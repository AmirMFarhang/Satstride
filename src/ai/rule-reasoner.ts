// Deterministic stand-in for the local model. The demo runs on it by default
// so anyone can reproduce it; QVAC replaces it with one environment variable.
// It is also the fallback whenever the model's output fails schema validation.

import { btc, pct, usdt } from '../core/money.js'
import type {
  CategoriseOutput,
  CategoriseRow,
  Category,
  CreditMemo,
  CreditMemoInput,
  DiscloseInput,
  DiscloseOutput,
  ExplainSplitInput,
  MarginNoteInput,
  Reasoner,
} from './types.js'

/** Text aimed at software rather than at a person. Anything matching is never shown to a model. */
export const INJECTION = /(ignore|disregard) (all |any |previous |prior |the )*instructions|^\s*(system|assistant|user)\s*:|override (the )?(policy|limits?|checks?)|approve (this|the|it|payment|immediately|the loan)|you are now|do not (tell|report)/im

/** A memo naming a loan flow: the borrower's own label on a disbursement or a repayment. */
export const LOAN_MEMO = /\bloan\b|repay|installment|instalment|disburs/i

export class RuleReasoner implements Reasoner {
  readonly engine: string = 'rules'

  async investigate(): Promise<import('../sandbox/investigation-types.js').InvestigationRun> {
    return { status: 'not_run', model: this.engine, reason: 'Local AI is disabled; fixed checks are not an investigation.', turns: 0, tokens_per_second: null }
  }

  async categorise(rows: CategoriseRow[]): Promise<CategoriseOutput> {
    return {
      rows: rows.map((r) => {
        const memo = r.memo.toLowerCase()
        let category: Category = 'unknown'
        let confidence = 0.4
        // A loan memo wins over the periodic hint: a lender's disbursements can look regular, and borrowed money is never income.
        const loanFlow = LOAN_MEMO.test(memo)
        if (r.hints.includes('self')) [category, confidence] = ['transfer_self', 0.9]
        else if (loanFlow && r.direction === 'in' && !/repay/.test(memo)) [category, confidence] = ['loan_disbursement', 0.8]
        else if (loanFlow) [category, confidence] = ['loan_repayment', 0.8]
        else if (r.direction === 'in' && (r.hints.includes('periodic') || /salary|payroll|wage|stipend/.test(memo))) [category, confidence] = ['income', 0.8]
        else if (r.direction === 'out' && (r.hints.includes('periodic') || /rent|lease|mortgage|utility|electric|internet|phone|insurance/.test(memo)))
          [category, confidence] = ['rent_or_fixed_bill', 0.8]
        else if (r.direction === 'out') [category, confidence] = ['discretionary', 0.5]
        return { txid: r.txid, category, confidence }
      }),
    }
  }

  /** Smallest set by count that covers the required months and the required sum. */
  async disclose(input: DiscloseInput): Promise<DiscloseOutput> {
    const needSum = Math.ceil((input.requirement.repayment * input.requirement.inflow_multiple_bps) / 10_000)
    const months = new Set<number>()
    const selected: string[] = []
    let sum = 0
    const byAmount = [...input.candidates].sort((a, b) => b.amount - a.amount)
    // First cover each required month with its largest inflow, then top up by amount.
    for (let m = 0; m < input.requirement.inflow_months; m++) {
      const best = byAmount.find((c) => c.month_index === m && !selected.includes(c.txid))
      if (best) {
        selected.push(best.txid)
        months.add(m)
        sum += best.amount
      }
    }
    for (const c of byAmount) {
      if (sum >= needSum) break
      if (!selected.includes(c.txid)) {
        selected.push(c.txid)
        sum += c.amount
      }
    }
    return {
      selected_txids: selected,
      reason: `${selected.length} inflow(s) covering ${months.size} of ${input.requirement.inflow_months} months, ${usdt(sum)} against ${usdt(needSum)} required`,
    }
  }

  async creditMemo(i: CreditMemoInput): Promise<CreditMemo> {
    const flags: string[] = []
    let adj = 0
    if (i.passbook.on_time === 0) {
      flags.push('fresh key')
      adj += 50
    }
    if (i.passbook.defaults > 0) {
      flags.push(`${i.passbook.defaults} default(s) on chain`)
      adj += 100 * i.passbook.defaults
    }
    if (i.passbook.late > 0) {
      flags.push('late repayment(s)')
      adj += 25
    }
    if (i.passbook.unverified > 0) {
      flags.push('registry claims Bitcoin could not confirm')
      adj += 25
    }
    if (i.checks.some((c) => !c.ok)) {
      flags.push(`failed ${i.checks_by ?? 'sandbox'} check: ${i.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`)
      adj += 50
    }
    if (i.passbook.on_time >= 3 && i.passbook.defaults === 0) {
      flags.push('seasoned key')
      adj -= 25
    }
    const [lo, hi] = i.band
    const adjustment_bps = Math.max(lo, Math.min(hi, adj))
    const memo =
      `${i.lender}: ${i.passbook.on_time} on time, ${i.passbook.late} late, ${i.passbook.defaults} defaulted, step ${i.passbook.step}. ` +
      `${i.verified_inflows.count} verified inflow(s) totalling ${usdt(i.verified_inflows.sum)} over ${i.verified_inflows.months_covered} month(s). ` +
      `${i.checks.filter((c) => c.ok).length}/${i.checks.length} ${i.checks_by ?? 'sandbox'} checks passed. Base ${pct(i.base_apr_bps)}, adjustment ${adjustment_bps >= 0 ? '+' : ''}${adjustment_bps} bps.`
    return { adjustment_bps, flags, memo }
  }

  async explainSplit(i: ExplainSplitInput): Promise<string> {
    return (
      `You borrow ${usdt(i.principal)} and owe ${usdt(i.principal + i.fee)} by block ${i.maturity_height}. ` +
      `Your ${btc(i.collateral_sats)} stays locked. If you have not repaid ${i.grace_blocks} blocks after that, ` +
      `the lender can take ${btc(i.lender_sats_on_default)} (what you owe at today's price of ${(i.price_cents / 100).toLocaleString('en-US')} per BTC) ` +
      `and you get ${btc(i.borrower_sats_on_default)} back. Nobody can change these numbers after you sign.`
    )
  }

  async marginNote(i: MarginNoteInput): Promise<string> {
    const state = i.ltv_bps >= 8000 ? 'The lender may now liquidate.' : i.ltv_bps >= 7000 ? `Margin call: repay part or add BTC before block ${i.cure_until_height ?? '?'}.` : 'You are safe for now.'
    return (
      `Your loan is at ${pct(i.ltv_bps)} loan-to-value with BTC at ${(i.price_cents / 100).toLocaleString('en-US')}. ` +
      `A margin call starts at ${(i.margin_call_price_cents / 100).toLocaleString('en-US')} and liquidation at ${(i.liquidation_price_cents / 100).toLocaleString('en-US')}. ${state}`
    )
  }
}
