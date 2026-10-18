// The platform's HTTP API as the phone calls it (src/agents/platform-client.ts):
// the same routes, every request signed by the party key in the worklet over the
// same digest (src/server/auth.ts requestDigest), the same headers. With the platform's
// key from the provider's link the same requests travel over Nostr (platform-nostr.ts),
// and the LAN address is the fallback.
import { sha256Hex, type Hex } from '../../../../src/core/crypto.js'
import type { LoanTerms, OracleQuote } from '../../../../src/core/terms.js'
import type { Offer } from '../../../../src/market/orderbook.js'
import type { Attestation } from '../../../../src/sandbox/broker.js'
import type { SandboxResult } from '../../../../src/sandbox/types.js'
import type { PassbookDocument } from '../../../../src/registry/passbook-doc.js'
import type { FeeRecord } from '../../../../src/server/fees.js'
import type { Economics } from '../../../../src/core/economics.js'
import type { PartySigner } from './ports'

/** The public half of a lender's per-loan repayment account (src/rgb/watch.ts WatchKeys). */
export interface WatchKeys { account_xpub_vanilla: string; account_xpub_colored: string; master_fingerprint: string }
/** What the platform's watch-only wallet issued on those keys: the invoice and an rgb-lib backup (base64) of that wallet. */
export interface IssuedInvoice { invoice: string; recipient_id: string; backup: string; password: string }
export interface Check { id: string; ok: boolean; detail: string }

export interface PhonePlatformState { platform_pk: Hex; oracle_pk: Hex; chain: string; height: number; price_cents: number }
export interface PhoneLoanRecord { id?: Hex; status: string; terms?: LoanTerms; repayment_watch?: { invoice: string; recipient_id?: string }; settlement_txid?: Hex; margin_call_height?: number; lock_txid?: Hex; lock_vout?: number; disbursement_txid?: Hex; repayment_txid?: Hex; release_txid?: Hex; closed_height?: number }
export interface Verification { ok: boolean; checks: { id: string; ok: boolean; detail: string }[]; receipt?: unknown }

/** The platform API over another carrier (NostrPlatformCall): the same contract as PhonePlatform's HTTP call. */
export interface PlatformCarrier { call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> }

export class PhonePlatform {
  private viaNostr: boolean
  constructor(readonly base: string, private readonly key: PartySigner, private readonly nostr: PlatformCarrier | null = null) {
    this.viaNostr = !!nostr
  }

  /** How requests travel now: over Nostr while the platform answers there, else HTTP to `base`. */
  get route(): 'nostr' | 'http' { return this.viaNostr ? 'nostr' : 'http' }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.nostr || !this.viaNostr) return this.http<T>(method, path, body)
    try {
      return await this.nostr.call<T>(method, path, body)
    } catch (e) {
      // The LAN address is the fallback, only when Nostr brought no answer at all and only for a read:
      // a write may have reached the platform, so it is never sent a second time another way.
      if (!this.base || method !== 'GET' || !/no answer from the platform over Nostr/.test((e as Error).message)) throw e
      const r = await this.http<T>(method, path, body)
      // the LAN answered: the rest of this session uses it
      this.viaNostr = false
      return r
    }
  }

  private async http<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.base) throw new Error(`${method} ${path}: no platform address; open the provider's link in Settings, Network`)
    const raw = body === undefined ? '' : JSON.stringify(body)
    const ts = Date.now()
    const nonce = sha256Hex(`${ts}:${Math.random()}`).slice(0, 32)
    const sig = await this.key.signRequest({ method, pathAndQuery: path, timestampMs: ts, nonce, bodySha256: sha256Hex(raw) })
    const headers: Record<string, string> = { 'x-passbook-key': this.key.pubkey, 'x-passbook-ts': String(ts), 'x-passbook-nonce': nonce, 'x-passbook-sig': sig, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : raw })
    const json = (await res.json()) as unknown
    if (!res.ok) throw new Error(`${method} ${path} (${res.status}): ${(json as { error?: string }).error ?? res.status}`)
    return json as T
  }

  state() { return this.call<PhonePlatformState>('GET', '/state') }
  quote() { return this.call<OracleQuote>('GET', '/oracle/quote') }
  orderbook() { return this.call<{ offers: Offer[] }>('GET', '/orderbook') }
  sandboxPubkey() { return this.call<{ sandbox_pk: Hex; attestation: Attestation }>('GET', '/sandbox/pubkey') }
  submitToSandbox(senderPk: Hex, ciphertext: string) { return this.call<SandboxResult>('POST', '/sandbox/submit', { sender_pk: senderPk, ciphertext }) }
  loan(id: Hex) { return this.call<PhoneLoanRecord>('GET', `/loans/${id}`) }
  recordLock(id: Hex, lockTxid: Hex) { return this.call<unknown>('POST', `/loans/${id}/lock`, { lock_txid: lockTxid }) }
  recordRelease(id: Hex, releaseTxid: Hex) { return this.call<unknown>('POST', `/loans/${id}/release`, { release_txid: releaseTxid }) }
  verifyRepayment(id: Hex, repaymentTxid: Hex) { return this.call<Verification>('POST', `/loans/${id}/repayment/verify`, { repayment_txid: repaymentTxid }) }
  cosign(req: { loan_id: Hex; purpose: 'release' | 'liquidate' | 'refund'; psbt: string; repayment_txid?: Hex }) { return this.call<{ ok: boolean; psbt?: string; checks: Check[] }>('POST', '/cosign', req) }
  note(note: unknown) { return this.call<unknown>('POST', '/wire', note) }
  // the lender's routes (src/agents/platform-client.ts): each is signed by the lender's party key
  registerLoan(terms: LoanTerms, passbook?: PassbookDocument) { return this.call<{ loan: PhoneLoanRecord & { id: Hex }; verdict: Verification }>('POST', '/loans', { terms, passbook }) }
  recordFunded(id: Hex, disbursementTxid: Hex, lenderSig: Hex) { return this.call<PhoneLoanRecord>('POST', `/loans/${id}/funded`, { disbursement_txid: disbursementTxid, lender_sig: lenderSig }) }
  recordRepaid(id: Hex, repaymentTxid: Hex, lenderSig: Hex) { return this.call<PhoneLoanRecord>('POST', `/loans/${id}/repaid`, { repayment_txid: repaymentTxid, lender_sig: lenderSig }) }
  repaymentWatch(id: Hex, keys: WatchKeys, lenderSig: Hex) { return this.call<IssuedInvoice>('POST', `/loans/${id}/repayment-watch`, { ...keys, lender_sig: lenderSig }) }
  settle(id: Hex, txid: Hex, outcome: 'defaulted' | 'liquidated' | 'refunded') { return this.call<PhoneLoanRecord>('POST', `/loans/${id}/settle`, { txid, outcome }) }
  fees(lenderPk: Hex) { return this.call<{ height: number; fees: FeeRecord[]; blocked?: string | null; economics: Economics }>('GET', `/fees?lender=${lenderPk}`) }
  feeInvoice(loanId: Hex) { return this.call<FeeRecord>('POST', `/fees/${loanId}/invoice`, {}) }
  verifyFee(loanId: Hex, txid?: Hex) { return this.call<Verification & { fee?: FeeRecord }>('POST', `/fees/${loanId}/verify`, { txid }) }
}
