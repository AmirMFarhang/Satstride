import type { Prompt } from '../ai/prompts.js'
import type { Hex } from '../core/crypto.js'
import type { Bundle } from './types.js'

export const FINDING_TYPES = ['prefunded_inflow', 'circular_flow', 'income_is_loan', 'new_payer', 'irregular_genuine', 'injection_attempt', 'fan_in_burst', 'pass_through'] as const
export type FindingType = typeof FINDING_TYPES[number]
export interface ProposedFinding { type: FindingType; evidence: string[] }
export interface EvidenceEntry { id: string; tool: ToolName; args: Record<string, unknown>; result: unknown; error?: string; elapsed_ms?: number }
export interface InvestigationPolicy { verdict: 'clean' | 'concerns' | 'fraud' | 'failed'; reason_codes: string[]; hard_stops: string[]; coverage_gaps: string[] }
export interface ProposedIncomeTier { tier: 'tier_1' | 'tier_2' | 'tier_3' | 'out'; evidence: string[] }
export interface InvestigationReport {
  verdict: 'clean' | 'concerns' | 'fraud'
  findings: ProposedFinding[]
  payer_tiers?: ProposedIncomeTier[]
}
export type InvestigationAction = { action: 'tool'; name: ToolName; args: { pk?: string; txid?: string; txids?: string[]; blocks?: number } } | { action: 'finish'; report: InvestigationReport }
export const TOOL_NAMES = ['list_counterparties', 'flows_with', 'outflows_before', 'month_table', 'payer_profile', 'read_memos'] as const
export type ToolName = typeof TOOL_NAMES[number]
export interface PayerProfile {
  known_lender: boolean
  known_borrower: boolean
  passbook_pages: number
  first_seen_height?: number
  disbursement_txids?: Hex[]
}
export interface InvestigationContext { verifiedHistory?: boolean; verifiedCounterparties?: Set<Hex>; payerProfile?: (pk: Hex) => Promise<PayerProfile> }
export interface InvestigationEvidence {
  bundle: Bundle
  currentHeight: number
  blocksPerMonth: number
  validInflows: Set<Hex>
  redactedTxids: Set<Hex>
  profiles: Map<Hex, PayerProfile>
  trustedInflows: Set<Hex>
  verifiedHistory: boolean
  verifiedCounterparties: Set<Hex>
  resolveTxid(ref: string): Hex | undefined
  resolvePk(ref: string): Hex | undefined
}
export interface InvestigationTools {
  execute(name: ToolName, args: Extract<InvestigationAction, { action: 'tool' }>['args']): Promise<unknown>
}
export interface InvestigationStep { n: number; tool: string; argsSummary: string; ms: number; model: string; tokens_per_second: number | null }
export interface InvestigationRequest {
  borrower: string
  history_rows: number
  required_months: number
  tools: InvestigationTools
  /** Read-only deterministic review; errors can be corrected within the same turn budget. */
  reviewReport?: (report: InvestigationReport, ledger: EvidenceEntry[]) => string[]
  record?: {
    recordTool(input: { name: string; args: Record<string, unknown>; evidenceId: string; result: unknown; elapsedMs: number; error?: string }): void
    recordModel(input: { request: unknown; response: unknown; elapsedMs: number }): void
    recordDecision(input: { report: InvestigationReport; accepted: boolean; reasonCodes: string[] }): void
  }
  budgetMs?: number
  onStep?: (step: InvestigationStep) => void
}
export type InvestigationRun =
  | { status: 'not_run'; model: string; reason: string; turns: number; tokens_per_second: number | null }
  | { status: 'failed'; model: string; reason: string; turns: number; tokens_per_second: number | null }
  | { status: 'done'; model: string; report: InvestigationReport; evidence: EvidenceEntry[]; turns: number; tokens_per_second: number | null }
export interface ConfirmedFinding { type: FindingType; txids: Hex[]; payers: Hex[] }
export interface ConfirmedInvestigation {
  findings: ConfirmedFinding[]
  hallucinations: number
  rejected: number
  excludedPayers: Set<Hex>
  irregularIncomeMedian?: number
}
export interface PublicInvestigation {
  status: InvestigationRun['status']
  verdict?: InvestigationReport['verdict']
  findings: { type: FindingType; count: number }[]
  lender_note: string
  model: string
  turns: number
  tokens_per_second: number | null
  hallucinations: number
  rejected: number
  reason?: string
  policy?: InvestigationPolicy
}
export type InvestigationCompletion = (prompt: Prompt, timeoutMs: number) => Promise<{ value: unknown; tokensPerSecond?: number; request?: unknown; response?: unknown }>
