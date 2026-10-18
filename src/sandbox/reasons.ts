// Borrower-private descriptive bars. These are not an eligibility score.
import type { HistoryMetrics } from './metrics.js'
import type { ReconcileResult } from './reconcile.js'
import type { scoreTypologies } from './typologies.js'
export function privateReasonBars(metrics: HistoryMetrics, reconciliation: ReconcileResult, scores: ReturnType<typeof scoreTypologies>) {
  const months = metrics.cash_flow.months.length
  const ratio = (value: number | null) => value === null ? null : Math.max(0, Math.min(10000, Math.round(value)))
  return { basis: 'Block-height proxies; partial months and same-block ordering are conservative.', history_assurance: reconciliation.status, rows: [
    { id: 'cashflow', label: 'Months with nonnegative net flow', value_bps: months ? ratio((months - metrics.cash_flow.negative_net_months) * 10000 / months) : null, detail: `${months - metrics.cash_flow.negative_net_months} of ${months} observed months` },
    { id: 'buffer', label: 'Time above the near-zero buffer', value_bps: metrics.buffer.status === 'verified' && metrics.buffer.near_zero_block_share_bps !== null ? ratio(10000 - metrics.buffer.near_zero_block_share_bps) : null, detail: metrics.buffer.status === 'verified' ? 'Verified balance; share of observed blocks' : 'Buffer proof unavailable' },
    { id: 'obligations', label: 'Recurring outflows / observed income', value_bps: ratio(metrics.obligations.recurring_outflows_share_bps), detail: 'Observed recurrence; declared bills are checked separately' },
    { id: 'payers', label: 'Largest payer concentration', value_bps: ratio(metrics.income_quality.top_payer_share_bps), detail: `${metrics.income_quality.payer_count} locally observed payers` },
    { id: 'tenure', label: 'History toward three demo months', value_bps: ratio(metrics.tenure.history_length_blocks * 10000 / (3 * metrics.evidence_quality.blocks_per_month)), detail: `${metrics.tenure.history_length_blocks} blocks; longest dormant period ${metrics.tenure.longest_dormant_blocks} blocks` },
    { id: 'patterns', label: 'Confirmed pattern score', value_bps: ratio(scores.score * 100), detail: scores.typologies.filter((t) => t.matched).map((t) => t.type.replaceAll('_', ' ')).join(', ') || 'No confirmed screening patterns' },
  ] }
}
