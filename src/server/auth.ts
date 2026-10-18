// API request signing, authentication and rate limits.
//
// Agents sign each request with their Passbook key (BIP-340 Schnorr over
// method, path and query, a millisecond timestamp, a nonce and the body hash).
// The dashboard, which runs in a browser without secp256k1, signs the same
// digest with HMAC-SHA256 under an operator session secret (web/session-auth.js),
// delivered in the link the demo prints (a URL fragment, never sent to the server).
// The server checks the signature or MAC, a +-60 s clock window and nonce reuse,
// then the route's access level:
//   public    anyone (GET reads, the dashboard files)
//   signed    a valid signature, rate-limited per key; a party binding names
//             which keys may sign (the loan's borrower or lender, the lender
//             in the terms, the bundle's sender), read from the request and
//             the registry. Any other key, an operator and the dashboard get 403.
//   operator  the platform key, a listed operator key, or a dashboard session
//
//   device    (not a route level) a paired phone's own key, checked on every
//             request: revoked or expired is refused at once (401); its scope
//             lists what it may do (DEVICE_SCOPES), anything else is 403.
//
// Modes: enforce (the default; blocks with 401, 403 or 429), report (checks
// and reports in a response header, never blocks) and off. report, off and the
// unsigned loopback console are development only: they need PASSBOOK_DEV=1.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isHex, sha256Hex, signHash, verifyHash, type Hex, type KeyPair } from '../core/crypto.js'

export type Access = 'public' | 'signed' | 'operator'
export type AuthMode = 'off' | 'report' | 'enforce'

/** The keys that may sign a `signed` route, from its path parameters, its body and the registry. */
export interface PartyBinding {
  /** Named in the 403, e.g. "the loan's borrower or lender". */
  who: string
  keys: (req: { params: Record<string, string>; body: Record<string, unknown> }) => readonly unknown[]
}

/** A route's binding applied to one request: `keys` reads its body only after the signature checks out. */
export interface BoundParty { who: string; keys: () => readonly unknown[] }

export const AUTH_HEADERS = { key: 'x-passbook-key', ts: 'x-passbook-ts', nonce: 'x-passbook-nonce', sig: 'x-passbook-sig', session: 'x-passbook-session', hmac: 'x-passbook-hmac' } as const
const WINDOW_MS = 60_000

export function requestDigest(method: string, pathAndQuery: string, timestampMs: number, nonce: string, body: string): Hex {
  return sha256Hex(['passbook-request-v1', method.toUpperCase(), pathAndQuery, String(timestampMs), nonce, sha256Hex(body)].join('\n'))
}

/** Headers a client adds; `body` must be the exact bytes it sends. */
export function signRequest(key: KeyPair, method: string, pathAndQuery: string, body = '', now = Date.now(), nonce = sha256Hex(`${now}:${Math.random()}`).slice(0, 32)): Record<string, string> {
  return { [AUTH_HEADERS.key]: key.pubkey, [AUTH_HEADERS.ts]: String(now), [AUTH_HEADERS.nonce]: nonce, [AUTH_HEADERS.sig]: signHash(requestDigest(method, pathAndQuery, now, nonce, body), key.secretKey) }
}

/** An operator session for the browser dashboard: `<id>.<64 hex secret>`, as carried in the printed link's fragment. */
export interface DashboardSession { id: string; secret: Hex }

export function newDashboardSession(): DashboardSession {
  return { id: randomBytes(8).toString('hex'), secret: randomBytes(32).toString('hex') }
}

export function parseDashboardSession(token: string): DashboardSession {
  const m = /^([A-Za-z0-9_-]{8,64})\.([0-9a-f]{64})$/.exec(token)
  if (!m) throw new Error('dashboard session must be <id>.<64 hex secret>')
  return { id: m[1], secret: m[2] }
}

export const sessionToken = (s: DashboardSession) => `${s.id}.${s.secret}`

/** What web/session-auth.js computes: HMAC-SHA256(secret, utf8(requestDigest)). */
export function sessionMac(secret: Hex, digest: Hex): Hex {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(digest, 'utf8').digest('hex')
}

export class NonceCache {
  private readonly seen = new Map<string, number>()
  /** false when this key already used this nonce inside the window */
  claim(key: Hex, nonce: string, now: number): boolean {
    if (this.seen.size > 10_000) for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k)
    const id = `${key}:${nonce}`
    const exp = this.seen.get(id)
    if (exp !== undefined && exp >= now) return false
    this.seen.set(id, now + 2 * WINDOW_MS)
    return true
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  constructor(private readonly capacity: number, private readonly perSecond: number) {}
  take(id: string, now: number): { ok: boolean; retryAfterS: number } {
    const b = this.buckets.get(id) ?? { tokens: this.capacity, at: now }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSecond)
    b.at = now
    this.buckets.set(id, b)
    if (b.tokens < 1) return { ok: false, retryAfterS: Math.ceil((1 - b.tokens) / this.perSecond) }
    b.tokens -= 1
    return { ok: true, retryAfterS: 0 }
  }
}

export interface ApiAuthConfig {
  mode: AuthMode
  operators: Hex[]
  /** Unsigned loopback requests act as the operator console. Development only. */
  localConsole: boolean
  /** Browser dashboard sessions, each with operator rights. */
  sessions?: DashboardSession[]
  /** Paired phones (thin clients); ApiAuth makes an empty registry when absent. */
  devices?: DeviceRegistry
  /** Per signing key; public reads are limited per IP. */
  signedLimit?: { capacity: number; perSecond: number }
  publicLimit?: { capacity: number; perSecond: number }
  now?: () => number
}

export type AuthDecision =
  | { ok: true; identity: string; via: 'signature' | 'session' | 'device' | 'local-console' | 'public' | 'off' }
  | { ok: false; status: 401 | 403 | 429; reason: string; retryAfterS?: number }

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export class ApiAuth {
  private readonly nonces = new NonceCache()
  private readonly signedLimiter: RateLimiter
  private readonly publicLimiter: RateLimiter
  readonly devices: DeviceRegistry
  constructor(readonly cfg: ApiAuthConfig) {
    this.devices = cfg.devices ?? new DeviceRegistry()
    this.signedLimiter = new RateLimiter(cfg.signedLimit?.capacity ?? 120, cfg.signedLimit?.perSecond ?? 20)
    this.publicLimiter = new RateLimiter(cfg.publicLimit?.capacity ?? 240, cfg.publicLimit?.perSecond ?? 40)
  }

  decide(req: IncomingMessage, pathAndQuery: string, body: string, access: Access, party?: BoundParty): AuthDecision {
    if (this.cfg.mode === 'off') return { ok: true, identity: 'anonymous', via: 'off' }
    const now = this.cfg.now?.() ?? Date.now()
    const h = (name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v }
    const key = h(AUTH_HEADERS.key), sig = h(AUTH_HEADERS.sig)
    const sessionId = h(AUTH_HEADERS.session), mac = h(AUTH_HEADERS.hmac)
    const local = this.cfg.localConsole && LOOPBACK.has(req.socket.remoteAddress ?? '')
    if (sessionId || mac) {
      const ts = Number(h(AUTH_HEADERS.ts)), nonce = h(AUTH_HEADERS.nonce) ?? ''
      const session = this.cfg.sessions?.find((x) => x.id === sessionId)
      if (!session || typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac) || !Number.isSafeInteger(ts) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return { ok: false, status: 401, reason: 'unknown dashboard session or malformed headers' }
      if (Math.abs(now - ts) > WINDOW_MS) return { ok: false, status: 401, reason: 'request timestamp outside the window' }
      const want = Buffer.from(sessionMac(session.secret, requestDigest(req.method ?? 'GET', pathAndQuery, ts, nonce, body)), 'hex')
      if (!timingSafeEqual(want, Buffer.from(mac, 'hex'))) return { ok: false, status: 401, reason: 'bad dashboard session MAC' }
      if (!this.nonces.claim(`session:${session.id}`, nonce, now)) return { ok: false, status: 401, reason: 'replayed request' }
      // the operator acts for the platform, never for a party
      if (party) return { ok: false, status: 403, reason: `request must be signed by ${party.who}` }
      return { ok: true, identity: `session:${session.id}`, via: 'session' }
    }
    if (!key && !sig) {
      if (party) return { ok: false, status: 401, reason: `request must be signed by ${party.who}` }
      if (local) return { ok: true, identity: 'local-console', via: 'local-console' }
      if (access !== 'public') return { ok: false, status: 401, reason: 'signed request required' }
      const limited = this.publicLimiter.take(`ip:${req.socket.remoteAddress ?? '?'}`, now)
      return limited.ok ? { ok: true, identity: 'anonymous', via: 'public' } : { ok: false, status: 429, reason: 'rate limit', retryAfterS: limited.retryAfterS }
    }
    const ts = Number(h(AUTH_HEADERS.ts)), nonce = h(AUTH_HEADERS.nonce) ?? ''
    if (!isHex(key, 32) || typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig) || !Number.isSafeInteger(ts) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return { ok: false, status: 401, reason: 'malformed signature headers' }
    if (Math.abs(now - ts) > WINDOW_MS) return { ok: false, status: 401, reason: 'request timestamp outside the window' }
    if (!verifyHash(sig, requestDigest(req.method ?? 'GET', pathAndQuery, ts, nonce, body), key)) return { ok: false, status: 401, reason: 'bad request signature' }
    if (!this.nonces.claim(key, nonce, now)) return { ok: false, status: 401, reason: 'replayed request' }
    const device = this.devices.get(key)
    if (device) return this.decideDevice(device, req.method ?? 'GET', pathAndQuery, body, access, now, party)
    const operator = this.cfg.operators.includes(key)
    if (access === 'operator' && !operator) return { ok: false, status: 403, reason: 'operator key required' }
    if (party && !party.keys().includes(key)) return { ok: false, status: 403, reason: `request must be signed by ${party.who}` }
    if (!operator) {
      const limited = this.signedLimiter.take(key, now)
      if (!limited.ok) return { ok: false, status: 429, reason: 'rate limit', retryAfterS: limited.retryAfterS }
    }
    return { ok: true, identity: key, via: 'signature' }
  }

  /** A paired phone: never an operator; a party only where a route names device keys; otherwise exactly its scope. */
  private decideDevice(device: DeviceKey, method: string, pathAndQuery: string, body: string, access: Access, now: number, party?: BoundParty): AuthDecision {
    const refused = deviceRefusal(device, now)
    if (refused) return { ok: false, status: 401, reason: `device key ${refused}; pair the phone again` }
    if (party) {
      if (!party.keys().includes(device.pubkey)) return { ok: false, status: 403, reason: `request must be signed by ${party.who}` }
    } else if (!deviceScopeAllows(device.scope, method, pathAndQuery, body, access)) {
      return { ok: false, status: 403, reason: `device scope ${device.scope} does not cover ${method.toUpperCase()} ${pathAndQuery.split('?')[0]}` }
    } else if (!(method.toUpperCase() === 'GET' && access === 'public')) {
      // the stops are the node's one running borrower's: a phone paired for another borrower answers none of them
      const current = this.devices.currentBorrower?.()
      if (current !== device.borrower_pk) return { ok: false, status: 403, reason: current ? `device is paired for borrower ${device.borrower_pk.slice(0, 12)}…, this node's borrower is ${current.slice(0, 12)}…` : 'no borrower is running on this node' }
    }
    const limited = this.signedLimiter.take(device.pubkey, now)
    if (!limited.ok) return { ok: false, status: 429, reason: 'rate limit', retryAfterS: limited.retryAfterS }
    return { ok: true, identity: `device:${device.id}`, via: 'device' }
  }
}

// ---- device keys: a paired phone (thin client, apps/android) ----
//
// The operator's dashboard offers a one-time pairing code, shown as a QR with
// the node URL, the scope and both expiries. The phone makes its own Schnorr key
// (its secret never leaves the phone and is never on screen), then claims the
// code with a request signed by that key: proof of possession. From then on it
// signs every request like an agent, and every request checks the key's record.

export type DeviceScope = 'borrower'

export interface DeviceKey {
  id: string
  pubkey: Hex
  scope: DeviceScope
  /** The borrower this phone acts for; shown on both sides of the pairing. */
  borrower_pk: Hex
  label: string
  paired_at: number
  expires_at: number
  revoked_at?: number
}

export interface PairingOffer {
  code: string
  scope: DeviceScope
  borrower_pk: Hex
  /** The code's own expiry: claim it before this. */
  expires_at: number
  /** The device key's lifetime from the claim. */
  key_ttl_ms: number
}

/**
 * What each scope may do besides public reads. `borrower`: the borrower's own
 * stops on the phone (share at stop 1, accept or pay at stops 2 and 3), the
 * same requests the dashboard's phone makes. Not lender or checker approvals,
 * fees, the step gate, the price, the platform switch or any party write.
 */
export const DEVICE_SCOPES: Record<DeviceScope, readonly { method: string; path: string; body?: (b: Record<string, unknown>) => boolean }[]> = {
  borrower: [
    { method: 'POST', path: '/demo/approve' },
    { method: 'POST', path: '/demo/confirm', body: (b) => b.stop === 'accept' || b.stop === 'repay' },
  ],
}

export const DEVICE_LIMITS = { codeTtlMs: 5 * 60_000, keyTtlMs: 12 * 3_600_000, maxKeyTtlMs: 24 * 3_600_000 } as const

export function deviceRefusal(d: DeviceKey, now: number): 'revoked' | 'expired' | null {
  if (d.revoked_at !== undefined) return 'revoked'
  return now >= d.expires_at ? 'expired' : null
}

export function deviceScopeAllows(scope: DeviceScope, method: string, pathAndQuery: string, body: string, access: Access): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' && access === 'public') return true
  const path = pathAndQuery.split('?')[0]
  const rule = DEVICE_SCOPES[scope]?.find((r) => r.method === m && r.path === path)
  if (!rule) return false
  if (!rule.body) return true
  try {
    const parsed = JSON.parse(body || '{}') as unknown
    return !!parsed && typeof parsed === 'object' && rule.body(parsed as Record<string, unknown>)
  } catch {
    return false
  }
}

/** In memory: a restarted node forgets its phones, and they pair again. */
export class DeviceRegistry {
  private readonly offers = new Map<string, PairingOffer>()
  private readonly keys = new Map<Hex, DeviceKey>()
  /**
   * The borrower whose stops this node is running now (createApp reads the
   * demo's announcement). A device writes only for its own borrower; with no
   * borrower known it writes nothing.
   */
  currentBorrower?: () => Hex | undefined

  offer(o: { scope: DeviceScope; borrower_pk: Hex; key_ttl_ms?: number }, now: number): PairingOffer {
    if (o.scope !== 'borrower') throw new Error('scope must be borrower')
    if (!isHex(o.borrower_pk, 32)) throw new Error('borrower_pk must be a 32-byte x-only key')
    const current = this.currentBorrower?.()
    if (current && current !== o.borrower_pk) throw new Error(`this node's borrower is ${current.slice(0, 12)}…, not ${o.borrower_pk.slice(0, 12)}…`)
    const key_ttl_ms = o.key_ttl_ms ?? DEVICE_LIMITS.keyTtlMs
    if (!Number.isSafeInteger(key_ttl_ms) || key_ttl_ms < 60_000 || key_ttl_ms > DEVICE_LIMITS.maxKeyTtlMs) throw new Error('device key lifetime must be between 1 minute and 24 hours')
    for (const [code, x] of this.offers) if (x.expires_at <= now) this.offers.delete(code)
    const offer: PairingOffer = { code: randomBytes(16).toString('hex'), scope: o.scope, borrower_pk: o.borrower_pk, expires_at: now + DEVICE_LIMITS.codeTtlMs, key_ttl_ms }
    this.offers.set(offer.code, offer)
    return offer
  }

  /** One use: the first valid claim consumes the code. */
  claim(code: unknown, pubkey: unknown, label: unknown, now: number): DeviceKey {
    const offer = typeof code === 'string' ? this.offers.get(code) : undefined
    if (!offer) throw new Error('unknown or already used pairing code')
    this.offers.delete(offer.code)
    if (offer.expires_at <= now) throw new Error('pairing code expired; show a new one')
    if (!isHex(pubkey, 32)) throw new Error('device_pk must be a 32-byte x-only key')
    const prior = this.keys.get(pubkey)
    if (prior && !deviceRefusal(prior, now)) throw new Error('this device key is already paired')
    const device: DeviceKey = {
      id: randomBytes(6).toString('hex'),
      pubkey,
      scope: offer.scope,
      borrower_pk: offer.borrower_pk,
      label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : 'phone',
      paired_at: now,
      expires_at: now + offer.key_ttl_ms,
    }
    this.keys.set(pubkey, device)
    return device
  }

  revoke(id: string, now: number): DeviceKey | undefined {
    const d = [...this.keys.values()].find((x) => x.id === id)
    if (d && d.revoked_at === undefined) d.revoked_at = now
    return d
  }

  get(pubkey: string | undefined): DeviceKey | undefined {
    return pubkey ? this.keys.get(pubkey) : undefined
  }

  /** Keys that would pass right now. */
  activeKeys(now: number): Hex[] {
    return [...this.keys.values()].filter((d) => !deviceRefusal(d, now)).map((d) => d.pubkey)
  }

  list(): DeviceKey[] {
    return [...this.keys.values()].map((d) => ({ ...d }))
  }
}

export function authFromEnv(platformPk: Hex, env: NodeJS.ProcessEnv = process.env, sessions: DashboardSession[] = []): ApiAuthConfig {
  const mode = (env.PASSBOOK_API_AUTH ?? 'enforce') as AuthMode
  if (!['off', 'report', 'enforce'].includes(mode)) throw new Error(`PASSBOOK_API_AUTH must be off, report or enforce, got ${mode}`)
  const dev = env.PASSBOOK_DEV === '1'
  if (mode !== 'enforce' && !dev) throw new Error(`PASSBOOK_API_AUTH=${mode} is development only; set PASSBOOK_DEV=1 to use it`)
  const localConsole = env.PASSBOOK_API_LOCAL_CONSOLE === '1'
  if (localConsole && !dev) throw new Error('PASSBOOK_API_LOCAL_CONSOLE=1 (unsigned loopback operator) is development only; set PASSBOOK_DEV=1')
  const operators = [platformPk, ...(env.PASSBOOK_OPERATOR_PKS ?? '').split(',').map((s) => s.trim()).filter(Boolean)]
  if (!operators.every((pk) => isHex(pk, 32))) throw new Error('PASSBOOK_OPERATOR_PKS must be comma-separated 32-byte x-only keys')
  return { mode, operators, localConsole, sessions }
}
