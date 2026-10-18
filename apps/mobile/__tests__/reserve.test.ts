// The reserve per network: regtest keeps its amounts; Mutinynet's are small enough for the lender
// phone's rationed faucet coins (about 15,000 sats) to carry a whole loan without a second full top-up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureCollateral, ensureRgbReserve, rgbReady, RESERVES, type ReservePorts, type ReserveRules, type Unspent } from '../src/app/reserve.ts'

const FEE = 150
const CREATE_FEE = 420

/** A wallet in memory: the main account, the RGB wallet's vanilla bitcoin and its free colored outputs. */
function wallet(main: number, vanilla = 0, freeSlots = 0) {
  const w = { main, vanilla, freeSlots, moved: 0, moves: 0 }
  const slot = (i: number): Unspent => ({ outpoint: `s${i}:0`, sats: 2_000, colorable: true, exists: true, allocations: [], pendingBlinded: 0, free: true })
  const ports = {
    main: {
      balance: async () => BigInt(w.main),
      quote: async () => BigInt(FEE),
      sign: async (_to: string, sats: bigint, fee: bigint) => JSON.stringify([Number(sats), Number(fee)]),
      broadcast: async (hex: string) => { const [sats, fee] = JSON.parse(hex) as number[]; w.main -= sats + fee; w.vanilla += sats; w.moved += sats; w.moves++; return { txid: 'ab'.repeat(32), fee: BigInt(fee) } },
    },
    rgb: {
      rgbAddress: async () => 'tb1prgb',
      rgbBtcBalance: async () => ({ vanilla: { settled: w.vanilla, future: w.vanilla, spendable: w.vanilla }, colored: { settled: 0, future: 0, spendable: 0 } }),
      rgbUnspents: async () => Array.from({ length: w.freeSlots }, (_, i) => slot(i)),
      rgbCreateUtxos: async (o: { num?: number; size?: number }) => { const n = o.num ?? 1; w.vanilla -= n * (o.size ?? 0) + CREATE_FEE; w.freeSlots += n; return n },
    },
    chain: { getTx: async () => ({ height: 1 }), utxos: async () => [] },
    party: { address: 'tb1pparty', script: '51' },
  } as unknown as ReservePorts
  return { w, ports }
}
/** One of the lender's RGB sends: a 1,000-sat witness output and its fee; the asset's change takes a free slot. */
const send = (w: { vanilla: number; freeSlots: number }) => { w.vanilla -= 1_300; w.freeSlots = Math.max(0, w.freeSlots - 1) }

test('regtest keeps its reserve; Mutinynet uses the smaller one', () => {
  assert.deepEqual(RESERVES.regtest, { vanillaMin: 15_000, vanillaTopUp: 50_000, freeSlotsMin: 2, slotsPerTopUp: 3, slotSats: 5_000, slotFeeMargin: 0, collateralMargin: 1_000 })
  const m = RESERVES.mutinynet
  assert.deepEqual([m.vanillaMin, m.freeSlotsMin, m.slotsPerTopUp, m.slotSats, m.vanillaTopUp], [2_000, 1, 3, 2_000, 10_000])
  assert.ok(m.vanillaMin > 1_300, 'one send (1,000 witness + fee) never starts below the minimum')
})

test("Mutinynet: the lender's whole loan runs on 15,000 sats (post, fund, payout, later sends)", async () => {
  const r = RESERVES.mutinynet
  const { w, ports } = wallet(15_000)
  // post the offer
  await ensureRgbReserve(ports, () => {}, r, 0)
  assert.ok(w.vanilla >= r.vanillaMin, `after the slots are made, vanilla ${w.vanilla} still covers a send`)
  assert.equal(w.freeSlots, 3)
  // fund, then the payout
  await ensureRgbReserve(ports, () => {}, r, 0)
  send(w)
  // later steps: the IOU return, the platform and check fee
  for (let i = 0; i < 2; i++) { await ensureRgbReserve(ports, () => {}, r, 0); assert.ok(w.vanilla >= 1_300, 'enough for the next send'); send(w) }
  assert.ok(w.main >= 0 && w.moved + w.moves * FEE <= 15_000, `moved ${w.moved} of 15,000`)
})

test('a top-up the wallet cannot afford in full moves only what is missing; one it cannot afford at all says so', async () => {
  const r: ReserveRules = RESERVES.mutinynet
  const { w, ports } = wallet(3_000, 500, 1)
  await ensureRgbReserve(ports, () => {}, r, 0)
  assert.equal(w.moved, 1_500, 'the 1,500 sats missing, not the 10,000 top-up')
  assert.equal(w.vanilla, r.vanillaMin)
  const broke = wallet(500, 0, 0)
  await assert.rejects(ensureRgbReserve(broke.ports, () => {}, r, 0), /Not enough bitcoin/)
})

test('regtest behaves as before: a 50,000-sat top-up and three slots', async () => {
  const { w, ports } = wallet(100_000)
  const did = await ensureRgbReserve(ports, () => {}, RESERVES.regtest, 0)
  assert.equal(w.moved, 50_000)
  assert.equal(did.created, 3)
  assert.equal((await rgbReady(ports, RESERVES.regtest)).ready, true)
  assert.equal(await ensureCollateral(ports, 10_000, () => {}, RESERVES.regtest) !== null, true)
  assert.equal(w.moved, 50_000 + 10_000 + 500 + 1_000, 'collateral, the lock fee and the margin')
})
