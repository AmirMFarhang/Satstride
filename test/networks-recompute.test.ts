// The lender recomputes the borrower's on-chain rows from its own source.
// Real recorded mainnet data (block 971896, a public BIP-86 test-vector address
// that belongs to no Passbook user): every transaction proves itself by raw
// bytes, merkle branch and header work. The recompute matches; a tampered row
// is named by txid and field; a left-out row is named; a source that serves
// altered bytes is caught.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { BtcOnchainAdapter } from '../src/networks/btc-onchain.js'
import { bitsToTarget, FallbackSource, headerProblems, MAINNET_MAX_TARGET, merkleRootFromBranch, SnapshotSource, txRecordProblems, type BitcoinSource, type RecordedSnapshot } from '../src/networks/bitcoin-source.js'

const FILE = new URL('./fixtures/networks/mainnet-snapshot.json', import.meta.url).pathname
const ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
const ALL = { from_time: 0, to_time: 2_000_000_000 }
const snap = () => JSON.parse(readFileSync(FILE, 'utf8')) as RecordedSnapshot

describe('recorded mainnet data', () => {
  it('every recorded transaction proves itself: bytes hash to the txid, merkle branch to the header, header work above the mainnet floor', () => {
    const s = snap()
    assert.equal(s.chain, 'bitcoin')
    assert.equal(Object.keys(s.txs).length, 30)
    for (const r of Object.values(s.txs)) assert.deepEqual(txRecordProblems(r, 'bitcoin'), [], r.txid)
    assert.equal(new SnapshotSource(s).label, `recorded mainnet data, block ${s.tip_height}`)
  })

  it('a made-up header is refused: wrong hash, no work, or work below the mainnet floor', () => {
    const r = Object.values(snap().txs)[0]
    assert.ok(headerProblems(r.header, r.block_hash.replace(/^0/, '1'), 'bitcoin').includes('HEADER_HASH_MISMATCH'))
    assert.ok(bitsToTarget(0x207fffff) > MAINNET_MAX_TARGET)
    const forged = r.header.slice(0, 144) + 'ffff7f20' + r.header.slice(152)
    assert.ok(headerProblems(forged, r.block_hash, 'bitcoin').length > 0)
    assert.notEqual(merkleRootFromBranch(r.txid, r.merkle.merkle, r.merkle.pos + 1), merkleRootFromBranch(r.txid, r.merkle.merkle, r.merkle.pos))
  })
})

describe('lender recompute from its own source', () => {
  const borrower = () => new BtcOnchainAdapter('bitcoin', SnapshotSource.fromFile(FILE))
  const lender = (source?: BitcoinSource) => new BtcOnchainAdapter('bitcoin', source ?? SnapshotSource.fromFile(FILE))

  it('matches row for row, and logs every source call with endpoint and height', async () => {
    const claimed = await borrower().history([ADDRESS], ALL)
    assert.equal(claimed.rows.length, 30)
    assert.equal(claimed.balance, 0)
    assert.ok(claimed.rows.every((r) => r.evidence_level === 'chain-recomputable' && r.unit === 'sat' && Number.isInteger(r.amount)))
    const rc = await lender().recompute(claimed, ALL)
    assert.equal(rc.ok, true)
    assert.equal(rc.matched, 30)
    assert.deepEqual([rc.tampered, rc.missing, rc.unknown], [[], [], []])
    assert.ok(rc.calls.length > 30 && rc.calls.every((c) => c.endpoint && c.height === 971896 && c.source === 'recorded mainnet data, block 971896'))
  })

  it('names a tampered row by txid and field', async () => {
    const claimed = await borrower().history([ADDRESS], ALL)
    const victim = claimed.rows.find((r) => r.direction === 'in')!
    const tampered = { ...claimed, rows: claimed.rows.map((r) => (r.txid === victim.txid ? { ...r, amount: r.amount * 100 } : r)) }
    const rc = await lender().recompute(tampered, ALL)
    assert.equal(rc.ok, false)
    assert.deepEqual(rc.tampered, [{ txid: victim.txid, field: 'amount', claimed: String(victim.amount * 100), recomputed: String(victim.amount) }])
    assert.equal(rc.matched, 29)
  })

  it('names a row the borrower left out and a row the lender cannot find', async () => {
    const claimed = await borrower().history([ADDRESS], ALL)
    const left = claimed.rows[5]
    const fake = { ...claimed.rows[6], txid: 'ab'.repeat(32) }
    const rc = await lender().recompute({ ...claimed, rows: [...claimed.rows.filter((r) => r !== left), fake] }, ALL)
    assert.deepEqual(rc.missing, [left.txid])
    assert.deepEqual(rc.unknown, ['ab'.repeat(32)])
    assert.equal(rc.ok, false)
  })

  it('a lender source that serves altered bytes is caught by the proofs, not trusted', async () => {
    const s = snap()
    const txid = Object.keys(s.txs)[2]
    s.txs[txid] = { ...s.txs[txid], hex: s.txs[txid].hex.replace(/..$/, '01') }
    const lying = new SnapshotSource(s)
    const claimed = await borrower().history([ADDRESS], ALL)
    const rc = await lender(lying).recompute(claimed, ALL)
    assert.equal(rc.ok, false)
    assert.ok(rc.lender_history!.limits.some((l) => l.startsWith(`TX_PROOF_FAILED:${txid}`)))
  })

  it('falls back to the recording when the live source is offline, and says so', async () => {
    const offline: BitcoinSource = { label: 'https://mempool.space/api', kind: 'esplora', chain: 'bitcoin', calls: [], tipHeight: async () => { throw new Error('offline') }, addressTxids: async () => [], tx: async () => { throw new Error('offline') }, rawTx: async () => { throw new Error('offline') } }
    const fb = new FallbackSource(offline, SnapshotSource.fromFile(FILE))
    const h = await new BtcOnchainAdapter('bitcoin', fb).history([ADDRESS], ALL)
    assert.equal(fb.usingRecording, true)
    assert.equal(h.source, 'recorded mainnet data, block 971896')
    assert.equal(h.rows.length, 30)
    assert.ok(h.rows.every((r) => r.provenance.source === 'recorded mainnet data, block 971896'))
  })

  it('the window keeps rows by block time; wallet age still sees the first transaction', async () => {
    const h = await borrower().history([ADDRESS], { from_time: 1_750_000_000, to_time: 2_000_000_000 })
    assert.ok(h.rows.length < 30 && h.rows.length > 0)
    assert.ok(h.rows.every((r) => r.time! >= 1_750_000_000))
    assert.equal(h.first_seen_time, 1_683_203_681)
  })
})
