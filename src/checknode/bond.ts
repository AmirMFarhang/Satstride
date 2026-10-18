// The operator bond: DESIGNED, NOT LIVE (docs/CHECK-BOND.md). Nothing here
// locks, watches or sweeps a UTXO. This file only holds the arithmetic the
// design rests on, so its test vectors are checked in test:
//
// The operator signs each result commitment with its bond key x and a nonce
// point R it committed to before the result existed. Signing two different
// commitments under the same R leaks x:
//   s1 = k + e1·x,  s2 = k + e2·x   (mod n)   =>   x = (s1 − s2) / (e1 − e2)
// and whoever learns x can spend the bond output locked to x·G.

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes, type Hex } from '../core/crypto.js'

const { Point, utils } = schnorr
const Fn = Point.Fn
const n = Fn.ORDER
const mod = (a: bigint) => ((a % n) + n) % n
const int = (b: Uint8Array) => BigInt(`0x${bytesToHex(b) || '0'}`)
const bytes32 = (v: bigint) => hexToBytes(v.toString(16).padStart(64, '0'))
const pow = (b: bigint, e: bigint): bigint => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n } return r }
const inv = (a: bigint) => pow(a, n - 2n)
const hasEvenY = (p: InstanceType<typeof Point>) => p.toAffine().y % 2n === 0n

/** BIP-340 with the even-y adjustment applied: the scalar that actually signs for x-only P. */
export function evenScalar(secret: Hex): bigint {
  const d = mod(int(hexToBytes(secret)))
  return hasEvenY(Point.BASE.multiply(d)) ? d : n - d
}

/** The nonce point an operator announces before it signs (x-only hex). */
export function noncePoint(k: Hex): Hex {
  return bytesToHex(utils.pointToBytes(Point.BASE.multiply(mod(int(hexToBytes(k))))))
}

/** BIP-340 signature with a CALLER-CHOSEN nonce. Only for the bond design and its vectors: reusing k leaks the key, which is the point. */
export function signWithNonce(message: Hex, secret: Hex, k: Hex): Hex {
  const d = evenScalar(secret)
  const P = Point.BASE.multiply(d)
  let kk = mod(int(hexToBytes(k)))
  const R = Point.BASE.multiply(kk)
  if (!hasEvenY(R)) kk = n - kk
  const rx = utils.pointToBytes(R)
  const e = mod(int(utils.taggedHash('BIP0340/challenge', rx, utils.pointToBytes(P), hexToBytes(message))))
  return bytesToHex(rx) + bytesToHex(bytes32(mod(kk + e * d)))
}

function challenge(sig: Hex, message: Hex, pubkey: Hex): bigint {
  return mod(int(utils.taggedHash('BIP0340/challenge', hexToBytes(sig.slice(0, 64)), hexToBytes(pubkey), hexToBytes(message))))
}

/**
 * Two valid signatures by `pubkey` with the same R over different messages:
 * returns the even-y secret scalar, or null when they do not share R.
 */
export function extractBondKey(a: { sig: Hex; message: Hex }, b: { sig: Hex; message: Hex }, pubkey: Hex): Hex | null {
  if (a.sig.slice(0, 64) !== b.sig.slice(0, 64) || a.message === b.message) return null
  if (!schnorr.verify(hexToBytes(a.sig), hexToBytes(a.message), hexToBytes(pubkey)) || !schnorr.verify(hexToBytes(b.sig), hexToBytes(b.message), hexToBytes(pubkey))) return null
  const s1 = int(hexToBytes(a.sig.slice(64))), s2 = int(hexToBytes(b.sig.slice(64)))
  const e1 = challenge(a.sig, a.message, pubkey), e2 = challenge(b.sig, b.message, pubkey)
  if (e1 === e2) return null
  const x = mod((s1 - s2) * inv(mod(e1 - e2)))
  return bytesToHex(utils.pointToBytes(Point.BASE.multiply(x))) === pubkey ? bytesToHex(bytes32(x)) : null
}
