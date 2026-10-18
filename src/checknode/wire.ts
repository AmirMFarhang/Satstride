// Check-market messages on public relays. Some relays (nos.lol, nostr.mom)
// drop events over about 64 KiB, and a credit check's largest messages (the
// borrower's sealed bundle, the operator's sealed result, the forwarded KEY
// chain) can be larger. A message whose JSON exceeds WIRE_CHUNK_CHARS is sent
// as several chunks, each its own signed, NIP-44 event from the same sender:
//   { passbook_wire: 1, id: sha256(full JSON), n, of, data }
// The receiver groups chunks by sender and id, joins them in order and accepts
// the message only if sha256 of the joined text is the id. Small messages go
// out unchanged, so nothing changes for them. Chunking only (no compression):
// the large parts are base64 ciphertext, which barely compresses.
// Browser-safe (no node: imports): both phone halves use it.

import { sha256Hex, type Hex } from '../core/crypto.js'

/** JSON characters per chunk: with NIP-44 padding and base64 an event stays well under 60 KiB. */
export const WIRE_CHUNK_CHARS = 36_000
/** No message is reassembled from more chunks than this (a 3.6 MB cap). */
export const WIRE_MAX_CHUNKS = 100

export interface WireChunk { passbook_wire: 1; id: Hex; n: number; of: number; data: string }

export function isWireChunk(p: unknown): p is WireChunk {
  const c = p as WireChunk
  return !!c && c.passbook_wire === 1 && typeof c.id === 'string' && /^[0-9a-f]{64}$/.test(c.id) && Number.isSafeInteger(c.n) && Number.isSafeInteger(c.of) && c.of >= 1 && c.of <= WIRE_MAX_CHUNKS && c.n >= 0 && c.n < c.of && typeof c.data === 'string'
}

/** The payloads to send for one message: the message itself when small, else its chunks (each under WIRE_CHUNK_CHARS bytes of UTF-8). */
export function packWire(payload: unknown, chunkChars = WIRE_CHUNK_CHARS): unknown[] {
  const text = JSON.stringify(payload)
  if (utf8Length(text) <= chunkChars) return [payload]
  const parts: string[] = []
  let i = 0
  while (i < text.length) {
    // Cut by characters, then shrink until the slice fits in bytes (rare non-ASCII text).
    let end = Math.min(text.length, i + chunkChars)
    while (utf8Length(text.slice(i, end)) > chunkChars) end = i + Math.floor((end - i) * 0.9)
    // Never split a surrogate pair.
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--
    parts.push(text.slice(i, end))
    i = end
  }
  if (parts.length > WIRE_MAX_CHUNKS) throw new Error('WIRE_MESSAGE_TOO_LARGE')
  const id = sha256Hex(text)
  return parts.map((data, n): WireChunk => ({ passbook_wire: 1, id, n, of: parts.length, data }))
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Collects chunks per sender; returns the whole message once every chunk of it arrived and its hash checks out. */
export class WireReassembler {
  private readonly open = new Map<string, { of: number; parts: (string | undefined)[]; at: number }>()
  constructor(private readonly maxOpen = 64, private readonly ttlMs = 15 * 60_000) {}

  /**
   * Feed one received payload from `sender`. A plain message comes straight back; a chunk returns null until its
   * message is complete, then the parsed message. A message whose joined text does not hash to its id is dropped.
   */
  feed(sender: Hex, payload: unknown, nowMs = Date.now()): { payload: unknown } | null {
    if (!isWireChunk(payload)) return { payload }
    for (const [k, v] of this.open) if (nowMs - v.at > this.ttlMs) this.open.delete(k)
    const key = `${sender}:${payload.id}`
    let entry = this.open.get(key)
    if (!entry) {
      if (this.open.size >= this.maxOpen) this.open.delete(this.open.keys().next().value!)
      entry = { of: payload.of, parts: new Array(payload.of).fill(undefined), at: nowMs }
      this.open.set(key, entry)
    }
    if (entry.of !== payload.of) return null
    entry.parts[payload.n] = payload.data
    if (entry.parts.some((p) => p === undefined)) return null
    this.open.delete(key)
    const text = entry.parts.join('')
    if (sha256Hex(text) !== payload.id) return null
    try { return { payload: JSON.parse(text) } } catch { return null }
  }
}
