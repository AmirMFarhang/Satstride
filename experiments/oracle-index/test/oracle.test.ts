import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { schemaErrors, type JsonSchema } from '../src/core/schema.js'
import { TERMSHEET_SCHEMA } from '../src/market/termsheet.js'
import { fetchIndexPrice, PRICE_STALE_MS, SAMPLE_MAX_AGE_MS } from '../src/oracle/feed.js'
import { AVERAGE_MAX_GAP_MS, LIQUIDATION_QUOTE_MAX_AGE_MS, liquidationPrices, Oracle, verifyQuote } from '../src/oracle/oracle.js'
import { FAST_WINDOW_MS, SLOW_WINDOW_MS, timeWeightedAverage } from '../src/oracle/twap.js'
import { EPOCH, liveOracle, market, venues } from './oracle-venues.js'

const index = (books: Parameters<typeof venues>[1] = {}) => fetchIndexPrice(venues(EPOCH, books), () => EPOCH)
const reasons = (dropped: { name: string; pair: string; reason: string }[]) => Object.fromEntries(dropped.map((d) => [`${d.name} ${d.pair}`, d.reason]))

describe('BTC/USDT mid-price index', () => {
  it('takes order-book mids from every venue and the median in USDT terms', async () => {
    const r = await index()
    assert.equal(r.price_cents, 10_000_000)
    assert.equal(r.usdt_usd.ppm, 1_000_000)
    assert.equal(r.usdt_usd.implied_ppm, 999_990)
    assert.equal(r.sources.length, 7)
    assert.deepEqual(r.dropped, [])
    assert.deepEqual(r.sources.find((s) => s.name === 'Kraken'), { name: 'Kraken', pair: 'BTC/USD', bid_cents: 9_998_000, ask_cents: 10_000_000, price_cents: 9_999_000, observed_at: EPOCH })
    assert.equal(r.sources.find((s) => s.name === 'Bybit')!.price_cents, 10_000_500)
    assert.equal(r.observed_at, EPOCH)
  })

  it('prices a USDT debt in USDT when USDT is off its peg', async () => {
    // docs/PRICE-ORACLE.md section 4: BTC $60,000, USDT $0.95, so BTC is 63,157.89 USDT.
    const r = await index(market(60_000, 0.95))
    assert.equal(r.usdt_usd.ppm, 950_000)
    assert.equal(r.price_cents, 6_315_789)
    assert.ok(r.sources.filter((s) => s.pair === 'BTC/USD').every((s) => s.bid_cents === 5_999_999 && s.price_cents === 6_315_789))
  })

  it('drops a failed, crossed or too-wide venue and keeps the index', async () => {
    const r = await index({
      'Gemini BTC/USD': { status: 503 },
      'Bybit BTC/USDT': { bid: '100010', ask: '100000' },
      'Kraken USDT/USD': { bid: '0.98', ask: '1.02' },
    })
    assert.deepEqual(reasons(r.dropped), { 'Gemini BTC/USD': 'HTTP 503', 'Bybit BTC/USDT': 'crossed book', 'Kraken USDT/USD': 'spread too wide' })
    assert.deepEqual(r.sources.map((s) => s.name), ['Coinbase', 'Kraken', 'Bitstamp', 'Binance', 'OKX'])
    assert.deepEqual(r.usdt_usd.sources.map((s) => s.name), ['Coinbase', 'Bitstamp'])
    assert.equal(r.price_cents, 10_000_000)
  })

  it('drops a stale, malformed or outlying venue and keeps the index', async () => {
    const r = await index({
      'Bitstamp BTC/USD': { bid: '102995', ask: '103005' },
      'Binance BTC/USDT': { bid: '100000', ask: '100002', date: EPOCH - SAMPLE_MAX_AGE_MS - 1000 },
      'Coinbase USDT/USD': { bid: 0.9999, ask: '1.0001' },
    })
    assert.deepEqual(reasons(r.dropped), { 'Bitstamp BTC/USD': 'outlier: 300 bps from the median', 'Binance BTC/USDT': 'stale book', 'Coinbase USDT/USD': 'invalid decimal price' })
    assert.equal(r.price_cents, 10_000_000)
  })

  it('needs a quorum of each kind of book', async () => {
    await assert.rejects(index({ 'Coinbase USDT/USD': { status: 500 }, 'Kraken USDT/USD': { status: 500 } }), /USDT\/USD: 1 of 2 venues needed/)
    await assert.rejects(index({ 'Gemini BTC/USD': { status: 500 }, 'Kraken BTC/USD': { status: 500 } }), /BTC\/USD: 2 of 3 venues needed \(Kraken BTC\/USD: HTTP 500; Gemini BTC\/USD: HTTP 500\)/)
    await assert.rejects(index({ 'OKX BTC/USDT': { status: 451 }, 'Bybit BTC/USDT': { status: 403 } }), /BTC\/USDT: 1 of 2 venues needed/)
  })

  it('refuses when the USDT/USD books and the BTC books disagree about USDT', async () => {
    // USDT/USD venues say $1.00, but BTC/USDT books trade 5% above BTC/USD.
    await assert.rejects(index(market(100_000, 1, 105_000)), /USDT\/USD index 1000000 ppm and the BTC books' implied 952381 ppm disagree/)
  })

  it('refuses when the venues that remain still disagree', async () => {
    const r = market(100_000, 1)
    await assert.rejects(index({
      ...r,
      'Coinbase BTC/USD': { bid: '99199.99', ask: '99200.01' }, 'Kraken BTC/USD': { bid: '100799.99', ask: '100800.01' },
      'Binance BTC/USDT': { bid: '99299.99', ask: '99300.01' }, 'OKX BTC/USDT': { bid: '100699.99', ask: '100700.01' },
    }), /BTC venues disagree by 160 bps/)
  })

  it('reads venue timestamps and refuses books from the future', async () => {
    const r = await index({ 'OKX BTC/USDT': { bid: '99998', ask: '100000', at: EPOCH + 60_000 } })
    assert.equal(reasons(r.dropped)['OKX BTC/USDT'], 'venue timestamp in the future')
    const old = await index({ 'Bitstamp BTC/USD': { bid: '100010', ask: '100030', at: EPOCH - SAMPLE_MAX_AGE_MS - 1000 } })
    assert.equal(reasons(old.dropped)['Bitstamp BTC/USD'], 'stale book')
  })
})

describe('signed live oracle', () => {
  it('signs the index with its evidence, and the term-sheet schema accepts it', async () => {
    const oracle = await liveOracle()
    const quote = oracle.quote(1)
    assert.equal(quote.source, 'live_median')
    assert.equal(quote.method, 'btc-usdt-mid-index-v1')
    assert.equal(quote.sources?.length, 7)
    assert.equal(quote.usdt_usd?.ppm, 1_000_000)
    assert.ok(verifyQuote(quote))
    assert.equal(verifyQuote({ ...quote, usdt_usd: { ...quote.usdt_usd!, ppm: 950_000 } }), false)
    assert.equal(verifyQuote({ ...quote, sources: quote.sources!.map((s) => ({ ...s, bid_cents: 1 })) }), false)
    const quoteSchema = ((TERMSHEET_SCHEMA as { properties: Record<string, JsonSchema> }).properties.terms as { properties: Record<string, JsonSchema> }).properties.oracle_quote
    assert.deepEqual(schemaErrors(quote, quoteSchema), [])
    assert.deepEqual(schemaErrors(new Oracle(keyPairFromLabel('oracle'), 10_000_000).quote(1), quoteSchema), [])
  })

  it('pauses quotes, so new loans and liquidations, while USDT is off its peg', async () => {
    const oracle = await liveOracle(market(60_000, 0.95))
    assert.equal(oracle.currentPrice(), 6_315_789)
    assert.equal(oracle.status().usdt_peg_ok, false)
    assert.equal(oracle.status().usdt_usd_ppm, 950_000)
    assert.throws(() => oracle.quote(1), /USDT is off its \$1 peg \(0\.9500 USD\); new loans and liquidations are paused until it is back within 0\.9800–1\.0200/)
    const inBand = await liveOracle(market(60_000, 0.985))
    assert.equal(inBand.status().usdt_peg_ok, true)
    assert.ok(verifyQuote(inBand.quote(1)))
  })

  it('retains the last good index and latches demo overrides until explicit return to live', async () => {
    let now = EPOCH
    let down = false
    const oracle = new Oracle(keyPairFromLabel('oracle'), 12_000_000, {
      live: true, now: () => now,
      fetcher: (async (...args: Parameters<typeof fetch>) => venues(now, down ? { 'Coinbase USDT/USD': { status: 503 }, 'Kraken USDT/USD': { status: 503 } } : {})(...args)) as typeof fetch,
    })
    assert.throws(() => oracle.quote(1), /unavailable/)
    await oracle.refresh()
    assert.ok(verifyQuote(oracle.quote(1)))
    assert.equal(oracle.currentPrice(), 10_000_000)
    oracle.setPrice(6_100_000)
    await oracle.refresh()
    assert.equal(oracle.currentPrice(), 6_100_000)
    assert.equal(oracle.quote(2).source, 'demo_override')
    await oracle.useLive()
    assert.equal(oracle.currentPrice(), 10_000_000)
    down = true
    now += PRICE_STALE_MS + 1
    await oracle.refresh()
    assert.equal(oracle.currentPrice(), 10_000_000)
    assert.equal(oracle.status().stale, true)
    assert.match(oracle.status().last_error!, /USDT\/USD: 1 of 2 venues needed/)
    assert.throws(() => oracle.quote(3), /stale/)
    oracle.setPrice(6_000_000)
    await assert.rejects(oracle.useLive(), /no fresh/)
    assert.equal(oracle.currentPrice(), 6_000_000)
    assert.ok(verifyQuote(oracle.quote(4)))
  })
})

describe('time-weighted averages for liquidation', () => {
  const MIN = 60_000
  const steady = (price: number, from: number, to: number, step = 10_000) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => ({ price_cents: price, at: from + i * step }))

  it('weights each price by how long it held, over the whole window', () => {
    const now = EPOCH
    const history = [{ price_cents: 100, at: now - 40 * MIN }, { price_cents: 200, at: now - 15 * MIN }]
    assert.deepEqual(timeWeightedAverage(history, SLOW_WINDOW_MS, now, Infinity), { window_ms: SLOW_WINDOW_MS, price_cents: 150, from: now - 30 * MIN, to: now, samples: 2 })
    assert.equal(timeWeightedAverage(history, FAST_WINDOW_MS, now, Infinity)!.price_cents, 200)
  })

  it('lets a 10-second wick move the averages by its share of the window only', () => {
    const now = EPOCH
    const history = steady(10_000_000, now - 31 * MIN, now).map((o) => o.at === now - 60_000 ? { ...o, price_cents: 5_000_000 } : o)
    assert.equal(timeWeightedAverage(history, SLOW_WINDOW_MS, now, AVERAGE_MAX_GAP_MS)!.price_cents, 9_972_222)
    assert.equal(timeWeightedAverage(history, FAST_WINDOW_MS, now, AVERAGE_MAX_GAP_MS)!.price_cents, 9_833_333)
  })

  it('has no average without a record covering the window, across a gap, or after the record stops', () => {
    const now = EPOCH
    assert.equal(timeWeightedAverage(steady(100, now - 20 * MIN, now), SLOW_WINDOW_MS, now, AVERAGE_MAX_GAP_MS), null, 'only 20 minutes recorded')
    assert.ok(timeWeightedAverage(steady(100, now - 20 * MIN, now), FAST_WINDOW_MS, now, AVERAGE_MAX_GAP_MS))
    const gap = steady(100, now - 31 * MIN, now).filter((o) => o.at < now - 12 * MIN || o.at > now - 10 * MIN)
    assert.equal(timeWeightedAverage(gap, SLOW_WINDOW_MS, now, AVERAGE_MAX_GAP_MS), null, 'a two-minute outage inside the window')
    assert.ok(timeWeightedAverage(gap, FAST_WINDOW_MS, now, AVERAGE_MAX_GAP_MS), 'the 5-minute window starts after it')
    assert.equal(timeWeightedAverage(steady(100, now - 40 * MIN, now - 2 * MIN), SLOW_WINDOW_MS, now, AVERAGE_MAX_GAP_MS), null, 'last observation too old')
    assert.equal(timeWeightedAverage([...steady(100, now - 31 * MIN, now), { price_cents: 1, at: now + MIN }], SLOW_WINDOW_MS, now, AVERAGE_MAX_GAP_MS)!.price_cents, 100, 'future observations ignored')
  })

  it('signs the averages into live quotes once the record covers each window', async () => {
    let now = EPOCH
    let dollars = 100_000
    const oracle = new Oracle(keyPairFromLabel('oracle'), 12_000_000, { live: true, now: () => now, fetcher: (async (...args: Parameters<typeof fetch>) => venues(now, market(dollars, 1))(...args)) as typeof fetch })
    await oracle.refresh()
    assert.deepEqual(oracle.quote(1).averages, { at: now, slow: null, fast: null })
    assert.deepEqual(liquidationPrices(oracle.quote(1)), { spot: 10_000_000, slow: null, fast: null })
    for (let i = 0; i < 30; i++) { now += 10_000; await oracle.refresh() }
    assert.equal(oracle.quote(2).averages!.slow, null)
    assert.equal(oracle.quote(2).averages!.fast!.price_cents, 10_000_000)
    for (let i = 0; i < 151; i++) { now += 10_000; await oracle.refresh() }
    dollars = 61_000
    now += 10_000
    await oracle.refresh()
    assert.equal(oracle.quote(3).averages!.fast!.price_cents, 10_000_000, 'a price observed this instant has held for no time yet')
    now += 10_000
    await oracle.refresh()
    const q = oracle.quote(3)
    assert.equal(q.price_cents, 6_100_000)
    assert.equal(q.averages!.slow!.price_cents, 9_978_333, 'one 10-second step at $61,000 in 30 minutes')
    assert.equal(q.averages!.fast!.price_cents, 9_870_000)
    assert.ok(verifyQuote(q))
    assert.equal(verifyQuote({ ...q, averages: { ...q.averages!, slow: { ...q.averages!.slow!, price_cents: 6_100_000 } } }), false)
    const quoteSchema = ((TERMSHEET_SCHEMA as { properties: Record<string, JsonSchema> }).properties.terms as { properties: Record<string, JsonSchema> }).properties.oracle_quote
    assert.deepEqual(schemaErrors(q, quoteSchema), [])
  })

  it('reads a demo price as all three prices, and refuses a live quote that predates averages', async () => {
    const demo = new Oracle(keyPairFromLabel('oracle'), 6_100_000).quote(1)
    assert.deepEqual(liquidationPrices(demo), { spot: 6_100_000, slow: 6_100_000, fast: 6_100_000 })
    const live = (await liveOracle()).quote(1)
    const { averages: _, ...older } = live
    assert.deepEqual(liquidationPrices({ ...older }), { spot: 10_000_000, slow: null, fast: null })
  })

  it('accepts a lender-supplied quote for a liquidation only when it is ours and recent', async () => {
    let now = EPOCH
    const oracle = new Oracle(keyPairFromLabel('oracle'), 12_000_000, { live: true, now: () => now, fetcher: (async (...args: Parameters<typeof fetch>) => venues(now)(...args)) as typeof fetch })
    await oracle.refresh()
    const q = oracle.quote(1)
    assert.ok(oracle.recentForLiquidation(q))
    assert.equal(oracle.recentForLiquidation({ ...q, price_cents: 1 }), false, 'tampered')
    assert.equal(new Oracle(keyPairFromLabel('other'), 1, { now: () => now }).recentForLiquidation(q), false, 'another oracle')
    assert.equal(oracle.recentForLiquidation({ nonsense: true } as never), false, 'malformed input never throws')
    now += LIQUIDATION_QUOTE_MAX_AGE_MS + 1
    assert.equal(oracle.recentForLiquidation(q), false, 'too old')
  })
})
