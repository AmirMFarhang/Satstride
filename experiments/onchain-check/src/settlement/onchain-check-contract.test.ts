import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as ecc from 'tiny-secp256k1'
import { hashObject, keyPairFromSecret, sha256Hex } from '../core/crypto.js'
import vector from './onchain-check-vector.json' with { type: 'json' }
import {
  CHECK_NATIVE_REPOSITORY, CHECK_NATIVE_REVISION, CHECK_PAYMENT_ASSURANCE, CHECK_PAYMENT_CONTRACT,
  CHECK_PAYMENT_RAIL, CHECK_REGTEST_GENESIS, ONCHAIN_CHECK_LIVE_ENABLED,
  assertCheckWholeTransactionSighash, assertOnchainCheckActivationAllowed,
  checkPurchaseSlot, checkQuoteAdmissionProblems, checkQuoteSignatureProblems, checkQuoteHash, checkQuoteProblems,
  checkPreparedOperationHash, checkOperationApprovalProblems, signCheckOperationApproval, type CheckPreparedOperation,
  signCheckQuoteApproval, type CheckPaymentQuote,
} from './onchain-check-contract.js'
import { checkHtlcFor } from './onchain-check-template.js'

// Public 1G/2G/3G examples; never used with a funded wallet or service.
const borrower = keyPairFromSecret('0'.repeat(63) + '1')
const lender = keyPairFromSecret('0'.repeat(63) + '2')
const operator = keyPairFromSecret('0'.repeat(63) + '3')
const h = (n: number) => n.toString(16).padStart(2, '0').repeat(32)

function fixture(): CheckPaymentQuote {
  const scope = { wallet_id: h(1), borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, negotiation_id: h(2), assessment_scope: h(3), check_index: 0 }
  return {
    v: 2, contract: CHECK_PAYMENT_CONTRACT, rail: CHECK_PAYMENT_RAIL, assurance: CHECK_PAYMENT_ASSURANCE,
    native_repository: CHECK_NATIVE_REPOSITORY, native_revision: CHECK_NATIVE_REVISION,
    network: 'regtest', genesis: CHECK_REGTEST_GENESIS,
    scope, slot_id: checkPurchaseSlot(scope), purchase_id: h(4), check_plan_hash: h(5),
    payer_pk: borrower.pubkey, operator_pk: operator.pubkey,
    request_hash: h(6), request_nonce: h(7), consent_hash: h(8), offer_hash: h(9), release_hash: h(10),
    plaintext_hash: h(11), ciphertext_hash: h(12), key_hash: h(13),
    asset: { contract_id: 'rgb:fixture-contract-not-an-issued-asset', schema_id: 'rgb:fixture-nia-schema', precision: 6, amount: '500000', kind: 'payment' },
    input_policy: 'one-exact-nia-allocation/v1',
    risk: { operator_accepts_disclosure_refund_reorg_loss: true, payer_accepts_conditional_finality: true, atomic_required: false },
    timing: { quoted_tip: 100, funding_confirmations: 6, claim_confirmations: 6, claim_before_height: 200, refund_height: 220 },
    bitcoin: { lock_value_sat: '1000', claim_value_sat: '1000', refund_value_sat: '1000', funding_fee_cap_sat: '2000', claim_fee_cap_sat: '2000', refund_fee_cap_sat: '2000', claim_script_pubkey: '5120' + operator.pubkey, refund_script_pubkey: '5120' + borrower.pubkey, fee_payer: 'payer', claim_fee_payer: 'operator', refund_fee_payer: 'payer' },
    retention: { raw_bundle_seconds: 0, recovery: 'encrypted-until-ack-or-expiry/v1', recovery_expires_at: 200000, exported_claims: 'key-disclosure-cannot-be-erased/v1', tombstone: 'retain-no-secret-payment-references/v1' },
    receipt: 'signed-record-only', issued_at: 100000, expires_at: 103600,
  }
}

test('bounded exposure requires payer, operator and borrower processing signatures over the complete quote', () => {
  const q = fixture()
  assert.deepEqual(checkQuoteProblems(q), [])
  const approvals = [signCheckQuoteApproval(q, 'payer-spend', borrower), signCheckQuoteApproval(q, 'operator-risk', operator), signCheckQuoteApproval(q, 'borrower-processing', borrower)]
  assert.deepEqual(checkQuoteAdmissionProblems(q, approvals, 100001), [])
  assert.ok(checkQuoteAdmissionProblems(q, approvals.slice(1), 100001).includes('CHECK_APPROVAL_SET_REQUIRED'))
  assert.ok(checkQuoteAdmissionProblems(q, [approvals[0], approvals[0], approvals[2]], 100001).includes('CHECK_APPROVAL_DUPLICATE_ROLE'))
  assert.ok(checkQuoteAdmissionProblems(q, approvals, q.expires_at).includes('CHECK_QUOTE_NOT_CURRENT'))
  assert.deepEqual(checkQuoteSignatureProblems(q, approvals), [], 'historical signatures remain valid for recovery after admission expiry')
  assert.throws(() => signCheckQuoteApproval(q, 'operator-risk', borrower), /WRONG_ACTOR/)
  for (const mutate of [
    (x: CheckPaymentQuote) => { x.asset.amount = '500001' },
    (x: CheckPaymentQuote) => { x.retention.recovery_expires_at++ },
    (x: CheckPaymentQuote) => { x.timing.refund_height++ },
    (x: CheckPaymentQuote) => { x.ciphertext_hash = h(14) },
    (x: CheckPaymentQuote) => { x.check_plan_hash = h(15) },
    (x: CheckPaymentQuote) => { x.request_nonce = h(16) },
    (x: CheckPaymentQuote) => { x.receipt = 'optional-rgb-uda' },
  ]) {
    const changed = structuredClone(q)
    mutate(changed)
    assert.notEqual(checkQuoteHash(q), checkQuoteHash(changed))
    assert.ok(checkQuoteAdmissionProblems(changed, approvals, 100001).includes('CHECK_APPROVAL_INVALID'))
  }
})

test('slot survives transport/nonce/operator changes; exact approved plan index remains in quote authorization', () => {
  const q = fixture()
  const other = structuredClone(q)
  other.operator_pk = lender.pubkey
  other.purchase_id = h(17)
  other.request_nonce = h(18)
  assert.equal(checkPurchaseSlot(q.scope), checkPurchaseSlot(other.scope))
  assert.equal(q.slot_id, other.slot_id)
  assert.notEqual(checkPurchaseSlot(q.scope), checkPurchaseSlot({ ...q.scope, check_index: 1 }))
  assert.notEqual(checkPurchaseSlot(q.scope), checkPurchaseSlot({ ...q.scope, assessment_scope: h(19) }))
  // This tests stable identity only, not an implemented database unique constraint.
  assert.throws(() => checkPurchaseSlot({ ...q.scope, check_index: -1 }))
  assert.throws(() => checkPurchaseSlot({ ...q.scope, rpc_key: h(20) } as typeof q.scope))
})

test('new monetary wire amounts preserve exact u64 and reject rounded numbers, zero, overflow and extra fields', () => {
  const q = fixture()
  q.asset.amount = '18446744073709551615'
  assert.deepEqual(checkQuoteProblems(q), [])
  q.asset.amount = '18446744073709551616'
  assert.ok(checkQuoteProblems(q).includes('CHECK_AMOUNT_OUT_OF_U64_RANGE'))
  q.asset.amount = '0'
  assert.ok(checkQuoteProblems(q).includes('CHECK_AMOUNT_OUT_OF_U64_RANGE'))
  for (const amount of ['01', '-1', '1e6', 9007199254740992, null]) {
    assert.ok(checkQuoteProblems({ ...fixture(), asset: { ...fixture().asset, amount } }).some((e) => e.startsWith('CHECK_QUOTE_SCHEMA')))
  }
  assert.ok(checkQuoteProblems({ ...fixture(), trust: 'atomic' }).length)
  assert.ok(checkQuoteProblems({ ...fixture(), native_repository: 'https://github.com/RGB-Tools/rgb-lib' }).length)
  assert.ok(checkQuoteProblems({ ...fixture(), network: 'mainnet' }).length)
})

test('vouchers are one unit and both fees and output funding must be explicitly bounded', () => {
  const q = fixture()
  q.asset = { ...q.asset, amount: '1', kind: 'voucher' }
  assert.deepEqual(checkQuoteProblems(q), [])
  q.asset.amount = '2'
  assert.ok(checkQuoteProblems(q).includes('CHECK_VOUCHER_NOT_ONE_UNIT'))
  const changed = fixture()
  changed.bitcoin.refund_value_sat = '999'
  assert.ok(checkQuoteProblems(changed).includes('CHECK_Q_VALUE_NOT_PRESERVED'))
  changed.bitcoin = { ...fixture().bitcoin, lock_value_sat: '329', claim_value_sat: '329', refund_value_sat: '329' }
  assert.ok(checkQuoteProblems(changed).includes('CHECK_Q_VALUE_BELOW_P2TR_DUST_FLOOR'))
  changed.bitcoin = { ...fixture().bitcoin, claim_fee_cap_sat: '0' }
  assert.ok(checkQuoteProblems(changed).includes('CHECK_AMOUNT_OUT_OF_U64_RANGE'))
})

test('timing/retention assumptions are explicit limits, never an atomic guarantee', () => {
  const q = fixture()
  q.timing.refund_height = q.timing.claim_before_height
  assert.ok(checkQuoteProblems(q).includes('CHECK_NO_CLAIM_CONFIRMATION_MARGIN'))
  q.timing = { ...fixture().timing, claim_before_height: 106 }
  assert.ok(checkQuoteProblems(q).includes('CHECK_NO_FUNDING_CLAIM_WINDOW'))
  q.timing = { ...fixture().timing, refund_height: 2117 }
  assert.ok(checkQuoteProblems(q).includes('CHECK_REFUND_WINDOW_TOO_LONG'))
  q.timing = fixture().timing
  q.retention.recovery_expires_at = q.expires_at
  assert.ok(checkQuoteProblems(q).includes('CHECK_RECOVERY_EXPIRY'))
  for (const risk of [
    { ...fixture().risk, atomic_required: true },
    { ...fixture().risk, operator_accepts_disclosure_refund_reorg_loss: false },
    { ...fixture().risk, payer_accepts_conditional_finality: false },
  ]) assert.ok(checkQuoteProblems({ ...fixture(), risk }).length)
})

test('only full-transaction sighashes are permitted and live activation always refuses', () => {
  for (const sighash of [0, 1]) assert.doesNotThrow(() => assertCheckWholeTransactionSighash(sighash))
  for (const sighash of [2, 3, 0x80, 0x81, 0x82, 0x83, -1, NaN]) assert.throws(() => assertCheckWholeTransactionSighash(sighash))
  assert.equal(ONCHAIN_CHECK_LIVE_ENABLED, false)
  assert.throws(assertOnchainCheckActivationAllowed, /ONCHAIN_CHECK_DISABLED/)
})

test('exact HTLC script binds quote, SHA256 key, operator and payer refund height under NUMS', () => {
  const p = { quote_hash: h(21), key_hash: h(22), payer_pk: borrower.pubkey, operator_pk: operator.pubkey, refund_height: 220 }
  const output = checkHtlcFor(p)
  assert.equal(output.template, 'check-sha256-size32-quote/v1')
  assert.equal(output.claim.script, `20${p.quote_hash}7582012088a820${p.key_hash}8820${p.operator_pk}ac`)
  assert.equal(output.refund.script, `20${p.quote_hash}7502dc00b17520${p.payer_pk}ac`)
  assert.equal(output.claim.control_block.length, 130)
  assert.equal(output.refund.control_block.length, 130)
  for (const change of [{ quote_hash: h(23) }, { key_hash: h(24) }, { operator_pk: lender.pubkey }, { refund_height: 221 }]) {
    assert.notEqual(checkHtlcFor({ ...p, ...change }).script_pubkey, output.script_pubkey)
  }
  assert.throws(() => checkHtlcFor({ ...p, payer_pk: operator.pubkey }))
  assert.throws(() => checkHtlcFor({ ...p, key_hash: '00' }))
  assert.throws(() => checkHtlcFor({ ...p, refund_height: 500000000 }))
  assert.notEqual(hashObject(output.claim), hashObject(output.refund))
})

test('public vector independently matches BIP341 leaf hashes, sorted branch, tweak and control blocks', () => {
  const actual = checkHtlcFor(vector.parameters)
  assert.deepEqual(actual, vector.expected)
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
  const tagged = (tag: string, bytes: Uint8Array) => {
    const prefix = sha(Buffer.from(tag))
    return sha(Buffer.concat([prefix, prefix, bytes]))
  }
  const leaf = (script: string) => {
    const bytes = Buffer.from(script, 'hex')
    assert.ok(bytes.length < 253)
    return tagged('TapLeaf', Buffer.concat([Buffer.from([0xc0, bytes.length]), bytes]))
  }
  const claim = leaf(actual.claim.script), refund = leaf(actual.refund.script)
  const branch = tagged('TapBranch', Buffer.concat([claim, refund].sort(Buffer.compare)))
  const internal = Buffer.from(actual.internal_key, 'hex')
  const output = ecc.xOnlyPointAddTweak(internal, tagged('TapTweak', Buffer.concat([internal, branch])))
  assert.ok(output)
  assert.equal(actual.claim.leaf_hash, claim.toString('hex'))
  assert.equal(actual.refund.leaf_hash, refund.toString('hex'))
  assert.equal(actual.merkle_root, branch.toString('hex'))
  assert.equal(actual.script_pubkey, '5120' + Buffer.from(output.xOnlyPubkey).toString('hex'))
  assert.equal(actual.claim.control_block, Buffer.concat([Buffer.from([0xc0 | output.parity]), internal, refund]).toString('hex'))
  assert.equal(actual.refund.control_block, Buffer.concat([Buffer.from([0xc0 | output.parity]), internal, claim]).toString('hex'))
})

// Exact proof/transaction bytes have a later authorization to avoid a circular
// quote -> Q -> funding/proofs -> quote hash dependency.
test('operation approvals bind exact prepared bytes, proof history, summary, stage and quote', () => {
  const q = fixture()
  const artifact = (value: string) => ({ sha256: sha256Hex(value), bytes_base64: Buffer.from(value).toString('base64') })
  const prepared: CheckPreparedOperation = {
    v: 1, domain: 'passbook-check-prepared/v2', slot_id: q.slot_id, quote_hash: checkQuoteHash(q), stage: 'fund', native_operation_id: 'fixture-op',
    unsigned_psbt: artifact('fixture bytes, not an executable PSBT'), proof_artifacts: [artifact('fixture history')], decoded_summary: artifact('fixture summary'),
  }
  const approval = signCheckOperationApproval(q, prepared, borrower)
  assert.deepEqual(checkOperationApprovalProblems(q, prepared, approval), [])
  assert.throws(() => signCheckOperationApproval(q, prepared, operator), /WRONG_ACTOR/)
  for (const mutate of [
    (p: CheckPreparedOperation) => { p.unsigned_psbt = artifact('other transaction') },
    (p: CheckPreparedOperation) => { p.proof_artifacts = [artifact('other RGB history')] },
    (p: CheckPreparedOperation) => { p.decoded_summary = artifact('other summary') },
    (p: CheckPreparedOperation) => { p.stage = 'refund' },
    (p: CheckPreparedOperation) => { p.native_operation_id = 'another-op' },
  ]) {
    const changed = structuredClone(prepared); mutate(changed)
    assert.notEqual(checkPreparedOperationHash(q, changed), checkPreparedOperationHash(q, prepared))
    assert.ok(checkOperationApprovalProblems(q, changed, approval).length)
  }
  const changed = structuredClone(prepared)
  changed.proof_artifacts[0].bytes_base64 = Buffer.from('uncommitted').toString('base64')
  assert.throws(() => checkPreparedOperationHash(q, changed), /NOT_COMMITTED/)
  changed.proof_artifacts[0] = { sha256: sha256Hex('x'), bytes_base64: 'eA===' }
  assert.throws(() => checkPreparedOperationHash(q, changed), /NOT_COMMITTED/)
  changed.quote_hash = h(25)
  assert.throws(() => checkPreparedOperationHash(q, changed), /OTHER_QUOTE/)
})
