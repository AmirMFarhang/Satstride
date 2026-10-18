// Amounts as the canvas writes them ("606.00", "0.01212", "4,000 sats"), always with the
// test units: test coins never look real (README, "Test coins never look real").
import { activeNetwork } from '../core/network'

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** micro-units (precision 6) -> "2,000.00", "100.90", "1.234567": cents always, more only when there are more. */
export function usdNum(micro: number | bigint, precision = 6): string {
  const v = BigInt(micro)
  const neg = v < 0n
  const a = neg ? -v : v
  const base = 10n ** BigInt(precision)
  let frac = (a % base).toString().padStart(precision, '0').replace(/0+$/, '')
  if (frac.length < 2) frac = frac.padEnd(Math.min(2, precision), '0')
  return `${neg ? '−' : ''}${group((a / base).toString())}${frac ? `.${frac}` : ''}`
}
export const usd = (micro: number | bigint, precision = 6) => `${usdNum(micro, precision)} ${activeNetwork().usdUnit}`

/** sats -> "0.01212", "0.00182955", "1.00": trailing zeros trimmed, at least two decimals. */
export function btcNum(sats: number | bigint): string {
  const v = BigInt(sats)
  const neg = v < 0n
  const a = neg ? -v : v
  let frac = (a % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')
  if (frac.length < 2) frac = frac.padEnd(2, '0')
  return `${neg ? '−' : ''}${group((a / 100_000_000n).toString())}.${frac}`
}
export const btc = (sats: number | bigint) => `${btcNum(sats)} ${activeNetwork().btcUnit}`

export const satsText = (n: number | bigint) => `${group(BigInt(n).toString())} sats`

/** "7c2e…f31d" */
export const short = (id: string, n = 4) => (id.length > n * 2 + 1 ? `${id.slice(0, n)}…${id.slice(-n)}` : id)

/** A counterparty the person has never named: the first six characters of its key. */
export const partyName = (role: 'Lender' | 'Borrower', pk: string) => `${role} ${pk.slice(0, 6)}`

export const pctText = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

/** "in 12 blocks", "now", "3 blocks ago" */
export function blocksFrom(target: number, height: number): string {
  const d = target - height
  if (d === 0) return 'now'
  if (d > 0) return `in ${d} block${d === 1 ? '' : 's'}`
  return `${-d} block${d === -1 ? '' : 's'} ago`
}
