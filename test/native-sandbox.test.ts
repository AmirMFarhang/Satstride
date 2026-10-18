// Unit-only synthetic observer receipt. Real native restore evidence is in
// test/regtest/history.test.ts; this suite checks sandbox/lender-view wiring.
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { PlaybookReasoner } from '../src/ai/playbook-reasoner.js'
import { hashObject, keyPairFromLabel, signObject } from '../src/core/crypto.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { historyLedger, type HistoryProof } from '../src/sandbox/reconcile.js'
import { runSandbox } from '../src/sandbox/run.js'
import { publishedRunMaterials } from '../src/sandbox/published-materials.js'
import { verifyRunRecord } from '../src/sandbox/run-record.js'
import { INVESTIGATION_BUDGETS, INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from '../src/sandbox/investigate.js'

function fixture() {
  const f = investigationFixture('fatima'), signer = keyPairFromLabel('fixture-oracle')
  f.bundle.balance = f.bundle.history.reduce((n, r) => n + r.amount, 0)
  f.bundle.asset_id = 'rgb:synthetic-native-unit'
  f.bundle.lender_requirements = { ...f.bundle.lender_requirements, reconciliation: 'required', income_evidence: 'reconciled_tiers' }
  const allocation = { txid: f.bundle.history.at(-1)!.txid, vout: 0, amount: f.bundle.balance, bitcoin_sats: 1000, script: '00' }
  const transfers = f.bundle.history.map((r) => ({ ...r, recipient_id: 'synthetic-unit-recipient' }))
  const proof: Omit<HistoryProof, 'sig'> = { v: 1, assurance: 'trusted_wallet_snapshot', observer_pk: signer.pubkey, borrower_pk: f.bundle.borrower_pk, asset_id: f.bundle.asset_id, wallet_xpubs_hash: hashObject('synthetic-xpubs'), observed_from_zero: true, first_transfer_txid: transfers[0].txid, opening_balance: 0, current_balance: f.bundle.balance, height: 280, transfers, allocations: [allocation], native_snapshot_hash: hashObject({ ledger: historyLedger(transfers), balance: f.bundle.balance, allocations: [allocation] }), btc_history: { status: 'verified', scope: 'declared_xpub_branches', xpubs_hash: hashObject('synthetic-xpubs'), gap_limit: 20, scanned_scripts: 1, first_height: 200, current_sats: 1000, rows: [], reasons: [] } }
  f.bundle.history_proof = signObject(proof, signer.secretKey)
  Object.assign(f.chain, { rpc: async (method: string) => { assert.equal(method, 'gettxout'); return { value: 0.00001, scriptPubKey: { hex: '00' } } } })
  return { ...f, config: { ...f, oraclePk: signer.pubkey, blocksPerMonth: 30, reasoner: new PlaybookReasoner(), runArtifactDir: null } }
}
it('qualifies reconciled native income and releases only signed checks/bands to lenders', async () => {
  const f = fixture(), result = await runSandbox(f.bundle, f.config)
  assert.ok(result.checks.every((c) => c.ok), JSON.stringify(result.checks))
  assert.equal(result.income_evidence?.qualified, true)
  assert.equal(result.disclosure_proposal.length, 0)
  assert.equal(result.summary.income_tiers?.payers.filter((p) => p.tier === 1).length, 4)
  const text = JSON.stringify(result.lender_result)
  assert.ok(!text.includes(f.bundle.history[0].txid))
  assert.ok(!text.includes(f.bundle.history[0].counterparty_pk))
  assert.ok(!text.includes('history_proof') && !text.includes('history_metrics') && !text.includes('income_tiers'))
  const expected = await publishedRunMaterials(f.config.reasoner.engine, { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS })
  assert.equal(verifyRunRecord(result.run_record!, expected, f.key.pubkey, INVESTIGATION_BUDGETS, result.investigation).ok, true)
})
it('rejects edited history and excludes signed gifts before counted coverage', async () => {
  const edited = fixture(); edited.bundle.history[0].amount++
  const invalid = await runSandbox(edited.bundle, edited.config)
  assert.equal(invalid.reconciliation?.status, 'failed')
  assert.equal(invalid.income_evidence?.qualified, false)
  const gift = fixture(); for (const row of gift.bundle.history) row.memo = 'gift'
  const result = await runSandbox(gift.bundle, gift.config)
  assert.equal(result.reconciliation?.status, 'verified')
  assert.equal(result.summary.income_monthly_median, 0)
  assert.equal(result.checks.find((c) => c.id === 'inflows')?.ok, false)
  assert.equal(result.income_evidence?.qualified, false)
})
