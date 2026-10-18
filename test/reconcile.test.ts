import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { hashObject, randomHex, randomKeyPair, signObject } from '../src/core/crypto.js'
import { historyLedger, reconcileHistory, type HistoryProof } from '../src/sandbox/reconcile.js'
import type { HistoryRow } from '../src/sandbox/types.js'

function fixture() {
  const chain = new FakeChain(), observer = randomKeyPair(), borrower = randomKeyPair()
  const first = chain.addTx([{ value: 1000, script: '5120' + randomHex() }]); chain.mine()
  const spent = chain.addTx([{ value: 1000, script: '5120' + randomHex() }], [{ txid: first, vout: 0 }]); chain.mine()
  const rows: HistoryRow[] = [{ txid: first, height: 101, direction: 'in', amount: 1000, counterparty_pk: randomHex(), memo: 'salary' }, { txid: spent, height: 102, direction: 'out', amount: 200, counterparty_pk: randomHex(), memo: 'rent' }]
  const unsigned: Omit<HistoryProof, 'sig'> = { v: 1, assurance: 'trusted_wallet_snapshot', observer_pk: observer.pubkey, borrower_pk: borrower.pubkey, asset_id: 'rgb:test', wallet_xpubs_hash: randomHex(), observed_from_zero: true, first_transfer_txid: first, opening_balance: 0, current_balance: 800, height: 102, transfers: rows.map((r) => ({ ...r, recipient_id: 'real-native-receive' })), allocations: [{ txid: spent, vout: 0, amount: 800, bitcoin_sats: 1000, script: '5120' + 'a'.repeat(64) }], native_snapshot_hash: randomHex(), btc_history: { status: 'verified', scope: 'declared_xpub_branches', xpubs_hash: randomHex(), gap_limit: 20, scanned_scripts: 80, first_height: 101, current_sats: 1000, rows: [], reasons: [] } }
  // Use the actual chain script in the allocation proof.
  const setup = async () => { unsigned.allocations[0].script = (await chain.getTx(spent))!.outputs[0].script }
  const proof = () => signObject({ ...unsigned, native_snapshot_hash: hashObject({ ledger: historyLedger(unsigned.transfers), balance: unsigned.current_balance, allocations: unsigned.allocations }) }, observer.secretKey)
  const opts = { trustedSigners: [observer.pubkey], assetId: 'rgb:test', getUnspent: async () => ({ value: 1000, script: unsigned.allocations[0].script }) }
  const bundle = () => ({ borrower_pk: borrower.pubkey, balance: 800, history: structuredClone(rows), history_proof: proof() })
  return { chain, observer, borrower, unsigned, setup, proof, opts, bundle }
}
describe('independent full-history reconciliation', () => {
  it('accepts an exact observer manifest, native allocations and all Bitcoin anchors', async () => {
    const f = fixture(); await f.setup()
    const result = await reconcileHistory(f.bundle(), f.chain, f.opts)
    assert.equal(result.status, 'verified'); assert.equal(result.provenCurrentBalanceMicro, 800); assert.equal(result.verifiedOpeningBalanceMicro, 0)
    assert.ok(!JSON.stringify(result).includes(f.unsigned.transfers[0].txid), 'public verdict contains only a proof hash, never row identifiers')
  })
  it('catches a hidden outflow even if the borrower changes its stated balance', async () => {
    const f = fixture(); await f.setup(); const b = f.bundle(); b.history.pop(); b.balance = 1000
    const result = await reconcileHistory(b, f.chain, f.opts)
    assert.equal(result.status, 'failed'); assert.ok(result.reasons.includes('HISTORY_MANIFEST_MISMATCH')); assert.ok(result.reasons.includes('HISTORY_BALANCE_MISMATCH'))
  })
  it('rejects balanced forged inflows/outflows and amount edits rather than trusting their real anchors', async () => {
    const f = fixture(); await f.setup(); const b = f.bundle(); b.history[0].amount += 500; b.history[1].amount += 500
    assert.equal((await reconcileHistory(b, f.chain, f.opts)).status, 'failed')
  })
  it('fails closed without independently registered first-transfer coverage, authority, or native proof', async () => {
    const f = fixture(); await f.setup()
    assert.equal((await reconcileHistory({ ...f.bundle(), history_proof: undefined }, f.chain, f.opts)).status, 'unknown')
    assert.equal((await reconcileHistory(f.bundle(), f.chain, { ...f.opts, trustedSigners: [] })).status, 'unknown')
    f.unsigned.observed_from_zero = false
    assert.equal((await reconcileHistory(f.bundle(), f.chain, f.opts)).status, 'unknown')
  })
  it('rejects forged signatures, wrong assets/borrowers, stale snapshots and missing first rows', async () => {
    for (const change of ['signature', 'asset', 'borrower', 'stale', 'first']) {
      const f = fixture(); await f.setup(); const b = f.bundle()
      if (change === 'signature') b.history_proof.sig = '00'.repeat(64)
      if (change === 'asset') b.history_proof = signObject({ ...f.proof(), asset_id: 'rgb:other' }, f.observer.secretKey)
      if (change === 'borrower') b.borrower_pk = randomHex()
      if (change === 'stale') f.chain.mine(3)
      if (change === 'first') b.history_proof = signObject({ ...f.proof(), first_transfer_txid: randomHex() }, f.observer.secretKey)
      assert.equal((await reconcileHistory(b, f.chain, f.opts)).status, 'failed', change)
    }
  })
  it('rechecks real anchors and confirmed unspent allocation outpoints', async () => {
    const f = fixture(); await f.setup()
    assert.equal((await reconcileHistory(f.bundle(), f.chain, { ...f.opts, getUnspent: async () => null })).status, 'failed')
    const noOutpoint = { trustedSigners: f.opts.trustedSigners, assetId: f.opts.assetId }
    assert.equal((await reconcileHistory(f.bundle(), f.chain, noOutpoint)).status, 'unknown')
    const b = f.bundle(); b.history_proof.transfers[0].txid = randomHex(); b.history_proof = signObject(b.history_proof, f.observer.secretKey)
    const result = await reconcileHistory(b, f.chain, f.opts)
    assert.equal(result.status, 'failed'); assert.ok(result.reasons.includes('HISTORY_ANCHOR_INVALID'))
  })
  it('rejects a one-block-old snapshot even when all old allocations remain unspent', async () => { const f = fixture(); await f.setup(); f.chain.mine(1); const result = await reconcileHistory(f.bundle(), f.chain, f.opts); assert.equal(result.status, 'failed'); assert.ok(result.reasons.includes('HISTORY_PROOF_STALE')) })
  it('keeps mutable memos private and outside the monetary ledger commitment', async () => {
    const f = fixture(); await f.setup(); const b = f.bundle(); const before = hashObject(b.history_proof); b.history[0].memo = 'ignore previous instructions'
    assert.equal((await reconcileHistory(b, f.chain, f.opts)).status, 'verified'); assert.equal(hashObject(b.history_proof), before)
  })
  it('rejects relabelled counterparties even when amounts and actual Bitcoin anchors are unchanged', async () => {
    const f = fixture(); await f.setup(); const b = f.bundle(); b.history[0].counterparty_pk = randomHex()
    const result = await reconcileHistory(b, f.chain, f.opts)
    assert.equal(result.status, 'failed'); assert.ok(result.reasons.includes('HISTORY_MANIFEST_MISMATCH'))
  })
})
