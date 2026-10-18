// The RGB history moved behind the rgb adapter unchanged: the same rows
// BorrowerAgent built before, and the adapter only adds layer, provenance and
// evidence level.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashObject, keyPairFromLabel, randomHex, signHash } from '../src/core/crypto.js'
import { issueChallenge } from '../src/networks/challenge.js'
import { normalizeRgbRows, RgbAdapter, rgbHistoryRows } from '../src/networks/rgb.js'
import type { CandidateInflow } from '../src/sandbox/types.js'

const ASSET = 'rgb:usdt-test'
const t = (txid: string, kind: string, status: string, amount: number) => ({ txid, kind, status, amount })
const wallet = { transfers: (asset?: string) => (asset === ASSET ? [
  t('a1'.repeat(32), 'ReceiveWitness', 'Settled', 500),
  t('b2'.repeat(32), 'Send', 'Settled', 120),
  t('c3'.repeat(32), 'ReceiveBlind', 'WaitingConfirmations', 50),
  t('d4'.repeat(32), 'Issuance', 'Settled', 1_000_000),
  t('e5'.repeat(32), 'ReceiveWitness', 'Settled', 70),
  { txid: null, kind: 'ReceiveBlind', status: 'Settled', amount: 9 },
  t('f6'.repeat(32), 'ReceiveWitness', 'Settled', 33),
] : []) }
const heights: Record<string, number | null> = { ['a1'.repeat(32)]: 10, ['b2'.repeat(32)]: 12, ['e5'.repeat(32)]: 15, ['f6'.repeat(32)]: null }
const chain = { getTx: async (txid: string) => (txid in heights ? { txid, height: heights[txid], inputs: [], outputs: [] } : null) }
const payer = keyPairFromLabel('rgb-test-payer'), borrower = keyPairFromLabel('rgb-test-borrower')
const inflows = [{ txid: 'a1'.repeat(32), payer_pk: payer.pubkey, memo: 'salary' }]
const labels = { ['b2'.repeat(32)]: { counterparty_pk: 'cd'.repeat(32), memo: 'rent' } }

describe('rgb adapter', () => {
  it('rows are exactly what the borrower wallet produced before: settled, anchored, non-issuance, seeded > label > unknown', async () => {
    const rows = await rgbHistoryRows({ wallet, assetId: ASSET, chain, inflows, labels })
    assert.deepEqual(rows, [
      { txid: 'a1'.repeat(32), height: 10, direction: 'in', amount: 500, counterparty_pk: payer.pubkey, memo: 'salary' },
      { txid: 'b2'.repeat(32), height: 12, direction: 'out', amount: 120, counterparty_pk: 'cd'.repeat(32), memo: 'rent' },
      { txid: 'e5'.repeat(32), height: 15, direction: 'in', amount: 70, counterparty_pk: '00'.repeat(32), memo: '' },
    ])
  })

  it('a payer-signed inflow is counterparty-signed; the rest are client-side-validated', async () => {
    const rows = await rgbHistoryRows({ wallet, assetId: ASSET, chain, inflows, labels })
    const signed: CandidateInflow[] = [{ txid: 'a1'.repeat(32), height: 10, amount: 500, payer_pk: payer.pubkey, payer_sig: signHash(hashObject({ txid: 'a1'.repeat(32), amount: 500, borrower_pk: borrower.pubkey }), payer.secretKey) }]
    const n = normalizeRgbRows(rows, { chain: 'regtest', assetId: ASSET, borrowerPk: borrower.pubkey, signed, source: 'rgb wallet', height: 20 })
    assert.deepEqual(n.map((r) => r.evidence_level), ['counterparty-signed', 'client-side-validated', 'client-side-validated'])
    assert.deepEqual(n.map((r) => r.provenance.confirmations), [11, 9, 6])
    assert.ok(n.every((r) => r.layer === 'rgb' && r.unit === 'micro-usdt' && r.asset === ASSET))
    // a signature for another borrower does not count
    const wrong = normalizeRgbRows(rows, { chain: 'regtest', assetId: ASSET, borrowerPk: keyPairFromLabel('someone').pubkey, signed, source: 'rgb wallet', height: 20 })
    assert.equal(wrong[0].evidence_level, 'client-side-validated')
  })

  it('applies the window by height: only the last days x blocks-per-day blocks feed the features; balance uses all rows', async () => {
    const row = (h: number, amount: number) => ({ txid: h.toString(16).padStart(64, '0'), height: h, direction: 'in' as const, amount, counterparty_pk: payer.pubkey, memo: '' })
    const rgb = new RgbAdapter('regtest', { borrowerPk: borrower.pubkey, assetId: ASSET, rows: async () => [row(10, 100), row(69, 200), row(70, 300), row(100, 400)], signed: [], height: async () => 100, blocksPerDay: 1 })
    const h = await rgb.history([], { from_time: 0, to_time: 30 * 86_400 })
    assert.deepEqual(h.rows.map((r) => r.height), [100], '30 days at 1 block a day: heights 71 to 100')
    assert.equal(h.balance, 1_000)
    const year = await rgb.history([], { from_time: 0, to_time: 365 * 86_400 })
    assert.deepEqual(year.rows.map((r) => r.height), [10, 69, 70, 100])
    const noHeight = await new RgbAdapter('regtest', { borrowerPk: borrower.pubkey, assetId: ASSET, rows: async () => [row(10, 1)], signed: [] }).history([], { from_time: 0, to_time: 86_400 })
    assert.ok(noHeight.limits.includes('RGB_WINDOW_NOT_APPLIED: no chain height'))
  })

  it('proves control with the Passbook party key and fails for another', async () => {
    const N = randomHex(32), L = randomHex(32)
    const rgb = new RgbAdapter('regtest', { party: borrower, borrowerPk: borrower.pubkey, assetId: ASSET, rows: async () => [], signed: [] })
    const c = issueChallenge({ layer: 'rgb', chain: 'regtest', subject: borrower.pubkey, negotiation_id: N, lender_pk: L, now: 1000 })
    const proof = await rgb.proveControl(c)
    assert.ok(rgb.verifyControl(proof, { negotiation_id: N, lender_pk: L, now: 1001, issued: c }).ok)
    const other = keyPairFromLabel('other')
    assert.deepEqual(rgb.verifyControl({ ...proof, subject: other.pubkey, challenge: { ...c, subject: other.pubkey } }, { negotiation_id: N, lender_pk: L, now: 1001 }).reasons, ['CHALLENGE_TEXT_MISMATCH', 'SIGNATURE_INVALID'])
  })
})
