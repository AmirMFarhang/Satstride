// Architecture credit: Tazama's rule -> weighted typology -> threshold model.
// Vocabulary credit: IBM AMLSim fan_in / gather_scatter. Thresholds below are
// Passbook demo policy, not Tazama/IBM production rules or calibrated AML claims.
import type { FindingType } from './investigation-types.js'
import { metricHistory, metricMedian, metricRatioBps, metricSum } from './metrics.js'
import type { Bundle } from './types.js'

export type TypologyType = FindingType | 'fan_in_burst' | 'pass_through'
export interface TypologyContext { currentHeight: number; blocksPerMonth: number }
export interface TypologyRule { id: string; matched: boolean }
export interface TypologyDetection {
  type: 'fan_in_burst' | 'pass_through'
  matched: boolean
  /** Private support for grounding. The caller maps these records to ledger evidence IDs. */
  txids: string[]
  payers: string[]
  rules: TypologyRule[]
  measures: Record<string, number | string | null>
  limitations: string[]
}

export const TYPOLOGY_POLICY_VERSION = 'passbook-demo-typologies-v1'
export const FAN_IN_THRESHOLDS = Object.freeze({ baseline_months: 3, min_nonzero_baseline_months: 2, min_new_payers: 5, surge_multiple_bps: 30_000, min_new_payer_share_bps: 8_000, max_new_payment_of_baseline_bps: 5_000 })
export const PASS_THROUGH_THRESHOLDS = Object.freeze({ max_delay_blocks: 3, min_qualifying_inflows: 3, min_distinct_inflow_heights: 3, min_forwarded_per_inflow_bps: 8_000, min_qualifying_value_share_bps: 8_000 })

const reaches = (value: number, denominator: number, threshold: number) => BigInt(value) * 10000n >= BigInt(denominator) * BigInt(threshold)
const atMost = (value: number, denominator: number, threshold: number) => BigInt(value) * 10000n <= BigInt(denominator) * BigInt(threshold)
type HistoryBundle = Pick<Bundle, 'history' | 'borrower_pk' | 'own_pks'>

/** Local novelty is all the ego history establishes. Never infer global account age. */
export function detectFanInBurst(bundle: HistoryBundle, context: TypologyContext): TypologyDetection {
  const rows = metricHistory(bundle.history, context), own = new Set([bundle.borrower_pk, ...bundle.own_pks])
  const incoming = rows.filter((r) => r.direction === 'in' && !own.has(r.counterparty_pk))
  const age = (height: number) => Math.floor((context.currentHeight - height) / context.blocksPerMonth)
  const recent = incoming.filter((r) => age(r.height) === 0)
  const baseline = incoming.filter((r) => age(r.height) >= 1 && age(r.height) <= FAN_IN_THRESHOLDS.baseline_months)
  const monthly = Array.from({ length: FAN_IN_THRESHOLDS.baseline_months }, (_, i) => metricSum(baseline.filter((r) => age(r.height) === i + 1).map((r) => r.amount)))
  const median = metricMedian(monthly)!
  const firstSeen = new Map<string, number>()
  for (const r of rows) if (!firstSeen.has(r.counterparty_pk)) firstSeen.set(r.counterparty_pk, r.height)
  const newRows = recent.filter((r) => age(firstSeen.get(r.counterparty_pk)!) === 0)
  const payers = [...new Set(newRows.map((r) => r.counterparty_pk))].sort()
  const recentTotal = metricSum(recent.map((r) => r.amount)), newTotal = metricSum(newRows.map((r) => r.amount))
  const requiredStart = context.currentHeight - (FAN_IN_THRESHOLDS.baseline_months + 1) * context.blocksPerMonth + 1
  const rules: TypologyRule[] = [
    { id: 'baseline_observed', matched: !!rows.length && rows[0].height <= requiredStart && monthly.filter((n) => n > 0).length >= FAN_IN_THRESHOLDS.min_nonzero_baseline_months && median > 0 },
    { id: 'many_locally_new_payers', matched: payers.length >= FAN_IN_THRESHOLDS.min_new_payers },
    { id: 'income_surges', matched: median > 0 && reaches(recentTotal, median, FAN_IN_THRESHOLDS.surge_multiple_bps) },
    { id: 'new_payers_dominate', matched: recentTotal > 0 && reaches(newTotal, recentTotal, FAN_IN_THRESHOLDS.min_new_payer_share_bps) },
    { id: 'each_new_payment_small', matched: newRows.length > 0 && median > 0 && newRows.every((r) => atMost(r.amount, median, FAN_IN_THRESHOLDS.max_new_payment_of_baseline_bps)) },
  ]
  return { type: 'fan_in_burst', matched: rules.every((r) => r.matched), txids: [...baseline, ...recent].map((r) => r.txid), payers, rules, measures: { baseline_monthly_median_micro: median, recent_inflow_micro: recentTotal, new_payer_inflow_micro: newTotal, new_payers: payers.length, recent_multiple_bps: metricRatioBps(recentTotal, median), novelty_basis: 'first_observed_in_supplied_history' }, limitations: ['Local first observation is not global account age.', 'A burst is a screening pattern, not proof of laundering or eligible income.', 'Completeness and Bitcoin anchors must be verified separately.'] }
}

/** Match each outgoing unit at most once. Temporal matching is a cash-flow
 * proxy; an ego history cannot prove which incoming asset funded an outgoing. */
export function detectPassThrough(bundle: HistoryBundle, context: TypologyContext): TypologyDetection {
  const rows = metricHistory(bundle.history, context), own = new Set([bundle.borrower_pk, ...bundle.own_pks])
  const incoming = rows.filter((r) => r.direction === 'in' && !own.has(r.counterparty_pk))
  const outgoing = rows.filter((r) => r.direction === 'out' && !own.has(r.counterparty_pk)).map((r) => ({ ...r, remaining: r.amount }))
  const qualifying: typeof incoming = [], support = new Set<string>()
  let matchedOutflow = 0
  for (const inflow of incoming) {
    const needed = Number((BigInt(inflow.amount) * BigInt(PASS_THROUGH_THRESHOLDS.min_forwarded_per_inflow_bps) + 9999n) / 10000n)
    const eligible = outgoing.filter((out) => out.height > inflow.height && out.height <= inflow.height + PASS_THROUGH_THRESHOLDS.max_delay_blocks && out.remaining > 0)
    if (metricSum(eligible.map((out) => out.remaining)) < needed) continue
    let remaining = needed
    const used: string[] = []
    for (const out of eligible) {
      // Same-block order is unknown, and a row after the ask is not evidence.
      const amount = Math.min(remaining, out.remaining)
      if (amount > 0) { out.remaining -= amount; remaining -= amount; used.push(out.txid) }
      if (remaining === 0) break
    }
    matchedOutflow += needed
    qualifying.push(inflow)
    support.add(inflow.txid)
    for (const txid of used) support.add(txid)
  }
  const total = metricSum(incoming.map((r) => r.amount)), qualifyingValue = metricSum(qualifying.map((r) => r.amount))
  const rules: TypologyRule[] = [
    { id: 'repeated_fast_forwarding', matched: qualifying.length >= PASS_THROUGH_THRESHOLDS.min_qualifying_inflows },
    { id: 'distinct_inflow_heights', matched: new Set(qualifying.map((r) => r.height)).size >= PASS_THROUGH_THRESHOLDS.min_distinct_inflow_heights },
    { id: 'most_inflow_value_forwarded', matched: total > 0 && reaches(qualifyingValue, total, PASS_THROUGH_THRESHOLDS.min_qualifying_value_share_bps) },
  ]
  return { type: 'pass_through', matched: rules.every((r) => r.matched), txids: [...support].sort(), payers: [...new Set(qualifying.map((r) => r.counterparty_pk))].sort(), rules, measures: { qualifying_inflows: qualifying.length, total_inflows: incoming.length, matched_outflow_micro: matchedOutflow, qualifying_value_share_bps: metricRatioBps(qualifyingValue, total), forwarding_window_blocks: PASS_THROUGH_THRESHOLDS.max_delay_blocks }, limitations: ['Temporal amount matching is not RGB coin lineage.', 'Same-block order is unknown and is not matched.', 'This does not prove a low wallet balance; use reconciled buffer metrics.', 'Known obligations can create this pattern; it is a screening alert, not proof of crime.'] }
}

export const TYPOLOGY_WEIGHTS: Readonly<Record<TypologyType, number>> = Object.freeze({ prefunded_inflow: 90, circular_flow: 100, income_is_loan: 60, new_payer: 25, irregular_genuine: 0, injection_attempt: 40, fan_in_burst: 60, pass_through: 70 })
export const TYPOLOGY_SCORE_THRESHOLDS = Object.freeze({ alert: 25, block: 90 })
export type TypologyDisposition = 'clear' | 'alert' | 'block'
const disposition = (score: number): TypologyDisposition => score >= TYPOLOGY_SCORE_THRESHOLDS.block ? 'block' : score >= TYPOLOGY_SCORE_THRESHOLDS.alert ? 'alert' : 'clear'

/** Only call after code grounding. No model-provided weight, count, verdict or
 * money field is read. Duplicate and benign findings cannot dilute risk. */
export function scoreTypologies(confirmed: readonly { type: TypologyType }[]) {
  const types = new Set<TypologyType>()
  for (const finding of confirmed) {
    if (!Object.hasOwn(TYPOLOGY_WEIGHTS, finding.type)) throw new TypeError('unknown confirmed typology')
    types.add(finding.type)
  }
  const typologies = (Object.keys(TYPOLOGY_WEIGHTS) as TypologyType[]).map((type) => {
    const score = types.has(type) ? TYPOLOGY_WEIGHTS[type] : 0
    return { type, matched: types.has(type), weight: TYPOLOGY_WEIGHTS[type], score, ...TYPOLOGY_SCORE_THRESHOLDS, disposition: disposition(score) }
  })
  const score = Math.min(100, typologies.reduce((sum, t) => sum + t.score, 0))
  return { policy: TYPOLOGY_POLICY_VERSION, typologies, score, ...TYPOLOGY_SCORE_THRESHOLDS, disposition: disposition(score) }
}
