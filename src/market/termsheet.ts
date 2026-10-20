// The term sheet: one document both agents sign and each human approves.
//
// Its hash IS the terms hash committed on chain. The sheet carries the exact
// LoanTerms that go into the lock's OP_RETURN, and those terms' 32-byte nonce
// is derived from every other field of the sheet (and a random salt), so
// termsHash(terms) commits to the scorer reference, consent hash, settlement
// kind and parameters, negotiation transcript and risk thresholds as well.
// Escrow scripts and passbook verification are unchanged.
//
// Every number comes from the negotiation engine, integer money helpers and
// src/core/economics.ts. The borrower pays principal plus the lender's term
// interest and nothing else; the platform's share of that interest is the
// lender's to pay after close, so it is shown to the lender but is not a term
// the borrower signs. There is no liquidation penalty.

import { hashObject, isHex, signHash, verifyHash, type Hex } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, lenderReturn, termDays, termInterest, type Economics } from '../core/economics.js'
import { btc, collateralFor, ltvBps, pct, priceAtLtv, usdt, type Bps, type Micro, type Sats } from '../core/money.js'
import { debtOf, termsHash, validateTerms, type LoanTerms, type OracleQuote } from '../core/terms.js'
import { HEX32_PATTERN, HEX64_PATTERN, schemaErrors, type JsonSchema } from '../core/schema.js'
import { CURE_BLOCKS, LIQUIDATION_BPS, MARGIN_CALL_BPS } from '../registry/ladder.js'
import type { TrustLevel } from '../scorer/trust.js'
import type { Recommendation, ScorerDescriptor } from '../scorer/types.js'
import { applySettlement, settlementOf } from '../settlement/adapters.js'
import type { SettlementParams } from '../settlement/types.js'
import type { Position } from './negotiate.js'

/** What the lender verified, committed through the terms nonce into the on-chain terms hash. */
export type TermSheetEvidence =
  | { kind: 'external-evidence'; evidence_sha256: Hex; reference?: string }
  | { kind: 'passbook-run-record'; run_record_sha256: Hex }

export interface TermSheetScorer {
  provider: ScorerDescriptor['provider']
  scorer_id: string
  code_measurement: string
  contract_hash: Hex
  /** The trust the lender's verifier granted, not the scorer's claim. */
  trust: TrustLevel
  /** scorerResultHash of the evidence the lender verified. */
  result_hash: Hex
  fallback: boolean
  recommendation: Recommendation
  /**
   * The evidence digest (decision 4): changing it changes the terms hash the
   * lock commits. Required in a v2 sheet; v1 sheets were issued before it and
   * carry none.
   */
  evidence?: TermSheetEvidence
  /** Check market: the RGB UDA receipt the check node sent the borrower, named next to the evidence digest (src/checknode/receipt.ts). */
  check_receipt?: { contract_id: string; commitment: Hex; operator_pk: Hex }
  /**
   * Check market, bill-at-close (src/checknode/bill.ts): the check ran on credit and its fee is added to the lender's
   * platform fee when this loan closes. Covered by the sheet's hash, so the lock commits to the bill. Absent: unchanged.
   */
  check_bill?: { bill_hash: Hex; operator_pk: Hex; asset_id: string; amount: number; due: 'at-close' }
}

export interface TermSheet {
  /** 2: carries the evidence digest. 1: issued before it; still validated so historical loans audit. */
  v: 1 | 2
  kind: 'passbook-termsheet'
  negotiation: { id: Hex; accept_hash: Hex }
  terms: LoanTerms
  binding_salt: Hex
  apr_bps: Bps
  /** interest: termInterest of the agreed APR and term (= terms.fee). borrower_other: always 0, no other borrower fee. */
  fees: { interest: Micro; borrower_other: 0 }
  collateral: { sats: Sats; ltv_bps: Bps; margin_call_ltv_bps: Bps; liquidation_ltv_bps: Bps; margin_call_price_cents: number; liquidation_price_cents: number; cure_blocks: number }
  default_terms: { maturity_height: number; grace_blocks: number; recovery_height: number }
  settlement: SettlementParams
  scorer: TermSheetScorer
  consent_hash: Hex
  ladder_step: number
  signatures: { borrower?: Hex; lender?: Hex }
}

const hex32: JsonSchema = { type: 'string', pattern: HEX32_PATTERN }
const sig: JsonSchema = { type: 'string', pattern: HEX64_PATTERN }
const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'integer', minimum, maximum })
const obj = (properties: Record<string, JsonSchema>, optional: string[] = []): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) })
const atomic = obj({ invoice: { type: 'string', pattern: '^lnbcrt[0-9a-z]+$', maxLength: 2000 }, btc_amount_msat: { type: 'integer', const: 3_000_000 }, payment_hash: hex32, expires_at: int(1), payee_pubkey: { type: 'string', pattern: '^0[23][0-9a-f]{64}$' } })
const quote = obj({ price_cents: int(1), height: int(), oracle_pk: hex32, source: { type: 'string', enum: ['live_median', 'demo_override', 'configured'] }, observed_at: int(), sources: { type: 'array', maxItems: 10, items: obj({ name: { type: 'string', maxLength: 40 }, price_cents: int(1), observed_at: int() }) }, sig }, ['source', 'observed_at', 'sources'])
const terms = obj({ v: { type: 'integer', minimum: 1, maximum: 2 }, atomic_repayment: atomic, borrower_pk: hex32, lender_pk: hex32, platform_pk: hex32, asset_id: { type: 'string', minLength: 1, maxLength: 200 }, principal: int(1), fee: int(), collateral_sats: int(1), oracle_quote: quote, open_height: int(), maturity_height: int(), grace_blocks: int(), recovery_height: int(), ladder_step: int(), ltv_bps: int(1, 9999), prev_passbook_txid: { oneOf: [hex32, { type: 'null' }] }, nonce: hex32 }, ['atomic_repayment'])

export const TERMSHEET_SCHEMA: JsonSchema = obj({
  v: { type: 'integer', minimum: 1, maximum: 2 },
  kind: { type: 'string', const: 'passbook-termsheet' },
  negotiation: obj({ id: hex32, accept_hash: hex32 }),
  terms,
  binding_salt: hex32,
  apr_bps: int(0, 1_000_000),
  fees: obj({ interest: int(), borrower_other: { type: 'integer', const: 0 } }),
  collateral: obj({ sats: int(1), ltv_bps: int(1, 9999), margin_call_ltv_bps: int(1, 9999), liquidation_ltv_bps: int(1, 9999), margin_call_price_cents: int(), liquidation_price_cents: int(), cure_blocks: int() }),
  default_terms: obj({ maturity_height: int(), grace_blocks: int(), recovery_height: int() }),
  settlement: { oneOf: [obj({ kind: { type: 'string', const: 'cosign-rgb' } }), obj({ kind: { type: 'string', const: 'ln-rln' }, atomic })] },
  scorer: obj({ provider: { type: 'string', enum: ['in-process', 'container', 'external'] }, scorer_id: { type: 'string', minLength: 1, maxLength: 100 }, code_measurement: { type: 'string', pattern: '^(source|sha256):[0-9a-f]{64}$' }, contract_hash: hex32, trust: { type: 'string', enum: ['dev-inprocess', 'software-evidence', 'hardware-attested'] }, result_hash: hex32, fallback: { type: 'boolean' }, recommendation: { type: 'string', enum: ['QUALIFY', 'QUALIFY_WITH_HAIRCUT', 'DECLINE', 'ESCALATE'] }, evidence: { oneOf: [obj({ kind: { type: 'string', const: 'external-evidence' }, evidence_sha256: hex32, reference: { type: 'string', minLength: 1, maxLength: 120 } }, ['reference']), obj({ kind: { type: 'string', const: 'passbook-run-record' }, run_record_sha256: hex32 })] }, check_receipt: obj({ contract_id: { type: 'string', pattern: '^rgb:[A-Za-z0-9~_.-]{10,120}$' }, commitment: hex32, operator_pk: hex32 }), check_bill: obj({ bill_hash: hex32, operator_pk: hex32, asset_id: { type: 'string', minLength: 1, maxLength: 200 }, amount: int(1), due: { type: 'string', const: 'at-close' } }) }, ['evidence', 'check_receipt', 'check_bill']),
  consent_hash: hex32,
  ladder_step: int(0, 10),
  signatures: obj({ borrower: sig, lender: sig }, ['borrower', 'lender']),
})

const BINDING_DOMAIN = 'passbook-termsheet-binding-v1'

/** The terms nonce that makes the on-chain terms hash commit to the whole sheet. */
export function bindingNonce(sheet: TermSheet): Hex {
  const { signatures: _signatures, ...rest } = sheet
  return hashObject({ domain: BINDING_DOMAIN, sheet: { ...rest, terms: { ...sheet.terms, nonce: undefined } } })
}

/** The term-sheet hash is the terms hash committed on chain; it refuses an unbound sheet. */
export function termSheetHash(sheet: TermSheet): Hex {
  if (sheet.terms.nonce !== bindingNonce(sheet)) throw new Error('term sheet is not bound to its terms nonce')
  return termsHash(sheet.terms)
}

export interface TermSheetInput {
  agreed: Position
  negotiation: { id: Hex; accept_hash: Hex }
  borrower_pk: Hex
  lender_pk: Hex
  platform_pk: Hex
  asset_id: string
  oracle_quote: OracleQuote
  grace_blocks: number
  ladder_step: number
  prev_passbook_txid: Hex | null
  /** The platform's published economics; DEFAULT_ECONOMICS when absent. */
  economics?: Economics
  /** From the agreed kind's adapter: `originate` on the lender's side for ln-rln. */
  settlement: SettlementParams
  /** New sheets are v2, so the evidence digest is required here. */
  scorer: TermSheetScorer & { evidence: TermSheetEvidence }
  consent_hash: Hex
  salt: Hex
}

export function buildTermSheet(i: TermSheetInput): TermSheet {
  if (i.settlement.kind !== i.agreed.settlement) throw new Error(`settlement params are ${i.settlement.kind}, the agreement says ${i.agreed.settlement}`)
  const e = i.economics ?? DEFAULT_ECONOMICS
  if (i.agreed.apr_bps > e.max_apr_bps) throw new Error(`agreed APR ${pct(i.agreed.apr_bps)} is above the ${pct(e.max_apr_bps)} cap`)
  const fee = termInterest(i.agreed, e)
  const debt = i.agreed.principal + fee
  const price = i.oracle_quote.price_cents
  const sats = collateralFor(debt, i.agreed.ltv_bps, price)
  const open = i.oracle_quote.height
  const draft = {
    borrower_pk: i.borrower_pk, lender_pk: i.lender_pk, platform_pk: i.platform_pk, asset_id: i.asset_id,
    principal: i.agreed.principal, fee, collateral_sats: sats, oracle_quote: i.oracle_quote,
    open_height: open, maturity_height: open + i.agreed.term_blocks, grace_blocks: i.grace_blocks,
    // Same recovery margin as LenderAgent.underwrite.
    recovery_height: open + i.agreed.term_blocks + i.grace_blocks + 20,
    ladder_step: i.ladder_step, ltv_bps: ltvBps(debt, sats, price), prev_passbook_txid: i.prev_passbook_txid, nonce: '00'.repeat(32),
  }
  const t = applySettlement(draft, i.settlement)
  const sheet: TermSheet = {
    v: 2, kind: 'passbook-termsheet', negotiation: i.negotiation, terms: t, binding_salt: i.salt,
    apr_bps: i.agreed.apr_bps, fees: { interest: fee, borrower_other: 0 },
    collateral: { sats, ltv_bps: t.ltv_bps, margin_call_ltv_bps: MARGIN_CALL_BPS, liquidation_ltv_bps: LIQUIDATION_BPS, margin_call_price_cents: priceAtLtv(debt, sats, MARGIN_CALL_BPS), liquidation_price_cents: priceAtLtv(debt, sats, LIQUIDATION_BPS), cure_blocks: CURE_BLOCKS },
    default_terms: { maturity_height: t.maturity_height, grace_blocks: t.grace_blocks, recovery_height: t.recovery_height },
    settlement: i.settlement, scorer: i.scorer, consent_hash: i.consent_hash, ladder_step: i.ladder_step, signatures: {},
  }
  sheet.terms = { ...t, nonce: bindingNonce(sheet) }
  validateTerms(sheet.terms, e)
  return sheet
}

export function signTermSheet(sheet: TermSheet, role: 'borrower' | 'lender', secretKey: Uint8Array): TermSheet {
  return { ...sheet, signatures: { ...sheet.signatures, [role]: signHash(termSheetHash(sheet), secretKey) } }
}

/** Every problem with a sheet; pass the verified agreement to check it was followed. */
export function termSheetProblems(sheet: TermSheet, ctx: { economics?: Economics; agreed?: Position; accept_hash?: Hex; requireSignatures?: boolean }): string[] {
  const problems = schemaErrors(sheet, TERMSHEET_SCHEMA)
  if (problems.length) return problems
  if (sheet.v === 2 && !sheet.scorer.evidence) return ['$.scorer.evidence: required in a v2 term sheet']
  if (sheet.v === 1 && sheet.scorer.evidence) return ['$.scorer.evidence: a v1 term sheet has no evidence digest; evidence needs v2']
  const t = sheet.terms
  const e = ctx.economics ?? DEFAULT_ECONOMICS
  try { validateTerms(t, e) } catch (err) { return [(err as Error).message] }
  if (sheet.apr_bps > e.max_apr_bps) problems.push(`APR ${pct(sheet.apr_bps)} is above the ${pct(e.max_apr_bps)} cap`)
  if (t.nonce !== bindingNonce(sheet)) problems.push('terms nonce does not bind this sheet')
  if (hashObject(settlementOf(t)) !== hashObject(sheet.settlement)) problems.push('settlement does not match the terms')
  const debt = debtOf(t)
  const term = t.maturity_height - t.open_height
  if (t.fee !== termInterest({ principal: t.principal, apr_bps: sheet.apr_bps, term_blocks: term }, e) || sheet.fees.interest !== t.fee) problems.push('fee does not follow from APR and term')
  const c = sheet.collateral
  if (c.sats !== t.collateral_sats || c.ltv_bps !== t.ltv_bps || c.ltv_bps !== ltvBps(debt, t.collateral_sats, t.oracle_quote.price_cents) || c.margin_call_price_cents !== priceAtLtv(debt, c.sats, c.margin_call_ltv_bps) || c.liquidation_price_cents !== priceAtLtv(debt, c.sats, c.liquidation_ltv_bps) || c.margin_call_ltv_bps !== MARGIN_CALL_BPS || c.liquidation_ltv_bps !== LIQUIDATION_BPS || c.cure_blocks !== CURE_BLOCKS) problems.push('collateral figures do not follow from the terms')
  const d = sheet.default_terms
  if (d.maturity_height !== t.maturity_height || d.grace_blocks !== t.grace_blocks || d.recovery_height !== t.recovery_height || sheet.ladder_step !== t.ladder_step) problems.push('default terms do not match the terms')
  if (ctx.agreed) {
    const a = ctx.agreed
    if (a.principal !== t.principal || a.apr_bps !== sheet.apr_bps || a.term_blocks !== term || a.settlement !== sheet.settlement.kind || collateralFor(debt, a.ltv_bps, t.oracle_quote.price_cents) !== t.collateral_sats) problems.push('sheet does not follow the accepted position')
  }
  if (ctx.accept_hash && sheet.negotiation.accept_hash !== ctx.accept_hash) problems.push('sheet names a different ACCEPT message')
  const hash = termsHash(t)
  for (const [role, pk] of [['borrower', t.borrower_pk], ['lender', t.lender_pk]] as const) {
    const s = sheet.signatures[role]
    if (s ? !verifyHash(s, hash, pk) : ctx.requireSignatures) problems.push(`${role} signature ${s ? 'invalid' : 'missing'}`)
  }
  return problems
}

const evidenceLine = (e: TermSheetEvidence | undefined) =>
  !e ? 'Evidence digest: none (v1 term sheet, issued before evidence binding).'
    : `Evidence: ${e.kind === 'external-evidence' ? `external evidence ${e.evidence_sha256.slice(0, 12)}…` : `sandbox run record ${e.run_record_sha256.slice(0, 12)}…`}, bound to this loan on Bitcoin.`

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
/** A share of principal as a percentage with two decimals, half-up, from integers. */
const shareOf = (part: Micro, whole: Micro) => `${(Number((BigInt(part) * 20_000n + BigInt(whole)) / (2n * BigInt(whole))) / 100).toFixed(2)}%`

/** The borrower's cost line and its required disclosure: principal + interest, nothing else, and the early-liquidation interest. */
export function borrowerCostLines(t: Pick<LoanTerms, 'principal' | 'fee' | 'open_height' | 'maturity_height'>, e: Pick<Economics, 'blocks_per_day'> = DEFAULT_ECONOMICS): string[] {
  const days = termDays(t.maturity_height - t.open_height, e)
  return [
    `You repay ${usdt(debtOf(t))} by day ${days}. No other fees.`,
    `If BTC falls and the loan is liquidated early, the lender still receives the full term's interest; on this ${days}-day loan that is ${usdt(t.fee)}, about ${shareOf(t.fee, t.principal)} of the amount borrowed.`,
  ]
}

/** The lender's line: gross interest, the platform's share after close, net and its annual rate. */
export function lenderReturnLine(t: Pick<LoanTerms, 'principal' | 'fee' | 'open_height' | 'maturity_height'>, e: Pick<Economics, 'blocks_per_day' | 'platform_share_bps'> = DEFAULT_ECONOMICS): string {
  const r = lenderReturn({ principal: t.principal, fee: t.fee, term_blocks: t.maturity_height - t.open_height }, e)
  return `Interest: ${usdt(r.gross)} gross, ${usdt(r.platform)} platform fee after close (${pct(r.share_bps)} of the interest, paid by you), ${usdt(r.net)} net (${pct(r.net_apr_bps)} a year).`
}

/** Plain language for the approval screen. Deterministic: code wrote every number here. */
export function renderTermSheet(sheet: TermSheet, opts: { audience: 'borrower' | 'lender'; economics?: Economics }): { title: string; lines: string[]; if_price_falls: string[]; if_not_repaid: string[]; settlement: string; scorer: string; final: string } {
  const t = sheet.terms
  const e = opts.economics ?? DEFAULT_ECONOMICS
  const you = opts.audience === 'borrower'
  const termBlocks = t.maturity_height - t.open_height
  const atomic = sheet.settlement.kind === 'ln-rln'
  return {
    title: you ? `Borrow ${usdt(t.principal)} against ${btc(t.collateral_sats)}` : `Lend ${usdt(t.principal)} against ${btc(t.collateral_sats)}`,
    lines: [
      `${you ? 'You receive' : 'You send'} ${usdt(t.principal)} (test USDT on regtest).`,
      ...(you
        ? borrowerCostLines(t, e)
        : [`You are repaid ${usdt(debtOf(t))} by day ${termDays(termBlocks, e)}.`, lenderReturnLine(t, e)]),
      `Term: ${termBlocks} blocks, until block ${t.maturity_height} (${e.blocks_per_day} block${e.blocks_per_day === 1 ? '' : 's'} per day). Interest ${usdt(sheet.fees.interest)} at ${pct(sheet.apr_bps)} APR, ${e.day_count}.`,
      `Collateral: ${btc(t.collateral_sats)} locked in a Taproot escrow at ${pct(t.ltv_bps)} loan-to-value (BTC at ${dollars(t.oracle_quote.price_cents)}).`,
    ],
    if_price_falls: [
      `If BTC falls to ${dollars(sheet.collateral.margin_call_price_cents)} (${pct(sheet.collateral.margin_call_ltv_bps)} LTV), a margin call gives ${you ? 'you' : 'the borrower'} ${sheet.collateral.cure_blocks} blocks to add collateral or repay.`,
      `At ${dollars(sheet.collateral.liquidation_price_cents)} (${pct(sheet.collateral.liquidation_ltv_bps)} LTV) after the cure window, the lender and the platform can liquidate: the lender takes exactly what is owed (${usdt(debtOf(t))}) in bitcoin at the oracle price and the rest returns to the borrower. No penalty; the only cost is the mining fee.`,
    ],
    if_not_repaid: [
      `After block ${t.maturity_height} plus ${t.grace_blocks} blocks of grace, an unpaid loan defaults and the lender can claim the collateral with the platform.`,
      `If nobody acts, the borrower can recover the collateral alone from block ${t.recovery_height}.`,
    ],
    settlement: atomic ? 'Repayment: over RGB Lightning. Paying the lender’s invoice reveals the secret that unlocks the bitcoin, in one step, with no co-signer.' : 'Repayment: over RGB, then the lender co-signs the release. If the lender refuses, the platform can co-sign instead.',
    scorer: `Credit check: ${sheet.scorer.provider}${sheet.scorer.fallback ? ' (FALLBACK, primary unavailable)' : ''}, ${sheet.scorer.trust} trust, recommendation ${sheet.scorer.recommendation}. ${evidenceLine(sheet.scorer.evidence)}${sheet.scorer.check_receipt ? ` Check receipt: RGB token ${sheet.scorer.check_receipt.contract_id} from check node ${sheet.scorer.check_receipt.operator_pk.slice(0, 12)}…, commitment ${sheet.scorer.check_receipt.commitment.slice(0, 12)}….` : ''}${sheet.scorer.check_bill ? ` Credit check billed at close, not paid up front: ${usdt(sheet.scorer.check_bill.amount)} added to the lender's platform fee at close.` : ''} No hardware attestation.`,
    final: 'Approving signs this exact term sheet. Once the collateral is locked, this can’t be undone.',
  }
}

export const isTermSheetHash = (h: unknown): h is Hex => isHex(h, 32)
