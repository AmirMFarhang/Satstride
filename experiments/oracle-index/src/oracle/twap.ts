// Time-weighted average of the live index, for liquidation. A liquidation
// should follow where the price has been, not one print (docs/PRICE-ORACLE.md,
// section 6): the 80% trigger reads a 30-minute average and the 85% hard stop a
// 5-minute one. Passbook's own model shows no lender loss even with a 12-hour
// execution lag (docs/REVENUE.md), so the delay costs lenders nothing.
//
// The index is a step function: each observation holds until the next. An
// average exists only for a window the record covers without a break: there
// must be an observation at or before the window's start, no gap between
// observations longer than `maxGapMs`, and a last observation no older than
// `maxGapMs`. After an outage the average waits for a full window of new
// observations instead of averaging across the hole.

/** The window the 80% liquidation trigger averages over. */
export const SLOW_WINDOW_MS = 30 * 60_000
/** The window the 85% hard stop averages over. */
export const FAST_WINDOW_MS = 5 * 60_000

export interface Observation {
  price_cents: number
  /** Unix milliseconds. */
  at: number
}

export interface TimeAverage {
  window_ms: number
  price_cents: number
  /** The window, Unix milliseconds. */
  from: number
  to: number
  /** Observations that set the price somewhere inside the window. */
  samples: number
}

/** The time-weighted average over [now - windowMs, now], or null when the record doesn't cover it. */
export function timeWeightedAverage(history: readonly Observation[], windowMs: number, now: number, maxGapMs: number): TimeAverage | null {
  const obs = history.filter((o) => o.at <= now)
  if (!obs.length || now - obs[obs.length - 1].at > maxGapMs) return null
  const from = now - windowMs
  let first = -1
  for (let i = obs.length - 1; i >= 0; i--) if (obs[i].at <= from) { first = i; break }
  if (first < 0) return null
  let weighted = 0
  for (let i = first; i < obs.length; i++) {
    const end = i + 1 < obs.length ? obs[i + 1].at : now
    if (end - obs[i].at > maxGapMs) return null
    weighted += obs[i].price_cents * (end - Math.max(obs[i].at, from))
  }
  return { window_ms: windowMs, price_cents: Math.round(weighted / windowMs), from, to: now, samples: obs.length - first }
}
