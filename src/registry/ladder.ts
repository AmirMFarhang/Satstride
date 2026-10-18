// The credit ladder and the risk thresholds. Pure functions of verified
// history; nothing here reads a model output. Numbers come from the market
// survey in docs/HANDOFF.md section 7.

import type { Bps, Micro, PriceCents, Sats } from '../core/money.js'
import { ltvBps, priceAtLtv } from '../core/money.js'

export const LADDER_BPS: readonly Bps[] = [5000, 5500, 6000, 6500]
export const MAX_STEP = LADDER_BPS.length - 1
export const MARGIN_CALL_BPS: Bps = 7000
export const LIQUIDATION_BPS: Bps = 8000
export const HARD_STOP_BPS: Bps = 8500
// No liquidation penalty, origination or platform fee on the borrower here: the
// borrower pays principal + the lender's interest only, and the platform's
// share is invoiced to the lender after close (src/core/economics.ts).
/** Blocks the borrower gets to cure a margin call before lender + platform may liquidate. */
export const CURE_BLOCKS = 10
/** Blocks after the lock within which the lender must fund, else borrower + platform refund. */
export const FUND_TIMEOUT_BLOCKS = 10

export type LoanOutcome = 'on_time' | 'late' | 'defaulted' | 'liquidated' | 'refunded' | 'open'

export interface HistoryEntry {
  open_height: number
  outcome: LoanOutcome
}

export interface LadderState {
  step: number
  allowed_ltv_bps: Bps
  on_time: number
  late: number
  defaults: number
  open: number
}

/**
 * Walk the history in order of opening. Each on-time repayment climbs one step;
 * a late repayment holds the step; a default or liquidation resets it to zero.
 * Refunded and still-open loans do not move the ladder.
 */
export function ladderFromHistory(history: HistoryEntry[]): LadderState {
  const sorted = [...history].sort((a, b) => a.open_height - b.open_height)
  const s: LadderState = { step: 0, allowed_ltv_bps: LADDER_BPS[0], on_time: 0, late: 0, defaults: 0, open: 0 }
  for (const h of sorted) {
    switch (h.outcome) {
      case 'on_time':
        s.on_time += 1
        s.step = Math.min(MAX_STEP, s.step + 1)
        break
      case 'late':
        s.late += 1
        break
      case 'defaulted':
      case 'liquidated':
        s.defaults += 1
        s.step = 0
        break
      case 'open':
        s.open += 1
        break
      case 'refunded':
        break
    }
  }
  s.allowed_ltv_bps = LADDER_BPS[s.step]
  return s
}

export function allowedLtvForStep(step: number): Bps {
  return LADDER_BPS[Math.max(0, Math.min(MAX_STEP, step))]
}

export interface Headroom {
  ltv_bps: Bps
  margin_call_price_cents: PriceCents
  liquidation_price_cents: PriceCents
  /** Percentage drop from the current price to each threshold, in bps of the price. */
  drop_to_margin_call_bps: Bps
  drop_to_liquidation_bps: Bps
  state: 'healthy' | 'margin_call' | 'liquidatable' | 'hard_stop'
}

export function headroom(debt: Micro, collateralSats: Sats, priceCents: PriceCents): Headroom {
  const ltv = ltvBps(debt, collateralSats, priceCents)
  const mc = priceAtLtv(debt, collateralSats, MARGIN_CALL_BPS)
  const liq = priceAtLtv(debt, collateralSats, LIQUIDATION_BPS)
  const drop = (target: PriceCents) => Math.max(0, Math.round(((priceCents - target) / priceCents) * 10_000))
  const state = ltv >= HARD_STOP_BPS ? 'hard_stop' : ltv >= LIQUIDATION_BPS ? 'liquidatable' : ltv >= MARGIN_CALL_BPS ? 'margin_call' : 'healthy'
  return {
    ltv_bps: ltv,
    margin_call_price_cents: mc,
    liquidation_price_cents: liq,
    drop_to_margin_call_bps: drop(mc),
    drop_to_liquidation_bps: drop(liq),
    state,
  }
}

export interface LiquidationDue {
  ok: boolean
  headroom: Headroom
  /** LTV at or above LIQUIDATION_BPS */
  at_liquidation: boolean
  /** the cure window has run out, or the hard stop makes waiting moot */
  cure_over: boolean
  cure_until_height?: number
}

/**
 * The liquidation rule, shared by the platform (before it adds its leaf B
 * signature) and the lender (before it asks): LTV at 80% or more, and either the
 * margin call raised at `marginCallHeight` has had CURE_BLOCKS to cure, or the
 * hard stop at 85% is reached.
 */
export function liquidationDue(debt: Micro, collateralSats: Sats, priceCents: PriceCents, marginCallHeight: number | undefined, height: number): LiquidationDue {
  const h = headroom(debt, collateralSats, priceCents)
  const cure_until_height = marginCallHeight === undefined ? undefined : marginCallHeight + CURE_BLOCKS
  const at_liquidation = h.ltv_bps >= LIQUIDATION_BPS
  const cure_over = (cure_until_height !== undefined && height >= cure_until_height) || h.ltv_bps >= HARD_STOP_BPS
  return { ok: at_liquidation && cure_over, headroom: h, at_liquidation, cure_over, cure_until_height }
}
