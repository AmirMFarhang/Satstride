// The lender agent on the phone (M6). It speaks the laptop lender's v1 protocol unchanged
// (src/agents/lender.ts, the standalone peer of src/cli/peer.ts --role lender):
//   publishOffer -> nextApplication (review: the sandbox's signed result, its run record,
//   the borrower's passbook on Bitcoin; price; register; accept) -> fund (verify the lock
//   and the borrower-signed default split, disburse over RGB, per-loan repayment account
//   watched by the platform) -> awaitIou -> confirmRepayment -> signRelease -> payFees.
// Every number and every check comes from the shared code in src/; every signature from
// the party key in the worklet. Policy computes every financial number; no model is
// consulted (the phone has none yet: M4). It never mines: the laptop's regtest service does.
// Lane E3: a negotiated offer (its 38388 carries the signed policy's NegotiationTerms) is served
// over Nostr by src/lender/desk.ts, with the credit check billed at close and the term sheet
// approved on the phone; its application comes through review() to the desk, and fund() and
// payFee() check the countersigned sheet and the billed checks. Not here (laptop only): RGB
// Lightning (v2) terms, IOU sales.

import { canonicalJson, hashObject, verifyHash, verifyObject, randomHex, type Hex } from '../../../../src/core/crypto.js'
import { btc, collateralFor, ltvBps, usdt, type Micro } from '../../../../src/core/money.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm, termInterest } from '../../../../src/core/economics.js'
import { debtOf, termsHash, type LoanTerms } from '../../../../src/core/terms.js'
import {
  addLeafSignature, buildEscrowSpend, describe as describePsbt, escrowFor, leafSignature, partiesOf, psbtFromBase64,
  releaseOutputs, splitLocktime, splitOutputs, unsignedTxid, verifyLeafSignature,
} from '../../../../src/escrow/escrow.js'
import { bytesToHex } from '../../../../src/core/crypto.js'
import { KIND } from '../../../../src/market/kinds.js'
import type { AcceptancePayload, ApplicationPayload, FundedPayload, OfferPayload, RepaidPayload, SignaturePayload, SignRequestPayload } from '../../../../src/market/messages.js'
import { verifyOwnership, type IouCertificate, type IouOwnership } from '../../../../src/market/iou.js'
import { lenderReturnLine } from '../../../../src/market/termsheet.js'
import { verifyQuote } from '../../../../src/oracle/oracle.js'
import { verifyPassbook, type RgbRepaymentReceipt } from '../../../../src/registry/passbook-doc.js'
import { RuleReasoner } from '../../../../src/ai/rule-reasoner.js'
import { verifyRunRecord, type RunMaterials } from '../../../../src/sandbox/run-record.js'
import { investigationAccepted } from '../../../../src/sandbox/investigation-policy.js'
import type { Attestation } from '../../../../src/sandbox/broker.js'
import type { LenderSandboxResult } from '../../../../src/sandbox/types.js'
import type { LenderPolicy } from '../../../../src/agents/lender.js'
import pin from './run-materials.json'
import { PHONE, type PhoneApproval } from './borrower'
import type { ChainPort, PartySigner, RepayPort, RgbPort, RgbTransferRow } from './ports'
import { parseAmbiguous } from '../core/sends'
import type { Check, PhoneLoanRecord, PhonePlatform } from './platform'
import type { PhoneRelay } from './relay'
import type { NegotiationTerms } from '../../../../src/market/negotiate-nostr.js'
import { approvalStatus, type Approval } from '../../../../src/market/approvals.js'
import { termSheetHash, termSheetProblems, type TermSheet } from '../../../../src/market/termsheet.js'
import type { DeskState } from '../lender/desk'
import { closeFees, type CloseFeeRecord, type HeldBill } from '../lender/fees'
import type { ReviewResult } from '../lender/review'

/**
 * The laptop's L2 policy (src/agents/lender.ts L2_POLICY): it lends on the chain record, no
 * income evidence, the earned ladder step decides the LTV. A parity test holds it to src/.
 * The person may change the range and the APR before posting (both are shown on the stop).
 */
export const PASSBOOK_ONLY: LenderPolicy = {
  d: 'usdt-30-record',
  min: 100_000_000,
  max: 5_000_000_000,
  apr_bps: 1100,
  term_blocks: 30,
  grace_blocks: 5,
  ltv_ladder_bps: [5000, 5500, 6000, 6500],
  requirements: { affordability: true, inflow_months: 0, inflow_multiple_bps: 0, investigation: 'optional' },
  band: [-100, 200],
  expires_in_blocks: 1000,
}

/**
 * What the phone posts: the L2 policy above with a 10 test USDT minimum, so a small test loan fits
 * (the Mutinynet two-phone run lends 10 test USDT; the integration owner's request, 18 October).
 * Every other number is L2's.
 */
export const PHONE_OFFER: LenderPolicy = { ...PASSBOOK_ONLY, min: 10_000_000 }

/** The sandbox run materials published by src/ (scripts/run-materials.ts pins them). */
export function expectedRunMaterials(modelId: string): RunMaterials {
  const m = (pin.models as Record<string, RunMaterials>)[modelId]
  if (m) return m
  return { system_prompt_sha256: pin.system_prompt_sha256, tool_definitions_sha256: pin.tool_definitions_sha256, model_id: modelId, model_file_sha256: null, model_material_kind: 'unavailable' }
}

const PAYOUT_REQUEST_DOMAIN = 'passbook-validated-payout-request-v1' as const

export interface SavedPayoutRequest {
  v: 1
  domain: typeof PAYOUT_REQUEST_DOMAIN
  loan_id: Hex
  lender_pk: Hex
  request: SignRequestPayload
  sig: Hex
}

function payoutRequestSealValid(saved: SavedPayoutRequest, loanId: Hex, lenderPk: Hex): boolean {
  return saved.v === 1 && saved.domain === PAYOUT_REQUEST_DOMAIN && saved.loan_id === loanId && saved.lender_pk === lenderPk && verifyObject(saved, lenderPk)
}

export interface LenderLoan {
  terms: LoanTerms
  borrower_pk: Hex
  accepted_at: number
  checks: Check[]
  memo: string
  /** the person's OK to fund (the lender's stop) */
  fund_approved?: boolean
  lock?: { txid: Hex; vout: number }
  /** the borrower-signed default split (leaf A), held for after maturity + grace */
  split_psbt?: string
  /** an attempted external send is reconciled, never blindly repeated */
  disbursement_attempted?: boolean
  disbursement_txid?: Hex
  repayment_invoice?: string
  repayment_recipient_id?: string
  repayment_account?: string
  iou?: IouOwnership
  repayment_txid?: Hex
  repayment_receipt?: RgbRepaymentReceipt
  iou_returned_txid?: Hex
  release_txid?: Hex
  released_height?: number
  fee_paid_txid?: Hex
  /** the platform closed it without a payout (a refund to the borrower after the funding window) */
  cancelled?: string
  /** a payout or a fee payment that was signed and may have been broadcast (the send failed late) */
  disbursement_pending?: Hex
  fee_pending?: Hex
  /** the borrower-chosen disbursement invoice, kept to finish a payout that went out */
  disbursement_invoice?: string
  /** Validated original borrower request, kept before indexing so a restart never needs a second relay event. */
  disbursement_request?: SavedPayoutRequest
  /** after the payout, each step done once, so a retry resumes the missing ones (platform notice, watch, FUNDED) */
  funded_recorded?: boolean
  repayment_watch_issued?: { invoice: string; recipient_id: string; backup: string; password: string; master_fingerprint: string }
  iou_invoice?: string
  funded_sent?: boolean
  /** Negotiated (lane E3): the lender-signed sheet (its hash is the loan id), the lender's approval, then the borrower's countersigned sheet from the split request. */
  termsheet?: TermSheet
  lender_approvals?: Approval[]
  negotiation_id?: Hex
  /** the credit check billed to this lender for this negotiation, charged with the platform fee at close */
  check_bill?: HeldBill
}

/** A payout stopped before any send may continue under the person's existing approval. */
export function canResumeApprovedPayout(l: LenderLoan, loanId: Hex): boolean {
  const saved = l.disbursement_request
  const req = saved?.request
  return !!l.fund_approved && !!l.lock && !!saved && payoutRequestSealValid(saved, loanId, l.terms.lender_pk) &&
    req?.purpose === 'split' && req.loan_id === loanId && req.terms_hash === loanId &&
    !l.disbursement_attempted && !l.disbursement_pending && !l.disbursement_txid && !l.release_txid && !l.cancelled
}

/**
 * auto_fund: the person approved paying out, at posting, to every borrower whose application
 * passes every check and whose collateral is then locked, within the offer. The protocol needs
 * it: a borrower waits only two minutes for the payout after locking (src/agents/borrower.ts).
 */
export interface LenderOffer { d: string; payload: OfferPayload; event_id: Hex; published_at: number; withdrawn?: boolean; auto_fund?: boolean; expired?: boolean }
export interface Declined { at: number; borrower_pk: Hex; principal: number; failed: Check[] }

/** What the phone keeps for the lender between app runs: public loan data and signatures only. */
export interface PhoneLenderState extends DeskState {
  offer?: LenderOffer
  loans: Record<Hex, LenderLoan>
  declined: Declined[]
  /** signed approval notes not yet accepted by the platform's wire, oldest first: retried until delivered */
  outbox?: object[]
}

/** From when the relay must listen for this lender after a restart: the oldest unfinished loan's acceptance. */
export function lenderRelayWindow(state: PhoneLenderState): number | null {
  const open = Object.values(state.loans).filter((l) => !l.release_txid && !l.cancelled)
  return open.length ? Math.min(...open.map((l) => l.accepted_at)) - 60 : null
}

export type Step = { step: string; detail?: Record<string, unknown> }

const APPROVAL_TITLES = {
  offer: 'Approved on the phone: post this offer and accept matching applications under its policy',
  fund: 'Approved on the phone: fund this loan once the collateral is locked',
  fee: 'Approved on the phone: pay the platform fee for this loan',
  termsheet: 'Approved on the phone: this term sheet, and lending once the collateral is locked',
} as const

export class PhoneLender {
  constructor(
    readonly key: PartySigner,
    readonly platform: PhonePlatform,
    readonly relay: PhoneRelay,
    readonly chain: ChainPort,
    readonly rgb: RgbPort,
    readonly repay: RepayPort,
    readonly assetId: string,
    readonly state: PhoneLenderState,
    private readonly onStep: (s: Step) => void = () => {},
    private readonly save: () => Promise<void> = async () => {},
    readonly economics = DEFAULT_ECONOMICS,
  ) {}

  get pubkey(): Hex { return this.key.pubkey }

  /** Write the lender's state to app storage now (after a change made by the negotiated desk). */
  async persist(): Promise<void> { await this.save() }

  /** On a public network: the test-data labels every public event carries (lend-flow sets them from the profile). */
  publicTags: string[][] = []

  /** A negotiated application goes here (src/lender/desk.ts review), set while a negotiated offer is posted. */
  negotiated?: (app: ApplicationPayload, borrowerPk: Hex) => Promise<ReviewResult>

  /** Narrate to the screen and, signed, to the platform's wire with the laptop lender's titles. */
  async say(step: string, detail?: Record<string, unknown>): Promise<void> {
    this.onStep({ step, detail })
    await this.flushOutbox()
    try { await this.platform.note(await this.key.signObject({ actor_pk: this.pubkey, role: 'lender', title: step, detail: { ...(detail ?? {}), device: PHONE } })) } catch { /* narration is best effort */ }
  }

  /** Deliver the signed approvals still waiting, oldest first (as the borrower's outbox). */
  async flushOutbox(): Promise<number> {
    const box = this.state.outbox ?? []
    while (box.length) {
      try { await this.platform.note(box[0]) } catch { break }
      box.shift()
      this.state.outbox = box
      await this.save()
    }
    return box.length
  }

  /** The person's approval at a lender stop, signed by the party key; never dropped (persisted outbox, as the borrower's). */
  async recordApproval(action: 'offer' | 'fund' | 'fee' | 'termsheet', subject: Record<string, unknown>): Promise<PhoneApproval & { waiting: number }> {
    const approval = await this.key.signObject({ v: 1 as const, domain: 'passbook-phone-approval-v1' as const, action, ...subject, approver_pk: this.pubkey, method: 'phone-lock' as const, approved_at: Math.floor(Date.now() / 1000) }) as unknown as PhoneApproval
    const note = await this.key.signObject({ actor_pk: this.pubkey, role: 'lender', title: APPROVAL_TITLES[action], detail: { approval, device: PHONE } })
    this.state.outbox = [...(this.state.outbox ?? []), note]
    await this.save()
    this.onStep({ step: APPROVAL_TITLES[action], detail: { approval } })
    return { ...approval, waiting: await this.flushOutbox() }
  }

  loan(id: Hex): LenderLoan {
    const l = this.state.loans[id]
    if (!l) throw new Error(`no loan ${id.slice(0, 12)} on this phone`)
    return l
  }

  offerId(policy: Pick<LenderPolicy, 'd'>): string { return `${this.pubkey}:${policy.d}` }

  /** A public relay keeps a test offer six hours at most (NIP-40); regtest has no labels and no expiry. */
  private publicLabelsWithExpiry(): string[][] {
    return this.publicTags.length ? [...this.publicTags, ['expiration', String(Math.floor(Date.now() / 1000) + 6 * 3600)]] : []
  }

  private interest(principal: Micro, aprBps: number, termBlocks: number): Micro {
    return termInterest({ principal, apr_bps: aprBps, term_blocks: termBlocks }, this.economics)
  }

  /** Post the offer to the relay (the platform's order book follows it). Refused while a platform fee is overdue. */
  async publishOffer(policy: LenderPolicy, opts: { autoFund?: boolean; negotiation?: NegotiationTerms } = {}): Promise<OfferPayload> {
    const owed = await this.platform.fees(this.pubkey).catch(() => null)
    if (owed?.blocked) {
      const due = owed.fees.filter((f) => f.status === 'fee_due')
      await this.say('Offer not published: platform fee overdue', { fees: due.map((f) => ({ loan_id: f.loan_id.slice(0, 12), amount: usdt(f.amount), grace_until: f.grace_until_height })) })
      throw new Error(`A platform fee is overdue (${due.length}, ${usdt(due.reduce((s, f) => s + f.amount, 0))}). Pay it first.`)
    }
    const height = await this.chain.getHeight()
    const payload: OfferPayload = {
      asset_id: this.assetId, min: policy.min, max: policy.max, apr_bps: policy.apr_bps, term_blocks: policy.term_blocks, grace_blocks: policy.grace_blocks,
      ltv_ladder_bps: policy.ltv_ladder_bps, requirements: policy.requirements, expires_height: height + policy.expires_in_blocks,
      // negotiated (E3): the signed market policy's structural terms; never its APR floor or LTV cap
      ...(opts.negotiation ? { negotiation: opts.negotiation } : {}),
    }
    const event = await this.relay.publishPublic(KIND.OFFER, payload, [['d', policy.d], ...this.publicLabelsWithExpiry()])
    this.state.offer = { d: policy.d, payload, event_id: event.id, published_at: Math.floor(Date.now() / 1000), auto_fund: opts.autoFund ?? false }
    await this.save()
    await this.say('Offer published to the relay', { offer_id: this.offerId(policy), apr: `${policy.apr_bps / 100}%`, range: `${usdt(policy.min)} to ${usdt(policy.max)}`, ladder: policy.ltv_ladder_bps, requirements: policy.requirements, negotiates: !!opts.negotiation })
    return payload
  }

  /** Withdraw the offer: republished expiring now, so the order book drops it. */
  async withdrawOffer(): Promise<void> {
    const o = this.state.offer
    if (!o) return
    const height = await this.chain.getHeight()
    await this.relay.publishPublic(KIND.OFFER, { ...o.payload, expires_height: height }, [['d', o.d], ...this.publicLabelsWithExpiry()])
    o.withdrawn = true
    await this.save()
    await this.say('Offer withdrawn', { offer_id: `${this.pubkey}:${o.d}` })
  }

  /**
   * Wait for the next application to the posted offer, review it and, if every check passes,
   * price it, register it with the platform and accept: the person approved this policy when
   * posting the offer (as the laptop peer's operator does). A failing application is declined
   * with its reasons kept on the phone.
   */
  async nextApplication(policy: LenderPolicy, timeoutMs = 600_000): Promise<{ loan_id: Hex } | { declined: Declined } | { proposal: Hex }> {
    const offerId = this.offerId(policy)
    const { payload: app, event } = await this.relay.receive<ApplicationPayload>(KIND.APPLICATION, null, { timeoutMs, match: (a) => a.offer_id === offerId })
    return this.review(policy, app, event.pubkey)
  }

  async review(policy: LenderPolicy, app: ApplicationPayload, borrowerPk: Hex): Promise<{ loan_id: Hex } | { declined: Declined } | { proposal: Hex }> {
    await this.say('Application received over Nostr', { from: borrowerPk.slice(0, 12), principal: usdt(app.principal), disclosed: app.disclosed_inflows.length })
    if ((app.negotiation !== undefined || app.check_key !== undefined) && this.negotiated) {
      // negotiated over Nostr with the credit check billed at close: the desk reviews it; a sheet waits for the person's approval
      const r = await this.negotiated(app, borrowerPk)
      if ('proposal' in r) return { proposal: r.proposal.loan_id }
      return { declined: { at: Math.floor(Date.now() / 1000), borrower_pk: borrowerPk, principal: app.principal, failed: r.declined.failed } }
    }
    const p = policy
    const offerId = this.offerId(p)
    const checks: Check[] = []
    const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail })
    if (app.check_key !== undefined || app.scorer_outcome !== undefined || app.negotiation !== undefined) {
      check('flow', false, 'a negotiated, scorer or check-market application needs the laptop lender; this phone takes v1 applications')
    }
    const { sandbox_pk, attestation: current } = await this.platform.sandboxPubkey()
    const state = await this.platform.state()
    const result = app.sandbox_result as LenderSandboxResult
    const attestation = app.attestation as Attestation
    // a delayed application to an offer that has expired or was withdrawn is never accepted
    const posted = this.state.offer
    check('offer-live', !!posted && posted.d === p.d && !posted.withdrawn && state.height < posted.payload.expires_height, posted ? `offer ${posted.withdrawn ? 'withdrawn' : `valid until block ${posted.payload.expires_height}, now ${state.height}`}` : 'no offer posted')
    check('amount', app.principal >= p.min && app.principal <= p.max && app.term_blocks === p.term_blocks, `${usdt(app.principal)} for ${app.term_blocks} blocks`)
    check('sandbox-sig', !!result && verifyObject(result, sandbox_pk) && result.borrower_pk === borrowerPk && result.offer_id === offerId, `signed by sandbox ${sandbox_pk.slice(0, 12)} for this borrower and offer`)
    const request = result?.loan_request
    check('sandbox-request', !!request && request.principal === app.principal && request.term_blocks === app.term_blocks && request.term_blocks === p.term_blocks && request.grace_blocks === p.grace_blocks && request.fee === this.interest(app.principal, p.apr_bps, p.term_blocks),
      'signed sandbox principal, term and grace match this application and offer; fee estimate matches the advertised APR')
    check('attestation', !!attestation && verifyObject(attestation, state.platform_pk) && attestation.sandbox_pk === sandbox_pk && attestation.image_digest === current.image_digest, `platform attests ${attestation?.image_digest}`)
    if (app.consent) {
      // stricter than the laptop's v1 lender: a consent receipt that came with the application must be the one the sandbox committed to
      check('consent-bound', verifyObject(app.consent, borrowerPk) && app.consent.borrower_pk === borrowerPk && app.consent.lender_pk === this.pubkey && result?.consent_hash === hashObject(app.consent) && app.consent.retention === 'none', 'the borrower-signed consent names this lender, and the sandbox signed its hash')
    }
    check('no-raw-rows', !!result && !('history' in result) && !('candidate_inflows' in result) && !canonicalJson(result).includes('"memo"'), 'the result carries checks and summaries only')
    const runRecord = result?.run_record
    const runCheck = runRecord ? verifyRunRecord(runRecord, expectedRunMaterials(result.investigation?.model ?? ''), sandbox_pk, pin.budgets, result.investigation) : { ok: false, errors: ['RUN_RECORD_MISSING'] }
    check('sandbox-run-record', runCheck.ok && runRecord?.image_digest === current.image_digest && runRecord?.bundle_hash === result.bundle_hash && runRecord?.status === result.investigation?.status && runRecord?.policy_sha256 === hashObject(result.investigation?.policy ?? null), runCheck.errors.join(',') || 'signed software run record; published materials and budgets verified')
    check('required-local-model', p.requirements.investigation !== 'required' || runRecord?.materials.model_material_kind === 'file', 'a deterministic playbook is a baseline and cannot satisfy a local-model lender policy')
    check('investigation-policy', investigationAccepted(p.requirements.investigation, result?.investigation), `policy ${p.requirements.investigation ?? 'optional'}; investigation ${result?.investigation?.status ?? 'missing'}`)
    check('reconciliation-policy', p.requirements.reconciliation !== 'required' || (result?.reconciliation?.status === 'verified' && result.asset_id === this.assetId && result.height === state.height), 'required history reconciles against independently observed RGB allocations for this asset')
    const required = ['injection', 'headroom', 'sybil', ...(p.requirements.reconciliation === 'required' ? ['reconcile'] : []), ...(p.requirements.affordability ? ['affordability'] : []), ...(p.requirements.inflow_months > 0 ? ['inflows', 'disclosure'] : [])]
    for (const id of required) {
      const r = result?.checks.find((c) => c.id === id)
      check(`sandbox:${id}`, !!r?.ok, r?.detail ?? 'missing')
    }

    // every disclosed inflow re-verified without the sandbox: payer signature and Bitcoin confirmation
    const committed = new Set(result?.disclosure_commitments ?? [])
    const proposal = new Map((app.disclosure_items ?? []).filter((d) => committed.has(hashObject(d))).map((d) => [d.txid, d]))
    check('unique-disclosures', new Set(app.disclosed_inflows).size === app.disclosed_inflows.length, 'each payment can count only once')
    let verifiedSum = 0
    const months = new Set<number>()
    const blocksPerMonth = 30
    for (const txid of app.disclosed_inflows) {
      const proof = app.inflow_proofs?.find((x) => x.txid === txid)
      const item = proposal.get(txid)
      const sigOk = !!proof && verifyHash(proof.payer_sig, hashObject({ txid, amount: proof.amount, borrower_pk: borrowerPk }), proof.payer_pk)
      const tx = await this.chain.getTx(txid)
      const ok = !!item && sigOk && !!tx?.height && proof!.amount === item.amount && proof!.payer_pk === item.payer_pk
      check(`inflow:${txid.slice(0, 8)}`, ok, ok ? `${usdt(proof!.amount)} signed by ${proof!.payer_pk.slice(0, 8)}, confirmed at ${tx!.height}` : 'not verifiable')
      if (ok) { verifiedSum += proof!.amount; months.add(Math.floor((state.height - tx!.height!) / blocksPerMonth)) }
    }
    if (p.requirements.inflow_months > 0) {
      const sumRequired = Math.ceil(((app.principal + this.interest(app.principal, p.apr_bps, p.term_blocks)) * p.requirements.inflow_multiple_bps) / 10_000)
      const coveredMonths = [...months].filter((m) => m < p.requirements.inflow_months).length
      check('disclosed-coverage', coveredMonths >= p.requirements.inflow_months && verifiedSum >= sumRequired, `we verified ${usdt(verifiedSum)} over ${coveredMonths} of ${p.requirements.inflow_months} month(s), need ${usdt(sumRequired)}`)
    }

    // the borrower's own record: its signed outstanding debt and its passbook on Bitcoin
    const outstandingOk = !!app.outstanding_statement && verifyHash(app.outstanding_statement.sig, hashObject({ outstanding_micro: app.outstanding_statement.outstanding_micro }), borrowerPk)
    check('outstanding', outstandingOk && app.outstanding_statement.outstanding_micro === 0, `${usdt(app.outstanding_statement?.outstanding_micro ?? 0)} outstanding, signed by the borrower`)
    const passbook = app.passbook && app.passbook.borrower_pk === borrowerPk ? await verifyPassbook(app.passbook, this.chain) : null
    check('passbook', !!passbook && passbook.document_valid && passbook.unverified === 0 && passbook.ladder.open === 0, passbook ? `${passbook.pages.length} page(s), step ${passbook.ladder.step}, ${passbook.ladder.on_time} on time, all confirmed on Bitcoin` : 'no borrower-signed passbook')

    const failed = checks.filter((c) => !c.ok)
    if (failed.length || !passbook) {
      const declined: Declined = { at: Math.floor(Date.now() / 1000), borrower_pk: borrowerPk, principal: app.principal, failed }
      this.state.declined = [...(this.state.declined ?? []).slice(-9), declined]
      await this.save()
      await this.say('Application declined', { failed })
      return { declined }
    }

    // pricing is deterministic: the rules memo's adjustment, clamped into the policy band, under the APR cap
    const memo = await new RuleReasoner().creditMemo({
      lender: 'phone', tenor_blocks: p.term_blocks, principal: app.principal,
      passbook: { on_time: passbook.ladder.on_time, late: passbook.ladder.late, defaults: passbook.ladder.defaults, open: passbook.ladder.open, step: passbook.ladder.step, unverified: passbook.unverified },
      verified_inflows: { count: app.disclosed_inflows.length, sum: verifiedSum, months_covered: months.size },
      checks: (result.checks ?? []).map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })), base_apr_bps: p.apr_bps, band: p.band,
    })
    const applied = memo.adjustment_bps
    check('clamp', true, `deterministic policy selected ${applied} bps`)
    const apr = Math.min(p.apr_bps + applied, this.economics.max_apr_bps)
    const fee = this.interest(app.principal, apr, p.term_blocks)
    const debt = app.principal + fee
    const step = passbook.ladder.step
    const ltvTarget = Math.min(passbook.ladder.allowed_ltv_bps, p.ltv_ladder_bps[Math.min(step, p.ltv_ladder_bps.length - 1)], maxLtvForTerm(p.term_blocks, this.economics))
    const quote = await this.platform.quote()
    if (!verifyQuote(quote, state.oracle_pk)) throw new Error('oracle quote does not verify')
    const collateral = collateralFor(debt, ltvTarget, quote.price_cents)
    const lastClose = [...passbook.pages].reverse().find((pg) => pg.verified.close && pg.close_txid)?.close_txid ?? null
    const terms: LoanTerms = {
      v: 1, borrower_pk: borrowerPk, lender_pk: this.pubkey, platform_pk: state.platform_pk, asset_id: this.assetId,
      principal: app.principal, fee, collateral_sats: collateral, oracle_quote: quote, open_height: quote.height,
      maturity_height: quote.height + p.term_blocks, grace_blocks: p.grace_blocks, recovery_height: quote.height + p.term_blocks + p.grace_blocks + 20,
      ladder_step: step, ltv_bps: ltvBps(debt, collateral, quote.price_cents), prev_passbook_txid: lastClose, nonce: randomHex(32),
    }
    const { loan } = await this.platform.registerLoan(terms, app.passbook)
    this.state.loans[loan.id] = { terms, borrower_pk: borrowerPk, accepted_at: Math.floor(Date.now() / 1000), checks, memo: memo.memo, ...(this.state.offer?.auto_fund && this.state.offer.d === p.d ? { fund_approved: true } : {}) }
    await this.save()
    const acceptance: AcceptancePayload = { offer_id: offerId, terms, terms_hash: termsHash(terms) }
    await this.relay.send(KIND.ACCEPTANCE, acceptance, borrowerPk)
    await this.say('Accepted and registered', {
      loan_id: loan.id.slice(0, 12), apr: `${apr / 100}%`, fee: usdt(fee), interest: lenderReturnLine(terms, this.economics),
      ltv: `${terms.ltv_bps / 100}% (step ${step})`, collateral_sats: collateral, memo: memo.memo, flags: memo.flags,
      pricing_policy: `${applied >= 0 ? '+' : ''}${applied} bps from verified policy facts`,
    })
    return { loan_id: loan.id }
  }

  /** What the lender's stop shows: the default split's payouts, from the shared escrow code. */
  splitPreview(loanId: Hex): { lender_sats_on_default: number; borrower_sats_on_default: number; locktime: number } {
    const t = this.loan(loanId).terms
    const outputs = splitOutputs(t)
    return { lender_sats_on_default: outputs[0].value, borrower_sats_on_default: outputs[1]?.value ?? 0, locktime: splitLocktime(t) }
  }

  /**
   * After the person's OK: wait for the borrower's split request, check the lock on Bitcoin and
   * the split against the canonical template and the confirmed collateral, hold it, then pay
   * out over RGB and have the platform issue the repayment invoice on a per-loan account.
   */
  async fund(loanId: Hex, timeoutMs = 600_000): Promise<{ disbursement_txid: Hex; repayment_invoice: string }> {
    const l = this.loan(loanId)
    if (!l.fund_approved) throw new Error('funding needs the person\'s OK on this phone')
    if (l.disbursement_attempted || l.disbursement_pending || l.disbursement_txid) throw new Error('disbursement already attempted for this loan; reconcile the wallet before retrying')
    if (this.pubkey !== l.terms.lender_pk) throw new Error('this loan belongs to another lender')
    const saved = l.disbursement_request
    if (saved && !payoutRequestSealValid(saved, loanId, this.pubkey)) throw new Error('saved payout request seal does not verify for this lender and loan')
    const req = saved ? saved.request : (await this.relay.receive<SignRequestPayload>(KIND.SIGN_REQUEST, l.borrower_pk, { timeoutMs, match: (r) => r.loan_id === loanId && r.purpose === 'split' })).payload
    if (req.loan_id !== loanId || req.purpose !== 'split') throw new Error('saved split request does not name this loan')
    if (l.termsheet) {
      // nothing moves before both people approved this exact sheet: the borrower's countersignature and approval ride on the split request
      const problems = countersignedSheetProblems(l, req, loanId, this.economics, this.state.market?.policy)
      if (problems.length) throw new Error(`refusing to fund: ${problems.join('; ')}`)
      l.termsheet = req.termsheet!
      await this.save()
      await this.say('Both approvals of the term sheet verified', { loan_id: loanId.slice(0, 12), borrower: 'approved', lender_approvers: l.lender_approvals?.length ?? 0 })
    }
    const parties = partiesOf(l.terms)
    const requested = psbtFromBase64(req.psbt_base64)
    const d = describePsbt(requested)
    const input = d.inputs[0]
    const lock = input ? await this.waitConfirmed(input.txid, timeoutMs) : null
    const lockOk = !!lock?.height && lock.outputs[input.vout]?.script === escrowFor(parties).script && lock.outputs[input.vout]?.value === l.terms.collateral_sats && lock.outputs.some((o) => o.script === `6a20${loanId}`) && (l.terms.prev_passbook_txid === null || lock.inputs.some((i) => i.txid === l.terms.prev_passbook_txid))
    if (!lockOk || req.terms_hash !== loanId || d.inputs.length !== 1 || !req.disbursement_invoice) throw new Error('split request does not match the terms')
    const actual = lock!.outputs[input.vout]
    const leaf = escrowFor(parties).leaves.A
    const metadata = requested.data.inputs[0]
    const suppliedLeaf = metadata.tapLeafScript?.[0]
    const borrowerSignature = leafSignature(requested, parties, 'A', 'borrower')
    const metadataOk =
      metadata.witnessUtxo?.value === BigInt(actual.value) && bytesToHex(metadata.witnessUtxo.script) === actual.script &&
      metadata.tapLeafScript?.length === 1 && !!suppliedLeaf && suppliedLeaf.leafVersion === 0xc0 &&
      bytesToHex(suppliedLeaf.script) === bytesToHex(leaf.script) && bytesToHex(suppliedLeaf.controlBlock) === bytesToHex(leaf.controlBlock) &&
      (metadata.sighashType === undefined || metadata.sighashType === 0) && metadata.tapScriptSig?.length === 1 && borrowerSignature?.length === 128 &&
      metadata.nonWitnessUtxo === undefined && metadata.tapKeySig === undefined && metadata.finalScriptWitness === undefined &&
      metadata.finalScriptSig === undefined && metadata.redeemScript === undefined && metadata.witnessScript === undefined
    if (!metadataOk) throw new Error('split PSBT metadata does not match the confirmed collateral and leaf A')
    // hash only our canonical template against the actual prevout, never borrower-supplied UTXO data
    const psbt = buildEscrowSpend({ escrow: { txid: input.txid, vout: input.vout, value: actual.value }, parties, leaf: 'A', outputs: splitOutputs(l.terms), locktime: splitLocktime(l.terms) })
    if (unsignedTxid(requested) !== unsignedTxid(psbt)) throw new Error('split transaction does not match the canonical default template')
    try { addLeafSignature(psbt, parties, 'A', 'borrower', borrowerSignature!) } catch { throw new Error('split borrower signature does not verify against the confirmed collateral') }
    l.lock = { txid: input.txid, vout: input.vout }
    l.split_psbt = psbt.toBase64()
    await this.save()
    await this.say('Holding the borrower-signed default split', { txid: d.txid.slice(0, 12), locktime: d.locktime, lender_sats: d.outputs[0].value })

    const decoded = await this.rgbDecode(req.disbursement_invoice)
    if (decoded && decoded.assetId && decoded.assetId !== this.assetId) throw new Error('the disbursement invoice names another asset')
    if (!saved) {
      l.disbursement_request = await this.key.signObject({ v: 1 as const, domain: PAYOUT_REQUEST_DOMAIN, loan_id: loanId, lender_pk: this.pubkey, request: req })
      await this.save()
    }
    // right before money moves: the collateral is still locked (the escrow output unspent) and the
    // platform has not closed the loan (a refund after the funding window spends that output)
    await this.assertCollateralLive(loanId, { txid: input.txid, vout: input.vout })
    // Two callers may have validated the same saved request concurrently. The
    // guard is checked again synchronously before the first irreversible step.
    if (l.disbursement_attempted || l.disbursement_pending || l.disbursement_txid) throw new Error('disbursement already attempted for this loan; reconcile the wallet before retrying')
    l.disbursement_attempted = true
    l.disbursement_invoice = req.disbursement_invoice
    await this.save()
    let sent: { txid: Hex }
    try { sent = await this.rgb.send({ invoice: req.disbursement_invoice, assetId: this.assetId, amount: l.terms.principal }) } catch (e) {
      // signed and maybe broadcast: never paid out again; resumePayout resolves it
      const amb = parseAmbiguous((e as Error).message)
      if (amb) { l.disbursement_pending = amb.txid as Hex; await this.save() }
      throw e
    }
    l.disbursement_txid = sent.txid
    l.funded_sent = false
    await this.save()
    return this.finishPayout(loanId)
  }

  /** The loan's escrow output is unspent and the platform still has the loan pending or locked; else refuse to pay out. */
  async assertCollateralLive(loanId: Hex, outpoint: { txid: Hex; vout: number }): Promise<void> {
    const l = this.loan(loanId)
    const unspent = (await this.chain.utxos(escrowFor(partiesOf(l.terms)).script)).some((u) => u.txid === outpoint.txid && u.vout === outpoint.vout)
    if (!unspent) throw new Error('refusing to pay out: the collateral is no longer locked (its escrow output was spent)')
    const record = await this.platform.loan(loanId)
    if (!['pending', 'locked'].includes(record.status)) {
      l.cancelled = record.status
      await this.save()
      throw new Error(`refusing to pay out: the platform has the loan as ${record.status}`)
    }
    // The phone and platform may see a confirmation at different times. Do not send
    // principal until the platform has independently accepted this exact lock.
    const indexed = await this.ensureIndexedLock(loanId, outpoint, record, 3)
    if (indexed.status !== 'locked') throw new Error('refusing to pay out: the platform already has this loan as funded')
    if (!(await this.chain.utxos(escrowFor(partiesOf(l.terms)).script)).some((u) => u.txid === outpoint.txid && u.vout === outpoint.vout)) {
      throw new Error('refusing to pay out: the collateral is no longer locked (its escrow output was spent)')
    }
  }

  /** Reconcile only an existing lock; this never builds, signs or broadcasts a transaction. */
  private async ensureIndexedLock(loanId: Hex, lock: { txid: Hex; vout: number }, record?: PhoneLoanRecord, attempts = 1): Promise<PhoneLoanRecord> {
    let current = record ?? await this.platform.loan(loanId)
    for (let attempt = 1; current.status === 'pending' && attempt <= attempts; attempt++) {
      let failure: unknown
      try { await this.platform.recordLock(loanId, lock.txid) } catch (e) { failure = e }
      // A write can have succeeded even if its answer was lost, or the borrower
      // may have recorded the same lock concurrently. Trust the resulting record.
      current = await this.platform.loan(loanId)
      if (failure && current.status === 'pending') {
        if (attempt < attempts && /(?:\(422\)|422): lock transaction not confirmed$/.test((failure as Error).message)) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          continue
        }
        throw failure
      }
      break
    }
    if (!['locked', 'open'].includes(current.status) || current.lock_txid !== lock.txid || current.lock_vout !== lock.vout) {
      throw new Error('the platform has not accepted this loan\'s saved collateral lock')
    }
    return current
  }

  /**
   * A payout whose send failed after signing: finish it if it is on the network; if rgb-lib
   * has it as Failed (cancelled, it never left), clear the attempt; otherwise refuse for now.
   */
  async resumePayout(loanId: Hex): Promise<{ disbursement_txid: Hex; repayment_invoice: string } | null> {
    const l = this.loan(loanId)
    if (l.disbursement_txid || !l.disbursement_pending) return null
    const st = await this.rgb.status(l.disbursement_pending)
    if (st.state === 'broadcast') { l.disbursement_txid = l.disbursement_pending; l.funded_sent = false; delete l.disbursement_pending; await this.save(); return this.finishPayout(loanId) }
    if (st.rgbStatus === 'Failed') { delete l.disbursement_pending; l.disbursement_attempted = false; await this.save(); return null }
    throw new Error(st.state === 'not-seen' ? 'The payout is not on the network yet. If it never left this phone, cancel it in Wallet health.' : "Can't tell yet whether the payout went out.")
  }

  /**
   * After the payout went out, each step once and resumable: wait for it to settle, tell the
   * platform, have it issue the repayment invoice on this loan's own account (kept until the
   * account is restored here), the IOU invoice, then FUNDED to the borrower.
   */
  async finishPayout(loanId: Hex): Promise<{ disbursement_txid: Hex; repayment_invoice: string }> {
    const l = this.loan(loanId)
    const txid = l.disbursement_txid
    if (!txid) throw new Error('no payout to finish')
    // loans paid out before these steps were recorded sent FUNDED right after restoring the account
    if (l.funded_sent === undefined && l.repayment_account && l.repayment_invoice && !l.repayment_watch_issued) l.funded_sent = true
    if (l.funded_sent) return { disbursement_txid: txid, repayment_invoice: l.repayment_invoice! }
    await this.awaitTransfer(this.rgb, this.assetId, txid, 'Send')
    if (!l.lock) throw new Error('no saved collateral lock for this payout')
    let record = await this.platform.loan(loanId)
    if (l.funded_recorded && (record.status !== 'open' || record.disbursement_txid !== txid)) {
      l.funded_recorded = false
      await this.save()
    }
    record = await this.ensureIndexedLock(loanId, l.lock, record)
    // Older builds marked funded_recorded even when the platform refused it.
    // Reconcile against the actual record, never against that local flag alone.
    if (record.status === 'locked') {
      const funding = await this.key.signObject({ loan_id: loanId, disbursement_txid: txid })
      let failure: unknown
      try { await this.platform.recordFunded(loanId, txid, funding.sig) } catch (e) { failure = e }
      record = await this.platform.loan(loanId)
      if (failure && record.status === 'locked') throw failure
    }
    if (record.status !== 'open' || record.disbursement_txid !== txid) throw new Error('the platform has not accepted this loan\'s saved payout')
    if (!l.funded_recorded) {
      l.funded_recorded = true
      await this.save()
    }
    if (!l.repayment_account) {
      // the repayment goes to a per-loan account from our seed; the platform watches it with xpubs only
      if (!l.repayment_watch_issued) {
        const keys = await this.repay.keys(loanId)
        const watch = await this.key.signObject({ loan_id: loanId, account_xpub_vanilla: keys.account_xpub_vanilla, account_xpub_colored: keys.account_xpub_colored, master_fingerprint: keys.master_fingerprint })
        const issued = await this.platform.repaymentWatch(loanId, keys, watch.sig)
        l.repayment_watch_issued = { ...issued, master_fingerprint: keys.master_fingerprint }
        await this.save()
      }
      const issued = l.repayment_watch_issued
      await this.repay.restore(loanId, issued.backup, issued.password)
      l.repayment_recipient_id = issued.recipient_id
      l.repayment_invoice = issued.invoice
      l.repayment_account = issued.master_fingerprint
      delete l.repayment_watch_issued
      await this.save()
    }
    if (!l.iou_invoice) {
      l.iou_invoice = (await this.rgb.witnessInvoice(debtOf(l.terms), null)).invoice
      await this.save()
    }
    const funded: FundedPayload = { loan_id: loanId, disbursement_txid: txid, repayment_invoice: l.repayment_invoice!, iou_invoice: l.iou_invoice }
    await this.relay.send(KIND.FUNDED, funded, l.borrower_pk)
    l.funded_sent = true
    await this.save()
    await this.say('Disbursed over RGB', { txid: txid.slice(0, 12), amount: usdt(l.terms.principal), repayment_invoice: `${l.repayment_recipient_id!.slice(0, 24)}… issued by the platform on our repayment account ${l.repayment_account}` })
    return { disbursement_txid: txid, repayment_invoice: l.repayment_invoice! }
  }

  /** The borrower's PB-IOU: its certificate authenticates this loan and the note settled in our wallet. */
  async awaitIou(loanId: Hex, timeoutMs = 300_000): Promise<IouOwnership> {
    const l = this.loan(loanId)
    const { payload } = await this.relay.receive<{ certificate: IouCertificate }>(KIND.NOTE_ISSUED, l.borrower_pk, { timeoutMs, match: (p) => p.certificate?.loan_id === loanId })
    const c = payload.certificate
    const ownership = await this.key.signObject({ certificate: c, assignments: [], holder_pk: this.pubkey }) as unknown as IouOwnership
    if (!await verifyOwnership(ownership, l.terms, this.chain)) throw new Error('IOU certificate does not authenticate this loan')
    const received = await this.awaitTransfer(this.rgb, c.asset_id, c.issuance_transfer_txid, 'ReceiveWitness')
    if (received.amount !== c.amount) throw new Error('IOU amount does not equal debt')
    l.iou = ownership
    await this.save()
    await this.say('PB-IOU received and verified', { loan_id: loanId.slice(0, 12), asset_id: c.asset_id, amount: c.amount })
    return ownership
  }

  /** The borrower says it repaid: see it settle in this loan's repayment account, acknowledge it, return the IOU. */
  async confirmRepayment(loanId: Hex, timeoutMs = 3_600_000): Promise<Hex> {
    const l = this.loan(loanId)
    const { payload } = await this.relay.receive<RepaidPayload>(KIND.REPAID, l.borrower_pk, { timeoutMs, match: (r) => r.loan_id === loanId })
    const t = await this.awaitRepayment(loanId, payload.repayment_txid)
    if (l.repayment_recipient_id && t.recipientId !== l.repayment_recipient_id) throw new Error('repayment does not settle this loan\'s invoice')
    if (t.amount < debtOf(l.terms)) throw new Error(`repayment ${usdt(t.amount)} is short of ${usdt(debtOf(l.terms))}`)
    l.repayment_txid = payload.repayment_txid
    l.repayment_receipt = await this.key.signObject({ domain: 'passbook-rgb-repayment-v1' as const, loan_id: loanId, repayment_txid: payload.repayment_txid, asset_id: l.terms.asset_id, amount: t.amount, validator_pk: this.pubkey, validation: 'rgb-lib-settled' as const }) as RgbRepaymentReceipt
    await this.save()
    await this.relay.send(KIND.REPAYMENT_RECEIPT, l.repayment_receipt, l.borrower_pk)
    const ack = await this.key.signObject({ loan_id: loanId, repayment_txid: payload.repayment_txid })
    try { await this.platform.recordRepaid(loanId, payload.repayment_txid, ack.sig) } catch (e) { await this.say('Index warning: repaid', { warning: (e as Error).message }) }
    if (payload.note_return_invoice && l.iou) {
      const c = l.iou.certificate
      const sent = await this.rgb.send({ invoice: payload.note_return_invoice, assetId: c.asset_id, amount: c.amount })
      await this.awaitTransfer(this.rgb, c.asset_id, sent.txid, 'Send')
      l.iou_returned_txid = sent.txid
      await this.save()
      await this.relay.send(KIND.NOTE_RETURNED, { loan_id: loanId, asset_id: c.asset_id, txid: sent.txid }, c.issuer_pk)
    }
    await this.say('Repayment settled in our repayment account; acknowledged', { txid: payload.repayment_txid.slice(0, 12), amount: usdt(t.amount) })
    return payload.repayment_txid
  }

  /** Co-sign the release (leaf A) only after our own wallet saw the repayment, and only if it pays the borrower everything back. */
  async signRelease(loanId: Hex, timeoutMs = 600_000): Promise<Hex> {
    const l = this.loan(loanId)
    const { payload: req } = await this.relay.receive<SignRequestPayload>(KIND.SIGN_REQUEST, l.borrower_pk, { timeoutMs, match: (r) => r.loan_id === loanId && r.purpose === 'release' })
    const parties = partiesOf(l.terms)
    const psbt = psbtFromBase64(req.psbt_base64)
    const d = describePsbt(psbt)
    const refuse = async (why: string): Promise<never> => {
      await this.relay.send(KIND.SIGNATURE, { loan_id: loanId, txid: d.txid, refused: why } satisfies SignaturePayload, l.borrower_pk)
      throw new Error(`release refused: ${why}`)
    }
    if (!l.repayment_txid) return refuse('no repayment acknowledged for this loan')
    if (d.inputs.length !== 1 || d.inputs[0].txid !== l.lock?.txid || d.inputs[0].vout !== l.lock?.vout) return refuse('does not spend the collateral output')
    if (canonicalJson(d.outputs) !== canonicalJson(releaseOutputs(l.terms))) return refuse('does not pay the collateral back to the borrower')
    if (!verifyLeafSignature(psbt, parties, 'A', 'borrower')) return refuse('borrower signature missing or invalid')
    // the worklet computes the leaf's sighash from this PSBT and signs only a leaf with our key in it
    const { signature } = await this.key.signEscrowLeaf(psbt.toBase64())
    addLeafSignature(psbt, parties, 'A', 'lender', signature) // throws unless it verifies
    const sig: SignaturePayload = { loan_id: loanId, txid: unsignedTxid(psbt), signature, repayment_receipt: l.repayment_receipt }
    await this.relay.send(KIND.SIGNATURE, sig, l.borrower_pk)
    await this.say('Release co-signed (leaf A)', { txid: sig.txid.slice(0, 12) })
    const tx = await this.waitConfirmed(sig.txid, timeoutMs)
    l.release_txid = sig.txid
    l.released_height = tx?.height ?? undefined
    await this.save()
    return sig.txid
  }

  /** Platform fees this lender owes on closed loans (all, or one loan's). */
  async feesDue(loanId?: Hex) {
    const { fees } = await this.platform.fees(this.pubkey)
    return fees.filter((f) => f.status === 'fee_due' && (loanId === undefined || f.loan_id === loanId))
  }

  /** Pay one loan's platform fee from our USDT over RGB (after the person's OK), then have the platform validate it. */
  async payFee(loanId: Hex): Promise<Hex> {
    const l = this.state.loans[loanId]
    let paid: Hex | null = null
    if (l?.fee_pending) {
      // an earlier fee payment of uncertain fate: never pay twice
      const st = await this.rgb.status(l.fee_pending)
      if (st.state === 'broadcast') paid = l.fee_pending
      else if (st.rgbStatus === 'Failed') { delete l.fee_pending; await this.save() }
      else throw new Error(st.state === 'not-seen' ? 'The earlier fee payment is not on the network yet. If it never left this phone, cancel it in Wallet health.' : "Can't tell yet whether the earlier fee payment went out.")
    }
    const f = await this.platform.feeInvoice(loanId)
    if (!paid && (f.status !== 'fee_due' || !f.invoice)) throw new Error(`no payable fee for ${loanId.slice(0, 12)} (${f.status})`)
    // the platform share plus the checks billed at close: paid only when every part is accounted for (lane E3)
    const parts = this.closeFees(f)
    if (!paid && parts.problems.length) throw new Error(`not paying this fee: ${parts.problems.join('; ')}`)
    let sent: { txid: Hex }
    if (paid) sent = { txid: paid }
    else {
      try { sent = await this.rgb.send({ invoice: f.invoice!, assetId: f.asset_id, amount: f.amount }) } catch (e) {
        const amb = parseAmbiguous((e as Error).message)
        if (amb && l) { l.fee_pending = amb.txid as Hex; await this.save() }
        throw e
      }
    }
    await this.awaitTransfer(this.rgb, f.asset_id, sent.txid, 'Send')
    let v = await this.platform.verifyFee(loanId, sent.txid)
    for (let i = 0; !v.ok && i < 6; i++) { await new Promise((r) => setTimeout(r, 5000)); v = await this.platform.verifyFee(loanId, sent.txid) }
    if (!v.ok) throw new Error(`the platform did not validate the fee payment: ${v.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
    if (this.state.loans[loanId]) { this.state.loans[loanId].fee_paid_txid = sent.txid; delete this.state.loans[loanId].fee_pending; await this.save() }
    await this.say('Platform fee paid over RGB', { loan_id: loanId.slice(0, 12), amount: usdt(f.amount), share: `${f.share_bps / 100}% of ${usdt(f.interest)} interest`, ...(parts.checks.length ? { checks_billed_at_close: usdt(parts.checks_total) } : {}), outcome: f.outcome, txid: sent.txid.slice(0, 12) })
    return sent.txid
  }

  /** A fee's parts (platform share, checks billed at close) against the bills this phone holds. */
  closeFees(f: CloseFeeRecord) {
    const l = this.state.loans[f.loan_id]
    return closeFees(f, this.state.bills ?? [], { borrower_pk: l?.borrower_pk ?? null, own: l?.check_bill ? [l.check_bill] : [] })
  }

  /** test USDT this lender holds: the main wallet and every loan's repayment account. */
  async usdtHeld(): Promise<{ main: number; repayments: number }> {
    const main = (await this.rgb.balance(this.assetId)).settled
    let repayments = 0
    for (const [id, l] of Object.entries(this.state.loans)) if (l.repayment_account) repayments += (await this.repay.balance(id as Hex, this.assetId).catch(() => ({ settled: 0 }))).settled
    return { main, repayments }
  }

  private async rgbDecode(invoice: string): Promise<{ assetId?: string | null } | null> {
    const m = (this.rgb as unknown as { decode?: (i: string) => Promise<{ assetId?: string | null }> }).decode
    return m ? m(invoice) : null
  }

  async waitConfirmed(txid: Hex, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const tx = await this.chain.getTx(txid).catch(() => null)
      if (tx?.height) return tx
      await new Promise((r) => setTimeout(r, 2500))
    }
    throw new Error(`still waiting for ${txid.slice(0, 12)}… to confirm`)
  }

  private async awaitTransfer(wallet: RgbPort, assetId: string, txid: Hex, kind: string, timeoutMs = 300_000): Promise<RgbTransferRow> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await wallet.refresh(assetId).catch(() => {})
      const t = (await wallet.transfers(assetId)).find((x) => x.txid === txid && x.kind === kind)
      if (t?.status === 'Settled') return t
      if (t?.status === 'Failed') throw new Error(`RGB ${kind} ${txid.slice(0, 12)} failed`)
      await new Promise((r) => setTimeout(r, 3000))
    }
    throw new Error(`RGB ${kind} ${txid.slice(0, 12)} did not settle in time`)
  }

  private async awaitRepayment(loanId: Hex, txid: Hex, timeoutMs = 600_000): Promise<RgbTransferRow> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await this.repay.refresh(loanId, null).catch(() => {})
      const t = (await this.repay.transfers(loanId, this.assetId).catch(() => [] as RgbTransferRow[])).find((x) => x.txid === txid && x.kind === 'ReceiveWitness')
      if (t?.status === 'Settled') return t
      if (t?.status === 'Failed') throw new Error(`repayment ${txid.slice(0, 12)} failed in our account`)
      await new Promise((r) => setTimeout(r, 3000))
    }
    throw new Error(`repayment ${txid.slice(0, 12)} did not settle in our account in time`)
  }
}

/**
 * The borrower's countersigned sheet on the split request, against the sheet this phone signed and approved (the laptop
 * lender's fund check): the same sheet, the borrower's signature over its hash, both approvals complete under the policy.
 */
export function countersignedSheetProblems(l: Pick<LenderLoan, 'termsheet' | 'lender_approvals' | 'borrower_pk'>, req: Pick<SignRequestPayload, 'termsheet' | 'borrower_approval'>, loanId: Hex, economics = DEFAULT_ECONOMICS, policy?: Parameters<typeof approvalStatus>[2]): string[] {
  const sheet = req.termsheet
  if (!l.termsheet) return ['no term sheet on this phone for this loan']
  if (!sheet) return ['the split request carries no countersigned term sheet']
  let hash: Hex
  try { hash = termSheetHash(sheet) } catch { return ['the countersigned sheet is not bound to its terms'] }
  const problems: string[] = []
  if (hash !== loanId) problems.push('the countersigned sheet is for another loan')
  if (hashObject({ ...sheet, signatures: {} }) !== hashObject({ ...l.termsheet, signatures: {} }) || sheet.signatures.lender !== l.termsheet.signatures.lender) problems.push('the countersigned sheet differs from the one this phone signed')
  problems.push(...termSheetProblems(sheet, { economics, requireSignatures: true }))
  if (!sheet.signatures.borrower || !verifyHash(sheet.signatures.borrower, loanId, l.borrower_pk)) problems.push('the borrower did not sign this sheet')
  const a = req.borrower_approval
  if (!a || a.role !== 'borrower' || a.approver_pk !== l.borrower_pk || a.termsheet_hash !== loanId || !verifyObject(a, a.approver_pk)) problems.push('no borrower approval of this sheet')
  if (policy) {
    const s = approvalStatus(sheet, [...(l.lender_approvals ?? []), ...(a ? [a] : [])], policy, Number.MAX_SAFE_INTEGER)
    if (!s.complete || s.problems.length) problems.push(`approvals incomplete${s.problems.length ? ` (${s.problems.join(', ')})` : ''}`)
  } else if (!(l.lender_approvals ?? []).some((x) => x.role === 'lender' && x.termsheet_hash === loanId && verifyObject(x, x.approver_pk))) problems.push('no lender approval of this sheet on this phone')
  return [...new Set(problems)]
}

export { btc as btcText }
