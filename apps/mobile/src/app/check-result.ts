import type { PassbookCheckOutputs } from '../../../../src/scorer/types.js'

/** Explain the verified recommendation without inventing a failed history or affordability check. */
export function checkResultWords(outputs: Pick<PassbookCheckOutputs, 'recommendation' | 'checks'>): { title: string; detail: string } {
  if (outputs.recommendation === 'ESCALATE') {
    const checks = outputs.checks.length > 0 && outputs.checks.every((check) => check.ok)
      ? 'All reported checks passed, but Compex still asks for a person to review this loan.'
      : 'Compex asks for a person to review this loan.'
    return {
      title: 'A person needs to review this loan',
      detail: `${checks} The lender lends only on QUALIFY, so nothing was sent and nothing was locked.`,
    }
  }
  return { title: 'This loan did not qualify', detail: 'The check did not qualify this loan. Nothing was sent and nothing was locked.' }
}
