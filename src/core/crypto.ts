// Keys, hashing and signatures. secp256k1 / BIP-340 Schnorr throughout, so one
// key can be a Nostr identity, a Taproot leaf signer and an oracle signer.

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export type Hex = string

export interface KeyPair {
  secretKey: Uint8Array
  /** x-only, 32 bytes hex */
  pubkey: Hex
}

/** Deterministic JSON: sorted keys, no undefined, no whitespace. All hashes are over this form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortDeep(v)
    }
    return out
  }
  return value
}

export function sha256Hex(data: string | Uint8Array): Hex {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data))
}

export function hashObject(value: unknown): Hex {
  return sha256Hex(canonicalJson(value))
}

export function randomKeyPair(): KeyPair {
  const secretKey = randomBytes(32)
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) }
}

/** Demo-only: reproducible keys so identities are stable across runs. Never for real funds. */
export function keyPairFromLabel(label: string): KeyPair {
  const secretKey = sha256(utf8ToBytes(`passbook-demo-key:${label}`))
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) }
}

export function keyPairFromSecret(secretHex: Hex): KeyPair {
  const secretKey = hexToBytes(secretHex)
  return { secretKey, pubkey: bytesToHex(schnorr.getPublicKey(secretKey)) }
}

export function signHash(hashHex: Hex, secretKey: Uint8Array): Hex {
  return bytesToHex(schnorr.sign(hexToBytes(hashHex), secretKey))
}

export function verifyHash(sigHex: Hex, hashHex: Hex, pubkey: Hex): boolean {
  try {
    return schnorr.verify(hexToBytes(sigHex), hexToBytes(hashHex), hexToBytes(pubkey))
  } catch {
    return false
  }
}

/** Sign the canonical hash of an object; the signature covers every field except `sig`. */
export function signObject<T extends object>(value: T, secretKey: Uint8Array): T & { sig: Hex } {
  const { sig: _ignored, ...rest } = value as T & { sig?: Hex }
  return { ...(rest as T), sig: signHash(hashObject(rest), secretKey) }
}

export function verifyObject<T extends { sig?: Hex }>(value: T, pubkey: Hex): boolean {
  const { sig, ...rest } = value
  return typeof sig === 'string' && verifyHash(sig, hashObject(rest), pubkey)
}

export function randomHex(bytes = 32): Hex {
  return bytesToHex(randomBytes(bytes))
}

export function isHex(v: unknown, bytes?: number): v is Hex {
  return typeof v === 'string' && /^[0-9a-f]*$/.test(v) && (bytes === undefined ? v.length % 2 === 0 : v.length === bytes * 2)
}

export { bytesToHex, hexToBytes }
