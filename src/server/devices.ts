// Pairing a phone (apps/android) with this node. The phone is a thin client:
// it shows what the node computed and signs the borrower's own answers with a
// scoped, expiring device key (src/server/auth.ts). It never holds the
// borrower's Passbook key; the borrower's agent on the node still signs the
// term-sheet approval, exactly as it does when the dashboard's phone answers.
//
//   POST /devices/pairing      operator (the dashboard): a one-time code + the QR's pairing link
//   POST /devices/claim        signed by the new device key itself (proof of possession)
//   GET  /devices/me           signed by an active device key: its own record
//   GET  /devices              public: paired devices, no secrets (codes are never listed)
//   POST /devices/:id/revoke   operator: refused at once on its next request

import type { Api } from './api.js'
import { HttpError, str } from './api.js'
import { DEVICE_LIMITS, type DeviceKey, type DeviceRegistry, type PairingOffer } from './auth.js'
import { qrMatrix } from './qr.js'

export const PAIRING_SCHEME = 'passbook://pair'

/**
 * The QR's content; the phone parses it with apps/android/src/core/pairing.ts.
 * Kept short so the QR stays coarse enough for a phone camera on a laptop screen:
 * the node origin goes in as is (an origin has no & or =) and the borrower as a
 * 16-hex prefix, which the phone checks against the key the node pairs it for.
 */
export function pairingLink(node: string, offer: PairingOffer): string {
  return `${PAIRING_SCHEME}?v=1&node=${node}&code=${offer.code}&scope=${offer.scope}&borrower=${offer.borrower_pk.slice(0, 16)}&exp=${offer.expires_at}&ttl=${offer.key_ttl_ms}`
}

/** The phone talks plain HTTP only to this laptop over `adb reverse` (loopback); anything else must be HTTPS. */
export function nodeUrlProblem(node: unknown): string | null {
  if (typeof node !== 'string' || node.length > 200) return 'node must be a URL'
  let u: URL
  try { u = new URL(node) } catch { return 'node must be a URL' }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return 'node must be an origin, like http://127.0.0.1:4170'
  if (u.protocol === 'https:') return null
  // 127.0.0.1 and localhost only: the app's network security config allows cleartext to exactly these
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return null
  return 'node must be https, or http on 127.0.0.1/localhost (adb reverse)'
}

const publicView = (d: DeviceKey, now: number) => ({ id: d.id, pubkey: d.pubkey, scope: d.scope, borrower_pk: d.borrower_pk, label: d.label, paired_at: d.paired_at, expires_at: d.expires_at, ...(d.revoked_at !== undefined ? { revoked_at: d.revoked_at } : {}), state: d.revoked_at !== undefined ? 'revoked' : now >= d.expires_at ? 'expired' : 'active' })

export function mountDeviceRoutes(api: Api, devices: DeviceRegistry, now: () => number = Date.now): void {
  api.on('POST', '/devices/pairing', async ({ body }) => {
    const b = await body()
    const problem = nodeUrlProblem(b.node)
    if (problem) throw new HttpError(400, problem)
    const minutes = b.key_ttl_minutes === undefined ? undefined : Number(b.key_ttl_minutes)
    let offer: PairingOffer
    try {
      offer = devices.offer({ scope: (b.scope ?? 'borrower') as 'borrower', borrower_pk: str(b.borrower_pk, 'borrower_pk'), ...(minutes !== undefined ? { key_ttl_ms: minutes * 60_000 } : {}) }, now())
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    const link = pairingLink(new URL(b.node as string).origin, offer)
    return { link, qr: qrMatrix(link), scope: offer.scope, borrower_pk: offer.borrower_pk, code_expires_at: offer.expires_at, key_ttl_ms: offer.key_ttl_ms, code_ttl_ms: DEVICE_LIMITS.codeTtlMs }
  }, 'operator')

  api.on('POST', '/devices/claim', async ({ body }) => {
    const b = await body()
    let device: DeviceKey
    try {
      device = devices.claim(b.code, b.device_pk, b.label, now())
    } catch (err) {
      throw new HttpError(409, (err as Error).message)
    }
    api.emit({ type: 'device', action: 'paired', id: device.id, label: device.label, scope: device.scope, borrower_pk: device.borrower_pk, expires_at: device.expires_at })
    return publicView(device, now())
  }, { who: 'the device being paired (device_pk)', keys: ({ body }) => [body.device_pk] })

  api.on('GET', '/devices/me', ({ req }) => {
    const pk = req.headers['x-passbook-key']
    const device = devices.get(typeof pk === 'string' ? pk : undefined)
    if (!device) throw new HttpError(401, 'not a paired device')
    return publicView(device, now())
  }, { who: 'a paired device', keys: () => devices.activeKeys(now()) })

  api.on('GET', '/devices', () => ({ devices: devices.list().map((d) => publicView(d, now())) }))

  api.on('POST', '/devices/:id/revoke', ({ params }) => {
    const device = devices.revoke(params.id, now())
    if (!device) throw new HttpError(404, 'unknown device')
    api.emit({ type: 'device', action: 'revoked', id: device.id, label: device.label, scope: device.scope })
    return publicView(device, now())
  }, 'operator')
}
