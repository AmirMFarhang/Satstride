// The term sheet names a credit check billed at close (scorer.check_bill,
// optional): absent, every sheet hash and on-chain terms hash is exactly what it
// was; present, it is covered by the sheet's hash, so the lock commits to the
// bill; both parties see the sentence.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalJson, keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { termsHash } from '../src/core/terms.js'
import type { Position } from '../src/market/negotiate.js'
import { bindingNonce, buildTermSheet, renderTermSheet, termSheetHash, termSheetProblems, type TermSheet, type TermSheetInput } from '../src/market/termsheet.js'
import { Oracle } from '../src/oracle/oracle.js'

const U = MICRO_PER_USDT
const borrower = keyPairFromLabel('bill-sheet-borrower'), lender = keyPairFromLabel('bill-sheet-lender'), platform = keyPairFromLabel('bill-sheet-platform')
const oracle = new Oracle(keyPairFromLabel('bill-sheet-oracle'), 10_000_000)
// One quote for every sheet here, so two sheets differ only in what a test changes.
const QUOTE = oracle.quote(500)
const BILL = { bill_hash: 'b1'.repeat(32), operator_pk: keyPairFromLabel('bill-sheet-operator').pubkey, asset_id: 'rgb:usdt', amount: 500_000, due: 'at-close' as const }

function sheet(salt: string, scorerOver: Record<string, unknown> = {}, over: Partial<TermSheetInput> = {}): TermSheet {
  const agreed: Position = { principal: 600 * U, apr_bps: 1200, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' }
  return buildTermSheet({
    agreed, negotiation: { id: 'aa'.repeat(32), accept_hash: 'bb'.repeat(32) }, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey,
    asset_id: 'rgb:usdt', oracle_quote: QUOTE, grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
    scorer: { provider: 'in-process', scorer_id: 'local-sandbox', code_measurement: 'sha256:' + '4d'.repeat(32), contract_hash: 'cd'.repeat(32), trust: 'dev-inprocess', result_hash: 'ef'.repeat(32), fallback: false, recommendation: 'QUALIFY', evidence: { kind: 'passbook-run-record', run_record_sha256: '11'.repeat(32) }, ...scorerOver } as TermSheetInput['scorer'],
    consent_hash: '12'.repeat(32), salt, ...over,
  })
}

describe('term sheet: a credit check billed at close', () => {
  it('absent, recorded sheets keep their sheet hash and their on-chain terms hash byte for byte', () => {
    // A v2 and a v1 sheet built today: an absent check_bill and no key at all give the same bytes and hashes.
    const salt = randomHex()
    const v2 = sheet(salt)
    const v2Undefined = sheet(salt, { check_bill: undefined })
    assert.equal(canonicalJson(v2), canonicalJson(v2Undefined))
    assert.equal(termSheetHash(v2), termSheetHash(v2Undefined))
    assert.equal(termsHash(v2.terms), termsHash(v2Undefined.terms))
    const { evidence: _e, ...noEvidence } = v2.scorer
    const v1 = { ...v2, v: 1 as const, scorer: noEvidence }
    v1.terms = { ...v1.terms, nonce: bindingNonce(v1) }
    const v1Undefined = { ...v1, scorer: { ...v1.scorer, check_bill: undefined } }
    assert.equal(bindingNonce(v1), bindingNonce(v1Undefined))
    assert.equal(termsHash(v1.terms), termsHash({ ...v1Undefined.terms, nonce: bindingNonce(v1Undefined) }))
  })

  it('present, the bill is covered by the sheet hash: the lock commits to it, and a changed bill no longer binds', () => {
    const salt = randomHex()
    const plain = sheet(salt)
    const billed = sheet(salt, { check_bill: BILL })
    assert.deepEqual(termSheetProblems(billed, {}).filter((p) => /schema/i.test(p)), [], 'the closed schema accepts the bill')
    assert.notEqual(termSheetHash(billed), termSheetHash(plain))
    assert.notEqual(termsHash(billed.terms), termsHash(plain.terms), 'the on-chain terms hash commits to the bill')
    const otherAmount = { ...billed, scorer: { ...billed.scorer, check_bill: { ...BILL, amount: 1 } } }
    assert.ok(termSheetProblems(otherAmount, {}).includes('terms nonce does not bind this sheet'))
    const otherBill = { ...billed, scorer: { ...billed.scorer, check_bill: { ...BILL, bill_hash: 'b2'.repeat(32) } } }
    assert.ok(termSheetProblems(otherBill, {}).includes('terms nonce does not bind this sheet'))
    // The schema is closed: a bill that is not due at close, or has extra fields, is malformed.
    assert.ok(termSheetProblems(sheet(salt, { check_bill: { ...BILL, due: 'now' } }), {}).length > 0)
    assert.ok(termSheetProblems(sheet(salt, { check_bill: { ...BILL, paid: true } }), {}).length > 0)
  })

  it('the borrower and the lender both read the sentence', () => {
    const billed = sheet(randomHex(), { check_bill: BILL })
    for (const audience of ['borrower', 'lender'] as const) {
      const text = JSON.stringify(renderTermSheet(billed, { audience }))
      assert.match(text, /Credit check billed at close, not paid up front: 0\.50 USDT added to the lender's platform fee at close\./, audience)
    }
    assert.doesNotMatch(JSON.stringify(renderTermSheet(sheet(randomHex()), { audience: 'borrower' })), /billed at close/)
  })
})
