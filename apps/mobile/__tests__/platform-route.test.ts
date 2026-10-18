// The platform over Nostr when the provider's link names its key, the LAN address as the fallback:
// only for a read that got no answer at all (a write may have arrived), and then for the rest of the session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PhonePlatform, type PlatformCarrier } from '../src/agent/platform.ts'
import type { PartySigner } from '../src/agent/ports.ts'
import { parseProviderLink, profileFor } from '../src/core/network.ts'
import { plainError } from '../src/ui/errors.ts'

const PK = 'ab'.repeat(32)
const key = { pubkey: 'cd'.repeat(32), signRequest: async () => 'ee'.repeat(64) } as unknown as PartySigner
const STATE = { platform_pk: PK, oracle_pk: PK, chain: 'mutinynet', height: 1, price_cents: 1 }

function carrier(answer: 'ok' | 'silent' | 'refused') {
  const calls: string[] = []
  const c: PlatformCarrier = {
    call: async <T>(method: string, path: string): Promise<T> => {
      calls.push(`${method} ${path}`)
      if (answer === 'ok') return STATE as T
      if (answer === 'silent') throw new Error(`${method} ${path}: no answer from the platform over Nostr after 3 attempt(s) within 45000 ms`)
      throw new Error(`${method} ${path} (403): refused`)
    },
  }
  return { c, calls }
}
function lan() {
  const hits: string[] = []
  globalThis.fetch = (async (url: string, init?: { method?: string }) => { hits.push(`${init?.method ?? 'GET'} ${url}`); return { ok: true, json: async () => ({ ...STATE, via: 'lan' }) } }) as unknown as typeof fetch
  return hits
}

test('with the platform key the phone asks over Nostr and never touches the LAN', async () => {
  const hits = lan()
  const { c, calls } = carrier('ok')
  const p = new PhonePlatform('http://192.168.1.20:4301', key, c)
  assert.equal((await p.state()).platform_pk, PK)
  assert.deepEqual(calls, ['GET /state'])
  assert.deepEqual(hits, [])
  assert.equal(p.route, 'nostr')
})

test('a read with no answer over Nostr falls back to the LAN, and the session stays there', async () => {
  const hits = lan()
  const { c, calls } = carrier('silent')
  const p = new PhonePlatform('http://192.168.1.20:4301', key, c)
  assert.equal(((await p.state()) as unknown as { via: string }).via, 'lan')
  assert.equal(p.route, 'http')
  await p.recordLock('11'.repeat(32), '22'.repeat(32))
  assert.deepEqual(calls, ['GET /state'], 'Nostr is not asked again')
  assert.deepEqual(hits, ['GET http://192.168.1.20:4301/state', `POST http://192.168.1.20:4301/loans/${'11'.repeat(32)}/lock`])
})

test('a write is never sent a second time over the LAN; a refusal is not a reason to fall back', async () => {
  const hits = lan()
  const silent = new PhonePlatform('http://192.168.1.20:4301', key, carrier('silent').c)
  await assert.rejects(silent.recordLock('11'.repeat(32), '22'.repeat(32)), /no answer from the platform over Nostr/)
  const refused = new PhonePlatform('http://192.168.1.20:4301', key, carrier('refused').c)
  await assert.rejects(refused.state(), /\(403\): refused/)
  assert.deepEqual(hits, [])
  // no LAN address: the Nostr failure stands, in words
  await assert.rejects(new PhonePlatform('', key, carrier('silent').c).state(), (e: Error) => plainError(e.message).kind === 'platform')
  await assert.rejects(new PhonePlatform('', key).state(), (e: Error) => /No service provider is set/.test(plainError(e.message).text))
})

test("the provider's link carries the platform key into the profile; a malformed key is refused", () => {
  const r = parseProviderLink(`passbookwallet://provider?network=mutinynet&platform=http%3A%2F%2F192.168.1.20%3A4301&relays=wss%3A%2F%2Frelay.primal.net&platform_pk=${PK}&proxy=rpcs%3A%2F%2Fproxy.kaleidoswap.com%2Fjson-rpc`)
  assert.ok(!('error' in r))
  assert.equal(r.overrides.platformPk, PK)
  const p = profileFor(r.name, r.overrides)
  assert.equal(p.platformPk, PK)
  assert.equal(p.platform, 'http://192.168.1.20:4301')
  assert.equal(profileFor('mutinynet').platformPk, null)
  assert.equal(profileFor('regtest').platformPk, null)
  assert.match((parseProviderLink('passbookwallet://provider?network=mutinynet&platform_pk=xyz') as { error: string }).error, /64 hex/)
  assert.throws(() => profileFor('mutinynet', { platformPk: 'nothex' }), /64 hex/)
})

test('worklet errors arrive as JSON; the phone shows words, never the JSON', async () => {
  const { setActiveNetwork, REGTEST, MUTINYNET } = await import('../src/core/network.ts')
  const raw = '{"code":"UNKNOWN","message":"RgbLib(InvalidIndexer { details: \\"not a valid electrum nor esplora server\\" })"}'
  setActiveNetwork(REGTEST)
  const r = plainError(raw)
  assert.equal(r.kind, 'chain')
  assert.match(r.text, /switch to Mutinynet in Settings, Network/)
  assert.ok(!r.text.includes('{') && !(r.detail ?? '').includes('{"code"'), 'no JSON on screen')
  setActiveNetwork(MUTINYNET)
  assert.match(plainError(raw).text, /RGB indexer for Mutinynet/)
  assert.match(plainError('no relay accepted event 1234abcd').text, /internet connection/)
  const other = plainError('{"code":"BAD_REQUEST","message":"Amount is more than you have"}')
  assert.deepEqual([other.text, other.detail], ['Amount is more than you have', null])
  setActiveNetwork(REGTEST)
})
