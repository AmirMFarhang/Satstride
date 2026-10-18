// The phone's platform client over Nostr (src/agent/platform-nostr.ts) against the real
// platform: createApp in enforce mode behind the Nostr bridge (src/server/nostr-api.ts),
// joined by an in-memory relay. Signing is the phone's: the party key signs the HTTP
// request digest from the body hash, exactly as PartySigner.signRequest does.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeChain } from '../../../src/chain/fake.ts'
import { keyPairFromLabel, randomHex, sha256Hex, signHash, signObject, type Hex, type KeyPair } from '../../../src/core/crypto.ts'
import { termInterest } from '../../../src/core/economics.ts'
import { collateralFor, MICRO_PER_USDT } from '../../../src/core/money.ts'
import { termsHash, type LoanTerms } from '../../../src/core/terms.ts'
import { keyPairSigner, type NegotiationTransport, type NostrEvent, type NostrFilter } from '../../../src/market/negotiate-nostr.ts'
import { Store } from '../../../src/registry/store.ts'
import type { RepaymentWatcher } from '../../../src/rgb/watch.ts'
import { createApp, type App } from '../../../src/server/app.ts'
import { MemoryFeeWallet } from '../../../src/server/fees.ts'
import { NostrApi } from '../../../src/server/nostr-api.ts'
import { MAX_MESSAGE_CHARS, PLATFORM_NOSTR_KIND } from '../../../src/server/nostr-api-wire.ts'
import { NostrPlatformCall, readPlatformInfo, type PlatformNostrSigner } from '../src/agent/platform-nostr.ts'

const U = MICRO_PER_USDT
const platformKey = keyPairFromLabel('phone-nostr-platform')
const lender = keyPairFromLabel('phone-nostr-lender')
const borrower = keyPairFromLabel('phone-nostr-borrower')

class MemoryRelay implements NegotiationTransport {
  readonly events: NostrEvent[] = []
  private readonly subs = new Set<{ filter: NostrFilter & { '#d'?: string[] }; onEvent: (e: NostrEvent) => void }>()
  drop?: (e: NostrEvent) => boolean
  async publish(event: NostrEvent): Promise<void> {
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
  return (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (f.since === undefined || e.created_at >= f.since) && tag('p', f['#p']) && tag('d', f['#d'])
}

/** The worklet's party key, as far as this client uses it: NIP-44, Nostr events and the request signature over the body hash. */
function phoneSigner(key: KeyPair): PlatformNostrSigner {
  return { ...keyPairSigner(key), signRequest: async (r) => signHash(sha256Hex(['passbook-request-v1', r.method.toUpperCase(), r.pathAndQuery, String(r.timestampMs), r.nonce, r.bodySha256].join('\n')), key.secretKey) }
}

describe('the phone reaches the platform over Nostr only', () => {
  const relay = new MemoryRelay()
  const chain = new FakeChain(100)
  const watcher: RepaymentWatcher = { issue: () => ({ invoice: 'rgb:invoice', recipient_id: 'recipient-1', backup: '', password: '' }), inspect: () => null, close: () => undefined }
  let app: App, bridge: NostrApi
  before(() => {
    app = createApp({ platformKey, store: new Store(), chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth: { mode: 'enforce', operators: [platformKey.pubkey], localConsole: false }, repayments: watcher, feeWallet: new MemoryFeeWallet() })
    bridge = new NostrApi({ api: app.api, key: platformKey, transport: relay, relays: ['wss://relay.test'], network: 'mutinynet' })
    bridge.start()
  })
  after(() => { bridge.stop(); return app.close() })
  const phone = (key: KeyPair, over: Partial<ConstructorParameters<typeof NostrPlatformCall>[0]> = {}) => new NostrPlatformCall({ transport: relay, signer: phoneSigner(key), platformPk: platformKey.pubkey, timeoutMs: 1_500, ...over })

  async function newTerms(): Promise<LoanTerms> {
    const height = await chain.getHeight()
    const quote = app.oracle.quote(height)
    const principal = 600 * U, fee = termInterest({ principal, apr_bps: 1200, term_blocks: 30 })
    return {
      v: 1, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platformKey.pubkey, asset_id: 'rgb:phone-nostr-usdt',
      principal, fee, collateral_sats: collateralFor(principal + fee, 5000, quote.price_cents), oracle_quote: quote,
      open_height: height, maturity_height: height + 30, grace_blocks: 5, recovery_height: height + 55, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex(),
    }
  }

  test('call() works like platform.ts: state, the lender registers terms, the borrower reads the loan; errors read the same', async () => {
    const state = await phone(borrower).call<{ platform_pk: Hex; height: number }>('GET', '/state')
    assert.equal(state.platform_pk, platformKey.pubkey)
    const t = await newTerms()
    const registered = await phone(lender).call<{ loan: { id: Hex } }>('POST', '/loans', { terms: t })
    assert.equal(registered.loan.id, termsHash(t))
    const loan = await phone(borrower).call<{ status: string; terms: LoanTerms }>('GET', `/loans/${termsHash(t)}`)
    assert.equal(loan.status, 'pending')
    assert.deepEqual(loan.terms, t)
    // the platform's own refusal, worded like PhonePlatform.call's
    await assert.rejects(phone(borrower).call('POST', '/loans', { terms: await newTerms() }), /^Error: POST \/loans \(403\): request must be signed by/)
  })

  test('times out and retries the same signed request after a lost event, then gives up clearly', async () => {
    let lost = 0
    relay.drop = (e) => e.kind === PLATFORM_NOSTR_KIND.REQUEST && lost++ === 0
    const t0 = Date.now()
    const state = await phone(borrower, { timeoutMs: 150 }).call<{ platform_pk: Hex }>('GET', '/state')
    assert.equal(state.platform_pk, platformKey.pubkey)
    assert.ok(Date.now() - t0 >= 150, 'the first attempt timed out')
    assert.equal(lost, 2, 'the lost attempt and one retry')
    relay.drop = (e) => e.kind === PLATFORM_NOSTR_KIND.REQUEST
    await assert.rejects(phone(borrower, { timeoutMs: 60, attempts: 3 }).call('GET', '/state'), /GET \/state: no answer from the platform over Nostr after 3 attempt\(s\) within 180 ms/)
    relay.drop = undefined
  })

  test('a lost answer: the retry carries fresh events, and the platform resends its cached answer without running the request again', async () => {
    let lostAnswers = 0
    relay.drop = (e) => e.kind === PLATFORM_NOSTR_KIND.RESPONSE && lostAnswers++ === 0
    const before = app.store.listEvents(0).length
    const note = { actor_pk: borrower.pubkey, role: 'borrower', title: 'once only', detail: null }
    const signed = { ...note, sig: signObject(note, borrower.secretKey).sig }
    assert.deepEqual(await phone(borrower, { timeoutMs: 120 }).call('POST', '/wire', signed), { ok: true })
    assert.equal(lostAnswers, 2, 'the first answer was lost, the resent one arrived')
    assert.equal(app.store.listEvents(0).length, before + 1, 'the note was posted once')
    const requests = relay.events.filter((e) => e.kind === PLATFORM_NOSTR_KIND.REQUEST && e.tags.some((t) => t[0] === 'q'))
    assert.equal(new Set(requests.map((e) => e.id)).size, requests.length, 'every attempt is a new event')
    relay.drop = undefined
  })

  test('retries stop inside the signature window while the wait goes on (a slow sandbox check)', async () => {
    let published = 0
    relay.drop = (e) => e.kind === PLATFORM_NOSTR_KIND.REQUEST && ++published > 0
    await assert.rejects(phone(borrower, { timeoutMs: 50, attempts: 10, retryWindowMs: 120, timeoutFor: () => 400 }).call('GET', '/state'), /after 3 attempt\(s\) within 400 ms/)
    assert.equal(published, 3, 'attempts at 0, 50 and 100 ms; none after the 120 ms window')
    relay.drop = undefined
  })

  test('refuses a body over the bridge limit before sending anything', async () => {
    const before = relay.events.length
    await assert.rejects(phone(borrower).call('POST', '/wire', { blob: 'x'.repeat(MAX_MESSAGE_CHARS) }), /over the .* limit of the platform's Nostr bridge/)
    assert.equal(relay.events.length, before)
  })

  test('reads the platform info event by its key, labelled test data for mutinynet', async () => {
    await bridge.publishInfo()
    const info = await readPlatformInfo(relay, platformKey.pubkey, 1_000)
    assert.equal(info.network, 'mutinynet')
    assert.deepEqual(info.relays, ['wss://relay.test'])
    assert.equal(info.test_data, true)
    await assert.rejects(readPlatformInfo(relay, lender.pubkey, 100), /no platform info event/)
  })
})
