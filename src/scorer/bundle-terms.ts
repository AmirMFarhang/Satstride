// The loan a scorer assessed, for a lender who never sees the bundle. A external provider
// run reads the whole bundle but releases only an income band and check results
// bound to its hash, so on its own the evidence does not say which loan the
// bundle asked for: a borrower could be scored for a small loan and apply for a
// larger one. The Passbook chain observer already reads the bundle to run the
// chain checks, and external provider and the lender both trust it for chain facts. It
// signs the bundle's terms against the same hash, lender and purpose: the loan
// request, asset, offer and lender requirements. The lender compares them with
// the agreed loan before it accepts the result.

import { hashObject, isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import type { Bundle } from '../sandbox/types.js'
import type { PassbookCheckOutputs, ScoredLoan, ScorerOutcome } from './types.js'

/** The loan a bundle asks for, as outputs v2 must name it (and as external provider binds it: passbookLoanBinding). */
export function bundleLoan(bundle: Pick<Bundle, 'loan_request' | 'asset_id' | 'lender_requirements'>): ScoredLoan {
  const { principal, fee, term_blocks, grace_blocks } = bundle.loan_request
  return { loan_request: { principal, fee, term_blocks, grace_blocks }, asset_id: bundle.asset_id ?? '', lender_requirements_hash: hashObject(bundle.lender_requirements) }
}

/** Why released outputs do not name exactly this loan; empty when they do. v1 outputs (contract 1.2.0) name none. */
export function scoredLoanProblems(outputs: PassbookCheckOutputs, expected: ScoredLoan): string[] {
  if (outputs.v !== 2 || !outputs.loan_request) return ['the released outputs name no scored loan (outputs v1, scoring contract 1.2.0)']
  const problems: string[] = []
  for (const k of ['principal', 'fee', 'term_blocks', 'grace_blocks'] as const) if (outputs.loan_request[k] !== expected.loan_request[k]) problems.push(`scored ${k} ${outputs.loan_request[k]}, expected ${expected.loan_request[k]}`)
  if (outputs.asset_id !== expected.asset_id) problems.push(`scored asset ${outputs.asset_id}, expected ${expected.asset_id}`)
  if (outputs.lender_requirements_hash !== expected.lender_requirements_hash) problems.push('scored against other lender requirements')
  return problems
}

/** Why a term sheet's own terms are not the loan a scorer assessed (outputs v2); empty when they are. */
export function scoredSheetProblems(sheet: { terms: { principal: number; fee: number; open_height: number; maturity_height: number; grace_blocks: number; asset_id: string } }, outcome: ScorerOutcome): string[] {
  let outputs: PassbookCheckOutputs | null = null
  try { outputs = outcome.kind === 'external-evidence' ? outcome.outputs : outcome.result.outputs } catch { return ['the released outputs do not parse'] }
  if (!outputs || outputs.v !== 2 || !outputs.loan_request) return ['the released outputs name no scored loan']
  const t = sheet.terms, l = outputs.loan_request
  const problems: string[] = []
  if (t.principal !== l.principal || t.fee !== l.fee) problems.push(`the sheet lends ${t.principal} with fee ${t.fee}; the scorer assessed ${l.principal} with fee ${l.fee}`)
  if (t.maturity_height - t.open_height !== l.term_blocks || t.grace_blocks !== l.grace_blocks) problems.push(`the sheet's term ${t.maturity_height - t.open_height} and grace ${t.grace_blocks} differ from the scored ${l.term_blocks} and ${l.grace_blocks}`)
  if (t.asset_id !== outputs.asset_id) problems.push('the sheet names another asset than the scored loan')
  return problems
}

export interface BundleTerms {
  v: 1
  kind: 'passbook-bundle-terms'
  bundle_hash: Hex
  borrower_pk: Hex
  lender_pk: Hex
  purpose_id: string
  offer_id: string
  asset_id: string
  loan_request: Bundle['loan_request']
  lender_requirements: Bundle['lender_requirements']
  signer_pk: Hex
  sig: Hex
}

export function signBundleTerms(bundle: Bundle, signer: KeyPair, binding: { lender_pk: Hex; purpose_id: string }): BundleTerms {
  return signObject({
    v: 1 as const, kind: 'passbook-bundle-terms' as const, bundle_hash: hashObject(bundle), borrower_pk: bundle.borrower_pk,
    lender_pk: binding.lender_pk, purpose_id: binding.purpose_id, offer_id: bundle.offer_id, asset_id: bundle.asset_id ?? '',
    loan_request: bundle.loan_request, lender_requirements: bundle.lender_requirements, signer_pk: signer.pubkey,
  }, signer.secretKey)
}

const KEYS = ['v', 'kind', 'bundle_hash', 'borrower_pk', 'lender_pk', 'purpose_id', 'offer_id', 'asset_id', 'loan_request', 'lender_requirements', 'signer_pk', 'sig'].sort().join()

/** Why these terms do not bind the scored bundle to the expected loan; empty when they do. */
export function bundleTermsProblems(t: BundleTerms | undefined, expect: Omit<BundleTerms, 'v' | 'kind' | 'signer_pk' | 'sig'> & { trustedSigners: Hex[] }): string[] {
  if (!t || typeof t !== 'object' || Object.keys(t).sort().join() !== KEYS || t.v !== 1 || t.kind !== 'passbook-bundle-terms') return ['no signed terms of the scored bundle']
  const problems: string[] = []
  if (!isHex(t.signer_pk, 32) || !expect.trustedSigners.includes(t.signer_pk) || !verifyObject(t, t.signer_pk)) problems.push('not signed by a trusted chain observer')
  if (t.bundle_hash !== expect.bundle_hash) problems.push('for another bundle than the one scored')
  if (t.borrower_pk !== expect.borrower_pk || t.lender_pk !== expect.lender_pk || t.purpose_id !== expect.purpose_id) problems.push('for another borrower, lender or purpose')
  if (t.offer_id !== expect.offer_id || t.asset_id !== expect.asset_id) problems.push('for another offer or asset')
  for (const k of ['principal', 'fee', 'term_blocks', 'grace_blocks'] as const) if (t.loan_request?.[k] !== expect.loan_request[k]) problems.push(`the scored loan request has ${k} ${t.loan_request?.[k]}, the agreed loan ${expect.loan_request[k]}`)
  if (hashObject(t.loan_request ?? null) !== hashObject(expect.loan_request)) problems.push('the scored loan request has other fields')
  if (hashObject(t.lender_requirements ?? null) !== hashObject(expect.lender_requirements)) problems.push("the bundle was scored against other lender requirements than this lender's offer")
  return [...new Set(problems)]
}
