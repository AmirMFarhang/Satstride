// The borrower agent on the phone. It speaks the laptop agents' protocol unchanged
// (src/agents/borrower.ts, the standalone peer sequence of src/cli/peer.ts):
//   findOffer -> ask -> runSandbox -> approve -> apply -> awaitAcceptance ->
//   lockAndSplit -> awaitFunding (+ PB-IOU) -> repay -> awaitIouReturn -> release.
// Every number and every check comes from the shared code in src/ (terms, money,
// economics, escrow, oracle, passbook); every signature from the party key in the
// worklet (ports.ts). It never mines: the laptop's regtest service does, and the
// phone waits for blocks like any light wallet.

import { hashObject, isHex, verifyHash, verifyObject, type Hex } from '../../../../src/core/crypto.js'
import { btc, collateralFor, ltvBps, usdt, type Micro } from '../../../../src/core/money.js'
import { debtOf, termsHash, validateTerms, type LoanTerms } from '../../../../src/core/terms.js'
import { feeWithinApr, impliedAprBps, termInterest } from '../../../../src/core/economics.js'
import {
  addLeafSignature, buildEscrowSpend, buildLock, extractHex, finalizeEscrowSpend, partiesOf, psbtFromBase64,
  releaseOutputs, splitLocktime, splitOutputs, TX_FEE_SATS, unsignedTxid, type KeyPathUtxo,
} from '../../../../src/escrow/escrow.js'
import { KIND } from '../../../../src/market/kinds.js'
import type { AcceptancePayload, ApplicationPayload, FundedPayload, RepaidPayload, SignaturePayload, SignRequestPayload } from '../../../../src/market/messages.js'
import type { Offer } from '../../../../src/market/orderbook.js'
import type { IouCertificate } from '../../../../src/market/iou.js'
import { approvalStatus, type Approval } from '../../../../src/market/approvals.js'
// types only: negotiate.ts and policy.ts load node: modules and are never imported for their code on the phone
import type { NegotiationMessage, Position } from '../../../../src/market/negotiate.js'
import { verifyTranscript } from '../../../../src/market/negotiate-engine.js'
import type { BorrowerPolicy, LenderPolicy } from '../../../../src/market/policy.js'
import type { LogEntry } from '../../../../src/governance/log.js'
import { eligiblePersona, type PersonaRecord } from '../app/persona'
import { termSheetHash, termSheetProblems, type TermSheet } from '../../../../src/market/termsheet.js'
import { verifyQuote } from '../../../../src/oracle/oracle.js'
import { verifyPassbook, type PassbookDocument, type PortablePage, type RgbRepaymentReceipt } from '../../../../src/registry/passbook-doc.js'
import { rgbHistoryRows, type RgbRowLabel } from '../../../../src/networks/rgb.js'
import type { Attestation } from '../../../../src/sandbox/broker.js'
import { scoredSheetProblems } from '../../../../src/scorer/bundle-terms.js'
import { termSheetEvidenceProblems } from '../../../../src/scorer/evidence-digest-core.js'
import type { ScorerOutcome } from '../../../../src/scorer/types.js'
import { sandboxScorerId } from '../../../../src/sandbox/provenance.js'
import { bundleCategories, consentHash, type ConsentReceipt } from '../../../../src/scorer/consent.js'
import scoringContract from '../../../../contracts/scoring.contract.json'
import type { Bundle, DisclosureItem, SandboxResult } from '../../../../src/sandbox/types.js'
import type { ChainPort, PartySigner, RgbPort, RgbTransferRow } from './ports'
import { parseAmbiguous } from '../core/sends'
import type { PhonePlatform } from './platform'
import type { PhoneRelay } from './relay'

/** A human approval on the phone (after its lock), signed by the party key; see recordApproval. */
export interface PhoneApproval { v: 1; domain: 'passbook-phone-approval-v1'; action: 'consent' | 'lock' | 'repay'; approver_pk: Hex; method: 'phone-lock'; approved_at: number; sig: Hex; [k: string]: unknown }
const APPROVAL_TITLES = {
  consent: 'Approved on the phone: share my sealed history for one credit check',
  lock: 'Approved on the phone: lock my collateral for these terms',
  repay: 'Approved on the phone: repay this loan',
} as const

/** How the wire names where the borrower runs. */
export const PHONE = 'phone (dev.passbook.wallet)'


export interface PhoneLoan {
  terms: LoanTerms
  lender_pk: Hex
  lock?: { txid: Hex; vout: number }
  disbursement_invoice?: string
  disbursement_recipient_id?: string
  disbursement_txid?: Hex
  repayment_invoice?: string
  repayment_txid?: Hex
  repayment_receipt?: RgbRepaymentReceipt
  iou?: IouCertificate
  release_txid?: Hex
  /** when the terms were accepted (unix s): the relay listens back to here after a restart */
  accepted_at?: number
  /** the signed lock, saved before it is broadcast: a retry rebroadcasts this one, never builds another */
  lock_pending?: { txid: Hex; hex: Hex }
  /** a repayment that was signed and may have been broadcast (the send failed late): resolved before any new payment */
  repay_pending?: { txid: Hex }
  /** the lender was told of the repayment (REPAID) */
  repaid_sent?: boolean
  /** Negotiated origination: the lender-signed sheet (its hash is the loan id), the lender's approvals under its signed policy, then the phone's countersignature and approval. */
  termsheet?: TermSheet
  lender_approvals?: Approval[]
  lender_policy?: LenderPolicy
  borrower_approval?: Approval
  /** the lender node's signed governance decisions for this loan (sanctions screen, term-sheet approval), each verified on arrival */
  lender_decisions?: LogEntry[]
}

/** What the negotiated loan must follow (src/agents/borrower.ts awaitAcceptance): the agreement both agents signed and the check this phone opened. */
export interface NegotiatedAcceptance {
  agreed: Position
  accept_hash: Hex
  messages: NegotiationMessage[]
  maker_checker_above_micro: Micro
  /**
   * The forwarded check the phone opened itself (src/checknode/borrower-check.ts BorrowerCheckView, used only when ok): the sheet
   * must name this execution and recommendation, lend exactly the scored loan, come from the same
   * scorer, and name no check receipt (the phone holds none).
   */
  check?: { execution_id: string | null; operator_pk: Hex; commitment: Hex | null; recommendation: string | null; outcome?: ScorerOutcome | null }
}

/** What the phone keeps between app runs (JSON, app-private storage): no keys, no seed. */
export interface PhoneAgentState {
  loans: Record<Hex, PhoneLoan>
  labels: Record<Hex, RgbRowLabel>
  passbook?: PassbookDocument
  relay_seen?: string[]
  /** signed approval notes not yet accepted by the platform's wire, oldest first: retried until delivered */
  outbox?: object[]
  /** the person's own borrowing rules, signed by the party key (src/market/policy.ts); the agent never goes past them */
  policy?: BorrowerPolicy
  /** REGTEST TEST DATA: set only while the phone runs the seeded test persona (src/app/persona.ts) */
  persona?: PersonaRecord
}

/**
 * From when the relay must listen after a restart: back to the oldest unfinished loan's
 * acceptance (a lender's FUNDED, NOTE_RETURNED or SIGNATURE may have come while the app was
 * closed), else a few seconds back. Events already handled are kept in relay_seen.
 */
export function relayWindow(state: PhoneAgentState, nowS = Math.floor(Date.now() / 1000)): number {
  const open = Object.values(state.loans).filter((l) => !l.release_txid && l.accepted_at)
  return open.length ? Math.min(...open.map((l) => l.accepted_at!)) - 60 : nowS - 5
}

/**
 * The lender node's governance decisions sent with the acceptance (P1, AcceptancePayload.lender_decisions):
 * kept only if each is a v1 decision-log entry whose hash is its content and whose node signature verifies,
 * about this loan or no loan. They are shown, never acted on.
 */
export function lenderDecisions(payload: object, loanId: Hex): LogEntry[] {
  const sent = (payload as { lender_decisions?: unknown }).lender_decisions
  const list = Array.isArray(sent) ? sent.slice(0, 16) as LogEntry[] : []
  return list.filter((e) => {
    if (!e || e.v !== 1 || e.domain !== 'passbook-decision-log-v1' || !isHex(e.node_pk, 32) || (e.loan_id !== null && e.loan_id !== loanId)) return false
    const { hash, sig, ...body } = e
    return hashObject(body) === hash && verifyHash(sig, hash, e.node_pk)
  })
}

export type Step = { step: string; detail?: Record<string, unknown> }

export class PhoneBorrower {
  constructor(
    readonly key: PartySigner,
    readonly platform: PhonePlatform,
    readonly relay: PhoneRelay,
    readonly chain: ChainPort,
    readonly rgb: RgbPort,
    readonly assetId: string,
    readonly state: PhoneAgentState,
    private readonly onStep: (s: Step) => void = () => {},
    /** Persist `state` (the app writes it to storage; tests keep it in memory). */
    private readonly save: () => Promise<void> = async () => {},
  ) {}

  get pubkey(): Hex { return this.key.pubkey }

  /** Write the agent's state to app storage now (after a change made outside the agent, such as a new signed policy). */
  async persist(): Promise<void> { await this.save() }

  /**
   * Narrate: to the screen and, signed by the party key, to the platform's wire (best effort,
   * never wallet data). Titles are the laptop agents' own (src/agents/borrower.ts), so the
   * platform's dashboard follows the phone exactly as it follows a laptop borrower; every note
   * says it came from the phone.
   */
  async say(step: string, detail?: Record<string, unknown>): Promise<void> {
    this.onStep({ step, detail })
    await this.flushOutbox()
    try { await this.platform.note(await this.key.signObject({ actor_pk: this.pubkey, role: 'borrower', title: step, detail: { ...(detail ?? {}), device: PHONE } })) } catch { /* narration is best effort */ }
  }

  /**
   * Deliver the signed approvals still waiting, oldest first; stop at the first the platform
   * does not accept and keep the rest (persisted). Returns how many are still waiting.
   */
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

  /**
   * The person's approval on the phone, after the phone's lock: a record signed by the party
   * key (what exactly was approved, by which key, how, when), shown on the platform's wire so
   * the laptop's dashboard sees each human approval. It authorises nothing by itself; the
   * signatures that move coins are the lock, split, repayment and release.
   */
  async recordApproval(action: 'consent' | 'lock' | 'repay', subject: Record<string, unknown>): Promise<PhoneApproval & { waiting: number }> {
    const approval = await this.key.signObject({ v: 1 as const, domain: 'passbook-phone-approval-v1' as const, action, ...subject, approver_pk: this.pubkey, method: 'phone-lock' as const, approved_at: Math.floor(Date.now() / 1000) }) as PhoneApproval
    // unlike narration, an approval record is never dropped: it waits in the persisted outbox
    // until the platform's wire accepts it (retried on every later note and at the next start)
    const note = await this.key.signObject({ actor_pk: this.pubkey, role: 'borrower', title: APPROVAL_TITLES[action], detail: { approval, device: PHONE } })
    this.state.outbox = [...(this.state.outbox ?? []), note]
    await this.save()
    this.onStep({ step: APPROVAL_TITLES[action], detail: { approval } })
    const waiting = await this.flushOutbox()
    return { ...approval, waiting }
  }

  private loan(id: Hex): PhoneLoan {
    const l = this.state.loans[id]
    if (!l) throw new Error(`no loan ${id.slice(0, 12)} on this phone`)
    return l
  }

  /** The signed passbook this phone keeps for itself (empty on a new wallet). */
  async passbookDocument(): Promise<PassbookDocument> {
    const doc = this.state.passbook
    if (doc) {
      if (doc.borrower_pk !== this.pubkey || !verifyObject(doc, this.pubkey)) throw new Error('saved passbook signature is invalid')
      return doc
    }
    return this.key.signObject({ v: 1 as const, borrower_pk: this.pubkey, pages: [] as PortablePage[] }) as Promise<PassbookDocument>
  }

  private async savePassbookPage(loanId: Hex, proof?: PortablePage['repayment'], outcome?: PortablePage['outcome']): Promise<void> {
    const l = this.loan(loanId)
    if (!l.lock) throw new Error('no lock for passbook page')
    const pages = (await this.passbookDocument()).pages.filter((p) => termsHash(p.terms) !== loanId)
    pages.push({ terms: l.terms, lock_txid: l.lock.txid, lock_vout: l.lock.vout, outcome_txid: l.release_txid, outcome, repayment: proof })
    pages.sort((a, b) => a.terms.open_height - b.terms.open_height)
    this.state.passbook = await this.key.signObject({ v: 1 as const, borrower_pk: this.pubkey, pages }) as PassbookDocument
    await this.save()
  }

  /** The party key's own BTC (BIP-86), the collateral source: from electrs. */
  async btcUtxos(): Promise<{ txid: Hex; vout: number; value: number; height: number }[]> {
    return this.chain.utxos(this.key.btc.script)
  }

  async ask(principal: Micro, aprBps = 1200, termBlocks = 30) {
    const passbook = await verifyPassbook(await this.passbookDocument(), this.chain)
    const quote = await this.platform.quote()
    const fee = termInterest({ principal, apr_bps: aprBps, term_blocks: termBlocks })
    const collateral = collateralFor(principal + fee, passbook.ladder.allowed_ltv_bps, quote.price_cents)
    const available = (await this.btcUtxos()).filter((u) => u.height > 0).reduce((s, u) => s + u.value, 0)
    await this.say('Asking for a loan', { principal: usdt(principal), term_blocks: termBlocks, allowed_ltv: `${passbook.ladder.allowed_ltv_bps / 100}% (step ${passbook.ladder.step})`, btc_needed: btc(collateral), btc_available: btc(available) })
    return { passbook, allowed_ltv_bps: passbook.ladder.allowed_ltv_bps, price_cents: quote.price_cents, fee_estimate: fee, collateral_sats: collateral, btc_available: available }
  }

  async findOffer(opts: { lenderPk?: Hex; principal: Micro; timeoutMs?: number }): Promise<Offer> {
    const deadline = Date.now() + (opts.timeoutMs ?? 20_000)
    while (Date.now() < deadline) {
      const { offers } = await this.platform.orderbook()
      const fit = offers.find((o) => (!opts.lenderPk || o.lender_pk === opts.lenderPk) && o.payload.asset_id === this.assetId && o.payload.min <= opts.principal && o.payload.max >= opts.principal)
      if (fit) {
        await this.say('Offer found in the order book', { offer_id: fit.id.slice(0, 20), apr: `${fit.payload.apr_bps / 100}%`, requirements: fit.payload.requirements })
        return fit
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error('no matching offer appeared in the order book')
  }

  /** The wallet's history as the laptop borrower builds it (src/networks/rgb.ts), from this phone's rgb-lib. */
  /**
   * The seeded test persona's observer proof and income records, only when the proof is about this
   * wallet's key and this asset (the phone runs the persona's words); otherwise none.
   */
  private persona(): PersonaRecord | null {
    return eligiblePersona(this.state.persona, this.pubkey, this.assetId)
  }

  private async history() {
    const transfers: RgbTransferRow[] = await this.rgb.transfers(this.assetId)
    return rgbHistoryRows({ wallet: { transfers: () => transfers }, assetId: this.assetId, chain: this.chain, inflows: this.persona()?.inflows ?? [], labels: this.state.labels })
  }

  /** `aprBps`: the negotiated APR, so the bundle's loan request is the loan the check binds (v2). */
  async buildSandboxBundle(offer: Offer, principal: Micro, aprBps = offer.payload.apr_bps): Promise<Bundle> {
    const passbook = await verifyPassbook(await this.passbookDocument(), this.chain)
    const quote = await this.platform.quote()
    const persona = this.persona()
    const fee = termInterest({ principal, apr_bps: aprBps, term_blocks: offer.payload.term_blocks })
    return {
      v: 1,
      borrower_pk: this.pubkey,
      own_pks: [],
      offer_id: offer.id,
      loan_request: { principal, fee, term_blocks: offer.payload.term_blocks, grace_blocks: offer.payload.grace_blocks },
      lender_requirements: offer.payload.requirements,
      balance: (await this.rgb.balance(this.assetId)).settled,
      history: await this.history(),
      asset_id: this.assetId,
      // the observer's proof as issued (seeded test persona only): scorer reconciles this history against it
      ...(persona ? { history_proof: persona.history_proof } : {}),
      // a phone wallet has no payer-signed inflow records of its own; the seeded persona carries the ones it was seeded with
      candidate_inflows: (persona?.inflows ?? []).map(({ memo: _memo, ...c }) => c),
      // only what the borrower declares: a seeded persona's own outflows, never an invented default (the laptop
      // borrower's 900-a-month rent belongs to its own personas, who earn 1,000 a month)
      scheduled_outflows: (persona?.declared_outflows ?? []).map((o) => ({ ...o, next_height: quote.height + 10 })),
      collateral: { sats: collateralFor(principal + fee, passbook.ladder.allowed_ltv_bps, quote.price_cents), oracle_quote: quote, allowed_ltv_bps: passbook.ladder.allowed_ltv_bps },
    }
  }

  /**
   * Bundle built on the phone from its own wallet history, with a consent receipt signed on the
   * phone (src/scorer/consent.ts): what the data is for (this offer), the only scorer that may
   * read it, the only lender that gets the result, the categories sent, zero retention, 6 hours.
   * NIP-44 encrypted to the sandbox key in the worklet; only the signed result comes back, and
   * it must commit to this bundle and this receipt.
   */
  async runSandbox(offer: Offer, principal: Micro): Promise<{ result: SandboxResult; attestation: Attestation; bundle_hash: Hex; consent: ConsentReceipt }> {
    const { sandbox_pk, attestation } = await this.platform.sandboxPubkey()
    const bundle = await this.buildSandboxBundle(offer, principal)
    const now = Math.floor(Date.now() / 1000)
    const consent = await this.key.signObject({
      v: 1 as const, domain: 'passbook-consent-v1' as const, borrower_pk: this.pubkey, retention: 'none' as const,
      purpose: `credit check for offer ${offer.id.slice(0, 24)}`, purpose_id: offer.id,
      scorer_id: sandboxScorerId(sandbox_pk, attestation.image_digest), scorer_pk: sandbox_pk,
      contract_hash: hashObject(scoringContract), lender_pk: offer.lender_pk,
      data_categories: bundleCategories(bundle), issued_at: now, expires_at: now + 6 * 3600,
    }) as ConsentReceipt
    const sent = { ...bundle, consent }
    const ciphertext = await this.key.nip44Encrypt(sandbox_pk, JSON.stringify(sent))
    await this.say('Bundle encrypted to the sandbox key and submitted', { rows: bundle.history.length, bytes: ciphertext.length, sandbox_pk: sandbox_pk.slice(0, 12), consent: consentHash(consent).slice(0, 12) })
    const result = await this.platform.submitToSandbox(this.pubkey, ciphertext)
    if (result.bundle_hash !== hashObject(sent)) throw new Error('sandbox result is not about our bundle')
    if (result.consent_hash !== consentHash(consent)) throw new Error('sandbox result does not commit to our consent receipt')
    await this.say('Sandbox result received', { checks: result.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}`), proposal: result.disclosure_proposal.length, consent_hash: result.consent_hash?.slice(0, 12) })
    return { result, attestation, bundle_hash: result.bundle_hash, consent }
  }

  /** The person approves proposed items only (a phone wallet has no payer-signed inflows, so usually none). */
  approve(result: SandboxResult, chosen: Hex[] = []): Hex[] {
    const proposed = new Set(result.disclosure_proposal.map((i: DisclosureItem) => i.txid))
    return chosen.filter((t) => proposed.has(t))
  }

  async apply(offer: Offer, principal: Micro, s: { result: SandboxResult; attestation: Attestation; consent?: ConsentReceipt }, approved: Hex[]): Promise<void> {
    if (!s.result.lender_result) throw new Error('sandbox must provide a separately signed lender result')
    if (approved.length) throw new Error('this phone holds no payer proofs to disclose')
    // only loans whose collateral is locked and not yet released are debt; accepted terms that were never locked are not
    const outstanding = Object.values(this.state.loans).filter((l) => l.lock && !l.release_txid).reduce((sum, l) => sum + debtOf(l.terms), 0)
    const app: ApplicationPayload = {
      offer_id: offer.id,
      principal,
      term_blocks: offer.payload.term_blocks,
      sandbox_result: s.result.lender_result,
      attestation: s.attestation,
      disclosed_inflows: [],
      disclosure_items: [],
      inflow_proofs: [],
      passbook: await this.passbookDocument(),
      outstanding_statement: { outstanding_micro: outstanding, sig: await this.key.signPassbookHash(hashObject({ outstanding_micro: outstanding })) },
      ...(s.consent ? { consent: s.consent } : {}),
    }
    await this.relay.send(KIND.APPLICATION, app, offer.lender_pk)
    await this.say('Application sent to the lender (NIP-44)', { lender: offer.lender_pk.slice(0, 12) })
  }

  /**
   * Negotiated origination, as src/agents/borrower.ts applyChecked builds it (the lender's
   * reviewChecked): the signed transcript ending in ACCEPT, the consent the operator signed into the
   * commitment, and the hash of the KEY message the lender forwarded; the lender paid for the check
   * on its own rail, so no sandbox result, attestation or disclosure travels.
   */
  async applyNegotiated(offer: Offer, principal: Micro, n: { negotiation: NegotiationMessage[]; consent: ConsentReceipt; check_key: Hex }): Promise<void> {
    const outstanding = Object.values(this.state.loans).filter((l) => l.lock && !l.release_txid).reduce((sum, l) => sum + debtOf(l.terms), 0)
    const app: ApplicationPayload = {
      offer_id: offer.id,
      principal,
      term_blocks: offer.payload.term_blocks,
      sandbox_result: null,
      attestation: null,
      // the KEY message the lender forwarded, by hash: the lender takes the check only from that message
      check_key: n.check_key,
      disclosed_inflows: [],
      passbook: await this.passbookDocument(),
      outstanding_statement: { outstanding_micro: outstanding, sig: await this.key.signPassbookHash(hashObject({ outstanding_micro: outstanding })) },
      negotiation: n.negotiation,
      consent: n.consent,
    }
    await this.relay.send(KIND.APPLICATION, app, offer.lender_pk)
    await this.say('Application sent to the lender (NIP-44) naming the forwarded check', { lender: offer.lender_pk.slice(0, 12), key_message: n.check_key.slice(0, 12), negotiation: n.negotiation[0]?.negotiation_id.slice(0, 12), messages: n.negotiation.length })
  }

  /** The sheet against the agreement, the check this phone opened and the lender's own signed policy; every problem, none means it may be approved. */
  sheetProblems(t: LoanTerms, payload: AcceptancePayload, n: NegotiatedAcceptance): string[] {
    const sheet = payload.termsheet
    if (!sheet) return ['no term sheet for a negotiated loan']
    const problems: string[] = []
    const sheetProblems = termSheetProblems(sheet, { agreed: n.agreed, accept_hash: n.accept_hash })
    if (sheetProblems.length || !sheet.signatures.lender) return [`term sheet: ${sheetProblems.join('; ') || 'not signed by the lender'}`]
    if (termSheetHash(sheet) !== payload.terms_hash || hashObject(sheet.terms) !== hashObject(t)) problems.push('term sheet does not hash to these terms')
    if (n.check) {
      const e = sheet.scorer.evidence, c = n.check
      if (!e) problems.push('term sheet: no scorer evidence digest')
      if (!c.outcome) problems.push('term sheet: the signed check outcome is missing')
      if (c.recommendation !== null && sheet.scorer.recommendation !== c.recommendation) problems.push('term sheet: names another recommendation than the check released')
      // the phone holds no RGB check receipt, so the sheet names none (awaitAcceptance with receipt_contract_id null)
      if (sheet.scorer.check_receipt !== undefined) problems.push('term sheet: names a check receipt this phone does not hold')
      if (c.outcome) {
        // the sheet names exactly the envelope and result released to this phone (the evidence digest the lock commits)
        problems.push(...termSheetEvidenceProblems(sheet, c.outcome).map((p) => `term sheet: ${p}`))
        problems.push(...scoredSheetProblems(sheet, c.outcome).map((p) => `term sheet: ${p}`))
        if (sheet.scorer.provider !== c.outcome.descriptor.provider || sheet.scorer.fallback !== c.outcome.fallback) problems.push('term sheet: names another scorer than the one that checked us')
      }
    }
    // The authenticated ASK commits to the policy in the lender's public offer. The lender may
    // ACCEPT it immediately, without sending an OFFER; that signature binds the ASK's hash.
    // When an OFFER is present, it must name the same policy as the ASK.
    const policy = payload.lender_policy
    const ask = n.messages[0]
    const rounds = ask?.body?.max_rounds
    let named: Hex | null = null
    try {
      if (ask?.type === 'ASK' && ask.from_pk === t.borrower_pk && ask.body.lender_pk === t.lender_pk && isHex(ask.body.lender_policy_hash, 32) && Number.isSafeInteger(rounds) && (rounds as number) >= 1 && (rounds as number) <= 10) {
        const transcript = verifyTranscript(n.messages, { borrower_pk: t.borrower_pk, lender_pk: t.lender_pk, max_rounds: rounds as number })
        const consistent = n.messages.filter((m) => m.type === 'OFFER').every((m) => m.from_pk === t.lender_pk && m.body.policy_hash === ask.body.lender_policy_hash)
        if (transcript.ok && transcript.agreed && transcript.accept_hash === n.accept_hash && hashObject(transcript.agreed) === hashObject(n.agreed) && sheet.negotiation.id === ask.negotiation_id && consistent) named = ask.body.lender_policy_hash
      }
    } catch { /* malformed transcript: refuse the policy binding */ }
    if (!policy || policy.kind !== 'passbook-lender-policy' || policy.owner_pk !== t.lender_pk || !verifyObject(policy, policy.owner_pk) || !named || hashObject(policy) !== named) problems.push('lender policy missing or not the one the signed negotiation named')
    else {
      const s = approvalStatus(sheet, payload.lender_approvals ?? [], policy, n.maker_checker_above_micro)
      if (s.lender_approvers.length < s.required_lender_approvals || s.problems.length) problems.push(`lender approvals incomplete: ${s.lender_approvers.length}/${s.required_lender_approvals}${s.problems.length ? ` (${s.problems.join(', ')})` : ''}`)
    }
    if (!(payload.lender_approvals ?? []).some((a) => a.approver_pk === t.lender_pk && a.role === 'lender' && a.termsheet_hash === payload.terms_hash && verifyObject(a, a.approver_pk))) problems.push('no lender approval of this term sheet')
    return problems
  }

  /** The phone's accept stop, after its lock: countersign exactly this sheet and approve its hash, both with the party key. */
  async approveTermSheet(loanId: Hex, approvedAt = Math.floor(Date.now() / 1000)): Promise<Approval> {
    const l = this.loan(loanId)
    if (!l.termsheet) throw new Error('this loan has no term sheet to approve')
    if (l.borrower_approval) return l.borrower_approval
    const hash = termSheetHash(l.termsheet)
    if (hash !== loanId) throw new Error('the term sheet does not hash to this loan')
    const sheet: TermSheet = { ...l.termsheet, signatures: { ...l.termsheet.signatures, borrower: await this.key.signPassbookHash(hash) } }
    const approval = await this.key.signObject({ v: 1 as const, domain: 'passbook-approval-v1' as const, termsheet_hash: hash, approver_pk: this.pubkey, role: 'borrower' as const, approved_at: approvedAt }) as Approval
    l.termsheet = sheet
    l.borrower_approval = approval
    await this.save()
    await this.say('Term sheet countersigned and approved on the phone', { loan_id: loanId.slice(0, 12) })
    return approval
  }

  /** The lender's terms, checked on the phone against what was asked and what the chain allows (src/agents/borrower.ts awaitAcceptance, v1). */
  async awaitAcceptance(offer: Offer, principal: Micro, timeoutMs = 120_000, negotiated?: NegotiatedAcceptance): Promise<{ loan_id: Hex; terms: LoanTerms }> {
    const { payload } = await this.relay.receive<AcceptancePayload>(KIND.ACCEPTANCE, offer.lender_pk, { match: (a) => a.offer_id === offer.id, timeoutMs })
    const t = payload.terms
    validateTerms(t)
    const problems: string[] = []
    if (t.v === 2) problems.push('atomic (v2) terms need an RGB Lightning node; this phone does on-chain RGB only')
    const state = await this.platform.state()
    const passbook = await verifyPassbook(await this.passbookDocument(), this.chain)
    const lastClose = [...passbook.pages].reverse().find((p) => p.verified.close && p.close_txid)?.close_txid ?? null
    if (termsHash(t) !== payload.terms_hash) problems.push('terms hash')
    if (t.borrower_pk !== this.pubkey || t.lender_pk !== offer.lender_pk || t.platform_pk !== state.platform_pk) problems.push('keys')
    if (t.principal !== principal || t.asset_id !== this.assetId) problems.push('amount or asset')
    if (t.maturity_height - t.open_height !== offer.payload.term_blocks) problems.push('term')
    if (t.ltv_bps > passbook.ladder.allowed_ltv_bps || ltvBps(debtOf(t), t.collateral_sats, t.oracle_quote.price_cents) > passbook.ladder.allowed_ltv_bps) problems.push('LTV above the earned ladder')
    if (!verifyQuote(t.oracle_quote, state.oracle_pk)) problems.push('oracle quote')
    if (t.prev_passbook_txid !== lastClose) problems.push('passbook chain')
    // the lender's band is at most +200 bps over the offer, or exactly the negotiated APR; fees compared, so cent rounding never rejects a fair price
    if (!feeWithinApr({ principal: t.principal, fee: t.fee, term_blocks: t.maturity_height - t.open_height }, negotiated ? negotiated.agreed.apr_bps : offer.payload.apr_bps + 200)) problems.push(`fee implies ${impliedAprBps(t) / 100}% APR`)
    if (negotiated) problems.push(...this.sheetProblems(t, payload, negotiated))
    const loan = await this.platform.loan(payload.terms_hash)
    if (loan.status !== 'pending') problems.push(`loan is ${loan.status}`)
    if (problems.length) throw new Error(`terms rejected: ${problems.join(', ')}`)
    this.state.loans[payload.terms_hash] = {
      terms: t, lender_pk: offer.lender_pk, accepted_at: Math.floor(Date.now() / 1000),
      ...(negotiated && payload.termsheet ? { termsheet: payload.termsheet, lender_approvals: payload.lender_approvals, lender_policy: payload.lender_policy, lender_decisions: lenderDecisions(payload, payload.terms_hash) } : {}),
    }
    await this.save()
    await this.say('Terms checked and accepted', { loan_id: payload.terms_hash.slice(0, 12), fee: usdt(t.fee), ltv: `${t.ltv_bps / 100}%`, collateral: btc(t.collateral_sats), maturity: t.maturity_height })
    return { loan_id: payload.terms_hash, terms: t }
  }

  /** What the phone shows before the person signs: the default split's payouts, from the shared escrow code. */
  splitPreview(loanId: Hex): { lender_sats_on_default: number; borrower_sats_on_default: number; locktime: number } {
    const t = this.loan(loanId).terms
    const outputs = splitOutputs(t)
    return { lender_sats_on_default: outputs[0].value, borrower_sats_on_default: outputs[1]?.value ?? 0, locktime: splitLocktime(t) }
  }

  /** Lock the collateral (key path, signed in the worklet), then sign the default split (leaf A) and hand it to the lender with a witness invoice. */
  async lockAndSplit(loanId: Hex): Promise<{ lock_txid: Hex; split_txid: Hex }> {
    const l = this.loan(loanId)
    const t = l.terms
    if (l.termsheet && !l.borrower_approval) throw new Error('approve the term sheet before locking collateral')
    // a lock that already exists (or was signed and maybe broadcast) is resumed, never doubled
    const lockTxid = l.lock?.txid ?? (l.lock_pending ? await this.rebroadcast(l.lock_pending) : await this.buildAndBroadcastLock(loanId))
    if (!l.lock) {
      await this.waitConfirmed(lockTxid)
      try { await this.platform.recordLock(loanId, lockTxid) } catch (e) { await this.say('Index warning: lock', { warning: (e as Error).message }) }
      l.lock = { txid: lockTxid, vout: 0 }
      delete l.lock_pending
      await this.savePassbookPage(loanId)
      await this.say('Collateral locked with the terms hash in OP_RETURN', { lock_txid: lockTxid.slice(0, 12), collateral: btc(t.collateral_sats) })
    }

    const parties = partiesOf(t)
    const split = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: t.collateral_sats }, parties, leaf: 'A', outputs: splitOutputs(t), locktime: splitLocktime(t) })
    const { signature } = await this.key.signEscrowLeaf(split.toBase64())
    addLeafSignature(split, parties, 'A', 'borrower', signature)
    if (!l.disbursement_invoice || !l.disbursement_recipient_id) {
      const invoice = await this.rgb.witnessInvoice(t.principal, this.assetId)
      l.disbursement_invoice = invoice.invoice
      l.disbursement_recipient_id = invoice.recipientId
      await this.save()
    }
    const req: SignRequestPayload = { purpose: 'split', loan_id: loanId, psbt_base64: split.toBase64(), terms_hash: loanId, disbursement_invoice: l.disbursement_invoice, ...(l.termsheet && l.borrower_approval ? { termsheet: l.termsheet, borrower_approval: l.borrower_approval } : {}) }
    await this.relay.send(KIND.SIGN_REQUEST, req, l.lender_pk)
    await this.say('Default split signed and handed to the lender', { locktime: splitLocktime(t) })
    return { lock_txid: lockTxid, split_txid: unsignedTxid(split) }
  }

  /** The same signed lock again (a broadcast that may have failed): its txid either way. */
  private async rebroadcast(p: { txid: Hex; hex: Hex }): Promise<Hex> {
    try { await this.chain.broadcast(p.hex) } catch { /* already in the mempool or a block, or retried later */ }
    return p.txid
  }

  /** Build, sign and broadcast the lock; the signed lock is saved before it leaves the phone. */
  private async buildAndBroadcastLock(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    const t = l.terms
    const utxos = (await this.btcUtxos()).filter((u) => u.height > 0)
    const inputs: KeyPathUtxo[] = []
    if (t.prev_passbook_txid) {
      const prev = utxos.find((u) => u.txid === t.prev_passbook_txid)
      if (!prev) throw new Error('the previous release output is not in our UTXO set')
      inputs.push({ txid: prev.txid, vout: prev.vout, value: prev.value, internal_pk: this.pubkey })
    }
    const need = t.collateral_sats + TX_FEE_SATS
    for (const u of utxos.sort((a, b) => b.value - a.value)) {
      if (inputs.reduce((s, x) => s + x.value, 0) >= need) break
      if (!inputs.some((x) => x.txid === u.txid && x.vout === u.vout)) inputs.push({ txid: u.txid, vout: u.vout, value: u.value, internal_pk: this.pubkey })
    }
    const lock = buildLock({ inputs, terms: t, changeScript: this.key.btc.script })
    const signedLock = psbtFromBase64(await this.key.signKeyPath(lock.toBase64()))
    signedLock.finalizeAllInputs()
    const hex = extractHex(signedLock)
    const txid = signedLock.extractTransaction().getId()
    l.lock_pending = { txid, hex }
    await this.save()
    await this.chain.broadcast(hex)
    return txid
  }

  async awaitFunding(loanId: Hex, timeoutMs = 180_000): Promise<Hex> {
    const l = this.loan(loanId)
    if (!l.lock || !l.disbursement_invoice || !l.disbursement_recipient_id) throw new Error('no locked collateral and disbursement invoice for this loan')
    const { payload } = await this.relay.receive<FundedPayload>(KIND.FUNDED, l.lender_pk, { match: (f) => f.loan_id === loanId, timeoutMs })
    await this.waitConfirmed(payload.disbursement_txid)
    const lock = await this.chain.getTx(l.lock.txid)
    const funding = await this.chain.getTx(payload.disbursement_txid)
    if (!lock?.height || !funding?.height || funding.height <= lock.height) throw new Error('funding witness must confirm after this loan collateral lock')
    const t = await this.awaitTransfer(this.assetId, payload.disbursement_txid, 'ReceiveWitness')
    if (t.recipientId !== l.disbursement_recipient_id) throw new Error('funding does not settle this loan disbursement invoice')
    if (t.amount !== l.terms.principal) throw new Error(`received ${usdt(t.amount)}, expected ${usdt(l.terms.principal)}`)
    const record = await this.platform.loan(loanId)
    if (!payload.repayment_invoice || record.repayment_watch?.invoice !== payload.repayment_invoice) throw new Error('the repayment invoice is not the one the platform issued for this loan')
    l.disbursement_txid = payload.disbursement_txid
    l.repayment_invoice = payload.repayment_invoice
    this.state.labels[payload.disbursement_txid] = { counterparty_pk: l.lender_pk, memo: 'loan disbursement' }
    await this.save()
    if (payload.iou_invoice) l.iou = await this.issueIou(loanId, payload.iou_invoice)
    await this.say('USDT received over RGB; loan open', { txid: payload.disbursement_txid.slice(0, 12), amount: usdt(t.amount) })
    return payload.disbursement_txid
  }

  /** PB-IOU (src/agents/iou-desk.ts issue): issue the note on the phone, send it to the lender, sign the certificate. */
  private async issueIou(loanId: Hex, invoice: string): Promise<IouCertificate> {
    const l = this.loan(loanId)
    const amount = debtOf(l.terms)
    const asset_id = await this.rgb.issueNia({ ticker: 'PBIOU', name: `PB-IOU ${loanId.slice(0, 16)}`, precision: 6, amount })
    const sent = await this.rgb.send({ invoice, assetId: asset_id, amount })
    await this.waitConfirmed(sent.txid)
    await this.awaitTransfer(asset_id, sent.txid, 'Send')
    const certificate = await this.key.signObject({ domain: 'passbook-iou-v1' as const, loan_id: loanId, asset_id, amount, issuer_pk: this.pubkey, initial_holder_pk: l.terms.lender_pk, issuance_transfer_txid: sent.txid, lock_txid: l.lock!.txid, lock_vout: l.lock!.vout }) as IouCertificate
    await this.relay.send(KIND.NOTE_ISSUED, { certificate }, l.terms.lender_pk)
    await this.say('PB-IOU issued and transferred over RGB', { asset_id, txid: sent.txid.slice(0, 12), amount, endpoint: sent.endpoint ?? null })
    l.iou = certificate
    await this.save()
    return certificate
  }

  /** Pay principal + fee to the platform-watched invoice, from the phone's RGB wallet. */
  /**
   * Repay once, whatever fails along the way: the txid is saved the moment the send returns; a
   * send that failed after signing (it may be on the network) is kept as repay_pending and
   * resolved before any new payment; a repayment made but not yet reported is reported.
   */
  async repay(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (l.release_txid) throw new Error('loan was already repaid and released')
    const debt = debtOf(l.terms)
    let txid = l.repayment_txid
    if (!txid) {
      if (!l.repayment_invoice) throw new Error('no repayment invoice from the lender')
      if (l.repay_pending) txid = await this.resolvePending(l.repay_pending.txid) ?? undefined
      if (!txid) {
        delete l.repay_pending
        try {
          const sent = await this.rgb.send({ invoice: l.repayment_invoice, assetId: this.assetId, amount: debt })
          txid = sent.txid
          await this.say('Repayment consignment posted', { txid: txid.slice(0, 12), endpoint: sent.endpoint ?? null })
        } catch (e) {
          const amb = parseAmbiguous((e as Error).message)
          if (amb) { l.repay_pending = { txid: amb.txid as Hex }; await this.save() }
          throw e
        }
      }
      l.repayment_txid = txid
      delete l.repay_pending
      this.state.labels[txid] = { counterparty_pk: l.lender_pk, memo: 'loan repayment' }
      await this.save()
    }
    await this.waitConfirmed(txid)
    await this.awaitTransfer(this.assetId, txid, 'Send')
    if (!l.repaid_sent) {
      const msg: RepaidPayload = { loan_id: loanId, repayment_txid: txid, note_return_invoice: l.iou ? (await this.rgb.witnessInvoice(debt, l.iou.asset_id)).invoice : undefined }
      await this.relay.send(KIND.REPAID, msg, l.lender_pk)
      l.repaid_sent = true
      await this.save()
      await this.say('Repaid over RGB', { txid: txid.slice(0, 12), amount: usdt(debt) })
    }
    return txid
  }

  /**
   * An earlier signed send of uncertain fate: its txid if it is on the network, null if rgb-lib
   * has it as Failed (cancelled: safe to send anew); otherwise refuse until it can be told.
   */
  private async resolvePending(txid: Hex): Promise<Hex | null> {
    const st = await this.rgb.status(txid)
    if (st.state === 'broadcast') return txid
    if (st.rgbStatus === 'Failed') return null
    throw new Error(st.state === 'not-seen'
      ? 'The earlier payment is not on the network yet. If it never left this phone, cancel it in Wallet health, then pay again.'
      : "Can't tell yet whether the earlier payment went out. Try again in a moment.")
  }

  async awaitIouReturn(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (!l.iou) throw new Error('no IOU issued')
    const iou = l.iou
    const { payload } = await this.relay.receive<{ loan_id: Hex; asset_id: string; txid: Hex }>(KIND.NOTE_RETURNED, l.lender_pk, { match: (p) => p.loan_id === loanId && p.asset_id === iou.asset_id, timeoutMs: 180_000 })
    await this.waitConfirmed(payload.txid)
    const received = await this.awaitTransfer(iou.asset_id, payload.txid, 'ReceiveWitness')
    if (received.amount !== debtOf(l.terms)) throw new Error('returned IOU is incomplete')
    return payload.txid
  }

  /** Sign the release (leaf A) on the phone, get the lender's signature over Nostr, finalize with the shared code, broadcast. */
  async release(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (!l.lock) throw new Error('not locked')
    const parties = partiesOf(l.terms)
    const psbt = buildEscrowSpend({ escrow: { ...l.lock, value: l.terms.collateral_sats }, parties, leaf: 'A', outputs: releaseOutputs(l.terms) })
    const { signature } = await this.key.signEscrowLeaf(psbt.toBase64())
    addLeafSignature(psbt, parties, 'A', 'borrower', signature)
    const req: SignRequestPayload = { purpose: 'release', loan_id: loanId, psbt_base64: psbt.toBase64(), terms_hash: loanId }
    await this.relay.send(KIND.SIGN_REQUEST, req, l.lender_pk)
    let payload: SignaturePayload
    try {
      ;({ payload } = await this.relay.receive<SignaturePayload>(KIND.SIGNATURE, l.lender_pk, { match: (s) => s.loan_id === loanId, timeoutMs: 90_000 }))
    } catch (error) {
      if (!/timed out waiting/.test((error as Error).message)) throw error
      await this.say('Lender did not answer; asking the platform to validate the repayment')
      return this.releaseWithPlatform(loanId)
    }
    if ('refused' in payload) {
      await this.say('Lender refused the release; asking the platform to validate the repayment', { reason: payload.refused })
      return this.releaseWithPlatform(loanId)
    }
    addLeafSignature(psbt, parties, 'A', 'lender', payload.signature)
    finalizeEscrowSpend(psbt, parties, 'A')
    const txid = await this.chain.broadcast(extractHex(psbt))
    await this.waitConfirmed(txid)
    try { await this.platform.recordRelease(loanId, txid) } catch (e) { await this.say('Index warning: release', { warning: (e as Error).message }) }
    l.release_txid = txid
    l.repayment_receipt = payload.repayment_receipt
    await this.savePassbookPage(loanId, l.repayment_receipt ? { kind: 'rgb_receipt', receipt: l.repayment_receipt } : undefined, 'repaid')
    await this.say('Collateral released; passbook page stamped', { release_txid: txid.slice(0, 12) })
    return txid
  }

  /** Without the lender: the platform validates the RGB repayment and co-signs leaf C; the phone adds its own signature. */
  async releaseWithPlatform(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (!l.lock || !l.repayment_txid) throw new Error('nothing repaid yet')
    const proof = await this.platform.verifyRepayment(loanId, l.repayment_txid)
    if (!proof.ok) throw new Error(`repayment not validated: ${proof.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
    const parties = partiesOf(l.terms)
    const psbt = buildEscrowSpend({ escrow: { ...l.lock, value: l.terms.collateral_sats }, parties, leaf: 'C', outputs: releaseOutputs(l.terms) })
    const decision = await this.platform.cosign({ loan_id: loanId, purpose: 'release', psbt: psbt.toBase64(), repayment_txid: l.repayment_txid })
    if (!decision.ok || !decision.psbt) throw new Error(`platform refused the release: ${decision.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
    const signed = psbtFromBase64(decision.psbt)
    if (unsignedTxid(signed) !== unsignedTxid(psbt)) throw new Error('the platform returned a different transaction')
    const { signature } = await this.key.signEscrowLeaf(signed.toBase64())
    addLeafSignature(signed, parties, 'C', 'borrower', signature)
    finalizeEscrowSpend(signed, parties, 'C')
    const txid = await this.chain.broadcast(extractHex(signed))
    await this.waitConfirmed(txid)
    try { await this.platform.recordRelease(loanId, txid) } catch { /* index only */ }
    l.release_txid = txid
    await this.savePassbookPage(loanId, proof.receipt ? { kind: 'rgb_receipt', receipt: proof.receipt as RgbRepaymentReceipt } : undefined, 'repaid')
    await this.say('Collateral released through leaf C with the platform; passbook page stamped', { release_txid: txid.slice(0, 12) })
    return txid
  }

  /** Wait (the laptop mines on regtest) until a transaction has one confirmation. */
  async waitConfirmed(txid: Hex, timeoutMs = 120_000): Promise<number> {
    if (!isHex(txid, 32)) throw new Error('bad txid')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const tx = await this.chain.getTx(txid)
      if (tx?.height) return tx.height
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(`transaction ${txid.slice(0, 12)} did not confirm in ${Math.round(timeoutMs / 1000)} s (is the laptop mining?)`)
  }

  /** Refresh the phone's RGB wallet until its transfer for `txid` is Settled. */
  async awaitTransfer(assetId: string, txid: Hex, kind: string, timeoutMs = 120_000): Promise<RgbTransferRow> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await this.rgb.refresh(null)
      const t = (await this.rgb.transfers(assetId)).find((x) => x.txid === txid && x.kind === kind)
      if (t?.status === 'Settled') return t
      if (t?.status === 'Failed') throw new Error(`RGB transfer ${txid.slice(0, 12)} failed`)
      await new Promise((r) => setTimeout(r, 2500))
    }
    throw new Error(`RGB transfer ${txid.slice(0, 12)} did not settle in ${Math.round(timeoutMs / 1000)} s`)
  }
}
