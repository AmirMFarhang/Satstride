// Paying for a check in USDT over RGB Lightning.
//
//   rgb-ln-hodl              the operator's invoice is locked to sha256(K); the
//                            payer's HTLC is held until the operator claims it
//                            with K, so paying and learning K are one atomic
//                            step. Needs an RGB Lightning Node with HODL
//                            invoices: `payment_hash` on /lninvoice and
//                            /claimhodlinvoice (the pinned d4762ac has neither;
//                            infra/check-market.sh builds the UTEXO fork's
//                            HODL commit 61be1f7 for the check nodes only).
//   rgb-ln-pay-then-deliver  FALLBACK, labelled wherever it appears: a plain
//                            invoice; the operator sends K after it sees the
//                            payment settle. It trusts the node to deliver.
//                            The signed commitment still means a wrong K is
//                            caught, but a refusal after payment is not.
//
// No simulated success: every status comes from the node.

import { isHex, type Hex } from '../core/crypto.js'
import { BILL_RAIL_LABEL } from './bill.js'
import { verifyPreimage, type DecodedLightningInvoice, type LightningPayment, type RgbLightningNode } from '../rgb/lightning.js'

export type LightningCheckRail = 'rgb-ln-hodl' | 'rgb-ln-pay-then-deliver'

export const RAIL_LABEL: Record<LightningCheckRail | 'rgb-onchain' | 'bill-at-close', string> = {
  'bill-at-close': BILL_RAIL_LABEL,
  'rgb-ln-hodl': 'RGB Lightning, HODL invoice: paying reveals K (atomic)',
  'rgb-ln-pay-then-deliver': 'FALLBACK: pay, then deliver (trusts the node)',
  'rgb-onchain': 'FALLBACK: on-chain RGB, slow and not atomic (trusts the node)',
}

/** RGB invoices need an accompanying BTC HTLC of at least 3,000 sat (docs/ATOMIC.md). */
export const RGB_HTLC_MSAT = 3_000_000

export interface OperatorRail {
  readonly kind: LightningCheckRail
  /** hodl: payment hash = keyHash; plain: the node picks its own hash. */
  invoice(o: { asset_id: string; amount: number; key_hash: Hex; expiry_sec: number }): Promise<{ invoice: string; payment_hash: Hex }>
  /**
   * Resolves once the payer's HTLC is held (hodl) or the payment settled (plain),
   * after the receive checks: this asset (a voucher of another operator is
   * refused) and exactly this amount, inbound on this node.
   */
  waitPaid(paymentHash: Hex, timeoutMs: number, expect: { asset_id: string; amount: number }): Promise<'held' | 'settled'>
  /** hodl only: settle the held HTLC by revealing K. */
  claim(paymentHash: Hex, preimage: Hex): Promise<void>
  cancel(paymentHash: Hex): Promise<void>
}

export interface PayerRail {
  decode(invoice: string): Promise<DecodedLightningInvoice>
  /** Pays and waits; returns the preimage the node reports (K on the HODL rail). */
  pay(invoice: string, expect: { asset_id: string; amount: number; payment_hash: Hex }, timeoutMs: number): Promise<{ preimage: Hex | null }>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The node's view of a payment. The pinned RLN says `inbound`; the HODL build says `payment_type` instead. */
type NodePayment = Omit<LightningPayment, 'status' | 'inbound'> & { status: string; inbound?: boolean; payment_type?: 'Outbound' | 'InboundAutoClaim' | 'InboundHodl' }

export function isInboundPayment(p: { inbound?: boolean; payment_type?: string } | null | undefined): boolean {
  return !!p && (p.inbound === true || p.payment_type === 'InboundAutoClaim' || p.payment_type === 'InboundHodl')
}

export function isOutboundPayment(p: { inbound?: boolean; payment_type?: string } | null | undefined): boolean {
  return !!p && (p.inbound === false || p.payment_type === 'Outbound')
}

/** The RGB Lightning Node REST API, with the HODL routes when the node has them. */
export class RlnOperatorRail implements OperatorRail {
  constructor(readonly node: RgbLightningNode, readonly kind: LightningCheckRail, private readonly pollMs = 500) {}

  async invoice(o: { asset_id: string; amount: number; key_hash: Hex; expiry_sec: number }): Promise<{ invoice: string; payment_hash: Hex }> {
    if (!Number.isSafeInteger(o.amount) || o.amount <= 0) throw new Error('invalid check price')
    const body: Record<string, unknown> = { asset_id: o.asset_id, asset_amount: o.amount, amt_msat: RGB_HTLC_MSAT, expiry_sec: o.expiry_sec }
    if (this.kind === 'rgb-ln-hodl') body.payment_hash = o.key_hash
    const { invoice } = await this.node.request<{ invoice: string }>('/lninvoice', body)
    const d = await this.node.decodeInvoice(invoice)
    // A node without HODL support ignores the field: refuse rather than silently fall back.
    if (this.kind === 'rgb-ln-hodl' && d.payment_hash !== o.key_hash) throw new Error('HODL_UNSUPPORTED: this RGB Lightning Node ignored payment_hash; use the labelled pay-then-deliver fallback or the HODL build (infra/check-market.sh build)')
    if (d.asset_id !== o.asset_id || d.asset_amount !== o.amount) throw new Error('the node created an invoice for another asset or amount')
    return { invoice, payment_hash: d.payment_hash }
  }

  async waitPaid(paymentHash: Hex, timeoutMs: number, expect: { asset_id: string; amount: number }): Promise<'held' | 'settled'> {
    const deadline = Date.now() + timeoutMs
    let assetUnknownSince: number | null = null
    for (;;) {
      const p = await this.node.getPayment(paymentHash).catch(() => null) as NodePayment | null
      const inbound = isInboundPayment(p)
      // The node records the HTLC's RGB amount beside the payment; give it a moment to appear before judging.
      if (p && inbound && p.status === 'Claimable' && p.asset_id === null && (assetUnknownSince ??= Date.now()) > Date.now() - 20_000) { await sleep(this.pollMs); continue }
      if (p && inbound && ['Claimable', 'Succeeded'].includes(p.status) && (p.asset_id !== expect.asset_id || p.asset_amount !== expect.amount)) {
        // Never reveal K for another asset or amount; give the HTLC back.
        await this.cancel(paymentHash).catch(() => undefined)
        throw new Error(`RECEIVE_REFUSED: paid ${p.asset_amount ?? 0} of ${p.asset_id ?? 'BTC'}, expected ${expect.amount} of ${expect.asset_id}`)
      }
      if (p && inbound) {
        if (this.kind === 'rgb-ln-hodl' && p.status === 'Claimable') return 'held'
        if (p.status === 'Succeeded') return 'settled'
        if (p.status === 'Failed' || p.status === 'Cancelled') throw new Error(`check payment ${p.status.toLowerCase()}`)
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for the check payment')
      await sleep(this.pollMs)
    }
  }

  async claim(paymentHash: Hex, preimage: Hex): Promise<void> {
    if (this.kind !== 'rgb-ln-hodl') throw new Error('only a HODL invoice is claimed with a preimage')
    if (!verifyPreimage(preimage, paymentHash)) throw new Error('K does not hash to the invoice payment hash')
    await this.node.request('/claimhodlinvoice', { payment_hash: paymentHash, payment_preimage: preimage })
  }

  async cancel(paymentHash: Hex): Promise<void> {
    if (this.kind === 'rgb-ln-hodl') await this.node.request('/cancelhodlinvoice', { payment_hash: paymentHash })
  }
}

export class RlnPayerRail implements PayerRail {
  constructor(readonly node: RgbLightningNode, private readonly pollMs = 500) {}

  decode(invoice: string): Promise<DecodedLightningInvoice> {
    return this.node.decodeInvoice(invoice)
  }

  async pay(invoice: string, expect: { asset_id: string; amount: number; payment_hash: Hex }, timeoutMs: number): Promise<{ preimage: Hex | null }> {
    const d = await this.node.decodeInvoice(invoice)
    if (d.payment_hash !== expect.payment_hash || d.asset_id !== expect.asset_id || d.asset_amount !== expect.amount || d.amt_msat !== RGB_HTLC_MSAT) throw new Error('the invoice is not the committed check payment')
    const submitted = await this.node.payInvoice(invoice)
    if (submitted.payment_id !== expect.payment_hash) throw new Error('RGB Lightning returned a different payment id')
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const p = await this.node.getPayment(expect.payment_hash) as NodePayment
      const mismatch = p.asset_id !== expect.asset_id || p.asset_amount !== expect.amount
      if (!isOutboundPayment(p) || (mismatch && (p.asset_id !== null || p.status === 'Succeeded'))) throw new Error('RGB Lightning payment does not match this check')
      if (p.status === 'Failed') throw new Error('check payment failed')
      if (p.status === 'Succeeded') {
        if (!isHex(p.preimage, 32) || !verifyPreimage(p.preimage, expect.payment_hash)) throw new Error('RGB Lightning returned an invalid preimage')
        return { preimage: p.preimage }
      }
      if (Date.now() >= deadline) throw new Error('check payment timed out; inspect the payment hash before retrying')
      await sleep(this.pollMs)
    }
  }
}
