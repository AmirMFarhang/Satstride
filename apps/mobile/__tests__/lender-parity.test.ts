// The phone lender (src/agent/lender.ts, worklet/party.js) is held to the laptop's code in
// src/: the sandbox run materials it pins, its policy, the per-loan repayment account it
// derives, and the three notices the platform verifies with the lender's key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mnemonicToSeedSync } from '@scure/bip39'
import { HDKey } from '@scure/bip32'
import { hashObject, verifyHash, verifyObject } from '../../../src/core/crypto.ts'
import { PUBLISHED_QVAC_MODELS, publishedRunMaterials } from '../../../src/sandbox/published-materials.ts'
import { INVESTIGATION_BUDGETS, INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from '../../../src/sandbox/investigate.ts'
import { L2_POLICY } from '../../../src/agents/lender.ts'
import { repaymentMnemonic, watchKeys } from '../../../src/rgb/watch.ts'
import { verifyRunRecord } from '../../../src/sandbox/run-record.ts'
import { expectedRunMaterials, PASSBOOK_ONLY } from '../src/agent/lender.ts'
import pin from '../src/agent/run-materials.json'

const require = createRequire(import.meta.url)
const { rootFromSeed, rgbKeys } = require('../worklet/keys.js')
const { PartyKey } = require('../worklet/party.js')

const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const defs = { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS }

test('the pinned run materials are what src/ publishes (run `npm run materials` if this fails)', async () => {
  for (const id of ['rules', 'playbook:passbook-v1', ...Object.keys(PUBLISHED_QVAC_MODELS), 'some-unpublished-model', '']) {
    assert.deepEqual(expectedRunMaterials(id), await publishedRunMaterials(id, defs), id)
  }
  assert.deepEqual(pin.budgets, { ...INVESTIGATION_BUDGETS })
  assert.equal(verifyRunRecord({} as never, expectedRunMaterials('rules'), '00'.repeat(32), pin.budgets).ok, false)
})

test('the phone lender\'s policy is the laptop\'s L2 ("passbook only")', () => {
  assert.deepEqual(PASSBOOK_ONLY, L2_POLICY)
})

test('the per-loan repayment account matches src/rgb/watch.ts for the same seed and loan', async () => {
  const seed = mnemonicToSeedSync(WORDS)
  const party = new PartyKey(rootFromSeed(seed))
  const secret = HDKey.fromMasterSeed(seed).derive("m/86'/1'/0'/0/0").privateKey!
  for (const loanId of ['70a2efd7f096deaa3cfb4d3ead7e7a0c3fd877be45e8f84df4c8d5e20d3bf1a0', 'ab'.repeat(32)]) {
    const k = rgbKeys(rootFromSeed(party.repaymentSeed(loanId)))
    const laptop = await watchKeys(repaymentMnemonic(secret, loanId))
    assert.deepEqual({ account_xpub_vanilla: k.accountXpubVanilla, account_xpub_colored: k.accountXpubColored, master_fingerprint: k.masterFingerprint }, laptop)
  }
  assert.throws(() => party.repaymentSeed('zz'), /bad loan id/)
})

test('the funding notice, repayment ack and watch request verify as the platform checks them', () => {
  const party = new PartyKey(rootFromSeed(mnemonicToSeedSync(WORDS)))
  const loanId = '11'.repeat(32)
  const txid = '22'.repeat(32)
  const keys = { account_xpub_vanilla: 'tpubA', account_xpub_colored: 'tpubB', master_fingerprint: 'abcd0123' }
  // src/server/platform.ts recordFunded / recordRepaid / registerRepaymentWatch
  const funding = party.signObject({ loan_id: loanId, disbursement_txid: txid })
  assert.ok(verifyHash(funding.sig, hashObject({ loan_id: loanId, disbursement_txid: txid }), party.pubkey))
  const ack = party.signObject({ loan_id: loanId, repayment_txid: txid })
  assert.ok(verifyHash(ack.sig, hashObject({ loan_id: loanId, repayment_txid: txid }), party.pubkey))
  const watch = party.signObject({ loan_id: loanId, ...keys })
  assert.ok(verifyHash(watch.sig, hashObject({ loan_id: loanId, ...keys }), party.pubkey))
  // the repayment receipt the borrower checks (src/registry/passbook-doc.ts rgbRepaymentReceipt)
  const receipt = party.signObject({ domain: 'passbook-rgb-repayment-v1', loan_id: loanId, repayment_txid: txid, asset_id: 'rgb:x', amount: 5, validator_pk: party.pubkey, validation: 'rgb-lib-settled' })
  assert.ok(verifyObject(receipt, party.pubkey))
})
