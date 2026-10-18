// The five things a local model is asked to do. Each has a strict JSON schema
// (sent to QVAC as response_format) and a validator the guard runs on the way
// back. No task output moves money, sets a limit or is signed; the numbers that
// matter are computed in code and the model labels, selects, drafts or explains.

import type { Bps, Micro } from '../core/money.js'

/**
 * `loan_disbursement` is borrowed money arriving (a Passbook loan or any other):
 * it is labelled so it is not left unknown, and it is never income, so it adds
 * nothing to the affordability projection. The debt it creates reaches the
 * lender through the borrower's signed outstanding statement instead.
 */
export const CATEGORIES = ['income', 'transfer_self', 'rent_or_fixed_bill', 'loan_disbursement', 'loan_repayment', 'discretionary', 'unknown'] as const
export type Category = (typeof CATEGORIES)[number]

export interface CategoriseRow {
  txid: string
  direction: 'in' | 'out'
  amount: Micro
  height: number
  counterparty_pk: string
  memo: string
  /** what the rules already know: interval regularity etc. */
  hints: string[]
}

export interface CategoriseOutput {
  rows: { txid: string; category: Category; confidence: number }[]
}

export interface DiscloseInput {
  requirement: { inflow_months: number; inflow_multiple_bps: Bps; repayment: Micro }
  candidates: { txid: string; amount: Micro; height: number; payer_pk: string; month_index: number }[]
}

export interface DiscloseOutput {
  selected_txids: string[]
  reason: string
}

export interface CreditMemoInput {
  policy_adjustment_bps?: number
  lender: string
  tenor_blocks: number
  principal: Micro
  passbook: { on_time: number; late: number; defaults: number; open: number; step: number; unverified: number }
  verified_inflows: { count: number; sum: Micro; months_covered: number }
  checks: { id: string; ok: boolean; detail: string }[]
  /** Who ran the checks, for the memo text: the sandbox unless a scorer's released outputs (e.g. Compex). */
  checks_by?: string
  base_apr_bps: Bps
  band: [number, number]
}

export interface CreditMemo {
  adjustment_bps: number
  flags: string[]
  memo: string
}

export interface ExplainSplitInput {
  principal: Micro
  fee: Micro
  collateral_sats: number
  price_cents: number
  maturity_height: number
  grace_blocks: number
  lender_sats_on_default: number
  borrower_sats_on_default: number
}

export interface MarginNoteInput {
  ltv_bps: Bps
  price_cents: number
  margin_call_price_cents: number
  liquidation_price_cents: number
  cure_until_height?: number
  debt: Micro
  collateral_sats: number
}

export interface Reasoner {
  /** e.g. "rules", "qvac-http:qwen3-4b" */
  readonly engine: string
  categorise(rows: CategoriseRow[]): Promise<CategoriseOutput>
  disclose(input: DiscloseInput): Promise<DiscloseOutput>
  creditMemo(input: CreditMemoInput): Promise<CreditMemo>
  explainSplit(input: ExplainSplitInput): Promise<string>
  marginNote(input: MarginNoteInput): Promise<string>
  investigate(input: import('../sandbox/investigation-types.js').InvestigationRequest): Promise<import('../sandbox/investigation-types.js').InvestigationRun>
}

export type AiTask = 'categorise' | 'disclose' | 'creditMemo' | 'explainSplit' | 'marginNote' | 'investigate'

export interface AiTrace {
  engine: string
  task: AiTask
  ms: number
  output: unknown
  fallbackReason?: string
}

export const CATEGORISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['txid', 'category', 'confidence'],
        properties: {
          txid: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const

export const DISCLOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['selected_txids', 'reason'],
  properties: {
    selected_txids: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
} as const

export const MEMO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // flags and memo come first so a model writing in schema order reasons before it picks the number
  required: ['flags', 'memo', 'adjustment_bps'],
  properties: {
    flags: { type: 'array', items: { type: 'string' } },
    memo: { type: 'string' },
    adjustment_bps: { type: 'integer' },
  },
} as const

export const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
} as const

export function isCategoriseOutput(v: unknown): v is CategoriseOutput {
  const x = v as CategoriseOutput
  return (
    !!x &&
    Array.isArray(x.rows) &&
    x.rows.every(
      (r) => typeof r.txid === 'string' && (CATEGORIES as readonly string[]).includes(r.category) && typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1,
    )
  )
}

/**
 * A label that contradicts the money's direction is wrong whatever the model says:
 * money in is never rent or discretionary spending, money out is never income.
 * (Loan flows go both ways: a lender receives repayments and sends disbursements.)
 */
export function categoryFitsDirection(category: Category, direction: 'in' | 'out'): boolean {
  if (direction === 'in') return category !== 'rent_or_fixed_bill' && category !== 'discretionary'
  return category !== 'income'
}

export function isDiscloseOutput(v: unknown): v is DiscloseOutput {
  const x = v as DiscloseOutput
  return !!x && Array.isArray(x.selected_txids) && x.selected_txids.every((t) => typeof t === 'string') && typeof x.reason === 'string'
}

export function isCreditMemo(v: unknown): v is CreditMemo {
  const x = v as CreditMemo
  return !!x && Number.isInteger(x.adjustment_bps) && Array.isArray(x.flags) && x.flags.every((f) => typeof f === 'string') && typeof x.memo === 'string'
}

export function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}
