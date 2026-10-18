import type { PublicInvestigation } from './investigation-types.js'

/** Lender policy is explicit; an absent or failed investigation is never success. */
export function investigationAccepted(requirement: 'required' | 'optional' | undefined, result: PublicInvestigation | undefined): boolean {
  if (result?.status === 'done' && result.verdict === 'fraud') return false
  return requirement !== 'required' || (result?.status === 'done' && (result.verdict === 'clean' || result.verdict === 'concerns'))
}
