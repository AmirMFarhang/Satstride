import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { hashObject, keyPairFromLabel, signObject } from '../src/core/crypto.js'
import { checkRunArtifact, checkRunDirectory, type ReplayInvestigation, type ReplayPolicy } from '../src/sandbox/check-run.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { investigationTools } from '../src/sandbox/investigation-tools.js'
import { RecordingChain, RunRecorder, modelFileHash, readRunArtifact, runMaterials, verifyRunRecord, writeRunArtifact, type RunArtifact, type RunBudgets, type SignedRunRecord } from '../src/sandbox/run-record.js'

const budgets: RunBudgets = { max_tool_calls: 6, max_model_calls: 8, max_decision_attempts: 2, turn_ms: 20_000, total_ms: 90_000 }
const policy: ReplayPolicy = { verdict: 'clean', reason_codes: [], hard_stops: [], coverage_gaps: [] }
const publicResult = { status: 'done', verdict: 'clean', findings: [{ type: 'irregular_genuine', count: 1 }], policy }
const decision = { verdict: 'clean' as const, findings: [{ type: 'irregular_genuine', evidence: ['E1'] }] }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

async function fixture() {
  const f = investigationFixture('fatima')
  const chain = new RecordingChain(f.chain)
  const prepared = await investigationTools(f.bundle, chain, 30)
  const materials = await runMaterials({ systemPrompt: 'Published constrained prompt', toolDefinitions: { month_table: {} }, modelId: 'playbook', deterministicMaterial: 'deterministic code bytes' })
  const recorder = new RunRecorder(f.key, { bundleHash: hashObject(f.bundle), image_digest: 'in-process', network_mode: 'in-process-host', materials, budgets })
  const result = await prepared.tools.execute('month_table', {})
  recorder.recordModel({ request: { schema: 'tool', input: 'private memo' }, response: { action: 'tool', name: 'month_table', args: {} }, elapsedMs: 3 })
  recorder.recordTool({ name: 'month_table', args: {}, evidenceId: 'E1', result, elapsedMs: 1 })
  recorder.recordModel({ request: { evidence: result }, response: { action: 'finish', report: decision }, elapsedMs: 3 })
  recorder.recordDecision({ report: decision, accepted: true, reasonCodes: [] })
  recorder.attachReplayContext({ bundle: f.bundle, chain: chain.snapshot(), blocks_per_month: 30, redacted_txids: [], profiles: [...prepared.evidence.profiles].map(([pk, profile]) => ({ pk, profile })) })
  const sealed = recorder.finish({ status: 'done', publicInvestigation: publicResult, policyResult: policy })
  // Tests inject the release policy so they do not depend on a model, network,
  // or a coincidentally compatible implementation of the real confirmer.
  const replay: ReplayInvestigation = (report, ledger, _evidence, failureCode) => report ? { policy, errors: report.findings.every((finding) => finding.evidence.every((id) => ledger.some((entry) => entry.id === id && entry.tool === 'month_table' && !entry.error))) ? [] : ['EVIDENCE_NOT_GROUNDED'] } : { policy: { verdict: 'failed', reason_codes: [failureCode ?? 'FAILSAFE_ESCALATE'], hard_stops: [], coverage_gaps: [] }, errors: [] }
  return { ...f, ...sealed, recorder, materials, options: { materials, budgets, sandboxPk: f.key.pubkey, replayInvestigation: replay } }
}

function reseal(artifact: RunArtifact, secret: Uint8Array) {
  artifact.record = signObject({ ...artifact.record, private_evidence_sha256: hashObject(artifact.private_evidence) }, secret)
}

describe('signed sandbox run evidence', () => {
  it('signs only commitments and verifies expected public materials, key and budgets', async () => {
    const f = await fixture()
    assert.equal(verifyRunRecord(f.record, f.materials, f.key.pubkey, budgets, publicResult).ok, true)
    assert.equal((await checkRunArtifact(f.artifact, f.options)).ok, true)
    const encoded = JSON.stringify(f.record)
    for (const secret of ['private memo', f.bundle.history[0].memo, f.bundle.history[0].counterparty_pk, f.bundle.history[0].txid]) assert.ok(!encoded.includes(secret))
    assert.equal(f.record.assurance, 'software-signature-only')
    assert.throws(() => f.recorder.recordModel({ request: {}, response: {}, elapsedMs: 1 }), /sealed/)
    assert.equal(verifyRunRecord(f.record, f.materials, keyPairFromLabel('wrong-box').pubkey, budgets).ok, false)
    assert.equal(verifyRunRecord(f.record, { ...f.materials, system_prompt_sha256: '00'.repeat(32) }, f.key.pubkey, budgets).ok, false)
    assert.equal(verifyRunRecord(f.record, f.materials, f.key.pubkey, { ...budgets, max_tool_calls: 7 }).ok, false)
  })
  it('detects changed signatures, private tool results, grounding and policy even with a new valid sandbox signature', async () => {
    const f = await fixture()
    let artifact = clone(f.artifact)
    artifact.record.tool_calls[0].result_sha256 = '00'.repeat(32)
    assert.equal((await checkRunArtifact(artifact, f.options)).ok, false)
    artifact = clone(f.artifact)
    artifact.private_evidence.tools[0].result = { fabricated: true }
    assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_PRIVATE_EVIDENCE_MISMATCH'))
    // Re-sign the forged evidence and matching commitment. Replay must still
    // reject it because a signature is not proof the claimed tool ran.
    const tool = artifact.record.tool_calls[0]
    tool.result_sha256 = hashObject(artifact.private_evidence.tools[0].result)
    tool.call_sha256 = hashObject({ name: tool.name, arguments_sha256: tool.arguments_sha256, evidence_id: tool.evidence_id, result_sha256: tool.result_sha256 })
    reseal(artifact, f.key.secretKey)
    assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_TOOL_REPLAY_MISMATCH'))
    artifact = clone(f.artifact)
    artifact.private_evidence.decisions[0].report.findings[0].evidence = ['E2']
    artifact.record.decision_attempts[0].report_sha256 = hashObject(artifact.private_evidence.decisions[0].report)
    reseal(artifact, f.key.secretKey)
    assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_GROUNDING_REPLAY_MISMATCH'))
    artifact = clone(f.artifact)
    artifact.private_evidence.policy_result = { ...policy, verdict: 'fraud' }
    artifact.record.policy_sha256 = hashObject(artifact.private_evidence.policy_result)
    artifact.private_evidence.public_result = { ...publicResult, verdict: 'fraud', policy: artifact.private_evidence.policy_result }
    artifact.record.public_result_sha256 = hashObject(artifact.private_evidence.public_result)
    reseal(artifact, f.key.secretKey)
    assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_POLICY_REPLAY_MISMATCH'))
    artifact = clone(f.artifact)
    artifact.private_evidence.public_result = { ...publicResult, verdict: 'fraud' }
    artifact.record.public_result_sha256 = hashObject(artifact.private_evidence.public_result)
    reseal(artifact, f.key.secretKey)
    assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_PUBLIC_POLICY_MISMATCH'))
  })
  it('refuses unsigned model material, exhausted budgets and prose in a decision', async () => {
    const f = await fixture()
    const unavailable = { ...f.materials, model_material_kind: 'unavailable' as const, model_file_sha256: null }
    let record: SignedRunRecord = signObject({ ...f.record, materials: unavailable }, f.key.secretKey)
    assert.ok(verifyRunRecord(record, unavailable, f.key.pubkey, budgets).errors.includes('RUN_MODEL_MATERIAL_UNAVAILABLE'))
    record = signObject({ ...f.record, duration_ms: 90_001 }, f.key.secretKey)
    assert.ok(verifyRunRecord(record, f.materials, f.key.pubkey, budgets).errors.includes('RUN_BUDGET_EXCEEDED'))
    record = signObject({ ...f.record, model_calls: [{ ...f.record.model_calls[0], elapsed_ms: 20_001 }] }, f.key.secretKey)
    assert.ok(verifyRunRecord(record, f.materials, f.key.pubkey, budgets).errors.includes('RUN_MODEL_COMMITMENT_INVALID'))
    const recorder = new RunRecorder(f.key, { bundleHash: hashObject(f.bundle), image_digest: 'in-process', network_mode: 'in-process-host', materials: f.materials, budgets })
    assert.throws(() => recorder.recordDecision({ report: { ...decision, lender_note: 'private amount' } as typeof decision, accepted: true, reasonCodes: [] }), /codes and evidence ids/)
    assert.throws(() => recorder.recordDecision({ report: { ...decision, findings: [{ type: 'irregular_genuine', evidence: [f.bundle.history[0].txid] }] }, accepted: true, reasonCodes: [] }), /codes and evidence ids/)
  })
  it('fails closed on malformed records and prevents added public prose fields', async () => {
    const f = await fixture()
    for (const malformed of [null, {}, { ...f.record, model_calls: [null] }, { ...f.record, materials: null }]) {
      assert.equal(verifyRunRecord(malformed as typeof f.record, f.materials, f.key.pubkey, budgets).ok, false)
    }
    const record = signObject({ ...f.record, memo: 'private model prose' }, f.key.secretKey)
    assert.ok(verifyRunRecord(record, f.materials, f.key.pubkey, budgets).errors.includes('RUN_RECORD_UNEXPECTED_FIELDS'))
    const malformed = clone(f.artifact)
    malformed.private_evidence.tools = [null as never]
    assert.equal((await checkRunArtifact(malformed, f.options)).ok, false)
    const extra = clone(f.artifact)
    Object.assign(extra.private_evidence, { explanation: 'model prose' })
    reseal(extra, f.key.secretKey)
    assert.ok((await checkRunArtifact(extra, f.options)).errors.includes('RUN_PRIVATE_UNEXPECTED_FIELDS'))
  })
  it('accepts coded payer-tier proposals while rejecting identifiers, money and tampered tier prose', async () => {
    const f = await fixture()
    const recorder = new RunRecorder(f.key, { bundleHash: hashObject(f.bundle), image_digest: 'in-process', network_mode: 'in-process-host', materials: f.materials, budgets })
    const coded = { ...decision, payer_tiers: [{ tier: 'tier_2' as const, evidence: ['E1'] }] }
    assert.doesNotThrow(() => recorder.recordDecision({ report: coded, accepted: true, reasonCodes: [] }))
    for (const proposal of [{ tier: 'tier_4', evidence: ['E1'] }, { tier: 'tier_2', evidence: ['E1'], amount: 100 }, { tier: 'tier_2', evidence: [f.bundle.history[0].counterparty_pk] }]) {
      assert.throws(() => recorder.recordDecision({ report: { ...decision, payer_tiers: [proposal] } as typeof coded, accepted: true, reasonCodes: [] }), /codes and evidence ids/)
    }
    const artifact = clone(f.artifact)
    artifact.private_evidence.decisions[0].report.payer_tiers = [{ tier: 'tier_2', evidence: ['E1'], note: 'private model prose' } as never]
    artifact.record.decision_attempts[0].report_sha256 = hashObject(artifact.private_evidence.decisions[0].report)
    reseal(artifact, f.key.secretKey)
    assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_DECISION_PROSE_OR_SCHEMA'))
  })
  it('uses only evidence available at each decision and refuses a missing replay implementation', async () => {
    const f = await fixture(), artifact = clone(f.artifact)
    artifact.private_evidence.decisions[0].evidence_count = 0
    artifact.record.decision_attempts[0].evidence_count = 0
    reseal(artifact, f.key.secretKey)
    assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_GROUNDING_REPLAY_MISMATCH'))
    const unavailable = await checkRunArtifact(f.artifact, { ...f.options, replayInvestigation: () => { throw new Error('no replay') } })
    assert.ok(unavailable.errors.includes('RUN_REPLAY_UNAVAILABLE'))
  })
  it('recomputes a fail-safe policy even when no model or evidence was available', async () => {
    const f = await fixture()
    for (const status of ['failed', 'not_run'] as const) {
      const failureCode = status === 'failed' ? 'MODEL_UNAVAILABLE' : 'INVESTIGATION_NOT_RUN'
      const failedPolicy = { verdict: 'failed', reason_codes: [failureCode], hard_stops: [], coverage_gaps: [] }
      const recorder = new RunRecorder(f.key, { bundleHash: hashObject(f.bundle), image_digest: 'in-process', network_mode: 'in-process-host', materials: f.materials, budgets })
      const { artifact } = recorder.finish({ status, failureCode, publicInvestigation: { status }, policyResult: failedPolicy })
      assert.equal((await checkRunArtifact(artifact, f.options)).ok, true)
      artifact.private_evidence.failure_code = 'CHANGED_FAILURE'
      reseal(artifact, f.key.secretKey)
      assert.ok((await checkRunArtifact(artifact, f.options)).errors.includes('RUN_FAILSAFE_POLICY_REPLAY_MISMATCH'))
    }
  })
  it('writes owner-readable artifacts, reloads them without wallets and refuses overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'passbook-run-'))
    try {
      const f = await fixture()
      await writeRunArtifact(dir, f.artifact)
      assert.equal((await stat(join(dir, 'private-evidence.json'))).mode & 0o777, 0o600)
      assert.deepEqual(await readRunArtifact(dir), f.artifact)
      assert.equal((await checkRunDirectory(dir, f.options)).ok, true)
      await assert.rejects(writeRunArtifact(dir, f.artifact), /EEXIST/)
      await writeFile(join(dir, 'private-evidence.json'), '{}')
      assert.equal((await checkRunDirectory(dir, f.options)).ok, false)
      assert.ok((await readFile(join(dir, 'run-record.json'), 'utf8')).includes('software-signature-only'))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('hashes actual model bytes and notices replacement instead of hashing a model name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'passbook-model-'))
    try {
      const file = join(dir, 'model.gguf')
      await writeFile(file, 'actual model bytes one')
      const first = await modelFileHash(file)
      assert.equal(await modelFileHash(file), first)
      await writeFile(file, 'different model bytes two')
      assert.notEqual(await modelFileHash(file), first)
      const materials = await runMaterials({ systemPrompt: 'prompt', toolDefinitions: {}, modelId: 'qvac-sdk:qwen3-1.7b', modelFile: file })
      assert.equal(materials.model_material_kind, 'file')
      assert.equal(materials.model_file_sha256, await modelFileHash(file))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
