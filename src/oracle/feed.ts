// Primary public BTC/USD APIs. Require all three responses for a three-source
// median; a partial refresh never replaces the last complete observation.
export const PRICE_ENDPOINTS = {
  Kraken: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
  Coinbase: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
  Bitstamp: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
} as const

export interface PriceSample {
  name: keyof typeof PRICE_ENDPOINTS
  price_cents: number
  observed_at: number
}
export interface MedianPrice {
  price_cents: number
  observed_at: number
  sources: PriceSample[]
}
export const PRICE_REFRESH_MS = 30_000
export const PRICE_STALE_MS = 90_000

function cents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) throw new Error('invalid dollar price')
  const price = Math.round(Number(value) * 100)
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('price must be positive safe integer cents')
  return price
}

export async function fetchMedianPrice(fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<MedianPrice> {
  const results = await Promise.allSettled(Object.entries(PRICE_ENDPOINTS).map(async ([name, url]) => {
    const res = await fetcher(url, { signal: AbortSignal.timeout(5_000), cache: 'no-store', headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Kraken and Coinbase do not timestamp this field. Their HTTP Date is the
    // observation time, not a claim about the time of the underlying last trade.
    const date = res.headers.get('date')
    const observed = date ? Date.parse(date) : NaN
    const at = now()
    const age = Number(res.headers.get('age') ?? 0) * 1000
    if (!Number.isFinite(observed) || !Number.isFinite(age) || age < 0 || age > PRICE_STALE_MS || at - observed > PRICE_STALE_MS || observed - at > 30_000) throw new Error('missing or stale HTTP observation time')
    const body = await res.json() as Record<string, any>
    let value: unknown
    let observedAt = observed
    if (name === 'Kraken') {
      if (!Array.isArray(body.error) || body.error.length) throw new Error('Kraken returned an API error')
      value = body.result?.XXBTZUSD?.c?.[0]
    } else if (name === 'Coinbase') {
      if (body.data?.base !== 'BTC' || body.data?.currency !== 'USD') throw new Error('wrong Coinbase currency pair')
      value = body.data.amount
    } else {
      observedAt = Number(body.timestamp) * 1000
      if (!Number.isSafeInteger(observedAt) || at - observedAt > PRICE_STALE_MS || observedAt - at > 30_000) throw new Error('stale Bitstamp ticker')
      value = body.last
    }
    return { name: name as PriceSample['name'], price_cents: cents(value), observed_at: observedAt }
  }))
  const errors = results.flatMap((r, i) => r.status === 'rejected' ? [`${Object.keys(PRICE_ENDPOINTS)[i]}: ${(r.reason as Error).message}`] : [])
  if (errors.length) throw new Error(errors.join('; '))
  const sources = results.map((r) => (r as PromiseFulfilledResult<PriceSample>).value)
  const sorted = sources.map((s) => s.price_cents).sort((a, b) => a - b)
  return { price_cents: sorted[1], observed_at: Math.min(...sources.map((s) => s.observed_at)), sources }
}
