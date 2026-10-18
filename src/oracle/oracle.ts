// Signed price observations. Live updates retain the last complete median when
// a source fails. A manual demo override latches until explicitly cleared.
import { hashObject, signHash, verifyHash, type Hex, type KeyPair } from '../core/crypto.js'
import type { PriceCents } from '../core/money.js'
import type { OracleQuote } from '../core/terms.js'
import { fetchMedianPrice, PRICE_REFRESH_MS, PRICE_STALE_MS, type MedianPrice } from './feed.js'

export class Oracle {
  private price: PriceCents
  private live?: MedianPrice
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
        const observation = await fetchMedianPrice(this.options.fetcher, () => this.now())
        if (this.stopped) return
        this.live = observation
        this.error = undefined
        if (this.overrideAt === undefined) this.price = observation.price_cents
      } catch (err) {
        this.error = (err as Error).message
      }
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  async useLive(): Promise<void> {
    if (!this.options.live) throw new Error('live feed disabled; start with PASSBOOK_ORACLE=live')
    await this.refresh()
    if (!this.live || this.now() - this.live.observed_at > PRICE_STALE_MS) throw new Error('no fresh three-source median; demo override retained')
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
    if (status.stale) throw new Error('live oracle is stale; wait for all three sources or choose a labelled demo override')
    const unsigned = {
      price_cents: this.price, height, oracle_pk: this.key.pubkey,
      source: status.source as 'live_median' | 'demo_override' | 'configured',
      ...(status.observed_at === null ? {} : { observed_at: status.observed_at }),
      ...(status.source === 'live_median' ? { sources: this.live!.sources } : {}),
    }
    return { ...unsigned, sig: signHash(hashObject(unsigned), this.key.secretKey) }
  }
}

export function verifyQuote(q: OracleQuote, expectedOraclePk?: Hex): boolean {
  if (expectedOraclePk && q.oracle_pk !== expectedOraclePk) return false
  const { sig, ...unsigned } = q
  return verifyHash(sig, hashObject(unsigned), q.oracle_pk)
}
