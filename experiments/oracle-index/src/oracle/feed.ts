// The live BTC/USDT index. Loans are denominated in USDT, so the index is in
// USDT terms: BTC/USDT books are used directly, and BTC/USD books are divided
// by a USDT/USD index. Every venue contributes its order-book mid price (best
// bid and ask), never a last trade, which one small trade can set.
//
// A venue that fails, is stale, has a crossed or too-wide book, cannot be
// parsed, or sits too far from the others is dropped and recorded with the
// reason. The index stands while a quorum of each kind of book remains, so one
// venue's outage no longer stops it. Method and parameters:
// docs/PRICE-ORACLE.md, section 6.
//
// Units: BTC prices in cents of the venue's quote currency (USD or USDT);
// USDT/USD in ppm (1_000_000 = one dollar per USDT). The index result is in
// cents of USDT, which is the unit `price_cents` has everywhere in the loan
// math (debts are USDT).

export type BtcPair = 'BTC/USD' | 'BTC/USDT'
export type Pair = BtcPair | 'USDT/USD'

/** One venue's best bid and ask, as decimal strings, and its own data time if it reports one. */
interface Quoted { bid: unknown; ask: unknown; at?: number }
interface Venue { name: string; pair: Pair; url: string; parse(body: any): Quoted }

/** Kraken keys the result by its own pair code; take the single entry instead of guessing it. */
function krakenBook(body: any): Quoted {
  if (!Array.isArray(body?.error) || body.error.length) throw new Error('API error')
  const rows = Object.values(body.result ?? {}) as any[]
  if (rows.length !== 1) throw new Error('expected one pair in the result')
  return { bid: rows[0]?.b?.[0], ask: rows[0]?.a?.[0] }
}
/** Coinbase Exchange ticker. Its `time` is the last trade's, not the book's, so the HTTP Date is used. */
function coinbaseBook(body: any): Quoted { return { bid: body?.bid, ask: body?.ask } }
function bitstampBook(body: any): Quoted { return { bid: body?.bid, ask: body?.ask, at: Number(body?.timestamp) * 1000 } }

export const VENUES: readonly Venue[] = [
  { name: 'Coinbase', pair: 'BTC/USD', url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker', parse: coinbaseBook },
  { name: 'Kraken', pair: 'BTC/USD', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parse: krakenBook },
  { name: 'Bitstamp', pair: 'BTC/USD', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', parse: bitstampBook },
  { name: 'Gemini', pair: 'BTC/USD', url: 'https://api.gemini.com/v1/pubticker/btcusd', parse: (b) => ({ bid: b?.bid, ask: b?.ask }) },
  {
    name: 'Binance', pair: 'BTC/USDT', url: 'https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT',
    parse: (b) => { if (b?.symbol !== 'BTCUSDT') throw new Error('wrong symbol'); return { bid: b.bidPrice, ask: b.askPrice } },
  },
  {
    name: 'OKX', pair: 'BTC/USDT', url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
    parse: (b) => {
      const t = b?.data?.[0]
      if (b?.code !== '0' || t?.instId !== 'BTC-USDT') throw new Error('API error or wrong instrument')
      return { bid: t.bidPx, ask: t.askPx, at: Number(t.ts) }
    },
  },
  {
    name: 'Bybit', pair: 'BTC/USDT', url: 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
    parse: (b) => {
      const t = b?.result?.list?.[0]
      if (b?.retCode !== 0 || t?.symbol !== 'BTCUSDT') throw new Error('API error or wrong symbol')
      return { bid: t.bid1Price, ask: t.ask1Price, at: Number(b.time) }
    },
  },
  { name: 'Kraken', pair: 'USDT/USD', url: 'https://api.kraken.com/0/public/Ticker?pair=USDTUSD', parse: krakenBook },
  { name: 'Coinbase', pair: 'USDT/USD', url: 'https://api.exchange.coinbase.com/products/USDT-USD/ticker', parse: coinbaseBook },
  { name: 'Bitstamp', pair: 'USDT/USD', url: 'https://www.bitstamp.net/api/v2/ticker/usdtusd/', parse: bitstampBook },
]

/** A venue counts only if its book was observed this recently (CF Benchmarks drops books older than 30 s). */
export const SAMPLE_MAX_AGE_MS = 30_000
/** Allowed clock skew between a venue and this host. */
export const FUTURE_SKEW_MS = 30_000
export const FETCH_TIMEOUT_MS = 5_000
/** A wider bid/ask spread means a thin or broken book. */
export const MAX_VENUE_SPREAD_BPS = 100
/** BTC venues more than this from the median are dropped; then the rest must agree within the dispersion limit. */
export const BTC_OUTLIER_BPS = 100
export const BTC_MAX_DISPERSION_BPS = 100
export const USDT_OUTLIER_BPS = 50
export const USDT_MAX_DISPERSION_BPS = 50
/** The USDT/USD index and the rate implied by the BTC/USD and BTC/USDT books must agree this closely. */
export const IMPLIED_MAX_GAP_BPS = 50
/** Venues needed after dropping, per kind of book. */
export const QUORUM: Readonly<Record<Pair, number>> = { 'BTC/USD': 3, 'BTC/USDT': 2, 'USDT/USD': 2 }
/** Outside this USDT/USD band the oracle signs no quote: no new loans and no liquidations. Repayment needs no quote. */
export const USDT_PEG_BAND_PPM = { min: 980_000, max: 1_020_000 } as const
export const PRICE_REFRESH_MS = 10_000
export const PRICE_STALE_MS = 90_000
export const INDEX_METHOD = 'btc-usdt-mid-index-v1' as const

/** A BTC venue in the index. `price_cents` is its mid in USDT cents; bid and ask are raw, in the venue's quote currency. */
export interface PriceSample {
  name: string
  pair: BtcPair
  bid_cents: number
  ask_cents: number
  price_cents: number
  observed_at: number
}
export interface UsdtSample { name: string; bid_ppm: number; ask_ppm: number; ppm: number; observed_at: number }
export interface UsdtIndex {
  /** Median USDT/USD of the venues kept, in ppm. */
  ppm: number
  /** median(BTC/USD mids) ÷ median(BTC/USDT mids), the cross-check. */
  implied_ppm: number
  sources: UsdtSample[]
}
export interface DroppedVenue { name: string; pair: Pair; reason: string }
export interface IndexPrice {
  /** BTC in cents of USDT. */
  price_cents: number
  /** The oldest observation among the venues kept. */
  observed_at: number
  sources: PriceSample[]
  usdt_usd: UsdtIndex
  dropped: DroppedVenue[]
}

export function usdtPegOk(ppm: number): boolean {
  return ppm >= USDT_PEG_BAND_PPM.min && ppm <= USDT_PEG_BAND_PPM.max
}

function decimal(value: unknown, scale: 100 | 1_000_000): number {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) throw new Error('invalid decimal price')
  const units = Math.round(Number(value) * scale)
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error('price must be a positive safe integer')
  return units
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

function gapBps(value: number, reference: number): number {
  return Math.abs(value - reference) * 10_000 / reference
}

interface Book { venue: Venue; bid: number; ask: number; mid: number; observed_at: number }

async function readVenue(venue: Venue, fetcher: typeof fetch, at: number): Promise<Book> {
  const res = await fetcher(venue.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store',
    headers: { accept: 'application/json', 'user-agent': 'passbook-oracle/1' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // The HTTP Date is when the venue answered; a cache's Age is added to it.
  const date = Date.parse(res.headers.get('date') ?? '')
  const age = Number(res.headers.get('age') ?? 0) * 1000
  if (!Number.isFinite(date) || !Number.isFinite(age) || age < 0) throw new Error('missing HTTP observation time')
  const quoted = venue.parse(await res.json())
  let observed = date - age
  if (quoted.at !== undefined) {
    if (!Number.isSafeInteger(quoted.at) || quoted.at <= 0) throw new Error('invalid venue timestamp')
    observed = Math.min(observed, quoted.at)
    if (quoted.at - at > FUTURE_SKEW_MS) throw new Error('venue timestamp in the future')
  }
  if (date - at > FUTURE_SKEW_MS) throw new Error('HTTP date in the future')
  if (at - observed > SAMPLE_MAX_AGE_MS) throw new Error('stale book')
  const scale = venue.pair === 'USDT/USD' ? 1_000_000 : 100
  const bid = decimal(quoted.bid, scale)
  const ask = decimal(quoted.ask, scale)
  if (ask < bid) throw new Error('crossed book')
  const mid = Math.round((bid + ask) / 2)
  if ((ask - bid) * 10_000 / mid > MAX_VENUE_SPREAD_BPS) throw new Error('spread too wide')
  return { venue, bid, ask, mid, observed_at: observed }
}

function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/\s+/g, ' ').slice(0, 120) || 'failed'
}

/** Drop rows too far from the median of `value`, recording why. */
function dropOutliers<T extends { venue: Venue }>(rows: T[], value: (r: T) => number, limitBps: number, dropped: DroppedVenue[]): T[] {
  if (!rows.length) return rows
  const m = median(rows.map(value))
  return rows.filter((r) => {
    const gap = gapBps(value(r), m)
    if (gap <= limitBps) return true
    dropped.push({ name: r.venue.name, pair: r.venue.pair, reason: `outlier: ${gap.toFixed(0)} bps from the median` })
    return false
  })
}

function failure(message: string, dropped: DroppedVenue[]): Error {
  const detail = dropped.map((d) => `${d.name} ${d.pair}: ${d.reason}`).join('; ')
  return new Error(detail ? `${message} (${detail})` : message)
}

function requireQuorum(pair: Pair, kept: { venue: Venue }[], dropped: DroppedVenue[]): void {
  const n = kept.filter((r) => r.venue.pair === pair).length
  if (n < QUORUM[pair]) throw failure(`${pair}: ${n} of ${QUORUM[pair]} venues needed`, dropped)
}

function requireAgreement(label: string, values: number[], limitBps: number, dropped: DroppedVenue[]): void {
  const spread = (Math.max(...values) - Math.min(...values)) * 10_000 / median(values)
  if (spread > limitBps) throw failure(`${label} venues disagree by ${spread.toFixed(0)} bps`, dropped)
}

export async function fetchIndexPrice(fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<IndexPrice> {
  const at = now()
  const results = await Promise.allSettled(VENUES.map((v) => readVenue(v, fetcher, at)))
  const dropped: DroppedVenue[] = []
  const books: Book[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') books.push(r.value)
    else dropped.push({ name: VENUES[i].name, pair: VENUES[i].pair, reason: reason(r.reason) })
  })

  // The debt asset first: USDT/USD.
  const usdtBooks = dropOutliers(books.filter((b) => b.venue.pair === 'USDT/USD'), (b) => b.mid, USDT_OUTLIER_BPS, dropped)
  requireQuorum('USDT/USD', usdtBooks, dropped)
  requireAgreement('USDT/USD', usdtBooks.map((b) => b.mid), USDT_MAX_DISPERSION_BPS, dropped)
  const ppm = median(usdtBooks.map((b) => b.mid))

  // Cross-check it against what the BTC books imply.
  const usdBooks = books.filter((b) => b.venue.pair === 'BTC/USD')
  const tetherBooks = books.filter((b) => b.venue.pair === 'BTC/USDT')
  requireQuorum('BTC/USD', usdBooks, dropped)
  requireQuorum('BTC/USDT', tetherBooks, dropped)
  const implied = Math.round(median(usdBooks.map((b) => b.mid)) * 1_000_000 / median(tetherBooks.map((b) => b.mid)))
  if (gapBps(implied, ppm) > IMPLIED_MAX_GAP_BPS) throw failure(`USDT/USD index ${ppm} ppm and the BTC books' implied ${implied} ppm disagree`, dropped)

  // BTC in USDT: USDT books as they are, dollar books divided by USDT/USD.
  const inUsdt = (b: Book) => b.venue.pair === 'BTC/USDT' ? b.mid : Math.round(b.mid * 1_000_000 / ppm)
  const kept = dropOutliers([...usdBooks, ...tetherBooks], inUsdt, BTC_OUTLIER_BPS, dropped)
  requireQuorum('BTC/USD', kept, dropped)
  requireQuorum('BTC/USDT', kept, dropped)
  requireAgreement('BTC', kept.map(inUsdt), BTC_MAX_DISPERSION_BPS, dropped)

  return {
    price_cents: median(kept.map(inUsdt)),
    observed_at: Math.min(...kept.map((b) => b.observed_at), ...usdtBooks.map((b) => b.observed_at)),
    sources: kept.map((b) => ({ name: b.venue.name, pair: b.venue.pair as BtcPair, bid_cents: b.bid, ask_cents: b.ask, price_cents: inUsdt(b), observed_at: b.observed_at })),
    usdt_usd: { ppm, implied_ppm: implied, sources: usdtBooks.map((b) => ({ name: b.venue.name, bid_ppm: b.bid, ask_ppm: b.ask, ppm: b.mid, observed_at: b.observed_at })) },
    dropped,
  }
}
