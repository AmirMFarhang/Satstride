// Private descriptive metrics. These functions neither prove the history nor
// choose loan amounts. Reconciliation and income tiering are separate checks.
import type { Bundle, HistoryRow } from './types.js'

export interface HistoryMetricOptions {
  currentHeight: number
  blocksPerMonth: number
  /** Balance immediately before the first supplied row. Never infer it from the closing balance. */
  openingBalance?: number
  balanceBasis?: 'reconciled' | 'reported'
  /** Required to label a buffer verified; supplied by the reconciliation verifier. */
  provenCurrentBalance?: number
  /** Height of the proven first transfer, not a public/global account creation date. */
  provenHistoryStart?: number
  knownLenders?: ReadonlySet<string>
}

export interface MetricMonth {
  age: number
  start_height: number
  end_height: number
  observed_blocks: number
  inflow_micro: number
  outflow_micro: number
  net_micro: number
  transactions: number
}

export interface HistoryMetrics {
  v: 1
  evidence_quality: {
    history: 'supplied_ego_history'
    history_start: 'proven_first_transfer' | 'first_supplied_row' | 'unknown'
    balance: 'reconciled' | 'reported' | 'unavailable'
    time: 'block_height_proxy_not_wall_clock_days'
    blocks_per_month: number
    same_block_order: 'unknown_conservative_balance_lower_bound'
  }
  cash_flow: { months: MetricMonth[]; monthly_net_mean_micro: number | null; monthly_net_stddev_micro: number | null; negative_net_months: number }
  buffer: {
    status: 'verified' | 'reported' | 'unavailable' | 'inconsistent'
    reason_codes: string[]
    near_zero_threshold_micro: number | null
    /** Duration weighted by observed blocks, not transaction counts or actual days. */
    near_zero_block_share_bps: number | null
    monthly_lowest_balance_micro: { age: number; lower_bound_micro: number }[] | null
  }
  obligations: {
    /** A stable recurring payment is an obligation proxy, not proof of a contract. */
    recurring_outflows: { counterparty_pk: string; months: number; monthly_micro: number }[]
    recurring_outflows_monthly_micro: number
    recurring_outflows_share_bps: number | null
    declared_schedule_monthly_micro: number
    known_lender_repayments_micro: number
    known_lender_inflows_micro: number
  }
  income_quality: {
    basis: 'observed_external_non_lender_inflows_not_eligible_income'
    payers: { pk: string; inflow_micro: number; payments: number; paid_months: number; first_observed_height: number; last_observed_height: number; observed_span_blocks: number }[]
    payer_count: number
    top_payer_share_bps: number | null
    monthly_inflow_median_micro: number | null
  }
  tenure: {
    history_length_blocks: number
    active_months: number
    longest_dormant_blocks: number
    dormant_periods: { start_height: number; end_height: number; blocks: number }[]
    recent_month_transactions: number
    earlier_month_transaction_median: number | null
    recent_activity_multiple_bps: number | null
  }
}

export const MAX_METRIC_MONTHS = 120
export const MAX_METRIC_ROWS = 200
export type HistoryMetricBundle = Pick<Bundle, 'history' | 'borrower_pk' | 'own_pks' | 'balance' | 'scheduled_outflows'>

export const metricMedian = (values: readonly number[]): number | null => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  const sum = BigInt(s[m - 1] ?? s[m]) + BigInt(s[m])
  return s.length % 2 ? s[m] : Number(sum / 2n - (sum < 0n && sum % 2n !== 0n ? 1n : 0n))
}

export function metricSum(values: readonly number[]): number {
  const result = values.reduce((n, value) => n + BigInt(value), 0n)
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('history aggregate exceeds safe integer range')
  return Number(result)
}

export function metricRatioBps(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  const value = BigInt(numerator) * 10000n / BigInt(denominator)
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('metric ratio exceeds safe integer range')
  return Number(value)
}

/** Reject incomplete numeric domains instead of silently dropping future/invalid rows. */
export function metricHistory(history: readonly HistoryRow[], opts: Pick<HistoryMetricOptions, 'currentHeight' | 'blocksPerMonth'>): HistoryRow[] {
  if (!Number.isSafeInteger(opts.currentHeight) || opts.currentHeight < 0 || !Number.isSafeInteger(opts.blocksPerMonth) || opts.blocksPerMonth < 1) throw new RangeError('invalid metric height or month size')
  if (history.length > MAX_METRIC_ROWS || new Set(history.map((r) => r.txid)).size !== history.length) throw new RangeError('history is too large or has duplicate transaction references')
  for (const r of history) {
    if (!Number.isSafeInteger(r.height) || r.height < 0 || r.height > opts.currentHeight || !Number.isSafeInteger(r.amount) || r.amount <= 0 || !['in', 'out'].includes(r.direction) || !r.txid || !r.counterparty_pk) throw new RangeError('invalid history row for metrics')
  }
  metricSum(history.map((r) => r.amount))
  return [...history].sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid))
}

const monthAge = (height: number, opts: HistoryMetricOptions) => Math.floor((opts.currentHeight - height) / opts.blocksPerMonth)
const validBalance = (n: number | undefined) => n !== undefined && Number.isSafeInteger(n) && n >= 0

function buffers(rows: HistoryRow[], months: MetricMonth[], income: number | null, b: HistoryMetricBundle, opts: HistoryMetricOptions): HistoryMetrics['buffer'] {
  const unavailable = (status: HistoryMetrics['buffer']['status'], reason: string): HistoryMetrics['buffer'] => ({ status, reason_codes: [reason], near_zero_threshold_micro: null, near_zero_block_share_bps: null, monthly_lowest_balance_micro: null })
  if (!rows.length) return unavailable('unavailable', 'no_observed_history')
  if (!validBalance(opts.openingBalance)) return unavailable('unavailable', 'opening_balance_unknown')
  if (opts.balanceBasis === 'reconciled' && !validBalance(opts.provenCurrentBalance)) return unavailable('unavailable', 'proven_current_balance_missing')
  const closing = opts.balanceBasis === 'reconciled' ? opts.provenCurrentBalance! : b.balance
  if (!validBalance(closing)) return unavailable('unavailable', 'current_balance_unknown')
  const expected = metricSum([opts.openingBalance!, ...rows.map((r) => r.direction === 'in' ? r.amount : -r.amount)])
  if (expected !== closing) return unavailable('inconsistent', 'opening_plus_flows_differs_from_current_balance')
  const threshold = Math.floor((income ?? 0) / 20) // at most 5% of the observed monthly inflow median
  let balance = opts.openingBalance!, nearBlocks = 0
  const lows: { age: number; lower_bound_micro: number }[] = []
  for (const m of months) {
    let lowest = balance, cursor = m.start_height
    const heights = [...new Set(rows.filter((r) => r.height >= m.start_height && r.height <= m.end_height).map((r) => r.height))]
    for (const height of heights) {
      if (balance <= threshold) nearBlocks += height - cursor
      const at = rows.filter((r) => r.height === height)
      const outgoing = metricSum(at.filter((r) => r.direction === 'out').map((r) => r.amount))
      const incoming = metricSum(at.filter((r) => r.direction === 'in').map((r) => r.amount))
      // Bitcoin heights do not establish order within a block. This bound is
      // conservative and never invents a negative spendable wallet balance.
      lowest = Math.min(lowest, Math.max(0, balance - outgoing))
      balance = metricSum([balance, incoming, -outgoing])
      if (balance < 0) return unavailable('inconsistent', 'negative_balance_after_block')
      lowest = Math.min(lowest, balance)
      cursor = height
    }
    if (balance <= threshold) nearBlocks += m.end_height + 1 - cursor
    lows.push({ age: m.age, lower_bound_micro: lowest })
  }
  return { status: opts.balanceBasis === 'reconciled' ? 'verified' : 'reported', reason_codes: [], near_zero_threshold_micro: threshold, near_zero_block_share_bps: metricRatioBps(nearBlocks, metricSum(months.map((m) => m.observed_blocks))), monthly_lowest_balance_micro: lows }
}

export function computeHistoryMetrics(bundle: HistoryMetricBundle, opts: HistoryMetricOptions): HistoryMetrics {
  const rows = metricHistory(bundle.history, opts)
  const first = rows[0]?.height
  if (opts.provenHistoryStart !== undefined && (!Number.isSafeInteger(opts.provenHistoryStart) || opts.provenHistoryStart !== first)) throw new RangeError('proven first transfer does not match supplied history start')
  const oldest = first === undefined ? -1 : monthAge(first, opts)
  if (oldest >= MAX_METRIC_MONTHS) throw new RangeError('history spans more than the bounded metric month capacity')
  const months: MetricMonth[] = []
  for (let age = oldest; age >= 0; age--) {
    const start = Math.max(first!, opts.currentHeight - (age + 1) * opts.blocksPerMonth + 1, 0), end = opts.currentHeight - age * opts.blocksPerMonth
    const within = rows.filter((r) => monthAge(r.height, opts) === age)
    const inflow = metricSum(within.filter((r) => r.direction === 'in').map((r) => r.amount)), outflow = metricSum(within.filter((r) => r.direction === 'out').map((r) => r.amount))
    months.push({ age, start_height: start, end_height: end, observed_blocks: end - start + 1, inflow_micro: inflow, outflow_micro: outflow, net_micro: inflow - outflow, transactions: within.length })
  }
  const own = new Set([bundle.borrower_pk, ...bundle.own_pks])
  const incomeRows = rows.filter((r) => r.direction === 'in' && !own.has(r.counterparty_pk) && !opts.knownLenders?.has(r.counterparty_pk))
  const payerKeys = [...new Set(incomeRows.map((r) => r.counterparty_pk))].sort()
  const payers = payerKeys.map((pk) => {
    const paid = incomeRows.filter((r) => r.counterparty_pk === pk)
    return { pk, inflow_micro: metricSum(paid.map((r) => r.amount)), payments: paid.length, paid_months: new Set(paid.map((r) => monthAge(r.height, opts))).size, first_observed_height: paid[0].height, last_observed_height: paid.at(-1)!.height, observed_span_blocks: paid.at(-1)!.height - paid[0].height }
  })
  const monthlyIncome = months.map((m) => metricSum(incomeRows.filter((r) => monthAge(r.height, opts) === m.age).map((r) => r.amount)))
  const incomeMedian = metricMedian(monthlyIncome)
  const outgoing = rows.filter((r) => r.direction === 'out' && !own.has(r.counterparty_pk) && !opts.knownLenders?.has(r.counterparty_pk))
  const recurring: HistoryMetrics['obligations']['recurring_outflows'] = []
  for (const pk of [...new Set(outgoing.map((r) => r.counterparty_pk))].sort()) {
    const payments = outgoing.filter((r) => r.counterparty_pk === pk)
    if (payments.length < 3 || new Set(payments.map((r) => monthAge(r.height, opts))).size !== payments.length) continue
    const amount = metricMedian(payments.map((r) => r.amount))!
    const stableAmounts = payments.every((r) => BigInt(Math.abs(r.amount - amount)) * 10000n <= BigInt(amount) * 1000n)
    const stableTiming = payments.slice(1).every((r, i) => Math.abs(r.height - payments[i].height - opts.blocksPerMonth) <= Math.max(2, Math.floor(opts.blocksPerMonth / 5)))
    if (stableAmounts && stableTiming) recurring.push({ counterparty_pk: pk, months: payments.length, monthly_micro: amount })
  }
  const recurringMonthly = metricSum(recurring.map((r) => r.monthly_micro))
  const schedule = metricSum(bundle.scheduled_outflows.map((r) => {
    if (!Number.isSafeInteger(r.amount) || r.amount < 0 || !Number.isSafeInteger(r.every_blocks) || r.every_blocks <= 0) throw new RangeError('invalid declared outflow schedule')
    const monthly = BigInt(r.amount) * BigInt(opts.blocksPerMonth) / BigInt(r.every_blocks)
    if (monthly > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('scheduled obligation exceeds safe integer range')
    return Number(monthly)
  }))
  const activeHeights = [...new Set(rows.map((r) => r.height))]
  const gaps: { start_height: number; end_height: number; blocks: number }[] = []
  for (let i = 0; i < activeHeights.length; i++) {
    const start = activeHeights[i] + 1, end = i + 1 < activeHeights.length ? activeHeights[i + 1] - 1 : opts.currentHeight
    if (end >= start) gaps.push({ start_height: start, end_height: end, blocks: end - start + 1 })
  }
  const mean = months.length ? metricSum(months.map((m) => m.net_micro)) / months.length : null
  const earlier = metricMedian(months.filter((m) => m.age > 0).map((m) => m.transactions))
  const recent = months.find((m) => m.age === 0)?.transactions ?? 0
  const buffer = buffers(rows, months, incomeMedian, bundle, opts)
  return {
    v: 1,
    evidence_quality: { history: 'supplied_ego_history', history_start: opts.provenHistoryStart === undefined ? first === undefined ? 'unknown' : 'first_supplied_row' : 'proven_first_transfer', balance: buffer.status === 'verified' ? 'reconciled' : buffer.status === 'reported' ? 'reported' : 'unavailable', time: 'block_height_proxy_not_wall_clock_days', blocks_per_month: opts.blocksPerMonth, same_block_order: 'unknown_conservative_balance_lower_bound' },
    cash_flow: { months, monthly_net_mean_micro: mean === null ? null : Math.round(mean), monthly_net_stddev_micro: mean === null ? null : Math.round(Math.sqrt(months.reduce((sum, m) => sum + (m.net_micro - mean) ** 2, 0) / months.length)), negative_net_months: months.filter((m) => m.net_micro < 0).length },
    buffer,
    obligations: { recurring_outflows: recurring, recurring_outflows_monthly_micro: recurringMonthly, recurring_outflows_share_bps: metricRatioBps(recurringMonthly, incomeMedian ?? 0), declared_schedule_monthly_micro: schedule, known_lender_repayments_micro: metricSum(rows.filter((r) => r.direction === 'out' && opts.knownLenders?.has(r.counterparty_pk)).map((r) => r.amount)), known_lender_inflows_micro: metricSum(rows.filter((r) => r.direction === 'in' && opts.knownLenders?.has(r.counterparty_pk)).map((r) => r.amount)) },
    income_quality: { basis: 'observed_external_non_lender_inflows_not_eligible_income', payers, payer_count: payers.length, top_payer_share_bps: metricRatioBps(Math.max(0, ...payers.map((p) => p.inflow_micro)), metricSum(payers.map((p) => p.inflow_micro))), monthly_inflow_median_micro: incomeMedian },
    tenure: { history_length_blocks: first === undefined ? 0 : opts.currentHeight - first + 1, active_months: months.filter((m) => m.transactions > 0).length, longest_dormant_blocks: Math.max(0, ...gaps.map((g) => g.blocks)), dormant_periods: gaps.filter((g) => g.blocks >= opts.blocksPerMonth), recent_month_transactions: recent, earlier_month_transaction_median: earlier, recent_activity_multiple_bps: metricRatioBps(recent, earlier ?? 0) },
  }
}
