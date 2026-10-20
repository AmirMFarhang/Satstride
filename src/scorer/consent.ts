// Consent receipt: the borrower signs what the data is for, which scorer key may
// read it, which lender gets the result, the data categories, zero retention
// and an expiry. The scorer refuses to run without one; the lender stores only
// its hash.

import { hashObject, isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import type { Bundle } from '../sandbox/types.js'
import type { ScoringContract } from './contract.js'

export interface ConsentReceipt {
  v: 1
  domain: 'passbook-consent-v1'
  /** Plain language, e.g. "credit assessment for negotiation <id>". */
  purpose: string
  /** Negotiation or offer this assessment belongs to. */
  purpose_id: string
  borrower_pk: Hex
  /** Descriptor scorer_id of the only scorer allowed to process the bundle. */
  scorer_id: string
  /** In-process and container: the enclave key allowed to decrypt the bundle. external provider: absent. */
  scorer_pk?: Hex
  /** The contract the borrower approves; for external provider this approval is the consent. */
  contract_hash: Hex
  /** Check market (src/checknode): the operator key that runs the scorer, a processor under this consent. */
  operator_pk?: Hex
  /** The only lender the signed result is addressed to. */
  lender_pk: Hex
  /** Check market: who pays the operator. `lender` means the lender sends the request, pays and sees the result first. */
  payer?: 'borrower' | 'lender'
  /** Check market: releaseHash of the exact release (workload, scoring contract, model) the borrower agrees to be scored by. */
  release_hash?: Hex
  data_categories: string[]
  retention: 'none'
  /** Unix seconds */
  issued_at: number
  expires_at: number
  sig: Hex
}

/** Longest a receipt may be valid for: an assessment, not a standing grant. */
export const MAX_CONSENT_SECONDS = 24 * 60 * 60

export function signConsent(borrower: KeyPair, input: Omit<ConsentReceipt, 'v' | 'domain' | 'borrower_pk' | 'retention' | 'sig'>): ConsentReceipt {
  return signObject({ v: 1 as const, domain: 'passbook-consent-v1' as const, borrower_pk: borrower.pubkey, retention: 'none' as const, ...input }, borrower.secretKey)
}

export function consentHash(receipt: ConsentReceipt): Hex {
  return hashObject(receipt)
}

export function consentProblems(receipt: ConsentReceipt, expect: { scorer_id: string; scorer_pk?: Hex; contract: ScoringContract; contract_hash: Hex; now: number; borrower_pk?: Hex }): string[] {
  const problems: string[] = []
  if (!receipt || receipt.v !== 1 || receipt.domain !== 'passbook-consent-v1') return ['CONSENT_MALFORMED']
  if (!isHex(receipt.borrower_pk, 32) || !verifyObject(receipt, receipt.borrower_pk)) problems.push('CONSENT_SIGNATURE')
  if (expect.borrower_pk && receipt.borrower_pk !== expect.borrower_pk) problems.push('CONSENT_WRONG_BORROWER')
  if (receipt.scorer_id !== expect.scorer_id || receipt.scorer_pk !== expect.scorer_pk) problems.push('CONSENT_WRONG_SCORER')
  if (receipt.contract_hash !== expect.contract_hash) problems.push('CONSENT_WRONG_CONTRACT')
  if (!isHex(receipt.lender_pk, 32)) problems.push('CONSENT_NO_LENDER')
  if (receipt.retention !== 'none') problems.push('CONSENT_RETENTION')
  if (typeof receipt.purpose !== 'string' || !receipt.purpose.trim() || receipt.purpose.length > 200 || typeof receipt.purpose_id !== 'string' || !receipt.purpose_id || receipt.purpose_id.length > 200) problems.push('CONSENT_PURPOSE')
  if (!Array.isArray(receipt.data_categories) || receipt.data_categories.length === 0 || !receipt.data_categories.every((c) => expect.contract.inputs.data_categories.includes(c))) problems.push('CONSENT_CATEGORIES')
  if (!Number.isSafeInteger(receipt.issued_at) || !Number.isSafeInteger(receipt.expires_at) || receipt.expires_at <= receipt.issued_at || receipt.expires_at - receipt.issued_at > MAX_CONSENT_SECONDS) problems.push('CONSENT_WINDOW')
  else if (expect.now < receipt.issued_at - 300 || expect.now >= receipt.expires_at) problems.push('CONSENT_EXPIRED')
  return problems
}

/** The data categories a bundle actually carries; consent must name every one of them. */
export function bundleCategories(bundle: Bundle): string[] {
  return [
    'transaction_history', 'loan_request', 'collateral_quote',
    ...(bundle.candidate_inflows.length ? ['payer_signatures'] : []),
    ...(bundle.own_pks.length ? ['own_keys'] : []),
    ...(bundle.scheduled_outflows.length ? ['scheduled_outflows'] : []),
    ...(bundle.history_proof ? ['history_proof'] : []),
  ]
}

/** Categories that would be sent without consent; empty means the receipt covers the transfer. */
export function uncoveredCategories(receipt: ConsentReceipt, bundle: Bundle, extra: string[] = []): string[] {
  return [...bundleCategories(bundle), ...extra].filter((c) => !receipt.data_categories.includes(c))
}
