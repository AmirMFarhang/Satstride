// Fake venue APIs for the live index (src/oracle/feed.ts). Each venue answers
// in its own documented response shape, so the parsers are exercised as they
// are in production. No network.
import { Oracle } from '../src/oracle/oracle.js'
import { VENUES } from '../src/oracle/feed.js'
import { keyPairFromLabel, type KeyPair } from '../src/core/crypto.js'

export const EPOCH = Date.UTC(2026, 9, 18, 9)

export type VenueKey = `${string} ${'BTC/USD' | 'BTC/USDT' | 'USDT/USD'}`
/** A book as the venue would print it, or a way for the venue to fail. */
export type VenueBook = { bid: unknown; ask: unknown; date?: number; at?: number } | { status: number }

/** Healthy books near $100,000 and USDT at $1.0000. Mids: USD 100,000 / 99,990 / 100,020 / 100,000; USDT 100,001 / 99,999 / 100,005. */
export const HEALTHY: Record<VenueKey, VenueBook> = {
  'Coinbase BTC/USD': { bid: '99990.00', ask: '100010.00' },
  'Kraken BTC/USD': { bid: '99980.0', ask: '100000.0' },
  'Bitstamp BTC/USD': { bid: '100010', ask: '100030' },
  'Gemini BTC/USD': { bid: '99995.00', ask: '100005.00' },
  'Binance BTC/USDT': { bid: '100000.00000000', ask: '100002.00000000' },
  'OKX BTC/USDT': { bid: '99998', ask: '100000' },
  'Bybit BTC/USDT': { bid: '100004.0', ask: '100006.0' },
  'Kraken USDT/USD': { bid: '0.99990000', ask: '1.00010000' },
  'Coinbase USDT/USD': { bid: '0.9999', ask: '1.0001' },
  'Bitstamp USDT/USD': { bid: '0.99980', ask: '1.00020' },
}

/** Every venue quoting the same mid, with a 2-unit spread; for whole-market scenarios. */
export function market(btcUsd: number, usdtUsd: number, btcUsdt = btcUsd / usdtUsd): Record<VenueKey, VenueBook> {
  const book = (mid: number, half: number, dp: number) => ({ bid: (mid - half).toFixed(dp), ask: (mid + half).toFixed(dp) })
  const out = {} as Record<VenueKey, VenueBook>
  for (const v of VENUES) {
    const key = `${v.name} ${v.pair}` as VenueKey
    out[key] = v.pair === 'BTC/USD' ? book(btcUsd, 0.01, 2) : v.pair === 'BTC/USDT' ? book(btcUsdt, 0.01, 2) : book(usdtUsd, 0.0001, 6)
  }
  return out
}

function body(key: string, b: { bid: unknown; ask: unknown }, at: number): unknown {
  const [name, pair] = key.split(' ')
  if (name === 'Kraken') return { error: [], result: { [pair === 'BTC/USD' ? 'XXBTZUSD' : 'USDTZUSD']: { a: [b.ask, '1', '1.000'], b: [b.bid, '1', '1.000'], c: ['0', '0'] } } }
  if (name === 'Coinbase') return { bid: b.bid, ask: b.ask, price: '1', size: '0.1', time: new Date(at - 60_000).toISOString(), trade_id: 1, volume: '1' }
  if (name === 'Bitstamp') return { bid: b.bid, ask: b.ask, last: '1', timestamp: String(Math.floor(at / 1000)) }
  if (name === 'Gemini') return { bid: b.bid, ask: b.ask, last: '1', volume: { BTC: '1', USD: '1', timestamp: at - 300_000 } }
  if (name === 'Binance') return { symbol: 'BTCUSDT', bidPrice: b.bid, bidQty: '1', askPrice: b.ask, askQty: '1' }
  if (name === 'OKX') return { code: '0', msg: '', data: [{ instId: 'BTC-USDT', bidPx: b.bid, askPx: b.ask, last: '1', ts: String(at) }] }
  if (name === 'Bybit') return { retCode: 0, retMsg: 'OK', result: { category: 'spot', list: [{ symbol: 'BTCUSDT', bid1Price: b.bid, ask1Price: b.ask, lastPrice: '1' }] }, time: at }
  throw new Error(`no fake for ${key}`)
}

/** A fetch that answers every venue URL from `books`, at time `at`. */
export function venues(at: number, books: Partial<Record<VenueKey, VenueBook>> = {}): typeof fetch {
  const all = { ...HEALTHY, ...books }
  return (async (url: string) => {
    const venue = VENUES.find((v) => v.url === url)
    if (!venue) return new Response('{}', { status: 404 })
    const key = `${venue.name} ${venue.pair}` as VenueKey
    const b = all[key]
    if (!b) throw new Error(`no fake book for ${key}`)
    if ('status' in b) return new Response('{}', { status: b.status })
    return new Response(JSON.stringify(body(key, b, b.at ?? at)), { headers: { date: new Date(b.date ?? at).toUTCString() } })
  }) as typeof fetch
}

/** A live oracle that has refreshed once against `books`. */
export async function liveOracle(books: Partial<Record<VenueKey, VenueBook>> = {}, key: KeyPair = keyPairFromLabel('oracle'), at = EPOCH): Promise<Oracle> {
  const oracle = new Oracle(key, 10_000_000, { live: true, now: () => at, fetcher: venues(at, books) })
  await oracle.refresh()
  return oracle
}
