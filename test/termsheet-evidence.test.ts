import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { opReturnScript } from '../src/chain/types.js'
import { hashObject, keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { termsHash } from '../src/core/terms.js'
import type { Position } from '../src/market/negotiate.js'
import { approve } from '../src/market/approvals.js'
import { bindingNonce, buildTermSheet, renderTermSheet, termSheetHash, termSheetProblems, type TermSheet, type TermSheetEvidence, type TermSheetInput } from '../src/market/termsheet.js'
import { buildAuditBundle } from '../src/audit/export.js'
import { Oracle } from '../src/oracle/oracle.js'
import { approveWithEvidence, evidenceDigest, termSheetEvidenceProblems, termSheetNamesEvidence } from '../src/scorer/evidence-digest.js'
import type { ScorerOutcome } from '../src/scorer/types.js'
import { scorerResultHash } from '../src/scorer/verify.js'

const U = MICRO_PER_USDT
const borrower = keyPairFromLabel('evidence-borrower'), lender = keyPairFromLabel('evidence-lender'), platform = keyPairFromLabel('evidence-platform')
const oracle = new Oracle(keyPairFromLabel('evidence-oracle'), 10_000_000)

function sampleOutcome(name: string): ScorerOutcome {
  return {kind:'external-evidence',descriptor:{v:1,provider:'external',scorer_id:'test-optional-provider',trust:'software-evidence',code_measurement:'sha256:'+'ab'.repeat(32),contract_hash:'cd'.repeat(32)},evidence:{test_vector:name},outputs:{} as never,reference:name,fallback:false}
}

function sheetWith(outcome: ScorerOutcome, salt: string, over: Partial<TermSheetInput> = {}) {
  const agreed: Position = { principal: 600 * U, apr_bps: 1200, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' }
  return buildTermSheet({
    agreed, negotiation: { id: 'aa'.repeat(32), accept_hash: 'bb'.repeat(32) }, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey,
    asset_id: 'rgb:usdt', oracle_quote: oracle.quote(500), grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
    scorer: { provider: outcome.descriptor.provider, scorer_id: outcome.descriptor.scorer_id, code_measurement: outcome.descriptor.code_measurement, contract_hash: outcome.descriptor.contract_hash, trust: 'software-evidence', result_hash: scorerResultHash(outcome), fallback: false, recommendation: 'QUALIFY', evidence: evidenceDigest(outcome) },
    consent_hash: '12'.repeat(32), salt, ...over,
  })
}

describe('evidence digest in the term sheet (decision 4)', () => {
  it('hashes opaque evidence and its optional reference without importing provider formats',()=>{
    const o=sampleOutcome('vector-1')
    if(o.kind!=='external-evidence')throw new Error('expected external evidence')
    assert.deepEqual(evidenceDigest(o),{kind:'external-evidence',evidence_sha256:hashObject(o.evidence),reference:'vector-1'})
  })

  it('changes the terms hash the lock commits when the evidence changes', () => {
    const salt = randomHex()
    const a = sheetWith(sampleOutcome('qvac-ok'), salt)
    const b = sheetWith(sampleOutcome('standin-ok'), salt)
    assert.deepEqual(termSheetProblems(a, {}), [])
    assert.deepEqual(termSheetProblems(b, {}), [])
    assert.notEqual(termSheetHash(a), termSheetHash(b))
    assert.notEqual(opReturnScript(termsHash(a.terms)), opReturnScript(termsHash(b.terms)), 'the lock OP_RETURN differs')
    const forged = { ...a, scorer: { ...a.scorer, evidence: b.scorer.evidence } }
    assert.throws(() => termSheetHash(forged), /not bound/, 'swapping the digest after the fact breaks the binding')
    assert.ok(termSheetProblems(forged, {}).includes('terms nonce does not bind this sheet'))
  })

  it('lets the lender confirm the sheet names exactly the evidence it verified', () => {
    const o = sampleOutcome('qvac-ok'), other = sampleOutcome('standin-ok')
    const sheet = sheetWith(o, randomHex())
    assert.equal(termSheetNamesEvidence(sheet, o), true)
    assert.equal(termSheetNamesEvidence(sheet, other), false)
  })

  it('refuses to approve, and the audit fails, a rebound sheet naming other evidence with the right result hash', () => {
    const o = sampleOutcome('qvac-ok'), other = sampleOutcome('standin-ok')
    const honest = sheetWith(o, randomHex())
    const forged = sheetWith(o, randomHex(), { scorer: { ...honest.scorer, evidence: evidenceDigest(other) } })
    assert.deepEqual(termSheetProblems(forged, {}), [], 'well formed and bound: only the evidence comparison catches it')
    assert.equal(forged.scorer.result_hash, scorerResultHash(o))
    assert.deepEqual(termSheetEvidenceProblems(forged, o), ['the term sheet evidence digest does not match the verified evidence'])
    assert.throws(() => approveWithEvidence(lender, forged, 'lender', o), /not approving: the term sheet evidence digest does not match/)
    assert.equal(approveWithEvidence(lender, honest, 'lender', o).termsheet_hash, termSheetHash(honest))
    const check = (sheet: TermSheet) => buildAuditBundle({ termsheet: sheet, scorer: o }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 5_000 * U }).checks.find((c) => c.id === 'scorer-reference')
    assert.equal(check(honest)?.ok, true)
    assert.deepEqual({ ok: check(forged)?.ok, detail: check(forged)?.detail }, { ok: false, detail: 'the term sheet evidence digest does not match the verified evidence' })
  })

  it('still validates a v1 sheet issued before evidence digests; v2 requires one', () => {
    const o = sampleOutcome('qvac-ok')
    const v2 = sheetWith(o, randomHex())
    assert.equal(v2.v, 2)
    const { evidence: _evidence, ...scorer } = v2.scorer
    const v1: TermSheet = { ...v2, v: 1, scorer }
    v1.terms = { ...v1.terms, nonce: bindingNonce(v1) }
    assert.deepEqual(termSheetProblems(v1, {}), [], 'a historical v1 sheet still audits')
    assert.equal(approve(lender, v1, 'lender').termsheet_hash, termSheetHash(v1), 'its terms hash and approvals still work')
    assert.deepEqual(termSheetEvidenceProblems(v1, o), [], 'only the result hash is compared for v1')
    assert.throws(() => approveWithEvidence(lender, v1, 'lender', o), /needs a v2 term sheet/)
    assert.match(renderTermSheet(v1, { audience: 'lender' }).scorer, /Evidence digest: none \(v1 term sheet/)
    const v2NoEvidence: TermSheet = { ...v2, scorer }
    v2NoEvidence.terms = { ...v2NoEvidence.terms, nonce: bindingNonce(v2NoEvidence) }
    assert.deepEqual(termSheetProblems(v2NoEvidence, {}), ['$.scorer.evidence: required in a v2 term sheet'])
    const v1WithEvidence: TermSheet = { ...v2, v: 1 }
    v1WithEvidence.terms = { ...v1WithEvidence.terms, nonce: bindingNonce(v1WithEvidence) }
    assert.deepEqual(termSheetProblems(v1WithEvidence, {}), ['$.scorer.evidence: a v1 term sheet has no evidence digest; evidence needs v2'])
  })

  it('rejects a malformed digest and shows it on the approval screen', () => {
    const o = sampleOutcome('qvac-ok')
    const bad = sheetWith(o, randomHex(), { scorer: { ...sheetWith(o, randomHex()).scorer, evidence: { kind: 'external-evidence', evidence_sha256: 'nope' } as unknown as TermSheetEvidence } })
    assert.ok(termSheetProblems(bad, {}).some((p) => p.includes('$.scorer.evidence')), 'schema rejects a malformed digest')
    const sheet = sheetWith(o, randomHex())
    assert.match(renderTermSheet(sheet, { audience: 'borrower' }).scorer, /Evidence: external evidence [0-9a-f]{12}…, bound to this loan on Bitcoin/)
  })
})
