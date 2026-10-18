// The operator bond is designed, not live (docs/CHECK-BOND.md). These are its
// test vectors: two commitments signed under one announced nonce leak the bond key.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes, keyPairFromLabel, sha256Hex } from '../src/core/crypto.js'
import { extractBondKey, noncePoint, signWithNonce } from '../src/checknode/bond.js'

const V = {
  secret: '7e7e7fbadf2093d963bbac149f8b65ec36b21d80a7655872ab8011ee5c278a6f',
  pubkey: '978db63287d4222b9130e4cc2890ad4e25eec55a6cf318f2957a7d84e5db4349',
  k: '607345cf72b0b940e28d596bf177dc071c75ff4edfab88c4da7453483164c334',
  R: 'ef8cfb9754f5e159bbd11fb77ccd8abab89828f3a3e4f9f6f516bddb3a54b8a2',
  m1: 'bd495ec13edfa3a6d3b3fa5c83b8510feff208ac1925e97c4ba2ed9e4e661583',
  s1: 'ef8cfb9754f5e159bbd11fb77ccd8abab89828f3a3e4f9f6f516bddb3a54b8a2e7f75c8b6e271520b9e6e6d08cddacd3be8dd920b3fe2bb3a9b82f572d308870',
  m2: '4af0664f68c944f539ce2b5563acc9b401c6bd4cf323fcff04962df0a78e523f',
  s2: 'ef8cfb9754f5e159bbd11fb77ccd8abab89828f3a3e4f9f6f516bddb3a54b8a2dec03e7783bc490ab58ebc1b04d8cedaf5b68656dd5ec24711477a871b8bb882',
}

describe('operator bond (designed): nonce-reuse test vectors', () => {
  it('reproduces the documented vectors from their labels', () => {
    const op = keyPairFromLabel('check-bond-test-operator')
    assert.equal(bytesToHex(op.secretKey), V.secret)
    assert.equal(op.pubkey, V.pubkey)
    assert.equal(sha256Hex('check-bond-test-nonce-request-1'), V.k)
    assert.equal(sha256Hex('commitment: QUALIFY to the borrower'), V.m1)
    assert.equal(sha256Hex('commitment: DECLINE to the lender'), V.m2)
    assert.equal(noncePoint(V.k), V.R)
    assert.equal(signWithNonce(V.m1, V.secret, V.k), V.s1)
    assert.equal(signWithNonce(V.m2, V.secret, V.k), V.s2)
  })

  it('both are ordinary valid BIP-340 signatures by the bond key', () => {
    assert.ok(schnorr.verify(hexToBytes(V.s1), hexToBytes(V.m1), hexToBytes(V.pubkey)))
    assert.ok(schnorr.verify(hexToBytes(V.s2), hexToBytes(V.m2), hexToBytes(V.pubkey)))
  })

  it('equivocating under the announced nonce leaks the bond key; fresh nonces do not', () => {
    assert.equal(extractBondKey({ sig: V.s1, message: V.m1 }, { sig: V.s2, message: V.m2 }, V.pubkey), V.secret)
    const other = signWithNonce(V.m2, V.secret, sha256Hex('check-bond-test-nonce-request-2'))
    assert.equal(extractBondKey({ sig: V.s1, message: V.m1 }, { sig: other, message: V.m2 }, V.pubkey), null)
    assert.equal(extractBondKey({ sig: V.s1, message: V.m1 }, { sig: V.s1, message: V.m1 }, V.pubkey), null, 'the same commitment twice is not equivocation')
  })
})
