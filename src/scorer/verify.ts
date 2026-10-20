import { hashObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from '../sandbox/investigate.js'
import { publishedRunMaterials } from '../sandbox/published-materials.js'
import { verifyRunRecord } from '../sandbox/run-record.js'
import type { Bundle } from '../sandbox/types.js'
import type { ConsentReceipt } from './consent.js'
import { containerResultErrors, contractAllowsModel, contractHash, outputErrors, type ScoringContract } from './contract.js'
import { declarationValid, descriptorCore, selfSignatureValid } from './providers.js'
import { approvedBuild, releaseManifestProblems, type ReleaseManifest } from './releases.js'
import { PROVIDER_TRUST, trustAtLeast, weakerTrust, type TrustLevel } from './trust.js'
import type { PassbookCheckOutputs, ScoredLoan, ScorerDescriptor, ScorerOutcome, ScorerProvider } from './types.js'
import { verifyExternalOutcome, type ExternalOutcomeVerifier } from './external.js'
import { scoredLoanProblems } from './bundle-terms.js'

export interface Tick { id: string; ok: boolean; detail: string }


export interface TrustPolicy {
  minTrust: TrustLevel
  releases: ReleaseManifest
  /** Pinned in the client's config, never read from the manifest. */
  releaseSignerPk: Hex
  contract: ScoringContract
  /**
   * Check market (src/checknode): operators accepted for a container scorer's
   * declaration besides the manifest's list, i.e. the signer of the offer the
   * lender's own check-node rules accepted. No platform allowlist decides who
   * may run a check node.
   */
  marketOperators?: Hex[]
}

export interface DescriptorVerification { ok: boolean; trust: TrustLevel | null; ticks: Tick[] }

export function verifyDescriptor(d: ScorerDescriptor, policy: TrustPolicy): DescriptorVerification {
  const ticks: Tick[] = []
  const tick = (id: string, ok: boolean, detail: string) => ticks.push({ id, ok, detail })
  const manifest = releaseManifestProblems(policy.releases, policy.releaseSignerPk)
  tick('release-manifest', manifest.length === 0, manifest.length ? manifest.join(',') : `signed by the pinned release key${policy.releases.development ? ' (DEVELOPMENT key)' : ''}`)
  const build = approvedBuild(policy.releases, d.provider, d.code_measurement, d.contract_hash)
  tick('approved-build', !!build, build ? `${build.label}: measurement and contract hash approved` : `${d.provider} ${d.code_measurement.slice(0, 20)}… is not an approved build for this contract`)
  tick('scoring-contract', d.contract_hash === contractHash(policy.contract), 'descriptor names the scoring contract this client holds')
  if (d.provider === 'in-process' || d.provider === 'container') tick('enclave-key', selfSignatureValid(d), 'descriptor signed by its enclave key')
  if (d.provider === 'container') {
    const operator = d.operator_declaration?.operator_pk
    tick('operator-declaration', declarationValid(d) && !!operator && (policy.releases.operators.includes(operator) || !!policy.marketOperators?.includes(operator)), operator ? `declared by operator ${operator.slice(0, 12)}…${policy.marketOperators?.includes(operator) && !policy.releases.operators.includes(operator) ? ' (check-market operator, accepted by the lender\'s rules)' : ''}` : 'no operator declaration')
  }
  const ceiling = weakerTrust(d.trust, PROVIDER_TRUST[d.provider] ?? 'dev-inprocess')
  const trust = build ? weakerTrust(ceiling, build.max_trust) : null
  tick('trust-policy', !!trust && trustAtLeast(trust, policy.minTrust), `${trust ?? 'no'} trust granted (claimed ${d.trust}); policy needs ${policy.minTrust}; no hardware attestation`)
  return { ok: ticks.every((t) => t.ok), trust, ticks }
}

export class ScorerRejected extends Error {
  constructor(readonly ticks: Tick[]) {
    super(`scorer rejected: ${ticks.filter((t) => !t.ok).map((t) => `${t.id} (${t.detail})`).join('; ')}`)
    this.name = 'ScorerRejected'
  }
}

/**
 * Borrower side: verify each provider's descriptor before sending it data, sign a
 * consent receipt naming that verified scorer, and send only to it. Later
 * providers are labelled fallbacks with their own receipt and trust.
 */
export async function checkWithVerifiedScorer(providers: ScorerProvider[], bundle: Bundle, consentFor: (verified: ScorerDescriptor) => ConsentReceipt | Promise<ConsentReceipt>, borrower: KeyPair, policy: TrustPolicy, onFallback?: (error: Error) => void): Promise<ScorerOutcome & { consent: ConsentReceipt }> {
  if (!providers.length) throw new Error('no scorer configured')
  let last: Error = new Error('no scorer ran')
  for (const [i, provider] of providers.entries()) {
    try {
      const descriptor = await provider.describe()
      if (descriptor.provider !== provider.kind) throw new Error('provider descriptor names a different provider kind')
      const v = verifyDescriptor(descriptor, policy)
      if (!v.ok) throw new ScorerRejected(v.ticks)
      const consent = await consentFor(descriptor)
      const outcome = await provider.check(bundle, consent, borrower, descriptor)
      if (hashObject(descriptorCore(outcome.descriptor)) !== hashObject(descriptorCore(descriptor))) throw new Error('provider outcome names a different descriptor')
      if ((provider.kind === 'external') !== (outcome.kind === 'external-evidence')) throw new Error('provider returned an unsupported evidence kind')
      return { ...outcome, fallback: i > 0, consent }
    } catch (error) {
      last = error as Error
      if (i < providers.length - 1) onFallback?.(last)
    }
  }
  throw last
}

export interface LenderExpectations {
  lenderPk: Hex
  borrowerPk: Hex
  purposeId: string
  /** The consent hash the borrower put in the negotiation; the lender stores only this. */
  consentHash: Hex
  /** The lender policy's required_checks: each must be present and passing in the outputs. */
  requiredChecks: string[]
  externalVerifier?: ExternalOutcomeVerifier
  /** The loan this lender agreed to fund: the outputs (v2) must name exactly it, or nothing is accepted. */
  loan?: ScoredLoan
}

export interface LenderVerification {
  ok: boolean
  trust: TrustLevel | null
  fallback: boolean
  provider: ScorerDescriptor['provider']
  outputs: PassbookCheckOutputs | null
  ticks: Tick[]
}

export async function verifyOutcomeForLender(outcome: ScorerOutcome, policy: TrustPolicy, expect: LenderExpectations): Promise<LenderVerification> {
  const d = verifyDescriptor(outcome.descriptor, policy)
  const ticks = [...d.ticks]
  const tick = (id: string, ok: boolean, detail: string) => ticks.push({ id, ok, detail })
  let trust = d.trust
  let outputs: PassbookCheckOutputs | null = null

  tick('provider-evidence-kind', outcome.kind === 'passbook-signed' ? ['in-process', 'container'].includes(outcome.descriptor.provider) : outcome.kind === 'external-evidence' && outcome.descriptor.provider === 'external', 'evidence kind must match the provider protocol')
  if (outcome.kind === 'passbook-signed') {
    const r = outcome.result
    const desc = outcome.descriptor
    const leaks = containerResultErrors(policy.contract, r)
    tick('output-schema', leaks.length === 0, leaks.length ? `fields outside the contract: ${leaks.slice(0, 3).join('; ')}` : 'exactly the contract fields')
    if (leaks.length === 0) {
      tick('result-scorer', r.scorer.provider === desc.provider && r.scorer.scorer_id === desc.scorer_id && r.scorer.code_measurement === desc.code_measurement && r.scorer.contract_hash === desc.contract_hash && r.scorer.enclave_pubkey === desc.enclave_pubkey, 'result names the verified scorer')
      tick('result-signature', verifyObject(r, desc.enclave_pubkey ?? ''), 'signed by the enclave key')
      const inv = r.evidence.investigation
      const allowed = contractAllowsModel(policy.contract, inv.model)
      const materials = await publishedRunMaterials(inv.model, { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS })
      const run = verifyRunRecord(r.evidence.run_record, materials, desc.enclave_pubkey ?? '', policy.contract.budgets, inv)
      tick('run-record', allowed && run.ok && r.evidence.run_record.bundle_hash === r.outputs.bundle_hash, !allowed ? `model ${inv.model} not allowed by the contract` : run.ok ? `budgets and published materials verified (${inv.model})` : run.errors.join(','))
      tick('consent', r.consent_hash === expect.consentHash, 'result bound to the consent receipt the borrower showed')
      outputs = r.outputs
    }
  } else {
    const checked = await verifyExternalOutcome(outcome, policy, expect)
    ticks.push(...checked.ticks)
    trust = trust && checked.trust ? weakerTrust(trust, checked.trust) : null
    const leaks = outputErrors(policy.contract, outcome.outputs)
    tick('output-schema', leaks.length === 0, leaks.length ? leaks.join('; ') : 'exactly the contract fields')
    if (leaks.length === 0) outputs = outcome.outputs
  }

  if (outputs) {
    const passed = (id: string) => outputs!.checks.some((c) => c.id === id && c.ok)
    const missing = expect.requiredChecks.filter((id) => !passed(id))
    tick('required-checks', missing.length === 0, missing.length ? `required checks missing or failed: ${missing.join(', ')}` : expect.requiredChecks.length ? `required checks passed: ${expect.requiredChecks.join(', ')}` : 'lender policy requires no checks')
  }
  if (outputs) tick('addressed-to-lender', outputs.lender_pk === expect.lenderPk && outputs.borrower_pk === expect.borrowerPk && outputs.purpose_id === expect.purposeId, 'for this lender, borrower and negotiation')
  if (outputs && expect.loan) {
    const loan = scoredLoanProblems(outputs, expect.loan)
    const l = expect.loan.loan_request
    tick('scored-loan', loan.length === 0, loan.length ? loan.join('; ') : `the scorer assessed ${l.principal} micro-USDT plus ${l.fee} fee over ${l.term_blocks} blocks (grace ${l.grace_blocks}) of ${expect.loan.asset_id}, under these requirements`)
  }
  if (outcome.fallback) tick('fallback', true, `FALLBACK: the primary scorer was unavailable; ${outcome.descriptor.provider} ran at ${trust ?? 'no'} trust`)
  if (trust) tick('trust-minimum', trustAtLeast(trust, policy.minTrust), `${trust} against policy ${policy.minTrust}`)
  return { ok: ticks.every((t) => t.ok) && !!trust && !!outputs, trust, fallback: outcome.fallback, provider: outcome.descriptor.provider, outputs, ticks }
}

// Browser-safe, next to the term sheet's evidence digest (evidence-digest-core.ts).
export { scorerResultHash } from './evidence-digest-core.js'
