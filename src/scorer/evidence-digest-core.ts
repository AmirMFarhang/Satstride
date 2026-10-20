import { hashObject, type Hex } from '../core/crypto.js'
import type { TermSheet, TermSheetEvidence } from '../market/termsheet.js'
import type { ScorerOutcome } from './types.js'

/** Stable reference for a term sheet: the hash of the evidence the lender verified. */
export function scorerResultHash(outcome: ScorerOutcome): Hex {
  return outcome.kind === 'passbook-signed' ? hashObject(outcome.result) : hashObject({ evidence: outcome.evidence, outputs: outcome.outputs })
}

export function evidenceDigest(outcome: ScorerOutcome): TermSheetEvidence {
  if (outcome.kind === 'passbook-signed') return runRecordDigest(outcome.result.evidence.run_record)
  return { kind: 'external-evidence', evidence_sha256: hashObject(outcome.evidence), ...(outcome.reference ? { reference: outcome.reference } : {}) }
}

/**
 * Why the sheet does not name exactly this evidence; empty when it does.
 * A v1 sheet predates the digest, so only its result hash can be compared.
 */
export function termSheetEvidenceProblems(sheet: TermSheet, outcome: ScorerOutcome): string[] {
  let digest: TermSheetEvidence | null = null
  try { digest = evidenceDigest(outcome) } catch (err) { return [(err as Error).message] }
  return sheetDigestProblems(sheet, digest, scorerResultHash(outcome))
}

/**
 * The same comparison from a digest the caller computed itself: the agents
 * hold the sandbox's signed run record rather than a ScorerOutcome. Pass the
 * result hash when the caller knows it (the lender); the borrower checks the
 * digest of the run record it received.
 */
export function sheetDigestProblems(sheet: TermSheet, digest: TermSheetEvidence, resultHash?: Hex): string[] {
  const problems: string[] = []
  if (resultHash !== undefined && sheet.scorer.result_hash !== resultHash) problems.push('the term sheet names a different scorer result')
  if (sheet.v === 1) return problems
  if (!sheet.scorer.evidence) problems.push('the term sheet carries no evidence digest')
  else if (hashObject(sheet.scorer.evidence) !== hashObject(digest)) problems.push('the term sheet evidence digest does not match the verified evidence')
  return problems
}

/** The digest a v2 sheet must carry for a sandbox signed run record. */
export const runRecordDigest = (runRecord: unknown): TermSheetEvidence => ({ kind: 'passbook-run-record', run_record_sha256: hashObject(runRecord) })

export function termSheetNamesEvidence(sheet: TermSheet, outcome: ScorerOutcome): boolean {
  return termSheetEvidenceProblems(sheet, outcome).length === 0
}
