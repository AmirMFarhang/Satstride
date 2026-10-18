// What a lender's funding decision carries into the gate and the log besides
// the transfer itself: the scorer result its term sheet names, and the
// borrower's addresses for sanctions screening. On regtest the borrower's
// proven address is its Passbook key-path address (it signs the lock from it);
// the layers work (src/networks) adds BIP-322-proven mainnet addresses and
// their direct counterparties through the same ScreeningSubject.

import type { LoanTerms } from '../core/terms.js'
import { keyPathOutput } from '../escrow/escrow.js'
import type { TermSheet } from '../market/termsheet.js'
import type { SignContext } from './node.js'

export function fundingInputs(terms: LoanTerms, sheet?: TermSheet | null): Pick<SignContext, 'scorer' | 'screening'> {
  const s = sheet?.scorer
  return {
    scorer: s ? { provider: s.provider, recommendation: s.recommendation, trust: s.trust, result_hash: s.result_hash, fallback: s.fallback } : null,
    screening: { subject_pk: terms.borrower_pk, proven_addresses: [keyPathOutput(terms.borrower_pk).address], counterparties: [] },
  }
}
