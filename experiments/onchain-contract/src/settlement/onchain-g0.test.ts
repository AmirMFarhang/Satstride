// Protocol-owned tests; invoked explicitly by the additive G0 CI job.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { bytesToHex, hashObject, hexToBytes, keyPairFromLabel, sha256Hex } from '../core/crypto.js'
import { termsHash, validateTerms, type LoanTerms } from '../core/terms.js'
import { NUMS_KEY, keyPathOutput } from '../escrow/escrow.js'
import * as c from './onchain-v3-contract.js'
import { onchainCollateralFor } from './onchain-collateral-template.js'
import { summaryHash } from '../wallet/signer.js'
import { exploreJointModel, findHtlcCounterexamples, HTLC_MODEL_INITIAL, htlcTransition, htlcViolation, JOINT_INITIAL, jointTrace, jointTransition, jointViolation, modelTrace, type JointEvent } from './onchain-interleavings.js'
const borrower = keyPairFromLabel('g0-borrower'), lender = keyPairFromLabel('g0-lender'), platform = keyPairFromLabel('g0-platform')
const b = keyPathOutput(borrower.pubkey).script, l = keyPathOutput(lender.pubkey).script
const artifact = { sha256: '05'.repeat(32), byte_length: 100 }
function terms(): c.OnchainLoanTermsV3 {
  return { v: 3, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, principal: '600000000', fee: '6000000', collateral_sats: '1212000', oracle_quote: { price_cents: 10_000_000, height: 100, oracle_pk: platform.pubkey, sig: '00'.repeat(64) }, open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: '11'.repeat(32), settlement: { kind: 'rgb-onchain-joint', protocol: c.ONCHAIN_CONTRACT, native_revision: c.ONCHAIN_NATIVE_REVISION, network: { chain: 'regtest', genesis_hash: c.ONCHAIN_REGTEST_GENESIS }, collateral_template: 'joint-afd-terms/v1', internal_key: c.ONCHAIN_NUMS_KEY, input_policy: 'single-nia-exact-amount/v1', asset: { kind: 'NIA', contract_id: 'rgb:fixture-asset', schema_id: 'rgb:fixture-nia-schema', precision: 6 }, debt: '606000000', destinations: { borrower_rgb_script_pubkey: b, lender_rgb_script_pubkey: l, borrower_btc_script_pubkey: b, lender_btc_script_pubkey: l, borrower_change_script_pubkey: b }, bitcoin_policy: { fee_payer: 'borrower', collateral_return: 'full', rgb_output_sats: '1000', min_output_sats: '330', origination_fee_cap_sats: '5000', repayment_fee_cap_sats: '5000', enforcement_fee_cap_sats: '5000', recovery_fee_cap_sats: '5000' }, confirmations: { funding: 1, repayment: 1 }, default_payout: { lender_sats: '600000', borrower_sats: '611500', fee_sats: '500' }, liquidation: { policy: 'passbook-margin-70-80-85-cure10/v1', quote_max_age_blocks: 3, templates: [{ id: 'bucket-01', price_ceiling_cents: '9000000', lock_height: 100, lender_sats: '700000', borrower_sats: '511500', fee_sats: '500' }] } } }
}
function collateral(t = terms()) { return onchainCollateralFor({ ...t, loan_id: c.onchainLoanId(t) }) }
function funding(t = terms()): c.OnchainOriginationIntent {
  return { domain: 'passbook-rgb-joint-intent/v1', action: 'origination', loan_id: c.onchainLoanId(t), network: t.settlement.network, asset: t.settlement.asset, amount: t.principal, rgb_input: { txid: 'aa'.repeat(32), vout: 0, value_sats: '1000', script_pubkey: l }, borrower_btc_inputs: [{ txid: 'bb'.repeat(32), vout: 0, value_sats: '2000000', script_pubkey: b }], rgb_output_vout: 2, collateral_output_vout: 1, lender_btc_return_vout: 3, borrower_change_vout: 4 }
}
function repayment(t = terms()): c.OnchainRepaymentIntent {
  return { domain: 'passbook-rgb-joint-intent/v1', action: 'repayment', loan_id: c.onchainLoanId(t), network: t.settlement.network, asset: t.settlement.asset, amount: t.settlement.debt, rgb_input: { txid: '02'.repeat(32), vout: 0, value_sats: '1000', script_pubkey: b }, borrower_btc_inputs: [{ txid: '03'.repeat(32), vout: 0, value_sats: '5000', script_pubkey: b }], collateral: { txid: '01'.repeat(32), vout: 1, value_sats: t.collateral_sats, script_pubkey: collateral(t).script_pubkey }, rgb_output_vout: 1, collateral_return_vout: 2, borrower_change_vout: 3 }
}
function evidence(t = terms()): c.OnchainRepaymentEvidence {
  return { domain: 'passbook-rgb-joint-evidence/v1', funding: { intent: funding(t), txid: '01'.repeat(32), input_history: [artifact], transfer_consignment: artifact }, repayment: { intent: repayment(t), txid: '04'.repeat(32), input_history: [artifact], transfer_consignment: { ...artifact, sha256: '06'.repeat(32) } } }
}
function proposal(t = terms()): c.OnchainJointProposal { return { domain: 'passbook-rgb-joint-proposal/v1', terms: t, intent: repayment(t), colored_psbt_base64: 'cHNidP8=', input_history: [artifact], transfer_consignment: artifact } }
const origin: JointEvent[] = ['verify-funding', 'presign-enforcement', 'export-funding', 'confirm-funding']
const repaid: JointEvent[] = [...origin, 'verify-repayment', 'export-repayment', 'confirm-repayment']

describe('G0 joint contract', () => {
  it('pins exact A/F/D scripts, tree, NUMS and independently checked public vector', () => {
    const vector = JSON.parse(readFileSync(new URL('./onchain-collateral-vector.json', import.meta.url), 'utf8'))
    assert.deepEqual(onchainCollateralFor(vector.input), vector.output)
    assert.equal(c.ONCHAIN_NUMS_KEY, bytesToHex(NUMS_KEY))
    assert.deepEqual(Object.keys(collateral().leaves), ['A', 'F', 'D'])
    assert.notEqual(onchainCollateralFor({ ...vector.input, loan_id: '22'.repeat(32) }).script_pubkey, vector.output.script_pubkey)
    assert.throws(() => onchainCollateralFor({ ...vector.input, lender_pk: vector.input.borrower_pk }), /distinct/)
    assert.throws(() => onchainCollateralFor({ ...vector.input, recovery_height: 500_000_000 }), /height/)
  })
  it('accepts exact structural fixtures without conferring chain or RGB assurance', () => {
    const t = terms(); c.validateOnchainTermsV3(t); c.validateOnchainIntent(funding(t), t); c.validateOnchainIntent(repayment(t), t); c.validateOnchainProposal(proposal(t)); c.validateOnchainEvidence(evidence(t), t)
    assert.equal(c.onchainLoanId(t), hashObject(t)); assert.equal(c.onchainLoanId(JSON.parse(JSON.stringify(t))), c.onchainLoanId(t))
    assert.throws(() => c.assertOnchainV3OriginationAllowed(), /implementation and isolated acceptance/)
    assert.equal(c.ONCHAIN_V3_LIVE_ENABLED, false)
    assert.throws(() => validateTerms(t), /unknown|must be 1 or 2/)
  })
  it('preserves u64 digits and rejects numeric, noncanonical or overflowing amounts', () => {
    assert.equal(c.nativeAmount('9007199254740993'), 9007199254740993n)
    assert.equal(c.nativeAmount(c.MAX_NATIVE_AMOUNT.toString()), c.MAX_NATIVE_AMOUNT)
    for (const bad of [9007199254740992, '-1', '+1', '01', ' 1', '1.0', '1e3', '', (c.MAX_NATIVE_AMOUNT + 1n).toString()]) assert.throws(() => c.nativeAmount(bad), TypeError)
    const t = terms(); t.principal = '9007199254740993'; t.fee = '0'; t.settlement.debt = t.principal; c.validateOnchainTermsV3(t)
    const overflow = terms(); overflow.principal = c.MAX_NATIVE_AMOUNT.toString(); assert.throws(() => c.validateOnchainTermsV3(overflow), /overflow/)
  })
  it('rejects old HTLC fields, wrong fork revision, network, templates and duplicate authorities', () => {
    for (const patch of [{ kind: 'rgb-onchain-htlc' }, { native_revision: 'upstream' }, { input_policy: 'multi-input' }, { internal_key: borrower.pubkey }]) { const t = terms(); Object.assign(t.settlement, patch); assert.throws(() => c.validateOnchainTermsV3(t)) }
    const hashlock = terms(); Object.assign(hashlock.settlement, { payment_hash: '42'.repeat(32) }); assert.throws(() => c.validateOnchainTermsV3(hashlock), /unknown/)
    const net = terms(); net.settlement.network.genesis_hash = '00'.repeat(32); assert.throws(() => c.validateOnchainTermsV3(net), /genesis/)
    const time = terms(); time.recovery_height = 500_000_000; assert.throws(() => c.validateOnchainTermsV3(time), /height/)
    const key = terms(); key.lender_pk = key.borrower_pk; assert.throws(() => c.validateOnchainTermsV3(key), /distinct/)
  })
  it('commits fees, full collateral return and fixed conserving default/liquidation payouts', () => {
    const debt = terms(); debt.settlement.debt = '1'; assert.throws(() => c.validateOnchainTermsV3(debt), /debt/)
    const dust = terms(); dust.settlement.bitcoin_policy.rgb_output_sats = '1'; assert.throws(() => c.validateOnchainTermsV3(dust), /dust/)
    const payout = terms(); payout.settlement.default_payout.borrower_sats = '1'; assert.throws(() => c.validateOnchainTermsV3(payout), /payout/)
    const fee = terms(); fee.settlement.bitcoin_policy.enforcement_fee_cap_sats = '499'; assert.throws(() => c.validateOnchainTermsV3(fee), /payout/)
    const duplicate = terms(); duplicate.settlement.liquidation.templates.push(duplicate.settlement.liquidation.templates[0]); assert.throws(() => c.validateOnchainTermsV3(duplicate), /unique/)
    const beneficiary = terms(); beneficiary.settlement.destinations.borrower_btc_script_pubkey = l; assert.notEqual(c.onchainLoanId(beneficiary), c.onchainLoanId(terms()))
  })
  it('rejects duplicated inputs, output indices and mismatched obligations or amounts', () => {
    const t = terms(), i = repayment(t)
    for (const patch of [{ amount: '1' }, { loan_id: 'ab'.repeat(32) }, { rgb_input: i.collateral }, { collateral_return_vout: i.rgb_output_vout }, { rgb_output_vout: 0 }, { collateral: { ...i.collateral, value_sats: '1' } }]) assert.throws(() => c.validateOnchainIntent({ ...i, ...patch }, t))
    assert.throws(() => c.validateOnchainIntent({ ...funding(t), borrower_btc_inputs: [] }, t))
    assert.throws(() => c.validateOnchainIntent({ ...i, rgb_inputs: [i.rgb_input] }, t), /unknown/)
  })
  it('binds repayment evidence to the exact funding collateral and actual artifact references', () => {
    const t = terms(), e = evidence(t)
    assert.throws(() => c.validateOnchainEvidence({ ...e, native_validated: true }, t), /unknown/)
    const other = evidence(t); other.repayment.intent.collateral.txid = '09'.repeat(32); assert.throws(() => c.validateOnchainEvidence(other, t), /funding collateral/)
    const missing = evidence(t); missing.repayment.input_history = []; assert.throws(() => c.validateOnchainEvidence(missing, t), /history/)
    const artifactSize = evidence(t); artifactSize.repayment.transfer_consignment.byte_length = 33 * 1024 * 1024; assert.throws(() => c.validateOnchainEvidence(artifactSize, t), /byte_length/)
  })
  it('binds shared proposal and local preparation hashes without trusting caller hashes', () => {
    const p = proposal(), context = { request_id: 'rpc-1', idempotency_key: 'repay-1', wallet_id: 'b', network: p.terms.settlement.network, obligation_id: c.onchainLoanId(p.terms) }
    const r: c.OnchainNativePreparation = { context, terms: p.terms, intent: p.intent, intent_hash: '00'.repeat(32), unsigned_psbt_base64: p.colored_psbt_base64, input_history: p.input_history, recipient_id: 'recipient' }
    const h = c.onchainPreparationHash(r)
    assert.equal(h, c.onchainPreparationHash({ ...r, intent_hash: '11'.repeat(32), context: { ...context, request_id: 'retry', idempotency_key: 'different' } }))
    assert.notEqual(h, c.onchainPreparationHash({ ...r, context: { ...context, wallet_id: 'l' } }))
    assert.notEqual(c.onchainProposalHash(p), c.onchainProposalHash({ ...p, colored_psbt_base64: 'changed' }))
    const spend: c.OnchainEnforcementIntent = { parent_proposal_hash: c.onchainProposalHash(p), kind: 'default', template_id: null, unsigned_psbt_base64: 'future-C-and-fixed-payouts' }
    const eh = c.onchainEnforcementHash(context, spend)
    for (const change of [{ ...spend, unsigned_psbt_base64: 'other-C' }, { ...spend, parent_proposal_hash: '11'.repeat(32) }, { ...spend, kind: 'liquidation' as const, template_id: 'bucket-01' }]) assert.notEqual(eh, c.onchainEnforcementHash(context, change))
    assert.equal(c.checkIdempotentReplay(undefined, h), 'new'); assert.equal(c.checkIdempotentReplay(h, h), 'existing')
    assert.throws(() => c.checkIdempotentReplay(h, c.onchainPreparationHash({ ...r, recipient_id: 'other' })), /IDEMPOTENCY_CONFLICT/)
  })
  it('binds actual decoded RGB summary, proposal, operation and signing decision', () => {
    const p = proposal(), i = p.intent as c.OnchainRepaymentIntent
    const s: c.OnchainDecodedSummary = { kind: 'rgb-onchain-joint', action: 'repayment', wallet_id: 'b', network: p.terms.settlement.network, obligation_id: i.loan_id, inputs: [{ outpoint: i.collateral, value_sats: i.collateral.value_sats, script_pubkey: i.collateral.script_pubkey, sequence: 0xfffffffe, sighash: 'DEFAULT' }], outputs: [{ vout: 1, value_sats: '1000', script_pubkey: l, allocations: [{ asset: i.asset, amount: i.amount }] }], transaction_version: 2, locktime: 0, fee_sats: '500', unsigned_txid: '20'.repeat(32) }
    assert.equal(c.onchainDecodedSummaryHash(s), summaryHash(s))
    assert.notEqual(c.onchainDecodedSummaryHash(s), c.onchainDecodedSummaryHash({ ...s, fee_sats: '501' }))
    const auth: c.OnchainSigningAuthorization = { domain: 'passbook-onchain-signing-authorization/v1', decision_id: 'd', policy_version: 1, intent_hash: '10'.repeat(32), proposal_hash: c.onchainProposalHash(p), decoded_summary_hash: c.onchainDecodedSummaryHash(s), operation_id: 'op', issued_at: 100, expires_at: 200, signature: '00'.repeat(64) }
    assert.equal(c.onchainSigningAuthorizationHash(auth), c.onchainSigningAuthorizationHash({ ...auth, signature: '11'.repeat(64) }))
    for (const changed of [{ ...auth, operation_id: 'other' }, { ...auth, proposal_hash: '11'.repeat(32) }, { ...auth, expires_at: 201 }]) assert.notEqual(c.onchainSigningAuthorizationHash(auth), c.onchainSigningAuthorizationHash(changed))
  })
  it('rejects weak signature hash modes rather than changing the atomic transaction', () => {
    c.assertOnchainWholeTransactionSighash(0); c.assertOnchainWholeTransactionSighash(1)
    for (const bad of [2, 3, 0x80, 0x81, 0x82, 0x83, undefined, true, 'ALL']) assert.throws(() => c.assertOnchainWholeTransactionSighash(bad), /SIGHASH/)
  })
  it('leaves historical v1/v2 hashes and accepted terms unchanged', () => {
    const t = terms(), base: LoanTerms = { v: 1, borrower_pk: t.borrower_pk, lender_pk: t.lender_pk, platform_pk: t.platform_pk, asset_id: 'rgb:fixture-asset', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000, oracle_quote: t.oracle_quote, open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: '11'.repeat(32) }
    const v2: LoanTerms = { ...base, v: 2, atomic_repayment: { invoice: 'lnbcrt1historical-fixture', btc_amount_msat: 3_000_000, payment_hash: sha256Hex(hexToBytes('42'.repeat(32))), expires_at: 1_900_000_000, payee_pubkey: '02' + lender.pubkey } }
    validateTerms(base, null); validateTerms(v2, null)
    assert.equal(termsHash(base), '8eb4e7d650853429e78f547fe7439affc5a5504773a74d54dfb2eb9ff8590cbc')
    assert.equal(termsHash(v2), '35b40ca90b96bcc391dafb3c1a3dee1b1555c366f456cdeed62e43e294bdc261')
  })
})
describe('G0 old counterexamples and joint outcome model', () => {
  it('reproduces all three failures of the rejected independent-output design', () => {
    assert.equal(Object.keys(findHtlcCounterexamples()).length, 3)
    assert.equal(htlcViolation(modelTrace(['advance-refund', 'advance-default', 'confirm-default', 'confirm-claim'])), 'lender-collects-rgb-and-collateral')
    assert.equal(htlcViolation(modelTrace(['publish-secret', 'confirm-e', 'advance-refund', 'confirm-refund'])), 'borrower-recovers-rgb-and-collateral')
    assert.equal(htlcViolation(modelTrace(['confirm-claim', 'reorg-claim', 'confirm-e', 'advance-refund', 'confirm-refund'])), 'borrower-recovers-rgb-and-collateral')
    assert.equal(htlcTransition(HTLC_MODEL_INITIAL, 'confirm-refund'), undefined)
  })
  it('finds no split outcome in all reachable finite joint-model states', () => {
    const result = exploreJointModel(); assert.ok(result.states > 100); assert.deepEqual(result.violations, [])
  })
  it('cannot enforce default on unfunded collateral or export funding without the full fixed enforcement set', () => {
    assert.equal(jointTransition(JOINT_INITIAL, 'confirm-default'), undefined)
    assert.equal(jointTransition(jointTrace(['verify-funding']), 'export-funding'), undefined)
    const s = jointTrace(origin); assert.equal(s.principal_paid, true); assert.equal(s.collateral, 'unspent')
  })
  it('conflicts repayment with default, liquidation, recovery and spent RGB inputs', () => {
    const s = jointTrace(repaid)
    for (const event of ['confirm-default', 'confirm-liquidation', 'confirm-recovery'] as const) assert.equal(jointTransition({ ...s, tip: 205, liquidation_authorized: true }, event), undefined)
    for (const tail of [['advance-default', 'confirm-default'], ['authorize-liquidation', 'confirm-liquidation'], ['advance-recovery', 'confirm-recovery'], ['spend-rgb-elsewhere']] as JointEvent[][]) assert.equal(jointTransition(jointTrace([...origin, 'verify-repayment', 'export-repayment', ...tail]), 'confirm-repayment'), undefined)
  })
  it('rolls both repayment legs back on reorg without revoking exported signatures', () => {
    const s = jointTrace([...repaid, 'reorg-repayment']); assert.equal(s.collateral, 'unspent'); assert.equal(s.rgb_debt, 'available'); assert.equal(s.repayment_exported, true); assert.equal(jointViolation(s), undefined)
    const f = jointTrace([...repaid, 'reorg-funding']); assert.equal(f.collateral, 'absent'); assert.equal(f.principal_paid, false); assert.equal(f.funding_exported, true); assert.equal(f.repayment_exported, true); assert.equal(jointViolation(f), undefined)
  })
})
