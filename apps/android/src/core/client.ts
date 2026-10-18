// The phone's only connection: the borrower's Passbook node, over the signed
// API. Every request, reads included, is signed with the device key, so a
// revoked or expired key is refused at once and the app goes back to pairing.
// The phone computes nothing: every figure it shows came from the node.

import { signedHeaders, type DeviceKeyPair } from './signing.js'
import type { PairingLink } from './pairing.js'
import type { NetworkProfile } from './network.js'

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>

/** What the phone keeps in secure storage after pairing. */
export interface Paired {
  node: string
  key: DeviceKeyPair
  device_id: string
  scope: 'borrower'
  borrower_pk: string
  expires_at: number
}

export interface DeviceRecord {
  id: string
  pubkey: string
  scope: 'borrower'
  borrower_pk: string
  label: string
  paired_at: number
  expires_at: number
  revoked_at?: number
  state: 'active' | 'revoked' | 'expired'
}

/** The node refused this device key (revoked, expired, unknown): pair again. */
export class Unpaired extends Error {
  constructor(message: string) { super(message); this.name = 'Unpaired' }
}

export class NodeError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'NodeError' }
}

/** The bodies the dashboard's phone posts (web/app.js confirmStop and approve); the shared fixture pins them. */
export const stopRequests = {
  confirm: (stop: 'accept' | 'repay', accept: boolean, loanId: string) => ({ stop, accept, loan_id: loanId }),
  share: (txids: string[]) => ({ txids }),
}

export class NodeClient {
  constructor(readonly node: string, readonly key: DeviceKeyPair, private readonly fetchImpl: Fetch, private readonly now: () => number = Date.now) {}

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const headers = { ...(raw ? { 'content-type': 'application/json' } : {}), ...signedHeaders(this.key, method, path, raw, this.now()) }
    let res: Awaited<ReturnType<Fetch>>
    try {
      res = await this.fetchImpl(this.node + path, { method, headers, ...(raw ? { body: raw } : {}) })
    } catch {
      throw new NodeError(0, 'Can’t reach your Passbook node. Is the phone plugged in with adb reverse running?')
    }
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if ((res.status === 401 || res.status === 403) && typeof out.error === 'string' && /device key (revoked|expired)|a paired device/.test(out.error)) throw new Unpaired(out.error)
    if (res.status >= 400) throw new NodeError(res.status, typeof out.error === 'string' ? out.error : `node answered ${res.status}`)
    return out as T
  }

  me(): Promise<DeviceRecord> { return this.call('GET', '/devices/me') }
  demo(): Promise<Record<string, unknown>> { return this.call('GET', '/demo') }
  state(): Promise<Record<string, unknown>> { return this.call('GET', '/state') }
  local(): Promise<{ state: Record<string, unknown>; passbook: Record<string, unknown> }> { return this.call('GET', '/demo/local') }
  passbook(pk: string): Promise<Record<string, unknown>> { return this.call('GET', `/passbook/${pk}`) }
  wallet(): Promise<Record<string, unknown>> { return this.call('GET', '/demo/wallet') }
  orderbook(): Promise<{ offers: Record<string, unknown>[] }> { return this.call('GET', '/orderbook') }
  /** The node's network profile, when it runs the wallet panel's routes (work/addon4-wallet). */
  network(): Promise<{ network: NetworkProfile }> { return this.call('GET', '/wallet/api/network') }

  /** Stop 2 (accept the term sheet) or stop 3 (pay): the borrower's agent on the node signs the approval bound to this hash. */
  confirm(stop: 'accept' | 'repay', accept: boolean, loanId: string): Promise<{ ok: boolean }> {
    return this.call('POST', '/demo/confirm', stopRequests.confirm(stop, accept, loanId))
  }

  /** Stop 1: the inflows the lender may see. */
  share(txids: string[]): Promise<{ ok: boolean }> { return this.call('POST', '/demo/approve', stopRequests.share(txids)) }
}

/** Claims the one-time code with a brand-new key (signed by that key) and returns what the phone stores. */
export async function pair(link: PairingLink, key: DeviceKeyPair, label: string, fetchImpl: Fetch, now: () => number = Date.now): Promise<Paired> {
  const client = new NodeClient(link.node, key, fetchImpl, now)
  const d = await client.call<DeviceRecord>('POST', '/devices/claim', { code: link.code, device_pk: key.pubkey, label })
  if (d.pubkey !== key.pubkey || d.scope !== 'borrower' || typeof d.borrower_pk !== 'string' || !d.borrower_pk.startsWith(link.borrower_pk)) throw new Error('The node paired a different key or borrower. Not saved.')
  // The node must accept the new key before the phone keeps it.
  const me = await client.me()
  if (me.state !== 'active' || me.expires_at <= now()) throw new Unpaired('device key is not active')
  return { node: link.node, key, device_id: d.id, scope: d.scope, borrower_pk: d.borrower_pk, expires_at: d.expires_at }
}

export interface Snapshot {
  at: number
  demo: Record<string, unknown> | null
  state: Record<string, unknown> | null
  passbook: Record<string, unknown> | null
  wallet: Record<string, unknown> | null
  offers: Record<string, unknown>[]
  /** null when the node has no network profile route; the badge then comes from `state` */
  network: NetworkProfile | null
  platform_online: boolean
}

/** One poll: the same reads the dashboard makes, with the same fallback when the platform API is off. */
export async function snapshot(c: NodeClient, borrowerPk: string, now: () => number = Date.now): Promise<Snapshot> {
  // a restarted node has forgotten this key: reads would still pass as public, so ask first
  const me = await c.me()
  if (me.state !== 'active') throw new Unpaired(`device key ${me.state}`)
  const demo = await c.demo().catch((e) => { if (e instanceof Unpaired) throw e; return null })
  let state: Record<string, unknown> | null = null
  let passbook: Record<string, unknown> | null = null
  let online = true
  try {
    state = await c.state()
  } catch (e) {
    if (e instanceof Unpaired) throw e
    if (e instanceof NodeError && e.status === 503) {
      online = false
      const local = await c.local()
      state = local.state
      passbook = local.passbook
    } else throw e
  }
  const pk = typeof demo?.borrower_pk === 'string' ? demo.borrower_pk : borrowerPk
  if (online) passbook = await c.passbook(pk)
  const wallet = demo ? await c.wallet().catch((e) => { if (e instanceof Unpaired) throw e; return null }) : null
  const offers = online ? (await c.orderbook().catch((e) => { if (e instanceof Unpaired) throw e; return { offers: [] } })).offers ?? [] : []
  const network = (await c.network().catch((e) => { if (e instanceof Unpaired) throw e; return null }))?.network ?? null
  return { at: now(), demo, state, passbook, wallet, offers, network, platform_online: online }
}
