import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { fetchMedianPrice, PRICE_STALE_MS } from '../src/oracle/feed.js'
import { Oracle, verifyQuote } from '../src/oracle/oracle.js'

const epoch = Date.UTC(2026, 9, 17, 9)
function feeds(at: number, overrides: { kraken?: unknown; coinbase?: unknown; bitstamp?: unknown; date?: number; failure?: string } = {}): typeof fetch {
  return (async (url: string) => {
    if (overrides.failure && url.includes(overrides.failure)) return new Response('{}', { status: 503 })
    const body = url.includes('kraken') ? { error: [], result: { XXBTZUSD: { c: [overrides.kraken ?? '100000.00'] } } }
      : url.includes('coinbase') ? { data: { amount: overrides.coinbase ?? '101000.005', base: 'BTC', currency: 'USD' } }
      : { last: overrides.bitstamp ?? '99000.00', timestamp: String(Math.floor(at / 1000)) }
    return new Response(JSON.stringify(body), { headers: { date: new Date(overrides.date ?? at).toUTCString() } })
  }) as typeof fetch
}

describe('three-source signed oracle', () => {
  it('rounds decimal dollars to cents and takes the median of distinct primary feeds', async () => {
    const result = await fetchMedianPrice(feeds(epoch), () => epoch)
    assert.equal(result.price_cents, 10_000_000)
    assert.deepEqual(result.sources.map((s) => s.price_cents), [10_000_000, 10_100_001, 9_900_000])
    assert.equal(result.observed_at, epoch)
  })

  it('rejects malformed prices, cached observations and partial refreshes', async () => {
    for (const values of [{ coinbase: '-3' }, { kraken: 'NaN' }, { bitstamp: 100 }, { date: epoch - PRICE_STALE_MS - 1000 }, { failure: 'kraken' }]) {
      await assert.rejects(fetchMedianPrice(feeds(epoch, values), () => epoch))
    }
  })

  it('retains the last good median and latches demo overrides until explicit return to live', async () => {
    let now = epoch
    let fail = false
    const oracle = new Oracle(keyPairFromLabel('oracle'), 12_000_000, {
      live: true, now: () => now,
      fetcher: (async (...args: Parameters<typeof fetch>) => feeds(now, fail ? { failure: 'coinbase' } : {})(...args)) as typeof fetch,
    })
    assert.throws(() => oracle.quote(1), /unavailable/)
    await oracle.refresh()
    const quote = oracle.quote(1)
    assert.equal(quote.source, 'live_median')
    assert.equal(quote.sources?.length, 3)
    assert.ok(verifyQuote(quote))
    assert.equal(verifyQuote({ ...quote, source: 'demo_override' }), false)
    assert.equal(verifyQuote({ ...quote, observed_at: epoch - 1000 }), false)
    assert.equal(verifyQuote({ ...quote, sources: quote.sources!.map((s) => ({ ...s, price_cents: 1 })) }), false)
    oracle.setPrice(6_100_000)
    await oracle.refresh()
    assert.equal(oracle.currentPrice(), 6_100_000)
    assert.equal(oracle.quote(2).source, 'demo_override')
    await oracle.useLive()
    assert.equal(oracle.currentPrice(), 10_000_000)
    fail = true
    now += PRICE_STALE_MS + 1
    await oracle.refresh()
    assert.equal(oracle.currentPrice(), 10_000_000)
    assert.equal(oracle.status().stale, true)
    assert.match(oracle.status().last_error!, /Coinbase: HTTP 503/)
    assert.throws(() => oracle.quote(3), /stale/)
    oracle.setPrice(6_000_000)
    await assert.rejects(oracle.useLive(), /no fresh/)
    assert.equal(oracle.currentPrice(), 6_000_000)
    assert.ok(verifyQuote(oracle.quote(4)))
  })
})
