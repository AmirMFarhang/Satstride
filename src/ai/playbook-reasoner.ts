// Deterministic baseline using the same completion/tool/grounding interface.
// Design ported from Compex Fraud Desk (Apache-2.0); no Python service runs.
import { RuleReasoner } from './rule-reasoner.js'
import type { Prompt } from './prompts.js'
import { investigate } from '../sandbox/investigate.js'
import type { InvestigationCompletion, InvestigationRequest, InvestigationRun } from '../sandbox/investigation-types.js'

type Flow = { ref: string; height: number; month: number; direction: string; amount_usdt: number; payer: string; signed_inflow: boolean; known_lender?: boolean; known_disbursement?: boolean }
type Overview = { distinct_signed_incoming_payer_count: number; redacted_memo_refs: string[]; months: { month: number; flows: Flow[] }[] }
export const playbookCompletion: InvestigationCompletion = async (prompt: Prompt) => {
  const state = JSON.parse(prompt.messages.find((m) => m.role === 'user')!.content) as { observations: { id: string; tool: string; result: unknown }[]; decision_rejection_codes: string[] }
  const overview = state.observations.find((e) => e.tool === 'month_table')
  if (!overview) return { value: { action: 'tool', name: 'month_table', args: {} } }
  const table = overview.result as Overview
  const rows = table.months.flatMap((m) => m.flows)
  const findings: { type: string; evidence: string[] }[] = []
  const incoming = rows.filter((r) => r.direction === 'in' && r.signed_inflow)
  const outgoing = rows.filter((r) => r.direction === 'out')
  let fraud = false
  for (const payer of new Set(incoming.map((r) => r.payer))) {
    const paid = incoming.filter((r) => r.payer === payer)
    const prefundedMonths = new Set(paid.filter((r) => outgoing.some((o) => o.payer !== payer && o.height < r.height && r.height - o.height <= 5 && Math.abs(o.amount_usdt - r.amount_usdt) <= r.amount_usdt * 0.05)).map((r) => r.month))
    if (prefundedMonths.size >= 2) { findings.push({ type: 'prefunded_inflow', evidence: [overview.id] }); fraud = true; break }
    const returned = outgoing.filter((o) => o.payer === payer).reduce((n, o) => n + o.amount_usdt, 0)
    if (returned >= paid.reduce((n, r) => n + r.amount_usdt, 0) * 0.5) { findings.push({ type: 'circular_flow', evidence: [overview.id] }); fraud = true; break }
  }
  const loan = incoming.some((r) => r.known_lender || r.known_disbursement)
  // A mixed lender/nonlender month table does not ground a universal loan
  // finding. The baseline declines to invent a more specific citation.
  if (!fraud && loan && incoming.every((r) => r.known_lender || r.known_disbursement)) findings.push({ type: 'income_is_loan', evidence: [overview.id] })
  if (!fraud && !loan && table.distinct_signed_incoming_payer_count >= 3 && table.months.every((m) => m.flows.some((r) => r.direction === 'in' && r.signed_inflow))) findings.push({ type: 'irregular_genuine', evidence: [overview.id] })
  if (table.redacted_memo_refs.length) findings.push({ type: 'injection_attempt', evidence: [overview.id] })
  return { value: { action: 'finish', report: { verdict: fraud ? 'fraud' : findings.some((f) => f.type !== 'irregular_genuine') ? 'concerns' : 'clean', findings } } }
}
export class PlaybookReasoner extends RuleReasoner {
  override readonly engine = 'playbook:passbook-v1'
  override async investigate(request?: InvestigationRequest): Promise<InvestigationRun> {
    if (!request) return { status: 'failed', model: this.engine, reason: 'MISSING_REQUEST', turns: 0, tokens_per_second: null }
    return investigate(request, playbookCompletion, this.engine)
  }
}
