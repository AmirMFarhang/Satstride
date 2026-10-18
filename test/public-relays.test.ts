// Public Nostr relays (lane D4): every event that may leave for a public relay carries the test labels,
// the transport refuses one that does not, the rate limit holds, the check node labels its own events,
// and an unreachable relay cannot crash a process that loads the WebSocket guard.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { isOfferPayload, type OfferPayload } from '../src/market/messages.js'
import { DEFAULT_TOLERANCE, type EngineParams } from '../src/market/negotiate.js'
import { awaitNegotiation, keyPairSigner, negotiateAsBorrower, negotiationTerms, type NostrEvent, type NostrFilter, type PoolLike } from '../src/market/negotiate-nostr.js'
import { signBorrowerPolicy } from '../src/market/policy.js'
import { LocalKeySigner } from '../src/wallet/signer.js'
import { testLabel as relayLabel } from '../src/agents/relay.js'
import { isLabelled, labelledSigner, labelTags, parseRelays, PUBLIC_RELAYS, publicTransport, RateLimit, testLabel, type PublishedEvent } from '../infra/public-nostr.js'
import { probeEvent } from '../infra/public-relay-probe.js'
import { lenderPolicy, offerEvent, pickOffer } from '../infra/public-mutinynet-loan.js'
import { inflowProofOk } from '../infra/public-rules-check.js'
import { hashObject, signHash } from '../src/core/crypto.js'

/** An in-memory relay pool with NIP-01 filter matching, for the negotiation transport. */
function memoryPool(): PoolLike & { events: NostrEvent[] } {
  const events: NostrEvent[] = []
  const subs = new Set<{ f: NostrFilter; on: (e: NostrEvent) => void }>()
  const match = (e: NostrEvent, f: NostrFilter) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f.since || e.created_at >= f.since)
    && (['#p', '#t', '#n'] as const).every((k) => !f[k] || e.tags.some((t) => t[0] === k.slice(1) && f[k]!.includes(t[1])))
  return {
    events,
    publish: (_relays, e) => { events.push(e); for (const s of [...subs]) if (match(e, s.f)) setImmediate(() => s.on(e)); return [Promise.resolve('ok')] },
    subscribeMany: (_relays, f, p) => { const s = { f, on: p.onevent }; subs.add(s); for (const e of events) if (match(e, f)) setImmediate(() => s.on(e)); return { close: () => { subs.delete(s) } } },
  }
}

const ASSET = 'rgb:test-asset-public'
const PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: ['cosign-rgb'] }

describe('public relay labels', () => {
  it('uses the same words as the agents\' Relay and says test USDT, no value', () => {
    assert.equal(testLabel('regtest'), relayLabel('regtest'))
    assert.match(testLabel('mutinynet'), /test USDT on mutinynet, no value/)
    assert.deepEqual(PUBLIC_RELAYS, ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'])
  })

  it('adds the network and alt tags once and recognises them', () => {
    const tags = labelTags([['t', 'passbook']], 'regtest')
    assert.deepEqual(tags.filter((t) => t[0] === 'network'), [['network', 'regtest']])
    assert.equal(labelTags(tags, 'regtest').length, tags.length, 'idempotent')
    assert.ok(isLabelled({ tags }, 'regtest'))
    assert.ok(!isLabelled({ tags }, 'mutinynet'), 'another network is not this label')
    assert.ok(!isLabelled({ tags: [['t', 'passbook'], ['network', 'regtest']] }), 'the alt text is required too')
  })

  it('accepts wss:// relays and a local ws:// relay only', () => {
    assert.deepEqual(parseRelays('wss://nos.lol, ws://127.0.0.1:7997,wss://nos.lol'), ['wss://nos.lol', 'ws://127.0.0.1:7997'])
    assert.throws(() => parseRelays('ws://relay.example.com'), /wss:\/\//)
    assert.throws(() => parseRelays('https://nos.lol'), /wss:\/\//)
    assert.deepEqual(parseRelays(undefined), [])
  })

  it('rate-limits publishing per minute', () => {
    let now = 0
    const r = new RateLimit(2, () => now)
    assert.ok(r.take() && r.take())
    assert.ok(!r.take(), 'the third in the same minute is refused')
    now = 60_001
    assert.ok(r.take(), 'a minute later it opens again')
  })
})

describe('negotiation over the public transport', () => {
  const lender = keyPairFromLabel('public-test-lender')
  const borrower = keyPairFromLabel('public-test-borrower')

  async function negotiate(borrowerSigner: ReturnType<typeof keyPairSigner>) {
    const pool = memoryPool()
    const log: PublishedEvent[] = []
    const transport = publicTransport(pool, ['wss://relay.test'], 'mutinynet', { log })
    const policy = await lenderPolicy(lender, ASSET, Math.floor(Date.now() / 1000))
    const terms = negotiationTerms(policy, { max_rounds: 3, min_principal: 2 * MICRO_PER_USDT })
    const bp = await signBorrowerPolicy(new LocalKeySigner(borrower), { asset_id: ASSET, principal: { min: 2 * MICRO_PER_USDT, max: 2 * MICRO_PER_USDT }, max_apr_bps: 1500, max_ltv_bps: 5000, term_blocks: { min: 60, max: 60 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: Math.floor(Date.now() / 1000) })
    const lenderSide = awaitNegotiation({ transport, policy, params: PARAMS, signer: () => labelledSigner(lender, 'mutinynet'), waitMs: 10_000, timeoutMs: 5_000 }).catch((e: Error) => e)
    const deal = await negotiateAsBorrower({ transport, signer: borrowerSigner, policy: bp, terms, params: PARAMS, timeoutMs: 5_000 })
    return { deal, lenderSide, pool, log }
  }

  it('agrees when both sides label their events, and every published event is labelled', async () => {
    const { deal, lenderSide, pool, log } = await negotiate(labelledSigner(borrower, 'mutinynet'))
    assert.ok('agreed' in deal.outcome, JSON.stringify(deal.outcome))
    assert.ok(deal.verified.ok)
    const l = await lenderSide
    assert.ok(!(l instanceof Error) && 'agreed' in l.outcome)
    assert.ok(pool.events.length >= 2, "at least the ASK and the answer")
    for (const e of pool.events) {
      assert.ok(isLabelled(e, 'mutinynet'), `event kind ${e.kind} carries the labels`)
      assert.ok(verifyEvent(e as Event), 'signed with the labels')
    }
    assert.equal(log.length, pool.events.length)
    assert.ok(log.every((r) => r.accepted_by.length === 1))
  })

  it('refuses to put an unlabelled event on a public relay (the negotiation ends, nothing unlabelled is sent)', async () => {
    const { deal, pool } = await negotiate(keyPairSigner(borrower))
    assert.ok('no_deal' in deal.outcome)
    assert.equal(pool.events.filter((e) => !isLabelled(e)).length, 0)
  })
})

describe('the public Mutinynet offer', () => {
  const lender = keyPairFromLabel('public-test-lender')
  async function payload(): Promise<OfferPayload> {
    const policy = await lenderPolicy(lender, ASSET, 1_760_000_000)
    return { asset_id: ASSET, min: 2 * MICRO_PER_USDT, max: 20 * MICRO_PER_USDT, apr_bps: 1200, term_blocks: 60, grace_blocks: 5, ltv_ladder_bps: [5000], requirements: { affordability: true, inflow_months: 0, inflow_multiple_bps: 900 }, expires_height: 100, negotiation: negotiationTerms(policy, { max_rounds: 3, min_principal: 2 * MICRO_PER_USDT }) }
  }

  it('is labelled, expires (NIP-40), says test USDT in its content and is still a valid offer', async () => {
    const e = offerEvent(lender, await payload(), 1_760_000_000, 3600)
    assert.equal(e.kind, 38388)
    assert.ok(isLabelled(e, 'mutinynet'))
    assert.equal(e.tags.find((t) => t[0] === 'expiration')?.[1], String(1_760_000_000 + 3600))
    const content = JSON.parse(e.content) as OfferPayload & { test_note: string }
    assert.ok(isOfferPayload(content))
    assert.match(content.test_note, /test USDT on mutinynet, no value/)
  })

  it('the borrower picks only the lender\'s newest Mutinynet-labelled offer for the asset', async () => {
    const p = await payload()
    const older = offerEvent(lender, p, 1_760_000_000)
    const newer = offerEvent(lender, p, 1_760_000_100)
    const regtest = finalizeEvent({ kind: 38388, created_at: 1_760_000_200, tags: labelTags([['t', 'passbook'], ['d', 'x']], 'regtest'), content: JSON.stringify(p) }, lender.secretKey)
    const stranger = offerEvent(keyPairFromLabel('stranger'), p, 1_760_000_300)
    const picked = pickOffer([older, newer, regtest, stranger], lender.pubkey, ASSET)
    assert.equal(picked?.event.id, newer.id)
    assert.equal(pickOffer([regtest, stranger], lender.pubkey, ASSET), null)
    assert.equal(pickOffer([newer], lender.pubkey, 'rgb:another-asset'), null)
  })
})

describe('the lender re-verifies a disclosed inflow', () => {
  const payer = keyPairFromLabel('public-test-payer')
  const borrowerPk = keyPairFromLabel('public-test-borrower').pubkey
  const txid = 'ab'.repeat(32)
  const amount = 2 * MICRO_PER_USDT
  const proof = { txid, amount, payer_pk: payer.pubkey, payer_sig: signHash(hashObject({ txid, amount, borrower_pk: borrowerPk }), payer.secretKey) }
  const item = { txid, amount, height: 10, payer_pk: payer.pubkey } as unknown as Parameters<typeof inflowProofOk>[1]
  it('accepts the payer-signed inflow the sandbox committed to', () => {
    assert.ok(inflowProofOk(proof, item, new Set([hashObject(item)]), borrowerPk))
  })
  it('refuses a valid signature by another payer, or over another amount, for the committed txid', () => {
    const other = keyPairFromLabel('public-test-other-payer')
    const otherPayer = { txid, amount, payer_pk: other.pubkey, payer_sig: signHash(hashObject({ txid, amount, borrower_pk: borrowerPk }), other.secretKey) }
    assert.ok(!inflowProofOk(otherPayer, item, new Set([hashObject(item)]), borrowerPk), 'signed, but not by the committed payer')
    const more = amount * 10
    const otherAmount = { txid, amount: more, payer_pk: payer.pubkey, payer_sig: signHash(hashObject({ txid, amount: more, borrower_pk: borrowerPk }), payer.secretKey) }
    assert.ok(!inflowProofOk(otherAmount, item, new Set([hashObject(item)]), borrowerPk), 'signed by the payer, but over another amount than committed')
  })
  it('refuses another amount, another borrower, an uncommitted item or a missing item', () => {
    assert.ok(!inflowProofOk({ ...proof, amount: amount + 1 }, item, new Set([hashObject(item)]), borrowerPk))
    assert.ok(!inflowProofOk(proof, item, new Set([hashObject(item)]), keyPairFromLabel('someone').pubkey))
    assert.ok(!inflowProofOk(proof, item, new Set(), borrowerPk))
    assert.ok(!inflowProofOk(proof, undefined, new Set([hashObject(item)]), borrowerPk))
  })
})

describe('the relay probe event', () => {
  it('is throwaway, labelled, expiring and off the order book topic', () => {
    const e = probeEvent('11'.repeat(32), 7491, 'regtest', 1_760_000_000)
    assert.ok(verifyEvent(e))
    assert.ok(isLabelled(e, 'regtest'))
    assert.equal(e.tags.find((t) => t[0] === 't')?.[1], 'passbook-probe')
    assert.equal(e.tags.find((t) => t[0] === 'expiration')?.[1], String(1_760_000_600))
    assert.ok(!e.content.includes('test USDT'), 'encrypted kinds carry NIP-44 content')
    assert.match(probeEvent('11'.repeat(32), 38388, 'regtest').content, /test USDT/)
  })
})

describe('infra/public-ws-guard.mjs', () => {
  it('keeps a process alive when a relay is unreachable', () => {
    const script = `import { SimplePool } from 'nostr-tools'
const pool = new SimplePool()
pool.subscribeMany(['ws://127.0.0.1:1'], { kinds: [1], limit: 1 }, { onevent() {} })
setTimeout(() => { console.log('alive'); process.exit(0) }, 2500)`
    const dir = mkdtempSync(join(process.cwd(), 'test', '.ws-guard-'))
    try {
      writeFileSync(join(dir, 'probe.mjs'), script)
      const r = spawnSync(process.execPath, ['--import', join(process.cwd(), 'infra/public-ws-guard.mjs'), join(dir, 'probe.mjs')], { encoding: 'utf8', timeout: 20_000 })
      assert.equal(r.status, 0, r.stderr.slice(-400))
      assert.match(r.stdout, /alive/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('infra/service-provider.sh public relays', () => {
  const run = (extra: Record<string, string>, state: string, cmd = 'env') => spawnSync('bash', ['infra/service-provider.sh', cmd], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PASSBOOK_SP_STATE: state, PASSBOOK_SP_PROJECT: 'passbook-sp-publictest-none', ...extra } })

  it('refuses a public relay that is not wss:// (exit 2)', () => {
    const state = mkdtempSync(join(tmpdir(), 'passbook-sp-public-'))
    try {
      const r = run({ PASSBOOK_SP_PUBLIC_RELAYS: 'ws://relay.example.com' }, state)
      assert.equal(r.status, 2)
      assert.match(r.stderr, /not a wss:\/\/ URL/)
    } finally { rmSync(state, { recursive: true, force: true }) }
  })

  it('env prints the public relays from provider.json; the laptop clients keep the local relay', () => {
    const state = mkdtempSync(join(tmpdir(), 'passbook-sp-public-'))
    try {
      writeFileSync(join(state, 'provider.json'), JSON.stringify({ relay_url: 'ws://127.0.0.1:7997', platform_url: 'http://127.0.0.1:4351', public_relays: [...PUBLIC_RELAYS], lenders: [], check_nodes: [], assistant: { pubkey: 'cc'.repeat(32) } }))
      const r = run({ PASSBOOK_SP_PUBLIC_RELAYS: 'default', PASSBOOK_SP_RELAY_PORT: '7997' }, state)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /export PASSBOOK_PUBLIC_RELAYS=wss:\/\/nos\.lol,wss:\/\/relay\.primal\.net,wss:\/\/nostr\.mom/)
      assert.match(r.stdout, /export PASSBOOK_RELAYS=ws:\/\/127\.0\.0\.1:7997\n/, 'the laptop clients\' default (the platform) stays on the local relay')
      assert.match(r.stdout, new RegExp(`export PASSBOOK_ASSISTANT_PK=${'cc'.repeat(32)}`))
    } finally { rmSync(state, { recursive: true, force: true }) }
  })

  it('up refuses to change the public relays under running services (exit 3, before touching Docker)', () => {
    const state = mkdtempSync(join(tmpdir(), 'passbook-sp-public-'))
    const live = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      mkdirSync(join(state, 'pids'), { recursive: true })
      writeFileSync(join(state, 'pids', 'check-node.pid'), String(live.pid))
      writeFileSync(join(state, 'public-relays.active'), '')
      const r = run({ PASSBOOK_SP_PUBLIC_RELAYS: 'default' }, state, 'up')
      assert.equal(r.status, 3, r.stderr)
      assert.match(r.stderr, /running services use PASSBOOK_SP_PUBLIC_RELAYS=''.*stop' first/)
    } finally { live.kill(); rmSync(state, { recursive: true, force: true }) }
  })

  it('provider.json lists the public relays and says what goes there', () => {
    const r = spawnSync('npx', ['tsx', 'infra/service-provider-info.ts'], { encoding: 'utf8', env: { ...process.env, STATE: '/nonexistent', PUBLIC_RELAYS: PUBLIC_RELAYS.join(','), RELAY_PORT: '7997', PLATFORM_PORT: '4351', PROJECT: 'x', LENDERS: 'lender1' } })
    assert.equal(r.status, 0, r.stderr)
    const p = JSON.parse(r.stdout) as { public_relays: string[]; public_relay_note: string; relay_url: string }
    assert.deepEqual(p.public_relays, PUBLIC_RELAYS)
    assert.match(p.public_relay_note, /lender offer \(38388, NIP-40 expiry\) and negotiation/)
    assert.match(p.public_relay_note, /platform stays on relay_url/)
    assert.equal(p.relay_url, 'ws://127.0.0.1:7997')
  })
})

