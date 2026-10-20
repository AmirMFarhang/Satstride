// The lender's side, in the canvas's terms: three stops ask for a decision (post the offer,
// fund a loan, pay the platform fee); everything else runs by itself and says what it is
// waiting on. Applications that pass every check are accepted under the policy the person
// approved when posting (as the laptop peer's operator approves its policy); no money moves
// until the person funds that loan. The co-signed release needs no stop: it only returns
// the borrower's own bitcoin once their repayment settled in this phone's account.
// Lane E3: a negotiated offer is also served over Nostr (src/lender/desk.ts): the agent
// negotiates inside the signed policy, runs the credit check billed at close, and a term
// sheet that passes waits for the person's approval (one stop: these terms, and the payout
// once their bitcoin is locked).
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import type { Hex } from '../../../../src/core/crypto.js'
import { debtOf } from '../../../../src/core/terms.js'
import type { LenderPolicy } from '../../../../src/agents/lender.js'
import { shortUnits } from '../core/amounts'
import { NETWORK } from '../wallet/config'
import { requirePhoneLock } from '../wallet/phone-lock'
import type { LenderLoan, PhoneLender, PhoneLenderState } from '../agent/lender'
import type { NegotiationTransport } from '../../../../src/market/negotiate-nostr.js'
import type { PortableScorerKey } from '../../../../src/scorer/portable-evidence.js'
import { pinnedScorerKeys } from './scorer-keys'
import { NegotiatedDesk } from '../lender/desk'
import type { CloseFees } from '../lender/fees'
import { engineParams, offerTerms, signMarketPolicy, type MarketChoice } from '../lender/market-policy'
import { publicLabels } from '../lender/signer'
import { ensureRgbReserve, type ReservePorts } from './reserve'
import { Store } from './store'

export type LoanPhase = 'to-fund' | 'waiting-lock' | 'paying-out' | 'reconcile' | 'open' | 'repaid' | 'releasing' | 'fee-due' | 'closed' | 'cancelled'

/** Where a loan stands, from what the phone holds (no network). */
export function loanPhase(l: LenderLoan, feeDue: boolean): LoanPhase {
  if (l.cancelled) return 'cancelled'
  if (!l.fund_approved) return 'to-fund'
  if (l.disbursement_attempted && !l.disbursement_txid) return 'reconcile'
  if (!l.lock) return 'waiting-lock'
  if (!l.disbursement_txid || l.funded_sent === false || (l.funded_sent === undefined && !l.repayment_account)) return 'paying-out'
  if (!l.repayment_txid) return 'open'
  if (!l.release_txid) return 'releasing'
  if (l.fee_paid_txid) return 'closed'
  return feeDue ? 'fee-due' : 'repaid'
}

export interface LendState {
  listening: boolean
  /** what the phone is doing now, by loan ('' for the offer) */
  working: Record<string, string>
  error: string | null
  /** fees the platform says are due, by loan */
  feesDue: Record<Hex, number>
  /** each due fee's parts: the platform share and the credit checks billed at close (E3) */
  feeParts: Record<Hex, CloseFees>
  /** the negotiated desk answers ASKs over Nostr */
  negotiating: boolean
}

/** Optional scorer signer restrictions for this build; the signed operator offer is verified in every case. */
export interface LendOptions {
  /** default: the pinned keys in scorer-keys.json, the same file the borrower flow checks against */
  evidenceKeys?: () => Promise<PortableScorerKey[]>
  transport?: () => NegotiationTransport
}

export class LendFlow {
  readonly store = new Store<LendState>({ listening: false, working: {}, error: null, feesDue: {}, feeParts: {}, negotiating: false })
  private desks = new Map<string, NegotiatedDesk>()
  private following = new Set<Hex>()
  private stopListening = false

  /** the asset the person chose to lend, before an offer names it */
  asset: string | null = null

  constructor(
    private readonly lenderFor: (assetId: string) => PhoneLender,
    readonly state: PhoneLenderState,
    private readonly reserve: () => ReservePorts,
    private readonly changed: () => void,
    private readonly options: LendOptions = {},
  ) {}

  /** The negotiated desk for the offer's asset (the agent's negotiated applications go to it). */
  desk(): NegotiatedDesk | null {
    const a = this.lender()
    if (!a) return null
    let d = this.desks.get(a.assetId)
    if (!d) {
      // the session's relay connection (it drops events whose signature does not verify), or a test's
      const network = (NETWORK as { name?: string }).name ?? null
      a.publicTags = publicLabels(network)
      d = new NegotiatedDesk({ lender: a, state: this.state, transport: () => this.options.transport?.() ?? a.relay.transport() as unknown as NegotiationTransport, evidenceKeys: this.options.evidenceKeys ?? pinnedScorerKeys, changed: this.changed, network })
      a.negotiated = (app, pk) => d!.review(app, pk)
      this.desks.set(a.assetId, d)
    }
    return d
  }

  private startDesk(): void {
    if (!this.state.market || !this.policy) return
    const d = this.desk()
    d?.start()
    this.patch({ negotiating: !!d?.serving })
  }

  private patch(p: Partial<LendState>) { this.store.set((s) => ({ ...s, ...p })) }
  private setWorking(key: string, label: string | null) {
    this.store.set((s) => {
      const working = { ...s.working }
      if (label) working[key] = label; else delete working[key]
      return { ...s, working }
    })
  }

  private async work(key: string, label: string, f: () => Promise<void>) {
    if (this.store.get().working[key]) return
    this.setWorking(key, label)
    this.patch({ error: null })
    await activateKeepAwakeAsync(`passbook-lend-${key || 'offer'}`).catch(() => {})
    try { await f() } catch (e) { this.patch({ error: (e as Error).message }) } finally {
      this.setWorking(key, null)
      deactivateKeepAwake(`passbook-lend-${key || 'offer'}`)
      this.changed()
    }
  }

  /** The agent for the offer's asset (or the one the person picked to lend). */
  lender(): PhoneLender | null {
    const asset = this.state.offer?.payload.asset_id ?? this.asset
    return asset ? this.lenderFor(asset) : null
  }
  private loanAgent(id: Hex): PhoneLender | null {
    const l = this.state.loans[id]
    return l ? this.lenderFor(l.terms.asset_id) : null
  }

  get policy(): LenderPolicy | null {
    const o = this.state.offer
    if (!o || o.withdrawn || o.expired) return null
    const p = o.payload
    return { d: o.d, min: p.min, max: p.max, apr_bps: p.apr_bps, term_blocks: p.term_blocks, grace_blocks: p.grace_blocks, ltv_ladder_bps: p.ltv_ladder_bps, requirements: p.requirements, band: [-100, 200], expires_in_blocks: 1000 }
  }

  /** On start: listen again for the posted offer, and pick up every loan where it stood. */
  resume(): void {
    if (this.policy) void this.listen()
    this.startDesk()
    for (const id of Object.keys(this.state.loans) as Hex[]) this.follow(id)
    void this.refreshFees()
    void this.syncUnfunded()
  }

  /** Loans never paid out: the platform may have closed them (a refund to the borrower after the funding window). */
  async syncUnfunded(): Promise<void> {
    for (const [id, l] of Object.entries(this.state.loans) as [Hex, LenderLoan][]) {
      if (l.disbursement_txid || l.cancelled) continue
      const a = this.lenderFor(l.terms.asset_id)
      const record = await a.platform.loan(id).catch(() => null)
      if (record && ['refunded', 'expired', 'cancelled', 'declined'].includes(record.status)) { l.cancelled = record.status; this.changed() }
    }
  }

  async refreshFees(): Promise<void> {
    const a = this.lender()
    if (!a) return
    try {
      const due = await a.feesDue()
      this.patch({ feesDue: Object.fromEntries(due.map((f) => [f.loan_id, f.amount])), feeParts: Object.fromEntries(due.map((f) => [f.loan_id, a.closeFees(f)])) })
    } catch { /* shown as unknown */ }
  }

  /**
   * Stop 1: post the offer. Applications that pass every check are then accepted by its rules. With `market`, the
   * offer also negotiates over Nostr inside a signed policy (the posted APR is where the agent opens, the floor the
   * lowest it agrees to) and asks for the credit check billed at close; each term sheet then waits for the person.
   */
  async post(policy: LenderPolicy, assetId: string, autoFund = true, market?: MarketChoice): Promise<void> {
    if (!this.state.offer || this.state.offer.withdrawn) this.asset = assetId
    const a = this.lender()
    if (!a) { this.patch({ error: 'No test USDT in this wallet to lend.' }); return }
    const lock = await requirePhoneLock(market
      ? `Post your offer: ${shortUnits(policy.min)}–${shortUnits(policy.max)} ${NETWORK.usdUnit}, your agent opens at ${policy.apr_bps / 100}% and never agrees below ${market.floor_apr_bps / 100}%`
      : `Post your offer: ${shortUnits(policy.min)}–${shortUnits(policy.max)} ${NETWORK.usdUnit} at ${policy.apr_bps / 100}% a year${autoFund ? ', paid out to borrowers who pass' : ''}`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return }
    await this.work('', 'Posting your offer', async () => {
      await a.recordApproval('offer', { offer_id: a.offerId(policy), min_micro: policy.min, max_micro: policy.max, apr_bps: policy.apr_bps, term_blocks: policy.term_blocks, requirements: policy.requirements, auto_fund: autoFund, ...(market ? { negotiation: { floor_apr_bps: market.floor_apr_bps, check_operators: market.check_operators, check_fee: 'billed-at-close' } } : {}) })
      // the reserve is ready before borrowers can apply: a payout must not wait on a block
      await ensureRgbReserve(this.reserve(), (w) => this.setWorking('', w))
      this.setWorking('', 'Posting your offer')
      if (market) {
        this.desk()?.stop()
        const st = await a.platform.state() as unknown as { deployment?: { negotiation?: { max_rounds?: number; concession_bps?: number } | null } | null }
        const params = engineParams(st.deployment, a.economics)
        const signed = await signMarketPolicy(a.key, assetId, policy, market)
        const terms = offerTerms(signed, params, policy.min, this.desk()?.outstanding() ?? 0)
        this.state.market = { policy: signed, params }
        await a.publishOffer(policy, { autoFund, negotiation: terms })
      } else {
        this.desk()?.stop()
        delete this.state.market
        await a.publishOffer(policy, { autoFund })
      }
    })
    if (this.policy) { void this.listen(); this.startDesk() }
  }

  /** The negotiated stop: approve this term sheet, and the payout once their bitcoin is locked. */
  async approveSheet(id: Hex): Promise<void> {
    const d = this.desk()
    const p = this.state.proposals?.[id]
    const a = this.lender()
    if (!d || !p || !a) return
    const t = p.sheet.terms
    const lock = await requirePhoneLock(`Sign: lend ${shortUnits(t.principal)} ${NETWORK.usdUnit} at ${p.sheet.apr_bps / 100}% once their bitcoin is locked`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return }
    await this.work(id, 'Sending your approval', async () => {
      await a.recordApproval('termsheet', { loan_id: id, termsheet_hash: id, principal_micro: t.principal, repay_micro: debtOf(t), apr_bps: p.sheet.apr_bps, collateral_sats: t.collateral_sats, maturity_height: t.maturity_height, evidence: p.sheet.scorer.evidence ?? null, check_bill: this.state.bills?.find((b) => b.negotiation_id === p.negotiation_id) ?? null })
      await d.approveAndSend(id)
    })
    this.follow(id)
  }

  /** The person declines the sheet: nothing is sent or registered. */
  async declineSheet(id: Hex): Promise<void> {
    await this.desk()?.declineSheet(id)
    this.changed()
  }

  async withdraw(): Promise<void> {
    const a = this.lender()
    this.stopListening = true
    this.desk()?.stop()
    this.patch({ negotiating: false })
    await this.work('', 'Withdrawing your offer', async () => { await a?.withdrawOffer() })
  }

  /** Wait for applications while the offer is up; each is checked and accepted or declined by itself. */
  private async listen(): Promise<void> {
    if (this.store.get().listening) return
    this.stopListening = false
    this.patch({ listening: true })
    try {
      while (!this.stopListening) {
        const a = this.lender()
        const policy = this.policy
        if (!a || !policy) break
        // an offer past its expiry is no longer in the order book: stop taking applications for it
        const height = await a.chain.getHeight().catch(() => null)
        if (height !== null && this.state.offer && height >= this.state.offer.payload.expires_height) {
          this.state.offer.expired = true
          this.changed()
          break
        }
        try {
          const r = await a.nextApplication(policy, 300_000)
          this.changed()
          if ('loan_id' in r) this.follow(r.loan_id)
          // a negotiated sheet waits for the person (approveSheet); the borrower waits three minutes for it
        } catch (e) {
          if (!/timed out/.test((e as Error).message)) { this.patch({ error: (e as Error).message }); await new Promise((res) => setTimeout(res, 10_000)) }
        }
      }
    } finally { this.patch({ listening: false }) }
  }

  /** Stop 2: the person's OK to fund this loan once the borrower's bitcoin is locked. */
  async fund(id: Hex): Promise<void> {
    const a = this.loanAgent(id)
    const l = this.state.loans[id]
    if (!a || !l) return
    const lock = await requirePhoneLock(`Sign: lend ${shortUnits(l.terms.principal)} ${NETWORK.usdUnit} once their bitcoin is locked`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return }
    await this.work(id, 'Recording your OK', async () => {
      await a.recordApproval('fund', { loan_id: id, terms_hash: id, principal_micro: l.terms.principal, repay_micro: debtOf(l.terms), collateral_sats: l.terms.collateral_sats, maturity_height: l.terms.maturity_height })
      l.fund_approved = true
      this.changed()
    })
    this.follow(id)
  }

  /** Stop 3: pay the platform's share of the interest on a closed loan. */
  async payFee(id: Hex): Promise<void> {
    const a = this.loanAgent(id)
    const amount = this.store.get().feesDue[id]
    if (!a || amount === undefined) return
    const lock = await requirePhoneLock(`Sign: pay the platform fee, ${shortUnits(amount)} ${NETWORK.usdUnit}`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return }
    await this.work(id, 'Paying the platform fee', async () => {
      await a.recordApproval('fee', { loan_id: id, amount_micro: amount })
      await ensureRgbReserve(this.reserve(), (w) => this.setWorking(id, w))
      this.setWorking(id, 'Paying the platform fee')
      await a.payFee(id)
      await this.refreshFees()
    })
  }

  /** Everything between the stops, for one loan, in order; it stops at a stop and says why. */
  follow(id: Hex): void {
    if (this.following.has(id)) return
    const l = this.state.loans[id]
    const a = this.loanAgent(id)
    if (!l || !a || !l.fund_approved || l.release_txid) { if (l?.release_txid) void this.refreshFees(); return }
    this.following.add(id)
    void this.work(id, 'Waiting for their bitcoin to lock', async () => {
      try {
        if (!l.disbursement_txid && l.disbursement_pending) {
          this.setWorking(id, 'Checking the earlier payout')
          await a.resumePayout(id)
          this.changed()
        }
        if (l.disbursement_txid && !l.funded_sent) {
          // paid out, but the steps after it (watch, IOU invoice, FUNDED) did not all finish
          this.setWorking(id, 'Finishing the payout')
          await a.finishPayout(id)
          this.changed()
        }
        if (!l.disbursement_txid) {
          if (l.disbursement_attempted) throw new Error('A payout was started but not confirmed. Check the wallet before trying again.')
          await ensureRgbReserve(this.reserve(), (w) => this.setWorking(id, w))
          this.setWorking(id, 'Waiting for their bitcoin to lock')
          await a.fund(id)
          this.changed()
        }
        if (!l.iou) {
          this.setWorking(id, 'Waiting for their IOU')
          await a.awaitIou(id).catch(() => { /* the loan does not depend on it */ })
          this.changed()
        }
        if (!l.repayment_txid) {
          this.setWorking(id, `Open · due by block ${l.terms.maturity_height}`)
          await a.confirmRepayment(id, 7 * 24 * 3600 * 1000)
          this.changed()
        }
        if (!l.release_txid) {
          this.setWorking(id, 'Co-signing the release')
          await a.signRelease(id)
          this.changed()
        }
        this.setWorking(id, 'Waiting for the platform fee')
        for (let i = 0; i < 20; i++) {
          await this.refreshFees()
          if (this.store.get().feesDue[id] !== undefined || l.fee_paid_txid) break
          await new Promise((r) => setTimeout(r, 3000))
        }
      } finally { this.following.delete(id) }
    })
  }
}
