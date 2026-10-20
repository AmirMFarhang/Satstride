// The borrower's side as the canvas runs it: the stops ask for a decision (sign the rules, the
// check's consent and signed check result, accept and lock, pay); everything else runs by itself
// and says what it is waiting on.
// The flow lives outside the screens, so the person can leave the tab and come back. It
// drives the M3/M5 agent (src/agent/borrower.ts) unchanged; every number is the agent's,
// from src/. Money moves only after the phone's lock, at a stop.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import type { Hex } from '../../../../src/core/crypto.js'
import { debtOf, type LoanTerms } from '../../../../src/core/terms.js'
import type { Offer } from '../../../../src/market/orderbook.js'
import { bundleCategories } from '../../../../src/scorer/consent.js'
import { DEFAULT_TOLERANCE, type EngineParams, type NegotiationMessage, type Position } from '../../../../src/market/negotiate-engine.js'
import { DEFAULT_ECONOMICS } from '../../../../src/core/economics.js'
import type { Bundle } from '../../../../src/sandbox/types.js'
import { formatBtc, shortUnits } from '../core/amounts'
import { requirePhoneLock } from '../wallet/phone-lock'
import type { PhoneBorrower, PhoneAgentState } from '../agent/borrower'
import { ensureCollateral, ensureRgbReserve, type ReservePorts } from './reserve'
import { Store } from './store'
import { offerTerms, signPolicy, withinRules, type PolicyInput } from './borrow-policy'
import type { BorrowerPolicy } from '../../../../src/market/policy.js'
import { activeNetwork, testLabelTags } from '../core/network'
import { labelledEventSigner } from '../agent/relay'
import { awaitCheckMessage, checkSigner, CheckRefused, readCheckNodes, type CheckNodeRow } from './credit-check'
import { openForwardedCheck, prepareBorrowerCheckPart, relayEvents, type BorrowerCheckPart, type BorrowerCheckView } from '../../../../src/checknode/borrower-check.js'
import type { PortableScorerKey } from '../../../../src/scorer/portable-evidence.js'
import { negotiateAsBorrower } from '../../../../src/market/negotiate-nostr.js'
import { checkMessageHash, type CheckMessage } from '../../../../src/checknode/messages.js'


export type BorrowStage =
  | 'idle'
  // negotiated origination: the phone's agent negotiates within the signed policy, then the lender-paid check
  | 'negotiating' | 'no-deal' | 'negotiation-failed'
  | 'check-node' | 'consent' | 'check-sealing' | 'check-opening' | 'check-result' | 'check-refused' | 'no-terms'
  | 'applying' | 'awaiting'
  | 'terms'
  | 'collateral' | 'locking' | 'funding' | 'open'
  | 'repaying' | 'iou' | 'releasing' | 'closed'

export interface BorrowState {
  stage: BorrowStage
  offer?: Offer
  principal?: number
  loanId?: Hex
  terms?: LoanTerms
  /** the negotiation as it happens: every signed message, sent or received */
  transcript?: NegotiationMessage[]
  deal?: { negotiation_id: Hex; agreed: Position; accept_hash: Hex; messages: NegotiationMessage[] }
  noDeal?: string
  checkNodes?: CheckNodeRow[]
  checkNode?: CheckNodeRow
  part?: BorrowerCheckPart
  checkView?: BorrowerCheckView
  /** checkMessageHash of the KEY the lender forwarded: the application names the check by it */
  checkKey?: Hex
  /** the negotiated application went out (a retry only waits for the terms) */
  applied?: boolean
  /** a refusal from the check protocol, as P2 words it ("CODE: words" or "lender: CODE") */
  refused?: string
  /** why the negotiation stopped without an outcome (signer, relay, this build) */
  stopped?: string
  /** what the phone is doing now, in plain words */
  working: string | null
  error: string | null
}

const IDLE: BorrowState = { stage: 'idle', working: null, error: null }

/** How long the phone waits for the lender at each step of the negotiated path. */
const WAIT = { reply: 30_000, key: 300_000, terms: 180_000 }

export class BorrowFlow {
  readonly store = new Store<BorrowState>(IDLE)
  /** the sealed bundle stays in memory only, for opening the forwarded result */
  private bundle: Bundle | null = null

  constructor(
    private readonly agentFor: (assetId: string) => PhoneBorrower,
    private readonly state: PhoneAgentState,
    private readonly reserve: () => ReservePorts,
    private readonly changed: () => void,
    /** Optional signer restrictions configured before the build; otherwise verify the selected operator declaration. */
    private readonly evidenceKeys: () => Promise<PortableScorerKey[]> = async () => [],
  ) {}

  get value(): BorrowState { return this.store.get() }

  private patch(p: Partial<BorrowState>) { this.store.set((s) => ({ ...s, ...p })) }

  private async work(label: string, f: () => Promise<void>, onError?: (e: Error) => Partial<BorrowState>) {
    if (this.value.working) return
    this.patch({ working: label, error: null })
    await activateKeepAwakeAsync('passbook-borrow').catch(() => {})
    try { await f() } catch (e) {
      this.patch({ error: (e as Error).message, ...(onError ? onError(e as Error) : {}) })
    } finally {
      this.patch({ working: null })
      deactivateKeepAwake('passbook-borrow')
      this.changed()
    }
  }

  /** The open loan this phone holds (locked, not yet released), if any. */
  openLoan(): { id: Hex; loan: PhoneAgentState['loans'][Hex] } | null {
    const e = Object.entries(this.state.loans).find(([, l]) => l.lock && !l.release_txid)
    return e ? { id: e[0] as Hex, loan: e[1] } : null
  }

  /** On start: pick up a loan where it stood. Waiting steps continue by themselves; nothing new is signed without a stop. */
  resume(): void {
    const open = this.openLoan()
    if (!open) return
    const { id, loan } = open
    const base = { loanId: id, terms: loan.terms }
    if (!loan.disbursement_txid) {
      this.patch({ ...base, stage: 'funding' })
      void this.work('Waiting for the lender to pay you', async () => {
        await this.agentFor(loan.terms.asset_id).awaitFunding(id)
        this.patch({ stage: 'open' })
      })
    } else if (!loan.repayment_txid) {
      this.patch({ ...base, stage: 'open' })
    } else {
      // paid: report it if the lender was never told, then the release, which only pays the
      // person's own address, finishes without a stop
      this.patch({ ...base, stage: loan.repaid_sent ? 'releasing' : 'repaying' })
      void (async () => {
        if (!loan.repaid_sent) await this.work('Telling the lender you paid', async () => { await this.agentFor(loan.terms.asset_id).repay(id) })
        await this.finishRelease(id)
      })()
    }
  }

  reset(): void {
    if (this.value.working) return
    this.bundle = null
    this.store.set(IDLE)
  }

  /** The person's borrowing rules, signed with the party key after the phone's lock and kept with the agent's state. */
  async signRules(assetId: string, input: PolicyInput): Promise<BorrowerPolicy | null> {
    const lock = await requirePhoneLock(`Sign your rules: up to ${shortUnits(input.principal)} test USDT, at most ${input.max_apr_bps / 100}% a year`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return null }
    if (!(input.principal > 0 && input.term_blocks > 0 && input.max_apr_bps > 0 && input.max_ltv_bps > 0 && input.max_ltv_bps < 10_000)) { this.patch({ error: 'These rules are incomplete.' }); return null }
    const agent = this.agentFor(assetId)
    const policy = await signPolicy(agent.key, input)
    this.state.policy = policy
    await agent.persist()
    this.changed()
    return policy
  }

  /**
   * The phone's agent negotiates with this lender over Nostr (src/market/negotiate-nostr.ts negotiateAsBorrower): the
   * engine decides every move in code inside the signed rules, both sides verify the transcript
   * on every message, and the agreement is checked again here against the rules before anything
   * is shared. A no-deal or a stop is an outcome with its own screen, never an error to retry.
   */
  negotiate(offer: Offer, principal: number): void {
    const policy = this.state.policy
    const terms = offerTerms(offer)
    if (!policy) { this.patch({ error: 'Set and sign your borrowing rules first.' }); return }
    this.bundle = null
    this.store.set({ ...IDLE, stage: 'negotiating', offer, principal, transcript: [] })
    if (!terms) { this.patch({ stage: 'negotiation-failed', stopped: 'TERMS' }); return }
    const agent = this.agentFor(offer.payload.asset_id)
    void this.work(`Negotiating with lender ${offer.lender_pk.slice(0, 6)}`, async () => {
      const params = await this.engineParams(agent)
      const r = await negotiateAsBorrower({
        // one signer object for the negotiation and the check: a CheckSigner, and the worklet signs whole events itself
        transport: agent.relay.transport(), signer: { ...checkSigner(agent.key), signEvent: labelledEventSigner(agent.key, testLabelTags(activeNetwork())) }, policy, terms, params, timeoutMs: WAIT.reply,
        onMessage: (m) => this.patch({ transcript: [...(this.value.transcript ?? []), m] }),
      })
      this.patch({ transcript: r.messages })
      if ('no_deal' in r.outcome) { this.patch({ stage: 'no-deal', noDeal: r.outcome.no_deal }); return }
      const v = r.verified
      if (!v.ok || !v.agreed || !v.accept_hash) { this.patch({ stage: 'no-deal', noDeal: 'PROTOCOL' }); return }
      // code, not the model, keeps the agent inside what the person signed
      const outside = withinRules(policy, v.agreed)
      if (outside || v.agreed.principal !== principal) { this.patch({ stage: 'no-deal', noDeal: 'POLICY' }); return }
      await agent.say('Negotiation agreed over Nostr', { lender: offer.lender_pk.slice(0, 12), apr: `${v.agreed.apr_bps / 100}%`, ltv: `${v.agreed.ltv_bps / 100}%`, messages: r.messages.length })
      this.patch({ stage: 'check-node', deal: { negotiation_id: r.negotiation_id, agreed: v.agreed, accept_hash: v.accept_hash, messages: r.messages } })
      await this.loadCheckNodes()
    }, (e) => ({ stage: 'negotiation-failed', stopped: /NOT_IN_THIS_BUILD/.test(e.message) ? 'NOT_IN_THIS_BUILD' : /relay|publish/i.test(e.message) ? 'TRANSPORT' : 'SIGNER' }))
  }

  /** The engine's parameters on this phone; max_rounds is the lender's, from its terms. */
  private async engineParams(agent: PhoneBorrower): Promise<EngineParams> {
    // only the concession step comes from the platform's published settings; max_rounds is the lender's signed number
    const st = await agent.platform.state().catch(() => null) as { deployment?: { negotiation?: { enabled: boolean; max_rounds: number; concession_bps: number } } | null } | null
    const n = st?.deployment?.negotiation
    return { max_rounds: n?.max_rounds ?? 6, concession_bps: n?.concession_bps ?? 2_500, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: ['cosign-rgb'], economics: DEFAULT_ECONOMICS }
  }

  /** The check nodes' offers from the relay (kind 38401), usable ones first. */
  async loadCheckNodes(): Promise<void> {
    const offer = this.value.offer
    if (!offer) return
    const { rows } = await readCheckNodes(this.agentFor(offer.payload.asset_id).relay)
    this.patch({ checkNodes: rows, checkNode: this.value.checkNode ?? rows.find((r) => r.usable) })
  }

  pickCheckNode(row: CheckNodeRow): void { if (row.usable) this.patch({ checkNode: row }) }

  /** From the consent screen or a node's refusal, back to choosing a node; the agreement stands. */
  backToCheckNodes(): void {
    if (this.value.working || !this.value.deal) return
    this.bundle = null
    this.patch({ stage: 'check-node', part: undefined, refused: undefined, error: null })
    void this.loadCheckNodes().catch((e: Error) => this.patch({ error: e.message }))
  }

  /** On to the consent screen with the chosen node. */
  reviewConsent(): void { if (this.value.checkNode?.usable) this.patch({ stage: 'consent', error: null }) }

  /** The bundle as it will be sealed: the loan request is the agreed loan, so the result binds it. */
  private async checkBundle(): Promise<{ bundle: Bundle; categories: string[] }> {
    const { offer, principal, deal } = this.value
    const bundle = this.bundle ?? await this.agentFor(offer!.payload.asset_id).buildSandboxBundle(offer!, principal!, deal!.agreed.apr_bps)
    this.bundle = bundle
    return { bundle, categories: bundleCategories(bundle) }
  }

  /** The data categories the consent will name (shown on the consent screen before anything is signed). */
  async consentCategories(): Promise<string[]> { return (await this.checkBundle()).categories }

  /**
   * The consent stop: after the phone's lock, sign the consent receipt (operator, release, data,
   * payer = lender), seal the bundle to the operator, hand the part to the lender, and wait for
   * the check node's signed check result, which the phone checks before showing it.
   */
  async consent(): Promise<void> {
    const { offer, principal, deal, checkNode } = this.value
    if (!offer || principal === undefined || !deal || !checkNode) return
    const lock = await requirePhoneLock(`Share your sealed history with check node ${checkNode.offer.operator_pk.slice(0, 6)}; lender ${offer.lender_pk.slice(0, 6)} pays`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return }
    const agent = this.agentFor(offer.payload.asset_id)
    const signer = checkSigner(agent.key)
    const transport = agent.relay.transport()
    await this.work('Sealing your history to the check node', async () => {
      const { bundle, categories } = await this.checkBundle()
      await agent.recordApproval('consent', { negotiation_id: deal.negotiation_id, lender_pk: offer.lender_pk, operator_pk: checkNode.offer.operator_pk, release_hash: checkNode.release_hash, payer: 'lender', data_categories: categories })
      const now = Math.floor(Date.now() / 1000)
      const part = await prepareBorrowerCheckPart({ signer, offer: checkNode.offer, lenderPk: offer.lender_pk, negotiationId: deal.negotiation_id, bundle, dataCategories: categories, now })
      // in hash-checked chunks when large (public relays cap events near 64 KiB), labelled as test data
      for (const e of await relayEvents(signer, part, offer.lender_pk, deal.negotiation_id, testLabelTags(activeNetwork()))) await transport.publish(e)
      this.patch({ stage: 'check-opening', part, working: 'The local scorer checks your history; waiting for the signed result' })
      const key = await awaitCheckMessage<CheckMessage>(transport, signer, { from: offer.lender_pk, negotiationId: deal.negotiation_id, type: 'KEY', sinceS: now - 5, timeoutMs: WAIT.key })
      const view = await openForwardedCheck({ key, part, bundle, offer: checkNode.offer, evidenceKeys: await this.evidenceKeys(), now: Math.floor(Date.now() / 1000) })
      await agent.say('Check result opened and verified on the phone', { ok: view.ok, operator: view.operator_pk.slice(0, 12), rail: view.rail_label, recommendation: view.outputs?.recommendation ?? null })
      this.patch({ stage: 'check-result', checkView: view, checkKey: checkMessageHash(key) })
    }, (e) => this.refusal(e, 'consent'))
  }

  private refusal(e: Error, back: BorrowStage): Partial<BorrowState> {
    if (e instanceof CheckRefused) return { stage: 'check-refused', refused: e.reason }
    return { stage: back }
  }

  /** With a verified result: the application with the signed transcript and the consent, then the lender's term sheet, checked. */
  continueToTerms(): void {
    const { offer, principal, deal, part, checkView, checkKey } = this.value
    if (!offer || principal === undefined || !deal || !part || !checkView?.ok || !checkKey) return
    const agent = this.agentFor(offer.payload.asset_id)
    void this.work(`Waiting for lender ${offer.lender_pk.slice(0, 6)}'s terms`, async () => {
      this.patch({ stage: 'applying' })
      await agent.applyNegotiated(offer, principal, { negotiation: deal.messages, consent: part.consent, check_key: checkKey })
      this.patch({ stage: 'awaiting', applied: true })
      await this.receiveTerms()
    }, (e) => this.termsFailed(e))
  }

  /** Wait once more for the term sheet of the application already sent; nothing is sent or signed. */
  waitForTerms(): void {
    if (!this.value.applied) return
    void this.work(`Waiting for lender ${this.value.offer?.lender_pk.slice(0, 6)}'s terms`, async () => {
      this.patch({ stage: 'awaiting' })
      await this.receiveTerms()
    }, (e) => this.termsFailed(e))
  }

  private async receiveTerms(): Promise<void> {
    const { offer, principal, deal, checkView } = this.value
    const agent = this.agentFor(offer!.payload.asset_id)
    // the deployment's maker-checker rule is enforced by the lender; the phone checks the lender's own signed rule
    const accepted = await agent.awaitAcceptance(offer!, principal!, WAIT.terms, {
      agreed: deal!.agreed, accept_hash: deal!.accept_hash, messages: deal!.messages, maker_checker_above_micro: Number.MAX_SAFE_INTEGER,
      check: { execution_id: checkView!.execution_id, operator_pk: checkView!.operator_pk, commitment: checkView!.commitment, recommendation: checkView!.outputs?.recommendation ?? null, outcome: checkView!.ok ? checkView!.outcome : null },
    })
    this.bundle = null
    this.patch({ stage: 'terms', loanId: accepted.loan_id, terms: accepted.terms })
  }

  private termsFailed(e: Error): Partial<BorrowState> {
    if (!this.value.applied) return { stage: 'check-result' }
    return { stage: /timed out/.test(e.message) ? 'no-terms' : 'awaiting' }
  }

  /** Stop 2 declined: nothing is locked or signed. */
  decline(): void { this.reset() }

  /** Stop 2: lock the collateral and accept. Moves the person's own bitcoin to the passbook key first if it is short. */
  async accept(): Promise<void> {
    const { loanId, terms } = this.value
    if (!loanId || !terms) return
    const lock = await requirePhoneLock(`Sign: lock ${formatBtc(terms.collateral_sats)} test BTC for ${shortUnits(terms.principal)} test USDT`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return }
    const agent = this.agentFor(terms.asset_id)
    await this.work('Locking your bitcoin', async () => {
      await agent.recordApproval('lock', { loan_id: loanId, terms_hash: loanId, collateral_sats: terms.collateral_sats, principal_micro: terms.principal, repay_micro: debtOf(terms), maturity_height: terms.maturity_height })
      // a negotiated loan: the phone countersigns exactly this sheet before anything locks
      if (this.state.loans[loanId]?.termsheet) await agent.approveTermSheet(loanId)
      this.patch({ stage: 'collateral' })
      const say = (w: string) => this.patch({ working: w })
      await ensureCollateral(this.reserve(), terms.collateral_sats, say)
      // the PB-IOU this phone issues and the repayment later both need the RGB reserve
      await ensureRgbReserve(this.reserve(), say)
      this.patch({ stage: 'locking', working: 'Locking your bitcoin' })
      await agent.lockAndSplit(loanId)
      this.changed()
      this.patch({ stage: 'funding', working: 'Waiting for the lender to pay you' })
      await agent.awaitFunding(loanId)
      this.patch({ stage: 'open' })
    })
  }

  /** Stop 3: pay the loan back; the lender co-signs and the bitcoin comes back without another stop. */
  async pay(): Promise<void> {
    const open = this.openLoan()
    if (!open) return
    const { id, loan } = open
    const t = loan.terms
    const lock = await requirePhoneLock(`Sign: repay ${shortUnits(debtOf(t))} test USDT`)
    if (!lock.ok) { this.patch({ error: lock.reason }); return }
    const agent = this.agentFor(t.asset_id)
    this.patch({ loanId: id, terms: t })
    await this.work('Sending your payment', async () => {
      await agent.recordApproval('repay', { loan_id: id, repay_micro: debtOf(t) })
      await ensureRgbReserve(this.reserve(), (w) => this.patch({ working: w }))
      this.patch({ stage: 'repaying', working: 'Sending your payment' })
      await agent.repay(id)
      this.changed()
    })
    if (this.state.loans[id]?.repayment_txid) await this.finishRelease(id)
  }

  private async finishRelease(id: Hex): Promise<void> {
    const loan = this.state.loans[id]
    const agent = this.agentFor(loan.terms.asset_id)
    await this.work('Waiting for the lender to sign', async () => {
      if (loan.iou && !loan.release_txid) {
        this.patch({ stage: 'iou', working: 'Waiting for the lender to return your IOU' })
        await agent.awaitIouReturn(id).catch(() => { /* the release does not depend on it */ })
      }
      this.patch({ stage: 'releasing', working: 'Waiting for the lender to sign' })
      await agent.release(id)
      this.patch({ stage: 'closed' })
    }, () => ({ stage: 'releasing' }))
  }

  /** Try the release again with the lender's signature. */
  retryRelease(): void {
    const id = this.value.loanId ?? this.openLoan()?.id
    if (id) void this.finishRelease(id)
  }

  /** The lender did not sign: the platform co-signs leaf C once it has checked the repayment itself. */
  releaseWithPlatform(): void {
    const id = this.value.loanId ?? this.openLoan()?.id
    if (!id) return
    const loan = this.state.loans[id]
    void this.work('Asking the platform to release', async () => {
      this.patch({ stage: 'releasing' })
      await this.agentFor(loan.terms.asset_id).releaseWithPlatform(id)
      this.patch({ stage: 'closed' })
    }, () => ({ stage: 'releasing' }))
  }
}
