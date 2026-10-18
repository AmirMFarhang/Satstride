// The platform API over Nostr (passbook-platform-nostr/v1, wire in nostr-api-wire.ts):
// the laptop needs only outbound internet, and a phone reaches the platform from any
// network through public relays, with no Wi-Fi, tunnel or open port.
//
// Each request is the HTTP request the party already signs. It is fed to the SAME
// request listener the HTTP server uses (api.ts dispatch), so enforce-mode auth, the
// nonce and timestamp window, party binding (K7), rate limits, the 1 MB body cap and
// the platform-offline switch apply exactly as over HTTP. The request's socket is
// `nostr:<sender>`, never a loopback address, so the development-only unsigned loopback
// console can never be reached this way, and public routes are rate-limited per sender.
// Only the party routes the agents and the phone use are served; operator, demo,
// dashboard and stream routes are refused before dispatch. The signed key must be the
// Nostr event's author, and the response is encrypted to that author.
//
// Enabled by PASSBOOK_PLATFORM_RELAYS (comma-separated relay URLs); unset, nothing starts.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { SimplePool } from 'nostr-tools'
import { isHex, type Hex, type KeyPair } from '../core/crypto.js'
import { TOPIC } from '../market/kinds.js'
import { decryptFrom, encryptTo, isAuthentic, signEvent, type Event } from '../market/messages.js'
import { poolTransport, type NegotiationTransport, type NostrEvent } from '../market/negotiate-nostr.js'
import { guardedWebSocket } from '../agents/relay.js'
import type { Api } from './api.js'
import {
  chunkProblems, decodeChunk, encodeChunk, PLATFORM_INFO_D, PLATFORM_NOSTR_KIND, PLATFORM_NOSTR_PROTOCOL, MAX_MESSAGE_CHARS, Reassembly, requestProblems, toChunks,
  type Chunk, type PlatformInfo, type PlatformRequest, type PlatformResponse,
} from './nostr-api-wire.js'

/** The party routes served over Nostr: those src/agents/platform-client.ts and the phone's platform.ts call. */
export const PARTY_ROUTES: readonly { method: 'GET' | 'POST'; path: string }[] = [
  { method: 'GET', path: '/state' },
  { method: 'GET', path: '/oracle/quote' },
  { method: 'GET', path: '/orderbook' },
  { method: 'GET', path: '/sandbox/pubkey' },
  { method: 'GET', path: '/loans/:id' },
  { method: 'GET', path: '/passbook/:pk' },
  { method: 'GET', path: '/fees' },
  { method: 'GET', path: '/fees/:loan_id' },
  { method: 'POST', path: '/sandbox/submit' },
  { method: 'POST', path: '/loans' },
  { method: 'POST', path: '/loans/:id/lock' },
  { method: 'POST', path: '/loans/:id/release' },
  { method: 'POST', path: '/loans/:id/funded' },
  { method: 'POST', path: '/loans/:id/repaid' },
  { method: 'POST', path: '/loans/:id/repayment/verify' },
  { method: 'POST', path: '/loans/:id/repayment-watch' },
  { method: 'POST', path: '/loans/:id/settle' },
  { method: 'POST', path: '/cosign' },
  { method: 'POST', path: '/wire' },
  { method: 'POST', path: '/fees/:loan_id/invoice' },
  { method: 'POST', path: '/fees/:loan_id/verify' },
]

const ROUTE_PATTERNS = PARTY_ROUTES.map((r) => ({ method: r.method, pattern: new RegExp(`^${r.path.replace(/:[a-z_]+/g, '[A-Za-z0-9]{1,128}')}$`) }))

/** Whether a method and path (query ignored) is a party route served over Nostr. */
export function servedOverNostr(method: string, path: string): boolean {
  const pathname = path.split('?')[0]
  return ROUTE_PATTERNS.some((r) => r.method === method && r.pattern.test(pathname))
}

/** What the HTTP handler wrote, collected in memory (the same json() writes it does over a socket). */
class CapturedResponse {
  statusCode = 200
  writableEnded = false
  headersSent = false
  private readonly headers = new Map<string, string>()
  private body = ''
  private resolve!: () => void
  readonly finished = new Promise<void>((r) => { this.resolve = r })
  setHeader(name: string, value: string | number): this { this.headers.set(name.toLowerCase(), String(value)); return this }
  getHeader(name: string): string | undefined { return this.headers.get(name.toLowerCase()) }
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status
    this.headersSent = true
    for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v)
    return this
  }
  write(chunk: unknown): boolean { this.body += String(chunk); return true }
  end(chunk?: unknown): this {
    if (chunk !== undefined) this.body += String(chunk)
    this.writableEnded = true
    this.resolve()
    return this
  }
  on(): this { return this }
  once(): this { return this }
  json(): unknown { try { return JSON.parse(this.body) } catch { return this.body } }
}

export interface NostrApiOptions {
  /** The API the HTTP server serves (createApp().api): requests go to its own request listener. */
  api: Pick<Api, 'server'>
  /** The platform key: requests are encrypted to it; the info event and responses are signed by it. */
  key: KeyPair
  transport: NegotiationTransport
  /** The relays named in the info event (where requests are read). */
  relays: string[]
  /** The test network served (regtest, mutinynet, testnet4); never mainnet. */
  network: string
  /** How long a handler may take; default 120 s (a sandbox credit check). */
  handlerTimeoutMs?: number
  /** How long a response is kept for a retried request; default 10 min. */
  responseCacheMs?: number
  /** Incomplete multi-chunk requests kept at once; default 256 (the oldest is dropped for a new one). */
  maxPending?: number
  /** Incomplete multi-chunk requests one sender may have at once; default 4. */
  maxPendingPerSender?: number
  /** NIP-40 expiration of the info event; default 6 h (it is republished hourly). */
  infoTtlSec?: number
  now?: () => number
  log?: (line: string) => void
}

const testLabel = (network: string) => `Passbook test data: test USDT on ${network}, no value. Not real USDT.`

export class NostrApi {
  private readonly pending = new Map<string, Reassembly>()
  private readonly inFlight = new Set<string>()
  private readonly answered = new Map<string, { response: PlatformResponse; at: number }>()
  private readonly seenEvents = new Set<string>()
  private unsubscribe?: () => void
  private readonly now: () => number

  constructor(private readonly o: NostrApiOptions) {
    if (!/^[a-z0-9-]{1,32}$/.test(o.network) || ['mainnet', 'bitcoin', 'main'].includes(o.network)) throw new Error(`the platform's Nostr bridge serves a test network, not ${o.network}`)
    this.now = o.now ?? Date.now
  }

  get pubkey(): Hex { return this.o.key.pubkey }

  /** Incomplete multi-chunk requests waiting, in all or from one sender. */
  pendingCount(author?: Hex): number {
    return author ? [...this.pending.keys()].filter((k) => k.startsWith(`${author}:`)).length : this.pending.size
  }

  /** Listen for requests to the platform key from now (and the last two minutes, for a request sent while starting). */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.o.transport.subscribe({ kinds: [PLATFORM_NOSTR_KIND.REQUEST], '#p': [this.pubkey], since: Math.floor(this.now() / 1000) - 120 }, (e) => { void this.handle(e).catch((err) => this.o.log?.(`nostr api: ${(err as Error).message}`)) })
  }

  stop(): void { this.unsubscribe?.(); this.unsubscribe = undefined }

  info(): PlatformInfo {
    return { v: 1, protocol: PLATFORM_NOSTR_PROTOCOL, platform_pk: this.pubkey, relays: [...this.o.relays], network: this.o.network, kinds: { request: PLATFORM_NOSTR_KIND.REQUEST, response: PLATFORM_NOSTR_KIND.RESPONSE }, max_message_chars: MAX_MESSAGE_CHARS, routes: PARTY_ROUTES.map((r) => `${r.method} ${r.path}`), test_data: true }
  }

  /** The addressable info event: the platform key, its relays and routes, labelled as test data for its network. */
  async publishInfo(): Promise<NostrEvent> {
    const createdMs = this.now(), created = Math.floor(createdMs / 1000)
    const tags = [['d', PLATFORM_INFO_D], ['t', TOPIC], ['network', this.o.network], ['alt', testLabel(this.o.network)], ['expiration', String(created + (this.o.infoTtlSec ?? 6 * 3600))]]
    const event = signEvent(this.o.key, PLATFORM_NOSTR_KIND.INFO, JSON.stringify(this.info()), tags, createdMs) as NostrEvent
    await this.o.transport.publish(event)
    return event
  }

  /** One request event (a chunk). Exposed for tests; the subscription calls it. */
  async handle(e: NostrEvent): Promise<void> {
    if (e.kind !== PLATFORM_NOSTR_KIND.REQUEST || this.seenEvents.has(e.id)) return
    this.remember(e.id)
    const id = e.tags.find((t) => t[0] === 'q')?.[1]
    if (!isHex(id, 16) || !e.tags.some((t) => t[0] === 'p' && t[1] === this.pubkey) || !isAuthentic(e as Event)) return
    const author = e.pubkey
    const key = `${author}:${id}`
    let chunk: Chunk
    try { chunk = decodeChunk(decryptFrom(this.o.key, author, e.content)) } catch { return }
    if (chunk?.id !== id) return
    this.expire()
    // a retried request: answer again from the cache, never dispatch twice (its nonce is spent)
    const cached = this.answered.get(key)
    if (cached) { if (chunk.part === 0) await this.reply(author, id as Hex, cached.response); return }
    if (this.inFlight.has(key)) return
    if (chunkProblems(chunk).length) return this.finish(author, id as Hex, key, { v: 1, status: 413, body: { error: `request too large or malformed for the platform's Nostr bridge (at most ${MAX_MESSAGE_CHARS} characters); ${chunkProblems(chunk).join(',')}` } })
    // A single-chunk request (almost all of them) is whole at once and never waits here. A multi-chunk one waits, at
    // most maxPendingPerSender per sender; when the store is full the oldest waiting request makes room, so no sender
    // (none is authenticated yet) can hold every slot.
    let r = chunk.parts === 1 ? new Reassembly() : this.pending.get(key)
    if (!r) {
      const mine = [...this.pending.keys()].filter((k) => k.startsWith(`${author}:`)).length
      if (mine >= (this.o.maxPendingPerSender ?? 4)) return
      if (this.pending.size >= (this.o.maxPending ?? 256)) this.pending.delete(this.pending.keys().next().value as string)
      r = new Reassembly()
      this.pending.set(key, r)
    }
    let message: string | null
    try { message = r.add(chunk) } catch (err) { this.pending.delete(key); return this.finish(author, id as Hex, key, { v: 1, status: 400, body: { error: `bad request chunks: ${(err as Error).message}` } }) }
    if (message === null) return
    this.pending.delete(key)
    this.inFlight.add(key)
    try {
      await this.finish(author, id as Hex, key, await this.answer(author, message))
    } finally { this.inFlight.delete(key) }
  }

  private async answer(author: Hex, message: string): Promise<PlatformResponse> {
    let req: PlatformRequest
    try { req = JSON.parse(message) as PlatformRequest } catch { return { v: 1, status: 400, body: { error: 'request is not JSON' } } }
    const problems = requestProblems(req)
    if (problems.length) return { v: 1, status: 400, body: { error: `malformed request: ${problems.join(', ')}` } }
    if (!servedOverNostr(req.method, req.path)) return { v: 1, status: 403, body: { error: `${req.method} ${req.path.split('?')[0]} is not served over Nostr: party routes only` } }
    const signer = req.headers['x-passbook-key']
    if (signer !== undefined && signer !== author) return { v: 1, status: 401, body: { error: 'the key that signed the request must author the Nostr event' } }
    return this.dispatch(req, author)
  }

  /** Into the same request listener as HTTP: auth, nonce, party binding and rate limits unchanged. */
  private async dispatch(req: PlatformRequest, author: Hex): Promise<PlatformResponse> {
    const raw = req.body
    const headers: Record<string, string> = { host: 'platform.nostr', ...req.headers, ...(raw ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) } : {}) }
    const incoming = Object.assign(Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []), { method: req.method, url: req.path, headers, socket: { remoteAddress: `nostr:${author}` } })
    const res = new CapturedResponse()
    this.o.api.server.emit('request', incoming as unknown as IncomingMessage, res as unknown as ServerResponse)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([res.finished.then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), this.o.handlerTimeoutMs ?? 120_000) })])
    clearTimeout(timer)
    if (timedOut) return { v: 1, status: 504, body: { error: 'the platform did not answer in time' } }
    return { v: 1, status: res.statusCode, body: res.json() }
  }

  private async finish(author: Hex, id: Hex, key: string, response: PlatformResponse): Promise<void> {
    const text = JSON.stringify(response)
    let fits = true
    try { toChunks(id, text) } catch { fits = false }
    const sent = !fits ? { v: 1 as const, status: 502, body: { error: `response over the ${MAX_MESSAGE_CHARS}-character limit of the platform's Nostr bridge; use HTTP` } } : response
    this.answered.set(key, { response: sent, at: this.now() })
    await this.reply(author, id, sent)
  }

  private async reply(author: Hex, id: Hex, response: PlatformResponse): Promise<void> {
    const created = this.now()
    for (const c of toChunks(id, JSON.stringify(response))) {
      const event = signEvent(this.o.key, PLATFORM_NOSTR_KIND.RESPONSE, encryptTo(this.o.key, author, encodeChunk(c)), [['t', TOPIC], ['p', author], ['q', id]], created) as NostrEvent
      await this.o.transport.publish(event)
    }
  }

  private remember(eventId: string): void {
    this.seenEvents.add(eventId)
    if (this.seenEvents.size > 20_000) this.seenEvents.delete(this.seenEvents.values().next().value as string)
  }

  private expire(): void {
    const now = this.now()
    for (const [k, v] of this.answered) if (now - v.at > (this.o.responseCacheMs ?? 600_000)) this.answered.delete(k)
    for (const [k, v] of this.pending) if (Date.now() - v.startedAt > 120_000) this.pending.delete(k)
  }
}

/**
 * Starts the bridge when PASSBOOK_PLATFORM_RELAYS names relays: listens for requests, publishes the info event and
 * republishes it hourly. Returns null (nothing started) when the variable is unset.
 */
export async function startNostrApiFromEnv(api: Pick<Api, 'server'>, key: KeyPair, env: NodeJS.ProcessEnv = process.env, deploymentNetwork?: string): Promise<NostrApi | null> {
  const relays = (env.PASSBOOK_PLATFORM_RELAYS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
  if (!relays.length) return null
  const network = env.PASSBOOK_PUBLIC_NETWORK?.trim() || deploymentNetwork || 'regtest'
  // SimplePool spreads its options over its defaults at runtime; its type names only enablePing/enableReconnect
  const pool = new SimplePool({ websocketImplementation: guardedWebSocket() } as ConstructorParameters<typeof SimplePool>[0])
  const bridge = new NostrApi({ api, key, transport: poolTransport(pool, relays), relays, network, log: (line) => console.log(line) })
  bridge.start()
  const publish = () => bridge.publishInfo().catch((err) => console.error(`nostr api: info event not published: ${(err as Error).message}`))
  await publish()
  setInterval(() => void publish(), 3_600_000).unref()
  console.log(`platform API over Nostr on ${relays.join(', ')}: platform_pk=${key.pubkey} (${network}, test data; party routes only)`)
  return bridge
}
