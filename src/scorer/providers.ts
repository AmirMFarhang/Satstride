// Local scorers and an optional, explicitly installed external provider.
import type { Reasoner } from '../ai/types.js'
import type { ChainClient } from '../chain/types.js'
import { hashObject, isHex, signObject, type Hex, type KeyPair } from '../core/crypto.js'
import { decryptFrom, encryptTo } from '../market/messages.js'
import type { InvestigationContext } from '../sandbox/investigation-types.js'
import type { RunEnvironment } from '../sandbox/run-record.js'
import { runSandbox } from '../sandbox/run.js'
import { validateBundle, type Bundle, type SandboxResult } from '../sandbox/types.js'
import { bundleLoan } from './bundle-terms.js'
import { consentHash, consentProblems, uncoveredCategories, type ConsentReceipt } from './consent.js'
import { containerResultErrors, contractHash, loadScoringContract, type ScoringContract } from './contract.js'
import type { EncryptedCheckRequest, PassbookCheckOutputs, Recommendation, ScorerDescriptor, ScorerOutcome, ScorerProvider, SignedCheckResult } from './types.js'
import { declareScorer, descriptorCore, selfSignatureValid } from './descriptor.js'

// ---- the shared output shape ----

/** Fixed 1,000 USDT income bands. */
export function incomeBand(monthlyMicro: number): string {
  const n=Math.floor(Math.max(0,monthlyMicro)/1e9)*1000
  return `${n.toLocaleString('en-US')}–${(n+1000).toLocaleString('en-US')} USDT/month`
}

/** The sandbox writes reconciled bands as "2000–3000 USDT/month"; re-render its low edge in the shared format. */
function sharedBand(sandboxBand: string | undefined, monthlyMicro: number): string {
  const low = sandboxBand ? /^(\d+)–\d+ USDT\/month$/.exec(sandboxBand)?.[1] : undefined
  return low !== undefined ? `${Number(low).toLocaleString('en-US')}–${(Number(low)+1000).toLocaleString('en-US')} USDT/month` : incomeBand(monthlyMicro)
}

/** Deterministic: code reads the signed checks, never model text. */
export function recommend(r: Pick<SandboxResult, 'checks' | 'investigation' | 'income_evidence'>): Recommendation {
  if (r.investigation?.verdict === 'fraud') return 'DECLINE'
  const failing = r.checks.filter((c) => !c.ok)
  if (failing.some((c) => c.id !== 'investigation')) return 'DECLINE'
  if (failing.length) return 'ESCALATE'
  const tiers = r.income_evidence?.tier_counts
  return tiers && (tiers.recurring > 0 || tiers.business > 0) ? 'QUALIFY_WITH_HAIRCUT' : 'QUALIFY'
}

export function projectOutputs(r: SandboxResult, consent: ConsentReceipt, bundle: Bundle): PassbookCheckOutputs {
  return {
    v: 2, kind: 'passbook-check-outputs',
    recommendation: recommend(r),
    income_band: sharedBand(r.income_evidence?.income_band, r.summary.income_monthly_median),
    checks: r.checks.map((c) => ({ id: c.id, ok: c.ok })),
    findings: [...new Set((r.investigation?.findings ?? []).map((f) => f.type))].map((type) => ({ type })),
    lender_note: r.investigation?.lender_note ?? 'The local AI investigation did not run. This is not a clean report.',
    borrower_pk: r.borrower_pk, lender_pk: consent.lender_pk, purpose_id: consent.purpose_id, bundle_hash: r.bundle_hash,
    ...bundleLoan(bundle),
  }
}

// ---- descriptors ----

// Browser-safe (the phone verifies offers with them): src/scorer/descriptor.ts.
export { declarationValid, declareScorer, descriptorCore, selfSignatureValid } from './descriptor.js'

export function encryptCheckRequest(borrower: KeyPair, d: ScorerDescriptor, bundle: Bundle, consent: ConsentReceipt): EncryptedCheckRequest {
  if (!isHex(d.enclave_pubkey, 32) || !selfSignatureValid(d)) throw new Error('scorer descriptor has no valid enclave key')
  if (consent.scorer_id !== d.scorer_id || consent.scorer_pk !== d.enclave_pubkey) throw new Error('CONSENT_WRONG_SCORER: the receipt does not name this verified scorer')
  const uncovered = uncoveredCategories(consent, bundle)
  if (uncovered.length) throw new Error(`CONSENT_CATEGORIES_INCOMPLETE:${uncovered.join(',')}`)
  return { v: 1, kind: 'passbook-check-request', sender_pk: borrower.pubkey, enclave_pubkey: d.enclave_pubkey, contract_hash: d.contract_hash, consent_hash: consentHash(consent), ciphertext: encryptTo(borrower, d.enclave_pubkey, JSON.stringify(bundle)) }
}

// ---- the sandbox behind in-process and container scorers ----

export interface SandboxEngineConfig {
  provider: 'in-process' | 'container'
  key: KeyPair
  chain: ChainClient
  reasoner: Reasoner
  blocksPerMonth: number
  /** `source:<hash>` in-process (measureSource), `sha256:<image digest>` in a container. */
  measurement: string
  oraclePk?: Hex
  contract?: ScoringContract
  runEnvironment?: RunEnvironment
  investigationContext?: InvestigationContext
  now?: () => number
}

export class SandboxScorerEngine {
  readonly contract: ScoringContract
  readonly contractHash: Hex
  constructor(private readonly cfg: SandboxEngineConfig) {
    this.contract = cfg.contract ?? loadScoringContract()
    this.contractHash = contractHash(this.contract)
  }

  descriptor(): ScorerDescriptor {
    const core = { v: 1 as const, provider: this.cfg.provider, scorer_id: `passbook-sandbox:${this.cfg.provider}:${this.cfg.key.pubkey.slice(0, 16)}`, trust: 'dev-inprocess' as const, code_measurement: this.cfg.measurement, contract_hash: this.contractHash, enclave_pubkey: this.cfg.key.pubkey }
    return signObject(core, this.cfg.key.secretKey)
  }

  async handle(req: EncryptedCheckRequest, consent: ConsentReceipt): Promise<SignedCheckResult> {
    const d = this.descriptor()
    const now = this.cfg.now?.() ?? Math.floor(Date.now() / 1000)
    const refused = consentProblems(consent, { scorer_id: d.scorer_id, scorer_pk: this.cfg.key.pubkey, contract: this.contract, contract_hash: this.contractHash, now, borrower_pk: req.sender_pk })
    if (refused.length) throw new Error(`CONSENT_REFUSED:${refused.join(',')}`)
    if (req.v !== 1 || req.kind !== 'passbook-check-request' || req.enclave_pubkey !== this.cfg.key.pubkey || req.contract_hash !== this.contractHash || req.consent_hash !== consentHash(consent)) throw new Error('REQUEST_NOT_FOR_THIS_SCORER')
    const bundle: unknown = JSON.parse(decryptFrom(this.cfg.key, req.sender_pk, req.ciphertext))
    validateBundle(bundle)
    if (bundle.borrower_pk !== req.sender_pk) throw new Error('bundle must be sent by its borrower')
    const uncovered = uncoveredCategories(consent, bundle)
    if (uncovered.length) throw new Error(`CONSENT_REFUSED:CONSENT_CATEGORIES_INCOMPLETE`)
    // The contract fixes retention: none, so no private replay artifact is written.
    const r = await runSandbox(bundle, { key: this.cfg.key, chain: this.cfg.chain, reasoner: this.cfg.reasoner, blocksPerMonth: this.cfg.blocksPerMonth, oraclePk: this.cfg.oraclePk, investigationContext: this.cfg.investigationContext, runEnvironment: this.cfg.runEnvironment, runArtifactDir: null })
    if (!r.investigation || !r.run_record) throw new Error('sandbox result lacks its investigation record')
    const result = signObject({
      v: 1 as const, kind: 'passbook-check-result' as const,
      scorer: { provider: this.cfg.provider, scorer_id: d.scorer_id, trust: d.trust, code_measurement: d.code_measurement, contract_hash: d.contract_hash, enclave_pubkey: this.cfg.key.pubkey },
      request_hash: hashObject(req), consent_hash: req.consent_hash, height: r.height,
      outputs: projectOutputs(r, consent, bundle),
      evidence: { investigation: r.investigation, run_record: r.run_record },
    }, this.cfg.key.secretKey)
    // Never release a field the contract does not name.
    const leaks = containerResultErrors(this.contract, result)
    if (leaks.length) throw new Error(`OUTPUT_OUTSIDE_CONTRACT:${leaks.slice(0, 3).join('; ')}`)
    return result
  }
}

export class InProcessScorer implements ScorerProvider {
  readonly kind = 'in-process' as const
  constructor(private readonly engine: SandboxScorerEngine) {}
  async describe(): Promise<ScorerDescriptor> {
    return this.engine.descriptor()
  }
  async check(bundle: Bundle, consent: ConsentReceipt, borrower: KeyPair, verified: ScorerDescriptor): Promise<ScorerOutcome> {
    // Signatures carry fresh aux randomness, so compare what was signed.
    if (!selfSignatureValid(verified) || hashObject(descriptorCore(verified)) !== hashObject(descriptorCore(this.engine.descriptor()))) throw new Error('in-process scorer is not the verified descriptor')
    return { kind: 'passbook-signed', descriptor: verified, result: await this.engine.handle(encryptCheckRequest(borrower, verified, bundle, consent), consent), fallback: false }
  }
}

export class ContainerScorer implements ScorerProvider {
  readonly kind = 'container' as const
  constructor(private readonly baseUrl: string, private readonly opts: { operator?: KeyPair; fetch?: typeof fetch; timeoutMs?: number } = {}) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000) })
    const body = (await res.json()) as T | { error: string }
    if (!res.ok) throw new Error(`container scorer ${path}: ${(body as { error?: string }).error ?? res.status}`)
    return body as T
  }

  async describe(): Promise<ScorerDescriptor> {
    const d = await this.call<ScorerDescriptor>('/descriptor')
    return this.opts.operator ? declareScorer(this.opts.operator, d) : d
  }

  async check(bundle: Bundle, consent: ConsentReceipt, borrower: KeyPair, verified: ScorerDescriptor): Promise<ScorerOutcome> {
    // Encrypt only to the key that passed the borrower's checks; a rotated or substituted server cannot read it.
    const request = encryptCheckRequest(borrower, verified, bundle, consent)
    const result = await this.call<SignedCheckResult>('/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request, consent }) })
    return { kind: 'passbook-signed', descriptor: verified, result, fallback: false }
  }
}

