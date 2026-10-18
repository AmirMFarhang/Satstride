// Integer money. USDT amounts are in micro-units (precision 6, matching the RGB
// asset), BTC in satoshis, prices in cents per BTC, ratios in basis points.
// Every function here is pure and uses BigInt where products could overflow.
//
// Unit algebra used below:
//   value_usd(sats, price) = sats / 1e8 * priceCents / 100  USD
//   in micro-USDT:         = sats * priceCents / 1e4

/** Micro-USDT: 1 USDT = 1_000_000. */
export type Micro = number
/** Satoshis. */
export type Sats = number
/** Basis points: 10_000 = 100%. */
export type Bps = number
/** Cents per whole BTC. */
export type PriceCents = number

export const MICRO_PER_USDT = 1_000_000
export const SATS_PER_BTC = 100_000_000
export const BPS = 10_000

export function assertInt(name: string, v: number, min = 0): void {
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}, got ${v}`)
}

export function usdt(micro: Micro): string {
  const sign = micro < 0 ? '-' : ''
  const abs = Math.abs(micro)
  const whole = Math.floor(abs / MICRO_PER_USDT)
  const frac = Math.round((abs % MICRO_PER_USDT) / 10_000)
  return `${sign}${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')} USDT`
}

export function btc(sats: Sats): string {
  return `${(sats / SATS_PER_BTC).toFixed(8)} BTC`
}

export function pct(bps: Bps): string {
  return `${(bps / 100).toFixed(2)}%`
}

/** Dollar value of some sats at a price, in micro-USDT. */
export function satsToMicro(sats: Sats, priceCents: PriceCents): Micro {
  assertInt('sats', sats)
  assertInt('priceCents', priceCents)
  return Number((BigInt(sats) * BigInt(priceCents)) / 10_000n)
}

/** Sats needed to be worth some micro-USDT at a price, rounded up. */
export function microToSats(micro: Micro, priceCents: PriceCents): Sats {
  assertInt('micro', micro)
  assertInt('priceCents', priceCents, 1)
  const num = BigInt(micro) * 10_000n
  const den = BigInt(priceCents)
  return Number((num + den - 1n) / den)
}

/** Loan-to-value in basis points: debt / collateral value. */
export function ltvBps(debtMicro: Micro, collateralSats: Sats, priceCents: PriceCents): Bps {
  assertInt('debtMicro', debtMicro)
  assertInt('collateralSats', collateralSats, 1)
  assertInt('priceCents', priceCents, 1)
  // debt / (sats * price / 1e4) * 1e4 bps = debt * 1e8 / (sats * price)
  return Number((BigInt(debtMicro) * 100_000_000n) / (BigInt(collateralSats) * BigInt(priceCents)))
}

/** Collateral sats required for a debt at a target LTV, rounded up. */
export function collateralFor(debtMicro: Micro, ltv: Bps, priceCents: PriceCents): Sats {
  assertInt('debtMicro', debtMicro)
  assertInt('ltv', ltv, 1)
  assertInt('priceCents', priceCents, 1)
  const num = BigInt(debtMicro) * 100_000_000n
  const den = BigInt(ltv) * BigInt(priceCents)
  return Number((num + den - 1n) / den)
}

/** The price at which a debt against some sats reaches a given LTV. */
export function priceAtLtv(debtMicro: Micro, collateralSats: Sats, ltv: Bps): PriceCents {
  assertInt('debtMicro', debtMicro)
  assertInt('collateralSats', collateralSats, 1)
  assertInt('ltv', ltv, 1)
  return Number((BigInt(debtMicro) * 100_000_000n) / (BigInt(collateralSats) * BigInt(ltv)))
}

export function applyBps(amount: number, bps: Bps): number {
  return Number((BigInt(amount) * BigInt(bps)) / BigInt(BPS))
}
