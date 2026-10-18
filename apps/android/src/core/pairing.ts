// The dashboard's pairing QR: passbook://pair?v=1&node=…&code=…&scope=…&borrower=…&exp=…&ttl=…
// (src/server/devices.ts pairingLink). It grants nothing by itself: the phone
// makes its own key and claims the one-time code with it, before `exp`.

export interface PairingLink {
  node: string
  code: string
  scope: 'borrower'
  /** the borrower's key, or (as the dashboard's QR carries it) its first 16 hex digits */
  borrower_pk: string
  /** the code's expiry, ms */
  code_expires_at: number
  /** the device key's lifetime once claimed, ms */
  key_ttl_ms: number
}

// exactly the hosts plugins/with-loopback-cleartext.js lets the app reach over plain HTTP
const LOOPBACK = new Set(['127.0.0.1', 'localhost'])

/** Plain HTTP only to this laptop over `adb reverse`; anything else must be HTTPS. */
export function nodeOrigin(node: string): string {
  const m = /^(https?):\/\/(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(node)
  if (!m) throw new Error('The pairing code has no valid node address.')
  const [, scheme, host, port] = m
  if (scheme === 'http' && !LOOPBACK.has(host.toLowerCase())) throw new Error('This node is not on this phone’s USB link (adb reverse) and not HTTPS.')
  return `${scheme}://${host.toLowerCase()}${port ? `:${port}` : ''}`
}

/** Parses a scanned or pasted link; throws a sentence for the screen when it isn't a usable pairing code. */
export function parsePairingLink(text: string, now = Date.now()): PairingLink {
  const s = text.trim()
  const q = s.indexOf('?')
  if (!s.startsWith('passbook://pair') || q < 0) throw new Error('That is not a Passbook pairing code.')
  const p = new Map<string, string>()
  for (const part of s.slice(q + 1).split('&')) {
    const i = part.indexOf('=')
    if (i > 0) p.set(decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' ')))
  }
  if (p.get('v') !== '1') throw new Error('This pairing code is from another version of Passbook.')
  const node = nodeOrigin(p.get('node') ?? '')
  const code = p.get('code') ?? ''
  if (!/^[0-9a-f]{32}$/.test(code)) throw new Error('The pairing code is damaged. Show a new one on the dashboard.')
  if (p.get('scope') !== 'borrower') throw new Error('This phone can only pair as the borrower.')
  const borrower_pk = p.get('borrower') ?? ''
  if (!/^[0-9a-f]{16,64}$/.test(borrower_pk)) throw new Error('The pairing code names no borrower.')
  const code_expires_at = Number(p.get('exp'))
  const key_ttl_ms = Number(p.get('ttl'))
  if (!Number.isSafeInteger(code_expires_at) || !Number.isSafeInteger(key_ttl_ms) || key_ttl_ms <= 0) throw new Error('The pairing code is damaged. Show a new one on the dashboard.')
  if (code_expires_at <= now) throw new Error('This pairing code has expired. Show a new one on the dashboard.')
  return { node, code, scope: 'borrower', borrower_pk, code_expires_at, key_ttl_ms }
}
