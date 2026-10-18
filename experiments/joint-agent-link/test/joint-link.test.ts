// G2b part 2 (local): a joint loan between two agents over their encrypted
// Nostr bus (KIND.JOINT), with proposals larger than one relay event chunked.
// MemoryHub/MemoryBus carry the same signed, NIP-44 encrypted events as a relay.
// The native adapter is still the in-memory fake (not a native proof).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryBus, MemoryHub } from '../src/checknode/bus.js'
import { JointBorrower } from '../src/joint/borrower.js'
import { JointLender } from '../src/joint/lender.js'
import { JointLink } from '../src/joint/link.js'
import { sealJointMessage } from '../src/joint/messages.js'
import { MemoryJointStore } from '../src/joint/ports.js'
import { KIND } from '../src/market/kinds.js'
import { WIRE_CHUNK_CHARS } from '../src/checknode/wire.js'
import { agreementFor, borrowerFunding, borrowerKey, FakeAdapter, FakeArtifacts, FakeBuilder, FakeChain, FakeGate, FakeSigner, lenderKey, strangerKey } from './joint-fakes.js'

function setup() {
  const chain = new FakeChain(), hub = new MemoryHub(), agreement = agreementFor()
  const now = () => 1_800_000_000
  const bGate = new FakeGate('borrower', now), lGate = new FakeGate('lender', now)
  const bA = new FakeAdapter('borrower', 'wallet-b', chain, bGate.key.pubkey, 'receive-b'), lA = new FakeAdapter('lender', 'wallet-l', chain, lGate.key.pubkey, 'receive-l')
  const lBuilder = new FakeBuilder(lA, 'lender'), bBuilder = new FakeBuilder(bA, 'borrower')
  const options = { activation: 'isolated-regtest-acceptance' as const, now }
  const B = new JointBorrower({ key: borrowerKey, agreement, local: { role: 'borrower', wallet_id: 'wallet-b', receive_id: 'receive-b' }, adapter: bA, gate: bGate, signer: new FakeSigner('borrower'), artifacts: new FakeArtifacts(bA), builder: bBuilder, store: new MemoryJointStore(), options })
  const L = new JointLender({ key: lenderKey, agreement, local: { role: 'lender', wallet_id: 'wallet-l', receive_id: 'receive-l' }, adapter: lA, gate: lGate, signer: new FakeSigner('lender'), artifacts: new FakeArtifacts(lA), builder: lBuilder, store: new MemoryJointStore(), options })
  const bBus = new MemoryBus(hub, borrowerKey), lBus = new MemoryBus(hub, lenderKey)
  const bLink = new JointLink(bBus, B, agreement.loan_id, lenderKey.pubkey), lLink = new JointLink(lBus, L, agreement.loan_id, borrowerKey.pubkey)
  return { chain, hub, agreement, B, L, bLink, lLink, lBuilder, bBuilder, bBus }
}

test('joint link: a whole joint loan between two agents over encrypted Nostr events, large proposals chunked', async () => {
  const s = setup()
  // A proof history well past one relay event: the proposal must arrive in several chunks and reassemble.
  s.lBuilder.padding = 3 * WIRE_CHUNK_CHARS
  await s.B.open(); await s.L.open()
  await s.bLink.send(await s.B.offerFunding(borrowerFunding()))
  assert.equal((await s.lLink.step(2000)).replies[0].body.type, 'proposal')
  assert.equal((await s.bLink.step(2000)).replies[0].body.type, 'enforcement')
  assert.equal((await s.lLink.step(2000)).replies[0].body.type, 'signature')
  assert.equal((await s.bLink.step(2000)).replies[0].body.type, 'broadcast')
  assert.deepEqual((await s.lLink.step(2000)).replies, [])
  s.chain.mine()
  await s.B.settleOrigination(); await s.L.settleOrigination()

  const jointEvents = s.hub.events.filter(e => e.kind === KIND.JOINT)
  assert.ok(jointEvents.length > 6, `the large proposal went as several events (${jointEvents.length})`)
  assert.ok(jointEvents.every(e => !e.content.includes('passbook-joint-message')), 'every event is encrypted')
  assert.ok(jointEvents.every(e => e.content.length < 64_000), 'every event fits a public relay')

  await s.bLink.send(await s.B.startRepayment())
  assert.equal((await s.lLink.step(2000)).replies[0].body.type, 'signature')
  assert.equal((await s.bLink.step(2000)).replies[0].body.type, 'broadcast')
  await s.lLink.step(2000)
  s.chain.mine()
  await s.B.settleRepayment(); await s.L.settleRepayment()
  assert.equal((await s.B.evidence()).verification.ok, true)
})

test('joint link: only this loan\'s counterparty reaches the role; other loans and other senders are not taken', async () => {
  const s = setup()
  await s.B.open(); await s.L.open()
  const offer = await s.B.offerFunding(borrowerFunding())
  // Another sender's event on the same kind is never delivered to the lender's link.
  const stranger = new MemoryBus(s.hub, strangerKey)
  await stranger.send(KIND.JOINT, sealJointMessage(strangerKey, s.agreement.loan_id, lenderKey.pubkey, offer.body), lenderKey.pubkey)
  // The borrower's message for another loan is left for that loan's link.
  await s.bBus.send(KIND.JOINT, { ...offer, loan_id: 'ff'.repeat(32) }, lenderKey.pubkey)
  await assert.rejects(s.lLink.step(300), /timed out/)
  assert.equal(s.L.phase, 'agreed')
  await s.bLink.send(offer)
  assert.equal((await s.lLink.step(2000)).replies[0].body.type, 'proposal')
})
