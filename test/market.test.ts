import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { KIND } from '../src/market/kinds.js'
import { decryptFrom, encryptTo, encryptedJson, publicJson, readJson, type OfferPayload } from '../src/market/messages.js'
import { OrderBook } from '../src/market/orderbook.js'
import { Store } from '../src/registry/store.js'

const lender = keyPairFromLabel('lender')
const borrower = keyPairFromLabel('borrower')

const offer: OfferPayload = {
  asset_id: 'rgb:usdt',
  min: 100_000_000,
  max: 5_000_000_000,
  apr_bps: 1000,
  term_blocks: 30,
  grace_blocks: 5,
  ltv_ladder_bps: [5000, 5500, 6000, 6500],
  requirements: { affordability: true, inflow_months: 3, inflow_multiple_bps: 20000 },
  expires_height: 1000,
}

describe('messages', () => {
  it('encrypts between two parties and nobody else can read it', () => {
    const e = encryptedJson(borrower, KIND.APPLICATION, { hello: 'lender' }, lender.pubkey, [])
    assert.deepEqual(readJson(e, lender), { hello: 'lender' })
    assert.deepEqual(readJson(e, borrower), { hello: 'lender' })
    assert.throws(() => readJson(e, keyPairFromLabel('stranger')))
  })
  it('rejects tampered events', () => {
    const e = publicJson(lender, KIND.OFFER, offer, [['d', 'o1']])
    assert.throws(() => readJson({ ...e, content: e.content.replace('1000', '1001') }), /invalid signature/)
  })
  it('encrypts a standalone bundle to the sandbox', () => {
    const sandbox = keyPairFromLabel('sandbox')
    const ct = encryptTo(borrower, sandbox.pubkey, '{"secret":1}')
    assert.equal(decryptFrom(sandbox, borrower.pubkey, ct), '{"secret":1}')
  })
})

describe('orderbook', () => {
  it('ingests valid offers, replaces by d-tag, rejects bad ones', () => {
    const store = new Store()
    const ob = new OrderBook(store)
    const changes: string[] = []
    ob.onChange((o, a) => changes.push(`${a}:${o.id.slice(65)}`))
    const e1 = publicJson(lender, KIND.OFFER, offer, [['d', 'o1']], 1_000_000)
    assert.ok(ob.ingest(e1).offer)
    assert.equal(ob.list(100).length, 1)
    const e2 = publicJson(lender, KIND.OFFER, { ...offer, apr_bps: 900 }, [['d', 'o1']], 2_000_000)
    assert.ok(ob.ingest(e2).offer)
    assert.equal(ob.list(100).length, 1)
    assert.equal(ob.list(100)[0].payload.apr_bps, 900)
    assert.equal(ob.ingest(e1).rejected, 'older than the offer on record')
    assert.equal(ob.list(1000).length, 0, 'expired at its expiry height')
    assert.match(ob.ingest(publicJson(lender, KIND.OFFER, { ...offer, min: -1 }, [['d', 'o2']])).rejected ?? '', /validation/)
    assert.match(ob.ingest(publicJson(lender, KIND.REQUEST, offer, [['d', 'o3']])).rejected ?? '', /not an offer/)
    assert.match(ob.ingest({ ...e2, sig: '00'.repeat(64) }).rejected ?? '', /signature/)
    assert.deepEqual(changes, ['upsert:o1', 'upsert:o1'])
    store.close()
  })
})
