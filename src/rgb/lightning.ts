// Real RGB Lightning Node REST adapter. No simulated success or preimages.
// API pin and reproducible spike commands: docs/ATOMIC.md.
import { hexToBytes, isHex, sha256Hex, type Hex } from '../core/crypto.js'
import { debtOf, type AtomicRepayment, type LoanTerms } from '../core/terms.js'

export interface DecodedLightningInvoice {
  amt_msat: number | null
  payment_hash: Hex
  payee_pubkey: Hex
  asset_id: string | null
  asset_amount: number | null
  timestamp: number
  expiry_sec: number
  network: string
}
export interface LightningPayment {
  payment_hash: Hex
  inbound: boolean
  status: 'Pending' | 'Succeeded' | 'Failed'
  asset_id: string | null
  asset_amount: number | null
  preimage?: Hex | null
}

export interface RgbLightningClient {
  createInvoice(assetId: string, amount: number, expirySeconds: number): Promise<string>
  decodeInvoice(invoice: string): Promise<DecodedLightningInvoice>
  payInvoice(invoice: string): Promise<{ payment_id: Hex; status: string }>
  getPayment(hash: Hex): Promise<LightningPayment>
}

export class RgbLightningNode implements RgbLightningClient {
  constructor(readonly url: string, private readonly token?: string) {}

  static fromEnv(role: 'BORROWER' | 'LENDER'): RgbLightningNode | undefined {
    const url = process.env[`PASSBOOK_${role}_LIGHTNING_URL`]
    return url ? new RgbLightningNode(url, process.env[`PASSBOOK_${role}_LIGHTNING_TOKEN`]) : undefined
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`RGB Lightning ${path}: HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`)
    return await res.json() as T
  }

  async createInvoice(assetId: string, amount: number, expirySeconds: number): Promise<string> {
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(expirySeconds) || expirySeconds <= 0 || expirySeconds > 0xffffffff) throw new Error('invalid RGB Lightning invoice amount or expiry')
    // RLN requires an accompanying BTC HTLC of at least 3,000 sat for RGB.
    const result = await this.request<{ invoice: string }>('/lninvoice', { asset_id: assetId, asset_amount: amount, amt_msat: 3_000_000, expiry_sec: expirySeconds, description: 'Passbook loan repayment' })
    return result.invoice
  }
  decodeInvoice(invoice: string): Promise<DecodedLightningInvoice> { return this.request('/decodelninvoice', { invoice }) }
  payInvoice(invoice: string): Promise<{ payment_id: Hex; status: string }> { return this.request('/sendpayment', { invoice }) }
  async getPayment(hash: Hex): Promise<LightningPayment> { return (await this.request<{ payment: LightningPayment }>('/getpayment', { payment_hash: hash })).payment }
}

/** Heights cannot guarantee wall-clock expiry. Budget two nominal ten-minute
 * blocks per remaining block, one hour safety, and at least 30 days at issue. */
export function atomicCoverageSeconds(terms: Pick<LoanTerms, 'open_height' | 'recovery_height'>): number {
  return (terms.recovery_height - terms.open_height) * 1200 + 3600
}

export function atomicExpirySeconds(terms: Pick<LoanTerms, 'open_height' | 'recovery_height'>): number {
  return Math.max(30 * 24 * 3600, atomicCoverageSeconds(terms))
}

export async function createAtomicRepayment(node: RgbLightningClient, terms: LoanTerms, now = Math.floor(Date.now() / 1000)): Promise<AtomicRepayment> {
  const invoice = await node.createInvoice(terms.asset_id, debtOf(terms), atomicExpirySeconds(terms))
  const d = await node.decodeInvoice(invoice)
  const repayment: AtomicRepayment = { invoice, btc_amount_msat: 3_000_000, payment_hash: d.payment_hash, expires_at: d.timestamp + d.expiry_sec, payee_pubkey: d.payee_pubkey }
  const v2: LoanTerms = { ...terms, v: 2, atomic_repayment: repayment }
  await verifyAtomicInvoice(node, v2, now, atomicExpirySeconds(terms) - 60)
  return repayment
}

/** Decode on each party's own node before accepting or paying. Never trust
 * invoice metadata supplied by a counterparty, or model output. */
export async function verifyAtomicInvoice(node: RgbLightningClient, terms: LoanTerms, now = Math.floor(Date.now() / 1000), minRemainingSeconds = 60): Promise<DecodedLightningInvoice> {
  const a = terms.atomic_repayment
  if (terms.v !== 2 || !a) throw new Error('loan has no atomic repayment invoice')
  const d = await node.decodeInvoice(a.invoice)
  if (!isHex(d.payment_hash, 32) || d.payment_hash !== a.payment_hash) throw new Error('atomic invoice payment hash mismatch')
  if (!isHex(d.payee_pubkey, 33) || d.payee_pubkey !== a.payee_pubkey) throw new Error('atomic invoice payee mismatch')
  if (d.network !== 'Regtest' && d.network !== 'regtest') throw new Error('atomic invoice is not on regtest')
  if (d.amt_msat !== a.btc_amount_msat || a.btc_amount_msat !== 3_000_000) throw new Error('atomic invoice accompanying BTC amount mismatch')
  if (d.asset_id !== terms.asset_id || d.asset_amount !== debtOf(terms)) throw new Error('atomic invoice asset or amount mismatch')
  if (!Number.isSafeInteger(d.timestamp) || !Number.isSafeInteger(d.expiry_sec) || d.timestamp + d.expiry_sec !== a.expires_at || a.expires_at < now + minRemainingSeconds) throw new Error('atomic invoice expiry does not cover the required interval')
  return d
}

export function verifyPreimage(preimage: unknown, hash: Hex): preimage is Hex {
  return isHex(preimage, 32) && sha256Hex(hexToBytes(preimage)) === hash
}

/** Only a successful outbound payment with matching asset, amount and hash
 * can release the collateral. Timeout is visible; it never fabricates r. */
export async function payAtomicInvoice(node: RgbLightningClient, terms: LoanTerms, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<Hex> {
  await verifyAtomicInvoice(node, terms)
  const a = terms.atomic_repayment!
  const submitted = await node.payInvoice(a.invoice)
  if (submitted.payment_id !== a.payment_hash) throw new Error('RGB Lightning returned a different payment id')
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
  do {
    const p = await node.getPayment(a.payment_hash)
    if (p.payment_hash !== a.payment_hash || p.inbound || p.asset_id !== terms.asset_id || p.asset_amount !== debtOf(terms)) throw new Error('RGB Lightning payment does not match this loan')
    if (p.status === 'Failed') throw new Error('RGB Lightning payment failed')
    if (p.status === 'Succeeded') {
      if (!verifyPreimage(p.preimage, a.payment_hash)) throw new Error('RGB Lightning returned an invalid payment preimage')
      return p.preimage
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 500))
  } while (Date.now() < deadline)
  throw new Error('RGB Lightning payment timed out; inspect the existing payment hash before retrying')
}
