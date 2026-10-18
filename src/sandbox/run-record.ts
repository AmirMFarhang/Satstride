// Software evidence signed by the sandbox key. This is not a TEE quote: it
// commits to what this process reports, rather than proving its isolation.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChainClient, ChainTx } from '../chain/types.js'
import { canonicalJson, hashObject, isHex, sha256Hex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { FINDING_TYPES, TOOL_NAMES, type PayerProfile, type ToolName } from './investigation-types.js'
import type { Bundle } from './types.js'

export interface RunBudgets {
  max_tool_calls: number
  max_model_calls: number
  max_decision_attempts: number
  turn_ms: number
  total_ms: number
}
export interface RunMaterials {
  system_prompt_sha256: Hex
  tool_definitions_sha256: Hex
  model_id: string
  /** Hash the actual GGUF bytes. A registry identifier is not a file hash. */
  model_file_sha256: Hex | null
  model_material_kind: 'file' | 'deterministic-code' | 'unavailable'
}
export interface CodedDecision {
  verdict: 'clean' | 'concerns' | 'fraud'
  findings: { type: string; evidence: string[] }[]
  payer_tiers?: { tier: 'tier_1' | 'tier_2' | 'tier_3' | 'out'; evidence: string[] }[]
}
export interface RunEnvironment {
  image_digest: 'in-process' | string
  network_mode: 'in-process-host' | 'none' | 'host' | 'bridge' | 'internal' | 'declared-remote'
}
interface ToolCommitment {
  n: number
  name: ToolName
  evidence_id: string
  arguments_sha256: Hex
  result_sha256: Hex
  call_sha256: Hex
  elapsed_ms: number
}
interface ModelCommitment { n: number; request_sha256: Hex; response_sha256: Hex; elapsed_ms: number }
interface DecisionCommitment { n: number; report_sha256: Hex; accepted: boolean; reason_codes: string[]; evidence_count: number }
export interface SignedRunRecord extends RunEnvironment {
  v: 1
  kind: 'passbook-signed-run'
  assurance: 'software-signature-only'
  sandbox_pk: Hex
  bundle_hash: Hex
  materials: RunMaterials
  budgets: RunBudgets
  status: 'done' | 'failed' | 'not_run'
  tool_calls: ToolCommitment[]
  model_calls: ModelCommitment[]
  decision_attempts: DecisionCommitment[]
  duration_ms: number
  public_result_sha256: Hex
  policy_sha256: Hex
  private_evidence_sha256: Hex
  sig: Hex
}
export interface ChainSnapshot { kind: string; height: number; transactions: { txid: Hex; tx: ChainTx | null }[] }
export interface OfflineReplayContext {
  /** Only the injection-redacted bundle belongs in this private artifact. */
  bundle: Bundle
  chain: ChainSnapshot
  blocks_per_month: number
  redacted_txids: Hex[]
  profiles: { pk: Hex; profile: PayerProfile }[]
  native_history?: {
    trusted_observer_pk: Hex
    asset_id: string
    unspents: { txid: Hex; vout: number; value: number; script: Hex }[]
  }
}
export interface PrivateToolCall { name: ToolName; args: Record<string, unknown>; evidence_id: string; result: unknown; error?: string }
export interface PrivateDecision { report: CodedDecision; accepted: boolean; reason_codes: string[]; evidence_count: number }
export interface PrivateRunEvidence {
  tools: PrivateToolCall[]
  decisions: PrivateDecision[]
  replay: OfflineReplayContext | null
  policy_result: unknown
  public_result: unknown
  failure_code?: string
}
export interface RunArtifact { v: 1; record: SignedRunRecord; private_evidence: PrivateRunEvidence }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const code = (value: string) => /^[A-Z][A-Z0-9_:]{0,79}$/.test(value)
const evidenceId = (value: string) => /^E[1-9][0-9]*$/.test(value)
const nonnegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0
const elapsed = (value: number) => Math.ceil(Math.max(0, value))

/** File hashes are cached only while the filesystem identity and timestamps match. */
const fileHashes = new Map<string, { identity: string; hash: Hex }>()
export async function modelFileHash(path: string): Promise<Hex> {
  const before = await stat(path)
  if (!before.isFile()) throw new Error('model material must be a regular file')
  const identity = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':')
  const cached = fileHashes.get(path)
  if (cached?.identity === identity) return cached.hash
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  const after = await stat(path)
  if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== identity) throw new Error('model material changed while being hashed')
  const hash = digest.digest('hex')
  fileHashes.set(path, { identity, hash })
  return hash
}

export async function runMaterials(input: { systemPrompt: string; toolDefinitions: unknown; modelId: string; modelFile?: string; deterministicMaterial?: unknown }): Promise<RunMaterials> {
  if (input.modelFile && input.deterministicMaterial !== undefined) throw new Error('choose model file or deterministic code material')
  return {
    system_prompt_sha256: sha256Hex(input.systemPrompt), tool_definitions_sha256: hashObject(input.toolDefinitions), model_id: input.modelId,
    model_file_sha256: input.modelFile ? await modelFileHash(input.modelFile) : input.deterministicMaterial !== undefined ? hashObject(input.deterministicMaterial) : null,
    model_material_kind: input.modelFile ? 'file' : input.deterministicMaterial !== undefined ? 'deterministic-code' : 'unavailable',
  }
}

/** Wrap the chain actually used by preparation; never invent a chain observation. */
export class RecordingChain implements ChainClient {
  readonly kind: string
  private height: number | undefined
  private readonly transactions = new Map<Hex, ChainTx | null>()
  constructor(private readonly source: ChainClient) { this.kind = source.kind }
  async getHeight(): Promise<number> { return this.height = await this.source.getHeight() }
  async getTx(txid: Hex): Promise<ChainTx | null> {
    const tx = await this.source.getTx(txid)
    this.transactions.set(txid, clone(tx))
    return tx
  }
  snapshot(): ChainSnapshot {
    if (this.height === undefined) throw new Error('chain height was not observed')
    return { kind: this.kind, height: this.height, transactions: [...this.transactions].map(([txid, tx]) => ({ txid, tx })) }
  }
}

/** Read-only replay refuses a missing observation instead of treating it as null. */
export function snapshotChain(snapshot: ChainSnapshot): ChainClient {
  const txs = new Map(snapshot.transactions.map((entry) => [entry.txid, entry.tx]))
  return {
    kind: `offline:${snapshot.kind}`,
    async getHeight() { return snapshot.height },
    async getTx(txid) {
      if (!txs.has(txid)) throw new Error('chain observation missing from private evidence')
      return clone(txs.get(txid)!)
    },
  }
}

export class RunRecorder {
  private readonly started = performance.now()
  private readonly tools: ToolCommitment[] = []
  private readonly models: ModelCommitment[] = []
  private readonly attempts: DecisionCommitment[] = []
  private readonly privateTools: PrivateToolCall[] = []
  private readonly privateDecisions: PrivateDecision[] = []
  private replay: OfflineReplayContext | null = null
  private finished = false
  constructor(private readonly key: KeyPair, private readonly config: RunEnvironment & { bundleHash: Hex; materials: RunMaterials; budgets: RunBudgets }) {}
  private active() { if (this.finished) throw new Error('run record is already sealed') }
  recordTool(input: { name: ToolName; args: Record<string, unknown>; evidenceId: string; result: unknown; elapsedMs: number; error?: string }): void {
    this.active()
    if (!(TOOL_NAMES as readonly string[]).includes(input.name) || !evidenceId(input.evidenceId)) throw new Error('invalid tool record')
    if (this.tools.some((entry) => entry.evidence_id === input.evidenceId)) throw new Error('duplicate evidence id')
    if (input.error !== undefined && !code(input.error)) throw new Error('tool errors must be reason codes')
    const validArgs = toolArgumentsValid(input.name, input.args)
    if (!validArgs && !input.error) throw new Error('invalid tool arguments require a failed tool record')
    const arguments_sha256 = hashObject(input.args), result_sha256 = hashObject(input.result)
    const commitment = { name: input.name, arguments_sha256, evidence_id: input.evidenceId, result_sha256 }
    this.tools.push({ n: this.tools.length + 1, ...commitment, call_sha256: hashObject(commitment), elapsed_ms: elapsed(input.elapsedMs) })
    this.privateTools.push(clone({ name: input.name, args: validArgs ? input.args : { invalid_sha256: arguments_sha256 }, evidence_id: input.evidenceId, result: input.result, ...(input.error ? { error: input.error } : {}) }))
  }
  recordModel(input: { request: unknown; response: unknown; elapsedMs: number }): void {
    this.active()
    // Never retain requests/responses: model prose is reduced to commitments.
    this.models.push({ n: this.models.length + 1, request_sha256: hashObject(input.request), response_sha256: hashObject(input.response), elapsed_ms: elapsed(input.elapsedMs) })
  }
  recordDecision(input: { report: CodedDecision; accepted: boolean; reasonCodes: string[] }): void {
    this.active()
    assertCodedDecision(input.report)
    if (!input.reasonCodes.every(code)) throw new Error('decision rejection reasons must be codes')
    this.attempts.push({ n: this.attempts.length + 1, report_sha256: hashObject(input.report), accepted: input.accepted, reason_codes: [...input.reasonCodes], evidence_count: this.tools.length })
    this.privateDecisions.push(clone({ report: input.report, accepted: input.accepted, reason_codes: input.reasonCodes, evidence_count: this.tools.length }))
  }
  attachReplayContext(context: OfflineReplayContext): void { this.active(); this.replay = clone(context) }
  finish(input: { status: SignedRunRecord['status']; publicInvestigation: unknown; policyResult: unknown; failureCode?: string }): { record: SignedRunRecord; artifact: RunArtifact } {
    this.active()
    if (input.failureCode !== undefined && !code(input.failureCode)) throw new Error('failure reason must be a code')
    this.finished = true
    const private_evidence: PrivateRunEvidence = clone({ tools: this.privateTools, decisions: this.privateDecisions, replay: this.replay, policy_result: input.policyResult, public_result: input.publicInvestigation, ...(input.status === 'done' ? {} : { failure_code: input.failureCode ?? (input.status === 'not_run' ? 'INVESTIGATION_NOT_RUN' : 'FAILSAFE_ESCALATE') }) })
    const record = signObject({
      v: 1 as const, kind: 'passbook-signed-run' as const, assurance: 'software-signature-only' as const,
      sandbox_pk: this.key.pubkey, bundle_hash: this.config.bundleHash, image_digest: this.config.image_digest, network_mode: this.config.network_mode,
      materials: clone(this.config.materials), budgets: clone(this.config.budgets), status: input.status,
      tool_calls: clone(this.tools), model_calls: clone(this.models), decision_attempts: clone(this.attempts), duration_ms: elapsed(performance.now() - this.started),
      public_result_sha256: hashObject(input.publicInvestigation), policy_sha256: hashObject(input.policyResult), private_evidence_sha256: hashObject(private_evidence),
    }, this.key.secretKey)
    return { record, artifact: { v: 1, record, private_evidence } }
  }
}

export function assertCodedDecision(value: CodedDecision): void {
  if (!value || !exactKeys(value, ['findings', 'verdict', ...(Object.hasOwn(value, 'payer_tiers') ? ['payer_tiers'] : [])]) || !['clean', 'concerns', 'fraud'].includes(value.verdict) || !Array.isArray(value.findings) || value.findings.length > 4) throw new Error('decision must contain codes and evidence ids only')
  for (const finding of value.findings) {
    if (!finding || Object.keys(finding).sort().join() !== 'evidence,type' || !(FINDING_TYPES as readonly string[]).includes(finding.type) || !Array.isArray(finding.evidence) || finding.evidence.length < 1 || finding.evidence.length > 6 || !finding.evidence.every(evidenceId)) throw new Error('decision must contain codes and evidence ids only')
  }
  if (Object.hasOwn(value, 'payer_tiers') && (!Array.isArray(value.payer_tiers) || value.payer_tiers.length > 12 || value.payer_tiers.some((proposal) => !proposal || !exactKeys(proposal, ['tier', 'evidence']) || !['tier_1', 'tier_2', 'tier_3', 'out'].includes(proposal.tier) || !Array.isArray(proposal.evidence) || !proposal.evidence.length || proposal.evidence.length > 6 || !proposal.evidence.every(evidenceId)))) throw new Error('payer tiers must contain codes and evidence ids only')
}

/** Match the published read-only argument contract; malformed prose is hashed. */
export function toolArgumentsValid(name: ToolName, args: Record<string, unknown>): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const ref = (value: unknown, prefix: string) => typeof value === 'string' && (new RegExp(`^${prefix}[1-9][0-9]*$`).test(value) || isHex(value, 32))
  if (name === 'month_table' || name === 'list_counterparties') return Object.keys(args).length === 0
  if (name === 'flows_with' || name === 'payer_profile') return exactKeys(args, ['pk']) && ref(args.pk, 'p')
  if (name === 'outflows_before') return exactKeys(args, ['txid', 'blocks']) && ref(args.txid, 't') && Number.isInteger(args.blocks) && Number(args.blocks) >= 1 && Number(args.blocks) <= 30
  return name === 'read_memos' && exactKeys(args, ['txids']) && Array.isArray(args.txids) && args.txids.length <= 12 && args.txids.every((value) => ref(value, 't'))
}

export interface RunVerification { ok: boolean; errors: string[] }
export function verifyRunRecord(record: SignedRunRecord, expectedMaterials: RunMaterials, expectedSandboxPk: Hex, expectedBudgets: RunBudgets, publicResult?: unknown): RunVerification {
  try { return verifyRecord(record, expectedMaterials, expectedSandboxPk, expectedBudgets, publicResult) }
  catch { return { ok: false, errors: ['RUN_RECORD_MALFORMED'] } }
}
function exactKeys(value: object, keys: string[]): boolean { return Object.keys(value).sort().join() === keys.sort().join() }
function verifyRecord(record: SignedRunRecord, expectedMaterials: RunMaterials, expectedSandboxPk: Hex, expectedBudgets: RunBudgets, publicResult?: unknown): RunVerification {
  const errors: string[] = []
  if (!record || typeof record !== 'object') return { ok: false, errors: ['RUN_RECORD_MISSING'] }
  if (!exactKeys(record, ['v', 'kind', 'assurance', 'sandbox_pk', 'bundle_hash', 'image_digest', 'network_mode', 'materials', 'budgets', 'status', 'tool_calls', 'model_calls', 'decision_attempts', 'duration_ms', 'public_result_sha256', 'policy_sha256', 'private_evidence_sha256', 'sig'])) errors.push('RUN_RECORD_UNEXPECTED_FIELDS')
  if (record.v !== 1 || record.kind !== 'passbook-signed-run' || record.assurance !== 'software-signature-only') errors.push('RUN_RECORD_VERSION')
  if (record.sandbox_pk !== expectedSandboxPk || !verifyObject(record, expectedSandboxPk)) errors.push('RUN_RECORD_SIGNATURE')
  if (hashObject(record.materials) !== hashObject(expectedMaterials)) errors.push('RUN_MATERIALS_MISMATCH')
  if (hashObject(record.budgets) !== hashObject(expectedBudgets)) errors.push('RUN_BUDGETS_MISMATCH')
  if (!isHex(record.bundle_hash, 32) || !isHex(record.private_evidence_sha256, 32) || !isHex(record.policy_sha256, 32) || !isHex(record.public_result_sha256, 32)) errors.push('RUN_COMMITMENT_INVALID')
  if (!['done', 'failed', 'not_run'].includes(record.status)) errors.push('RUN_STATUS_INVALID')
  if (record.image_digest !== 'in-process' && !/^sha256:[0-9a-f]{64}$/.test(record.image_digest)) errors.push('RUN_IMAGE_DIGEST_INVALID')
  if (!['in-process-host', 'none', 'host', 'bridge', 'internal', 'declared-remote'].includes(record.network_mode)) errors.push('RUN_NETWORK_MODE_INVALID')
  const materials = record.materials
  if (!materials || !exactKeys(materials, ['system_prompt_sha256', 'tool_definitions_sha256', 'model_id', 'model_file_sha256', 'model_material_kind']) || !isHex(materials.system_prompt_sha256, 32) || !isHex(materials.tool_definitions_sha256, 32) || !/^[a-zA-Z0-9_.:/@-]{1,160}$/.test(materials.model_id) || !['file', 'deterministic-code', 'unavailable'].includes(materials.model_material_kind) || (materials.model_file_sha256 !== null && !isHex(materials.model_file_sha256, 32))) errors.push('RUN_MATERIALS_INVALID')
  if (record.status === 'done' && (!materials || materials.model_material_kind === 'unavailable' || !isHex(materials.model_file_sha256, 32))) errors.push('RUN_MODEL_MATERIAL_UNAVAILABLE')
  const budgets = record.budgets
  if (!budgets || !exactKeys(budgets, ['max_tool_calls', 'max_model_calls', 'max_decision_attempts', 'turn_ms', 'total_ms']) || !Object.values(budgets).every(nonnegativeInteger) || !budgets.max_decision_attempts || !budgets.turn_ms || !budgets.total_ms) errors.push('RUN_BUDGETS_INVALID')
  if (!Array.isArray(record.tool_calls) || !Array.isArray(record.model_calls) || !Array.isArray(record.decision_attempts)) return { ok: false, errors: [...errors, 'RUN_CALLS_INVALID'] }
  if (record.tool_calls.length > expectedBudgets.max_tool_calls || record.model_calls.length > expectedBudgets.max_model_calls || record.decision_attempts.length > expectedBudgets.max_decision_attempts || !nonnegativeInteger(record.duration_ms) || record.duration_ms > expectedBudgets.total_ms) errors.push('RUN_BUDGET_EXCEEDED')
  const ids = new Set<string>()
  for (const [index, entry] of record.tool_calls.entries()) {
    const commitment = { name: entry.name, arguments_sha256: entry.arguments_sha256, evidence_id: entry.evidence_id, result_sha256: entry.result_sha256 }
    if (!exactKeys(entry, ['n', 'name', 'evidence_id', 'arguments_sha256', 'result_sha256', 'call_sha256', 'elapsed_ms']) || entry.n !== index + 1 || entry.evidence_id !== `E${index + 1}` || ids.has(entry.evidence_id) || !(TOOL_NAMES as readonly string[]).includes(entry.name) || !isHex(entry.arguments_sha256, 32) || !isHex(entry.result_sha256, 32) || entry.call_sha256 !== hashObject(commitment) || !nonnegativeInteger(entry.elapsed_ms) || entry.elapsed_ms > expectedBudgets.turn_ms) errors.push('RUN_TOOL_COMMITMENT_INVALID')
    ids.add(entry.evidence_id)
  }
  for (const [index, entry] of record.model_calls.entries()) if (!exactKeys(entry, ['n', 'request_sha256', 'response_sha256', 'elapsed_ms']) || entry.n !== index + 1 || !isHex(entry.request_sha256, 32) || !isHex(entry.response_sha256, 32) || !nonnegativeInteger(entry.elapsed_ms) || entry.elapsed_ms > expectedBudgets.turn_ms) errors.push('RUN_MODEL_COMMITMENT_INVALID')
  for (const [index, entry] of record.decision_attempts.entries()) if (!exactKeys(entry, ['n', 'report_sha256', 'accepted', 'reason_codes', 'evidence_count']) || entry.n !== index + 1 || !isHex(entry.report_sha256, 32) || !nonnegativeInteger(entry.evidence_count) || entry.evidence_count > record.tool_calls.length || typeof entry.accepted !== 'boolean' || !Array.isArray(entry.reason_codes) || !entry.reason_codes.every(code) || (entry.accepted && entry.reason_codes.length !== 0) || (index < record.decision_attempts.length - 1 && entry.accepted)) errors.push('RUN_DECISION_COMMITMENT_INVALID')
  if (record.status === 'done' && (!record.decision_attempts.length || !record.decision_attempts.at(-1)!.accepted || !record.tool_calls.length)) errors.push('RUN_DONE_WITHOUT_GROUNDED_DECISION')
  if (publicResult !== undefined) {
    if (hashObject(publicResult) !== record.public_result_sha256) errors.push('RUN_PUBLIC_RESULT_MISMATCH')
    const view = publicResult as { status?: string; verdict?: string; policy?: { verdict?: string } }
    if (!view || view.status !== record.status) errors.push('RUN_PUBLIC_STATUS_MISMATCH')
    if ((view.policy && hashObject(view.policy) !== record.policy_sha256) || (record.status === 'done' && (!view.policy || !['clean', 'concerns', 'fraud'].includes(view.verdict ?? '') || view.verdict !== view.policy.verdict))) errors.push('RUN_PUBLIC_POLICY_MISMATCH')
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}

/** Private artifacts are opt-in, owner-readable, and must never be sent to a lender. */
export async function writeRunArtifact(dir: string, artifact: RunArtifact): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'run-record.json'), JSON.stringify(artifact.record, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await writeFile(join(dir, 'private-evidence.json'), JSON.stringify(artifact.private_evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
export async function readRunArtifact(dir: string): Promise<RunArtifact> {
  return { v: 1, record: JSON.parse(await readFile(join(dir, 'run-record.json'), 'utf8')) as SignedRunRecord, private_evidence: JSON.parse(await readFile(join(dir, 'private-evidence.json'), 'utf8')) as PrivateRunEvidence }
}

/** Canonical bytes used for hashes are available to independent verifiers. */
export { canonicalJson as canonicalRunJson }
