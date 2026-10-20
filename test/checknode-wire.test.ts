// Check messages under the public relays' size limit (src/checknode/wire.ts):
// large messages travel as hash-checked chunks, each a signed NIP-44 event
// under 60 KiB; small ones are unchanged. The largest real messages are the
// borrower's sealed bundle at the offer's maximum and the operator's sealed
// result carrying a synthetic opaque result; no provider-specific evidence format.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { relayEvents } from '../src/checknode/borrower-check.js'
import { chunkedBus, MemoryBus, MemoryHub, type CheckBus } from '../src/checknode/bus.js'
import { forwardKey, type PaidCheckResult } from '../src/checknode/client.js'
import { appendCheckMessage, type CheckMessage } from '../src/checknode/messages.js'
import { freshKey, seal, type CheckPlaintext } from '../src/checknode/seal.js'
import { encryptedEventWith, keyPairSigner } from '../src/checknode/signer.js'
import { isWireChunk, packWire, WIRE_CHUNK_CHARS, WireReassembler } from '../src/checknode/wire.js'
import { KIND } from '../src/market/kinds.js'
import type { Event } from 'nostr-tools'

const sender = keyPairFromLabel('wire-sender')
const recipient = keyPairFromLabel('wire-recipient')
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length

/** The largest messages a check sends: a REQUEST-sized bundle ciphertext and a FEEDBACK with a sealed synthetic opaque result. */
function largestMessages() {
  const outcome = { kind: 'external-evidence', descriptor: {}, evidence: { synthetic_wire_vector: randomBytes(12_000).toString('base64') }, outputs: {}, fallback: false } as unknown as CheckPlaintext['outcome']
  const plaintext: CheckPlaintext = { v: 1, kind: 'passbook-check-plaintext', negotiation_id: randomHex(32), request_nonce: randomHex(32), consent_hash: randomHex(32), outcome }
  const sealed = seal(plaintext, freshKey())
  // max_bundle_bytes 60,000 encrypted with NIP-44 (base64): about 80 KB of ciphertext.
  const bundleCiphertext = randomBytes(60_000).toString('base64')
  return {
    request: { v: 1, domain: 'passbook-check-v1', type: 'REQUEST', negotiation_id: randomHex(32), body: { check_request: { ciphertext: bundleCiphertext }, consent: { purpose: 'x'.repeat(200) } } },
    feedback: { v: 1, domain: 'passbook-check-v1', type: 'FEEDBACK', negotiation_id: randomHex(32), body: { status: 'billed', sealed, commitment: { invoice: 'bill-at-close' } } },
    key: { v: 1, domain: 'passbook-check-v1', type: 'KEY', body: { chain: [{ body: { check_request: { ciphertext: bundleCiphertext } } }, { body: { sealed } }], key: randomHex(32) } },
  }
}

describe('check messages under 60 KiB on the wire', () => {
  it('the largest real messages become signed NIP-44 events under 60 KiB each, and reassemble exactly', async () => {
    const signer = keyPairSigner(sender)
    const all = largestMessages()
    // The sealed synthetic opaque result fits in one event; a full-size bundle and the KEY chain carrying it do not.
    assert.ok(bytes(all.feedback) < 60 * 1024, `the synthetic sealed result is ${bytes(all.feedback)} bytes`)
    for (const name of ['request', 'key'] as const) assert.ok(bytes(all[name]) > 64 * 1024, `${name} is larger than the relays accept (${bytes(all[name])} bytes)`)
    for (const [name, msg] of Object.entries(all)) {
      const parts = packWire(msg)
      assert.equal(parts.length > 1, bytes(msg) > WIRE_CHUNK_CHARS, `${name}: chunked exactly when large`)
      const events = await Promise.all(parts.map((p) => encryptedEventWith(signer, KIND.CHECK_KEY, p, recipient.pubkey, [['n', randomHex(32)]])))
      for (const e of events) assert.ok(bytes(e) < 60 * 1024, `${name}: an event of ${bytes(e)} bytes`)
      const r = new WireReassembler()
      let whole: { payload: unknown } | null = null
      for (const p of [...parts].reverse()) whole = r.feed(sender.pubkey, p) ?? whole
      if (parts.length > 1) assert.ok(parts.every(isWireChunk), name)
      assert.deepEqual(whole?.payload, msg, `${name} reassembles exactly, in any order`)
    }
  })

  it('small messages are unchanged', () => {
    const small = { v: 1, type: 'APPROVAL', sig: randomHex(64) }
    assert.deepEqual(packWire(small), [small])
    assert.deepEqual(new WireReassembler().feed(sender.pubkey, small), { payload: small })
  })

  it('refuses a tampered, incomplete or mixed-sender message', () => {
    const msg = { blob: randomBytes(90_000).toString('base64') }
    const parts = packWire(msg) as { data: string }[]
    // A chunk whose data was changed: the joined text no longer hashes to the id.
    const r1 = new WireReassembler()
    const tampered = parts.map((p, i) => (i === 1 ? { ...p, data: p.data.replace(/^./, 'A') === p.data ? p.data.replace(/^./, 'B') : p.data.replace(/^./, 'A') } : p))
    assert.equal(tampered.map((p) => r1.feed(sender.pubkey, p)).find((x) => x), undefined)
    // One chunk missing: nothing is released.
    const r2 = new WireReassembler()
    assert.equal(parts.slice(1).map((p) => r2.feed(sender.pubkey, p)).find((x) => x), undefined)
    // Chunks from another sender never complete this sender's message.
    const r3 = new WireReassembler()
    assert.equal(r3.feed(sender.pubkey, parts[0]), null)
    for (const p of parts.slice(1)) assert.equal(r3.feed(recipient.pubkey, p), null)
    assert.ok(parts.every((p) => (p as unknown as { data: string }).data.length <= WIRE_CHUNK_CHARS))
  })

  it('relayEvents carries extra tags (a public network label) on every event', async () => {
    const tags = [['network', 'mutinynet'], ['alt', 'Passbook test data (mutinynet): not real money']]
    const events = await relayEvents(keyPairSigner(sender), largestMessages().request as never, recipient.pubkey, 'ab'.repeat(32), tags)
    assert.ok(events.length > 1)
    for (const e of events) {
      assert.ok(e.tags.some((t) => t[0] === 'network' && t[1] === 'mutinynet'))
      assert.ok(e.tags.some((t) => t[0] === 'alt'))
      assert.ok(e.tags.some((t) => t[0] === 'n' && t[1] === 'ab'.repeat(32)))
      assert.ok(bytes(e) < 60 * 1024)
    }
  })

  it('a borrower-paid KEY forwarded to the lender crosses a relay that drops events over 60 KiB', async () => {
    // As public relays do: anything over 60 KiB never reaches anyone.
    class CappedHub extends MemoryHub {
      dropped = 0
      override publish(e: Event): void { if (bytes(e) > 60 * 1024) { this.dropped++; return } super.publish(e) }
    }
    const hub = new CappedHub()
    const lender = keyPairFromLabel('wire-lender')
    const neg = randomHex(32)
    // The paid chain carries the sealed bundle at the offer's maximum, so the KEY is far over one event.
    const request = appendCheckMessage([], sender, recipient.pubkey, 'REQUEST', { rail: 'rgb-ln-hodl', check_request: { ciphertext: randomBytes(60_000).toString('base64') } }, neg)
    const paid = { offer: { operator_pk: recipient.pubkey }, chain: [request], key: randomHex(32), key_source: 'hodl-preimage' } as unknown as PaidCheckResult
    const key = await forwardKey(new MemoryBus(hub, sender), sender, lender.pubkey, paid)
    assert.ok(bytes(key) > 64 * 1024)
    assert.equal(hub.dropped, 0, 'every chunk fits')
    assert.ok(hub.events.length > 1)
    // The lender's read (src/agents/lender.ts, infra/check-market-run.ts): chunked, so the whole KEY comes back.
    const got = await chunkedBus(new MemoryBus(hub, lender)).receive<CheckMessage>(KIND.CHECK_KEY, sender.pubkey, { timeoutMs: 5000, match: (m) => m?.negotiation_id === neg })
    assert.deepEqual(got.payload, key)
  })

  it('passes on a bus error that is not a timeout, instead of waiting out the deadline', async () => {
    let calls = 0
    const broken = { key: sender, receive: async () => { calls++; throw new Error('relay closed') } } as unknown as CheckBus
    const started = Date.now()
    await assert.rejects(chunkedBus(broken).receive(KIND.CHECK_KEY, null, { timeoutMs: 30_000 }), /relay closed/)
    assert.equal(calls, 1)
    assert.ok(Date.now() - started < 1000)
  })
})
