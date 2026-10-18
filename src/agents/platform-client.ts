// What an agent sees of the platform: its HTTP API and nothing else.

import type { Hex, KeyPair } from '../core/crypto.js'
import { signRequest } from '../server/auth.js'
import type { LoanTerms, OracleQuote } from '../core/terms.js'
import type { Offer } from '../market/orderbook.js'
import type { Passbook } from '../registry/passbook.js'
import type { LoanRecord } from '../registry/store.js'
import type { Attestation } from '../sandbox/broker.js'
import type { SandboxResult } from '../sandbox/types.js'
import type { IssuedInvoice, WatchKeys } from '../rgb/watch.js'
import type { CosignDecision, CosignPurpose, Verdict } from '../server/platform.js'
import type { FeeRecord } from '../server/fees.js'
import type { Economics } from '../core/economics.js'

export class PlatformError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message)
  }
}

export interface MonitorRow {
  loan_id: Hex
  ltv_bps: number
  state: string
}

export interface PlatformState {
  platform_pk: Hex
  oracle_pk: Hex
  chain: string
  height: number
  price_cents: number
  engine: string
  /** The platform's published economics: share of interest, APR cap, LTV per term, day count. */
  economics?: Economics
}

export class PlatformClient {
  constructor(readonly base: string = process.env.PASSBOOK_URL ?? 'http://127.0.0.1:4170', private readonly key?: KeyPair) {}

  /** The same platform, with every request signed by this key (src/server/auth.ts). */
  as(key: KeyPair): PlatformClient {
    return new PlatformClient(this.base, key)
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { ...(raw === undefined ? {} : { 'content-type': 'application/json' }), ...(this.key ? signRequest(this.key, method, path, raw ?? '') : {}) }
    const res = await fetch(this.base + path, { method, headers, body: raw })
    const json = (await res.json()) as unknown
    if (!res.ok) throw new PlatformError(res.status, `${method} ${path} (${res.status}): ${(json as { error?: string }).error ?? res.status}`, json)
    return json as T
  }

  state(): Promise<PlatformState> {
    return this.call('GET', '/state')
  }
  quote(): Promise<OracleQuote> {
    return this.call('GET', '/oracle/quote')
  }
  orderbook(): Promise<{ offers: Offer[] }> {
    return this.call('GET', '/orderbook')
  }
  sandboxPubkey(): Promise<{ sandbox_pk: Hex; attestation: Attestation }> {
    return this.call('GET', '/sandbox/pubkey')
  }
  submitToSandbox(senderPk: Hex, ciphertext: string): Promise<SandboxResult> {
    return this.call('POST', '/sandbox/submit', { sender_pk: senderPk, ciphertext })
  }
  passbook(pk: Hex): Promise<Passbook> {
    return this.call('GET', `/passbook/${pk}`)
  }
  registerLoan(terms: LoanTerms, passbook?: import('../registry/passbook-doc.js').PassbookDocument): Promise<{ loan: LoanRecord; verdict: Verdict }> {
    return this.call('POST', '/loans', { terms, passbook })
  }
  loan(id: Hex): Promise<LoanRecord> {
    return this.call('GET', `/loans/${id}`)
  }
  recordLock(id: Hex, lockTxid: Hex): Promise<LoanRecord> {
    return this.call('POST', `/loans/${id}/lock`, { lock_txid: lockTxid })
  }
  recordFunded(id: Hex, disbursementTxid: Hex, lenderSig: Hex): Promise<LoanRecord> {
    return this.call('POST', `/loans/${id}/funded`, { disbursement_txid: disbursementTxid, lender_sig: lenderSig })
  }
  recordRepaid(id: Hex, repaymentTxid: Hex, lenderSig?: Hex): Promise<LoanRecord> {
    return this.call('POST', `/loans/${id}/repaid`, { repayment_txid: repaymentTxid, lender_sig: lenderSig })
  }
  /** Lender: the platform issues the repayment invoice from a watch-only wallet on these xpubs. */
  repaymentWatch(id: Hex, keys: WatchKeys, lenderSig: Hex): Promise<IssuedInvoice> {
    return this.call('POST', `/loans/${id}/repayment-watch`, { ...keys, lender_sig: lenderSig })
  }
  /** The loan's borrower or lender: the platform validates the RGB repayment with its own watch-only wallet and records it as proof. */
  verifyRepayment(id: Hex, repaymentTxid?: Hex): Promise<Verdict & { repayment_txid?: Hex; receipt?: import('../registry/passbook-doc.js').RgbRepaymentReceipt }> {
    return this.call('POST', `/loans/${id}/repayment/verify`, { repayment_txid: repaymentTxid })
  }
  recordRelease(id: Hex, releaseTxid: Hex): Promise<LoanRecord> {
    return this.call('POST', `/loans/${id}/release`, { release_txid: releaseTxid })
  }
  settle(id: Hex, txid: Hex, outcome: 'defaulted' | 'liquidated' | 'refunded'): Promise<LoanRecord> {
    return this.call('POST', `/loans/${id}/settle`, { txid, outcome })
  }
  /** Regtest only: the demo's price slider. The platform runs its monitor on every change. */
  setPrice(priceCents: number): Promise<{ price_cents: number; monitor: MonitorRow[] }> {
    return this.call('POST', '/oracle/set', { price_cents: priceCents })
  }
  monitor(): Promise<{ loans: MonitorRow[] }> {
    return this.call('POST', '/monitor')
  }
  cosign(req: { loan_id: Hex; purpose: CosignPurpose; psbt?: string; txid?: Hex; repayment_txid?: Hex }): Promise<CosignDecision> {
    return this.call('POST', '/cosign', req)
  }
  /** Platform fees a lender owes after its loans closed; `blocked` is the refusal message while one is overdue. */
  fees(lenderPk: Hex): Promise<{ height: number; fees: FeeRecord[]; blocked?: string | null; economics: Economics }> {
    return this.call('GET', `/fees?lender=${lenderPk}`)
  }
  /** A payable invoice for a due fee: the platform replaces one that never issued or is about to expire. */
  feeInvoice(loanId: Hex): Promise<FeeRecord> {
    return this.call('POST', `/fees/${loanId}/invoice`, {})
  }
  /** The platform validates the fee payment from its own wallet and marks it fee_paid. */
  verifyFee(loanId: Hex, txid?: Hex): Promise<Verdict & { fee?: FeeRecord }> {
    return this.call('POST', `/fees/${loanId}/verify`, { txid })
  }
  /** An agent's own line on the wire, signed with its key so the platform can attribute it. */
  note(note: { actor_pk: Hex; role: string; title: string; detail?: unknown; sig: Hex }): Promise<{ ok: true }> {
    return this.call('POST', '/wire', note)
  }
}
