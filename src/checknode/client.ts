// The payer's and the other party's side of passbook-check/v1.
//
// Payer (the borrower by default): list offers, pick one by policy (select.ts),
// sign a consent naming the operator, send the REQUEST, check the operator's
// signed commitment and invoice BEFORE paying, pay, open the sealed result
// with K, then forward the chain and K to the lender (KEY).
//
// Other party (the lender): verifyForwardedCheck re-checks everything from the
// forwarded messages alone: the chain, the offer against its own rules, the
// commitment, K against the commitment, the plaintext, then the scorer
// evidence with the existing verifier (verify.ts). It never trusts the payer.

import { hashObject, randomHex, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { KIND } from '../market/kinds.js'
import type { Event } from '../market/messages.js'
import { consentHash, signConsent, type ConsentReceipt } from '../scorer/consent.js'
import { encryptCheckRequest } from '../scorer/providers.js'
import type { ScorerOutcome } from '../scorer/types.js'
import { verifyOutcomeForLender, type LenderExpectations, type LenderVerification, type TrustPolicy } from '../scorer/verify.js'
import type { Bundle } from '../sandbox/types.js'
import { chunkedBus, type CheckBus } from './bus.js'
import { appendCheckMessage, CHECK_EVENT_KIND, checkChainProblems, checkMessageHash, type CheckMessage } from './messages.js'
import type { FeedbackBody, RequestBody, ResultBody } from './node.js'
import { latestOffers, offerHash, offerProblems, releaseHash, scorerDescriptor, type CheckOffer } from './offer.js'
import { RAIL_LABEL, type LightningCheckRail, type PayerRail } from './rail.js'
import { keyHash, openResult, reportData, sealedHash, type CheckCommitment, type SealedResult } from './seal.js'
import { pickCheckNode, type CheckNodePick, type CheckNodeRules, type PayerConstraints } from './select.js'
import { CheckRefused } from './borrower-check.js'
import { billedKeyProblems, type KeySource } from './bill.js'
import { deriveExecution, EXECUTION_TIER_LABEL, executionAtLeast, type DerivedExecution, type TeeVerifierConfig, type Tick } from './tee.js'

export async function listOffers(bus: CheckBus, now: number): Promise<{ valid: CheckOffer[]; rejected: { operator_pk: string; problems: string[] }[] }> {
  const events = await bus.publicEvents(KIND.CHECK_OFFER)
  const parsed = events.flatMap((e) => {
    try { return [{ offer: JSON.parse(e.content) as unknown, created_at: e.created_at, pubkey: e.pubkey }] } catch { return [] }
  })
  return latestOffers(parsed, now)
}

/** What the payer sends to the other party: everything needed to verify without trusting the payer. */
export interface KeyBody {
  offer: CheckOffer
  chain: CheckMessage[]
  key: Hex
  /** Where K came from: the Lightning preimage (HODL) or the operator's RESULT (fallback). */
  key_source: KeySource
  rail_label: string
}

export interface PaidCheckResult {
  offer: CheckOffer
  pick: CheckNodePick | null
  chain: CheckMessage[]
  commitment: CheckCommitment
  sealed: SealedResult
  key: Hex
  key_source: KeyBody['key_source']
  outcome: ScorerOutcome
  consent: ConsentReceipt
}

// One refusal type for both halves; the borrower half is browser-safe (borrower-check.ts).
export { CheckRefused }

/** Checks the operator's answer before any money moves: everything that can be checked without K. */
export async function commitmentProblemsBeforePaying(c: CheckCommitment, ctx: { offer: CheckOffer; request: CheckMessage; consent: ConsentReceipt; rail: LightningCheckRail; payWith: string; payer: PayerRail; sealed: SealedResult }): Promise<string[]> {
  const problems: string[] = []
  const asset = ctx.offer.accepted_assets.find((a) => a.asset_id === ctx.payWith)
  if (c?.v !== 1 || c.domain !== 'passbook-check-commitment-v1') return ['COMMITMENT_MALFORMED']
  if (c.operator_pk !== ctx.offer.operator_pk) problems.push('COMMITMENT_OTHER_OPERATOR')
  else if (!verifyObject(c, c.operator_pk)) problems.push('COMMITMENT_SIGNATURE')
  if (c.consent_hash !== consentHash(c.consent) || c.report_data !== reportData(c.commitment, c.request_nonce)) problems.push('COMMITMENT_INCONSISTENT')
  // The blob must be the one committed to; a mismatch found only after paying would cost the fee.
  if (sealedHash(ctx.sealed) !== c.ciphertext_hash) problems.push('SEALED_NOT_COMMITTED')
  if (c.request_hash !== checkMessageHash(ctx.request) || c.request_nonce !== (ctx.request.body as unknown as RequestBody).request_nonce) problems.push('COMMITMENT_OTHER_REQUEST')
  if (c.offer_hash !== offerHash(ctx.offer) || c.release_hash !== releaseHash(ctx.offer.release)) problems.push('COMMITMENT_OTHER_OFFER')
  if (hashObject(c.consent) !== hashObject(ctx.consent)) problems.push('COMMITMENT_OTHER_CONSENT')
  if (!asset || c.payment.asset_id !== asset.asset_id || c.payment.amount !== asset.amount) problems.push('PRICE_NOT_AS_OFFERED')
  if (c.payment.rail !== ctx.rail) problems.push('RAIL_CHANGED')
  if (ctx.rail === 'rgb-ln-hodl' && c.payment.payment_hash !== c.key_hash) problems.push('HODL_INVOICE_NOT_LOCKED_TO_KEY')
  try {
    const d = await ctx.payer.decode(c.payment.invoice)
    if (d.payment_hash !== c.payment.payment_hash || d.asset_id !== c.payment.asset_id || d.asset_amount !== c.payment.amount) problems.push('INVOICE_NOT_AS_COMMITTED')
    if (d.timestamp + d.expiry_sec < Math.floor(Date.now() / 1000) + 30) problems.push('INVOICE_EXPIRED')
  } catch {
    problems.push('INVOICE_UNREADABLE')
  }
  return problems
}

export interface RunCheckOptions {
  bus: CheckBus
  payer: KeyPair
  /** The borrower's key; the payer when the borrower pays. Signs the consent. */
  borrower: KeyPair
  lenderPk: Hex
  negotiationId: Hex
  bundle: Bundle
  offer: CheckOffer
  rail: LightningCheckRail
  payWith: string
  payerRail: PayerRail
  dataCategories: string[]
  pick?: CheckNodePick
  now?: number
  timeoutMs?: number
  /** Called after the commitment checks pass and before money moves, e.g. to show the invoice. */
  beforePay?: (c: CheckCommitment) => Promise<void> | void
  /** The borrower's RGB invoice for the check receipt (a UDA holding hashes only). */
  receiptInvoice?: string
}

/** The payer runs one paid check against one offer. */
export async function runPaidCheck(opts: RunCheckOptions): Promise<PaidCheckResult> {
  // The node may chunk large answers for the public relays (wire.ts).
  const o = { ...opts, bus: chunkedBus(opts.bus) }
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const offerIssues = offerProblems(o.offer, now)
  if (offerIssues.length) throw new CheckRefused(offerIssues.join(','))
  const payerRole = o.payer.pubkey === o.borrower.pubkey ? 'borrower' : 'lender'
  const descriptor = scorerDescriptor(o.offer)
  const consent = signConsent(o.borrower, {
    purpose: `credit assessment for negotiation ${o.negotiationId.slice(0, 16)} by check node ${o.offer.operator_pk.slice(0, 16)}`,
    purpose_id: o.negotiationId, scorer_id: descriptor.scorer_id, ...(descriptor.enclave_pubkey ? { scorer_pk: descriptor.enclave_pubkey } : {}),
    contract_hash: descriptor.contract_hash, operator_pk: o.offer.operator_pk, lender_pk: o.lenderPk, payer: payerRole, release_hash: releaseHash(o.offer.release),
    data_categories: o.dataCategories, issued_at: now, expires_at: now + 3600,
  })
  const chain: CheckMessage[] = []
  const checkRequest = encryptCheckRequest(o.borrower, descriptor, o.bundle, consent)
  const body: RequestBody = { offer_hash: offerHash(o.offer), request_nonce: randomHex(32), consent, check_request: checkRequest, rail: o.rail, pay_with: o.payWith, payer: payerRole, ...(o.receiptInvoice ? { receipt_invoice: o.receiptInvoice } : {}) }
  const request = appendCheckMessage(chain, o.payer, o.offer.operator_pk, 'REQUEST', body as unknown as Record<string, unknown>, o.negotiationId)
  const ours = (m: CheckMessage) => m?.negotiation_id === o.negotiationId && m.prev_hash === checkMessageHash(chain.at(-1)!)
  await o.bus.send(CHECK_EVENT_KIND.REQUEST, request, o.offer.operator_pk, [['n', o.negotiationId]])
  const timeoutMs = o.timeoutMs ?? 600_000
  let fb = await o.bus.receive<CheckMessage>(KIND.CHECK_FEEDBACK, o.offer.operator_pk, { timeoutMs, match: ours })
  chain.push(fb.payload)
  if ((fb.payload.body as unknown as FeedbackBody).status === 'consent-required') throw new CheckRefused('EXTERNAL_APPROVAL_PLUGIN_REQUIRED')
  const feedback = fb.payload.body as unknown as FeedbackBody
  if (feedback.status === 'error') throw new CheckRefused(feedback.reason)
  if (feedback.status !== 'payment-required') throw new CheckRefused('UNEXPECTED_FEEDBACK')
  const chainIssues = checkChainProblems(chain, { negotiation_id: o.negotiationId, payer_pk: o.payer.pubkey, operator_pk: o.offer.operator_pk })
  if (chainIssues.length) throw new CheckRefused(chainIssues.join('; '))
  const c = feedback.commitment
  const before = await commitmentProblemsBeforePaying(c, { offer: o.offer, request, consent, rail: o.rail, payWith: o.payWith, payer: o.payerRail, sealed: feedback.sealed })
  if (before.length) throw new CheckRefused(`not paying: ${before.join(',')}`)
  await o.beforePay?.(c)
  const paid = await o.payerRail.pay(c.payment.invoice, { asset_id: c.payment.asset_id, amount: c.payment.amount, payment_hash: c.payment.payment_hash }, timeoutMs)
  let key: Hex
  let keySource: KeyBody['key_source']
  if (o.rail === 'rgb-ln-hodl') {
    // Paying revealed K: the preimage of an invoice whose hash is sha256(K).
    if (!paid.preimage || keyHash(paid.preimage) !== c.key_hash) throw new CheckRefused('PAID_BUT_PREIMAGE_IS_NOT_K')
    key = paid.preimage
    keySource = 'lightning-preimage'
    // The operator's RESULT follows; read it so the chain is complete, but K is already ours.
    const result = await o.bus.receive<CheckMessage>(KIND.CHECK_RESULT, o.offer.operator_pk, { timeoutMs: 30_000, match: ours }).catch(() => null)
    if (result) chain.push(result.payload)
  } else {
    // FALLBACK, pay then deliver: K arrives only if the operator sends it.
    const result = await o.bus.receive<CheckMessage>(KIND.CHECK_RESULT, o.offer.operator_pk, { timeoutMs, match: ours }).catch(() => null)
    if (!result) throw new CheckRefused('PAID_BUT_NO_KEY: the operator did not deliver after payment (pay-then-deliver trusts the node)')
    chain.push(result.payload)
    key = (result.payload.body as unknown as ResultBody).key
    keySource = 'operator-result'
  }
  const opened = openResult(c, feedback.sealed, key, { operator_pk: o.offer.operator_pk, negotiation_id: o.negotiationId, borrower_pk: o.borrower.pubkey, lender_pk: o.lenderPk })
  if (!opened.plaintext || opened.problems.length) throw new CheckRefused(`result does not open: ${opened.problems.join(',')}`)
  return { offer: o.offer, pick: o.pick ?? null, chain, commitment: c, sealed: feedback.sealed, key, key_source: keySource, outcome: opened.plaintext.outcome, consent }
}

/** The payer hands the chain and K to the other party over the negotiation channel. */
export async function forwardKey(bus: CheckBus, payer: KeyPair, to: Hex, paid: PaidCheckResult): Promise<CheckMessage> {
  const chain = [...paid.chain]
  const rail = (paid.chain[0].body as unknown as RequestBody).rail
  const body: KeyBody = { offer: paid.offer, chain: paid.chain, key: paid.key, key_source: paid.key_source, rail_label: RAIL_LABEL[rail] }
  const m = appendCheckMessage(chain, payer, to, 'KEY', body as unknown as Record<string, unknown>)
  // The KEY carries the whole chain, the sealed bundle included: chunked under the public relays' size limit (wire.ts).
  await chunkedBus(bus).send(CHECK_EVENT_KIND.KEY, m, to, [['n', m.negotiation_id]])
  return m
}

export interface ForwardedCheckVerification {
  ok: boolean
  /** The released outputs, for a 2-of-N comparison (agreementProblems). */
  outputs?: { recommendation: string; income_band: string } | null
  ticks: Tick[]
  operator_pk: Hex | null
  release_hash: Hex | null
  execution: DerivedExecution | null
  rail_label: string | null
  commitment: CheckCommitment | null
  outcome: ScorerOutcome | null
  scorer: LenderVerification | null
}

/** The other party verifies a forwarded check from the KEY message alone. */
export async function verifyForwardedCheck(key: CheckMessage, expect: { negotiation_id: Hex; borrower_pk: Hex; lender_pk: Hex; payer_pk: Hex; rules: CheckNodeRules; trust: TrustPolicy; tee: TeeVerifierConfig; requiredChecks: string[]; externalVerifier?: LenderExpectations['externalVerifier']; loan?: LenderExpectations['loan']; now: number }): Promise<ForwardedCheckVerification> {
  const ticks: Tick[] = []
  const tick = (id: string, ok: boolean, detail: string) => ticks.push({ id, ok, detail })
  const fail = (): ForwardedCheckVerification => ({ ok: false, ticks, operator_pk: null, release_hash: null, execution: null, rail_label: null, commitment: null, outcome: null, scorer: null })
  const b = key?.body as unknown as KeyBody
  if (!b?.offer || !Array.isArray(b.chain)) { tick('key-message', false, 'not a KEY message'); return fail() }
  const offer = b.offer
  const chain = [...b.chain, key]
  const chainIssues = checkChainProblems(chain, { negotiation_id: expect.negotiation_id, payer_pk: expect.payer_pk, operator_pk: offer.operator_pk })
  tick('message-chain', chainIssues.length === 0, chainIssues.length ? chainIssues.join('; ') : `${chain.length} messages, hash-chained and signed, negotiation ${expect.negotiation_id.slice(0, 12)}…`)
  // The offer was valid when the check ran; it may have expired since.
  const request = chain[0]
  const offerIssues = offerProblems(offer, Math.min(expect.now, offer.expires - 1)).filter((p) => p !== 'OFFER_EXPIRED')
  tick('offer', offerIssues.length === 0 && (request?.body as unknown as RequestBody)?.offer_hash === offerHash(offer), offerIssues.length ? offerIssues.join(',') : 'the request names this signed offer')
  // One check's eligibility; a 2-of-N rule is checked across checks (agreementProblems).
  const pick = pickCheckNode([{ ...offer, expires: Math.max(offer.expires, expect.now + 1) }], { ...expect.rules, agreement: undefined }, { payer: expect.payer_pk === expect.borrower_pk ? 'borrower' : 'lender', payment_asset_id: (request?.body as unknown as RequestBody)?.pay_with, vouchers_held: [(request?.body as unknown as RequestBody)?.pay_with], rails: [(request?.body as unknown as RequestBody)?.rail] }, { trust: expect.trust, tee: expect.tee })
  tick('lender-rules', !!pick.picked, pick.picked ? 'operator, release, trust and execution meet the lender\'s check-node rules' : (pick.rejected[0]?.problems.join(', ') ?? 'no offer'))
  // A paid check's commitment arrives with 'payment-required'; a billed one (bill-at-close) with 'billed'.
  const feedback = chain.find((m) => m.type === 'FEEDBACK' && ['payment-required', 'billed'].includes((m.body as { status?: string }).status ?? ''))?.body as unknown as FeedbackBody | undefined
  if (!feedback || (feedback.status !== 'payment-required' && feedback.status !== 'billed')) { tick('commitment', false, 'no commitment in the chain'); return { ...fail(), operator_pk: offer.operator_pk } }
  const c = feedback.commitment
  // The consent the operator signed in must name who paid and this release (older consents name neither; a lender-paid one must).
  const payerRole = expect.payer_pk === expect.borrower_pk ? 'borrower' : 'lender'
  const consentPayerOk = (c?.consent?.payer === undefined && payerRole === 'borrower') || c?.consent?.payer === payerRole
  const consentReleaseOk = (c?.consent?.release_hash === undefined && payerRole === 'borrower') || c?.consent?.release_hash === releaseHash(offer.release)
  tick('consent-payer-release', consentPayerOk && consentReleaseOk, !consentPayerOk ? `the consent names payer ${c?.consent?.payer ?? 'none'}, the ${payerRole} paid` : !consentReleaseOk ? 'the consent names another release than the offer ran' : `the borrower consented to this release, paid by the ${payerRole}`)
  const opened = openResult(c, feedback.sealed, b.key, { operator_pk: offer.operator_pk, negotiation_id: expect.negotiation_id, borrower_pk: expect.borrower_pk, lender_pk: expect.lender_pk })
  tick('commitment', opened.problems.length === 0 && !!opened.plaintext, opened.problems.length ? opened.problems.join(',') : 'K opens the sealed result; sha256(plaintext) equals the operator-signed commitment')
  if (b.key_source === 'operator-billed') {
    const billIssues = billedKeyProblems(chain, c, b.key, { offer, lenderPk: expect.lender_pk, borrowerPk: expect.borrower_pk })
    tick('key-binding', billIssues.length === 0, billIssues.length ? billIssues.join(',') : `${RAIL_LABEL['bill-at-close']}: K came in the operator's RESULT with a signed bill for this check`)
  } else tick('key-binding', b.key_source === 'lightning-preimage' ? c.payment.rail === 'rgb-ln-hodl' && c.payment.payment_hash === keyHash(b.key) : c.payment.rail === 'rgb-ln-pay-then-deliver', b.key_source === 'lightning-preimage' ? 'K is the preimage of the paid HODL invoice' : `${RAIL_LABEL['rgb-ln-pay-then-deliver']}: K came from the operator after payment`)
  // The tier is granted per result: the fresh attestation must carry this commitment's report data and result_key must sign it.
  const fresh = feedback.tee ? { attestation: feedback.tee.attestation, result_sig: feedback.tee.result_sig, commitment_hash: c.commitment, report_data: c.report_data } : undefined
  const execution = deriveExecution(offer.execution, offer.release, expect.tee, fresh)
  const minExecution = expect.rules.min_execution ?? 'software'
  tick('execution-tier', executionAtLeast(execution.tier, minExecution), `${EXECUTION_TIER_LABEL[execution.tier]}${offer.execution.tee !== 'none' && execution.tier !== 'tee-attested' ? ` (claimed ${offer.execution.tee}; ${fresh ? 'the result\'s attestation does not verify' : 'no attestation for this result'})` : ''}; the lender needs ${minExecution === 'tee' ? 'a TEE-attested result' : 'software evidence or better'}`)
  if (!opened.plaintext) return { ok: false, ticks, operator_pk: offer.operator_pk, release_hash: releaseHash(offer.release), execution, rail_label: b.rail_label, commitment: c, outcome: null, scorer: null }
  const outcome = opened.plaintext.outcome
  const purposeId = expect.negotiation_id
  const scorer = await verifyOutcomeForLender(outcome, { ...expect.trust, marketOperators: [offer.operator_pk] }, { lenderPk: expect.lender_pk, borrowerPk: expect.borrower_pk, purposeId, consentHash: c.consent_hash, requiredChecks: expect.requiredChecks, externalVerifier: expect.externalVerifier, ...(expect.loan ? { loan: expect.loan } : {}) })
  for (const t of scorer.ticks) ticks.push({ ...t, id: `scorer:${t.id}` })
  const scorerMatchesOffer = outcome.descriptor.code_measurement === offer.release.image_digest && outcome.descriptor.contract_hash === offer.release.scoring_contract_hash && outcome.descriptor.scorer_id === offer.scorer.scorer_id && (outcome.descriptor.provider !== 'container' || outcome.descriptor.operator_declaration?.operator_pk === offer.operator_pk)
  tick('scorer-is-offered-release', scorerMatchesOffer, 'the evidence comes from the release the offer named')
  return { ok: ticks.every((t) => t.ok) && scorer.ok, outputs: scorer.outputs ? { recommendation: scorer.outputs.recommendation, income_band: scorer.outputs.income_band } : null, ticks, operator_pk: offer.operator_pk, release_hash: releaseHash(offer.release), execution, rail_label: b.rail_label, commitment: c, outcome, scorer }
}

/** Lists, picks and pays in one call: the borrower agent's structure-step helper. */
export async function pickAndRun(o: Omit<RunCheckOptions, 'offer' | 'rail' | 'payWith' | 'pick'> & { rules: CheckNodeRules; constraints: PayerConstraints; trust: TrustPolicy; tee: TeeVerifierConfig }): Promise<PaidCheckResult> {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const { valid } = await listOffers(o.bus, now)
  const pick = pickCheckNode(valid, o.rules, o.constraints, { trust: o.trust, tee: o.tee })
  // runPaidCheck pays over Lightning; bill-at-close is the phone lender's rail (lender-core.ts).
  if (!pick.picked || !pick.picked.rail || !pick.picked.pay_with || pick.picked.rail === 'rgb-onchain' || pick.picked.rail === 'bill-at-close') throw new CheckRefused(pick.why.join(' ') || 'NO_LIGHTNING_RAIL')
  return runPaidCheck({ ...o, offer: pick.picked.offer, rail: pick.picked.rail, payWith: pick.picked.pay_with.asset_id, pick })
}

export type { Event }
