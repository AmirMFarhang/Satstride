// Device keys for the Android thin client (apps/android): pairing by one-time
// code, scope = the borrower's own stops, revoked or expired refused at once.
// The phone side is the app's own code (apps/android/src/core), run here
// against a live node.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { Store } from '../src/registry/store.js'
import { DemoGate } from '../src/cli/demo-gate.js'
import { createApp, type App } from '../src/server/app.js'
import { authFromEnv, DEVICE_LIMITS, DeviceRegistry, newDashboardSession, signRequest, type DashboardSession } from '../src/server/auth.js'
import { nodeUrlProblem, pairingLink } from '../src/server/devices.js'
import { qrMatrix } from '../src/server/qr.js'
import { signedPost } from '../web/session-auth.js'
import { NodeClient, pair, snapshot, Unpaired, type Fetch, type Paired } from '../apps/android/src/core/client.js'
import { parsePairingLink } from '../apps/android/src/core/pairing.js'
import { newDeviceKey, signedHeaders } from '../apps/android/src/core/signing.js'

/** fetch against this node, for web/session-auth.js signedPost (which takes a path). */
const at = (base: string) => ((input: RequestInfo | URL, init?: RequestInit) => fetch(base + String(input), init)) as typeof fetch

const platformKey = keyPairFromLabel('device-platform')
const borrower = keyPairFromLabel('device-borrower')
const stranger = keyPairFromLabel('device-stranger')

/** The node's clock, moved by the tests. */
let clock = Date.now()
const fetchImpl: Fetch = (url, init) => fetch(url, init)

/** The demo's borrower stops, mounted as src/cli/demo.ts mounts them. */
function mountGate(app: App): DemoGate {
  const gate = new DemoGate(app, 'standard')
  app.api.on('GET', '/demo', () => ({ borrower_pk: borrower.pubkey, step: 7, waiting: gate.waiting, lenders: {} }))
  app.api.on('POST', '/demo/next', async () => ({ ok: gate.answer('next') }))
  app.api.on('POST', '/demo/approve', async ({ body }) => {
    const b = await body()
    return { ok: gate.answer('approve', Array.isArray(b.txids) ? b.txids.filter((t) => typeof t === 'string') : []) }
  })
  app.api.on('POST', '/demo/confirm', async ({ body }) => {
    const b = await body()
    return { ok: gate.answer('confirm', b.accept === true, typeof b.stop === 'string' ? b.stop : '', typeof b.loan_id === 'string' ? b.loan_id : '') }
  })
  app.api.on('POST', '/demo/platform-off', async () => { app.api.setPlatformOnline(false); return { ok: true } })
  app.api.on('GET', '/demo/wallet', () => ({ usdt_settled: 0, btc_free_sats: 0 }))
  // demo.ts announces its borrower when the gate opens; device keys are bound to it
  app.api.emit({ type: 'demo', waiting: null, borrower_pk: borrower.pubkey, scenario: 'standard' })
  return gate
}

async function start(): Promise<{ app: App; base: string; session: DashboardSession; gate: DemoGate }> {
  const session = newDashboardSession()
  const auth = { ...authFromEnv(platformKey.pubkey, {}, [session]), now: () => clock }
  const app = createApp({ platformKey, store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth })
  const gate = mountGate(app)
  const port = await app.api.listen(0, '127.0.0.1')
  return { app, base: `http://127.0.0.1:${port}`, session, gate }
}

/** The dashboard's "Show pairing code": an operator-signed POST from the browser's session. */
async function offer(base: string, session: DashboardSession, extra: Record<string, unknown> = {}) {
  const res = await signedPost(session, '/devices/pairing', { node: base, scope: 'borrower', borrower_pk: borrower.pubkey, ...extra }, at(base))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { link: string } }
}

async function signed(base: string, key: { secret: string; pubkey: string }, method: 'GET' | 'POST', path: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const res = await fetch(base + path, { method, headers: { ...(raw ? { 'content-type': 'application/json' } : {}), ...signedHeaders(key, method, path, raw, clock) }, ...(raw ? { body: raw } : {}) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('device keys: pairing the Android thin client', () => {
  let app: App, base: string, session: DashboardSession, gate: DemoGate
  before(async () => ({ app, base, session, gate } = await start()))
  after(() => app.close())

  it('the QR link round-trips from the node to the phone, and refuses plain HTTP off this laptop', () => {
    const registry = new DeviceRegistry()
    const o = registry.offer({ scope: 'borrower', borrower_pk: borrower.pubkey }, clock)
    const link = pairingLink('http://127.0.0.1:4271', o)
    assert.deepEqual(parsePairingLink(link, clock), { node: 'http://127.0.0.1:4271', code: o.code, scope: 'borrower', borrower_pk: borrower.pubkey.slice(0, 16), code_expires_at: o.expires_at, key_ttl_ms: DEVICE_LIMITS.keyTtlMs })
    assert.ok(link.length < 160, `short enough for a coarse QR: ${link.length} characters`)
    assert.throws(() => parsePairingLink(link, o.expires_at), /expired/)
    assert.throws(() => parsePairingLink(link.replace('http://127.0.0.1', 'http://192.168.1.5'), clock), /adb reverse/)
    assert.equal(parsePairingLink(link.replace('http://127.0.0.1:4271', 'https%3A%2F%2Fnode.example'), clock).node, 'https://node.example', 'an encoded node is read too')
    assert.throws(() => parsePairingLink('https://evil.example/?code=x', clock), /not a Passbook pairing code/)
    assert.equal(nodeUrlProblem('http://10.0.2.2:4271'), 'node must be https, or http on 127.0.0.1/localhost (adb reverse)')
    assert.equal(nodeUrlProblem('http://localhost:4271'), null)
    assert.ok(nodeUrlProblem('http://[::1]:4271'), 'no IPv6 loopback: the app allows cleartext to 127.0.0.1 and localhost only')
    assert.throws(() => parsePairingLink(link.replace('127.0.0.1', '[::1]'), clock), /adb reverse/)
    const qr = qrMatrix(link)
    assert.equal(qr.rows.length, qr.size)
    assert.ok(qr.rows.every((r) => r.length === qr.size && /^[01]+$/.test(r)))
    assert.equal(qr.rows[0].slice(0, 7), '1111111', 'finder pattern top left')
  })

  it('only the operator (the dashboard session) can offer a pairing code', async () => {
    const unsigned = await fetch(`${base}/devices/pairing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: base, borrower_pk: borrower.pubkey }) })
    assert.equal(unsigned.status, 401)
    const raw = JSON.stringify({ node: base, borrower_pk: borrower.pubkey })
    const asStranger = await fetch(`${base}/devices/pairing`, { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(stranger, 'POST', '/devices/pairing', raw, clock) }, body: raw })
    assert.equal(asStranger.status, 403)
    const ok = await offer(base, session)
    assert.equal(ok.status, 200)
    assert.match(ok.body.link, /^passbook:\/\/pair\?v=1&node=/)
    assert.equal((await offer(base, session, { node: 'http://192.168.1.5:4271' })).status, 400)
    assert.equal((await offer(base, session, { key_ttl_minutes: 60 * 25 })).status, 400, 'a device key lives at most 24 hours')
  })

  it('pairs with a valid, unexpired code: the phone makes its key and proves it, once', async () => {
    const link = parsePairingLink((await offer(base, session)).body.link, clock)
    const key = newDeviceKey()
    const paired = await pair(link, key, 'Pixel 9', fetchImpl, () => clock)
    assert.equal(paired.key.pubkey, key.pubkey)
    assert.equal(paired.borrower_pk, borrower.pubkey)
    assert.equal(paired.expires_at, clock + DEVICE_LIMITS.keyTtlMs)
    const me = await new NodeClient(base, key, fetchImpl, () => clock).me()
    assert.equal(me.state, 'active')
    assert.equal(me.label, 'Pixel 9')
    // the code is spent: a second phone with the same QR is refused
    await assert.rejects(pair(link, newDeviceKey(), 'other', fetchImpl, () => clock), /unknown or already used pairing code/)
    const listed = (await (await fetch(`${base}/devices`)).json()) as { devices: Record<string, unknown>[] }
    assert.equal(listed.devices.length, 1)
    assert.ok(!JSON.stringify(listed).includes(link.code), 'pairing codes are never listed')
    assert.ok(app.store.listEvents(0).some((e) => e.type === 'device' && e.action === 'paired' && e.id === paired.device_id))
  })

  it('refuses an expired code, and a claim not signed by the key it pairs', async () => {
    const expired = parsePairingLink((await offer(base, session)).body.link, clock)
    clock += DEVICE_LIMITS.codeTtlMs + 1
    try {
      await assert.rejects(pair(expired, newDeviceKey(), 'late', fetchImpl, () => clock), /expired/)
    } finally {
      clock -= DEVICE_LIMITS.codeTtlMs + 1
    }
    const link = parsePairingLink((await offer(base, session)).body.link, clock)
    const real = newDeviceKey(), thief = newDeviceKey()
    const forged = await signed(base, thief, 'POST', '/devices/claim', { code: link.code, device_pk: real.pubkey, label: 'x' })
    assert.equal(forged.status, 403)
    assert.match(String(forged.body.error), /device being paired/)
  })

  it('a device key may read and answer the borrower’s own stops, nothing else', async () => {
    const link = parsePairingLink((await offer(base, session)).body.link, clock)
    const key = newDeviceKey()
    await pair(link, key, 'scoped', fetchImpl, () => clock)
    assert.equal((await signed(base, key, 'GET', '/state')).status, 200)
    assert.equal((await signed(base, key, 'GET', '/demo')).status, 200)
    for (const [path, body] of [['/oracle/set', { price_cents: 1 }], ['/demo/next', {}], ['/demo/platform-off', {}], ['/monitor', {}], ['/devices/pairing', { node: base, borrower_pk: borrower.pubkey }], ['/loans/' + 'ab'.repeat(32) + '/lock', { lock_txid: 'cd'.repeat(32) }]] as const) {
      const r = await signed(base, key, 'POST', path, body)
      assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.body)}`)
    }
    // a lender's or a checker's approval, or the lender's fee, is never the phone's to answer
    for (const stop of ['lender-approve', 'checker-approve', 'fee']) {
      const waiting = gate.wait<boolean>('confirm', { stop, loan_id: 'ef'.repeat(32) })
      const r = await signed(base, key, 'POST', '/demo/confirm', { stop, accept: true, loan_id: 'ef'.repeat(32) })
      assert.equal(r.status, 403, stop)
      assert.match(String(r.body.error), /device scope borrower does not cover POST \/demo\/confirm/)
      assert.ok(gate.answer('confirm', false, stop, 'ef'.repeat(32)), 'the stop still waits for its owner')
      assert.equal(await waiting, false)
    }
    const accept = gate.wait<boolean>('confirm', { stop: 'accept', loan_id: 'ef'.repeat(32) })
    const ok = await new NodeClient(base, key, fetchImpl, () => clock).confirm('accept', true, 'ef'.repeat(32))
    assert.equal(ok.ok, true)
    assert.equal(await accept, true)
    const share = gate.wait<string[]>('approve', { items: [] })
    assert.equal((await new NodeClient(base, key, fetchImpl, () => clock).share(['aa'.repeat(32)])).ok, true)
    assert.deepEqual(await share, ['aa'.repeat(32)])
  })

  it('refuses an expired device key at once, and the phone goes back to pairing', async () => {
    const link = parsePairingLink((await offer(base, session, { key_ttl_minutes: 1 })).body.link, clock)
    const key = newDeviceKey()
    const paired: Paired = await pair(link, key, 'short-lived', fetchImpl, () => clock)
    const client = new NodeClient(base, key, fetchImpl, () => clock)
    assert.ok((await snapshot(client, paired.borrower_pk, () => clock)).demo)
    clock = paired.expires_at
    try {
      const r = await signed(base, key, 'GET', '/demo')
      assert.equal(r.status, 401)
      assert.match(String(r.body.error), /device key expired/)
      await assert.rejects(snapshot(client, paired.borrower_pk, () => clock), Unpaired)
      await assert.rejects(client.confirm('accept', true, 'ef'.repeat(32)), Unpaired)
    } finally {
      clock = Date.now()
    }
  })

  it('refuses a revoked device key at once, on its very next request', async () => {
    const link = parsePairingLink((await offer(base, session)).body.link, clock)
    const key = newDeviceKey()
    const paired = await pair(link, key, 'to revoke', fetchImpl, () => clock)
    const client = new NodeClient(base, key, fetchImpl, () => clock)
    assert.ok((await snapshot(client, paired.borrower_pk, () => clock)).state)
    const revoked = await signedPost(session, `/devices/${paired.device_id}/revoke`, undefined, at(base))
    assert.equal(revoked.status, 200)
    assert.equal(((await revoked.json()) as { state: string }).state, 'revoked')
    const r = await signed(base, key, 'GET', '/state')
    assert.equal(r.status, 401)
    assert.match(String(r.body.error), /device key revoked/)
    await assert.rejects(snapshot(client, paired.borrower_pk, () => clock), Unpaired)
    await assert.rejects(client.share([]), Unpaired)
    // the revoked key cannot pair itself again with a new code
    const again = parsePairingLink((await offer(base, session)).body.link, clock)
    await assert.rejects(pair(again, key, 'again', fetchImpl, () => clock), Unpaired)
    assert.ok(app.store.listEvents(0).some((e) => e.type === 'device' && e.action === 'revoked' && e.id === paired.device_id))
  })

  it('a phone answers only the stops of the borrower it was paired for', async () => {
    const link = parsePairingLink((await offer(base, session)).body.link, clock)
    const key = newDeviceKey()
    await pair(link, key, 'bound', fetchImpl, () => clock)
    const other = keyPairFromLabel('device-other-borrower')
    assert.equal((await offer(base, session, { borrower_pk: other.pubkey })).status, 400, 'no pairing code for a borrower this node is not running')
    // the node starts another borrower's run (say, the next persona): this phone's writes stop, its reads go on
    app.api.emit({ type: 'demo', waiting: null, borrower_pk: other.pubkey, scenario: 'standard' })
    try {
      const waiting = gate.wait<boolean>('confirm', { stop: 'accept', loan_id: 'ef'.repeat(32) })
      const r = await signed(base, key, 'POST', '/demo/confirm', { stop: 'accept', accept: true, loan_id: 'ef'.repeat(32) })
      assert.equal(r.status, 403)
      assert.match(String(r.body.error), /device is paired for borrower .*this node's borrower is/)
      assert.equal((await signed(base, key, 'POST', '/demo/approve', { txids: [] })).status, 403)
      assert.equal((await signed(base, key, 'GET', '/demo')).status, 200)
      assert.ok(gate.answer('confirm', false, 'accept', 'ef'.repeat(32)))
      assert.equal(await waiting, false)
    } finally {
      app.api.emit({ type: 'demo', waiting: null, borrower_pk: borrower.pubkey, scenario: 'standard' })
    }
  })

  it('a key the node does not know (say, after a restart) is told to pair again', async () => {
    const client = new NodeClient(base, newDeviceKey(), fetchImpl, () => clock)
    await assert.rejects(snapshot(client, borrower.pubkey, () => clock), Unpaired)
  })

  it('keeps pairing reachable with the platform API off, and still checks device keys there', async () => {
    const link = parsePairingLink((await offer(base, session)).body.link, clock)
    const key = newDeviceKey()
    const paired = await pair(link, key, 'offline', fetchImpl, () => clock)
    app.api.setPlatformOnline(false)
    try {
      assert.equal((await signed(base, key, 'GET', '/devices/me')).status, 200)
      assert.equal((await signed(base, key, 'GET', '/state')).status, 503)
      await signedPost(session, `/devices/${paired.device_id}/revoke`, undefined, at(base))
      assert.equal((await signed(base, key, 'GET', '/demo')).status, 401)
    } finally {
      app.api.setPlatformOnline(true)
    }
  })
})
