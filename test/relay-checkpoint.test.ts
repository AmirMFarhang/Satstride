// Real signatures/NIP-44, fake relay pool. Never connects to a network relay.
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { SimplePool, type Event, type Filter } from 'nostr-tools'
import { Relay, type RelayCheckpoint } from '../src/agents/relay.js'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { KIND } from '../src/market/kinds.js'
import { encryptedJson } from '../src/market/messages.js'

const borrower = keyPairFromLabel('relay-checkpoint-borrower'), lender = keyPairFromLabel('relay-checkpoint-lender')
const urls = ['ws://unit-relay.invalid']
function checkpoint(): RelayCheckpoint {
  return { v: 1, pubkey: lender.pubkey, relays: [...urls], since: Math.floor(Date.now() / 1000) - 120, seen: ['11'.repeat(32)] }
}
function application(n: number): Event {
  return encryptedJson(borrower, KIND.APPLICATION, { request: n }, lender.pubkey, [], Date.now() - 60_000)
}

describe('relay checkpoints (fake pool)', () => {
  it('round trips detached cursors and retains every consumed event ID', () => {
    const relay = new Relay(lender, [...urls]), saved = checkpoint()
    saved.seen = Array.from({ length: 2000 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))
    try {
      relay.restoreCheckpoint(saved)
      assert.deepEqual(relay.exportCheckpoint(), saved)
      assert.equal(relay.since, saved.since)
      saved.relays[0] = 'ws://changed.invalid'; saved.seen.length = 0
      const exported = relay.exportCheckpoint()
      assert.deepEqual(exported.relays, urls); assert.equal(exported.seen.length, 2000)
      exported.seen.length = 0
      assert.equal(relay.exportCheckpoint().seen.length, 2000)
      const older = checkpoint(); older.seen = []
      relay.restoreCheckpoint(older)
      assert.equal(relay.exportCheckpoint().seen.length, 2000, 'restoring an older cursor cannot erase consumed IDs')
      assert.equal('secretKey' in relay.exportCheckpoint(), false)
    } finally { relay.close() }
  })

  it('rejects wrong bindings and unsafe cursors without partially changing state', () => {
    const relay = new Relay(lender, [...urls])
    try {
      relay.restoreCheckpoint(checkpoint())
      const before = relay.exportCheckpoint()
      const attacks: ((saved: RelayCheckpoint) => void)[] = [
        (s) => { s.v = 2 as 1 }, (s) => { s.pubkey = borrower.pubkey },
        (s) => { s.relays = ['ws://other.invalid'] }, (s) => { s.relays = [] },
        (s) => { s.relays = new Array(1) }, (s) => { s.seen = new Array(1) },
        (s) => { s.since = -1 }, (s) => { s.since = NaN }, (s) => { s.since = 1.5 },
        (s) => { s.since = Math.floor(Date.now() / 1000) + 600 },
        (s) => { s.seen = ['invalid'] }, (s) => { s.seen.push(s.seen[0]) },
        (s) => { (s as unknown as Record<string, unknown>).extra = 'unexpected' },
      ]
      for (const attack of attacks) {
        const saved = structuredClone(before); attack(saved)
        assert.throws(() => relay.restoreCheckpoint(saved), /checkpoint/)
        assert.deepEqual(relay.exportCheckpoint(), before)
      }
    } finally { relay.close() }
  })

  it('receives an old unseen signed application after restore while ignoring one already consumed', async () => {
    const old = new Relay(lender, [...urls]), resumed = new Relay(lender, [...urls])
    const consumed = application(1), unseen = application(2)
    let events = [consumed], filters: Filter[] = [], closed = 0
    const subscribe = mock.method(SimplePool.prototype, 'subscribeMany', (_relays: string[], filter: Filter, handlers: { onevent: (event: Event) => void }) => {
      filters.push(structuredClone(filter))
      queueMicrotask(() => { for (const event of events) if (event.created_at >= (filter.since ?? 0)) handlers.onevent(event) })
      return { close() { closed++ } }
    })
    try {
      const start = checkpoint(); start.seen = []
      old.restoreCheckpoint(start)
      assert.equal((await old.receive(KIND.APPLICATION, borrower.pubkey, { timeoutMs: 500 })).event.id, consumed.id)
      const saved = old.exportCheckpoint()
      events = [consumed, unseen]
      await assert.rejects(resumed.receive(KIND.APPLICATION, borrower.pubkey, { timeoutMs: 10 }), /timed out/, 'the fresh five-second window misses both older messages')
      resumed.restoreCheckpoint(saved)
      const received = await resumed.receive<{ request: number }>(KIND.APPLICATION, borrower.pubkey, { timeoutMs: 500 })
      assert.equal(received.event.id, unseen.id); assert.deepEqual(received.payload, { request: 2 })
      assert.equal(filters.at(-1)!.since, saved.since)
      assert.deepEqual(filters.at(-1)!.authors, [borrower.pubkey])
      assert.deepEqual(resumed.exportCheckpoint().seen, [consumed.id, unseen.id])
      assert.equal(closed, 3)
    } finally { subscribe.mock.restore(); old.close(); resumed.close() }
  })
})
