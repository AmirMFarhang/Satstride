// G2b part 2 (local): mapping negotiated economics (Micro/Sats numbers) to #56's
// v3 joint terms (decimal strings, pinned protocol, both parties' targets).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JointRefused } from '../src/joint/ports.js'
import { jointTermsV3, type BorrowerJointTargets, type JointEconomics, type JointPolicy, type LenderJointTargets } from '../src/joint/terms-v3.js'
import { ASSET, jointTerms } from './joint-fakes.js'

function inputs() {
  const t = jointTerms(), d = t.settlement.destinations
  const economics: JointEconomics = { borrower_pk: t.borrower_pk, lender_pk: t.lender_pk, platform_pk: t.platform_pk, principal: Number(t.principal), fee: Number(t.fee), collateral_sats: Number(t.collateral_sats), oracle_quote: t.oracle_quote, open_height: t.open_height, maturity_height: t.maturity_height, grace_blocks: t.grace_blocks, recovery_height: t.recovery_height, ladder_step: t.ladder_step, ltv_bps: t.ltv_bps, prev_passbook_txid: t.prev_passbook_txid, nonce: t.nonce }
  const borrower: BorrowerJointTargets = { recipient_id: 'utxob:borrower-principal', borrower_rgb_script_pubkey: d.borrower_rgb_script_pubkey, borrower_btc_script_pubkey: d.borrower_btc_script_pubkey, borrower_change_script_pubkey: d.borrower_change_script_pubkey }
  const lender: LenderJointTargets = { recipient_id: 'utxob:lender-debt', lender_rgb_script_pubkey: d.lender_rgb_script_pubkey, lender_btc_script_pubkey: d.lender_btc_script_pubkey }
  const policy: JointPolicy = { bitcoin_policy: t.settlement.bitcoin_policy, confirmations: t.settlement.confirmations, default_payout: t.settlement.default_payout, liquidation: { quote_max_age_blocks: t.settlement.liquidation.quote_max_age_blocks, templates: t.settlement.liquidation.templates } }
  return { t, economics, borrower, lender, policy }
}
const refused = (code: string) => (e: unknown) => e instanceof JointRefused && e.code === code

test('joint terms: negotiated micro-units and sats map exactly onto v3 decimal strings with the pinned protocol', () => {
  const { t, economics, borrower, lender, policy } = inputs()
  const out = jointTermsV3(economics, ASSET, borrower, lender, policy)
  assert.deepEqual(out.terms, t)
  assert.equal(out.terms.settlement.debt, '101000000')
  assert.equal(out.borrower_recipient_id, 'utxob:borrower-principal'); assert.equal(out.lender_recipient_id, 'utxob:lender-debt')
  // Beyond 2^53 a Number would round; amounts stay exact as strings and BigInt.
  const big = jointTermsV3({ ...economics, principal: Number.MAX_SAFE_INTEGER, fee: 1 }, ASSET, borrower, lender, policy)
  assert.equal(big.terms.settlement.debt, '9007199254740992')
})

test('joint terms: refuses what cannot be mapped exactly', () => {
  const { economics, borrower, lender, policy } = inputs()
  assert.throws(() => jointTermsV3(economics, { ...ASSET, precision: 8 }, borrower, lender, policy), refused('JOINT_TERMS_UNITS'))
  assert.throws(() => jointTermsV3({ ...economics, principal: 1.5 }, ASSET, borrower, lender, policy), refused('JOINT_TERMS_UNITS'))
  assert.throws(() => jointTermsV3({ ...economics, principal: 0 }, ASSET, borrower, lender, policy), refused('JOINT_TERMS_UNITS'))
  assert.throws(() => jointTermsV3({ ...economics, collateral_sats: -1 }, ASSET, borrower, lender, policy), refused('JOINT_TERMS_UNITS'))
  assert.throws(() => jointTermsV3(economics, ASSET, { ...borrower, borrower_btc_script_pubkey: '0014' + '11'.repeat(20) }, lender, policy), refused('JOINT_TERMS_DESTINATION'))
  assert.throws(() => jointTermsV3(economics, ASSET, borrower, { ...lender, lender_rgb_script_pubkey: borrower.borrower_rgb_script_pubkey }, policy), refused('JOINT_TERMS_DESTINATION'))
  assert.throws(() => jointTermsV3(economics, ASSET, borrower, { ...lender, recipient_id: borrower.recipient_id }, policy), refused('JOINT_TERMS_DESTINATION'))
})
