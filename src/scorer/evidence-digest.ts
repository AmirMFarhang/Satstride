// Decision 4: the credit check is bound to the loan on Bitcoin. The term sheet
// carries a digest of the evidence the lender verified. Every term-sheet field
// is folded into the terms nonce, so the terms hash the lock commits changes
// with it.
//   Compex: sha256 of the canonical DSSE envelope. This is the value Compex
//           itself reports as envelopeSha256; test/termsheet-evidence.test.ts
//           checks it against a real sample.
//   in-process / container: the hash of the sandbox's signed run record.

import type { KeyPair } from '../core/crypto.js'
import { approve, type Approval } from '../market/approvals.js'
import type { TermSheet } from '../market/termsheet.js'
import { termSheetEvidenceProblems } from './evidence-digest-core.js'
import type { ScorerOutcome } from './types.js'

// The digest and its comparisons are browser-safe (the phone checks a term sheet with them): evidence-digest-core.ts.
export { evidenceDigest, runRecordDigest, scorerResultHash, sheetDigestProblems, termSheetEvidenceProblems, termSheetNamesEvidence } from './evidence-digest-core.js'

/**
 * The lender's approval: it refuses unless the sheet names exactly the
 * evidence the lender verified, so a well-formed but different digest (with
 * the right result hash) cannot be approved.
 */
export function approveWithEvidence(key: KeyPair, sheet: TermSheet, role: Approval['role'], verified: ScorerOutcome, approvedAt?: number): Approval {
  const problems = sheet.v === 2 ? termSheetEvidenceProblems(sheet, verified) : ['a new approval needs a v2 term sheet that names its evidence']
  if (problems.length) throw new Error(`not approving: ${problems.join('; ')}`)
  return approve(key, sheet, role, approvedAt)
}
