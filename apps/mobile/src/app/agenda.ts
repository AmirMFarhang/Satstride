// The agenda's loans (D1's src/ui/agenda) from what this phone holds: the borrower's loans whose
// collateral is locked (accepted terms that never locked are not debt) and the lender's loans whose
// collateral is locked, each at the stage its own records show. Nothing is estimated here; the
// agenda turns heights into countdowns.
import { debtOf } from '../../../../src/core/terms.js'
import type { PhoneAgentState } from '../agent/borrower'
import type { PhoneLenderState } from '../agent/lender'
import type { AgendaLoan, BlockSeen, LoanStage } from '../ui/agenda/agenda-model'

const REPAYING = new Set(['repaying', 'iou', 'releasing'])

/** A raised margin call moves the deadline earlier (the cure window), so the agenda must know it. */
const marginCall = (calls: Record<string, number> | undefined, id: string): { margin_call_height?: number } =>
  calls && Number.isSafeInteger(calls[id]) && calls[id] > 0 ? { margin_call_height: calls[id] } : {}

/** The loans still running (locked, not repaid or released): the ones whose platform record can carry a margin call. */
export const runningLoanIds = (loans: AgendaLoan[]): string[] => loans.filter((l) => l.stage === 'locked' || l.stage === 'funded' || l.stage === 'repaying').map((l) => l.id)

export function agendaLoans(
  borrower: PhoneAgentState,
  lender: PhoneLenderState,
  ctx: {
    flowLoanId?: string; flowStage?: string; pageIds: string[]; name: (role: 'Lender' | 'Borrower', pk: string) => string
    /** the height the platform raised a margin call at, per loan, from its loan record (PhoneLoanRecord.margin_call_height) */
    marginCalls?: Record<string, number>
  },
): AgendaLoan[] {
  const out: AgendaLoan[] = []
  for (const [id, l] of Object.entries(borrower.loans)) {
    if (!l.lock) continue
    const stage: LoanStage = l.release_txid ? 'released'
      : l.repayment_txid ? 'repaid'
      : ctx.flowLoanId === id && REPAYING.has(ctx.flowStage ?? '') ? 'repaying'
      : l.disbursement_txid ? 'funded'
      : 'locked'
    const page = ctx.pageIds.indexOf(id)
    out.push({
      id, role: 'borrower', ...(page >= 0 ? { pageNo: page + 1 } : {}), counterparty: ctx.name('Lender', l.lender_pk),
      principal: l.terms.principal, debt: debtOf(l.terms), open_height: l.terms.open_height, maturity_height: l.terms.maturity_height, grace_blocks: l.terms.grace_blocks, stage,
      ...marginCall(ctx.marginCalls, id),
    })
  }
  for (const [id, l] of Object.entries(lender.loans)) {
    if (!l.lock || l.cancelled) continue
    const stage: LoanStage = l.release_txid ? 'released' : l.repayment_txid ? 'repaid' : l.disbursement_txid ? 'funded' : 'locked'
    out.push({
      id, role: 'lender', counterparty: ctx.name('Borrower', l.borrower_pk),
      principal: l.terms.principal, debt: debtOf(l.terms), open_height: l.terms.open_height, maturity_height: l.terms.maturity_height, grace_blocks: l.terms.grace_blocks, stage,
      ...marginCall(ctx.marginCalls, id),
    })
  }
  return out
}

/** Keep the last few heights the app saw arrive, with when: two or more give the chain's pace. */
export function noteBlock(seen: BlockSeen[], height: number, time: number, keep = 8): BlockSeen[] {
  if (!Number.isSafeInteger(height) || height <= 0) return seen
  const last = seen.at(-1)
  if (last && last.height >= height) return seen
  return [...seen, { height, time }].slice(-keep)
}
