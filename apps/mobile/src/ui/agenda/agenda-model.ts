// The personal agenda, computed from the state the app already holds (the loans on this
// phone, the passbook read from Bitcoin, the chain height): what is due and when, what comes
// next on each loan, where the person is on the ladder, and the pages already stamped.
// Deadlines are block heights; the time next to one is an estimate, and it says what it
// assumed (the chain's own recent pace when the app saw blocks arrive, otherwise Bitcoin's
// 10-minute target). Pure: no network, no React Native, so the tests run it.
import { usd } from '../format'
import { closeWord } from '../../motion/stamp-model'

export type LoanStage = 'negotiating' | 'checking' | 'locked' | 'funded' | 'repaying' | 'repaid' | 'released'

export interface AgendaLoan {
  id: string
  role: 'borrower' | 'lender'
  /** the borrower's page number for this loan (1-based); lender loans have none */
  pageNo?: number
  /** how the counterparty is shown ("Lender 3f9a1c") */
  counterparty: string
  /** micro test USDT */
  principal: number
  /** principal + fee, micro test USDT */
  debt: number
  open_height: number
  maturity_height: number
  grace_blocks: number
  stage: LoanStage
  /** the height a margin call was raised at, when one was */
  margin_call_height?: number
}

export interface AgendaPage {
  loan_id: string
  outcome: string
  principal: number
  open_height: number
  maturity_height: number
  ladder_step: number
  close_txid?: string
}

/** A block the app saw: its height and when it saw it (ms). Two or more give the chain's pace. */
export interface BlockSeen { height: number; time: number }

export interface AgendaInput {
  height: number
  /** ms since the epoch */
  now: number
  /** blocks the app saw arrive, for the pace; without them the estimate uses Bitcoin's target */
  seen?: BlockSeen[]
  loans: AgendaLoan[]
  pages: AgendaPage[]
  /** LADDER_BPS and LadderState.step */
  ladder?: { steps: readonly number[]; at: number }
  /** CURE_BLOCKS (src/registry/ladder.ts) */
  cureBlocks?: number
}

export type Tone = 'ok' | 'soon' | 'grace' | 'late'

export interface Deadline {
  loanId: string
  role: AgendaLoan['role']
  title: string
  dueHeight: number
  blocksLeft: number
  /** the estimate, already in words ("about 3 h 20 min"); null once it is past */
  eta: string | null
  /** what is left of the term, 1 (just opened) .. 0 (due): the countdown ring */
  left: number
  tone: Tone
  note: string
}

export interface NextStep { loanId: string; role: AgendaLoan['role']; text: string; waitingOn: 'you' | 'them' | 'chain' }

export interface Pace { secondsPerBlock: number; basis: 'observed' | 'target'; words: string }

export interface Agenda {
  deadlines: Deadline[]
  next: NextStep[]
  ladder: { at: number; of: number; percent: number; next: string } | null
  /** stamped pages, newest first; `closeWord` names the closing transaction by the outcome (only a repaid page closes with the release) */
  past: { loanId: string; label: string; outcome: string; principal: number; close_txid?: string; closeWord: string }[]
  pace: Pace
}

export const TARGET_SECONDS = 600

/** Seconds per block from the blocks the app saw arrive; Bitcoin's target when it saw too few. */
export function paceOf(seen: readonly BlockSeen[] = []): Pace {
  const s = [...seen].sort((a, b) => a.height - b.height)
  const first = s[0], last = s.at(-1)
  if (first && last && last.height > first.height && last.time > first.time) {
    const sec = (last.time - first.time) / 1000 / (last.height - first.height)
    return { secondsPerBlock: sec, basis: 'observed', words: `at this chain's recent pace (${sec < 120 ? `${Math.round(sec)} s` : durationWords(sec * 1000)} a block)` }
  }
  return { secondsPerBlock: TARGET_SECONDS, basis: 'target', words: "at Bitcoin's 10-minute target" }
}

/** "under a minute", "12 min", "3 h 20 min", "2 days 4 h" */
export function durationWords(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60), m = min % 60
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`
  const d = Math.floor(h / 24), hh = h % 24
  return `${d} day${d === 1 ? '' : 's'}${hh ? ` ${hh} h` : ''}`
}

const blocks = (n: number) => `${n} block${n === 1 ? '' : 's'}`

function deadlineOf(l: AgendaLoan, height: number, pace: Pace, cure: number): Deadline | null {
  if (l.stage !== 'funded' && l.stage !== 'repaying') return null
  const eta = (b: number) => (b > 0 ? `about ${durationWords(b * pace.secondsPerBlock * 1000)}` : null)
  const name = l.role === 'borrower' ? `Pay page ${l.pageNo ?? '?'}` : `${l.counterparty} repays`
  if (l.margin_call_height !== undefined) {
    // the earlier of the two: the cure window, or the end of grace (the default spend unlocks
    // then, whatever the cure window says)
    const cureEnd = l.margin_call_height + cure
    const graceEnd = l.maturity_height + l.grace_blocks
    const due = Math.min(cureEnd, graceEnd)
    const left = due - height
    const why = graceEnd < cureEnd ? `before the grace period ends at block ${graceEnd}` : `within ${blocks(left)}`
    return { loanId: l.id, role: l.role, title: l.role === 'borrower' ? `Margin call on page ${l.pageNo ?? '?'}` : `Margin call: ${l.counterparty}`, dueHeight: due, blocksLeft: left, eta: eta(left), left: Math.max(0, Math.min(1, left / cure)), tone: 'late', note: left > 0 ? `${l.role === 'borrower' ? 'Pay early' : 'They can pay early'} ${why} to keep the bitcoin` : graceEnd < cureEnd ? 'Past the grace period' : 'The cure window has passed' }
  }
  const term = Math.max(1, l.maturity_height - l.open_height)
  const left = l.maturity_height - height
  if (left > 0) {
    const tone: Tone = left <= Math.max(3, Math.ceil(term * 0.15)) ? 'soon' : 'ok'
    return { loanId: l.id, role: l.role, title: name, dueHeight: l.maturity_height, blocksLeft: left, eta: eta(left), left: Math.min(1, left / term), tone, note: `${usd(l.debt)} by block ${l.maturity_height}` }
  }
  const graceLeft = l.maturity_height + l.grace_blocks - height
  if (graceLeft > 0) return { loanId: l.id, role: l.role, title: name, dueHeight: l.maturity_height + l.grace_blocks, blocksLeft: graceLeft, eta: eta(graceLeft), left: 0, tone: 'grace', note: `Past due: ${blocks(graceLeft)} of grace left, paid late` }
  return { loanId: l.id, role: l.role, title: name, dueHeight: l.maturity_height + l.grace_blocks, blocksLeft: graceLeft, eta: null, left: 0, tone: 'late', note: 'Past the grace period' }
}

function nextOf(l: AgendaLoan): NextStep | null {
  const b = l.role === 'borrower'
  const step = (text: string, waitingOn: NextStep['waitingOn']): NextStep => ({ loanId: l.id, role: l.role, text, waitingOn })
  switch (l.stage) {
    case 'negotiating': return step(b ? `Your agent is negotiating with ${l.counterparty}` : `Negotiating with ${l.counterparty}`, 'them')
    case 'checking': return step(b ? 'Your credit check is running' : `${l.counterparty}'s credit check is running`, 'them')
    case 'locked': return b ? step(`Waiting for ${l.counterparty} to pay in ${usd(l.principal)}`, 'them') : step(`Pay out ${usd(l.principal)} to ${l.counterparty}`, 'you')
    case 'funded': return b ? step(`Pay ${usd(l.debt)} by block ${l.maturity_height}`, 'you') : step(`${l.counterparty} owes ${usd(l.debt)} by block ${l.maturity_height}`, 'them')
    case 'repaying': return step(b ? 'Your payment is settling on Bitcoin' : `${l.counterparty}'s payment is settling`, 'chain')
    case 'repaid': return b ? step(`Waiting for ${l.counterparty} to co-sign your release`, 'them') : step('Co-sign the release', 'you')
    case 'released': return null
  }
}

export function agenda(i: AgendaInput): Agenda {
  const pace = paceOf(i.seen)
  const cure = i.cureBlocks ?? 10
  const order: Record<Tone, number> = { late: 0, grace: 1, soon: 2, ok: 3 }
  const deadlines = i.loans.map((l) => deadlineOf(l, i.height, pace, cure)).filter((d): d is Deadline => !!d)
    .sort((a, b) => order[a.tone] - order[b.tone] || a.blocksLeft - b.blocksLeft)
  const next = i.loans.map(nextOf).filter((n): n is NextStep => !!n)
    .sort((a, b) => (a.waitingOn === 'you' ? 0 : 1) - (b.waitingOn === 'you' ? 0 : 1))
  const ladder = i.ladder && i.ladder.steps.length
    ? (() => {
        const at = Math.max(0, Math.min(i.ladder!.at, i.ladder!.steps.length - 1))
        const of = i.ladder!.steps.length
        const pct = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
        const nextText = at < of - 1 ? `Pay your next page on time to reach ${pct(i.ladder!.steps[at + 1])}` : 'Top of the ladder'
        return { at, of, percent: i.ladder!.steps[at], next: nextText }
      })()
    : null
  const numbered = [...i.pages].sort((a, b) => a.open_height - b.open_height).map((p, n) => ({ p, n: n + 1 }))
  const past = numbered.filter(({ p }) => p.outcome !== 'open').reverse()
    .map(({ p, n }) => ({ loanId: p.loan_id, label: `Page ${n}`, outcome: p.outcome, principal: p.principal, close_txid: p.close_txid, closeWord: closeWord(p.outcome) }))
  return { deadlines, next, ladder, past, pace }
}
