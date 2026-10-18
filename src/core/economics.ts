// The platform's published economics: what a loan costs, what the platform
// takes, and the bounds no offer, counter or registered terms may cross.
// Everything that shows or checks a money figure derived from a rate calls
// into this file, so the term sheet, the invoices, the agents and the
// dashboard always show the same number.
//
// Decisions (17 Oct 2026, docs/REVENUE.md):
// - The borrower pays principal plus the lender's term interest, nothing else.
// - The platform takes platform_share_bps of each loan's term interest, paid
//   by the lender in USDT after the loan closes, the same on every outcome.
// - No liquidation penalty; APR capped at max_apr_bps; the top ladder step
//   only for short terms (max_ltv_bps_by_term).
//
// Day count is ACT/365 over the term in days. The demo maps 1 month = 30
// blocks, so blocks_per_day is 1 there; on mainnet it would be 144.
//
// Rounding, one rule: every USDT figure computed from a rate (term interest,
// the platform share) is rounded half-up to 0.01 USDT (10,000 micro-USDT).
// The lender's net is gross minus the rounded share, so the three always add up.

import { BPS, type Bps, type Micro } from './money.js'

export interface Economics {
  /** Share of each loan's term interest the lender pays the platform after close. */
  platform_share_bps: Bps
  /** Highest APR the platform registers; conservative ceiling under the Italian usury threshold. */
  max_apr_bps: Bps
  /** Highest LTV for terms up to each length in days; a term longer than the last key is refused. */
  max_ltv_bps_by_term: Readonly<Record<string, Bps>>
  day_count: 'ACT/365'
  /** How heights map to days. The demo: 1 month = 30 blocks, so 1. Mainnet: 144. */
  blocks_per_day: number
  /** Blocks after a loan closes before an unpaid platform fee blocks the lender. */
  fee_grace_blocks: number
}

/** The demo deployment's economics; passbook.config.yaml carries the same values (test/economics.test.ts). */
export const DEFAULT_ECONOMICS: Economics = Object.freeze({
  platform_share_bps: 1500,
  max_apr_bps: 1900,
  max_ltv_bps_by_term: Object.freeze({ '30': 6500, '60': 6000, '90': 5500 }),
  day_count: 'ACT/365' as const,
  blocks_per_day: 1,
  fee_grace_blocks: 6,
})

export const CENT: Micro = 10_000
const DAYS_PER_YEAR = 365n

/** num / den micro-USDT, rounded half-up to 0.01 USDT. Non-negative inputs only. */
export function roundHalfUpCents(num: bigint, den: bigint): Micro {
  if (num < 0n || den <= 0n) throw new RangeError('roundHalfUpCents needs num >= 0 and den > 0')
  const cent = BigInt(CENT)
  return Number(((num + (den * cent) / 2n) / (den * cent)) * cent)
}

/** The term in days, as a whole number of days started (ceil). */
export function termDays(termBlocks: number, e: Pick<Economics, 'blocks_per_day'> = DEFAULT_ECONOMICS): number {
  return Math.ceil(termBlocks / e.blocks_per_day)
}

export interface InterestInput {
  principal: Micro
  apr_bps: Bps
  term_blocks: number
}

/**
 * The lender's interest for the whole term, ACT/365, half-up to 0.01 USDT:
 * principal × APR × days / 365. 600 USDT at 12% for 30 days is 5.92 USDT.
 * This is the `fee` in the loan terms: the borrower repays principal + this,
 * and owes it in full even if the loan is liquidated early.
 */
export function termInterest(x: InterestInput, e: Pick<Economics, 'blocks_per_day'> = DEFAULT_ECONOMICS): Micro {
  if (![x.principal, x.apr_bps, x.term_blocks].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new RangeError('termInterest needs non-negative integers')
  const num = BigInt(x.principal) * BigInt(x.apr_bps) * BigInt(x.term_blocks)
  const den = BigInt(e.blocks_per_day) * DAYS_PER_YEAR * BigInt(BPS)
  return roundHalfUpCents(num, den)
}

/** The platform's share of a loan's term interest, half-up to 0.01 USDT. */
export function platformShare(interest: Micro, e: Pick<Economics, 'platform_share_bps'> = DEFAULT_ECONOMICS): Micro {
  return roundHalfUpCents(BigInt(interest) * BigInt(e.platform_share_bps), BigInt(BPS))
}

export interface LenderReturn {
  gross: Micro
  platform: Micro
  net: Micro
  /** net interest annualised over the term, ACT/365, floor */
  net_apr_bps: Bps
  share_bps: Bps
}

/** What the lender keeps of a loan's interest: gross, the platform's share after close, net. */
export function lenderReturn(t: { principal: Micro; fee: Micro; term_blocks: number }, e: Pick<Economics, 'platform_share_bps' | 'blocks_per_day'> = DEFAULT_ECONOMICS): LenderReturn {
  const platform = platformShare(t.fee, e)
  const net = t.fee - platform
  return { gross: t.fee, platform, net, net_apr_bps: aprOf(t.principal, net, t.term_blocks, e), share_bps: e.platform_share_bps }
}

/** The APR an amount of interest represents over a term, ACT/365, in whole bps (floor). */
export function aprOf(principal: Micro, interest: Micro, termBlocks: number, e: Pick<Economics, 'blocks_per_day'> = DEFAULT_ECONOMICS): Bps {
  if (principal <= 0 || termBlocks <= 0) return 0
  return Number((BigInt(interest) * BigInt(BPS) * DAYS_PER_YEAR * BigInt(e.blocks_per_day)) / (BigInt(principal) * BigInt(termBlocks)))
}

/** Terms carry the interest (`fee`), not the APR: this is the APR it implies. */
export function impliedAprBps(t: { principal: Micro; fee: Micro; open_height: number; maturity_height: number }, e: Pick<Economics, 'blocks_per_day'> = DEFAULT_ECONOMICS): Bps {
  return aprOf(t.principal, t.fee, t.maturity_height - t.open_height, e)
}

/**
 * Whether a term's interest is no more than an APR gives. Binding rather than
 * deriving: the fee may not exceed termInterest at that APR for this principal
 * and term under the same rounding rule, so cent rounding never trips it.
 */
export function feeWithinApr(t: { principal: Micro; fee: Micro; term_blocks: number }, aprBps: Bps, e: Pick<Economics, 'blocks_per_day'> = DEFAULT_ECONOMICS): boolean {
  return t.fee <= termInterest({ principal: t.principal, apr_bps: aprBps, term_blocks: t.term_blocks }, e)
}

/** Whether a term's interest is inside the APR cap (feeWithinApr at max_apr_bps). */
export function feeWithinCap(t: { principal: Micro; fee: Micro; term_blocks: number }, e: Pick<Economics, 'max_apr_bps' | 'blocks_per_day'> = DEFAULT_ECONOMICS): boolean {
  return feeWithinApr(t, e.max_apr_bps, e)
}

/** Buckets in ascending days. */
export function ltvBuckets(e: Pick<Economics, 'max_ltv_bps_by_term'> = DEFAULT_ECONOMICS): { days: number; max_ltv_bps: Bps }[] {
  return Object.entries(e.max_ltv_bps_by_term).map(([days, bps]) => ({ days: Number(days), max_ltv_bps: bps })).sort((a, b) => a.days - b.days)
}

/** The highest LTV allowed for a term, or 0 when the term is longer than any bucket. */
export function maxLtvForTerm(termBlocks: number, e: Pick<Economics, 'max_ltv_bps_by_term' | 'blocks_per_day'> = DEFAULT_ECONOMICS): Bps {
  const days = termDays(termBlocks, e)
  return ltvBuckets(e).find((b) => days <= b.days)?.max_ltv_bps ?? 0
}

/** The longest term in blocks any LTV is allowed for. */
export function maxTermBlocks(e: Pick<Economics, 'max_ltv_bps_by_term' | 'blocks_per_day'> = DEFAULT_ECONOMICS): number {
  return (ltvBuckets(e).at(-1)?.days ?? 0) * e.blocks_per_day
}

/** What the platform publishes next to its key and the oracle key (/state, infra/state.json). */
export function publishedEconomics(e: Economics = DEFAULT_ECONOMICS): Economics & { rounding: string; usury_note: string } {
  return {
    platform_share_bps: e.platform_share_bps,
    max_apr_bps: e.max_apr_bps,
    max_ltv_bps_by_term: { ...e.max_ltv_bps_by_term },
    day_count: e.day_count,
    blocks_per_day: e.blocks_per_day,
    fee_grace_blocks: e.fee_grace_blocks,
    rounding: 'half-up to 0.01 USDT',
    usury_note: 'max_apr_bps is a conservative ceiling under the Italian usury threshold (19.10% for Q4 2026 per docs/REVENUE.md); to confirm with counsel',
  }
}

/** Every reason these economics are unusable; empty when valid. */
export function economicsProblems(e: Economics): string[] {
  const problems: string[] = []
  const int = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
  if (!int(e.platform_share_bps, 0, BPS)) problems.push('platform_share_bps must be an integer from 0 to 10000')
  if (!int(e.max_apr_bps, 1, 100 * BPS)) problems.push('max_apr_bps must be an integer from 1 to 1000000')
  if (e.day_count !== 'ACT/365') problems.push('day_count must be ACT/365')
  if (!int(e.blocks_per_day, 1, 1_000)) problems.push('blocks_per_day must be an integer from 1 to 1000')
  if (!int(e.fee_grace_blocks, 0, 1_000_000)) problems.push('fee_grace_blocks must be an integer from 0 to 1000000')
  const keys = Object.keys(e.max_ltv_bps_by_term ?? {})
  if (!keys.length) problems.push('max_ltv_bps_by_term needs at least one { days: max_ltv_bps } entry')
  for (const k of keys) {
    if (!/^[1-9][0-9]{0,4}$/.test(k)) problems.push(`max_ltv_bps_by_term: ${k} is not a whole number of days`)
    if (!int(e.max_ltv_bps_by_term[k], 1, BPS - 1)) problems.push(`max_ltv_bps_by_term.${k} must be an integer from 1 to 9999`)
  }
  const buckets = ltvBuckets(e)
  if (buckets.some((b, i) => i > 0 && b.max_ltv_bps > buckets[i - 1].max_ltv_bps)) problems.push('max_ltv_bps_by_term must not allow a higher LTV for a longer term')
  return problems
}
