// Lightning node proof. The verifier recovers the node key from an LDK/LND
// message signature or from a challenge invoice (BOLT11, description = the
// challenge). Real RGB Lightning Node (d4762ac) output is recorded in
// fixtures/networks/rln-signmessage.json: its /signmessage is message-
// independent and is refused; its challenge invoice verifies.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, randomHex } from '../src/core/crypto.js'
import { challengeText, issueChallenge } from '../src/networks/challenge.js'
import { decodeInvoice } from '../src/networks/bolt11.js'
import type { ControlChallenge } from '../src/networks/types.js'
import { LightningAdapter, lnMessageHash, recoverLnSigner, verifyLnMessage, zbase32Decode, zbase32Encode, type LightningNodeApi } from '../src/networks/lightning.js'
import { testSignLn } from './networks-signer.js'

function fakeNode(): LightningNodeApi & { pubkey: string } {
  const secret = secp256k1.utils.randomSecretKey()
  const pubkey = bytesToHex(secp256k1.getPublicKey(secret, true))
  return {
    pubkey,
    async nodeInfo() { return { pubkey } },
    async signMessage(message: string) { return testSignLn(message, secret, lnMessageHash, zbase32Encode) },
    async descriptionInvoice() { throw new Error('the fake node signs messages only') },
    async listChannels() { return [{ channel_id: 'c1', funding_txid: 'aa'.repeat(32), peer_pubkey: `02${'bb'.repeat(32)}`, capacity_sat: 100_000, asset_id: null, ready: true }] },
  }
}

const N = randomHex(32), L = randomHex(32), NOW = 1_792_300_000

describe('lightning node proof', () => {
  it('zbase32 round-trips', () => {
    const b = Uint8Array.from({ length: 65 }, (_, i) => (i * 37) & 0xff)
    assert.deepEqual(zbase32Decode(zbase32Encode(b)), b)
  })

  it('a node proof verifies for the node key', async () => {
    const node = fakeNode()
    const ln = new LightningAdapter('regtest', node, null, 'signmessage')
    const challenge = issueChallenge({ layer: 'lightning', chain: 'regtest', subject: node.pubkey, negotiation_id: N, lender_pk: L, now: NOW })
    const proof = await ln.proveControl(challenge)
    assert.equal(proof.format, 'ln-signmessage')
    const v = ln.verifyControl(proof, { negotiation_id: N, lender_pk: L, now: NOW + 5, issued: challenge })
    assert.ok(v.ok, v.reasons.join(','))
    assert.equal(v.key, node.pubkey)
  })

  it('fails for another key', async () => {
    const node = fakeNode(), other = fakeNode()
    const ln = new LightningAdapter('regtest', node, null, 'signmessage')
    // the proof claims the other node, but this node signed it
    const challenge = issueChallenge({ layer: 'lightning', chain: 'regtest', subject: other.pubkey, negotiation_id: N, lender_pk: L, now: NOW })
    const signature = await node.signMessage(challenge.text)
    const v = ln.verifyControl({ layer: 'lightning', subject: other.pubkey, challenge, format: 'ln-signmessage', signature }, { negotiation_id: N, lender_pk: L, now: NOW + 5, issued: challenge })
    assert.equal(v.ok, false)
    assert.deepEqual(v.reasons, ['SIGNED_BY_ANOTHER_KEY'])
    assert.equal(verifyLnMessage(challenge.text, signature, other.pubkey), false)
    assert.equal(verifyLnMessage(challenge.text, signature, node.pubkey), true)
  })

  it('the device refuses to sign a challenge for a node it is not', async () => {
    const node = fakeNode(), other = fakeNode()
    const challenge = issueChallenge({ layer: 'lightning', chain: 'regtest', subject: other.pubkey, negotiation_id: N, lender_pk: L, now: NOW })
    await assert.rejects(new LightningAdapter('regtest', node, null, 'signmessage').proveControl(challenge), /different node key/)
  })

  it('fails for another lender, an expired challenge and a garbled signature', async () => {
    const node = fakeNode()
    const ln = new LightningAdapter('regtest', node, null, 'signmessage')
    const challenge = issueChallenge({ layer: 'lightning', chain: 'regtest', subject: node.pubkey, negotiation_id: N, lender_pk: L, now: NOW })
    const proof = await ln.proveControl(challenge)
    assert.ok(ln.verifyControl(proof, { negotiation_id: N, lender_pk: randomHex(32), now: NOW }).reasons.includes('LENDER_MISMATCH'))
    assert.ok(ln.verifyControl(proof, { negotiation_id: N, lender_pk: L, now: challenge.expires_at + 1 }).reasons.includes('CHALLENGE_EXPIRED'))
    assert.ok(ln.verifyControl({ ...proof, signature: proof.signature.slice(0, -2) + 'yy' }, { negotiation_id: N, lender_pk: L, now: NOW }).reasons.some((r) => r === 'SIGNATURE_INVALID' || r === 'SIGNED_BY_ANOTHER_KEY'))
  })

  it('a regtest node has no public graph facts and says so; payment proofs are not built', async () => {
    const node = fakeNode()
    const h = await new LightningAdapter('regtest', node, null, 'signmessage').history([node.pubkey], { from_time: 0, to_time: NOW })
    assert.equal(h.rows.length, 0)
    assert.equal(h.public_facts, null)
    assert.ok(h.limits.includes('LIGHTNING_PAYMENT_PROOFS_NOT_BUILT'))
    assert.ok(h.limits.includes('NO_PUBLIC_GRAPH_ON_REGTEST'))
    assert.equal(h.own_channels.length, 1)
  })

  describe('real RGB Lightning Node d4762ac output', () => {
    const fx = JSON.parse(readFileSync(new URL('./fixtures/networks/rln-signmessage.json', import.meta.url), 'utf8')) as { node_pubkey: string; challenge: ControlChallenge; signmessage: { message: string; signed_message: string }; invoice_proof: string }
    const expect = { negotiation_id: fx.challenge.negotiation_id, lender_pk: fx.challenge.lender_pk, now: fx.challenge.issued_at + 60, issued: fx.challenge }
    const ln = new LightningAdapter('regtest', null)

    it('/signmessage signs the empty message whatever it is asked, so the verifier refuses it', () => {
      assert.equal(recoverLnSigner('', fx.signmessage.signed_message), fx.node_pubkey)
      assert.notEqual(recoverLnSigner(fx.signmessage.message, fx.signmessage.signed_message), fx.node_pubkey)
      const v = ln.verifyControl({ layer: 'lightning', subject: fx.node_pubkey, challenge: fx.challenge, format: 'ln-signmessage', signature: fx.signmessage.signed_message }, expect)
      assert.equal(v.ok, false)
      assert.ok(v.reasons.includes('MESSAGE_INDEPENDENT_SIGNATURE'))
    })

    it('a challenge invoice from the node verifies for the node key', () => {
      const inv = decodeInvoice(fx.invoice_proof)
      assert.equal(inv.signer, fx.node_pubkey)
      assert.equal(inv.description, fx.challenge.text)
      const v = ln.verifyControl({ layer: 'lightning', subject: fx.node_pubkey, challenge: fx.challenge, format: 'ln-invoice', signature: fx.invoice_proof }, expect)
      assert.ok(v.ok, v.reasons.join(','))
    })

    it('the same invoice fails for another node key, another challenge and another lender', () => {
      const other = `03${'11'.repeat(32)}`
      const forOther = ln.verifyControl({ layer: 'lightning', subject: other, challenge: { ...fx.challenge, subject: other, text: challengeText({ ...fx.challenge, subject: other }) }, format: 'ln-invoice', signature: fx.invoice_proof }, { ...expect, issued: undefined })
      assert.ok(forOther.reasons.includes('SIGNED_BY_ANOTHER_KEY'))
      assert.ok(forOther.reasons.includes('INVOICE_DESCRIPTION_IS_NOT_THE_CHALLENGE'))
      const L2 = randomHex(32)
      const moved = { ...fx.challenge, lender_pk: L2 }
      const forLender = ln.verifyControl({ layer: 'lightning', subject: fx.node_pubkey, challenge: { ...moved, text: challengeText(moved) }, format: 'ln-invoice', signature: fx.invoice_proof }, { ...expect, lender_pk: L2, issued: undefined })
      assert.deepEqual(forLender.reasons, ['INVOICE_DESCRIPTION_IS_NOT_THE_CHALLENGE'])
      assert.ok(ln.verifyControl({ layer: 'lightning', subject: fx.node_pubkey, challenge: fx.challenge, format: 'ln-invoice', signature: fx.invoice_proof }, { ...expect, lender_pk: L2 }).reasons.includes('LENDER_MISMATCH'))
    })

    it('an invoice for mainnet is refused on a regtest check', () => {
      assert.ok(new LightningAdapter('bitcoin', null).verifyControl({ layer: 'lightning', subject: fx.node_pubkey, challenge: fx.challenge, format: 'ln-invoice', signature: fx.invoice_proof }, expect).reasons.includes('INVOICE_WRONG_CHAIN'))
    })
  })
})
