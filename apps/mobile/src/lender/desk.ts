import { hashObject } from '../../../../src/core/crypto.js'
// The lender phone's negotiated desk, end to end over the public relays: its 38388 offer
// carries the signed policy's NegotiationTerms; each borrower's ASK is answered by the shared
// engine inside that policy (serveNegotiations, the phone's key behind the signer); an
// agreement is followed by the credit check billed at close (check.ts); the borrower's
// application is reviewed against both (review.ts); the term sheet waits for the person's
// approval on this phone; then it is registered and sent, and the M6 path funds, holds the
// split, co-signs the release and pays the platform fee (with the billed check in it).
// Everything kept is public data and signatures, plus the check's verified outcome until its sheet is sent.
import type { Hex } from '../../../../src/core/crypto.js'
import { KIND } from '../../../../src/market/kinds.js'
import type { ApplicationPayload } from '../../../../src/market/messages.js'
import type { NegotiationMessage } from '../../../../src/market/negotiate-engine.js'
import { serveNegotiations, type AskInfo, type NegotiationResult, type NegotiationTransport } from '../../../../src/market/negotiate-nostr.js'
import type { PortableScorerKey } from '../../../../src/scorer/portable-evidence.js'
import type { LenderPolicy as OfferPolicy } from '../../../../src/agents/lender.js'
import type { Approval } from '../../../../src/market/approvals.js'
import type { LenderLoan, PhoneLender, PhoneLenderState } from '../agent/lender'
import { CheckRefused, runBilledCheck, type CheckCore, type CheckRecord, type CheckStage } from './check'
import type { HeldBill } from './fees'
import type { MarketPolicy } from './market-policy'
import { acceptancePayload, lenderApproval, reviewNegotiated, sendProblems, type NegotiationRecord, type ReviewResult, type SheetProposal } from './review'
import { lenderSigner, publicLabels } from './signer'

/** What the desk keeps in the lender's state (added to PhoneLenderState). */
export interface DeskState {
  market?: { policy: MarketPolicy; params: import('../../../../src/market/negotiate-engine.js').EngineParams }
  negotiations?: Record<Hex, NegotiationRecord>
  proposals?: Record<Hex, SheetProposal>
  /** every bill a check node issued to this lender (checked against what the platform charges at close) */
  bills?: HeldBill[]
  /** ASKs already answered (replay protection across restarts), newest last */
  asks_seen?: Hex[]
}

const KEEP_NEGOTIATIONS = 20
/** How long an open or agreed negotiation holds its principal against the cap without becoming a sheet. */
export const RESERVE_SECONDS = 30 * 60

/** Whether a negotiation still holds capacity: open, or agreed with a check that has not failed. */
export function reserves(r: NegotiationRecord): boolean {
  if (r.outcome === 'open') return true
  if ('no_deal' in r.outcome) return false
  return !r.check_error && !(r.check && r.check.refusals.length)
}

/** The principal a negotiation holds: the agreed one, else what the borrower's ASK asked for. */
export function reservedPrincipal(r: NegotiationRecord): number {
  if (typeof r.outcome === 'object' && 'agreed' in r.outcome) return r.outcome.agreed.principal
  const p = (r.messages[0]?.body as { position?: { principal?: unknown } } | undefined)?.position?.principal
  return Number.isSafeInteger(p) && (p as number) > 0 ? (p as number) : 0
}

export interface DeskDeps {
  lender: PhoneLender
  state: PhoneLenderState & DeskState
  transport: () => NegotiationTransport
  evidenceKeys: () => Promise<PortableScorerKey[]>
  core?: CheckCore
  changed: () => void
  /** the active network's name: on a public one every event the lender signs whole is labelled test data */
  network?: string | null
  /** for tests */
  now?: () => number
  /** Explicit development signer permission for labelled test rehearsals. */
  allowDevelopment?: boolean
  partTimeoutMs?: number
}

export class NegotiatedDesk {
  private server: { close(): void } | null = null
  private feesBlocked = false

  constructor(private readonly d: DeskDeps) {}

  private get s() { return this.d.state }
  private async save() { await this.d.lender.persist(); this.d.changed() }
  private nowS() { return Math.floor((this.d.now ?? Date.now)() / 1000) }

  get serving(): boolean { return this.server !== null }

  /** The posted offer as the review reads it. */
  private offer(): (OfferPolicy & { expires_height: number; withdrawn?: boolean }) | null {
    const o = this.s.offer
    if (!o) return null
    const p = o.payload
    return { d: o.d, min: p.min, max: p.max, apr_bps: p.apr_bps, term_blocks: p.term_blocks, grace_blocks: p.grace_blocks, ltv_ladder_bps: p.ltv_ladder_bps, requirements: p.requirements, band: [-100, 200], expires_in_blocks: 1000, expires_height: p.expires_height, withdrawn: o.withdrawn || o.expired }
  }

  /**
   * Principal this lender is committed to or negotiating, against its signed max_outstanding: loans not yet repaid,
   * sheets waiting for approval, and recent negotiations still open or agreed with a check that may still qualify
   * (reserved from the ASK, so two borrowers at once cannot both be promised the same capacity). `except` leaves one
   * sheet out, for the final check before it is approved.
   */
  outstanding(except?: Hex): number {
    const now = this.nowS()
    const loans = Object.values(this.s.loans).filter((l) => !l.repayment_txid && !l.cancelled)
    const sheets = Object.values(this.s.proposals ?? {}).filter((p) => p.loan_id !== except)
    const held = new Set<Hex>([...loans.flatMap((l) => (l.negotiation_id ? [l.negotiation_id] : [])), ...Object.values(this.s.proposals ?? {}).map((p) => p.negotiation_id)])
    const pending = Object.values(this.s.negotiations ?? {}).filter((r) => !held.has(r.negotiation_id) && now - r.started_at < RESERVE_SECONDS && reserves(r))
    return loans.reduce((s, l) => s + l.terms.principal, 0) + sheets.reduce((s, p) => s + p.sheet.terms.principal, 0) + pending.reduce((s, r) => s + reservedPrincipal(r), 0)
  }

  /** Answer every ASK to this lender while the offer is up. */
  start(): void {
    const m = this.s.market
    const offer = this.offer()
    if (this.server || !m || !offer || offer.withdrawn) return
    const seen = { has: (id: Hex) => (this.s.asks_seen ?? []).includes(id), add: (id: Hex) => { this.s.asks_seen = [...(this.s.asks_seen ?? []), id].slice(-200); void this.save() } }
    const signer = lenderSigner(this.d.lender.key, this.d.network)
    void this.d.lender.platform.fees(this.d.lender.pubkey).then((f) => { this.feesBlocked = !!f.blocked }).catch(() => {})
    this.server = serveNegotiations({
      transport: this.d.transport(), policy: m.policy, params: m.params, min_principal: offer.min, seen,
      signer: () => signer,
      outstanding: () => this.outstanding(),
      admit: (ask) => this.admit(ask),
      onMessage: (msg, _direction, ask) => this.onMessage(msg, ask),
      onResult: (r) => { void this.onResult(r) },
      onError: (e) => { void this.d.lender.say('Negotiation error', { error: (e as Error).message }) },
      now: this.d.now,
    })
  }

  stop(): void { this.server?.close(); this.server = null }

  /** Before anything is answered: the offer is live and this lender owes no overdue fee. */
  private admit(_ask: AskInfo): true | string {
    const o = this.offer()
    if (!o || o.withdrawn) return 'OFFER_WITHDRAWN'
    if (this.feesBlocked) return 'FEES_OVERDUE'
    return true
  }

  private record(ask: AskInfo): NegotiationRecord {
    const all = this.s.negotiations ?? (this.s.negotiations = {})
    let r = all[ask.negotiation_id]
    if (!r) {
      r = { negotiation_id: ask.negotiation_id, borrower_pk: ask.borrower_pk, started_at: this.nowS(), messages: [], outcome: 'open', verified: false, problems: [] }
      all[ask.negotiation_id] = r
      // keep the newest few
      const ids = Object.values(all).sort((a, b) => a.started_at - b.started_at).map((x) => x.negotiation_id)
      for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_NEGOTIATIONS))) delete all[id]
    }
    return r
  }

  /** The live transcript: every signed message as it is sent or received. */
  private onMessage(m: NegotiationMessage, ask: AskInfo): void {
    const r = this.record(ask)
    if (!r.messages.some((x) => x.seq === m.seq)) r.messages = [...r.messages, m].sort((a, b) => a.seq - b.seq)
    void this.save()
  }

  private async onResult(res: NegotiationResult): Promise<void> {
    const all = this.s.negotiations ?? (this.s.negotiations = {})
    const r = all[res.negotiation_id] ?? (all[res.negotiation_id] = { negotiation_id: res.negotiation_id, borrower_pk: res.counterparty_pk, started_at: this.nowS(), messages: [], outcome: 'open', verified: false, problems: [] })
    r.messages = res.messages
    r.verified = res.verified.ok
    r.problems = res.problems.slice(0, 5)
    r.outcome = 'agreed' in res.outcome && res.verified.ok && res.verified.accept_hash ? { agreed: res.outcome.agreed, accept_hash: res.verified.accept_hash } : { no_deal: 'agreed' in res.outcome ? 'PROTOCOL' : res.outcome.no_deal }
    await this.save()
    if (typeof r.outcome === 'object' && 'agreed' in r.outcome) {
      await this.d.lender.say('Negotiation agreed over Nostr', { negotiation_id: r.negotiation_id.slice(0, 12), messages: r.messages.length, apr: `${r.outcome.agreed.apr_bps / 100}%`, ltv: `${r.outcome.agreed.ltv_bps / 100}%`, transcript: 'verified' })
      await this.check(r.negotiation_id)
    } else {
      await this.d.lender.say('Negotiation ended without a deal', { negotiation_id: r.negotiation_id.slice(0, 12), reason: (r.outcome as { no_deal: string }).no_deal })
    }
  }

  /** The billed credit check of an agreed negotiation; its record (with the verified outcome) is kept in app storage. */
  async check(negotiationId: Hex): Promise<CheckRecord | null> {
    const r = this.s.negotiations?.[negotiationId]
    const m = this.s.market
    const offer = this.offer()
    if (!r || !m || !offer || typeof r.outcome !== 'object' || !('agreed' in r.outcome)) return null
    const agreed = r.outcome.agreed
    const stage = (st: CheckStage) => { r.check_stage = st; void this.save() }
    try {
      const rec = await runBilledCheck({
        core: this.d.core, transport: this.d.transport(), signer: lenderSigner(this.d.lender.key, this.d.network), borrowerPk: r.borrower_pk, negotiationId, agreed,
        offer, assetId: this.d.lender.assetId, policy: m.policy, evidenceKeys: await this.d.evidenceKeys(), tags: publicLabels(this.d.network),
        allowDevelopment: this.d.allowDevelopment, listOffers: (kind) => this.d.lender.relay.list(kind), partTimeoutMs: this.d.partTimeoutMs, onStage: stage, economics: this.d.lender.economics,
      })
      r.check = rec
      delete r.check_error
      if (rec.bill?.bill_hash) this.s.bills = [...(this.s.bills ?? []).filter((b) => b.bill_hash !== rec.bill.bill_hash), { bill_hash: rec.bill.bill_hash, negotiation_id: negotiationId, borrower_pk: r.borrower_pk, operator_pk: rec.bill.operator_pk, asset_id: rec.bill.asset_id, amount: rec.bill.amount }].slice(-50)
      await this.save()
      await this.d.lender.say('Credit check billed at close, not paid up front', { negotiation_id: negotiationId.slice(0, 12), verified: rec.ok, recommendation: rec.recommendation, bill: rec.bill.amount, fundable: rec.refusals.length === 0 })
      return rec
    } catch (e) {
      r.check_error = e instanceof CheckRefused ? e.reason : (e as Error).message
      r.check_stage = 'refused'
      await this.save()
      await this.d.lender.say('Credit check refused before it ran', { negotiation_id: negotiationId.slice(0, 12), reason: r.check_error.slice(0, 160) })
      return null
    }
  }

  /** A negotiated application: reviewed here; a sheet waits for the person's approval, anything else is declined. */
  async review(app: ApplicationPayload, borrowerPk: Hex): Promise<ReviewResult> {
    const m = this.s.market
    const offer = this.offer()
    const negId = (app.negotiation as NegotiationMessage[] | undefined)?.[0]?.negotiation_id
    if (!m || !offer) return { declined: { failed: [{ id: 'flow', ok: false, detail: 'this phone has no negotiated offer posted' }], checks: [] } }
    const result = await reviewNegotiated(this.d.lender, { offer, market: m, record: negId ? this.s.negotiations?.[negId] : undefined, check: negId ? this.s.negotiations?.[negId]?.check : undefined }, app, borrowerPk)
    if ('proposal' in result) {
      this.s.proposals = { ...(this.s.proposals ?? {}), [result.proposal.loan_id]: result.proposal }
      await this.save()
      await this.d.lender.say('Term sheet ready for the lender\'s approval', { loan_id: result.proposal.loan_id.slice(0, 12), apr: `${result.proposal.sheet.apr_bps / 100}%`, checks: result.proposal.checks.length })
    } else {
      this.s.declined = [...(this.s.declined ?? []).slice(-9), { at: this.nowS(), borrower_pk: borrowerPk, principal: app.principal, failed: result.declined.failed }]
      await this.save()
      await this.d.lender.say('Application declined', { failed: result.declined.failed })
    }
    return result
  }

  /**
   * After the person's approval on this phone (the lock is lend-flow's): sign the approval of exactly this
   * sheet, register it, record the loan (approved to fund once the collateral locks) and send the acceptance.
   */
  async approveAndSend(loanId: Hex): Promise<LenderLoan> {
    const p = this.s.proposals?.[loanId]
    const m = this.s.market
    const offer = this.offer()
    if (!p || !m || !offer) throw new Error('no term sheet waiting for approval')
    if (offer.withdrawn) throw new Error('the offer was withdrawn')
    // the final aggregate check: everything else committed or reserved, plus this sheet, stays within the signed cap
    const others = this.outstanding(loanId)
    if (others + p.sheet.terms.principal > m.policy.max_outstanding) throw new Error(`not approving: ${p.sheet.terms.principal} on top of ${others} committed or negotiating is above this lender's signed maximum of ${m.policy.max_outstanding}`)
    const approval: Approval = await lenderApproval(this.d.lender.key, p)
    const problems = sendProblems(p, [approval], m.policy, { pubkey: this.d.lender.pubkey, assetId: this.d.lender.assetId, economics: this.d.lender.economics })
    if (problems.length) throw new Error(`not sending: ${problems.join('; ')}`)
    const { loan } = await this.d.lender.platform.registerLoan(p.sheet.terms, p.passbook)
    if (loan.id !== loanId) throw new Error('the platform registered another loan id than the term-sheet hash')
    const bill = this.s.bills?.find((b) => b.negotiation_id === p.negotiation_id)
    const l: LenderLoan = {
      terms: p.sheet.terms, borrower_pk: p.borrower_pk, accepted_at: this.nowS(), checks: p.checks, memo: `negotiated: the agreed ${p.sheet.apr_bps / 100}% APR stands`,
      fund_approved: true, termsheet: p.sheet, lender_approvals: [approval], negotiation_id: p.negotiation_id, ...(bill ? { check_bill: bill } : {}),
    }
    this.s.loans[loanId] = l
    // the sheet now carries the evidence digest; the outcome itself is no longer needed on the phone
    const rec = this.s.negotiations?.[p.negotiation_id]
    if (rec?.check) rec.check.outcome = null
    const proposals = { ...(this.s.proposals ?? {}) }
    delete proposals[loanId]
    this.s.proposals = proposals
    await this.save()
    await this.d.lender.relay.send(KIND.ACCEPTANCE, acceptancePayload(this.d.lender.offerId({ d: offer.d }), p, [approval], m.policy), p.borrower_pk)
    await this.d.lender.say('Term sheet approved and sent', { loan_id: loanId.slice(0, 12), apr: `${p.sheet.apr_bps / 100}% (negotiated)`, evidence: p.sheet.scorer.evidence ? hashObject(p.sheet.scorer.evidence).slice(0, 12) : 'none' })
    return l
  }

  /** The person declined the sheet: nothing is sent; the borrower's wait runs out. */
  async declineSheet(loanId: Hex): Promise<void> {
    const proposals = { ...(this.s.proposals ?? {}) }
    const p = proposals[loanId]
    if (!p) return
    delete proposals[loanId]
    this.s.proposals = proposals
    this.s.declined = [...(this.s.declined ?? []).slice(-9), { at: this.nowS(), borrower_pk: p.borrower_pk, principal: p.sheet.terms.principal, failed: [{ id: 'lender', ok: false, detail: 'declined by the lender on this phone' }] }]
    await this.save()
  }
}
