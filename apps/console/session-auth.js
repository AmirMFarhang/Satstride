// Signs every console request with the operator session (src/server/auth.ts).
// Same scheme as web/session-auth.js: the operator link the platform prints
// carries the session in the URL fragment (#session=<id>.<secret>), which
// browsers never send to a server. It is kept in sessionStorage for this tab
// and removed from the address bar. Each request (GETs included: every
// console route is operator-only) carries HMAC-SHA256(secret, requestDigest)
// computed with WebCrypto.

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const bytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))

const KEY = 'passbook-console-session'
const LEGACY_KEY = 'passbook-dashboard-session'
const FRAGMENT = /(?:^#|[&?/])session=([A-Za-z0-9_-]{8,64})\.([0-9a-f]{64})/
const STORED = /^([A-Za-z0-9_-]{8,64})\.([0-9a-f]{64})$/

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

/** Same as requestDigest in src/server/auth.ts. */
export async function requestDigest(method, pathAndQuery, timestampMs, nonce, body) {
  return sha256Hex(['passbook-request-v1', method.toUpperCase(), pathAndQuery, String(timestampMs), nonce, await sha256Hex(body)].join('\n'))
}

/** Parses `<anything>#session=<id>.<secret>` or a bare `<id>.<secret>`; null when it is not a session. */
export function parseSession(text) {
  const s = String(text ?? '').trim()
  const m = /session=([A-Za-z0-9_-]{8,64})\.([0-9a-f]{64})(?![0-9a-f])/.exec(s) ?? STORED.exec(s)
  return m ? { id: m[1], secret: m[2] } : null
}

export function storeSession(session, storage = globalThis.sessionStorage) {
  try { storage?.setItem(KEY, `${session.id}.${session.secret}`) } catch { /* private mode: memory only */ }
}

export function forgetSession(storage = globalThis.sessionStorage) {
  try { storage?.removeItem(KEY); storage?.removeItem(LEGACY_KEY) } catch { /* storage blocked */ }
}

/**
 * The session from the fragment (stored for this tab, then hidden from the
 * address bar; any route in the fragment is kept) or from sessionStorage.
 * Null when absent.
 */
export function readSession(loc = globalThis.location, storage = globalThis.sessionStorage, history = globalThis.history) {
  const hash = loc?.hash ?? ''
  const m = FRAGMENT.exec(hash)
  if (m) {
    const session = { id: m[1], secret: m[2] }
    storeSession(session, storage)
    const route = /^#\/[a-z-]+/.exec(hash)
    try { history?.replaceState(null, '', `${loc.pathname}${loc.search}${route ? route[0] : ''}`) } catch { /* not in a browser */ }
    return session
  }
  for (const k of [KEY, LEGACY_KEY]) {
    let saved = null
    try { saved = storage?.getItem(k) ?? null } catch { /* storage blocked */ }
    const s = saved && STORED.exec(saved)
    if (s) return { id: s[1], secret: s[2] }
  }
  return null
}

const keyCache = new Map()
async function hmacKey(secret) {
  let key = keyCache.get(secret)
  if (!key) {
    key = await crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    keyCache.set(secret, key)
  }
  return key
}

/** The four x-passbook-* headers for one request. `body` is the exact string sent ('' for none). */
export async function signedHeaders(session, method, pathAndQuery, body = '', now = Date.now()) {
  if (!session) return {}
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  const digest = await requestDigest(method, pathAndQuery, now, nonce, body)
  const mac = hex(await crypto.subtle.sign('HMAC', await hmacKey(session.secret), enc.encode(digest)))
  return { 'x-passbook-session': session.id, 'x-passbook-ts': String(now), 'x-passbook-nonce': nonce, 'x-passbook-hmac': mac }
}
