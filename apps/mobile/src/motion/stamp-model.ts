// What the "page stamped" moment says, from the page's real closing transaction: the page
// number, the transaction's id (shortened on the seal, whole for the screen reader and the copy
// button) named for what it was (the release for a paid page; otherwise the default, sale or
// refund that closed it), the ladder step reached and the new limit. A missing or malformed txid
// gives no stamp at all (null): the seal never carries a made-up id. No React Native here.

export type StampOutcome = 'on_time' | 'late' | 'defaulted' | 'liquidated' | 'refunded'

export interface StampInput {
  pageNo: number
  /** the page's closing transaction on Bitcoin (PassbookPage.close_txid): 64 hex characters */
  closeTxid: string
  /** the ladder step this page earned (0-based, as LadderState.step) */
  ladderStep: number
  /** the number of steps in the ladder (LADDER_BPS.length) */
  ladderSteps: number
  /** the limit the ladder allows now, in bps (LadderState.allowed_ltv_bps) */
  limitBps?: number
  outcome?: StampOutcome
}

export interface StampWords {
  /** "Page 3 stamped" */
  title: string
  /** around the seal's ring: "PAID ON TIME · PAGE 3 · TEST COINS ·" (test coins never look real) */
  ring: string
  /** on the seal under the check: "31ad…71c6" */
  txShort: string
  /** what the closing transaction was: "release", "default claim", "sale", "refund" */
  txWord: string
  /** "Step 3 of 4 · limit now 65%" */
  ladder: string
  /** the whole sentence for the screen reader */
  a11y: string
  /** filled ladder steps after this page (1-based count), for the ladder strip */
  stepsFilled: number
  /** short vibration on the impact, only when the page is paid (never on a default) */
  buzz: boolean
  /** the seal's colour, as the canvas tags the outcome (PAID green, LATE amber, DEFAULT and SOLD warn, REFUND muted) */
  tone: 'green' | 'amber' | 'warn' | 'muted'
  /** a check only for a paid page; a bar otherwise */
  glyph: 'check' | 'bar'
}

const TONE: Record<StampOutcome, StampWords['tone']> = { on_time: 'green', late: 'amber', defaulted: 'warn', liquidated: 'warn', refunded: 'muted' }

const OUTCOME_WORDS: Record<StampOutcome, string> = {
  on_time: 'PAID ON TIME',
  late: 'PAID LATE',
  defaulted: 'DEFAULTED',
  liquidated: 'SOLD',
  refunded: 'REFUNDED',
}

export const isTxid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)

/**
 * What a page's closing transaction was, by its outcome: only a repaid page closes with the
 * release (borrower and lender co-sign it back to the borrower); a default, a sale or a refund
 * closes with its own spend. Anything else is named neutrally.
 */
export function closeWord(outcome: string): string {
  switch (outcome) {
    case 'on_time': case 'late': return 'release'
    case 'defaulted': return 'default claim'
    case 'liquidated': return 'sale'
    case 'refunded': return 'refund'
    default: return 'closing transaction'
  }
}

export function stampWords(i: StampInput): StampWords | null {
  if (!isTxid(i.closeTxid) || !Number.isInteger(i.pageNo) || i.pageNo < 1) return null
  if (!Number.isInteger(i.ladderStep) || i.ladderStep < 0 || !Number.isInteger(i.ladderSteps) || i.ladderSteps < 1) return null
  const outcome = i.outcome ?? 'on_time'
  const tx = i.closeTxid.toLowerCase()
  const txWord = closeWord(outcome)
  const txShort = `${tx.slice(0, 4)}…${tx.slice(-4)}`
  const step = Math.min(i.ladderStep, i.ladderSteps - 1) + 1
  const limit = i.limitBps !== undefined ? ` · limit now ${(i.limitBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : ''
  const ladder = `Step ${step} of ${i.ladderSteps}${limit}`
  const title = `Page ${i.pageNo} stamped`
  return {
    title,
    ring: `${OUTCOME_WORDS[outcome]} · PAGE ${i.pageNo} · TEST COINS ·`,
    txShort,
    txWord,
    ladder,
    a11y: `${title}: ${OUTCOME_WORDS[outcome].toLowerCase()}. The ${txWord}${txWord.endsWith('transaction') ? '' : ' transaction'} ${tx}. ${ladder}.`,
    stepsFilled: step,
    buzz: outcome === 'on_time' || outcome === 'late',
    tone: TONE[outcome],
    glyph: outcome === 'on_time' || outcome === 'late' ? 'check' : 'bar',
  }
}

/** The stamp's beats, in ms from the start (the page turns, the seal drops, it lands, the words settle). */
export const STAMP_TIMING = { turn: 680, hold: 160, drop: 280, settle: 360 } as const
/** The vibration on the seal's impact: one short pulse (Android ms). */
export const STAMP_BUZZ_MS = 28
