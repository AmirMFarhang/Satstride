// Plain words for the stops, written on this phone from the terms by fixed rules (no model):
// every number in them is a field of the terms or the escrow's own split. M4 (local QVAC
// explanations) would only reword these; it never produces a number.
import { debtOf, type LoanTerms } from '../../../../src/core/terms.js'
import { FUND_TIMEOUT_BLOCKS } from '../../../../src/registry/ladder.js'
import { btc, usd, usdNum } from './format'

export interface SplitPreview { lender_sats_on_default: number; borrower_sats_on_default: number; locktime: number }

/** Stop 2, borrower: what accepting means. */
export function borrowerAgreement(t: LoanTerms, lender: string, split: SplitPreview): { text: string; rows: [string, string][] } {
  return {
    text: `You borrow ${usd(t.principal)} and owe ${usdNum(debtOf(t))} by block ${t.maturity_height}. Your bitcoin stays locked until then. If you haven't paid by block ${split.locktime}, ${lender} takes ${btc(split.lender_sats_on_default)} of it and the rest comes back to you.`,
    rows: [
      [`If ${lender} never pays`, `refund with the platform after ${FUND_TIMEOUT_BLOCKS} blocks`],
      [`If unpaid by block ${split.locktime}`, `${lender} gets ${btc(split.lender_sats_on_default)}`],
      ['If everyone disappears', `yours alone after block ${t.recovery_height}`],
    ],
  }
}

/** The lender's stop: what funding means. */
export function lenderAgreement(t: LoanTerms, borrower: string, split: SplitPreview): { text: string; rows: [string, string][] } {
  return {
    text: `You send ${usd(t.principal)} to ${borrower} once their ${btc(t.collateral_sats)} is locked on Bitcoin. They owe you ${usdNum(debtOf(t))} by block ${t.maturity_height}. If they haven't paid by block ${split.locktime}, you can take ${btc(split.lender_sats_on_default)} of their bitcoin.`,
    rows: [
      ['You get back', usd(debtOf(t))],
      [`If unpaid by block ${split.locktime}`, `you get ${btc(split.lender_sats_on_default)}`],
      ['If bitcoin falls far', 'margin call, then sale with the platform'],
    ],
  }
}
