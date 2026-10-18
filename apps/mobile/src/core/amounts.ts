// Amounts are integers in satoshis everywhere; text is only for display.

export const SATS_PER_BTC = 100_000_000n

/** "12345678" or 12345678n -> "0.12345678". */
export function formatBtc(sats: bigint | string | number): string {
  const v = BigInt(sats)
  const neg = v < 0n
  const a = neg ? -v : v
  const whole = a / SATS_PER_BTC
  const frac = (a % SATS_PER_BTC).toString().padStart(8, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

/** Grouped sats for reading: 1234567 -> "1 234 567". */
export function groupSats(sats: bigint | string | number): string {
  return BigInt(sats).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Parses a whole number of sats typed by the user (spaces allowed). Null when not a positive integer. */
export function parseSats(input: string): bigint | null {
  const s = input.replace(/[\s_]/g, '')
  if (!/^\d{1,16}$/.test(s)) return null
  const v = BigInt(s)
  return v > 0n ? v : null
}

/** RGB test USDT is in micro-units (precision 6), like the laptop's money.ts. */
export const USDT_PRECISION = 6

/** 12500000 micro-units -> "12.500000". */
/** For sentences (a phone-lock prompt): no trailing zeros, "500" rather than "500.000000". */
export function shortUnits(units: bigint | string | number, precision = USDT_PRECISION): string {
  return formatUnits(units, precision).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

export function formatUnits(units: bigint | string | number, precision = USDT_PRECISION): string {
  const v = BigInt(units)
  const neg = v < 0n
  const a = neg ? -v : v
  const base = 10n ** BigInt(precision)
  const frac = precision > 0 ? `.${(a % base).toString().padStart(precision, '0')}` : ''
  return `${neg ? '-' : ''}${a / base}${frac}`
}

/** "12.5" -> 12500000n at precision 6. Null for anything but a positive amount with at most `precision` decimals. */
export function parseUnits(input: string, precision = USDT_PRECISION): bigint | null {
  const s = input.replace(/[\s_]/g, '')
  const m = /^(\d{1,12})(?:\.(\d*))?$/.exec(s)
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > precision) return null
  const v = BigInt(m[1]) * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, '0') || '0')
  return v > 0n ? v : null
}
