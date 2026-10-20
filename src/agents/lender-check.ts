// The lender's half of a lender-paid check (passbook-check/v1, payer mode
// `lender`), for a borrower whose keys and data stay on a phone. The borrower
// sends its part (consent + bundle sealed to the operator, borrower-check.ts);
// the lender:
//
//   1. checks the part: the borrower's signature, a consent naming this
//      operator, this release, payer = lender, this negotiation and lender;
//      the offer against its own check-node rules;
//   2. sends the REQUEST (signed by the lender, carrying the part unchanged);
//   3. external provider: relays the operator's draft to the borrower (APPROVAL_REQUEST),
//      checks that it binds the agreed loan and that the borrower's approval
//      verifies over the exact contract version, then forwards it (APPROVE);
//   4. verifies the operator's commitment and signed close-time bill;
//   5. receives the result and signed bill due at close (no up-front payment);
//   6. opens and verifies the result like any forwarded check
//      (verifyForwardedCheck: the chain, the commitment, K, the DSSE envelope
//      through external verifier, and the outputs v2 naming the agreed loan);
//   7. forwards K to the borrower (KEY, kind 7533), whatever the verdict: the
//      borrower's own result is never withheld.
//
// No up-front payment is made. An invalid result is reported through
// verification.ok and the caller declines; K is forwarded to its owner first.
// src/agents/lender.ts calls runLenderCheck in one place.

import type { Hex } from '../core/crypto.js'
import { randomHex, signObject } from '../core/crypto.js'
import { KIND } from '../market/kinds.js'
import { borrowerCheckPartProblems, CHECK_RELAY_DOMAIN, CheckRefused, type BorrowerCheckPart, type CheckRelayMessage, type CheckRelayRefusal } from '../checknode/borrower-check.js'
import { chunkedBus, type CheckBus } from '../checknode/bus.js'
import { listOffers, verifyForwardedCheck, type ForwardedCheckVerification, type KeyBody } from '../checknode/client.js'
import { appendCheckMessage, CHECK_EVENT_KIND, checkChainProblems, checkMessageHash, type CheckMessage } from '../checknode/messages.js'
import type { FeedbackBody, RequestBody, ResultBody } from '../checknode/node.js'
import { offerHash, type CheckOffer } from '../checknode/offer.js'
import { RAIL_LABEL } from '../checknode/rail.js'
import { billedKeyProblems, billInChain, type BilledCheckReceipt } from '../checknode/bill.js'
import { pickCheckNode, type CheckNodeRules } from '../checknode/select.js'
import type { TeeVerifierConfig } from '../checknode/tee.js'
import type { ScoredLoan } from '../scorer/types.js'
import type { LenderExpectations, TrustPolicy } from '../scorer/verify.js'

export { CheckRefused }

export interface LenderCheckOptions {
  /** The lender's relay connection; bus.key is the lender's key and the payer of the check. */
  bus: CheckBus
  part: BorrowerCheckPart
  /** The offer the part names; read from the relay when absent. */
  offer?: CheckOffer
  rail?: 'bill-at-close'
  /** The asset the lender pays with; the offer's price asset when absent. */
  payWith?: string
  /** The lender's signed check_nodes rules. */
  rules: CheckNodeRules
  trust: TrustPolicy
  tee: TeeVerifierConfig
  requiredChecks: string[]
  externalVerifier?: LenderExpectations['externalVerifier']
  /** The loan this lender agreed: the draft and the outputs (v2) must name exactly it. */
  loan: ScoredLoan
  now?: number
  timeoutMs?: number
  /** How long the borrower has to approve the external provider contract. */
  approvalTimeoutMs?: number
  beforeBill?: (offer: CheckOffer) => void | Promise<void>
  log?: (line: string) => void
}

/** The options type under the name P1's lender.ts (payForCheck) imports. */
export type RunLenderCheckOptions = LenderCheckOptions

export interface LenderCheckResult {
  verification: ForwardedCheckVerification
  bill: BilledCheckReceipt
  /** The KEY sent to the borrower. */
  key: CheckMessage
  fee: { asset_id: string; amount: number; rail_label: string; due: 'at-close' }
  consent_hash: Hex
  offer: CheckOffer
}

/** Waits for the borrower's part on kind 7533 (when P1's negotiation does not carry it). */
export async function receiveBorrowerCheckPart(bus: CheckBus, borrowerPk: Hex, negotiationId: Hex, timeoutMs = 300_000): Promise<BorrowerCheckPart> {
  const { payload } = await chunkedBus(bus).receive<CheckRelayMessage>(KIND.CHECK_KEY, borrowerPk, { timeoutMs, match: (m) => m?.domain === CHECK_RELAY_DOMAIN && m.type === 'PART' && m.negotiation_id === negotiationId && m.borrower_pk === borrowerPk })
  return payload as BorrowerCheckPart
}

// The draft-binds-the-agreed-loan check is shared with the phone lender's browser-safe half (src/checknode/lender-core.ts).

export async function runLenderCheck(opts: LenderCheckOptions): Promise<LenderCheckResult> {
  // Large check messages (the part, the sealed result, the KEY chain) travel chunked under the relays' size limit.
  const o = { ...opts, bus: chunkedBus(opts.bus) }
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const lender = o.bus.key
  const part = o.part
  const neg = part?.negotiation_id
  const say = (l: string) => o.log?.(l)
  const timeoutMs = o.timeoutMs ?? 600_000
  const tell = async (payload: CheckRelayMessage | CheckMessage) => { await o.bus.send(KIND.CHECK_KEY, payload, part.borrower_pk, [['n', neg]]) }
  const refuseBorrower = async (reason: string) => {
    const r: CheckRelayRefusal = signObject({ v: 1 as const, domain: CHECK_RELAY_DOMAIN, type: 'REFUSED' as const, negotiation_id: neg, from_pk: lender.pubkey, to_pk: part.borrower_pk, reason: reason.slice(0, 200) }, lender.secretKey)
    await tell(r).catch(() => undefined)
  }
  // Everything before payment: refuse with a code, tell the borrower, move no money.
  const refuse = async (reason: string): Promise<never> => {
    await refuseBorrower(reason)
    throw new CheckRefused(reason)
  }

  // 1. The part and the offer.
  let offer = o.offer
  if (!offer) {
    const { valid } = await listOffers(o.bus, now)
    offer = valid.find((x) => offerHash(x) === part?.offer_hash)
    if (!offer) return refuse('OFFER_NOT_ON_RELAY')
  }
  const partIssues = borrowerCheckPartProblems(part, { lenderPk: lender.pubkey, negotiationId: neg, offer, now })
  if (partIssues.length) return refuse(partIssues.join(','))
  const rail = 'bill-at-close' as const
  const payWith = o.payWith ?? offer.price.asset_id
  const pick = pickCheckNode([offer], { ...o.rules, agreement: undefined }, { payer: 'lender', payment_asset_id: payWith, rails: [rail] }, { trust: o.trust, tee: o.tee })
  if (!pick.picked) return refuse(`CHECK_NODE: ${pick.rejected[0]?.problems.join(',') ?? 'not eligible'}`)

  await o.beforeBill?.(offer)

  // 2. The REQUEST, signed by the lender, carrying the borrower's part unchanged.
  const chain: CheckMessage[] = []
  const body: RequestBody = { offer_hash: offerHash(offer), request_nonce: randomHex(32), consent: part.consent, check_request: part.check_request, rail, pay_with: payWith, payer: 'lender', ...(part.receipt_invoice ? { receipt_invoice: part.receipt_invoice } : {}) }
  const request = appendCheckMessage(chain, lender, offer.operator_pk, 'REQUEST', body as unknown as Record<string, unknown>, neg)
  const ours = (m: CheckMessage) => m?.negotiation_id === neg && m.prev_hash === checkMessageHash(chain.at(-1)!)
  await o.bus.send(CHECK_EVENT_KIND.REQUEST, request, offer.operator_pk, [['n', neg]])
  say(`check ${neg.slice(0, 8)}: REQUEST sent to ${offer.operator_pk.slice(0, 12)}… (the lender pays)`)
  let fb = await o.bus.receive<CheckMessage>(KIND.CHECK_FEEDBACK, offer.operator_pk, { timeoutMs, match: ours }).catch(() => null)
  if (!fb) return refuse('OPERATOR_TIMEOUT')
  chain.push(fb.payload)

  if ((fb.payload.body as unknown as FeedbackBody).status === 'consent-required') return refuse('EXTERNAL_APPROVAL_PLUGIN_REQUIRED')
  const feedback = fb.payload.body as unknown as FeedbackBody
  if (feedback.status === 'error') return refuse(`operator: ${feedback.reason}`)
  if (feedback.status !== 'billed') return refuse('UNEXPECTED_FEEDBACK')
  const chainIssues = checkChainProblems(chain, { negotiation_id: neg, payer_pk: lender.pubkey, operator_pk: offer.operator_pk })
  if (chainIssues.length) return refuse(`CHAIN: ${chainIssues.join('; ')}`)

  const c = feedback.commitment
  const result = await o.bus.receive<CheckMessage>(KIND.CHECK_RESULT, offer.operator_pk, { timeoutMs, match: ours }).catch(() => null)
  if (!result) return refuse('OPERATOR_TIMEOUT')
  chain.push(result.payload)
  const key = (result.payload.body as unknown as ResultBody).key
  const issues = billedKeyProblems(chain, c, key, { offer, lenderPk: lender.pubkey, borrowerPk: part.borrower_pk, now })
  if (issues.length) return refuse(`BILL: ${issues.join(',')}`)
  const bill = billInChain(chain)!
  say(`check ${neg.slice(0, 8)}: billed at close, not paid up front`)

  // 6 and 7. Forward K to the borrower, then verify exactly what was forwarded.
  const keyBody: KeyBody = { offer, chain: [...chain], key, key_source: 'operator-billed' as const, rail_label: RAIL_LABEL[rail] }
  const keyMsg = appendCheckMessage(chain, lender, part.borrower_pk, 'KEY', keyBody as unknown as Record<string, unknown>)
  await tell(keyMsg)
  const verification = await verifyForwardedCheck(keyMsg, { negotiation_id: neg, borrower_pk: part.borrower_pk, lender_pk: lender.pubkey, payer_pk: lender.pubkey, rules: o.rules, trust: o.trust, tee: o.tee, requiredChecks: o.requiredChecks, externalVerifier: o.externalVerifier, loan: o.loan, now: o.now ?? Math.floor(Date.now() / 1000) })
  say(`check ${neg.slice(0, 8)}: K forwarded to the borrower; lender verification ${verification.ok ? 'PASS' : `FAIL (${verification.ticks.filter((t) => !t.ok).map((t) => t.id).join(', ')})`}`)
  return { verification, bill, key: keyMsg, fee: { asset_id: c.payment.asset_id, amount: c.payment.amount, rail_label: RAIL_LABEL[rail], due: 'at-close' }, consent_hash: c.consent_hash, offer }
}
