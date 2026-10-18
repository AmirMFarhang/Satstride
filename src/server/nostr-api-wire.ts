// The platform API over Nostr, the wire both ends share (passbook-platform-nostr/v1).
// Browser-safe: the phone (apps/mobile/src/agent/platform-nostr.ts) imports it through
// Metro, the server (nostr-api.ts) on the laptop.
//
// A request is exactly the HTTP request the party already signs today (method, path
// with query, the four x-passbook-* headers and the raw body), so the platform
// checks it with the same code: src/server/auth.ts requestDigest, nonce, window,
// party binding and rate limits. It travels NIP-44 encrypted to the platform's key;
// the response `{ status, body }` travels NIP-44 encrypted back to the requester.
// Both are split into chunks and reassembled by request id. Every event stays under
// 60 KiB on the wire, because some public relays (nos.lol, nostr.mom) drop events over
// about 64 KiB. The message is ASCII (non-ASCII escaped as \uXXXX, still the same
// JSON), and a chunk's plaintext is one JSON header line followed by its data as is, so
// nothing is escaped twice. 30,000 data characters NIP-44-pad to 32,768 bytes, and the
// whole event is about 44 KB (measured in test/platform-nostr.test.ts).
//
//   REQUEST  7550  party -> platform, NIP-44, tags t=passbook, p=<platform>, q=<request id>
//   RESPONSE 7551  platform -> party, NIP-44, tags t=passbook, p=<party>, q=<request id>
//   INFO    38550  platform, public, addressable (d=passbook-platform): its key, relays and limits, labelled test data

import { isHex, type Hex } from '../core/crypto.js'
import { KIND } from '../market/kinds.js'

export const PLATFORM_NOSTR_KIND = { REQUEST: KIND.PLATFORM_REQUEST, RESPONSE: KIND.PLATFORM_RESPONSE, INFO: KIND.PLATFORM_INFO } as const
export const PLATFORM_INFO_D = 'passbook-platform'
export const PLATFORM_NOSTR_PROTOCOL = 'passbook-platform-nostr/v1'

/** Data characters (ASCII, so bytes) per chunk. */
export const CHUNK_DATA_CHARS = 30_000
/** The most one event may take on the wire (its NIP-01 JSON), under public relays' ~64 KiB cut-off. */
export const MAX_EVENT_BYTES = 60 * 1024
/** The largest request or response carried; the HTTP API's own cap (src/server/api.ts) is 1 MB. */
export const MAX_MESSAGE_CHARS = 512_000
export const MAX_CHUNKS = Math.ceil(MAX_MESSAGE_CHARS / CHUNK_DATA_CHARS)

/** The headers the party signs over HTTP (src/server/auth.ts AUTH_HEADERS); nothing else is forwarded. */
export const SIGNED_HEADERS = ['x-passbook-key', 'x-passbook-ts', 'x-passbook-nonce', 'x-passbook-sig'] as const
export type SignedHeaders = Partial<Record<(typeof SIGNED_HEADERS)[number], string>>

export interface PlatformRequest {
  v: 1
  method: 'GET' | 'POST'
  /** Path and query exactly as signed. */
  path: string
  headers: SignedHeaders
  /** The raw body exactly as signed ('' for GET). */
  body: string
}

export interface PlatformResponse {
  v: 1
  status: number
  body: unknown
}

export interface Chunk {
  v: 1
  /** The request id: 16 random bytes, hex, chosen by the requester; the response reuses it. */
  id: Hex
  part: number
  parts: number
  data: string
}

export function requestProblems(r: unknown): string[] {
  const x = r as PlatformRequest
  if (!x || typeof x !== 'object' || x.v !== 1) return ['REQUEST_MALFORMED']
  const problems: string[] = []
  if (x.method !== 'GET' && x.method !== 'POST') problems.push('method')
  if (typeof x.path !== 'string' || !x.path.startsWith('/') || x.path.length > 512 || x.path.includes('..') || x.path.includes('#') || /\s/.test(x.path)) problems.push('path')
  if (!x.headers || typeof x.headers !== 'object' || Object.keys(x.headers).some((k) => !(SIGNED_HEADERS as readonly string[]).includes(k)) || Object.values(x.headers).some((v) => typeof v !== 'string' || v.length > 256)) problems.push('headers')
  if (typeof x.body !== 'string' || (x.method === 'GET' && x.body !== '')) problems.push('body')
  return problems
}

/** The same JSON in ASCII: every non-ASCII code unit escaped as \uXXXX (only JSON strings can hold one). */
export function asciiJson(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Split one JSON message into chunks (at least one), after making it ASCII. */
export function toChunks(id: Hex, json: string): Chunk[] {
  if (!isHex(id, 16)) throw new Error('the request id is 16 bytes of hex')
  const message = asciiJson(json)
  if (message.length > MAX_MESSAGE_CHARS) throw new Error(`message of ${message.length} characters is over the ${MAX_MESSAGE_CHARS}-character limit of the platform's Nostr bridge`)
  const parts = Math.max(1, Math.ceil(message.length / CHUNK_DATA_CHARS))
  return Array.from({ length: parts }, (_, part) => ({ v: 1 as const, id, part, parts, data: message.slice(part * CHUNK_DATA_CHARS, (part + 1) * CHUNK_DATA_CHARS) }))
}

/** A chunk's NIP-44 plaintext: its header as one JSON line, then the data unescaped. */
export function encodeChunk(c: Chunk): string {
  return `${JSON.stringify({ v: c.v, id: c.id, part: c.part, parts: c.parts })}\n${c.data}`
}

export function decodeChunk(plaintext: string): Chunk {
  const nl = plaintext.indexOf('\n')
  if (nl < 0 || nl > 200) throw new Error('CHUNK_MALFORMED')
  const head = JSON.parse(plaintext.slice(0, nl)) as Omit<Chunk, 'data'>
  return { v: head.v, id: head.id, part: head.part, parts: head.parts, data: plaintext.slice(nl + 1) }
}

export function chunkProblems(c: unknown): string[] {
  const x = c as Chunk
  if (!x || typeof x !== 'object' || x.v !== 1 || !isHex(x.id, 16)) return ['CHUNK_MALFORMED']
  if (!Number.isSafeInteger(x.parts) || x.parts < 1 || x.parts > MAX_CHUNKS || !Number.isSafeInteger(x.part) || x.part < 0 || x.part >= x.parts) return ['CHUNK_INDEX']
  if (typeof x.data !== 'string' || x.data.length > CHUNK_DATA_CHARS || /[^\x00-\x7e]/.test(x.data)) return ['CHUNK_DATA']
  return []
}

/** Collects the chunks of one message; the message is complete once every part arrived (duplicates are ignored). */
export class Reassembly {
  private readonly parts = new Map<number, string>()
  private total?: number
  readonly startedAt = Date.now()

  /** The whole message once complete; null while parts are missing; throws on a chunk that contradicts the others. */
  add(c: Chunk): string | null {
    const problems = chunkProblems(c)
    if (problems.length) throw new Error(problems.join(','))
    if (this.total !== undefined && c.parts !== this.total) throw new Error('CHUNK_PARTS_MISMATCH')
    this.total = c.parts
    const seen = this.parts.get(c.part)
    if (seen !== undefined && seen !== c.data) throw new Error('CHUNK_CONFLICT')
    this.parts.set(c.part, c.data)
    if (this.parts.size < this.total) return null
    return Array.from({ length: this.total }, (_, i) => this.parts.get(i)!).join('')
  }
}

/** The platform's public info event (kind 38550): who to send requests to, where, and what it serves. */
export interface PlatformInfo {
  v: 1
  protocol: typeof PLATFORM_NOSTR_PROTOCOL
  /** The platform key: the Nostr key requests are encrypted to, and /state's platform_pk. */
  platform_pk: Hex
  relays: string[]
  /** The test network the platform serves (regtest, mutinynet); never mainnet. */
  network: string
  kinds: { request: number; response: number }
  max_message_chars: number
  /** Method and path patterns served over Nostr (party routes only). */
  routes: string[]
  test_data: true
}

export function platformInfoProblems(i: unknown): string[] {
  const x = i as PlatformInfo
  if (!x || typeof x !== 'object' || x.v !== 1 || x.protocol !== PLATFORM_NOSTR_PROTOCOL) return ['INFO_MALFORMED']
  const problems: string[] = []
  if (!isHex(x.platform_pk, 32)) problems.push('platform_pk')
  if (!Array.isArray(x.relays) || !x.relays.length || !x.relays.every((u) => typeof u === 'string' && /^wss?:\/\//.test(u))) problems.push('relays')
  if (typeof x.network !== 'string' || !/^[a-z0-9-]{1,32}$/.test(x.network) || ['mainnet', 'bitcoin', 'main'].includes(x.network)) problems.push('network')
  if (x.kinds?.request !== PLATFORM_NOSTR_KIND.REQUEST || x.kinds?.response !== PLATFORM_NOSTR_KIND.RESPONSE) problems.push('kinds')
  if (x.test_data !== true) problems.push('test_data')
  return problems
}
