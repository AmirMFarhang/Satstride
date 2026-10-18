// Request signing, byte for byte what src/server/auth.ts checks: BIP-340 Schnorr
// with the phone's device key over sha256 of method, path and query, a
// millisecond timestamp, a nonce and the body hash. Pure TypeScript (no React
// Native), so the root test suite runs this same file against a live node.

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export const AUTH_HEADERS = { key: 'x-passbook-key', ts: 'x-passbook-ts', nonce: 'x-passbook-nonce', sig: 'x-passbook-sig' } as const

export interface DeviceKeyPair {
  /** 32-byte secret, hex. Lives in the platform's secure storage, never on screen. */
  secret: string
  /** x-only public key, hex */
  pubkey: string
}

export const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)))

/** Same as requestDigest in src/server/auth.ts and web/session-auth.js. */
export function requestDigest(method: string, pathAndQuery: string, timestampMs: number, nonce: string, body: string): string {
  return sha256Hex(['passbook-request-v1', method.toUpperCase(), pathAndQuery, String(timestampMs), nonce, sha256Hex(body)].join('\n'))
}

/** A fresh device key: made on the phone at pairing, one per pairing. */
export function newDeviceKey(): DeviceKeyPair {
  const secret = schnorr.utils.randomSecretKey()
  return { secret: bytesToHex(secret), pubkey: bytesToHex(schnorr.getPublicKey(secret)) }
}

export function deviceKeyFromSecret(secret: string): DeviceKeyPair {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('device key must be 32 bytes of hex')
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(secret))) }
}

/** Headers for one request; `body` must be the exact bytes sent. */
export function signedHeaders(key: DeviceKeyPair, method: string, pathAndQuery: string, body = '', now = Date.now(), nonce = bytesToHex(randomBytes(16))): Record<string, string> {
  const digest = requestDigest(method, pathAndQuery, now, nonce, body)
  return {
    [AUTH_HEADERS.key]: key.pubkey,
    [AUTH_HEADERS.ts]: String(now),
    [AUTH_HEADERS.nonce]: nonce,
    [AUTH_HEADERS.sig]: bytesToHex(schnorr.sign(hexToBytes(digest), hexToBytes(key.secret))),
  }
}
