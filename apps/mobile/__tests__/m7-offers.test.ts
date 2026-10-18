// Offers straight from the relay: only valid, unexpired offers under the APR cap; the
// platform's order book is a cross-check, not the source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readRelayOffers } from '../src/app/relay-offers.ts'

const payload = (over: Record<string, unknown> = {}) => ({ asset_id: 'rgb:a', min: 100_000_000, max: 5_000_000_000, apr_bps: 1100, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: [5000, 5500, 6000, 6500], requirements: { affordability: true, inflow_months: 0, inflow_multiple_bps: 0, investigation: 'optional' }, expires_height: 1300, ...over })
const ev = (pubkey: string, id: string, d = 'usdt-30-record') => ({ id, pubkey, created_at: 1_800_000_000, tags: [['t', 'passbook'], ['d', d]] })

test('relay offers: valid and unexpired only, with the platform listing as a cross-check', async () => {
  const events = [
    { payload: payload(), event: ev('a'.repeat(64), 'e1') }, // good, listed
    { payload: payload(), event: ev('b'.repeat(64), 'e2') }, // good, not listed
    { payload: payload({ expires_height: 900 }), event: ev('c'.repeat(64), 'e3') }, // expired
    { payload: payload({ apr_bps: 99_999 }), event: ev('d'.repeat(64), 'e4') }, // over the APR cap
    { payload: { nonsense: true }, event: ev('e'.repeat(64), 'e5') }, // not an offer
    { payload: payload(), event: { ...ev('f'.repeat(64), 'e6'), tags: [['t', 'passbook']] } }, // no d tag
  ]
  const book = await readRelayOffers({
    relay: { relays: ['ws://relay'], list: async () => events as never },
    chain: { getHeight: async () => 1000 },
    platform: { orderbook: async () => ({ offers: [{ id: `${'a'.repeat(64)}:usdt-30-record`, event_id: 'e1' }] as never }) },
  })
  assert.deepEqual(book.offers.map((o) => [o.lender_pk[0], o.listed]), [['a', true], ['b', false]])
  assert.equal(book.rejected, 4)
  assert.equal(book.offers[0].id, `${'a'.repeat(64)}:usdt-30-record`)
  // the platform down: offers still come from the relay, marked "couldn't ask"
  const down = await readRelayOffers({ relay: { relays: ['ws://relay'], list: async () => events as never }, chain: { getHeight: async () => 1000 }, platform: { orderbook: async () => { throw new Error('down') } } })
  assert.deepEqual(down.offers.map((o) => o.listed), [null, null])
})
