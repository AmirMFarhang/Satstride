// Signed price observations. Live mode signs the BTC/USDT index from
// ./feed.ts with all its evidence and keeps the last good index when a refresh
// fails. Live quotes also carry the 30- and 5-minute time-weighted averages
// the liquidation rule reads (./twap.ts). No quote is signed while USDT is off
// its peg. A manual demo override latches until explicitly cleared.
import { hashObject, signHash, verifyHash, type Hex, type KeyPair } from '../core/crypto.js'
import type { PriceCents } from '../core/money.js'
import type { OracleQuote } from '../core/terms.js'
import type { LiquidationPrices } from '../registry/ladder.js'
import { fetchIndexPrice, INDEX_METHOD, PRICE_REFRESH_MS, PRICE_STALE_MS, USDT_PEG_BAND_PPM, usdtPegOk, type IndexPrice } from './feed.js'
import { FAST_WINDOW_MS, SLOW_WINDOW_MS, timeWeightedAverage, type Observation, type TimeAverage } from './twap.js'

const ppmText = (ppm: number) => (ppm / 1_000_000).toFixed(4)

/** A gap longer than this between index observations breaks the averages; the same limit that makes a quote stale. */
export const AVERAGE_MAX_GAP_MS = PRICE_STALE_MS
/**
 * The platform decides a liquidation from the lender's quote only if it was
 * signed this recently. Short, so a lender can't pick the most favourable of
 * many quotes; long enough for one request round trip.
 */
export const LIQUIDATION_QUOTE_MAX_AGE_MS = 30_000

export interface QuoteAverages {
  /** When the averages were computed, Unix milliseconds. */
  at: number
  /** 30-minute average for the 80% trigger; null until the record covers the window. */
  slow: TimeAverage | null
  /** 5-minute average for the 85% hard stop. */
  fast: TimeAverage | null
}

/**
 * The prices the liquidation rule reads from a quote. A live quote supplies its
 * averages, and one without them (signed before averages existed) supplies none,
 * so it cannot liquidate. A demo or configured quote has no record to average:
 * its one price stands for all three.
 */
export function liquidationPrices(q: OracleQuote): LiquidationPrices {
  if (q.source !== 'live_median') return { spot: q.price_cents, slow: q.price_cents, fast: q.price_cents }
  return { spot: q.price_cents, slow: q.averages?.slow?.price_cents ?? null, fast: q.averages?.fast?.price_cents ?? null }
}

export class Oracle {
  private price: PriceCents
  private live?: IndexPrice
  /** Live index observations, oldest first, pruned to what the slow window needs. */
  private history: Observation[] = []
  private overrideAt?: number
  private timer?: ReturnType<typeof setInterval>
  private refreshing?: Promise<void>
  private error?: string
  private stopped = false

  constructor(
    readonly key: KeyPair,
    initialPriceCents: PriceCents,
    private readonly options: { live?: boolean; fetcher?: typeof fetch; now?: () => number } = {},
  ) {
    if (!Number.isSafeInteger(initialPriceCents) || initialPriceCents <= 0) throw new RangeError('price must be positive integer cents')
    this.price = initialPriceCents
  }

  private now(): number { return (this.options.now ?? Date.now)() }
  get pubkey(): Hex { return this.key.pubkey }
  currentPrice(): PriceCents { return this.price }

  status() {
    const source = this.overrideAt !== undefined ? 'demo_override' : this.live ? 'live_median' : 'configured'
    const observedAt = source === 'demo_override' ? this.overrideAt : this.live?.observed_at
    return {
      source,
      live_enabled: this.options.live ?? false,
      observed_at: observedAt ?? null,
      age_ms: observedAt === undefined ? null : Math.max(0, this.now() - observedAt),
      stale: source === 'live_median' && this.now() - this.live!.observed_at > PRICE_STALE_MS,
      sources: this.live?.sources ?? [],
      dropped: this.live?.dropped ?? [],
      /** USDT/USD of the last live index, in ppm; null without one. */
      usdt_usd_ppm: this.live?.usdt_usd.ppm ?? null,
      usdt_peg_ok: this.live ? usdtPegOk(this.live.usdt_usd.ppm) : null,
      last_live_price_cents: this.live?.price_cents ?? null,
      last_live_observed_at: this.live?.observed_at ?? null,
      last_error: this.error ?? null,
    }
  }

  setPrice(priceCents: PriceCents): void {
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new RangeError('price must be a positive integer in cents')
    this.price = priceCents
    this.overrideAt = this.now()
  }

  async refresh(): Promise<void> {
    if (!this.options.live) return
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const observation = await fetchIndexPrice(this.options.fetcher, () => this.now())
        if (this.stopped) return
        this.live = observation
        this.record(observation)
        this.error = undefined
        if (this.overrideAt === undefined) this.price = observation.price_cents
      } catch (err) {
        this.error = (err as Error).message
      }
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private record(observation: IndexPrice): void {
    const last = this.history.at(-1)
    if (last && observation.observed_at < last.at) return
    // Same observation time: the newer index replaces the older one for that instant.
    if (last && observation.observed_at === last.at) last.price_cents = observation.price_cents
    else this.history.push({ price_cents: observation.price_cents, at: observation.observed_at })
    // Keep what a full slow window needs: everything inside it, and the observation in force at its start.
    const keepFrom = this.now() - SLOW_WINDOW_MS - AVERAGE_MAX_GAP_MS
    while (this.history.length > 1 && this.history[1].at <= keepFrom) this.history.shift()
  }

  /** The live index's time-weighted averages now; null outside live mode. */
  averages(): QuoteAverages | null {
    if (this.status().source !== 'live_median') return null
    const at = this.now()
    return {
      at,
      slow: timeWeightedAverage(this.history, SLOW_WINDOW_MS, at, AVERAGE_MAX_GAP_MS),
      fast: timeWeightedAverage(this.history, FAST_WINDOW_MS, at, AVERAGE_MAX_GAP_MS),
    }
  }

  /** Whether `q` is a quote this oracle signed within the last minute, so a liquidation priced from it can be decided from it. */
  recentForLiquidation(q: OracleQuote): boolean {
    try {
      if (!verifyQuote(q, this.pubkey)) return false
    } catch {
      return false
    }
    const at = q.averages?.at ?? q.observed_at
    return at !== undefined && Math.abs(this.now() - at) <= LIQUIDATION_QUOTE_MAX_AGE_MS
  }

  async useLive(): Promise<void> {
    if (!this.options.live) throw new Error('live feed disabled; start with PASSBOOK_ORACLE=live')
    await this.refresh()
    if (!this.live || this.now() - this.live.observed_at > PRICE_STALE_MS) throw new Error('no fresh live index; demo override retained')
    this.overrideAt = undefined
    this.price = this.live.price_cents
  }

  start(onUpdate: () => void): void {
    if (!this.options.live || this.timer) return
    this.stopped = false
    const update = async () => { await this.refresh(); if (!this.stopped) onUpdate() }
    void update()
    this.timer = setInterval(() => void update(), PRICE_REFRESH_MS)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  quote(height: number): OracleQuote {
    const status = this.status()
    if (this.options.live && status.source === 'configured') throw new Error('live oracle unavailable; choose a labelled demo override before borrowing')
    if (status.stale) throw new Error('live oracle is stale; wait for a quorum of venues or choose a labelled demo override')
    const live = status.source === 'live_median' ? this.live! : undefined
    // A loan priced or liquidated while the debt asset is off its peg would
    // move value between the parties on a USDT price nobody can rely on.
    if (live && !usdtPegOk(live.usdt_usd.ppm)) {
      throw new Error(`USDT is off its $1 peg (${ppmText(live.usdt_usd.ppm)} USD); new loans and liquidations are paused until it is back within ${ppmText(USDT_PEG_BAND_PPM.min)}–${ppmText(USDT_PEG_BAND_PPM.max)}`)
    }
    const unsigned = {
      price_cents: this.price, height, oracle_pk: this.key.pubkey,
      source: status.source as 'live_median' | 'demo_override' | 'configured',
      ...(status.observed_at === null ? {} : { observed_at: status.observed_at }),
      ...(live ? { method: INDEX_METHOD, sources: live.sources, usdt_usd: live.usdt_usd, dropped: live.dropped, averages: this.averages()! } : {}),
    }
    return { ...unsigned, sig: signHash(hashObject(unsigned), this.key.secretKey) }
  }
}

export function verifyQuote(q: OracleQuote, expectedOraclePk?: Hex): boolean {
  if (expectedOraclePk && q.oracle_pk !== expectedOraclePk) return false
  const { sig, ...unsigned } = q
  return verifyHash(sig, hashObject(unsigned), q.oracle_pk)
}
