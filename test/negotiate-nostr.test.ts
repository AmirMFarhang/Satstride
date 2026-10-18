import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyEvent } from 'nostr-tools'
import { hashObject, keyPairFromLabel, type Hex, type KeyPair } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { TOPIC } from '../src/market/kinds.js'
import { appendMessage, messageHash, negotiationId, simulate, verifyTranscript, type EngineParams, type NegotiationMessage, type Position } from '../src/market/negotiate.js'
import {
  answerAsk, awaitNegotiation, keyPairSigner, NEG_KIND, negotiateAsBorrower, negotiationTerms, negotiationTermsProblems, poolTransport, readAsk, serveNegotiations, signNostrEvent,
  type LenderNegotiationOptions, type NegotiationResult, type NegotiationTransport, type NostrEvent, type NostrFilter,
} from '../src/market/negotiate-nostr.js'
import { signBorrowerPolicy, signLenderPolicy, type BorrowerPolicy, type LenderPolicy } from '../src/market/policy.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const U = MICRO_PER_USDT
const PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb'] }
// Two key holders: the borrower's key never reaches the lender's code and the other way round.
const borrowerKey = keyPairFromLabel('negnostr-borrower')
const lenderKey = keyPairFromLabel('negnostr-lender')
const mallory = keyPairFromLabel('negnostr-mallory')

async function borrowerPolicy(over: Partial<BorrowerPolicy> = {}, key: KeyPair = borrowerKey): Promise<BorrowerPolicy> {
  return signBorrowerPolicy(new LocalKeySigner(key), { asset_id: 'rgb:usdt', principal: { min: 300 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: 1, ...over })
}
async function lenderPolicy(over: Partial<LenderPolicy> = {}): Promise<LenderPolicy> {
  return signLenderPolicy(new LocalKeySigner(lenderKey), { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: ['investigation', 'inflows'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [lenderKey.pubkey], maker_checker_above: 5_000 * U }, issued_at: 1, ...over })
}

/** An in-memory relay: stores every event, replays stored ones to new subscriptions, delivers asynchronously. */
class MemoryRelay implements NegotiationTransport {
  readonly events: NostrEvent[] = []
  private readonly subs = new Set<{ filter: NostrFilter; onEvent: (e: NostrEvent) => void }>()
  /** Drop (never store or deliver) events for which this returns true. */
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
  get open(): number { return this.subs.size }
}

function matches(f: NostrFilter, e: NostrEvent): boolean {
  const tag = (name: string, values?: string[]) => !values || e.tags.some((t) => t[0] === name && values.includes(t[1]))
  return (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (f.since === undefined || e.created_at >= f.since) && tag('p', f['#p']) && tag('t', f['#t']) && tag('n', f['#n'])
}

const lenderSigner = () => keyPairSigner(lenderKey)
const borrowerSigner = () => keyPairSigner(borrowerKey)

function lenderOptions(relay: NegotiationTransport, lp: LenderPolicy, over: Partial<LenderNegotiationOptions> = {}): LenderNegotiationOptions {
  return { transport: relay, policy: lp, params: PARAMS, signer: () => lenderSigner(), timeoutMs: 2_000, ...over }
}

/** Publish a hand-made negotiation message as `key` (a misbehaving party, or a forger). */
async function rawPublish(relay: NegotiationTransport, key: KeyPair, to: Hex, m: NegotiationMessage, kind: number = NEG_KIND[m.type as 'OFFER']): Promise<NostrEvent> {
  const s = keyPairSigner(key)
  const content = m.type === 'ASK' ? JSON.stringify(m) : await s.nip44Encrypt(to, JSON.stringify(m))
  const event = await signNostrEvent(s, { kind, created_at: Math.floor(Date.now() / 1000), tags: [['t', TOPIC], ['p', to], ['n', m.negotiation_id]], content })
  await relay.publish(event)
  return event
}

/** The borrower's ASK as negotiateAsBorrower publishes it, read back from the relay. */
const askEvent = (relay: MemoryRelay) => relay.events.find((e) => e.kind === NEG_KIND.ASK)!

describe('negotiation over Nostr: two key holders, one relay', () => {
  it('agrees inside both signed policies; both sides hold the same verified transcript, the same as the single-process engine', async () => {
    const relay = new MemoryRelay()
    const bp = await borrowerPolicy(), lp = await lenderPolicy()
    const lenderResults: NegotiationResult[] = []
    const server = serveNegotiations({ ...lenderOptions(relay, lp), onResult: (r) => lenderResults.push(r) })
    const seen: string[] = []
    const b = await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: bp, terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, nonce: 'ab'.repeat(32), timeoutMs: 2_000, onMessage: (m, d) => seen.push(`${d}:${m.type}`) })
    await waitFor(() => lenderResults.length === 1)
    server.close()
    const l = lenderResults[0]
    assert.ok('agreed' in b.outcome, JSON.stringify(b))
    assert.deepEqual(l.outcome, b.outcome)
    assert.deepEqual(l.messages, b.messages, 'one transcript, held by both')
    assert.ok(b.verified.ok && l.verified.ok)
    const agreed = b.outcome.agreed
    assert.ok(agreed.apr_bps >= lp.min_apr_bps && agreed.apr_bps <= bp.max_apr_bps, 'inside both APR bounds')
    assert.ok(agreed.ltv_bps <= bp.max_ltv_bps && agreed.ltv_bps <= lp.max_ltv_bps)
    assert.equal(agreed.principal, 600 * U)
    // the same engine: every move is what simulate() makes with both policies in one process
    const sim = simulate(bp, lp, PARAMS)
    assert.deepEqual(b.messages.map((m) => [m.type, m.body.position ?? m.body.reason]), sim.turns.map((t) => [t.move.type, 'position' in t.move ? t.move.position : t.move.reason]))
    // each message is signed by its own party's key only
    for (const m of b.messages) assert.equal(m.from_pk, m.type === 'ASK' || (b.messages.indexOf(m) % 2 === 0) ? borrowerKey.pubkey : lenderKey.pubkey)
    assert.equal(b.messages[0].body.lender_pk, lenderKey.pubkey)
    assert.equal(b.messages[0].body.lender_policy_hash, hashObject(lp))
    assert.equal(b.messages[1].body.policy_hash, hashObject(lp), 'the OFFER names the signed policy the borrower checks at acceptance')
    assert.equal(seen[0], 'sent:ASK')
    assert.equal(seen.length, b.messages.length)
    // only the ASK is public; the rest is NIP-44 between the two
    for (const e of relay.events) {
      if (e.kind === NEG_KIND.ASK) assert.equal(JSON.parse(e.content).type, 'ASK')
      else assert.throws(() => JSON.parse(e.content))
    }
    assert.equal(relay.open, 0, 'no subscription left open')
  })

  it('a signer with only the CheckSigner members (no signEvent) negotiates the same way', async () => {
    const relay = new MemoryRelay()
    const bp = await borrowerPolicy(), lp = await lenderPolicy()
    const { signEvent: _b, ...bare } = borrowerSigner()
    const { signEvent: _l, ...bareLender } = lenderSigner()
    const results: NegotiationResult[] = []
    const server = serveNegotiations({ ...lenderOptions(relay, lp, { signer: () => bareLender }), onResult: (r) => results.push(r) })
    const b = await negotiateAsBorrower({ transport: relay, signer: bare, policy: bp, terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 2_000 })
    await waitFor(() => results.length === 1)
    server.close()
    assert.ok('agreed' in b.outcome && b.verified.ok && results[0].verified.ok)
    assert.deepEqual(results[0].messages, b.messages)
    for (const e of relay.events) assert.ok(verifyEvent({ ...e }), 'events signed from signHash(event.id) are valid Nostr events')
  })

  it('ends in no deal when the bounds never meet; both transcripts still verify', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const results: NegotiationResult[] = []
    const server = serveNegotiations({ ...lenderOptions(relay, lp), onResult: (r) => results.push(r) })
    const b = await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy({ max_apr_bps: 800 }), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 2_000 })
    await waitFor(() => results.length === 1)
    server.close()
    assert.deepEqual(b.outcome, { no_deal: 'MAX_ROUNDS' })
    assert.deepEqual(results[0].outcome, { no_deal: 'MAX_ROUNDS' })
    assert.ok(b.verified.ok && results[0].verified.ok)
    for (const m of b.messages) if (m.from_pk === borrowerKey.pubkey && m.body.position) assert.ok((m.body.position as Position).apr_bps <= 800, 'the borrower never went past its signed max APR')
    for (const m of b.messages) if (m.from_pk === lenderKey.pubkey && m.body.position) assert.ok((m.body.position as Position).apr_bps >= 1000, 'the lender never went under its signed min APR')
  })

  it('times out when the lender never answers, and sends nothing more', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const t0 = Date.now()
    const b = await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 200 })
    assert.deepEqual(b.outcome, { no_deal: 'TIMEOUT' })
    assert.ok(Date.now() - t0 < 2_000)
    assert.equal(relay.events.length, 1, 'only the ASK')
    assert.equal(relay.open, 0)
  })

  it('ignores an OFFER forged by another key (wrong signer) and an OFFER signed by another key inside the lender\'s event', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const running = negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, nonce: 'cd'.repeat(32), timeoutMs: 400 })
    await waitFor(() => relay.events.length === 1)
    const ask = JSON.parse(askEvent(relay).content) as NegotiationMessage
    const offerBody = { position: { ...(ask.body.position as Position), apr_bps: 1100 }, policy_hash: hashObject(lp) }
    // mallory signs both the message and the event
    await rawPublish(relay, mallory, borrowerKey.pubkey, await appendMessage([ask], new LocalKeySigner(mallory), 'OFFER', offerBody))
    // the lender's event carrying a message mallory signed
    await rawPublish(relay, lenderKey, borrowerKey.pubkey, await appendMessage([ask], new LocalKeySigner(mallory), 'OFFER', offerBody))
    const b = await running
    assert.deepEqual(b.outcome, { no_deal: 'TIMEOUT' }, JSON.stringify(b.problems))
    assert.equal(b.messages.length, 1)
  })

  it('refuses a borrower policy that is not the signer\'s', async () => {
    const relay = new MemoryRelay()
    await assert.rejects(negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy({}, mallory), terms: negotiationTerms(await lenderPolicy(), { max_rounds: 3 }), params: PARAMS }), /not signed by this signer/)
    const bp = await borrowerPolicy()
    await assert.rejects(negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: { ...bp, max_apr_bps: 5000 }, terms: negotiationTerms(await lenderPolicy(), { max_rounds: 3 }), params: PARAMS }), /not signed/)
    assert.equal(relay.events.length, 0)
  })

  it('stops at a lender message that breaks the hash chain (PROTOCOL) and signs nothing after it', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const running = negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 1_000 })
    await waitFor(() => relay.events.length === 1)
    const ask = JSON.parse(askEvent(relay).content) as NegotiationMessage
    const forkedPrev = { ...ask, body: { ...ask.body, nonce: 'ee'.repeat(32) } }
    const broken = await appendMessage([forkedPrev], new LocalKeySigner(lenderKey), 'OFFER', { position: { ...(ask.body.position as Position), apr_bps: 1150 }, policy_hash: hashObject(lp) }, ask.negotiation_id)
    await rawPublish(relay, lenderKey, borrowerKey.pubkey, broken)
    const b = await running
    assert.deepEqual(b.outcome, { no_deal: 'PROTOCOL' })
    assert.ok(b.problems.some((p) => /broken hash chain/.test(p)), b.problems.join('; '))
    assert.equal(relay.events.length, 2, 'nothing sent after the bad message')
  })

  it('never accepts nor matches an over-policy counter: a lender OFFER above the borrower\'s max APR is countered inside the policy', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const bp = await borrowerPolicy()
    const running = negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: bp, terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 300 })
    await waitFor(() => relay.events.length === 1)
    const chain = [JSON.parse(askEvent(relay).content) as NegotiationMessage]
    const greedy = { ...(chain[0].body.position as Position), apr_bps: 1900 }
    await rawPublish(relay, lenderKey, borrowerKey.pubkey, await appendMessage(chain, new LocalKeySigner(lenderKey), 'OFFER', { position: greedy, policy_hash: hashObject(lp) }))
    await waitFor(() => relay.events.length === 3)
    const b = await running // the lender then goes silent
    assert.deepEqual(b.outcome, { no_deal: 'TIMEOUT' })
    const counter = b.messages[2]
    assert.equal(counter.type, 'COUNTER')
    assert.ok((counter.body.position as Position).apr_bps <= bp.max_apr_bps, 'the counter stays inside the signed max APR')
  })

  it('answers a structure change (another principal) with NO_DEAL STRUCTURE', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const running = negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 1_000 })
    await waitFor(() => relay.events.length === 1)
    const chain = [JSON.parse(askEvent(relay).content) as NegotiationMessage]
    await rawPublish(relay, lenderKey, borrowerKey.pubkey, await appendMessage(chain, new LocalKeySigner(lenderKey), 'OFFER', { position: { ...(chain[0].body.position as Position), principal: 300 * U, apr_bps: 1100 }, policy_hash: hashObject(lp) }))
    const b = await running
    assert.deepEqual(b.outcome, { no_deal: 'STRUCTURE' })
    assert.equal(b.messages.at(-1)!.type, 'NO_DEAL')
    assert.ok(b.verified.ok, b.verified.problems.join('; '))
  })

  it('answers each ASK once: a replayed ASK, a stale ASK and an ASK to another lender are ignored', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const results: NegotiationResult[] = []
    const opts = lenderOptions(relay, lp)
    const server = serveNegotiations({ ...opts, onResult: (r) => results.push(r) })
    await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 2_000 })
    await waitFor(() => results.length === 1)
    const count = relay.events.length
    await relay.publish({ ...askEvent(relay) }) // the same event again, as a relay replays it
    await sleep(50)
    assert.equal(results.length, 1, 'the server answered it once')
    server.close()
    // answered once per options object too, and stale or misaddressed ASKs are never answered
    const direct = lenderOptions(relay, lp)
    assert.ok(await answerAsk(direct, askEvent(relay)) !== null)
    assert.equal(await answerAsk(direct, askEvent(relay)), null, 'a replay of an answered ASK')
    assert.deepEqual(readAsk(askEvent(relay), lenderKey.pubkey, { now: () => Date.now() + 10 * 60_000 }), { ignored: 'stale or future ASK' })
    assert.deepEqual(readAsk(askEvent(relay), mallory.pubkey), { ignored: 'addressed to another lender' })
    assert.ok(relay.events.length > count)
  })

  it('ignores a replayed lender message from an earlier negotiation', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const results: NegotiationResult[] = []
    const server = serveNegotiations({ ...lenderOptions(relay, lp), onResult: (r) => results.push(r) })
    const first = await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 2_000 })
    await waitFor(() => results.length === 1)
    server.close()
    const oldOffer = relay.events.find((e) => e.kind === NEG_KIND.OFFER)!
    const running = negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 300 })
    await sleep(20)
    await relay.publish({ ...oldOffer, tags: oldOffer.tags.map((t) => [...t]) })
    const second = await running
    assert.ok('agreed' in first.outcome)
    assert.deepEqual(second.outcome, { no_deal: 'TIMEOUT' }, 'the old OFFER belongs to another negotiation id')
  })

  it('the lender refuses an ASK outside its policy, a wrong round count, an old policy version and a governance refusal', async () => {
    const lp = await lenderPolicy({ max_per_loan: 500 * U, max_outstanding: 5_000 * U })
    const run = async (terms: ReturnType<typeof negotiationTerms>, over: Partial<LenderNegotiationOptions> = {}, bp?: BorrowerPolicy) => {
      const relay = new MemoryRelay()
      const results: NegotiationResult[] = []
      const server = serveNegotiations({ ...lenderOptions(relay, lp, over), onResult: (r) => results.push(r) })
      const b = await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: bp ?? await borrowerPolicy(), terms, params: PARAMS, timeoutMs: 1_000 })
      await waitFor(() => results.length === 1)
      server.close()
      return { b, l: results[0] }
    }
    const current = negotiationTerms(lp, { max_rounds: 3 })
    // stale terms that still advertise 1,000 per loan: the ASK for 600 is outside the signed 500
    let r = await run({ ...current, max_principal: 1_000 * U })
    assert.deepEqual(r.b.outcome, { no_deal: 'PRINCIPAL' })
    assert.deepEqual(r.l.outcome, { no_deal: 'PRINCIPAL' })
    assert.ok(r.b.verified.ok)
    r = await run({ ...current, max_rounds: 4 })
    assert.deepEqual(r.b.outcome, { no_deal: 'PARAMS' })
    r = await run({ ...current, policy_hash: 'ff'.repeat(32) })
    assert.deepEqual(r.b.outcome, { no_deal: 'STALE_TERMS' })
    r = await run(current, { admit: () => 'sanctions-hit' })
    assert.deepEqual(r.b.outcome, { no_deal: 'REFUSED:sanctions-hit' })
    assert.equal(r.b.messages.length, 2, 'ASK, then the signed refusal')
    // a lender that cannot cover the borrower's minimum: no ASK at all
    const none = await negotiateAsBorrower({ transport: new MemoryRelay(), signer: borrowerSigner(), policy: await borrowerPolicy({ principal: { min: 800 * U, max: 900 * U } }), terms: current, params: PARAMS })
    assert.deepEqual(none.outcome, { no_deal: 'PRINCIPAL' })
    assert.equal(none.messages.length, 0)
  })

  it('a lender whose signer is stopped (kill switch) signs nothing', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const results: NegotiationResult[] = []
    const stopped = { ...lenderSigner(), signHash: async () => { throw new Error('agent lender is stopped: the kill switch froze it at this node\'s gate') } }
    const server = serveNegotiations({ ...lenderOptions(relay, lp, { signer: () => stopped }), onResult: (r) => results.push(r) })
    const b = await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 300 })
    await waitFor(() => results.length === 1)
    server.close()
    assert.deepEqual(results[0].outcome, { no_deal: 'SIGNER' })
    assert.match(results[0].problems.join(' '), /kill switch/)
    assert.deepEqual(b.outcome, { no_deal: 'TIMEOUT' })
    assert.equal(relay.events.length, 1)
  })

  it('awaitNegotiation resolves with the first agreement for the lender peer', async () => {
    const relay = new MemoryRelay()
    const lp = await lenderPolicy()
    const waiting = awaitNegotiation({ ...lenderOptions(relay, lp), waitMs: 3_000 })
    const b = await negotiateAsBorrower({ transport: relay, signer: borrowerSigner(), policy: await borrowerPolicy(), terms: negotiationTerms(lp, { max_rounds: 3 }), params: PARAMS, timeoutMs: 2_000 })
    const l = await waiting
    assert.ok('agreed' in l.outcome)
    assert.equal(l.negotiation_id, b.negotiation_id)
    assert.equal(l.negotiation_id, negotiationId(borrowerKey.pubkey, b.messages[0].body.nonce as Hex))
    assert.ok(verifyTranscript(l.messages, { borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, max_rounds: 3 }).ok)
  })

  it('validates the published terms', async () => {
    const t = negotiationTerms(await lenderPolicy(), { max_rounds: 3, min_principal: 100 * U, outstanding: 9_500 * U })
    assert.deepEqual(negotiationTermsProblems(t), [])
    assert.equal(t.max_principal, 500 * U, 'capacity left under max_outstanding')
    assert.deepEqual(negotiationTermsProblems({ ...t, max_rounds: 0 }), ['max_rounds'])
    assert.deepEqual(negotiationTermsProblems({ ...t, accepted_settlements: ['cash'] }), ['accepted_settlements'])
    assert.deepEqual(negotiationTermsProblems(null), ['TERMS_MALFORMED'])
  })
})

describe('transports and browser safety', () => {
  it('poolTransport wraps a SimplePool-shaped pool', async () => {
    const published: NostrEvent[] = []
    let closed = 0
    const pool = {
      publish: (_r: string[], e: NostrEvent) => { published.push(e); return [Promise.reject(new Error('down')), Promise.resolve('ok')] },
      subscribeMany: (_r: string[], _f: NostrFilter, p: { onevent: (e: NostrEvent) => void }) => { queueMicrotask(() => p.onevent(published[0])); return { close: () => { closed++ } } },
    }
    const t = poolTransport(pool, ['ws://127.0.0.1:1'])
    const e = await signNostrEvent(keyPairSigner(borrowerKey), { kind: 1, created_at: 1, tags: [], content: 'x' })
    await t.publish(e)
    const got: NostrEvent[] = []
    const stop = t.subscribe({ kinds: [1] }, (x) => got.push(x))
    await sleep(5)
    stop()
    assert.deepEqual(got, [e])
    assert.equal(closed, 1)
    await assert.rejects(poolTransport({ ...pool, publish: () => [Promise.reject(new Error('down'))] }, ['ws://x']).publish(e), /no relay accepted/)
  })

  it('negotiate-nostr.ts and the engine import no node: module and nothing beyond nostr-tools, @noble and @scure (the phone loads them through Metro)', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const seen = new Set<string>()
    const packages = new Set<string>()
    const walk = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      // Metro on Hermes: a node: import or a top-level import.meta crashes the app at start
      assert.ok(!/import\.meta/.test(src), `${file} uses import.meta`)
      for (const m of src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)'/gm)) {
        if (m[1]) continue
        const spec = m[2]
        assert.ok(!spec.startsWith('node:'), `${file} imports ${spec}`)
        if (spec.startsWith('.')) walk(join(dirname(file), spec.replace(/\.js$/, '.ts')))
        else packages.add(spec)
      }
    }
    walk(join(root, 'src/market/negotiate-nostr.ts'))
    for (const p of packages) assert.ok(/^(nostr-tools|@noble\/|@scure\/)/.test(p), `${p} is not browser-safe here`)
    assert.ok(![...seen].some((f) => /checknode|scorer\/(verify|contract|releases|providers)|sandbox|governance|policy\.ts$|negotiate\.ts$/.test(f)), [...seen].join('\n'))
  })
})

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await sleep(5)
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
void messageHash
