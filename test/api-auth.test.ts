import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { PlatformClient } from '../src/agents/platform-client.js'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { keyPairFromLabel, randomHex, signObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { termInterest } from '../src/core/economics.js'
import { collateralFor, MICRO_PER_USDT } from '../src/core/money.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { escrowFor, partiesOf, releaseOutputs } from '../src/escrow/escrow.js'
import { KIND } from '../src/market/kinds.js'
import { encryptTo, publicJson } from '../src/market/messages.js'
import { Store } from '../src/registry/store.js'
import type { RepaymentWatcher } from '../src/rgb/watch.js'
import { createApp, type App, type AppConfig } from '../src/server/app.js'
import { authFromEnv, newDashboardSession, parseDashboardSession, RateLimiter, sessionToken, signRequest, type ApiAuthConfig } from '../src/server/auth.js'
import { MemoryFeeWallet } from '../src/server/fees.js'
import { fundingNotice, repaymentAck, repaymentWatchRequest } from '../src/server/platform.js'
import { readSession, signedHeaders, signedPost } from '../web/session-auth.js'

const platformKey = keyPairFromLabel('auth-platform')
const operator = keyPairFromLabel('auth-operator')
const peer = keyPairFromLabel('auth-peer')

async function start(auth: ApiAuthConfig | undefined, extra: Partial<AppConfig> = {}): Promise<{ app: App; base: string }> {
  const app = createApp({ platformKey, store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], ...(auth ? { auth } : {}), ...extra })
  const port = await app.api.listen(0, '127.0.0.1')
  return { app, base: `http://127.0.0.1:${port}` }
}

async function post(base: string, path: string, body: unknown, key?: KeyPair, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body)
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? signRequest(key, 'POST', path, raw) : {}), ...headers }, body: raw })
  return { status: res.status, auth: res.headers.get('x-passbook-auth'), body: (await res.json()) as Record<string, unknown> }
}

describe('API request signing, authentication and rate limits', () => {
  describe('enforce, as seen from another machine (no local console)', () => {
    let app: App, base: string
    before(async () => ({ app, base } = await start({ mode: 'enforce', operators: [platformKey.pubkey, operator.pubkey], localConsole: false, signedLimit: { capacity: 5, perSecond: 0.001 } })))
    after(() => app.close())

    it('keeps reads public', async () => {
      assert.equal((await fetch(`${base}/state`)).status, 200)
    })

    it('requires a signature for writes and an operator key for operator routes', async () => {
      assert.equal((await post(base, '/oracle/set', { price_cents: 9_000_000 })).status, 401)
      assert.equal((await post(base, '/oracle/set', { price_cents: 9_000_000 }, peer)).status, 403)
      const ok = await post(base, '/oracle/set', { price_cents: 9_000_000 }, operator)
      assert.equal(ok.status, 200)
      assert.equal(ok.body.price_cents, 9_000_000)
    })

    it('rejects a tampered body, a replayed nonce and a stale timestamp', async () => {
      const raw = JSON.stringify({ price_cents: 8_000_000 })
      const headers = signRequest(operator, 'POST', '/oracle/set', raw)
      const tampered = await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ price_cents: 1 }) })
      assert.equal(tampered.status, 401)
      const first = await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })
      assert.equal(first.status, 200)
      const replay = await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })
      assert.equal(replay.status, 401)
      assert.match(((await replay.json()) as { error: string }).error, /replayed/)
      const stale = signRequest(operator, 'POST', '/oracle/set', raw, Date.now() - 120_000)
      assert.equal((await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...stale }, body: raw })).status, 401)
    })

    it('rate-limits a signing key with 429 and Retry-After', async () => {
      const statuses: number[] = []
      for (let i = 0; i < 7; i++) statuses.push((await post(base, '/wire', { actor_pk: peer.pubkey, role: 'x', title: 'y', sig: '00'.repeat(64) }, peer)).status)
      assert.ok(statuses.includes(429), statuses.join(','))
      assert.ok(statuses.slice(0, 5).every((s) => s !== 429), 'the bucket allows its capacity first')
    })

    it('signs agent requests through the platform client', async () => {
      const client = new PlatformClient(base).as(operator)
      assert.equal(((await client.state()) as { platform_pk: string }).platform_pk, platformKey.pubkey)
      const unsigned = new PlatformClient(base)
      await assert.rejects((unsigned as unknown as { call: (m: string, p: string, b: unknown) => Promise<unknown> }).call('POST', '/monitor', {}), /401/)
      assert.ok(await (client as unknown as { call: (m: string, p: string, b: unknown) => Promise<unknown> }).call('POST', '/monitor', {}))
    })
  })

  describe('enforce with the local operator console', () => {
    let app: App, base: string
    before(async () => ({ app, base } = await start({ mode: 'enforce', operators: [platformKey.pubkey], localConsole: true })))
    after(() => app.close())
    it('lets the single-laptop dashboard drive operator routes from loopback', async () => {
      assert.equal((await post(base, '/oracle/set', { price_cents: 9_500_000 })).status, 200)
      assert.equal((await post(base, '/oracle/set', { price_cents: 9_500_000 }, peer)).status, 403, 'a signature is still checked when present')
    })
  })

  describe('report (development only)', () => {
    let app: App, base: string
    before(async () => ({ app, base } = await start(authFromEnv(platformKey.pubkey, { PASSBOOK_DEV: '1', PASSBOOK_API_AUTH: 'report' }))))
    after(() => app.close())
    it('never blocks but says what enforce would do', async () => {
      const r = await post(base, '/oracle/set', { price_cents: 9_100_000 })
      assert.equal(r.status, 200)
      assert.equal(r.auth, 'would-reject:401:signed request required')
      const note = signObject({ actor_pk: operator.pubkey, role: 'lender1', title: 'relayed by another key', detail: null }, operator.secretKey)
      const relayed = await post(base, '/wire', note, peer)
      assert.equal(relayed.status, 200)
      assert.equal(relayed.auth, "would-reject:403:request must be signed by the note's actor (actor_pk)")
    })
  })

  it('enforces by default; report, off and the unsigned loopback console need PASSBOOK_DEV=1', () => {
    assert.deepEqual(authFromEnv(platformKey.pubkey, {}), { mode: 'enforce', operators: [platformKey.pubkey], localConsole: false, sessions: [] })
    assert.equal(authFromEnv(platformKey.pubkey, { PASSBOOK_OPERATOR_PKS: operator.pubkey }).operators.length, 2)
    assert.throws(() => authFromEnv(platformKey.pubkey, { PASSBOOK_API_AUTH: 'report' }), /development only/)
    assert.throws(() => authFromEnv(platformKey.pubkey, { PASSBOOK_API_AUTH: 'off' }), /development only/)
    assert.throws(() => authFromEnv(platformKey.pubkey, { PASSBOOK_API_LOCAL_CONSOLE: '1' }), /development only/)
    assert.equal(authFromEnv(platformKey.pubkey, { PASSBOOK_DEV: '1', PASSBOOK_API_AUTH: 'report', PASSBOOK_API_LOCAL_CONSOLE: '1' }).localConsole, true)
    assert.throws(() => authFromEnv(platformKey.pubkey, { PASSBOOK_API_AUTH: 'strict' }), /off, report or enforce/)
    assert.throws(() => authFromEnv(platformKey.pubkey, { PASSBOOK_OPERATOR_PKS: 'nope' }), /x-only keys/)
  })

  describe('the dashboard signs its writes with the operator session from the printed link', () => {
    const session = newDashboardSession()
    let app: App, base: string
    before(async () => ({ app, base } = await start(authFromEnv(platformKey.pubkey, {}, [session]))))
    after(() => app.close())
    const browser = (s = session) => ({ id: s.id, secret: s.secret })
    const post = (path: string, body: unknown, s?: { id: string; secret: string }) => signedPost(s ?? browser(), path, body, ((p: string, init: RequestInit) => fetch(base + p, init)) as typeof fetch)

    it('reads the session from the link fragment, keeps it for the tab and hides it', () => {
      const store = new Map<string, string>(), replaced: string[] = []
      const got = readSession({ hash: `#session=${sessionToken(session)}`, pathname: '/', search: '' }, { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }, { replaceState: (_a, _b, url) => void replaced.push(url) })
      assert.deepEqual(got, browser())
      assert.deepEqual(replaced, ['/'], 'the secret leaves the address bar')
      assert.deepEqual(readSession({ hash: '', pathname: '/', search: '' }, { getItem: (k) => store.get(k) ?? null, setItem: () => undefined }, null), browser(), 'a reload keeps the session for this tab')
      assert.deepEqual(parseDashboardSession(sessionToken(session)), session)
    })

    it('accepts a signed write from the browser module, with and without a body', async () => {
      const r = await post('/oracle/set', { price_cents: 9_200_000 })
      assert.equal(r.status, 200)
      assert.equal(((await r.json()) as { price_cents: number }).price_cents, 9_200_000)
      assert.equal((await post('/monitor', undefined)).status, 200)
    })

    it('refuses an unsigned write, a wrong secret, an expired timestamp and a replay', async () => {
      assert.equal((await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price_cents: 1 }) })).status, 401, 'no local-console exception by default')
      assert.equal((await post('/oracle/set', { price_cents: 1 }, { id: session.id, secret: 'ab'.repeat(32) })).status, 401)
      const raw = JSON.stringify({ price_cents: 9_300_000 })
      const stale = await signedHeaders(browser(), 'POST', '/oracle/set', raw, Date.now() - 120_000)
      const expired = await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...stale }, body: raw })
      assert.equal(expired.status, 401)
      assert.match(((await expired.json()) as { error: string }).error, /outside the window/)
      const fresh = await signedHeaders(browser(), 'POST', '/oracle/set', raw)
      assert.equal((await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...fresh }, body: raw })).status, 200)
      assert.equal((await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json', ...fresh }, body: raw })).status, 401, 'replayed')
    })
  })

  describe('party binding: a party write must be signed by that party', () => {
    const U = MICRO_PER_USDT
    const lender = keyPairFromLabel('auth-lender'), borrower = keyPairFromLabel('auth-borrower')
    const lender2 = keyPairFromLabel('auth-lender-2'), borrower2 = keyPairFromLabel('auth-borrower-2')
    const session = newDashboardSession()
    const chain = new FakeChain(100)
    // the platform's watch-only wallet, as far as these routes need it: one invoice, nothing received yet
    const watcher: RepaymentWatcher = { issue: () => ({ invoice: 'rgb:invoice', recipient_id: 'recipient-1', backup: '', password: '' }), inspect: () => null, close: () => undefined }
    let app: App, base: string
    before(async () => ({ app, base } = await start({ mode: 'enforce', operators: [platformKey.pubkey, operator.pubkey], localConsole: false, sessions: [session] }, { chain, repayments: watcher, feeWallet: new MemoryFeeWallet() })))
    after(() => app.close())

    /** Unsigned: 401. Another valid key: 403. The bound party: 200. */
    async function bound(path: string, body: unknown, party: KeyPair, others: KeyPair[] = [peer]): Promise<Record<string, unknown>> {
      const unsigned = await post(base, path, body)
      assert.equal(unsigned.status, 401, `${path} unsigned`)
      assert.match(String(unsigned.body.error), /must be signed by/)
      for (const other of others) {
        const refused = await post(base, path, body, other)
        assert.equal(refused.status, 403, `${path} signed by another key`)
        assert.match(String(refused.body.error), /^request must be signed by /)
      }
      const ok = await post(base, path, body, party)
      assert.equal(ok.status, 200, `${path}: ${JSON.stringify(ok.body)}`)
      return ok.body
    }

    async function newTerms(b: KeyPair, l: KeyPair): Promise<LoanTerms> {
      const height = await chain.getHeight()
      const quote = app.oracle.quote(height)
      const principal = 600 * U, fee = termInterest({ principal, apr_bps: 1200, term_blocks: 30 })
      return {
        v: 1, borrower_pk: b.pubkey, lender_pk: l.pubkey, platform_pk: platformKey.pubkey, asset_id: 'rgb:auth-usdt',
        principal, fee, collateral_sats: collateralFor(principal + fee, 5000, quote.price_cents), oracle_quote: quote,
        open_height: height, maturity_height: height + 30, grace_blocks: 5, recovery_height: height + 55, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex(),
      }
    }
    const lockTx = (t: LoanTerms) => {
      const txid = chain.addTx([{ value: t.collateral_sats, script: escrowFor(partiesOf(t)).script }, { value: 0, script: opReturnScript(termsHash(t)) }], [{ txid: randomHex(), vout: 0 }])
      chain.mine()
      return txid
    }
    const confirmed = (inputs: { txid: Hex; vout: number }[] = [], outputs = [{ value: 1000, script: '00' }]) => {
      const txid = chain.addTx(outputs, inputs)
      chain.mine()
      return txid
    }

    it('the order book takes an offer only from the lender who signed it', async () => {
      const offer = publicJson(lender, KIND.OFFER, {
        asset_id: 'rgb:auth-usdt', min: 1, max: 10, apr_bps: 1000, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: [5000],
        requirements: { affordability: true, inflow_months: 3, inflow_multiple_bps: 20000 }, expires_height: 9999,
      }, [['d', 'auth-o1']])
      const out = await bound('/orderbook', { event: offer }, lender, [peer, borrower])
      assert.equal(out.lender_pk, lender.pubkey)
    })

    it('the sandbox takes a bundle only from its borrower (sender_pk)', async () => {
      const { sandbox_pk } = (await (await fetch(`${base}/sandbox/pubkey`)).json()) as { sandbox_pk: Hex }
      const bundle = {
        v: 1, borrower_pk: borrower.pubkey, own_pks: [], offer_id: 'auth-o1', loan_request: { principal: 600_000_000, fee: 6_000_000, term_blocks: 30, grace_blocks: 5 },
        lender_requirements: { affordability: false, inflow_months: 0, inflow_multiple_bps: 0 }, balance: 5_000_000_000, history: [], candidate_inflows: [], scheduled_outflows: [],
        collateral: { sats: 1_212_000, oracle_quote: app.oracle.quote(await chain.getHeight()), allowed_ltv_bps: 5000 },
      }
      const result = await bound('/sandbox/submit', { sender_pk: borrower.pubkey, ciphertext: encryptTo(borrower, sandbox_pk, JSON.stringify(bundle)) }, borrower, [peer, lender])
      assert.equal(result.borrower_pk, borrower.pubkey)
    })

    let t: LoanTerms, id: Hex, lockTxid: Hex, repayTxid: Hex
    let t2: LoanTerms, id2: Hex
    it('only the lender named in the terms registers them, not the borrower or anyone else', async () => {
      t = await newTerms(borrower, lender)
      const out = await bound('/loans', { terms: t }, lender, [peer, borrower])
      id = (out.loan as { id: Hex }).id
      assert.equal(id, termsHash(t))
      // a second loan with other parties, for the settlement below
      t2 = await newTerms(borrower2, lender2)
      id2 = (await app.platform.registerLoan(t2)).loan.id
      await app.platform.recordLock(id2, lockTx(t2))
    })

    it('binds every /loans/:id write to that loan\'s borrower or lender', async () => {
      // a party to another loan, an operator key and the dashboard session are not parties to this one
      lockTxid = lockTx(t)
      const lockBody = { lock_txid: lockTxid }
      for (const key of [lender2, operator, platformKey]) assert.equal((await post(base, `/loans/${id}/lock`, lockBody, key)).status, 403)
      const dashboard = await signedPost(session, `/loans/${id}/lock`, lockBody, ((p: string, init: RequestInit) => fetch(base + p, init)) as typeof fetch)
      assert.equal(dashboard.status, 403)
      assert.equal((await post(base, `/loans/${'ab'.repeat(32)}/lock`, lockBody, lender)).status, 403, 'an unknown loan has no parties')
      assert.equal((await bound(`/loans/${id}/lock`, lockBody, borrower, [peer, lender2])).status, 'locked')

      const disb = confirmed()
      assert.equal((await bound(`/loans/${id}/funded`, { disbursement_txid: disb, lender_sig: fundingNotice(lender, id, disb) }, lender)).status, 'open')
      const keys = { account_xpub_vanilla: 'xpub-vanilla', account_xpub_colored: 'xpub-colored', master_fingerprint: 'abcd1234' }
      assert.equal((await bound(`/loans/${id}/repayment-watch`, { ...keys, lender_sig: repaymentWatchRequest(lender, id, keys) }, lender)).invoice, 'rgb:invoice')
      repayTxid = confirmed()
      assert.equal((await bound(`/loans/${id}/repaid`, { repayment_txid: repayTxid, lender_sig: repaymentAck(lender, id, repayTxid) }, lender)).repayment_proof, 'lender_ack')
      assert.equal((await bound(`/loans/${id}/repayment/verify`, { repayment_txid: repayTxid }, borrower)).ok, false, 'nothing received on the watch-only wallet yet')
      assert.ok(Array.isArray((await bound('/cosign', { loan_id: id, purpose: 'release', repayment_txid: repayTxid }, borrower)).checks))
      const release = confirmed([{ txid: lockTxid, vout: 0 }], releaseOutputs(t))
      assert.equal((await bound(`/loans/${id}/release`, { release_txid: release }, borrower)).status, 'repaid')

      const refund = confirmed([{ txid: app.store.getLoan(id2)!.lock_txid!, vout: 0 }])
      assert.equal((await bound(`/loans/${id2}/settle`, { txid: refund, outcome: 'refunded' }, borrower2, [peer, borrower, lender])).status, 'refunded')
    })

    it('binds /cosign to the loan named in the body', async () => {
      assert.equal((await post(base, '/cosign', { loan_id: 'ab'.repeat(32), purpose: 'refund' }, lender)).status, 403, 'an unknown loan has no parties')
      assert.equal((await post(base, '/cosign', { loan_id: id2, purpose: 'refund' }, lender)).status, 403, 'a party to another loan')
    })

    it('verifies a platform fee only for the lender who owes it', async () => {
      assert.equal(app.store.getFee(id)?.status, 'fee_due')
      assert.equal((await bound(`/fees/${id}/verify`, {}, lender, [peer, borrower])).ok, false, 'not paid yet')
      assert.equal((await post(base, `/fees/${id2}/verify`, {}, lender2)).status, 403, 'no fee recorded for a refunded loan, so no one owes it')
    })

    it('puts a wire note on the wire only from its actor', async () => {
      const note = signObject({ actor_pk: lender.pubkey, role: 'lender1', title: 'Offer published', detail: null }, lender.secretKey)
      assert.deepEqual(await bound('/wire', note, lender, [peer, borrower]), { ok: true })
    })
  })

  it('refills a token bucket over time', () => {
    const limiter = new RateLimiter(2, 1)
    assert.ok(limiter.take('k', 0).ok && limiter.take('k', 0).ok)
    assert.equal(limiter.take('k', 0).ok, false)
    assert.ok(limiter.take('k', 1000).ok)
  })

  it('rejects oversized bodies', async () => {
    const { app, base } = await start({ mode: 'off', operators: [], localConsole: true })
    try {
      const res = await fetch(`${base}/oracle/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) })
      assert.equal(res.status, 413)
    } finally {
      await app.close()
    }
  })
})
