import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Regtest } from '../../src/chain/regtest.js'
import { randomKeyPair } from '../../src/core/crypto.js'
import { RgbHistoryObserver } from '../../src/rgb/history-observer.js'
import { settle } from '../../src/rgb/wallet.js'
import { watchKeys } from '../../src/rgb/watch.js'
import { reconcileHistory } from '../../src/sandbox/reconcile.js'
import { loadSeed, openParty, type Party } from '../../src/wallet/party.js'
import type { HistoryRow } from '../../src/sandbox/types.js'

describe('trusted history observer with real RGB native watch-only restore', () => {
  it('observes from zero, verifies native amounts/allocations and BTC history, catches hidden or edited rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-history-')), regtest = new Regtest(), signer = randomKeyPair()
    let sender: Party | undefined, borrower: Party | undefined, observer: RgbHistoryObserver | undefined
    try {
      await regtest.ensureMiner()
      sender = await openParty('lender1', { dir, create: true }); borrower = await openParty('borrower', { dir, create: true })
      for (const p of [sender, borrower]) { await regtest.send(p.rgb.address(), 0.05); await regtest.send(p.btcAddress, 0.02) }
      await regtest.mine(1)
      for (const p of [sender, borrower]) await p.rgb.createUtxos(5)
      await regtest.mine(1)
      const assetId = sender.rgb.issueNia({ ticker: 'HIST', name: 'History reconciliation test', precision: 6, amount: 10000e6 })
      observer = new RgbHistoryObserver({ rootDir: join(dir, 'observer'), signer, chain: regtest.chain })
      observer.identifyWallet(sender.key.pubkey, sender.rgb)
      observer.registerFreshWallet({ borrowerPk: borrower.key.pubkey, wallet: borrower.rgb, watchKeys: await watchKeys(loadSeed('borrower', { dir })), assetId })
      const rows: HistoryRow[] = []
      const pay = async (from: Party, to: Party, amount: number) => {
        const sent = await from.rgb.send({ invoice: to.rgb.invoice(amount, assetId).invoice, assetId, amount })
        await settle({ sender: from.rgb, receiver: to.rgb, assetId, txid: sent.txid, mine: () => regtest.mine(1) })
        rows.push({ txid: sent.txid, height: (await regtest.chain.getTx(sent.txid))!.height!, direction: from === borrower ? 'out' : 'in', amount, counterparty_pk: from === borrower ? to.key.pubkey : from.key.pubkey, memo: 'test transfer' })
      }
      await pay(sender, borrower, 1000e6); await pay(borrower, sender, 200e6); await pay(sender, borrower, 100e6)
      const proof = await observer.proof(borrower.key.pubkey)
      const bundle = { borrower_pk: borrower.key.pubkey, balance: borrower.rgb.balance(assetId).settled, history: rows, history_proof: proof }
      const opts = { trustedSigners: [signer.pubkey], assetId, getUnspent: async (txid: string, vout: number) => {
        const u = await regtest.chain.rpc<{ value: number; scriptPubKey: { hex: string } } | null>('gettxout', [txid, vout, true])
        return u ? { value: Math.round(u.value * 1e8), script: u.scriptPubKey.hex } : null
      } }
      const verified = await reconcileHistory(bundle, regtest.chain, opts)
      assert.equal(verified.status, 'verified', JSON.stringify(verified)); assert.equal(verified.provenCurrentBalanceMicro, 900e6)
      assert.ok(proof.btc_history.rows.length >= 3); assert.equal(proof.btc_history.status, 'verified')
      assert.deepEqual(verified.verifiedCounterpartyPks, [sender.key.pubkey])
      assert.equal((await reconcileHistory({ ...bundle, history: rows.filter((r) => r.direction === 'in') }, regtest.chain, opts)).status, 'failed')
      assert.equal((await reconcileHistory({ ...bundle, history: rows.map((r, i) => i ? r : { ...r, amount: r.amount + 1 }) }, regtest.chain, opts)).status, 'failed')
      assert.throws(() => observer!.registerFreshWallet({ borrowerPk: borrower!.key.pubkey, wallet: borrower!.rgb, watchKeys: {} as never, assetId }), /already registered/)
      if (process.env.PASSBOOK_HISTORY_REPORT) writeFileSync(process.env.PASSBOOK_HISTORY_REPORT, JSON.stringify({ recorded_at: new Date().toISOString(), chain: regtest.chain.kind, asset_id: assetId, assurance: proof.assurance, observer_from_zero: proof.observed_from_zero, balance_micro: proof.current_balance, transfers: proof.transfers.map(({ txid, height, direction, amount }) => ({ txid, height, direction, amount })), allocation_count: proof.allocations.length, btc_history: { status: proof.btc_history.status, scope: proof.btc_history.scope, scanned_scripts: proof.btc_history.scanned_scripts, gap_limit: proof.btc_history.gap_limit, transactions: proof.btc_history.rows.length, current_sats: proof.btc_history.current_sats }, hidden_row_rejected: true, amount_edit_rejected: true }, null, 2) + '\n')
      // A transfer that bypasses observation cannot acquire completeness from
      // a native backup after the fact, even when all amounts are genuine.
      observer.close(); observer = undefined
      await pay(sender, borrower, 50e6)
      observer = new RgbHistoryObserver({ rootDir: join(dir, 'observer'), signer, chain: regtest.chain })
      observer.attachWallet(borrower.key.pubkey, borrower.rgb)
      await assert.rejects(observer.proof(borrower.key.pubkey), /unobserved transfer/)
    } finally { observer?.close(); sender?.close(); borrower?.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
