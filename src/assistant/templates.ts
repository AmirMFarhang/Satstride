// The template engine: answers the common questions from the help corpus and the
// context the phone shares, with every number taken from that context or from the
// code's own thresholds. It runs on the provider (no model, a refusal, or a model
// answer that broke the rules) and on the phone when the provider can't be reached.
// Its answers are always labelled `template`. Browser-safe.

import type { Hex } from '../core/crypto.js'
import { pctText, retrieve, section, type HelpSection } from './corpus.js'
import { intentProblems, moneyAction, looksSecret, REPAYABLE_STATES, type AssistContext, type AssistIntent, type IntentId, type LoanBrief, type Refusal } from './protocol.js'

export interface TemplateAnswer {
  text: string
  intent: AssistIntent | null
  cites: string[]
  refused: Refusal | null
}

const short = (id: Hex) => `${id.slice(0, 6)}…`
const LOAN_INTENTS: readonly IntentId[] = ['page', 'receipt', 'check-loan', 'margin']

/** The first candidate the allowlist and the shared context accept; loan screens get the most relevant shared loan. */
export function pickIntent(candidates: (IntentId | null | undefined)[], ctx: AssistContext | null): AssistIntent | null {
  for (const go of candidates) {
    if (!go) continue
    if (LOAN_INTENTS.includes(go)) {
      const loans = ctx?.loans ?? []
      const loan = (go === 'margin' ? loans.find((l) => l.role === 'borrower' && REPAYABLE_STATES.includes(l.state)) : undefined) ?? loans.find((l) => l.role === 'borrower') ?? loans[0]
      if (!loan) continue
      const intent = { go, loan_id: loan.loan_id }
      if (!intentProblems(intent, ctx).length) return intent
      continue
    }
    const intent = { go }
    if (!intentProblems(intent, ctx).length) return intent
  }
  return null
}

const repayable = (ctx: AssistContext | null) => ctx?.loans.filter((l) => l.role === 'borrower' && REPAYABLE_STATES.includes(l.state)) ?? []

function dueLine(l: LoanBrief): string | null {
  if (l.blocks_left === undefined && l.maturity_height === undefined) return null
  const at = l.maturity_height !== undefined ? ` (height ${l.maturity_height})` : ''
  if (l.blocks_left === undefined) return `Loan ${short(l.loan_id)} is due at height ${l.maturity_height}.`
  if (l.blocks_left >= 0) return `Loan ${short(l.loan_id)} is due in ${l.blocks_left} blocks${at}${l.grace_blocks !== undefined ? `, with ${l.grace_blocks} grace blocks after that` : ''}.`
  return `Loan ${short(l.loan_id)} is ${-l.blocks_left} blocks past its due height${at}${l.grace_blocks !== undefined ? `; the grace period is ${l.grace_blocks} blocks` : ''}. Repay now to keep it from defaulting.`
}

/** Context lines that make a section's general text about this person's own loans. Numbers only from the context. */
export function personal(s: HelpSection, ctx: AssistContext | null): string[] {
  if (!ctx) return []
  const out: string[] = []
  const due = repayable(ctx)
  switch (s.id) {
    case 'repay':
      if (!due.length) out.push('You have no loan to repay right now.')
      for (const l of due) out.push(`Loan ${short(l.loan_id)}${l.owed ? ` needs ${l.owed} test USDT to repay` : ' is open'}${l.blocks_left !== undefined ? `, due in ${l.blocks_left} blocks` : ''}.`)
      break
    case 'deadlines':
      for (const l of due) { const d = dueLine(l); if (d) out.push(d) }
      if (!due.length) out.push('You have no open loan, so no deadline is running.')
      break
    case 'ltv':
      for (const l of due) if (l.ltv_bps !== undefined) out.push(`Loan ${short(l.loan_id)} is at ${pctText(l.ltv_bps)} LTV now${l.state === 'margin-call' ? ': it is in a margin call' : ''}.`)
      break
    case 'ladder':
      if (ctx.test_persona) out.push(PERSONA)
      if (ctx.passbook) out.push(`You are on step ${ctx.passbook.step + 1}: ${ctx.passbook.on_time} on time, ${ctx.passbook.late} late, ${ctx.passbook.defaults} defaults.${ctx.passbook.borrowable ? ` You can borrow up to ${ctx.passbook.borrowable} test USDT now.` : ''}`)
      break
    case 'outcomes': {
      if (ctx.test_persona) out.push(PERSONA)
      const l = ctx.loans.find((x) => x.check === 'ESCALATE' || x.check === 'DECLINE' || ['escalated', 'declined', 'check-failed', 'no-deal'].includes(x.state))
      // an outcome is named only when the check returned it; a step that failed before any result is not a DECLINE
      if (l?.check === 'ESCALATE' || l?.state === 'escalated') out.push(`Your check for ${short(l.loan_id)} ended ESCALATE, so it was not funded. It is not a final no.`)
      else if (l?.check === 'DECLINE') out.push(`Your check for ${short(l.loan_id)} ended DECLINE, so it was not funded.`)
      else if (l?.state === 'check-failed') out.push(`The check for ${short(l.loan_id)} stopped before a result: one of its steps failed or was refused, so it was not funded. That is not a DECLINE; the borrowing screen shows which step stopped.`)
      else if (l?.state === 'declined') out.push(`Loan ${short(l.loan_id)} was declined, so it was not funded.`)
      else if (l?.state === 'no-deal') out.push(`The negotiation for ${short(l.loan_id)} ended with no deal: the lender's terms and your rules did not meet.`)
      break
    }
  }
  return out
}

const PERSONA = 'This wallet is a seeded test persona: its history is regtest test data.'
const SUGGEST = 'I can help with repaying, deadlines, why a check escalated or declined, LTV and margin calls, the ladder, what the credit check is, and who sees your data.'

export function refusalText(verb: string, intent: AssistIntent | null): string {
  const where = intent ? ' I can open the screen where you do it yourself; nothing happens until you confirm there.' : ''
  return `I can't ${verb} for you. I never move money, sign or approve anything, and I never see your keys.${where}`
}

/** Answer a question by template. `ctx` is what the phone shared (null when nothing was). */
export function templateAnswer(question: string, ctx: AssistContext | null): TemplateAnswer {
  const secret = looksSecret(question)
  if (secret) {
    return {
      text: 'That looks like a recovery phrase or a private key. It was not sent anywhere. Never type it into a chat, not even here: anyone who has it can take your coins. If you think someone has seen it, move your coins to a new wallet.',
      intent: null, cites: ['keys'], refused: 'SECRET',
    }
  }
  const action = moneyAction(question)
  if (action) {
    if (action.secret) {
      return { text: 'I never see or show your recovery words or keys. Only you can, in Settings after unlocking the phone. Never share them with anyone.', intent: pickIntent(['settings'], ctx), cites: ['keys'], refused: 'SECRET' }
    }
    const intent = pickIntent([action.intent?.go, 'passbook'], ctx)
    return { text: refusalText(action.verb, intent), intent, cites: ['agent'], refused: 'MONEY_ACTION' }
  }
  const sections = retrieve(question, 2)
  const top = sections[0]
  if (!top) return { text: SUGGEST, intent: null, cites: [], refused: null }
  const lines = [top.text, ...personal(top, ctx)]
  const intent = pickIntent([top.intent, sections[1]?.intent], ctx)
  return { text: lines.join(' '), intent, cites: [top.id], refused: null }
}

/** The questions the sheet suggests, each answered by the template engine as well as by the model. */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  'How do I repay?',
  'When is my loan due?',
  'Why was my check ESCALATE?',
  'What is LTV?',
  'How does the ladder work?',
  'What is the credit check?',
  'Who sees my data?',
]

export { section }
