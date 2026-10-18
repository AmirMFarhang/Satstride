// What the negotiation visualizer draws, computed from the real signed transcript
// (NegotiationMessage[], src/market/negotiate-engine.ts) and nothing else: one card per
// signed message, the APR each side put on the table move by move, how far apart they are,
// and how it ended. No React Native here, so the tests run it on real signed messages.
import type { MessageType, NegotiationMessage, Position } from '../../../../src/market/negotiate-engine.js'

export type Side = 'you' | 'lender'

export interface MessageCard {
  /** stable across renders: the sequence number and the start of the signature */
  key: string
  seq: number
  type: MessageType
  from: Side
  /** the position the message carries (ASK, OFFER, COUNTER, ACCEPT); null for the rest */
  position: Position | null
  /** NO_DEAL's reason code */
  reason: string | null
  /** the signature, shortened for the card ("signed 3f9a1c…") */
  sig: string
  /** whether it links to the previous message's hash (every message but the first) */
  chained: boolean
}

export interface AprPoint { seq: number; apr_bps: number }

export type NegotiationEnd =
  | { kind: 'open' }
  | { kind: 'accept'; by: Side; seq: number; position: Position }
  | { kind: 'no_deal'; by: Side; seq: number; reason: string }

export interface NegotiationPicture {
  cards: MessageCard[]
  /** APR per move, for each side, in sequence order */
  aprs: Record<Side, AprPoint[]>
  /** the chart's vertical range, padded so the two lines never touch the edges */
  range: { min: number; max: number }
  /** APR gap between the two sides' latest positions (bps); null until both have moved */
  gap: number | null
  /** the gap after the lender's first position: how far apart they started */
  firstGap: number | null
  /** 0 (as far apart as they started) .. 1 (met); null until both have moved */
  closed: number | null
  end: NegotiationEnd
  /** things in the list that are not a single clean chain; shown, never smoothed over */
  problems: string[]
}

const MOVES: ReadonlySet<MessageType> = new Set(['ASK', 'OFFER', 'COUNTER', 'ACCEPT'])

const positionOf = (m: NegotiationMessage): Position | null => {
  const p = (m.body as { position?: unknown }).position as Position | undefined
  return p && typeof p === 'object' && Number.isFinite(p.apr_bps) && Number.isFinite(p.ltv_bps) ? p : null
}

/** The transcript as the visualizer draws it. `borrowerPk` is this phone's key: its messages are "you". */
export function negotiationPicture(messages: readonly NegotiationMessage[], borrowerPk: string): NegotiationPicture {
  const problems: string[] = []
  // one card per signed message, in chain order, duplicates (a relay echo) once
  const seen = new Set<string>()
  const sorted = [...messages].sort((a, b) => a.seq - b.seq).filter((m) => {
    const k = `${m.seq}:${m.sig}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const ids = new Set(sorted.map((m) => m.negotiation_id))
  if (ids.size > 1) problems.push(`${ids.size} negotiations mixed in one list`)
  sorted.forEach((m, i) => { if (m.seq !== i) problems.push(`message ${m.seq} is out of sequence`) })

  const cards: MessageCard[] = sorted.map((m) => ({
    key: `${m.seq}:${m.sig.slice(0, 12)}`,
    seq: m.seq,
    type: m.type,
    from: m.from_pk === borrowerPk ? 'you' : 'lender',
    position: MOVES.has(m.type) ? positionOf(m) : null,
    reason: m.type === 'NO_DEAL' ? String((m.body as { reason?: unknown }).reason ?? '') : null,
    sig: `${m.sig.slice(0, 6)}…`,
    chained: m.prev_hash !== null,
  }))

  const aprs: Record<Side, AprPoint[]> = { you: [], lender: [] }
  for (const c of cards) if (c.position && c.type !== 'ACCEPT') aprs[c.from].push({ seq: c.seq, apr_bps: c.position.apr_bps })

  const latest = (s: Side) => aprs[s].at(-1)?.apr_bps
  const accept = cards.find((c) => c.type === 'ACCEPT' && c.position)
  const noDeal = cards.find((c) => c.type === 'NO_DEAL')
  const end: NegotiationEnd = accept
    ? { kind: 'accept', by: accept.from, seq: accept.seq, position: accept.position! }
    : noDeal ? { kind: 'no_deal', by: noDeal.from, seq: noDeal.seq, reason: noDeal.reason || 'NO_DEAL' } : { kind: 'open' }

  const firstLender = aprs.lender[0]
  const youBefore = firstLender ? [...aprs.you].reverse().find((p) => p.seq < firstLender.seq) ?? aprs.you[0] : undefined
  const firstGap = firstLender && youBefore ? Math.abs(firstLender.apr_bps - youBefore.apr_bps) : null
  const yl = latest('you'), ll = latest('lender')
  const gap = end.kind === 'accept' ? 0 : yl !== undefined && ll !== undefined ? Math.abs(ll - yl) : null
  const closed = gap === null || firstGap === null ? null : firstGap === 0 ? 1 : Math.max(0, Math.min(1, 1 - gap / firstGap))

  const all = [...aprs.you, ...aprs.lender].map((p) => p.apr_bps).concat(end.kind === 'accept' ? [end.position.apr_bps] : [])
  const lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 0
  const pad = Math.max(25, Math.round((hi - lo) * 0.15))
  return { cards, aprs, range: { min: Math.max(0, lo - pad), max: hi + pad }, gap, firstGap, closed, end, problems }
}

/** "12.5%" from basis points, as the screens write a rate. */
export const aprText = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

/** The card's one line, in the canvas's plain words. */
export function cardWords(c: MessageCard): string {
  const p = c.position
  switch (c.type) {
    case 'ASK': return p ? `asks for ${aprText(p.apr_bps)} APR` : 'asks'
    case 'OFFER': return p ? `offers ${aprText(p.apr_bps)} APR` : 'offers'
    case 'COUNTER': return p ? `counters at ${aprText(p.apr_bps)}` : 'counters'
    case 'ACCEPT': return p ? `accepts ${aprText(p.apr_bps)}` : 'accepts'
    case 'NO_DEAL': return `ends it (${c.reason || 'no deal'})`
    case 'TERMSHEET': return 'sends the term sheet'
    case 'APPROVED': return 'approves the term sheet'
  }
}
