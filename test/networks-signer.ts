// TEST ONLY. A BIP-322 "simple" signer, so the verifier can be tested on
// challenges it has never seen. It is used only with the private keys BIP-322
// publishes in its own test vectors (they hold no funds and everyone knows
// them). Passbook's src/ never signs a mainnet message or transaction: the
// person signs in their own wallet. Kept out of src/ on purpose; the guard test
// checks that src/networks/ has no signing code.

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { bip322MessageHash, decodeAddress, taggedHash, toSignTx, toSpendTx } from '../src/networks/bip322.js'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58check(text: string): Uint8Array {
  let n = 0n
  for (const ch of text) {
    const i = B58.indexOf(ch)
    if (i < 0) throw new Error('not base58')
    n = n * 58n + BigInt(i)
  }
  const hex = n.toString(16).padStart(2, '0')
  let bytes = Uint8Array.from(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'))
  const zeros = text.length - text.replace(/^1+/, '').length
  bytes = concatBytes(new Uint8Array(zeros), bytes)
  const body = bytes.slice(0, -4), check = bytes.slice(-4)
  const want = sha256(sha256(body)).slice(0, 4)
  if (!want.every((b, i) => b === check[i])) throw new Error('bad checksum')
  return body
}

/** Secret key bytes from a compressed mainnet WIF (BIP-322 test vector keys). */
export function wifSecret(wif: string): Uint8Array {
  const body = base58check(wif)
  if (body[0] !== 0x80 || body.length !== 34 || body[33] !== 0x01) throw new Error('expected a compressed mainnet WIF')
  return body.slice(1, 33)
}

function witnessBytes(items: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(items.length)]
  for (const it of items) parts.push(Uint8Array.of(it.length), it)
  return concatBytes(...parts)
}

/** BIP-322 simple signature (with the `smp` prefix) of `message` by `address`, using a published test key. */
export function testSignBip322(address: string, message: string, wif: string | Uint8Array, prefix = true, chain: 'bitcoin' | 'signet' | 'regtest' = 'bitcoin'): string {
  const secret = typeof wif === 'string' ? wifSecret(wif) : wif
  const { type, script, program } = decodeAddress(address, chain)
  const toSpend = toSpendTx(bip322MessageHash(message), script)
  const toSign = toSignTx(toSpend)
  let witness: Uint8Array[]
  if (type === 'p2wpkh') {
    const pub = secp256k1.getPublicKey(secret, true)
    const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), program, Uint8Array.of(0x88, 0xac))
    const sighash = toSign.hashForWitnessV0(0, scriptCode, 0n, 0x01)
    const der = secp256k1.sign(sighash, secret, { prehash: false, lowS: true, format: 'der' })
    witness = [concatBytes(der, Uint8Array.of(0x01)), pub]
  } else {
    // BIP-86 key path: tweak the internal key by H_TapTweak(P).
    const n = secp256k1.Point.CURVE().n
    const P = secp256k1.Point.BASE.multiply(BigInt(`0x${Buffer.from(secret).toString('hex')}`))
    let d = BigInt(`0x${Buffer.from(secret).toString('hex')}`)
    if (P.y % 2n === 1n) d = n - d
    const px = P.toBytes(true).slice(1)
    const t = BigInt(`0x${Buffer.from(taggedHash('TapTweak', px)).toString('hex')}`)
    const tweaked = (d + t) % n
    const key = Uint8Array.from(Buffer.from(tweaked.toString(16).padStart(64, '0'), 'hex'))
    if (Buffer.from(schnorr.getPublicKey(key)).toString('hex') !== Buffer.from(program).toString('hex')) throw new Error('tweaked key does not match the address')
    const sighash = toSign.hashForWitnessV1(0, [script], [0n], 0x00)
    witness = [schnorr.sign(sighash, key, new Uint8Array(32))]
  }
  return `${prefix ? 'smp' : ''}${Buffer.from(witnessBytes(witness)).toString('base64')}`
}

/** The keys BIP-322 publishes for its P2WPKH and P2TR vectors (no funds; public). */
export const BIP322_TEST_KEYS = {
  p2wpkh: { address: 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l', wif: 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k' },
  p2tr: { address: 'bc1pss0zhytly75awhm6x2hhvd5lnzv3vssgrf9axfheq8ldyzn88ges79fler', wif: 'KyrSGCFPhqZMjCe5fNTYddiLMp4tMj4gLKuJ26TsB2rvr1VJGPbt' },
} as const

/** A second published key per type (generated-test-vectors.json), for "another address" cases. */
export const BIP322_OTHER_KEYS = {
  p2wpkh: { address: 'bc1qqthe0hz8klx90e7stf6shclhsvqd5ly96pn53v', wif: 'KySmn2yeCukjHXnSu3M6vX7tNok4weu1FKbNEuVvm2b3ZidKhB4L' },
  p2tr: { address: 'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38', wif: 'L5XqN6ckPPsDiTbRxcsthwiWpDBfWLo4uquUEydsPt8rSMoTpqpc' },
} as const

/** TEST ONLY: an LDK/LND-format node signature (zbase32 of [31 + recid | r | s]) over the Lightning message hash. */
export function testSignLn(message: string, secret: Uint8Array, lnMessageHash: (m: string) => Uint8Array, zbase32Encode: (b: Uint8Array) => string): string {
  const sig = secp256k1.sign(lnMessageHash(message), secret, { prehash: false, lowS: true, format: 'recovered' })
  // noble 'recovered' format is [recid | r | s]
  return zbase32Encode(concatBytes(Uint8Array.of(31 + sig[0]), sig.slice(1)))
}
