// "Bill at close" (the user's decision, 18 Oct): a lender with no Lightning (a
// phone lender on Mutinynet) gets the credit check on credit. The check node
// runs it, hands over the result and K at once, and signs a bill for the
// check fee. The platform adds the bill to the platform fee the lender already
// pays over RGB when the loan closes (src/server/fees.ts), and the existing
// gate blocks a lender with an overdue fee. If no loan closes before the bill
// expires, the provider absorbs the cost; the node rate-limits bills per lender
// key and refuses lenders blocked for unpaid fees. No Lightning, no new
// contract, labelled everywhere: billed at close, not paid up front.
// Browser-safe (no node: imports): the phone lender checks the bill it receives.

import { hashObject, isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { checkMessageHash, type CheckMessage } from './messages.js'
import { offerHash, releaseHash, type CheckOffer } from './offer.js'
import { keyHash } from './seal-core.js'

export const BILL_AT_CLOSE = 'bill-at-close' as const
export const BILL_LABEL = 'billed at close, not paid up front' as const
export const BILL_RAIL_LABEL = "Billed at close, not paid up front: the check fee is added to the lender's platform fee when the loan closes"
/** How long a bill waits for a loan to close; after it, the provider absorbs the cost. */
export const DEFAULT_BILL_TTL_SECONDS = 30 * 24 * 3600
/** Bills per lender key in 24 h, the provider's exposure to checks that never become loans. */
export const DEFAULT_BILLS_PER_DAY = 3

/** The operator's signed bill for one check run on credit. */
export interface BilledCheckReceipt {
  v: 1
  kind: 'passbook-check-bill'
  label: typeof BILL_LABEL
  negotiation_id: Hex
  lender_pk: Hex
  borrower_pk: Hex
  operator_pk: Hex
  offer_hash: Hex
  release_hash: Hex
  /** hash of the lender's REQUEST */
  request_hash: Hex
  /** the operator-signed commitment's plaintext hash (CheckCommitment.commitment) */
  commitment: Hex
  fee: { asset_id: string; amount: number }
  due: 'at-close'
  issued_at: number
  /** No loan closed by then: the provider absorbs the cost. */
  expires_at: number
  sig: Hex
}

export function signBill(operator: KeyPair, input: Omit<BilledCheckReceipt, 'v' | 'kind' | 'label' | 'operator_pk' | 'due' | 'sig'>): BilledCheckReceipt {
  return signObject({ v: 1 as const, kind: 'passbook-check-bill' as const, label: BILL_LABEL, operator_pk: operator.pubkey, due: 'at-close' as const, ...input }, operator.secretKey)
}

export function billHash(bill: BilledCheckReceipt): Hex {
  return hashObject(bill)
}

const KEYS = ['v', 'kind', 'label', 'negotiation_id', 'lender_pk', 'borrower_pk', 'operator_pk', 'offer_hash', 'release_hash', 'request_hash', 'commitment', 'fee', 'due', 'issued_at', 'expires_at', 'sig'].sort().join()

/** Shape, label and the operator's signature: what the platform checks before charging a bill (it never sees the offer). */
export function billSignatureProblems(bill: BilledCheckReceipt): string[] {
  if (!bill || typeof bill !== 'object' || Object.keys(bill).sort().join() !== KEYS || bill.v !== 1 || bill.kind !== 'passbook-check-bill') return ['BILL_MALFORMED']
  const problems: string[] = []
  if (bill.label !== BILL_LABEL || bill.due !== 'at-close') problems.push('BILL_LABEL')
  for (const k of ['negotiation_id', 'lender_pk', 'borrower_pk', 'operator_pk', 'offer_hash', 'release_hash', 'request_hash', 'commitment'] as const) if (!isHex(bill[k], 32)) problems.push('BILL_MALFORMED')
  if (typeof bill.fee?.asset_id !== 'string' || !Number.isSafeInteger(bill.fee?.amount) || bill.fee.amount <= 0) problems.push('BILL_FEE')
  if (!Number.isSafeInteger(bill.issued_at) || !Number.isSafeInteger(bill.expires_at) || bill.expires_at <= bill.issued_at) problems.push('BILL_WINDOW')
  if (isHex(bill.operator_pk, 32) && !verifyObject(bill, bill.operator_pk)) problems.push('BILL_SIGNATURE')
  return [...new Set(problems)]
}

/** Why the lender must not accept this bill for its request; empty when it names exactly this check, at the offer's price. */
export function billProblems(bill: BilledCheckReceipt, x: { offer: CheckOffer; request: CheckMessage; commitment: Hex; lenderPk: Hex; borrowerPk: Hex; now?: number }): string[] {
  const problems = billSignatureProblems(bill)
  if (problems.includes('BILL_MALFORMED')) return problems
  if (bill.operator_pk !== x.offer.operator_pk) problems.push('BILL_OTHER_OPERATOR')
  if (bill.lender_pk !== x.lenderPk || bill.borrower_pk !== x.borrowerPk) problems.push('BILL_OTHER_PARTIES')
  if (bill.negotiation_id !== x.request.negotiation_id || bill.request_hash !== checkMessageHash(x.request)) problems.push('BILL_OTHER_REQUEST')
  if (bill.offer_hash !== offerHash(x.offer) || bill.release_hash !== releaseHash(x.offer.release)) problems.push('BILL_OTHER_OFFER')
  if (bill.commitment !== x.commitment) problems.push('BILL_OTHER_COMMITMENT')
  if (bill.fee.asset_id !== x.offer.price.asset_id || bill.fee.amount !== x.offer.price.amount) problems.push('BILL_NOT_THE_OFFERED_PRICE')
  if (x.now !== undefined && (bill.issued_at > x.now + 300 || bill.expires_at <= x.now)) problems.push('BILL_WINDOW')
  return [...new Set(problems)]
}

/** Where a forwarded K came from: the paid HODL invoice's preimage, the operator after payment, or the operator with a bill. */
export type KeySource = 'lightning-preimage' | 'operator-result' | 'operator-billed'

/**
 * A billed check's K binding: the operator's RESULT carries K and a bill naming exactly this check, lender,
 * borrower, commitment and the offer's price; sha256(K) is the committed key hash. Empty when it holds.
 */
export function billedKeyProblems(chain: CheckMessage[], c: { commitment: Hex; key_hash: Hex; payment: { rail: string } }, key: Hex, x: { offer: CheckOffer; lenderPk: Hex; borrowerPk: Hex; now?: number }): string[] {
  if (c?.payment?.rail !== BILL_AT_CLOSE) return ['NOT_BILLED']
  const result = chain.find((m) => m?.type === 'RESULT' && (m.body as { status?: string }).status === 'billed')
  const body = result?.body as { key?: unknown; bill?: BilledCheckReceipt } | undefined
  if (!result || !body?.bill) return ['BILL_MISSING']
  const problems: string[] = []
  if (body.key !== key || !isHex(key, 32) || keyHash(key) !== c.key_hash) problems.push('KEY_DOES_NOT_MATCH_COMMITMENT')
  if (!chain[0] || chain[0].type !== 'REQUEST') problems.push('BILL_OTHER_REQUEST')
  else problems.push(...billProblems(body.bill, { offer: x.offer, request: chain[0], commitment: c.commitment, lenderPk: x.lenderPk, borrowerPk: x.borrowerPk, ...(x.now !== undefined ? { now: x.now } : {}) }))
  return [...new Set(problems)]
}

/** The bill in a chain, when there is one. */
export function billInChain(chain: CheckMessage[]): BilledCheckReceipt | null {
  const result = chain.find((m) => m?.type === 'RESULT' && (m.body as { status?: string }).status === 'billed')
  return (result?.body as { bill?: BilledCheckReceipt } | undefined)?.bill ?? null
}
