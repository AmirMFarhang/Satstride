// What goes into the sandbox and what comes out. The bundle is the borrower's
// raw material and never leaves the sandbox process; the result carries only
// pass/fail checks, coarse summaries and a disclosure proposal, and is signed
// by the sandbox key so the lender can tell it was produced inside the box.

import type { Hex } from '../core/crypto.js'
import type { Bps, Micro, Sats } from '../core/money.js'
import type { OracleQuote } from '../core/terms.js'
import type { OfferRequirements } from '../market/messages.js'
import type { AiTrace, Category } from '../ai/types.js'

export interface HistoryRow {
  txid: Hex
  height: number
  direction: 'in' | 'out'
  amount: Micro
  counterparty_pk: Hex
  memo: string
}

export interface CandidateInflow {
  txid: Hex
  height: number
  amount: Micro
  payer_pk: Hex
  /** payer's Schnorr signature over hashObject({ txid, amount, borrower_pk }) */
  payer_sig: Hex
}

export interface ScheduledOutflow {
  label: string
  every_blocks: number
  next_height: number
  amount: Micro
}

export interface Bundle {
  v: 1
  borrower_pk: Hex
  /** other keys the borrower controls, so transfers between them are not income */
  own_pks: Hex[]
  offer_id: string
  loan_request: { principal: Micro; fee: Micro; term_blocks: number; grace_blocks: number }
  lender_requirements: OfferRequirements
  /** current USDT balance */
  balance: Micro
  history: HistoryRow[]
  asset_id?: string
  history_proof?: import('./reconcile.js').HistoryProof
  candidate_inflows: CandidateInflow[]
  scheduled_outflows: ScheduledOutflow[]
  collateral: { sats: Sats; oracle_quote: OracleQuote; allowed_ltv_bps: Bps }
  /** The borrower's consent receipt for this run (negotiated loans). The sandbox checks it before processing and signs its hash into the result. */
  consent?: import('../scorer/consent.js').ConsentReceipt
}

export interface CheckResult {
  id: 'injection' | 'categorise' | 'affordability' | 'headroom' | 'inflows' | 'sybil' | 'disclosure' | 'investigation' | 'reconcile'
  ok: boolean
  /** safe to show the lender */
  detail: string
}

export interface DisclosureItem {
  txid: Hex
  amount: Micro
  height: number
  payer_pk: Hex
  reason: string
}

export interface SandboxSummary {
  history_months: number
  income_monthly_median: Micro
  fixed_outflows_monthly: Micro
  categories: Record<Category, number>
  projected_balance_at_maturity: Micro
  ltv_bps: Bps
  /** Private, conservatively treated as outstanding after confirmed loan-like income. */
  investigation_debt_micro?: Micro
  history_metrics?: import('./metrics.js').HistoryMetrics
  income_tiers?: import('./income-tiers.js').IncomeTiers
}

export interface ResultTrace {
  task: AiTrace['task']
  engine: string
  ms: number
  fallback: string | null
}

export interface SandboxResult {
  v: 1
  sandbox_pk: Hex
  bundle_hash: Hex
  offer_id: string
  borrower_pk: Hex
  /** Public request checked inside the box; bound by both result signatures. */
  loan_request: Bundle['loan_request']
  height: number
  checks: CheckResult[]
  summary: SandboxSummary
  disclosure_proposal: DisclosureItem[]
  /** which engine did which task and how long it took; never the model's output, which names history rows */
  model_trace: ResultTrace[]
  sig: Hex
  /** Separately signed lender view: no balance or unapproved payment details. */
  lender_result?: LenderSandboxResult
  investigation?: import('./investigation-types.js').PublicInvestigation
  investigation_borrower_note?: string
  asset_id?: string
  income_evidence?: { basis: 'reconciled_tiers'; qualified: boolean; enough_months: boolean; enough_counted_income: boolean; income_band: string; tier_counts: { signed: number; recurring: number; business: number; excluded: number } }
  reconciliation?: Pick<import('./reconcile.js').ReconcileResult, 'status' | 'reasons' | 'assurance'>
  typology_scores?: ReturnType<typeof import('./typologies.js').scoreTypologies>
  run_record?: import('./run-record.js').SignedRunRecord
  /** consentHash of the receipt the sandbox checked before processing; absent when the bundle carried none. */
  consent_hash?: Hex
}

export type LenderSandboxResult = Omit<SandboxResult, 'summary' | 'disclosure_proposal' | 'lender_result' | 'investigation_borrower_note'> & { disclosure_commitments: Hex[] }

export function validateBundle(b: unknown): asserts b is Bundle {
  const x = b as Bundle
  if (!x || typeof x !== 'object' || x.v !== 1) throw new TypeError('bundle.v must be 1')
  if (typeof x.borrower_pk !== 'string' || x.borrower_pk.length !== 64) throw new TypeError('bundle.borrower_pk required')
  if (!Array.isArray(x.own_pks)) throw new TypeError('bundle.own_pks must be an array')
  if (typeof x.offer_id !== 'string') throw new TypeError('bundle.offer_id required')
  const lr = x.loan_request
  if (!lr || !Number.isInteger(lr.principal) || lr.principal <= 0 || !Number.isInteger(lr.fee) || !Number.isInteger(lr.term_blocks) || !Number.isInteger(lr.grace_blocks))
    throw new TypeError('bundle.loan_request invalid')
  const req = x.lender_requirements
  if (!req || typeof req.affordability !== 'boolean' || !Number.isInteger(req.inflow_months) || !Number.isInteger(req.inflow_multiple_bps))
    throw new TypeError('bundle.lender_requirements invalid')
  if (req.reconciliation !== undefined && !['required', 'optional'].includes(req.reconciliation)) throw new TypeError('bundle reconciliation policy invalid')
  if (x.asset_id !== undefined && (typeof x.asset_id !== 'string' || x.asset_id.length > 200)) throw new TypeError('bundle asset invalid')
  if (x.history_proof && (typeof x.history_proof !== 'object' || !Array.isArray(x.history_proof.transfers) || x.history_proof.transfers.length > 200 || !Array.isArray(x.history_proof.allocations) || x.history_proof.allocations.length > 200)) throw new TypeError('history proof exceeds bounded capacity')
  if (req.investigation !== undefined && !['required', 'optional'].includes(req.investigation)) throw new TypeError('bundle investigation policy invalid')
  if (!Number.isInteger(x.balance) || x.balance < 0) throw new TypeError('bundle.balance invalid')
  if (x.consent !== undefined && (!x.consent || typeof x.consent !== 'object' || Array.isArray(x.consent))) throw new TypeError('bundle.consent invalid')
  for (const name of ['history', 'candidate_inflows', 'scheduled_outflows'] as const) {
    if (!Array.isArray(x[name])) throw new TypeError(`bundle.${name} must be an array`)
  }
  if (x.history.length > 200 || x.candidate_inflows.length > 200) throw new TypeError('bundle history exceeds bounded investigation capacity')
  if (new Set(x.history.map((r) => r.txid)).size !== x.history.length || new Set(x.candidate_inflows.map((r) => r.txid)).size !== x.candidate_inflows.length) throw new TypeError('bundle transaction references must be unique')
  for (const r of x.history) {
    if (typeof r.txid !== 'string' || !Number.isInteger(r.height) || (r.direction !== 'in' && r.direction !== 'out') || !Number.isInteger(r.amount) || r.amount <= 0)
      throw new TypeError('bundle.history row invalid')
    if (typeof r.counterparty_pk !== 'string' || typeof r.memo !== 'string') throw new TypeError('bundle.history row invalid')
  }
  for (const c of x.candidate_inflows) {
    if (typeof c.txid !== 'string' || !Number.isInteger(c.height) || !Number.isInteger(c.amount) || typeof c.payer_pk !== 'string' || typeof c.payer_sig !== 'string')
      throw new TypeError('bundle.candidate_inflows item invalid')
  }
  for (const s of x.scheduled_outflows) {
    if (typeof s.label !== 'string' || !Number.isInteger(s.every_blocks) || s.every_blocks <= 0 || !Number.isInteger(s.next_height) || !Number.isInteger(s.amount) || s.amount < 0)
      throw new TypeError('bundle.scheduled_outflows item invalid')
  }
  const c = x.collateral
  if (!c || !Number.isInteger(c.sats) || c.sats <= 0 || !c.oracle_quote || !Number.isInteger(c.allowed_ltv_bps)) throw new TypeError('bundle.collateral invalid')
}
