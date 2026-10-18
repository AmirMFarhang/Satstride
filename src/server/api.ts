// HTTP plumbing: a tiny router over node:http, JSON bodies, and a Server-Sent
// Events hub that replays the registry's wire and streams new events.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { NewWireEvent, Store, WireEvent } from '../registry/store.js'
import type { Access, ApiAuth, PartyBinding } from './auth.js'

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  body: () => Promise<Record<string, unknown>>
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: unknown,
  ) {
    super(message)
  }
}

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
  access: Access
  party?: PartyBinding
}

const MAX_BODY_BYTES = 1_000_000

export class Api {
  private readonly routes: Route[] = []
  private readonly clients = new Set<ServerResponse>()
  private platformOnline = true
  readonly server: Server

  constructor(private readonly store: Store, private readonly auth?: ApiAuth) {
    this.server = createServer((req, res) => void this.dispatch(req, res))
    // Native rgb-lib work can block Node past the default 5s idle timer. Keep
    // server sockets longer than client pools to avoid stale keep-alive races.
    this.server.keepAliveTimeout = 120_000
    this.server.headersTimeout = 121_000
  }

  setPlatformOnline(online: boolean): void { this.platformOnline = online }
  get isPlatformOnline(): boolean { return this.platformOnline }

  /**
   * Default access: GET is public, demo controls are operator-only, any other write must be signed.
   * A party binding makes the route `signed` by one of the keys it names.
   */
  on(method: string, path: string, handler: Handler, access: Access | PartyBinding = method === 'GET' ? 'public' : path.startsWith('/demo') ? 'operator' : 'signed'): void {
    const keys: string[] = []
    const pattern = new RegExp(
      '^' +
        path.replace(/:[a-zA-Z_]+/g, (m) => {
          keys.push(m.slice(1))
          return '([^/]+)'
        }) +
        '$',
    )
    if (typeof access === 'object') this.routes.push({ method, pattern, keys, handler, access: 'signed', party: access })
    else this.routes.push({ method, pattern, keys, handler, access })
  }

  /** Persist and broadcast one wire event. */
  emit(event: NewWireEvent): WireEvent {
    const stored = this.store.appendEvent({ ...event, at: event.at ?? Date.now() })
    const line = `data: ${JSON.stringify(stored)}\n\n`
    for (const c of this.clients) c.write(line)
    return stored
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const addr = this.server.address()
        resolve(typeof addr === 'object' && addr ? addr.port : port)
      })
    })
  }

  close(): Promise<void> {
    for (const c of this.clients) c.end()
    this.clients.clear()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const local = url.pathname === '/demo' || url.pathname.startsWith('/demo/') || ['/','/app.js','/style.css','/session-auth.js','/events'].includes(url.pathname)
      // the wallet panel is the user's own node, not a platform service: it keeps working with the platform API off
      || url.pathname === '/wallet' || url.pathname.startsWith('/wallet/') || url.pathname.startsWith('/wallet.') || url.pathname === '/wallet-strings.js'
      // a paired phone talks to this node (src/server/devices.ts), so pairing stays up with the platform API off
      || url.pathname.startsWith('/devices')
    if (!this.platformOnline && !local) { json(res, 503, { error: 'platform API is offline; peers must use their own state, Bitcoin and Nostr' }); return }
    if (req.method === 'GET' && url.pathname === '/events') return this.sse(req, res, Number(url.searchParams.get('after') ?? 0))
    for (const r of this.routes) {
      if (r.method !== req.method) continue
      const m = r.pattern.exec(url.pathname)
      if (!m) continue
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
      try {
        const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readRaw(req)
        let parsed: Record<string, unknown> | undefined
        const body = () => (parsed ??= parseBody(raw))
        if (this.auth) {
          const party = r.party && { who: r.party.who, keys: () => r.party!.keys({ params, body: body() }) }
          const decision = this.auth.decide(req, url.pathname + url.search, raw, r.access, party)
          if (!decision.ok && this.auth.cfg.mode === 'enforce') {
            if (decision.status === 429) res.setHeader('retry-after', String(decision.retryAfterS ?? 1))
            throw new HttpError(decision.status, decision.reason)
          }
          if (this.auth.cfg.mode === 'report') res.setHeader('x-passbook-auth', decision.ok ? `ok:${decision.via}` : `would-reject:${decision.status}:${decision.reason}`)
        }
        const out = await r.handler({ req, res, url, params, body: async () => body() })
        if (!res.writableEnded) json(res, 200, out ?? {})
      } catch (err) {
        if (err instanceof HttpError) json(res, err.status, { error: err.message, ...(err.extra ? { detail: err.extra } : {}) })
        else if (err && typeof err === 'object' && 'verdict' in err) json(res, 422, { error: (err as unknown as Error).message, verdict: (err as { verdict: unknown }).verdict })
        else json(res, 500, { error: (err as Error).message })
      }
      return
    }
    json(res, 404, { error: 'not found' })
  }

  private sse(req: IncomingMessage, res: ServerResponse, after: number): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    for (const e of this.store.listEvents(after)) res.write(`data: ${JSON.stringify(e)}\n\n`)
    this.clients.add(res)
    req.on('close', () => this.clients.delete(res))
  }
}

export async function readRaw(req: IncomingMessage): Promise<string> {
  let raw = ''
  let size = 0
  // Past the cap, keep draining without storing so the client can read the 413.
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size <= MAX_BODY_BYTES) raw += chunk
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large')
  return raw
}

function parseBody(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return parseBody(await readRaw(req))
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${name} required`)
  return v
}
