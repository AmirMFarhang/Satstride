import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { keyPairFromLabel, randomHex, signObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { termInterest } from '../src/core/economics.js'
import { collateralFor, MICRO_PER_USDT } from '../src/core/money.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { opReturnScript } from '../src/chain/types.js'
import { buildEscrowSpend, escrowFor, partiesOf, releaseOutputs } from '../src/escrow/escrow.js'
import { TOPIC } from '../src/market/kinds.js'
import { decryptFrom, encryptTo, signEvent } from '../src/market/messages.js'
import type { NegotiationTransport, NostrEvent, NostrFilter } from '../src/market/negotiate-nostr.js'
import { Store } from '../src/registry/store.js'
import type { RepaymentWatcher } from '../src/rgb/watch.js'
import { createApp, type App } from '../src/server/app.js'
import { signRequest, type ApiAuthConfig } from '../src/server/auth.js'
import { MemoryFeeWallet } from '../src/server/fees.js'
import { NostrApi, PARTY_ROUTES, servedOverNostr } from '../src/server/nostr-api.js'
import { CHUNK_DATA_CHARS, decodeChunk, encodeChunk, MAX_CHUNKS, MAX_EVENT_BYTES, PLATFORM_NOSTR_KIND, platformInfoProblems, Reassembly, toChunks, type PlatformResponse } from '../src/server/nostr-api-wire.js'

const U = MICRO_PER_USDT
const platformKey = keyPairFromLabel('pnostr-platform')
const operator = keyPairFromLabel('pnostr-operator')
const lender = keyPairFromLabel('pnostr-lender')
const borrower = keyPairFromLabel('pnostr-borrower')
const peer = keyPairFromLabel('pnostr-peer')

/** An in-memory relay: stores every event, replays stored ones to new subscriptions, delivers asynchronously. */
class MemoryRelay implements NegotiationTransport {
  readonly events: NostrEvent[] = []
  private readonly subs = new Set<{ filter: NostrFilter & { '#d'?: string[] }; onEvent: (e: NostrEvent) => void }>()
  /** Lose an event (as a flaky relay does) when this returns true. */
  drop?: (e: NostrEvent) => boolean
  published = 0
  async publish(event: NostrEvent): Promise<void> {
    this.published++
    if (this.drop?.(event)) return
    this.events.push(event)
    for (const s of [...this.subs]) if (matches(s.filter, event)) queueMicrotask(() => s.onEvent(event))
  }
  subscribe(filter: NostrFilter, onEvent: (e: NostrEvent) => void): () => void {
    const sub = { filter, onEvent }
    this.subs.add(sub)
    for (const e of this.events) if (matches(filter, e)) queueMicrotask(() => { if (this.subs.has(sub)) onEvent(e) })
    return () => { this.subs.delete(sub) }
  }
}
function matches(f: NostrFilter & { '#d'?: string[] }, e: NostrEvent): boolean {
  const tag = (name: string, values?: string[]) => !values || e.tags.some((t) => t[0] === name && values.includes(t[1]))
  return (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (f.since === undefined || e.created_at >= f.since) && tag('p', f['#p']) && tag('t', f['#t']) && tag('d', f['#d'])
}

/** A request signed exactly as the phone signs it over HTTP (src/server/auth.ts signRequest). */
async function signedRequest(relay: MemoryRelay, key: KeyPair, method: 'GET' | 'POST', path: string, body?: unknown): Promise<PlatformResponse> {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return rawRequest(relay, key, { method, path, headers: signRequest(key, method, path, raw), body: raw })
}

/** A hand-made request from `author` (headers as given), and its response. */
async function rawRequest(relay: MemoryRelay, author: KeyPair, req: { method: string; path: string; headers: Record<string, string>; body: string }, id: Hex = randomHex(16)): Promise<PlatformResponse> {
  for (const c of toChunks(id, JSON.stringify({ v: 1, ...req }))) await relay.publish(signEvent(author, PLATFORM_NOSTR_KIND.REQUEST, encryptTo(author, platformKey.pubkey, encodeChunk(c)), [['t', TOPIC], ['p', platformKey.pubkey], ['q', id]], Date.now()) as NostrEvent)
  return responseFor(relay, author, id)
}
async function responseFor(relay: MemoryRelay, author: KeyPair, id: Hex, timeoutMs = 2_000): Promise<PlatformResponse> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const r = new Reassembly()
    let whole: string | null = null
    for (const e of relay.events) if (e.kind === PLATFORM_NOSTR_KIND.RESPONSE && e.tags.some((t) => t[0] === 'q' && t[1] === id) && e.tags.some((t) => t[0] === 'p' && t[1] === author.pubkey)) whole = r.add(decodeChunk(decryptFrom(author, platformKey.pubkey, e.content))) ?? whole
    if (whole) return JSON.parse(whole) as PlatformResponse
    if (Date.now() > end) throw new Error('no response')
    await new Promise((res) => setTimeout(res, 5))
  }
}

const watcher: RepaymentWatcher = { issue: () => ({ invoice: 'rgb:invoice', recipient_id: 'recipient-1', backup: '', password: '' }), inspect: () => null, close: () => undefined }

function newApp(auth: ApiAuthConfig, chain = new FakeChain(100)): App {
  return createApp({ platformKey, store: new Store(), chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth, repayments: watcher, feeWallet: new MemoryFeeWallet() })
}

describe('the platform API over Nostr: the server (same handler, party routes only)', () => {
  const relay = new MemoryRelay()
  const chain = new FakeChain(100)
  let app: App, bridge: NostrApi
  before(() => {
    app = newApp({ mode: 'enforce', operators: [platformKey.pubkey, operator.pubkey], localConsole: false }, chain)
    bridge = new NostrApi({ api: app.api, key: platformKey, transport: relay, relays: ['wss://relay.test'], network: 'regtest' })
    bridge.start()
  })
  after(() => { bridge.stop(); return app.close() })

  async function newTerms(b: KeyPair, l: KeyPair): Promise<LoanTerms> {
    const height = await chain.getHeight()
    const quote = app.oracle.quote(height)
    const principal = 600 * U, fee = termInterest({ principal, apr_bps: 1200, term_blocks: 30 })
    return {
      v: 1, borrower_pk: b.pubkey, lender_pk: l.pubkey, platform_pk: platformKey.pubkey, asset_id: 'rgb:pnostr-usdt',
      principal, fee, collateral_sats: collateralFor(principal + fee, 5000, quote.price_cents), oracle_quote: quote,
      open_height: height, maturity_height: height + 30, grace_blocks: 5, recovery_height: height + 55, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex(),
    }
  }

  it('carries a full request and response into the real API: state, a party write, a read back', async () => {
    const state = await signedRequest(relay, borrower, 'GET', '/state')
    assert.equal(state.status, 200)
    assert.equal((state.body as { platform_pk: Hex }).platform_pk, platformKey.pubkey)
    const t = await newTerms(borrower, lender)
    const registered = await signedRequest(relay, lender, 'POST', '/loans', { terms: t })
    assert.equal(registered.status, 200, JSON.stringify(registered.body))
    assert.equal((registered.body as { loan: { id: Hex } }).loan.id, termsHash(t))
    const loan = await signedRequest(relay, borrower, 'GET', `/loans/${termsHash(t)}`)
    assert.equal((loan.body as { status: string }).status, 'pending')
    assert.deepEqual((loan.body as { terms: LoanTerms }).terms, t)
    // what the relay saw: only NIP-44 content between the party and the platform key
    for (const e of relay.events) assert.throws(() => JSON.parse(e.content), `event ${e.kind} content is encrypted`)
  })

  it('refuses an unsigned party write (401), and a request whose signer is not the event author (401)', async () => {
    const t = await newTerms(borrower, lender)
    await app.platform.registerLoan(t)
    const raw = JSON.stringify({ lock_txid: 'aa'.repeat(32) })
    const unsigned = await rawRequest(relay, borrower, { method: 'POST', path: `/loans/${termsHash(t)}/lock`, headers: {}, body: raw })
    assert.equal(unsigned.status, 401)
    assert.match(String((unsigned.body as { error: string }).error), /must be signed by/)
    // the borrower's signed HTTP request, carried by another key's event
    const headers = signRequest(borrower, 'POST', `/loans/${termsHash(t)}/lock`, raw)
    const relayed = await rawRequest(relay, peer, { method: 'POST', path: `/loans/${termsHash(t)}/lock`, headers, body: raw })
    assert.equal(relayed.status, 401)
    assert.match(String((relayed.body as { error: string }).error), /must author the Nostr event/)
  })

  it('refuses the wrong party (403): only the lender named in the terms registers them', async () => {
    const t = await newTerms(borrower, lender)
    for (const wrong of [borrower, peer]) {
      const r = await signedRequest(relay, wrong, 'POST', '/loans', { terms: t })
      assert.equal(r.status, 403)
      assert.match(String((r.body as { error: string }).error), /^request must be signed by/)
    }
  })

  it('refuses a replayed signed request (same nonce under a new request id), and answers a retried request id from its cache', async () => {
    const raw = JSON.stringify(signObject({ actor_pk: borrower.pubkey, role: 'borrower', title: 'hello over nostr', detail: null }, borrower.secretKey))
    const headers = signRequest(borrower, 'POST', '/wire', raw)
    const id = randomHex(16)
    const first = await rawRequest(relay, borrower, { method: 'POST', path: '/wire', headers, body: raw }, id)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const replay = await rawRequest(relay, borrower, { method: 'POST', path: '/wire', headers, body: raw })
    assert.equal(replay.status, 401)
    assert.match(String((replay.body as { error: string }).error), /replayed request/)
    // the same request id again (the phone's retry over another relay): the cached answer, not a replay error
    const before = relay.events.filter((e) => e.kind === PLATFORM_NOSTR_KIND.RESPONSE).length
    const again = await rawRequest(relay, borrower, { method: 'POST', path: '/wire', headers, body: raw }, id)
    assert.equal(again.status, 200)
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(relay.events.filter((e) => e.kind === PLATFORM_NOSTR_KIND.RESPONSE).length > before, 'answered again')
  })

  it('refuses operator, demo, dashboard and stream routes over Nostr, even signed by an operator key', async () => {
    for (const [method, path] of [['POST', '/oracle/set'], ['POST', '/monitor'], ['POST', '/oracle/live'], ['POST', '/orderbook'], ['GET', '/events'], ['GET', '/'], ['GET', '/demo']] as const) {
      const raw = method === 'GET' ? '' : JSON.stringify({ price_cents: 1 })
      const r = await rawRequest(relay, operator, { method, path, headers: signRequest(operator, method, path, raw), body: raw })
      assert.equal(r.status, 403, `${method} ${path}`)
      assert.match(String((r.body as { error: string }).error), /not served over Nostr/)
    }
    assert.equal(app.oracle.currentPrice(), 10_000_000, 'the price never moved')
    assert.ok(PARTY_ROUTES.every((r) => servedOverNostr(r.method, r.path.replace(/:[a-z_]+/g, 'ab12'))))
    assert.equal(servedOverNostr('GET', '/loans/../oracle/set'), false)
  })

  it('refuses a request past the chunk limit cleanly (413)', async () => {
    const id = randomHex(16)
    const chunk = { v: 1 as const, id, part: 0, parts: MAX_CHUNKS + 1, data: 'x' }
    await relay.publish(signEvent(borrower, PLATFORM_NOSTR_KIND.REQUEST, encryptTo(borrower, platformKey.pubkey, encodeChunk(chunk)), [['t', TOPIC], ['p', platformKey.pubkey], ['q', id]], Date.now()) as NostrEvent)
    const r = await responseFor(relay, borrower, id)
    assert.equal(r.status, 413)
    assert.throws(() => toChunks(randomHex(16), 'x'.repeat(600_000)), /limit of the platform's Nostr bridge/)
  })

  it('carries a multi-chunk request and response', async () => {
    const note = signObject({ actor_pk: borrower.pubkey, role: 'borrower', title: 'a long note', detail: 'y'.repeat(70_000) }, borrower.secretKey)
    const r = await signedRequest(relay, borrower, 'POST', '/wire', note)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(relay.events.filter((e) => e.kind === PLATFORM_NOSTR_KIND.REQUEST).length >= 3)
  })

  it('keeps every event under 60 KiB on the wire: a real release PSBT, a locked loan record, a 300 kB note with non-ASCII text', async () => {
    const before = relay.events.length
    const t = await newTerms(borrower, lender)
    assert.equal((await signedRequest(relay, lender, 'POST', '/loans', { terms: t })).status, 200)
    const id = termsHash(t)
    const lockTxid = chain.addTx([{ value: t.collateral_sats, script: escrowFor(partiesOf(t)).script }, { value: 0, script: opReturnScript(id) }], [{ txid: randomHex(), vout: 0 }])
    chain.mine()
    assert.equal((await signedRequest(relay, borrower, 'POST', `/loans/${id}/lock`, { lock_txid: lockTxid })).status, 200)
    const record = await signedRequest(relay, borrower, 'GET', `/loans/${id}`)
    assert.equal((record.body as { lock_txid: Hex }).lock_txid, lockTxid)
    // the borrower's release PSBT for this loan's escrow (leaf A), as the phone sends it to /cosign
    const psbt = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: t.collateral_sats }, parties: partiesOf(t), leaf: 'A', outputs: releaseOutputs(t) }).toBase64()
    const cosign = await signedRequest(relay, borrower, 'POST', '/cosign', { loan_id: id, purpose: 'release', psbt })
    assert.ok([200, 400, 409, 422].includes(cosign.status), `the PSBT reached the platform's own checks: ${cosign.status} ${JSON.stringify(cosign.body).slice(0, 200)}`)
    // a long note with accents and emoji (each non-ASCII code unit travels as \uXXXX): several full chunks
    const detail = `café ✓ 💸 «test USDT» `.repeat(5_000)
    const note = signObject({ actor_pk: borrower.pubkey, role: 'borrower', title: 'grand note', detail }, borrower.secretKey)
    assert.equal((await signedRequest(relay, borrower, 'POST', '/wire', note)).status, 200)
    const events = relay.events.slice(before)
    const sizes = events.map((e) => Buffer.byteLength(JSON.stringify(e)))
    assert.ok(events.filter((e) => e.kind === PLATFORM_NOSTR_KIND.REQUEST).length >= 5)
    assert.equal((app.store.listEvents(0).at(-1) as { detail?: string } | undefined)?.detail, detail, 'the note reached the wire exactly as sent')
    assert.ok(Math.max(...sizes) <= MAX_EVENT_BYTES, `largest event ${Math.max(...sizes)} bytes`)
    // a full chunk is the worst case: measure one exactly
    const [full] = toChunks(randomHex(16), JSON.stringify({ s: 'q"\\'.repeat(CHUNK_DATA_CHARS) }))
    assert.equal(full.data.length, CHUNK_DATA_CHARS)
    const fullEvent = signEvent(borrower, PLATFORM_NOSTR_KIND.REQUEST, encryptTo(borrower, platformKey.pubkey, encodeChunk(full)), [['t', TOPIC], ['p', platformKey.pubkey], ['q', full.id]], Date.now())
    assert.ok(Buffer.byteLength(JSON.stringify(fullEvent)) <= MAX_EVENT_BYTES, `full chunk event ${Buffer.byteLength(JSON.stringify(fullEvent))} bytes`)
  })

  it('answers 503 like HTTP while the platform API is switched off', async () => {
    app.api.setPlatformOnline(false)
    try { assert.equal((await signedRequest(relay, borrower, 'GET', '/state')).status, 503) } finally { app.api.setPlatformOnline(true) }
  })

  it('publishes its info event, labelled as test data for its network; the phone reads and checks it', async () => {
    const event = await bridge.publishInfo()
    assert.equal(event.pubkey, platformKey.pubkey)
    assert.ok(event.tags.some((t) => t[0] === 'network' && t[1] === 'regtest'))
    assert.match(event.tags.find((t) => t[0] === 'alt')![1], /test data: test USDT on regtest, no value/)
    assert.ok(event.tags.some((t) => t[0] === 'expiration'))
    const info = JSON.parse(event.content)
    assert.deepEqual(platformInfoProblems(info), [])
    assert.equal(info.platform_pk, platformKey.pubkey)
    assert.deepEqual(info.relays, ['wss://relay.test'])
    assert.equal(info.routes.length, PARTY_ROUTES.length)
    assert.throws(() => new NostrApi({ api: app.api, key: platformKey, transport: relay, relays: ['wss://x'], network: 'mainnet' }), /test network/)
  })
})

describe('the Nostr bridge under a flood of partial requests', () => {
  it('caps each sender\'s incomplete requests; others still get single- and multi-chunk requests through', async () => {
    const relay = new MemoryRelay()
    const app = newApp({ mode: 'enforce', operators: [platformKey.pubkey], localConsole: false })
    const bridge = new NostrApi({ api: app.api, key: platformKey, transport: relay, relays: ['wss://relay.test'], network: 'regtest', maxPending: 6, maxPendingPerSender: 4 })
    bridge.start()
    try {
      // two unauthenticated senders each open many two-part requests and never finish them
      const floods = [keyPairFromLabel('pnostr-flood-1'), keyPairFromLabel('pnostr-flood-2')]
      for (const f of floods) for (let i = 0; i < 10; i++) {
        const id = randomHex(16)
        await relay.publish(signEvent(f, PLATFORM_NOSTR_KIND.REQUEST, encryptTo(f, platformKey.pubkey, encodeChunk({ v: 1, id, part: 0, parts: 2, data: '{' })), [['t', TOPIC], ['p', platformKey.pubkey], ['q', id]], Date.now()) as NostrEvent)
      }
      await new Promise((r) => setTimeout(r, 30))
      for (const f of floods) assert.ok(bridge.pendingCount(f.pubkey) <= 4, 'four waiting requests per sender at most')
      assert.equal(bridge.pendingCount(), 6, 'the store is full, the oldest made room for newer ones')
      assert.equal(bridge.pendingCount(floods[1].pubkey), 4)
      // a single-chunk request never waits; a multi-chunk one makes room by dropping the oldest waiting request
      assert.equal((await signedRequest(relay, borrower, 'GET', '/state')).status, 200)
      const note = signObject({ actor_pk: borrower.pubkey, role: 'borrower', title: 'long', detail: 'w'.repeat(40_000) }, borrower.secretKey)
      assert.equal((await signedRequest(relay, borrower, 'POST', '/wire', note)).status, 200)
    } finally { bridge.stop(); await app.close() }
  })

  it('splits by bytes: CJK text travels ASCII-escaped, each event under 60 KiB, and arrives exactly', async () => {
    const text = '信用检查 测试数据 '.repeat(4_000)
    const json = JSON.stringify({ v: 1, body: text })
    const chunks = toChunks(randomHex(16), json)
    const r = new Reassembly()
    let whole: string | null = null
    for (const c of chunks) {
      const plaintext = encodeChunk(c)
      assert.ok(Buffer.byteLength(plaintext) <= CHUNK_DATA_CHARS + 200, 'ASCII: bytes equal characters')
      const event = signEvent(borrower, PLATFORM_NOSTR_KIND.REQUEST, encryptTo(borrower, platformKey.pubkey, plaintext), [['t', TOPIC], ['p', platformKey.pubkey], ['q', c.id]], Date.now())
      assert.ok(Buffer.byteLength(JSON.stringify(event)) <= MAX_EVENT_BYTES)
      whole = r.add(decodeChunk(decryptFrom(platformKey, borrower.pubkey, event.content))) ?? whole
    }
    assert.equal(JSON.parse(whole!).body, text)
  })
})

describe('the Nostr bridge never reaches the development loopback console', () => {
  it('an unsigned write is refused over Nostr even where the loopback console is on', async () => {
    const relay = new MemoryRelay()
    const app = newApp({ mode: 'enforce', operators: [platformKey.pubkey], localConsole: true })
    const bridge = new NostrApi({ api: app.api, key: platformKey, transport: relay, relays: ['wss://relay.test'], network: 'regtest' })
    bridge.start()
    try {
      const r = await rawRequest(relay, peer, { method: 'POST', path: '/wire', headers: {}, body: JSON.stringify({ title: 'unsigned' }) })
      assert.equal(r.status, 401, JSON.stringify(r.body))
    } finally { bridge.stop(); await app.close() }
  })
})
