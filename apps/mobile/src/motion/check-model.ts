// What the credit-check visualizer draws, from the real check: where the sealed envelope is
// (the phone's stage of src/checknode/borrower-check.ts runBorrowerCheck, or the borrow
// flow's stage mapped onto it) and the ticks the phone computed when it opened the result
// (BorrowerCheckView.ticks, in their order). No tick, verdict or label is made up here: an
// unknown tick id is shown by its id. No React Native, so the tests run it.
import type { BorrowerCheckStage, BorrowerCheckView, CheckTick } from '../../../../src/checknode/borrower-check.js'

/**
 * Where the check is, as the envelope shows it:
 *   sealing    the phone seals the bundle to the operator (consent signed)
 *   out        the sealed part is on its way to the check node (runBorrowerCheck 'part-sent')
 *   approval   the node's Compex contract waits for this phone's approval ('approval-requested')
 *   running    approved; the check node runs Compex on QVAC, the lender pays ('approved')
 *   back       the lender forwarded the key; the result comes back ('key-received')
 *   opened     the phone opened and checked it ('opened'): the ticks
 *   refused    a coded refusal ('refused')
 */
export type CheckPhase = 'sealing' | 'out' | 'approval' | 'running' | 'back' | 'opened' | 'refused'

export const PHASE_OF_STAGE: Record<BorrowerCheckStage, CheckPhase> = {
  'part-sent': 'out',
  'approval-requested': 'approval',
  approved: 'running',
  'key-received': 'back',
  opened: 'opened',
  refused: 'refused',
}

/** Where the envelope sits and which way it travels: 0 is the phone, 1 the check node. */
export function envelopeAt(phase: CheckPhase): { at: 0 | 1; from: 0 | 1 } {
  switch (phase) {
    case 'sealing': return { at: 0, from: 0 }
    case 'out': return { at: 1, from: 0 }
    case 'approval': case 'running': return { at: 1, from: 1 }
    case 'back': case 'opened': return { at: 0, from: 1 }
    case 'refused': return { at: 0, from: 0 }
  }
}

/** Plain names for the ticks the phone computes (borrower-check.ts and scorer/compex-dsse.ts ids). */
export const TICK_LABELS: Record<string, string> = {
  'key-message': 'Key forwarded by the lender',
  offer: 'The check node offer you agreed to',
  'message-chain': 'Signed, hash-chained messages',
  'request-is-this-part': 'Your sealed bundle, unchanged',
  'approval-is-mine': 'Compex contract approved by you',
  'consent-in-commitment': 'Your consent signed into the commitment',
  commitment: 'The sealed result opens with the key',
  'key-binding': 'Key bound to the lender\'s payment',
  'scorer-is-offered-release': 'Run on the release you chose',
  'evidence:compex-evidence': 'Compex evidence',
  'evidence:dsse-signature': 'DSSE signature',
  'evidence:execution-released': 'Run completed and released',
  'evidence:execution-id': 'Execution id and evidence root',
  'evidence:run-contract': 'Run contract and validator',
  'evidence:workload': 'Workload image',
  'evidence:qvac-model': 'QVAC model',
  'evidence:run-binding': 'Binding v2: this borrower, lender and loan',
  'evidence:artifact-opening': 'Released outputs open',
  'evidence:outputs': 'Outputs parse',
  'evidence:outputs-addressed': 'Outputs addressed to you',
  'evidence:scored-loan': 'Scored the loan you asked for',
}

/** The ticks the visualizer calls out on the envelope's return (the rest are in the list). */
export const KEY_TICKS = ['evidence:dsse-signature', 'evidence:execution-released', 'evidence:run-binding'] as const

export interface TickRow { id: string; label: string; ok: boolean; detail: string; key: boolean }

export type VerdictTone = 'good' | 'hold' | 'bad'
export interface Verdict { recommendation: string; tone: VerdictTone; income_band: string | null }

export interface CheckPicture {
  phase: CheckPhase
  envelope: { at: 0 | 1; from: 0 | 1 }
  ticks: TickRow[]
  /** the recommendation the opened outputs carry, only when every tick passed */
  verdict: Verdict | null
  /** null until opened; false when any tick failed (a failure screen, never a result) */
  ok: boolean | null
  /** the refusal code, when refused */
  refusal: string | null
}

export const tickLabel = (id: string) => TICK_LABELS[id] ?? id.replace(/^evidence:/, '').replace(/-/g, ' ')

export function toneOf(recommendation: string): VerdictTone {
  return recommendation === 'QUALIFY' ? 'good' : recommendation === 'DECLINE' ? 'bad' : 'hold'
}

export function checkPicture(o: { phase: CheckPhase; view?: Pick<BorrowerCheckView, 'ok' | 'ticks' | 'outputs'> | null; refusal?: string | null }): CheckPicture {
  const ticks: TickRow[] = (o.view?.ticks ?? []).map((t: CheckTick) => ({ id: t.id, label: tickLabel(t.id), ok: t.ok, detail: t.detail, key: (KEY_TICKS as readonly string[]).includes(t.id) }))
  const opened = o.phase === 'opened' && !!o.view
  const ok = opened ? o.view!.ok && ticks.length > 0 && ticks.every((t) => t.ok) : null
  const out = o.view?.outputs
  const verdict = ok && out ? { recommendation: out.recommendation, tone: toneOf(out.recommendation), income_band: out.income_band ?? null } : null
  return { phase: o.phase, envelope: envelopeAt(o.phase), ticks: opened ? ticks : [], verdict, ok, refusal: o.phase === 'refused' ? (o.refusal ?? 'REFUSED') : null }
}

/** One line under the picture for each phase, in the canvas's plain words. */
export function phaseWords(phase: CheckPhase, operator = 'the check node'): string {
  switch (phase) {
    case 'sealing': return `Sealing your data so only ${operator} can open it`
    case 'out': return `Your sealed data is on its way to ${operator}`
    case 'approval': return `${operator[0].toUpperCase()}${operator.slice(1)} asks you to approve its Compex contract`
    case 'running': return `${operator[0].toUpperCase()}${operator.slice(1)} runs the check on Compex; the lender pays`
    case 'back': return 'The result is coming back to this phone'
    case 'opened': return 'Opened and checked on this phone'
    case 'refused': return 'The check stopped'
  }
}
