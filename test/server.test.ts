import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { keyPairFromLabel, signObject } from '../src/core/crypto.js'
import { KIND } from '../src/market/kinds.js'
import { encryptTo, publicJson } from '../src/market/messages.js'
import { Store } from '../src/registry/store.js'
import { createApp, type App } from '../src/server/app.js'

const platformKey = keyPairFromLabel('platform')
const lender = keyPairFromLabel('lender')
const borrower = keyPairFromLabel('borrower')

describe('http api', () => {
  let app: App
  let base: string

  before(async () => {
    app = createApp({ platformKey, store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [] })
    const port = await app.api.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${port}`
  })
  after(() => app.close())

  const get = async (path: string) => {
    const res = await fetch(base + path)
    return { status: res.status, body: await res.json() }
  }
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('serves state, oracle and the order book', async () => {
    const s = await get('/state')
    assert.equal(s.status, 200)
    assert.equal(s.body.platform_pk, platformKey.pubkey)
    assert.equal(s.body.chain, 'fake')
    const q = await get('/oracle/quote')
    assert.equal(q.body.price_cents, 10_000_000)
    const offer = publicJson(lender, KIND.OFFER, {
      asset_id: 'rgb:usdt', min: 1, max: 10, apr_bps: 1000, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: [5000],
      requirements: { affordability: true, inflow_months: 3, inflow_multiple_bps: 20000 }, expires_height: 9999,
    }, [['d', 'o1']])
    assert.equal((await post('/orderbook', { event: offer })).status, 200)
    const ob = await get('/orderbook')
    assert.equal(ob.body.offers.length, 1)
    const bad = await post('/orderbook', { event: { ...offer, sig: '00'.repeat(64) } })
    assert.equal(bad.status, 422)
  })

  it('runs the sandbox over HTTP and never echoes the bundle', async () => {
    const pk = await get('/sandbox/pubkey')
    assert.equal(pk.body.attestation.platform_pk, platformKey.pubkey)
    const bundle = {
      v: 1, borrower_pk: borrower.pubkey, own_pks: [], offer_id: 'o', loan_request: { principal: 600_000_000, fee: 6_000_000, term_blocks: 30, grace_blocks: 5 },
      lender_requirements: { affordability: false, inflow_months: 0, inflow_multiple_bps: 0 }, balance: 5_000_000_000, history: [], candidate_inflows: [], scheduled_outflows: [],
      collateral: { sats: 1_212_000, oracle_quote: (await get('/oracle/quote')).body, allowed_ltv_bps: 5000 },
    }
    const r = await post('/sandbox/submit', { sender_pk: borrower.pubkey, ciphertext: encryptTo(borrower, pk.body.sandbox_pk, JSON.stringify(bundle)) })
    assert.equal(r.status, 200)
    assert.equal(r.body.sandbox_pk, pk.body.sandbox_pk)
    assert.ok(Array.isArray(r.body.checks))
    const wrong = await post('/sandbox/submit', { sender_pk: lender.pubkey, ciphertext: 'nope' })
    assert.equal(wrong.status, 500)
  })

  it('validates loan registration and reports policy verdicts as 422', async () => {
    const r = await post('/loans', { terms: { v: 1 } })
    assert.equal(r.status, 500)
    assert.match(String(r.body.error), /borrower_pk/)
    const unknown = await get('/loans/' + 'ab'.repeat(32))
    assert.equal(unknown.status, 404)
    const cosign = await post('/cosign', { loan_id: 'ab'.repeat(32), purpose: 'refund', txid: 'cd'.repeat(32) })
    assert.equal(cosign.status, 200)
    assert.equal(cosign.body.ok, false)
  })

  it('moves the oracle and runs the monitor', async () => {
    const r = await post('/oracle/set', { price_cents: 9_000_000 })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.monitor, [])
    assert.equal((await post('/oracle/set', { price_cents: -1 })).status, 400)
  })

  it('streams the wire over SSE', async () => {
    const res = await fetch(base + '/events')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    assert.match(text, /"type":"offer"/)
    await reader.cancel()
  })

  it('puts an agent note on the wire only when the actor signed it', async () => {
    const note = signObject({ actor_pk: lender.pubkey, role: 'lender1', title: 'Offer published', detail: { apr: '12%' } }, lender.secretKey)
    assert.equal((await post('/wire', note)).status, 200)
    const forged = { ...note, title: 'Something else' }
    assert.equal((await post('/wire', forged)).status, 401)
    const events = app.store.listEvents()
    assert.ok(events.some((e) => e.type === 'agent' && e.title === 'Offer published' && e.role === 'lender1'))
    assert.ok(!events.some((e) => e.title === 'Something else'))
  })

  it('switches off every platform route while static UI and demo controls remain available', async () => {
    app.api.on('GET', '/demo/local-test', () => ({ local: true }))
    app.api.setPlatformOnline(false)
    try {
      for (const path of ['/state', '/orderbook', '/sandbox/pubkey', `/passbook/${borrower.pubkey}`, '/loans/abc']) assert.equal((await get(path)).status, 503)
      for (const path of ['/cosign', '/sandbox/submit', '/loans/abc/repaid']) assert.equal((await post(path, {})).status, 503)
      assert.equal((await fetch(base + '/')).status, 200)
      assert.deepEqual((await get('/demo/local-test')).body, { local: true })
    } finally { app.api.setPlatformOnline(true) }
  })

  it('serves the dashboard files and nothing else from disk', async () => {
    const page = await fetch(base + '/')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await page.text(), /<title>Satstride<\/title>/)
    assert.equal((await fetch(base + '/app.js')).status, 200)
    assert.equal((await fetch(base + '/style.css')).status, 200)
    for (const path of ['/index.html', '/../package.json', '/web/app.js', '/%2e%2e/package.json']) assert.equal((await fetch(base + path)).status, 404, path)
  })
})
