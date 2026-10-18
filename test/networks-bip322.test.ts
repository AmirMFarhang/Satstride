// BIP-322 proof of control for P2WPKH and P2TR mainnet addresses: the
// published vectors verify, and a Passbook challenge fails for another
// address, after expiry, or for another negotiation or lender.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { bytesToHex, randomHex } from '../src/core/crypto.js'
import { bip322MessageHash, decodeAddress, toSignTx, toSpendTx, verifyBip322Simple } from '../src/networks/bip322.js'
import { BtcOnchainAdapter } from '../src/networks/btc-onchain.js'
import { challengeText, issueChallenge } from '../src/networks/challenge.js'
import { ChallengeBook } from '../src/networks/agent-check.js'
import { SnapshotSource } from '../src/networks/bitcoin-source.js'
import { BIP322_OTHER_KEYS, BIP322_TEST_KEYS, testSignBip322 } from './networks-signer.js'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/networks/bip322-vectors.json', import.meta.url), 'utf8')) as {
  tx_hashes: { message: string; address: string; message_hash: string; to_spend_tx_hash: string; to_sign_tx_hash: string }[]
  simple: { message: string; address: string; type: string; bip322_signatures: string[] }[]
  error: { description: string; message: string; address: string; signature: string }[]
}
const adapter = new BtcOnchainAdapter('bitcoin', SnapshotSource.fromFile(new URL('./fixtures/networks/mainnet-snapshot.json', import.meta.url).pathname))
const N = randomHex(32), L = randomHex(32)
const NOW = 1_792_300_000

describe('BIP-322 vectors (bitcoin/bips, CC0)', () => {
  it('message hash and the two virtual transactions match the published hashes', () => {
    for (const v of vectors.tx_hashes) {
      const h = bip322MessageHash(v.message)
      const toSpend = toSpendTx(h, decodeAddress(v.address, 'bitcoin').script)
      assert.equal(bytesToHex(h), v.message_hash)
      assert.equal(toSpend.getId(), v.to_spend_tx_hash)
      assert.equal(toSignTx(toSpend).getId(), v.to_sign_tx_hash)
    }
  })
  it('every published P2WPKH and P2TR simple signature verifies, prefixed or not', () => {
    const types = new Set<string>()
    for (const v of vectors.simple) for (const sig of v.bip322_signatures) {
      const r = verifyBip322Simple(v.address, v.message, sig)
      assert.ok(r.ok, `${v.type} ${v.message}: ${r.reasons.join(',')}`)
      types.add(r.type!)
    }
    assert.deepEqual([...types].sort(), ['p2tr', 'p2wpkh'])
  })
  it('every published error case fails', () => {
    for (const e of vectors.error) assert.equal(verifyBip322Simple(e.address, e.message, e.signature).ok, false, e.description)
  })
  it('the test signer reproduces a published P2WPKH signature, so the challenge tests below sign the way wallets do', () => {
    const v = vectors.simple.find((s) => s.type === 'p2wpkh' && s.message === 'Hello World' && s.address === BIP322_TEST_KEYS.p2wpkh.address)!
    assert.ok(v.bip322_signatures.includes(testSignBip322(v.address, v.message, BIP322_TEST_KEYS.p2wpkh.wif)))
  })
  it('only mainnet addresses for a mainnet check, and only P2WPKH or P2TR', () => {
    const testnet = bitcoin.address.toBech32(decodeAddress(BIP322_TEST_KEYS.p2wpkh.address, 'bitcoin').program, 0, 'tb')
    assert.deepEqual(verifyBip322Simple(testnet, '', 'smpAA==').reasons, ['ADDRESS_WRONG_CHAIN'])
    assert.deepEqual(verifyBip322Simple('bc1qp0ahvfh83088w49k405szqgg4f3pptr7p2g06tdxfjcd40z4lh4q95lsz9', '', 'smpAA==').reasons, ['ADDRESS_TYPE_UNSUPPORTED'])
    assert.deepEqual(verifyBip322Simple('1BxMhvfWLnGLqVhJ3j39oDBk7qf5D86BFe', '', 'smpAA==').reasons, ['ADDRESS_INVALID'])
  })
})

for (const type of ['p2wpkh', 'p2tr'] as const) {
  describe(`Passbook challenge, ${type}`, () => {
    const { address, wif } = BIP322_TEST_KEYS[type]
    const other = BIP322_OTHER_KEYS[type]
    const challenge = issueChallenge({ layer: 'btc-onchain', chain: 'bitcoin', subject: address, negotiation_id: N, lender_pk: L, now: NOW })
    const expect = { negotiation_id: N, lender_pk: L, now: NOW + 60, issued: challenge }
    const proof = { layer: 'btc-onchain' as const, subject: address, challenge, format: 'bip322-simple' as const, signature: testSignBip322(address, challenge.text, wif) }

    it('the text binds negotiation, lender, nonce and expiry, on one line', () => {
      for (const part of [N, L, challenge.nonce, address, 'not a transaction']) assert.ok(challenge.text.includes(part))
      assert.ok(!challenge.text.includes('\n'))
      assert.ok(challenge.expires_at > challenge.issued_at)
    })
    it('verifies', () => {
      const v = adapter.verifyControl(proof, expect)
      assert.ok(v.ok, v.reasons.join(','))
      assert.equal(v.layer, 'btc-onchain')
    })
    it('fails for another address', () => {
      // the other address's owner signs this exact challenge: the signature is not for this address
      const forOther = { ...proof, signature: testSignBip322(other.address, challenge.text, other.wif) }
      assert.deepEqual(adapter.verifyControl(forOther, expect).reasons, [type === 'p2wpkh' ? 'PUBKEY_NOT_FOR_ADDRESS' : 'SIGNATURE_INVALID'])
      const claimOther = { ...proof, subject: other.address }
      assert.ok(adapter.verifyControl(claimOther, expect).reasons.includes('SUBJECT_MISMATCH'))
    })
    it('fails after expiry', () => {
      const v = adapter.verifyControl(proof, { ...expect, now: challenge.expires_at + 1 })
      assert.equal(v.ok, false)
      assert.ok(v.reasons.includes('CHALLENGE_EXPIRED'))
    })
    it('fails for another negotiation id', () => {
      const v = adapter.verifyControl(proof, { ...expect, negotiation_id: randomHex(32), issued: undefined })
      assert.ok(v.reasons.includes('NEGOTIATION_MISMATCH'))
      // rewriting the challenge to name the other negotiation breaks the signature
      const N2 = randomHex(32)
      const moved = { ...challenge, negotiation_id: N2 }
      const forged = { ...proof, challenge: { ...moved, text: challengeText(moved) } }
      const v2 = adapter.verifyControl(forged, { ...expect, negotiation_id: N2, issued: undefined })
      assert.deepEqual(v2.reasons, ['SIGNATURE_INVALID'])
    })
    it('fails for another lender', () => {
      const v = adapter.verifyControl(proof, { ...expect, lender_pk: randomHex(32), issued: undefined })
      assert.ok(v.reasons.includes('LENDER_MISMATCH'))
      const L2 = randomHex(32)
      const moved = { ...challenge, lender_pk: L2 }
      const forged = { ...proof, challenge: { ...moved, text: challengeText(moved) } }
      assert.deepEqual(adapter.verifyControl(forged, { ...expect, lender_pk: L2, issued: undefined }).reasons, ['SIGNATURE_INVALID'])
    })
    it('fails for a challenge the lender did not issue, and an edited text', () => {
      const fresh = issueChallenge({ layer: 'btc-onchain', chain: 'bitcoin', subject: address, negotiation_id: N, lender_pk: L, now: NOW })
      const signedFresh = { ...proof, challenge: fresh, signature: testSignBip322(address, fresh.text, wif) }
      assert.ok(adapter.verifyControl(signedFresh, expect).reasons.includes('CHALLENGE_NOT_ISSUED'))
      assert.ok(adapter.verifyControl({ ...proof, challenge: { ...challenge, text: `${challenge.text} ` } }, expect).reasons.includes('CHALLENGE_TEXT_MISMATCH'))
    })
  })
}

describe('challenge book', () => {
  it('a proof is single use', () => {
    const book = new ChallengeBook(L, N)
    const c = book.issue('btc-onchain', 'bitcoin', BIP322_TEST_KEYS.p2wpkh.address, NOW)
    assert.equal(book.current('btc-onchain', BIP322_TEST_KEYS.p2wpkh.address, NOW)?.nonce, c.nonce)
    assert.equal(book.consume(c.nonce), true)
    assert.equal(book.consume(c.nonce), false)
    assert.equal(book.current('btc-onchain', BIP322_TEST_KEYS.p2wpkh.address, NOW), null)
    assert.deepEqual(ChallengeBook.fromJSON(JSON.parse(JSON.stringify(book))).toJSON(), book.toJSON())
  })
})
