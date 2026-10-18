// The phone borrower receives a large KEY from the lender: on public relays the lender sends it as
// hash-checked chunks (src/checknode/wire.ts), and awaitCheckMessage joins them before reading it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { Event, Filter } from 'nostr-tools'
import { keyPairFromLabel, randomHex } from '../../../src/core/crypto.ts'
import { chunkedBus, MemoryBus, MemoryHub } from '../../../src/checknode/bus.ts'
import { appendCheckMessage, type CheckMessage } from '../../../src/checknode/messages.ts'
import { keyPairSigner } from '../../../src/checknode/signer.ts'
import { KIND } from '../../../src/market/kinds.ts'
import { awaitCheckMessage } from '../src/app/credit-check.ts'

const lender = keyPairFromLabel('phone-wire-lender')
const borrower = keyPairFromLabel('phone-wire-borrower')

/** The phone's relay connection over an in-memory relay that drops every event over 60 KiB, as public relays do. */
function cappedTransport(hub: MemoryHub) {
  const fits = (e: Event) => new TextEncoder().encode(JSON.stringify(e)).length <= 60 * 1024
  const matches = (e: Event, f: Filter) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1])))
  return {
    publish: async (e: Event) => { if (fits(e)) hub.publish(e) },
    subscribe: (f: Filter, on: (e: Event) => void) => {
      for (const e of [...hub.events]) if (fits(e) && matches(e, f)) on(e)
      return hub.subscribe((e) => { if (fits(e) && matches(e, f)) on(e) })
    },
  }
}

test('a KEY larger than a relay event reaches the phone borrower in chunks, whole and lender-signed', async () => {
  const hub = new MemoryHub()
  const negotiationId = randomHex(32)
  const sinceS = Math.floor(Date.now() / 1000) - 5
  // A KEY chain carrying a full-size sealed bundle: well over what one public-relay event can hold.
  const key = appendCheckMessage([], lender, borrower.pubkey, 'KEY', { chain: [{ body: { check_request: { ciphertext: randomBytes(60_000).toString('base64') } } }], key: randomHex(32) }, negotiationId)
  assert.ok(JSON.stringify(key).length > 64 * 1024)
  const waiting = awaitCheckMessage<CheckMessage>(cappedTransport(hub), keyPairSigner(borrower), { from: lender.pubkey, negotiationId, type: 'KEY', sinceS, timeoutMs: 5_000 })
  await chunkedBus(new MemoryBus(hub, lender)).send(KIND.CHECK_KEY, key, borrower.pubkey, [['n', negotiationId]])
  assert.ok(hub.events.length > 1, 'sent as several events')
  assert.deepEqual(await waiting, key)
})
