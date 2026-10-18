// What the help sheet shares, from what the app already shows: the screen, the
// passbook's counters and each loan's state. Built field by field through the
// shared assistContext (src/assistant/protocol.ts), which drops anything malformed
// and has no place for a key, an address, a history row or a counterparty.
import { routeFor, type AssistContextInput, type AssistIntent, type CheckOutcome, type LoanBrief, type LoanState } from '../../../../src/assistant/protocol.js'

/** The borrowing flow's stage (src/app/borrow-flow.ts BorrowStage) as the help agent's loan state. */
const STAGE_STATE: Record<string, LoanState> = {
  quoting: 'negotiating', quoted: 'negotiating', negotiating: 'negotiating',
  'no-deal': 'no-deal', 'negotiation-failed': 'no-deal',
  'check-node': 'checking', consent: 'checking', 'check-sealing': 'checking', 'compex-approval': 'checking', 'check-opening': 'checking', 'check-result': 'checking', checking: 'checking',
  // a protocol refusal, or a local check that failed before anything went to the lender: no outcome was returned,
  // so this is not a DECLINE (a DECLINE comes only from the check's own recommendation, below)
  'check-refused': 'check-failed', 'declined-check': 'check-failed',
  'no-terms': 'awaiting-terms', applying: 'awaiting-terms', awaiting: 'awaiting-terms',
  terms: 'terms', collateral: 'locking', locking: 'locking', funding: 'funding', open: 'open',
  repaying: 'repaying', iou: 'repaying', releasing: 'releasing', closed: 'closed',
}

export function loanStateFromStage(stage: string | undefined): LoanState | null {
  if (!stage || stage === 'idle') return null
  return STAGE_STATE[stage] ?? 'unknown'
}

/** A Compex/sandbox recommendation as the sheet names it; anything else is left out. */
export function checkOutcome(recommendation: unknown): CheckOutcome | undefined {
  const r = typeof recommendation === 'string' ? recommendation.toUpperCase() : ''
  return r === 'QUALIFY' || r === 'ESCALATE' || r === 'DECLINE' ? r : undefined
}

/** "100.9" test USDT for micro units: the shape the context accepts. */
export const usdtText = (micro: number | undefined): string | undefined =>
  Number.isSafeInteger(micro) && (micro as number) >= 0 ? ((micro as number) / 1_000_000).toFixed(2) : undefined

/**
 * One loan for the context. `borrowStage` is the flow's stage for the loan in progress; for a page of
 * the passbook pass its outcome-derived state instead. Escalated/declined come from the check outcome.
 */
export function loanBrief(o: {
  loanId: string
  role: 'borrower' | 'lender'
  stage?: string
  state?: LoanState
  principalMicro?: number
  owedMicro?: number
  maturityHeight?: number
  graceBlocks?: number
  height?: number
  ltvBps?: number
  recommendation?: unknown
}): Partial<LoanBrief> | null {
  let state = o.state ?? loanStateFromStage(o.stage)
  if (!state) return null
  // a verified check that isn't QUALIFY stays in 'check-result' with the recommendation on checkView.outputs
  const check = checkOutcome(o.recommendation)
  if (check === 'ESCALATE' && ['checking', 'check-failed', 'declined'].includes(state)) state = 'escalated'
  if (check === 'DECLINE' && ['checking', 'check-failed'].includes(state)) state = 'declined'
  return {
    loan_id: o.loanId,
    role: o.role,
    state,
    principal: usdtText(o.principalMicro),
    owed: usdtText(o.owedMicro),
    maturity_height: o.maturityHeight,
    grace_blocks: o.graceBlocks,
    blocks_left: o.maturityHeight !== undefined && o.height !== undefined ? o.maturityHeight - o.height : undefined,
    ltv_bps: o.ltvBps,
    check,
  }
}

/**
 * The intent if the app can open it: a button only for a screen the navigator registers (tab roots always
 * can). `screens` is the app's own screen list (Main.tsx SCREENS), so a screen another build lacks never
 * becomes a button that silently lands on the tab root.
 */
export function renderableIntent(intent: AssistIntent | null, screens: readonly string[]): AssistIntent | null {
  if (!intent) return null
  const r = routeFor(intent)
  return !r.name || screens.includes(r.name) ? intent : null
}

/** online: the provider announced itself or answered; unconfirmed: a pinned key not seen yet (asked anyway). */
export type AssistantStatus = 'looking' | 'online' | 'unconfirmed' | 'offline'

/**
 * The status after looking for the provider's INFO on the relay. A pinned key is an identity, not proof the
 * provider is up: without an INFO it is `unconfirmed`, never `online` (an earlier real answer keeps `online`).
 */
export function statusAfterLookup(prev: AssistantStatus, o: { transport: boolean; found: boolean; pinned: boolean }): AssistantStatus {
  if (!o.transport) return 'offline'
  if (o.found) return 'online'
  if (prev === 'online') return prev
  return o.pinned ? 'unconfirmed' : 'offline'
}

/** The status after an answer: a provider answer proves it is up; a phone answer because it could not be reached says it is not. */
export function statusAfterAnswer(prev: AssistantStatus, a: { answered_by: 'provider' | 'phone'; fallback_reason: string | null }): AssistantStatus {
  if (a.answered_by === 'provider') return 'online'
  return a.fallback_reason === 'PROVIDER_TIMEOUT' || a.fallback_reason === 'PROVIDER_UNREACHABLE' || a.fallback_reason === 'NO_ASSISTANT' ? 'offline' : prev
}

/** The whole context input: what useAssistant's `context()` returns. */
export function contextInput(o: { tab: string; screen: string; height?: number; passbook?: AssistContextInput['passbook']; loans?: (Partial<LoanBrief> | null)[]; testPersona?: boolean }): AssistContextInput {
  return { tab: o.tab, screen: o.screen, height: o.height, passbook: o.passbook, loans: (o.loans ?? []).filter((l): l is Partial<LoanBrief> => !!l), testPersona: o.testPersona === true }
}
