// src/agents/relay.ts on public relays: with PASSBOOK_PUBLIC_NETWORK unset nothing changes; set, every event this
// key signs is labelled test data (at creation, or re-signed with the same author), nothing unlabelled leaves this
// machine, the rate limit holds, Passbook's own signed payloads are untouched, and an unreachable relay cannot crash it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { getEventHash, verifyEvent, type Event } from 'nostr-tools'
import { isLabelled, isLocalRelay, publicLabelsFromEnv, Relay, testLabel, type PublicLabels } from '../src/agents/relay.js'
import { keyPairFromLabel, verifyObject } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { KIND, TOPIC } from '../src/market/kinds.js'
import { publicJson, readJson } from '../src/market/messages.js'
import { DEFAULT_TOLERANCE, type EngineParams } from '../src/market/negotiate.js'
import { awaitNegotiation, keyPairSigner, negotiateAsBorrower, negotiationTerms, poolTransport, type NostrEvent, type NostrFilter, type PoolLike } from '../src/market/negotiate-nostr.js'
import { verifyTranscript } from '../src/market/negotiate-engine.js'
import { signBorrowerPolicy, signLenderPolicy } from '../src/market/policy.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const LOCAL = 'ws://127.0.0.1:7997'
const PUBLIC = 'wss://relay.test'
const LABELS: PublicLabels = { network: 'regtest', offerTtlSec: 3600, perMinute: 30 }

/** An in-memory relay set that records which relays each event was sent to. */
function memoryPool(refuse: string[] = []): PoolLike & { sent: { relays: string[]; event: NostrEvent }[] } {
  const sent: { relays: string[]; event: NostrEvent }[] = []
  const subs = new Set<{ f: NostrFilter; on: (e: NostrEvent) => void }>()
  const match = (e: NostrEvent, f: NostrFilter) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f.since || e.created_at >= f.since)
    && (['#p', '#t', '#n'] as const).every((k) => !f[k] || e.tags.some((t) => t[0] === k.slice(1) && f[k]!.includes(t[1])))
  return {
    sent,
    publish: (relays, e) => {
      const ok = relays.filter((r) => !refuse.includes(r))
      if (ok.length) { sent.push({ relays: ok, event: e }); for (const s of [...subs]) if (match(e, s.f)) setImmediate(() => s.on(e)) }
      return relays.map((r) => (refuse.includes(r) ? Promise.reject(new Error('blocked: test refusal')) : Promise.resolve('ok')))
    },
    subscribeMany: (_r, f, p) => { const s = { f, on: p.onevent }; subs.add(s); for (const x of sent) if (match(x.event, f)) setImmediate(() => s.on(x.event)); return { close: () => { subs.delete(s) } } },
  }
}

function relayOn(pool: PoolLike, key = keyPairFromLabel('relay-test-lender'), relays = [LOCAL, PUBLIC], labels: PublicLabels | null = LABELS): Relay {
  const r = new Relay(key, relays, labels)
  ;(r as unknown as { pool: PoolLike }).pool = pool
  return r
}

describe('PASSBOOK_PUBLIC_NETWORK', () => {
  it('is off when unset, names a test network, never mainnet', () => {
    assert.equal(publicLabelsFromEnv({}), null)
    assert.deepEqual(publicLabelsFromEnv({ PASSBOOK_PUBLIC_NETWORK: 'regtest' }), { network: 'regtest', offerTtlSec: 21600, perMinute: 60 })
    assert.throws(() => publicLabelsFromEnv({ PASSBOOK_PUBLIC_NETWORK: 'mainnet' }), /test network/)
    assert.throws(() => publicLabelsFromEnv({ PASSBOOK_PUBLIC_NETWORK: 'regtest', PASSBOOK_PUBLIC_PER_MINUTE: '0' }), /positive/)
    assert.ok(isLocalRelay(LOCAL) && isLocalRelay('ws://localhost:7777') && !isLocalRelay(PUBLIC))
  })
})

describe('Relay with the labels off (env unset)', () => {
  it('builds and sends exactly the events it did before, to every relay', async () => {
    const pool = memoryPool()
    const key = keyPairFromLabel('relay-test-lender')
    const r = relayOn(pool, key, [LOCAL, PUBLIC], null)
    const payload = { asset_id: 'rgb:x', min: 1, max: 2 }
    const e = await r.publishPublic(KIND.OFFER, payload, [['d', 'o1']])
    const expected = publicJson(key, KIND.OFFER, payload, [['d', 'o1']], e.created_at * 1000)
    assert.equal(e.id, expected.id, 'same id: same tags, content, kind and time')
    assert.deepEqual(e.tags, [['t', TOPIC], ['d', 'o1']])
    const pre = publicJson(key, KIND.NEG_ASK, { x: 1 }, [])
    assert.equal(await r.publish(pre), pre, 'a pre-signed event is sent as it is')
    assert.ok(pool.sent.every((s) => s.relays.length === 2), 'to every configured relay, as before')
  })
})

describe('Relay with the labels on', () => {
  it('labels at creation: network, alt, and a NIP-40 expiration on addressable kinds', async () => {
    const pool = memoryPool()
    const r = relayOn(pool)
    const offer = await r.publishPublic(KIND.OFFER, { a: 1 }, [['d', 'o1']])
    assert.ok(verifyEvent(offer) && isLabelled(offer, 'regtest'))
    assert.equal(offer.tags.find((t) => t[0] === 'alt')?.[1], testLabel('regtest'))
    assert.equal(offer.tags.find((t) => t[0] === 'expiration')?.[1], String(offer.created_at + 3600))
    const to = keyPairFromLabel('relay-test-borrower')
    const msg = await r.send(KIND.CHECK_KEY, { secret: 'k' }, to.pubkey, [['n', 'neg']])
    assert.ok(isLabelled(msg, 'regtest'))
    assert.ok(!msg.tags.some((t) => t[0] === 'expiration'), 'regular kinds get no expiration')
    assert.deepEqual(readJson(msg, to), { secret: 'k' }, 'the NIP-44 payload is unchanged')
    assert.deepEqual(pool.sent.map((s) => s.relays), [[PUBLIC], [LOCAL], [PUBLIC], [LOCAL]], 'the public relay first, then the local one')
  })

  it('re-signs an unlabelled event of its own key with the same author, kind, time and content', async () => {
    const pool = memoryPool()
    const key = keyPairFromLabel('relay-test-lender')
    const r = relayOn(pool, key)
    const pre = publicJson(key, KIND.CHECK_OFFER, { signed: 'offer' }, [['d', 'svc'], ['expiration', '1900000000']])
    const out = await r.publish(pre)
    assert.notEqual(out.id, pre.id)
    assert.equal(out.pubkey, pre.pubkey)
    assert.equal(out.content, pre.content)
    assert.equal(out.created_at, pre.created_at)
    assert.ok(verifyEvent(out) && isLabelled(out, 'regtest'))
    assert.equal(out.tags.filter((t) => t[0] === 'expiration').length, 1, 'an existing expiration is kept, not doubled')
    assert.ok(pool.sent.every((x) => x.event.id === out.id), 'every relay gets the one labelled event')
    assert.equal(await r.publish(out), out, 'already labelled: unchanged')
  })

  it('never sends an unlabelled event off this machine', async () => {
    const pool = memoryPool()
    const r = relayOn(pool)
    const foreign = publicJson(keyPairFromLabel('someone-else'), KIND.NEG_ASK, { x: 1 }, [])
    assert.equal(await r.publish(foreign), foreign, 'another author\'s event is not re-signed')
    assert.deepEqual(pool.sent[0].relays, [LOCAL], 'local relay only')
    const publicOnly = relayOn(memoryPool(), keyPairFromLabel('relay-test-lender'), [PUBLIC])
    await assert.rejects(publicOnly.publish(foreign), /not labelled/)
  })

  it('refuses past perMinute labelled events a minute, sending nothing', async () => {
    const pool = memoryPool()
    const r = relayOn(pool, undefined, [LOCAL, PUBLIC], { ...LABELS, perMinute: 2 })
    for (let i = 0; i < 2; i++) await r.publishPublic(KIND.NEG_ASK, { i })
    await assert.rejects(r.publishPublic(KIND.NEG_ASK, { i: 3 }), /limit \(2 events a minute\)/)
    assert.equal(pool.sent.length, 4, 'two events, each to the public then the local relay; the third went nowhere')
  })

  it('counts a labelled event as published only when a public relay acknowledged it, and then nowhere else', async () => {
    const pool = memoryPool([PUBLIC])
    const r = relayOn(pool)
    await assert.rejects(r.publishPublic(KIND.NEG_ASK, { x: 1 }), /no public relay accepted .*not sent to the local relay either/)
    assert.equal(pool.sent.length, 0, 'the local relay did not get it: both sides see the same messages')
    const two = memoryPool(['wss://relay-b.test'])
    const r2 = relayOn(two, undefined, [LOCAL, PUBLIC, 'wss://relay-b.test'])
    await r2.publishPublic(KIND.NEG_ASK, { x: 2 })
    assert.deepEqual(two.sent.map((s) => s.relays), [[PUBLIC], [LOCAL]], 'one public acknowledgement is enough')
  })
})

describe('Passbook\'s signed payloads through labelled Relays', () => {
  const lender = keyPairFromLabel('relay-test-lender')
  const borrower = keyPairFromLabel('relay-test-borrower')
  const asset = 'rgb:relay-test'
  const params: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: ['cosign-rgb'] }

  it('a negotiation signed by plain keyPairSigners still verifies end to end when both Relays label its events', async () => {
    const pool = memoryPool()
    const lr = relayOn(pool, lender)
    const br = relayOn(pool, borrower)
    const now = Math.floor(Date.now() / 1000)
    const policy = await signLenderPolicy(new LocalKeySigner(lender), { asset_id: asset, max_per_loan: 20 * MICRO_PER_USDT, max_outstanding: 40 * MICRO_PER_USDT, min_apr_bps: 900, max_ltv_bps: 5000, term_blocks: { min: 60, max: 60 }, required_checks: ['inflows'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [lender.pubkey], maker_checker_above: 20 * MICRO_PER_USDT }, issued_at: now })
    const bp = await signBorrowerPolicy(new LocalKeySigner(borrower), { asset_id: asset, principal: { min: 2 * MICRO_PER_USDT, max: 2 * MICRO_PER_USDT }, max_apr_bps: 1500, max_ltv_bps: 5500, term_blocks: { min: 60, max: 60 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: now })
    const lenderSide = awaitNegotiation({ transport: poolTransport(pool, lr.relays, (e) => lr.publish(e as Event)), policy, params, signer: () => keyPairSigner(lender), waitMs: 10_000, timeoutMs: 5_000 })
    const deal = await negotiateAsBorrower({ transport: poolTransport(pool, br.relays, (e) => br.publish(e as Event)), signer: keyPairSigner(borrower), policy: bp, terms: negotiationTerms(policy, { max_rounds: 3 }), params, timeoutMs: 5_000 })
    const l = await lenderSide
    assert.ok('agreed' in deal.outcome && 'agreed' in l.outcome, JSON.stringify(deal.outcome))
    assert.ok(deal.verified.ok && l.verified.ok)
    assert.ok(verifyTranscript(deal.messages, { borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, max_rounds: 3 }).ok, 'the signed transcript is unaffected')
    assert.ok(pool.sent.length >= 4)
    const where = new Map<string, string[]>()
    for (const { event, relays } of pool.sent) where.set(event.id, [...(where.get(event.id) ?? []), ...relays])
    for (const [id, relays] of where) assert.deepEqual(relays, [PUBLIC, LOCAL], `event ${id.slice(0, 8)}: the public relay, then the local one, same id`)
    for (const { event, relays } of pool.sent) {
      assert.ok(isLabelled(event, 'regtest'), `kind ${event.kind} labelled`)
      assert.ok(verifyEvent(event as Event))
      assert.equal(relays.length, 1, 'public, then local')
      if (event.kind === KIND.NEG_ASK) assert.ok(verifyObject(JSON.parse(event.content), event.pubkey), 'the message inside is still signed by its author')
    }
  })

  it('a re-signed event keeps its content byte for byte (a signed check offer stays verifiable)', async () => {
    const op = keyPairFromLabel('relay-test-operator')
    const r = relayOn(memoryPool(), op)
    const signedBody = { v: 1, offer: 'x', sig: 'f'.repeat(128) }
    const pre = publicJson(op, KIND.CHECK_OFFER, signedBody, [['d', 'svc']])
    const out = await r.publish(pre)
    assert.equal(out.content, pre.content)
    assert.equal(getEventHash(out), out.id)
  })
})

describe('Relay and an unreachable relay', () => {
  it('does not crash the process (guarded WebSocket inside relay.ts, no preload)', () => {
    const dir = mkdtempSync(join(process.cwd(), 'test', '.relay-guard-'))
    try {
      writeFileSync(join(dir, 'probe.ts'), `import { Relay } from '../../src/agents/relay.js'
import { keyPairFromLabel } from '../../src/core/crypto.js'
const r = new Relay(keyPairFromLabel('unreachable'), ['ws://127.0.0.1:1'], null)
r.receive(7491, null, { timeoutMs: 2000 }).catch(() => { console.log('alive'); process.exit(0) })
setTimeout(() => { console.log('alive'); process.exit(0) }, 4000)
`)
      const r = spawnSync('npx', ['tsx', join(dir, 'probe.ts')], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(r.status, 0, r.stderr.slice(-400))
      assert.match(r.stdout, /alive/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
