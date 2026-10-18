// Formatting. Amounts are integers in micro-units of the regtest test USDT
// stand-in (1 test USDT = 1 000 000). They are always shown with a "t"
// prefix on the ticker so test coins never look real. No fiat anywhere.

export const DASH = '—'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
export const has = (v) => v !== null && v !== undefined && v !== ''

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
export const fmtInt = (n) => (isNum(n) ? intFmt.format(Math.round(n)) : DASH)

/** Decimals an amount needs to be shown exactly: at least 2, at most 6. */
export function amountDecimals(micro) {
  if (!isNum(micro)) return 2
  const frac = Math.abs(Math.round(micro)) % 1_000_000
  if (frac % 10_000 === 0) return 2
  let d = 6
  let f = frac
  while (d > 2 && f % 10 === 0) { f /= 10; d-- }
  return d
}

/** "1,234.56" from micro-units; exact to the micro-unit, no float drift. */
export function fmtUnits(micro, decimals = amountDecimals(micro)) {
  if (!isNum(micro)) return DASH
  const m = Math.abs(Math.round(micro))
  const neg = micro < 0 && m > 0
  const scaled = Math.round(m / 10 ** (6 - decimals)) // half-up on the cut digits
  const whole = Math.floor(scaled / 10 ** decimals)
  const frac = decimals ? '.' + String(scaled % 10 ** decimals).padStart(decimals, '0') : ''
  return `${neg ? '−' : ''}${intFmt.format(whole)}${frac}`
}

/** "tUSDT" for the asset ticker. */
export const tickerOf = (asset) => `t${(asset && asset.ticker) || 'USDT'}`
export const assetNote = (asset) =>
  `test ${(asset && asset.ticker) || 'USDT'}: ${(asset && asset.note) || 'regtest test USDT stand-in, not real USDT'}`

/** Compact units for axis ticks: 0, 2.5, 1.2K, 3M. */
export function fmtCompactUnits(units) {
  const a = Math.abs(units)
  if (a >= 1e6) return `${trim(units / 1e6)}M`
  if (a >= 1e3) return `${trim(units / 1e3)}K`
  return trim(units)
}
const trim = (n) => String(Number(n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)))

export const fmtPct = (bps, digits) => {
  if (!isNum(bps)) return DASH
  const p = bps / 100
  const d = digits ?? (Number.isInteger(p) ? 0 : p * 10 === Math.round(p * 10) ? 1 : 2)
  return `${p.toFixed(d)}%`
}

export const fmtHeight = (h) => (isNum(h) && h > 0 ? `#${intFmt.format(h)}` : DASH)

/** Truncates a hex key or id: 02ab12cd…9f3c. */
export function short(v, head = 8, tail = 6) {
  const s = String(v ?? '')
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** Timestamps: 0 and null mean "not known". */
export const hasTime = (t) => isNum(t) && t > 0

export function relTime(t, now = Date.now()) {
  if (!hasTime(t)) return DASH
  const s = Math.round((now - t) / 1000)
  if (s < -5) return `in ${relSpan(-s)}`
  if (s < 5) return 'just now'
  return `${relSpan(s)} ago`
}
function relSpan(s) {
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

const dtFmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const absTime = (t) => (hasTime(t) ? dtFmt.format(new Date(t)) : DASH)

const hourFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', day: '2-digit' })
export const fmtHour = (t) => hourFmt.format(new Date(t))
export const fmtDay = (t) => dayFmt.format(new Date(t))

export function fmtDuration(seconds) {
  if (!isNum(seconds)) return DASH
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return h ? `${d} d ${h} h` : `${d} d`
  if (h) return m ? `${h} h ${m} min` : `${h} h`
  if (m) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  return `${s} s`
}

/** Tone for a status word: ok | warn | alert | info | neutral. */
export function toneOf(status) {
  const s = String(status ?? '').toLowerCase()
  if (['settled', 'fee_paid', 'paid', 'repaid', 'released', 'running', 'answering', 'agreed', 'term-sheet', 'enforce', 'verified', 'connected', 'ok'].includes(s)) return 'ok'
  if (['held', 'pending', 'awaiting-payment', 'fee_due', 'locked', 'negotiating', 'asked', 'warn', 'log', 'stopped', 'unknown', 'loosen'].includes(s)) return 'warn'
  if (['failed', 'refused', 'unpaid', 'defaulted', 'liquidated', 'unreachable', 'down', 'no-deal', 'off', 'alert'].includes(s)) return 'alert'
  if (['open', 'info'].includes(s)) return 'info'
  return 'neutral'
}

export const label = (s) => String(s ?? '').replace(/[_-]+/g, ' ')

/** Nostr kinds from src/market/kinds.ts, for kinds the API does not label. */
export const KIND_LABELS = {
  38388: 'OFFER', 38389: 'REQUEST', 38390: 'NOTE_SALE', 38401: 'CHECK_OFFER',
  7470: 'APPLICATION', 7471: 'ACCEPTANCE', 7472: 'SIGN_REQUEST', 7473: 'SIGNATURE', 7474: 'FUNDED', 7475: 'REPAID', 7476: 'MARGIN_CALL',
  7480: 'NOTE_ISSUED', 7481: 'NOTE_BUY', 7482: 'NOTE_PRICE', 7483: 'NOTE_PAID', 7484: 'NOTE_ASSIGNED', 7485: 'NOTE_OWNER', 7486: 'NOTE_RETURNED', 7487: 'REPAYMENT_RECEIPT', 7488: 'ATOMIC_REPAID',
  7490: 'NEG_ASK', 7491: 'NEG_OFFER', 7492: 'NEG_COUNTER', 7493: 'NEG_ACCEPT', 7494: 'NEG_NO_DEAL', 7495: 'NEG_TERMSHEET', 7496: 'NEG_APPROVED',
  7530: 'CHECK_REQUEST', 7531: 'CHECK_FEEDBACK', 7532: 'CHECK_RESULT', 7533: 'CHECK_KEY',
}
