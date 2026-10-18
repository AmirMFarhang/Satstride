// The dashboard's own formatting (web/app.js helpers), so both show the same figures.

import type { Network } from './network.js'

export const short = (h: unknown, n = 10): string => (typeof h === 'string' && h.length > n + 2 ? `${h.slice(0, n)}…` : String(h ?? ''))
export const usdNum = (micro: number): string => (micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** "600.00 test USDT" on a test network. */
export const usdt = (micro: number, net: Network): string => `${usdNum(micro)} ${net.asset}`
export const btcNum = (sats: number): string => {
  let s = (sats / 1e8).toFixed(8).replace(/0+$/, '')
  if (s.endsWith('.')) s += '0'
  return s
}
export const btc = (sats: number): string => `${btcNum(sats)} BTC`
export const satsText = (n: number): string => `${Math.round(n).toLocaleString('en-US')} sats`
export const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`
export const centsOf = (sats: number, priceCents: number): number => Math.round((sats * priceCents) / 1e8)
export const pctOf = (bps: number): string => `${bps / 100}%`
