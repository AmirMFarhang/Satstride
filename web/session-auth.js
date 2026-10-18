// Signs dashboard writes for the platform's API auth (src/server/auth.ts).
// The operator session arrives in the link the demo prints, as a URL fragment
// (#session=<id>.<secret>), which browsers never send to the server. It is
// kept in sessionStorage for this tab and removed from the address bar. Each
// write carries HMAC-SHA256(secret, requestDigest) computed with WebCrypto:
// the same digest agents sign with their Passbook keys.

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const bytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))
const KEY = 'passbook-dashboard-session'

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

/** Same as requestDigest in src/server/auth.ts. */
export async function requestDigest(method, pathAndQuery, timestampMs, nonce, body) {
  return sha256Hex(['passbook-request-v1', method.toUpperCase(), pathAndQuery, String(timestampMs), nonce, await sha256Hex(body)].join('\n'))
}

/** The session from the fragment (stored for this tab, then hidden) or from sessionStorage; null when absent. */
export function readSession(loc = globalThis.location, storage = globalThis.sessionStorage, history = globalThis.history) {
  const m = loc && /(?:^#|&)session=([A-Za-z0-9_-]{8,64})\.([0-9a-f]{64})/.exec(loc.hash ?? '')
  if (m) {
    try { storage?.setItem(KEY, `${m[1]}.${m[2]}`) } catch { /* private mode: keep it in memory only */ }
    try { history?.replaceState(null, '', `${loc.pathname}${loc.search}`) } catch { /* not in a browser */ }
    return { id: m[1], secret: m[2] }
  }
  let saved = null
  try { saved = storage?.getItem(KEY) ?? null } catch { /* storage blocked */ }
  const s = saved && /^([A-Za-z0-9_-]{8,64})\.([0-9a-f]{64})$/.exec(saved)
  return s ? { id: s[1], secret: s[2] } : null
}

export async function signedHeaders(session, method, pathAndQuery, body, now = Date.now()) {
  if (!session) return {}
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  const digest = await requestDigest(method, pathAndQuery, now, nonce, body)
  const key = await crypto.subtle.importKey('raw', bytes(session.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = hex(await crypto.subtle.sign('HMAC', key, enc.encode(digest)))
  return { 'x-passbook-session': session.id, 'x-passbook-ts': String(now), 'x-passbook-nonce': nonce, 'x-passbook-hmac': mac }
}

/** POST with a signed body. `body` undefined sends no body (the digest covers the empty string). */
export async function signedPost(session, path, body, fetchImpl = globalThis.fetch) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const headers = { ...(raw ? { 'content-type': 'application/json' } : {}), ...(await signedHeaders(session, 'POST', path, raw)) }
  return fetchImpl(path, { method: 'POST', headers, ...(raw ? { body: raw } : {}) })
}
