// The sealed result. The operator runs the check first, then encrypts the
// plaintext (outputs plus the evidence: the DSSE envelope or the sandbox's
// signed result) under a fresh 32-byte K, signs a commitment to
// sha256(plaintext), and asks to be paid on an invoice whose payment hash is
// sha256(K). Paying reveals K (HODL rail); K decrypts; the plaintext's hash
// must equal the signed commitment. The payer forwards K to the other party,
// who checks the same commitment without trusting the payer.
//
// The commitment carries the consent receipt (which names this operator) and
// its hash, the request nonce and the negotiation id, so a result cannot be
// replayed for another borrower, lender, operator or negotiation.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { bytesToHex, hexToBytes, isHex, signObject, type Hex, type KeyPair } from '../core/crypto.js'
import { consentHash } from '../scorer/consent.js'
import { encKey, openResultWith, plaintextBytes, reportData, type CheckCommitment, type CheckPlaintext, type OpenedResult, type SealedResult } from './seal-core.js'

// The types, hashes and opening are browser-safe (seal-core.ts), so the phone opens a result with the same code.
export * from './seal-core.js'

export function freshKey(): Hex {
  return bytesToHex(randomBytes(32))
}

export function seal(p: CheckPlaintext, k: Hex): SealedResult {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encKey(hexToBytes(k)), iv)
  const body = Buffer.concat([cipher.update(gzipSync(plaintextBytes(p))), cipher.final(), cipher.getAuthTag()])
  return { v: 1, alg: 'aes-256-gcm+gzip', iv: bytesToHex(iv), ciphertext: body.toString('base64') }
}

/** Decrypts with K and returns the exact plaintext bytes; throws on a wrong key or a tampered blob. */
export function unseal(s: SealedResult, k: Hex): Uint8Array {
  if (s?.v !== 1 || s.alg !== 'aes-256-gcm+gzip' || !isHex(s.iv, 12) || typeof s.ciphertext !== 'string') throw new Error('SEALED_MALFORMED')
  const body = Buffer.from(s.ciphertext, 'base64')
  if (body.length < 17) throw new Error('SEALED_MALFORMED')
  const decipher = createDecipheriv('aes-256-gcm', encKey(hexToBytes(k)), hexToBytes(s.iv))
  decipher.setAuthTag(body.subarray(body.length - 16))
  try {
    return new Uint8Array(gunzipSync(Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]), { maxOutputLength: 4_000_000 }))
  } catch {
    throw new Error('SEALED_WRONG_KEY_OR_TAMPERED')
  }
}

export function signCommitment(operator: KeyPair, input: Omit<CheckCommitment, 'v' | 'domain' | 'operator_pk' | 'consent_hash' | 'report_data' | 'sig'>): CheckCommitment {
  return signObject({ v: 1 as const, domain: 'passbook-check-commitment-v1' as const, operator_pk: operator.pubkey, ...input, consent_hash: consentHash(input.consent), report_data: reportData(input.commitment, input.request_nonce) }, operator.secretKey)
}


/**
 * Anyone holding the commitment, the sealed blob and K runs the same checks:
 * the payer after paying, the other party after the payer forwards K.
 */
export function openResult(c: CheckCommitment, s: SealedResult, k: Hex, expect: { operator_pk: Hex; negotiation_id: Hex; borrower_pk: Hex; lender_pk: Hex }): OpenedResult | { plaintext: null; problems: string[] } {
  return openResultWith(unseal, c, s, k, expect)
}
