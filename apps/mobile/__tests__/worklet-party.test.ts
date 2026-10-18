// The worklet's party key (worklet/party.js) signs exactly what the laptop agents sign:
// every check below uses the laptop's own code in src/ to verify the phone's output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mnemonicToSeedSync } from '@scure/bip39'
import { HDKey } from '@scure/bip32'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { verifyEvent, getEventHash } from 'nostr-tools'
import * as bitcoin from 'bitcoinjs-lib'
import { canonicalJson, hashObject, sha256Hex, verifyHash, verifyObject, keyPairFromLabel } from '../../../src/core/crypto.ts'
import { requestDigest } from '../../../src/server/auth.ts'
import { decryptFrom, encryptTo } from '../../../src/market/messages.ts'
import { addLeafSignature, buildEscrowSpend, buildLock, keyPathOutput, psbtFromBase64, type EscrowParties } from '../../../src/escrow/escrow.ts'
import type { LoanTerms } from '../../../src/core/terms.ts'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../worklet/keys.js')
const party = require('../worklet/party.js')

const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const key = new party.PartyKey(rootFromSeed(mnemonicToSeedSync(WORDS)))

test('the party key is the laptop\'s: m/86\'/1\'/0\'/0/0, x-only, BIP-86 address', () => {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(WORDS)).derive("m/86'/1'/0'/0/0")
  assert.equal(key.pubkey, bytesToHex(schnorr.getPublicKey(node.privateKey!)))
  assert.deepEqual(key.btcOutput(), keyPathOutput(key.pubkey))
  assert.equal(JSON.stringify(key).includes(bytesToHex(node.privateKey!)), false)
})

test('canonical hashing and object signatures match src/core/crypto', () => {
  const obj = { b: [3, { z: 1, a: undefined, y: 'x' }], a: 'é', c: { k: null }, sig: 'ignored' }
  assert.equal(party.canonicalJson(obj), canonicalJson(obj))
  assert.equal(party.hashObject(obj), hashObject(obj))
  const signed = key.signObject(obj)
  assert.ok(verifyObject(signed, key.pubkey))
  assert.ok(verifyHash(key.signPassbookHash(hashObject({ outstanding_micro: 0 })), hashObject({ outstanding_micro: 0 }), key.pubkey))
  assert.throws(() => key.signPassbookHash('zz'))
})

test('platform request signatures verify against src/server/auth requestDigest', () => {
  const body = JSON.stringify({ lock_txid: 'ab'.repeat(32) })
  const r = { method: 'post', pathAndQuery: '/loans/x/lock', timestampMs: 1_792_000_000_000, nonce: 'n'.repeat(32), bodySha256: sha256Hex(body) }
  const sig = key.signRequest(r)
  assert.ok(verifyHash(sig, requestDigest('POST', r.pathAndQuery, r.timestampMs, r.nonce, body), key.pubkey))
})

test('Nostr events and NIP-44 interoperate with the laptop agents (nostr-tools, src/market/messages)', () => {
  const ev = key.signEvent({ kind: 7470, created_at: 1_792_000_000, tags: [['t', 'passbook'], ['p', 'aa'.repeat(32)]], content: 'x' })
  assert.equal(ev.pubkey, key.pubkey)
  assert.equal(ev.id, getEventHash(ev))
  assert.ok(verifyEvent({ ...ev }))
  const lender = keyPairFromLabel('mobile-test-lender')
  const toLender = key.nip44Encrypt(lender.pubkey, 'from the phone')
  assert.equal(decryptFrom(lender, key.pubkey, toLender), 'from the phone')
  assert.equal(key.nip44Decrypt(lender.pubkey, encryptTo(lender, key.pubkey, 'from the lender')), 'from the lender')
})

const parties = (): EscrowParties => ({ borrower_pk: key.pubkey, lender_pk: keyPairFromLabel('l').pubkey, platform_pk: keyPairFromLabel('p').pubkey, recovery_height: 500 })

test('the collateral lock is signed on the key path and finalizes with bitcoinjs (src/escrow buildLock)', () => {
  const p = parties()
  const terms = { borrower_pk: p.borrower_pk, lender_pk: p.lender_pk, platform_pk: p.platform_pk, recovery_height: p.recovery_height, collateral_sats: 100_000 } as unknown as LoanTerms
  // buildLock reads the parties, the collateral and the terms hash: a stub terms object is enough
  const lock = buildLock({ inputs: [{ txid: '11'.repeat(32), vout: 0, value: 150_000, internal_pk: key.pubkey }], terms, changeScript: keyPathOutput(key.pubkey).script })
  const signed = psbtFromBase64(key.signKeyPath(lock.toBase64()))
  assert.ok(signed.data.inputs[0].tapKeySig?.length === 64)
  assert.ok(signed.validateSignaturesOfInput(0, (pk, msg, sig) => schnorr.verify(sig, msg, pk)))
  signed.finalizeAllInputs()
  assert.ok(signed.extractTransaction().getId().length === 64)
  assert.throws(() => new party.PartyKey(rootFromSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))).signKeyPath(lock.toBase64()), /no input/)
})

test('the escrow leaf signature is computed in the worklet and accepted by src/escrow addLeafSignature', () => {
  const p = parties()
  for (const leaf of ['A', 'C'] as const) {
    const spend = buildEscrowSpend({ escrow: { txid: '22'.repeat(32), vout: 0, value: 100_000 }, parties: p, leaf, outputs: [{ script: keyPathOutput(key.pubkey).script, value: 99_500 }] })
    const { signature, signed } = key.signEscrowLeaf(spend.toBase64())
    assert.equal(signed.escrow_sats, '100000')
    addLeafSignature(spend, p, leaf, 'borrower', signature) // throws unless the signature verifies
  }
  // a leaf without this key is refused
  const lenderOnly = buildEscrowSpend({ escrow: { txid: '22'.repeat(32), vout: 0, value: 100_000 }, parties: p, leaf: 'B', outputs: [{ script: keyPathOutput(key.pubkey).script, value: 99_500 }] })
  assert.throws(() => key.signEscrowLeaf(lenderOnly.toBase64()), /not in that leaf/)
})
