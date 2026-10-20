// A check node: the credit check as a role any laptop can run. It publishes an
// Offer on the relay, answers REQUESTs with a sealed result and an invoice,
// and hands over K when paid. It keeps nothing about the borrower after
// answering (retention 0): the public log holds hashes and statuses only.

import type { Hex, KeyPair } from '../core/crypto.js'
import { isHex, verifyObject } from '../core/crypto.js'
import { KIND } from '../market/kinds.js'
import { publicJson, type Event } from '../market/messages.js'
import { consentHash, type ConsentReceipt } from '../scorer/consent.js'
import { declareScorer } from '../scorer/providers.js'
import type { EncryptedCheckRequest, ScorerDescriptor } from '../scorer/types.js'
import { chunkedBus, type CheckBus } from './bus.js'
import type { CheckEngine } from './engine.js'
import { appendCheckMessage, CHECK_EVENT_KIND, checkMessageHash, type CheckMessage } from './messages.js'
import { offerHash, releaseHash, scorerFromDescriptor, signOffer, type CheckAsset, type CheckOffer, type CheckRail, type DeliveryRail, type UnsignedOffer } from './offer.js'
import { billHash, signBill, type BilledCheckReceipt } from './bill.js'
import { RAIL_LABEL, type LightningCheckRail, type OperatorRail } from './rail.js'
import { freshKey, keyHash, plaintextCommitment, seal, sealedHash, signCommitment, type CheckCommitment, type CheckPlaintext, type SealedResult } from './seal.js'
import { receiptEvidenceDigest } from './receipt.js'

export interface RequestBody {
  offer_hash: Hex
  request_nonce: Hex
  consent: ConsentReceipt
  check_request: EncryptedCheckRequest
  rail: DeliveryRail
  pay_with: string
  payer: 'borrower' | 'lender'
  /** Optional: the borrower's RGB invoice for the check receipt (a UDA, hashes only). */
  receipt_invoice?: string
}

/** A TEE node's fresh evidence for this result: an attestation whose report data is the commitment's, and result_key's signature over the plaintext commitment. */
export interface ResultTeeEvidence { attestation: string; result_sig: Hex }

export type FeedbackBody =
  | { status: 'payment-required'; commitment: CheckCommitment; sealed: SealedResult; rail_label: string; tee?: ResultTeeEvidence }
  /** bill-at-close: the same commitment and sealed result; the RESULT with K follows at once, with the operator's bill. */
  | { status: 'billed'; commitment: CheckCommitment; sealed: SealedResult; rail_label: string; tee?: ResultTeeEvidence }
  | { status: 'consent-required'; draft: unknown }
  | { status: 'error'; reason: string }

export type ResultBody =
  | { status: 'settled'; key: Hex; payment_hash: Hex; rail_label: string }
  /** bill-at-close: K at once, and the operator's signed bill, due at close (bill.ts). */
  | { status: 'billed'; key: Hex; bill: BilledCheckReceipt; rail_label: string }

/** What the dashboard shows about a handled check: no bundle, no outputs, no personal data. */
export interface CheckLogEntry {
  negotiation_id: Hex
  status: 'refused' | 'awaiting-payment' | 'paid' | 'unpaid' | 'billed' | 'undelivered'
  reason?: string
  commitment?: Hex
  payment_hash?: Hex
  rail?: DeliveryRail
  /** bill-at-close: the bill's hash (the fee is due at close) */
  bill_hash?: Hex
  paid_with?: string
  at: number
}

export interface PaidCheck { negotiation_id: Hex; commitment: CheckCommitment; borrower_pk: Hex; envelope_digest: Hex; paid_with: CheckAsset; receipt_invoice?: string }

/** What a node needs to run lenders' checks on credit (bill-at-close). */
export interface CheckBilling {
  /** Bills per lender key in 24 h: the provider's exposure to checks that never become loans. */
  maxPerDay: number
  /** How long a bill waits for a loan to close (then the provider absorbs it). */
  ttlSeconds: number
  ledger: { countSince(lenderPk: Hex, sinceUnix: number): number; append(bill: BilledCheckReceipt): void }
  /** The platform's verdict on the lender's fees: a reason when it is blocked, null when not; throws when it can't tell. */
  feeGate(lenderPk: Hex): Promise<string | null>
}

export interface CheckNodeOptions {
  operator: KeyPair
  engine: CheckEngine
  bus: CheckBus
  /** One per rail the node offers. */
  rails: Partial<Record<LightningCheckRail, OperatorRail>>
  assets: CheckAsset[]
  payerModes?: ('borrower' | 'lender')[]
  p50Seconds?: number
  maxBundleBytes?: number
  offerTtlSeconds?: number
  invoiceExpirySeconds?: number
  paymentTimeoutMs?: number
  /** external provider: how long the node waits for the borrower's APPROVE. */
  approvalTimeoutMs?: number
  lnNodePubkey?: string
  execution?: CheckOffer['execution']
  /** A TEE node only: produces the fresh attestation for one result (report data = commitment.report_data) and signs commitment.commitment with result_key. */
  attestResult?: (c: { report_data: Hex; commitment: Hex }) => Promise<ResultTeeEvidence>
  /** bill-at-close: the node runs a lender's check on credit and signs a bill due at close (bill.ts). Absent: not offered. */
  billing?: CheckBilling
  /** Called once a check is paid, e.g. to send the UDA receipt. Errors are logged, never fatal. */
  onPaid?: (paid: PaidCheck) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

export class CheckNode {
  readonly log: CheckLogEntry[] = []
  private offer: CheckOffer
  private stopped = false
  /** bill-at-close: checks running on credit per lender key, reserved with the rate-limit check so concurrent requests cannot exceed it. */
  private readonly billsInFlight = new Map<Hex, number>()
  constructor(private readonly o: CheckNodeOptions) {
    this.offer = this.buildOffer()
  }

  /** The relay, with large messages chunked under the public relays' size limit (wire.ts); one wrapper per bus. */
  private get bus(): CheckBus { return chunkedBus(this.o.bus) }

  /** The engine's descriptor, declared by this operator (a declaration, not an attestation). */
  descriptor(): ScorerDescriptor {
    const d = this.o.engine.descriptor()
    return (d.provider === 'container' || d.provider === 'in-process') ? declareScorer(this.o.operator, d) : d
  }

  private now(): number { return this.o.now?.() ?? Math.floor(Date.now() / 1000) }
  private say(line: string) { (this.o.log ?? (() => {}))(line) }

  buildOffer(): CheckOffer {
    const payment = this.o.assets.find((a) => a.kind === 'payment')
    if (!payment) throw new Error('a check node needs a payment asset')
    const rails = (Object.keys(this.o.rails) as CheckRail[]).sort()
    const issued = this.now()
    const input: UnsignedOffer = {
      release: this.o.engine.release(),
      scorer: scorerFromDescriptor(this.descriptor()),
      execution: this.o.execution ?? { tee: 'none' },
      price: { asset_id: payment.asset_id, amount: payment.amount },
      accepted_assets: [payment, ...this.o.assets.filter((a) => a !== payment)],
      rails: this.o.billing ? [...rails, 'bill-at-close' as const].sort() : rails,
      // A lender-paid external provider check relays the borrower's own approval of the contract (borrower-check.ts).
      payer_modes: this.o.payerModes ?? ['borrower', 'lender'],
      p50_seconds: this.o.p50Seconds ?? 30,
      max_bundle_bytes: this.o.maxBundleBytes ?? 60_000,
      issued_at: issued,
      expires: issued + (this.o.offerTtlSeconds ?? 3600),
      ...(this.o.lnNodePubkey ? { ln_node_pubkey: this.o.lnNodePubkey } : {}),
    }
    return signOffer(this.o.operator, input)
  }

  currentOffer(): CheckOffer { return this.offer }

  /** Replaces the accepted assets (e.g. a voucher the node just issued) and re-signs the offer; publish it again after. */
  setAssets(assets: CheckAsset[]): CheckOffer {
    this.o.assets = assets
    this.offer = this.buildOffer()
    return this.offer
  }

  offerEvent(): Event {
    return publicJson(this.o.operator, KIND.CHECK_OFFER, this.offer, [['d', `${this.offer.service}`], ['expiration', String(this.offer.expires)]], this.offer.issued_at * 1000)
  }

  async publishOffer(): Promise<CheckOffer> {
    if (this.offer.expires - this.now() < 300) this.offer = this.buildOffer()
    await this.bus.publish(this.offerEvent())
    this.say(`offer ${offerHash(this.offer).slice(0, 12)}… published: ${this.o.engine.label}; release ${releaseHash(this.offer.release).slice(0, 12)}…; price ${this.offer.price.amount} of ${this.offer.price.asset_id.slice(0, 16)}…`)
    return this.offer
  }

  /** Why a REQUEST is refused; empty when the node will run it. */
  requestProblems(m: CheckMessage): string[] {
    const b = m.body as unknown as RequestBody
    const problems: string[] = []
    if (m.v !== 1 || m.domain !== 'passbook-check-v1' || m.type !== 'REQUEST' || m.seq !== 0 || m.prev_hash !== null || m.to_pk !== this.o.operator.pubkey || !verifyObject(m, m.from_pk)) return ['REQUEST_MALFORMED']
    if (!b || b.offer_hash !== offerHash(this.offer)) problems.push('OFFER_CHANGED')
    if (!isHex(b?.request_nonce, 32)) problems.push('REQUEST_NONCE')
    if (b?.rail === 'bill-at-close') {
      if (!this.o.billing || !this.offer.rails.includes('bill-at-close')) problems.push('BILL_NOT_OFFERED')
      else if (b.payer !== 'lender') problems.push('BILL_LENDER_ONLY')
    } else if (!b?.rail || !this.o.rails[b.rail]) problems.push('RAIL_NOT_OFFERED')
    if (!this.offer.accepted_assets.some((a) => a.asset_id === b?.pay_with)) problems.push('ASSET_NOT_ACCEPTED')
    if (!this.offer.payer_modes.includes(b?.payer)) problems.push('PAYER_MODE')
    const c = b?.consent
    if (!c || c.operator_pk !== this.o.operator.pubkey) problems.push('CONSENT_NAMES_ANOTHER_OPERATOR')
    else if (c.purpose_id !== m.negotiation_id) problems.push('CONSENT_OTHER_NEGOTIATION')
    else if (b.payer === 'borrower' && c.borrower_pk !== m.from_pk) problems.push('CONSENT_NOT_FROM_PAYER')
    else if (b.payer === 'lender' && c.lender_pk !== m.from_pk) problems.push('CONSENT_NOT_FOR_PAYER')
    // The consent names who pays and the exact release; a lender-paid request needs both.
    if (c && (c.payer !== undefined || b.payer === 'lender') && c.payer !== b.payer) problems.push('CONSENT_OTHER_PAYER')
    if (c && (c.release_hash !== undefined || b.payer === 'lender') && c.release_hash !== releaseHash(this.offer.release)) problems.push('CONSENT_OTHER_RELEASE')
    if (typeof b?.check_request?.ciphertext !== 'string' || b.check_request.ciphertext.length > Math.ceil(this.offer.max_bundle_bytes * 1.4)) problems.push('BUNDLE_TOO_LARGE')
    return problems
  }

  /** Answers one REQUEST end to end: run, seal, invoice, wait for payment, hand over K. */
  async handle(m: CheckMessage, from: Hex): Promise<CheckLogEntry> {
    const hold: { lender: Hex | null } = { lender: null }
    try {
      return await this.run(m, from, hold)
    } finally {
      // Release a reserved bill slot whatever happened; a delivered bill is in the ledger by now and counts there.
      if (hold.lender) {
        const n = (this.billsInFlight.get(hold.lender) ?? 1) - 1
        if (n > 0) this.billsInFlight.set(hold.lender, n)
        else this.billsInFlight.delete(hold.lender)
      }
    }
  }

  private async run(m: CheckMessage, from: Hex, hold: { lender: Hex | null }): Promise<CheckLogEntry> {
    const entry: CheckLogEntry = { negotiation_id: m.negotiation_id, status: 'refused', at: this.now() }
    this.log.push(entry)
    const chain: CheckMessage[] = [m]
    const reply = async (type: 'FEEDBACK' | 'RESULT', body: Record<string, unknown>) => {
      const msg = appendCheckMessage(chain, this.o.operator, from, type, body)
      await this.bus.send(CHECK_EVENT_KIND[type], msg, from, [['n', m.negotiation_id]])
      return msg
    }
    const refuse = async (reason: string) => {
      entry.reason = reason
      await reply('FEEDBACK', { status: 'error', reason }).catch(() => undefined)
      this.say(`check ${m.negotiation_id.slice(0, 8)} refused: ${reason}`)
      return entry
    }
    if (m.from_pk !== from) return refuse('REQUEST_MALFORMED')
    const problems = this.requestProblems(m)
    if (problems.length) return refuse(problems.join(','))
    const b = m.body as unknown as RequestBody
    // bill-at-close: the check runs on credit, so the lender must not be blocked for unpaid fees, and the
    // provider's exposure to checks that never become loans is limited per lender key. Fail closed.
    if (b.rail === 'bill-at-close') {
      const billing = this.o.billing!
      let blocked: string | null
      try { blocked = await billing.feeGate(m.from_pk) } catch { return refuse('BILL_FEE_STATUS_UNAVAILABLE') }
      if (blocked) return refuse('BILL_LENDER_BLOCKED')
      // Count and reserve in one synchronous step: handlers run concurrently (serve), and the scorer run is long.
      const inFlight = this.billsInFlight.get(m.from_pk) ?? 0
      if (billing.ledger.countSince(m.from_pk, this.now() - 86_400) + inFlight >= billing.maxPerDay) return refuse('BILL_RATE_LIMITED')
      this.billsInFlight.set(m.from_pk, inFlight + 1)
      hold.lender = m.from_pk
    }
    let plaintext: CheckPlaintext | null
    try {
      const approve = async (draft: unknown): Promise<Hex> => {
        // external provider: the borrower approves this exact contract version itself, over the check channel.
        await reply('FEEDBACK', { status: 'consent-required', draft })
        const prev = checkMessageHash(chain.at(-1)!)
        const a = await this.bus.receive<CheckMessage>(KIND.CHECK_REQUEST, from, { timeoutMs: this.o.approvalTimeoutMs ?? 120_000, match: (x) => x?.type === 'APPROVE' && x.negotiation_id === m.negotiation_id && x.prev_hash === prev })
        if (a.payload.from_pk !== from || a.payload.to_pk !== this.o.operator.pubkey || a.payload.seq !== chain.length || !verifyObject(a.payload, from)) throw new Error('APPROVAL_MALFORMED')
        chain.push(a.payload)
        return String((a.payload.body as { sig?: unknown }).sig ?? '')
      }
      const outcome = { ...await this.o.engine.run(b.check_request, b.consent, { operator: this.o.operator, approve }), descriptor: this.descriptor() }
      plaintext = { v: 1, kind: 'passbook-check-plaintext', negotiation_id: m.negotiation_id, request_nonce: b.request_nonce, consent_hash: consentHash(b.consent), outcome }
    } catch (err) {
      // Only coded reasons leave the node; bundle contents never appear in errors.
      const message = (err as Error).message
      return refuse(/^[A-Z_]+(:[A-Z_,]+)?$/.test(message.split(':').slice(0, 2).join(':')) ? message.slice(0, 200) : 'CHECK_FAILED')
    }
    const k = freshKey()
    const sealed = seal(plaintext, k)
    const asset = this.offer.accepted_assets.find((a) => a.asset_id === b.pay_with)!
    const rail = b.rail === 'bill-at-close' ? null : this.o.rails[b.rail]!
    let invoice: { invoice: string; payment_hash: Hex }
    if (!rail) invoice = { invoice: 'bill-at-close', payment_hash: keyHash(k) }
    else {
      try {
        invoice = await rail.invoice({ asset_id: asset.asset_id, amount: asset.amount, key_hash: keyHash(k), expiry_sec: this.o.invoiceExpirySeconds ?? 900 })
      } catch (err) {
        plaintext = null
        return refuse((err as Error).message.startsWith('HODL_UNSUPPORTED') ? 'HODL_UNSUPPORTED' : 'INVOICE_FAILED')
      }
    }
    const commitment = signCommitment(this.o.operator, {
      negotiation_id: m.negotiation_id, request_nonce: b.request_nonce, request_hash: checkMessageHash(m),
      offer_hash: offerHash(this.offer), release_hash: releaseHash(this.offer.release), consent: b.consent,
      commitment: plaintextCommitment(plaintext), ciphertext_hash: sealedHash(sealed), key_hash: keyHash(k),
      payment: { rail: b.rail, asset_id: asset.asset_id, amount: asset.amount, invoice: invoice.invoice, payment_hash: invoice.payment_hash },
      issued_at: this.now(),
    })
    const envelopeDigest = receiptEvidenceDigest(plaintext.outcome)
    // Retention 0: the plaintext is not kept once sealed.
    plaintext = null
    Object.assign(entry, { status: 'awaiting-payment', commitment: commitment.commitment, payment_hash: invoice.payment_hash, rail: b.rail, paid_with: asset.ticker })
    let tee: ResultTeeEvidence | undefined
    if (this.offer.execution.tee !== 'none' && this.o.attestResult) {
      try { tee = await this.o.attestResult({ report_data: commitment.report_data, commitment: commitment.commitment }) } catch (err) { this.say(`no attestation for this result: ${(err as Error).message.slice(0, 80)}`) }
    }
    if (!rail) {
      // Billed at close, not paid up front: hand over the result and K with the signed bill at once, and record the bill
      // only once that RESULT is out. A check that never reached the lender is never charged (the provider absorbs it).
      const billing = this.o.billing!
      const now = this.now()
      const bill = signBill(this.o.operator, {
        negotiation_id: m.negotiation_id, lender_pk: m.from_pk, borrower_pk: b.consent.borrower_pk, offer_hash: offerHash(this.offer), release_hash: releaseHash(this.offer.release),
        request_hash: checkMessageHash(m), commitment: commitment.commitment, fee: { asset_id: asset.asset_id, amount: asset.amount }, issued_at: now, expires_at: now + billing.ttlSeconds,
      })
      try {
        await reply('FEEDBACK', { status: 'billed', commitment, sealed, rail_label: RAIL_LABEL['bill-at-close'], ...(tee ? { tee } : {}) })
        await reply('RESULT', { status: 'billed', key: k, bill, rail_label: RAIL_LABEL['bill-at-close'] })
      } catch (err) {
        Object.assign(entry, { status: 'undelivered', reason: `RESULT_NOT_DELIVERED: not billed (${(err as Error).message.slice(0, 80)})` })
        this.say(`check ${m.negotiation_id.slice(0, 8)}: result not delivered, so not billed; the provider absorbs it`)
        return entry
      }
      Object.assign(entry, { status: 'billed', bill_hash: billHash(bill) })
      try { billing.ledger.append(bill) } catch (err) {
        // The lender has K and the bill, but the platform will not see it: the provider absorbs this check.
        Object.assign(entry, { reason: `BILL_NOT_RECORDED: ${(err as Error).message.slice(0, 80)}` })
        this.say(`check ${m.negotiation_id.slice(0, 8)}: bill not recorded (${(err as Error).message.slice(0, 80)}); the provider absorbs it`)
      }
      this.say(`check ${m.negotiation_id.slice(0, 8)} billed at close, not paid up front: ${asset.amount} ${asset.ticker} due from lender ${m.from_pk.slice(0, 12)}… when its loan closes; K handed over`)
      return entry
    }
    await reply('FEEDBACK', { status: 'payment-required', commitment, sealed, rail_label: RAIL_LABEL[b.rail], ...(tee ? { tee } : {}) })
    try {
      const paid = await rail.waitPaid(invoice.payment_hash, this.o.paymentTimeoutMs ?? 600_000, { asset_id: asset.asset_id, amount: asset.amount })
      if (b.rail === 'rgb-ln-hodl') {
        if (paid !== 'held') throw new Error('a HODL payment settled without the key')
        await rail.claim(invoice.payment_hash, k)
      }
    } catch (err) {
      entry.status = 'unpaid'
      entry.reason = (err as Error).message.slice(0, 120)
      if (b.rail === 'rgb-ln-hodl') await rail.cancel(invoice.payment_hash).catch(() => undefined)
      this.say(`check ${m.negotiation_id.slice(0, 8)} unpaid: ${entry.reason}`)
      return entry
    }
    entry.status = 'paid'
    await reply('RESULT', { status: 'settled', key: k, payment_hash: invoice.payment_hash, rail_label: RAIL_LABEL[b.rail] })
    this.say(`check ${m.negotiation_id.slice(0, 8)} paid in ${asset.ticker} (${RAIL_LABEL[b.rail]}); K handed over`)
    if (this.o.onPaid) await this.o.onPaid({ negotiation_id: m.negotiation_id, commitment, borrower_pk: b.consent.borrower_pk, envelope_digest: envelopeDigest, paid_with: asset, ...(typeof b.receipt_invoice === 'string' && b.receipt_invoice.length < 2000 ? { receipt_invoice: b.receipt_invoice } : {}) }).catch((err) => this.say(`receipt not sent: ${(err as Error).message}`))
    return entry
  }

  /** Serves REQUESTs until stop(); each runs on its own so one slow payer does not block the next. */
  async serve(opts: { republishMs?: number } = {}): Promise<void> {
    await this.publishOffer()
    const republish = setInterval(() => { this.publishOffer().catch((err) => this.say(`offer not republished: ${(err as Error).message}`)) }, opts.republishMs ?? 600_000)
    try {
      while (!this.stopped) {
        let next: { payload: CheckMessage; event: Event }
        try {
          // APPROVE shares the request kind; it belongs to the handler that asked for it.
          next = await this.bus.receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5_000, match: (x) => x?.type === 'REQUEST' })
        } catch { continue }
        void this.handle(next.payload, next.event.pubkey).catch((err) => this.say(`check failed: ${(err as Error).message}`))
      }
    } finally {
      clearInterval(republish)
    }
  }

  stop(): void { this.stopped = true }

  /** The public status the dashboard reads. */
  status() {
    return { offer: this.offer, offer_hash: offerHash(this.offer), release_hash: releaseHash(this.offer.release), scorer_label: this.o.engine.label, scorer_fallback: this.o.engine.fallback, rails: this.offer.rails.map((r) => ({ rail: r, label: RAIL_LABEL[r] })), log: this.log.slice(-20) }
  }
}
