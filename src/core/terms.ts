// The loan terms. Their canonical hash is committed in an OP_RETURN output of
// the collateral lock transaction, so anyone holding the terms can check a
// lock on chain and read the due height from it. Heights, not timestamps:
// the demo runs on regtest and maturity is enforced by nLockTime.

import { hashObject, isHex, type Hex } from './crypto.js'
import { DEFAULT_ECONOMICS, feeWithinCap, impliedAprBps, maxLtvForTerm, termDays, type Economics } from './economics.js'
import { assertInt, ltvBps, pct, type Bps, type Micro, type PriceCents, type Sats } from './money.js'

export interface OracleQuote {
  price_cents: PriceCents
  height: number
  oracle_pk: Hex
  /** Signed provenance; older quotes omit these fields. Times are Unix milliseconds. */
  source?: 'live_median' | 'demo_override' | 'configured'
  observed_at?: number
  sources?: { name: string; price_cents: number; observed_at: number }[]
  sig: Hex
}

/** Fixed at origination. The invoice pays the original lender, so assignment
 * requires a node protocol that can preserve this hash for a new payee. */
export interface AtomicRepayment {
  invoice: string
  /** RLN requires this accompanying BTC payment, in addition to RGB debt. */
  btc_amount_msat: 3_000_000
  payment_hash: Hex
  /** Invoice expiry in Unix seconds, not a Bitcoin height. */
  expires_at: number
  /** Compressed Lightning node identity returned by invoice decoding. */
  payee_pubkey: Hex
}

export interface LoanTerms {
  v: 1 | 2
  /** Required for v2; forbidden for v1, preserving existing escrow addresses. */
  atomic_repayment?: AtomicRepayment
  borrower_pk: Hex
  lender_pk: Hex
  platform_pk: Hex
  /** RGB contract id of the dollar asset. */
  asset_id: string
  principal: Micro
  /** The lender's interest for the whole term (termInterest, ACT/365): the only cost the borrower pays. */
  fee: Micro
  collateral_sats: Sats
  oracle_quote: OracleQuote
  open_height: number
  maturity_height: number
  grace_blocks: number
  recovery_height: number
  ladder_step: number
  ltv_bps: Bps
  /** Release txid of the previous loan in this borrower's passbook chain, null for the first. */
  prev_passbook_txid: Hex | null
  /** 32 random bytes so the hash cannot be brute-forced from guessable fields. */
  nonce: Hex
}

export function termsHash(terms: LoanTerms): Hex {
  return hashObject(terms)
}

export function debtOf(terms: Pick<LoanTerms, 'principal' | 'fee'>): Micro {
  return terms.principal + terms.fee
}

const TERM_FIELDS = new Set(['v', 'atomic_repayment', 'borrower_pk', 'lender_pk', 'platform_pk', 'asset_id', 'principal', 'fee', 'collateral_sats', 'oracle_quote', 'open_height', 'maturity_height', 'grace_blocks', 'recovery_height', 'ladder_step', 'ltv_bps', 'prev_passbook_txid', 'nonce'])
/** Names that would carry a borrower-side charge besides the lender's interest. */
const BORROWER_FEE_FIELD = /fee|commission|origination|penalt|charge|cost/i

/**
 * Structural and economic validation. Throws with a field name on the first problem.
 * Economics (docs/REVENUE.md): the fee (the lender's interest) may not exceed what the
 * APR cap gives for this principal and term, the LTV may not exceed the limit for the
 * term's length, and the terms carry no other borrower-side fee field. LoanTerms itself
 * is unchanged, so existing escrow addresses and terms hashes stay valid. Pass
 * `economics: null` to check structure only (historical passbook pages).
 */
export function validateTerms(t: unknown, economics: Economics | null = DEFAULT_ECONOMICS): asserts t is LoanTerms {
  const x = t as LoanTerms
  if (!x || typeof x !== 'object') throw new TypeError('terms must be an object')
  for (const key of Object.keys(x)) {
    if (TERM_FIELDS.has(key)) continue
    if (BORROWER_FEE_FIELD.test(key)) throw new TypeError(`terms.${key}: no borrower-side fee is allowed; the borrower pays principal plus the lender's interest (terms.fee) only`)
    throw new TypeError(`terms.${key}: unknown field`)
  }
  if (x.v !== 1 && x.v !== 2) throw new TypeError('terms.v must be 1 or 2')
  if (x.v === 1 && x.atomic_repayment !== undefined) throw new TypeError('terms.v1 cannot contain atomic_repayment')
  if (x.v === 2) {
    const a = x.atomic_repayment
    if (!a || typeof a.invoice !== 'string' || !a.invoice.startsWith('lnbcrt')) throw new TypeError('terms.atomic_repayment.invoice must be a regtest Lightning invoice')
    if (a.btc_amount_msat !== 3_000_000) throw new TypeError('terms.atomic_repayment.btc_amount_msat must be 3000000')
    if (!isHex(a.payment_hash, 32)) throw new TypeError('terms.atomic_repayment.payment_hash must be 32 bytes')
    if (!isHex(a.payee_pubkey, 33) || !/^(02|03)/.test(a.payee_pubkey)) throw new TypeError('terms.atomic_repayment.payee_pubkey must be a compressed key')
    assertInt('terms.atomic_repayment.expires_at', a.expires_at, 1)
  }
  for (const k of ['borrower_pk', 'lender_pk', 'platform_pk'] as const) {
    if (!isHex(x[k], 32)) throw new TypeError(`terms.${k} must be a 32-byte hex pubkey`)
  }
  if (typeof x.asset_id !== 'string' || !x.asset_id) throw new TypeError('terms.asset_id required')
  assertInt('terms.principal', x.principal, 1)
  assertInt('terms.fee', x.fee)
  assertInt('terms.collateral_sats', x.collateral_sats, 1)
  assertInt('terms.open_height', x.open_height)
  assertInt('terms.maturity_height', x.maturity_height, x.open_height + 1)
  assertInt('terms.grace_blocks', x.grace_blocks)
  assertInt('terms.recovery_height', x.recovery_height, x.maturity_height + x.grace_blocks + 1)
  assertInt('terms.ladder_step', x.ladder_step)
  assertInt('terms.ltv_bps', x.ltv_bps, 1)
  if (x.prev_passbook_txid !== null && !isHex(x.prev_passbook_txid, 32)) throw new TypeError('terms.prev_passbook_txid must be a txid or null')
  if (!isHex(x.nonce, 32)) throw new TypeError('terms.nonce must be 32 bytes hex')
  const q = x.oracle_quote
  if (!q || typeof q !== 'object') throw new TypeError('terms.oracle_quote required')
  assertInt('terms.oracle_quote.price_cents', q.price_cents, 1)
  assertInt('terms.oracle_quote.height', q.height)
  if (!isHex(q.oracle_pk, 32) || !isHex(q.sig, 64)) throw new TypeError('terms.oracle_quote must be signed')
  // null: a page already on chain is checked for structure only; today's pricing bounds apply to new terms
  if (economics === null) return
  const termBlocks = x.maturity_height - x.open_height
  if (!feeWithinCap({ principal: x.principal, fee: x.fee, term_blocks: termBlocks }, economics)) throw new RangeError(`terms.fee implies ${pct(impliedAprBps(x, economics))} APR, above the ${pct(economics.max_apr_bps)} cap`)
  const maxLtv = maxLtvForTerm(termBlocks, economics)
  const ltv = Math.max(x.ltv_bps, ltvBps(debtOf(x), x.collateral_sats, q.price_cents))
  if (ltv > maxLtv) throw new RangeError(maxLtv === 0 ? `terms: a ${termDays(termBlocks, economics)}-day term is longer than any allowed LTV bucket` : `terms.ltv_bps ${pct(ltv)} is above the ${pct(maxLtv)} limit for a ${termDays(termBlocks, economics)}-day term`)
}
