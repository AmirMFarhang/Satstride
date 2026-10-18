// The browser-safe half of the sealed result (seal.ts has the operator's
// half): the types, the hashes, and opening a result with K. Opening needs
// AES-256-GCM (@noble/ciphers) and gunzip (portable.ts), so the phone opens a
// forwarded result with the same checks as the laptop. No node: imports.

import { gcm } from '@noble/ciphers/aes.js'
import { canonicalJson, hashObject, hexToBytes, isHex, sha256Hex, verifyObject, type Hex } from '../core/crypto.js'
import { consentHash, type ConsentReceipt } from '../scorer/consent.js'
import type { ScorerOutcome } from '../scorer/types.js'
import type { CheckRail } from './offer.js'
import { base64ToBytes, gunzip } from './portable.js'

export interface CheckPlaintext {
  v: 1
  kind: 'passbook-check-plaintext'
  negotiation_id: Hex
  request_nonce: Hex
  consent_hash: Hex
  /** Exactly what the scorer released: outputs and evidence. Never the bundle. */
  outcome: ScorerOutcome
}

export interface SealedResult {
  v: 1
  alg: 'aes-256-gcm+gzip'
  iv: Hex
  /** base64 of gzip(plaintext) encrypted, followed by the 16-byte tag */
  ciphertext: string
}

export interface CheckCommitment {
  v: 1
  domain: 'passbook-check-commitment-v1'
  negotiation_id: Hex
  request_nonce: Hex
  /** hash of the REQUEST message this answers */
  request_hash: Hex
  operator_pk: Hex
  offer_hash: Hex
  release_hash: Hex
  /** The borrower-signed receipt, naming this operator; its hash too, so either can be checked. */
  consent: ConsentReceipt
  consent_hash: Hex
  /** sha256 of the canonical plaintext */
  commitment: Hex
  /** sha256 of the sealed ciphertext as sent */
  ciphertext_hash: Hex
  /** sha256(K) */
  key_hash: Hex
  payment: { rail: Exclude<CheckRail, 'rgb-onchain'>; asset_id: string; amount: number; invoice: string; payment_hash: Hex }
  /** sha256(commitment ‖ request nonce): the report data a TEE attestation must carry (tee.ts). */
  report_data: Hex
  issued_at: number
  sig: Hex
}

/** The AES-256-GCM key: sha256("passbook-check-v1/enc" ‖ K). */
export function encKey(k: Uint8Array): Uint8Array {
  return hexToBytes(sha256Hex(new Uint8Array([...new TextEncoder().encode('passbook-check-v1/enc'), ...k])))
}

/** sha256 of the 32 key bytes: the Lightning payment hash when K is the preimage. */
export function keyHash(k: Hex): Hex {
  if (!isHex(k, 32)) throw new Error('K must be 32 bytes')
  return sha256Hex(hexToBytes(k))
}

export function plaintextBytes(p: CheckPlaintext): Uint8Array {
  return new TextEncoder().encode(canonicalJson(p))
}

export function plaintextCommitment(p: CheckPlaintext): Hex {
  return sha256Hex(plaintextBytes(p))
}

export function reportData(commitment: Hex, requestNonce: Hex): Hex {
  return sha256Hex(hexToBytes(commitment + requestNonce))
}

export function sealedHash(s: SealedResult): Hex {
  return hashObject(s)
}

/** Decrypts with K without Node (noble AES-GCM, portable gunzip); throws on a wrong key or a tampered blob. */
export function unsealPortable(s: SealedResult, k: Hex): Uint8Array {
  if (s?.v !== 1 || s.alg !== 'aes-256-gcm+gzip' || !isHex(s.iv, 12) || typeof s.ciphertext !== 'string') throw new Error('SEALED_MALFORMED')
  let body: Uint8Array
  try { body = base64ToBytes(s.ciphertext) } catch { throw new Error('SEALED_MALFORMED') }
  if (body.length < 17) throw new Error('SEALED_MALFORMED')
  try {
    return gunzip(gcm(encKey(hexToBytes(k)), hexToBytes(s.iv)).decrypt(body), 4_000_000)
  } catch {
    throw new Error('SEALED_WRONG_KEY_OR_TAMPERED')
  }
}

export interface OpenedResult { plaintext: CheckPlaintext; problems: string[] }

/**
 * Anyone holding the commitment, the sealed blob and K runs the same checks:
 * the payer after paying, the other party after the payer forwards K.
 */
export function openResultWith(unseal: (s: SealedResult, k: Hex) => Uint8Array, c: CheckCommitment, s: SealedResult, k: Hex, expect: { operator_pk: Hex; negotiation_id: Hex; borrower_pk: Hex; lender_pk: Hex }): OpenedResult | { plaintext: null; problems: string[] } {
  const problems: string[] = []
  if (!c || c.v !== 1 || c.domain !== 'passbook-check-commitment-v1') return { plaintext: null, problems: ['COMMITMENT_MALFORMED'] }
  if (c.operator_pk !== expect.operator_pk || !verifyObject(c, c.operator_pk)) problems.push('COMMITMENT_SIGNATURE')
  if (c.negotiation_id !== expect.negotiation_id) problems.push('COMMITMENT_OTHER_NEGOTIATION')
  if (c.consent_hash !== consentHash(c.consent)) problems.push('COMMITMENT_CONSENT_HASH')
  if (c.consent.operator_pk !== c.operator_pk) problems.push('CONSENT_NAMES_ANOTHER_OPERATOR')
  if (c.consent.borrower_pk !== expect.borrower_pk || c.consent.lender_pk !== expect.lender_pk || c.consent.purpose_id !== expect.negotiation_id) problems.push('CONSENT_OTHER_PARTIES_OR_PURPOSE')
  if (!verifyObject(c.consent, c.consent.borrower_pk)) problems.push('CONSENT_SIGNATURE')
  if (c.report_data !== reportData(c.commitment, c.request_nonce)) problems.push('COMMITMENT_REPORT_DATA')
  if (sealedHash(s) !== c.ciphertext_hash) problems.push('SEALED_NOT_COMMITTED')
  if (!isHex(k, 32) || keyHash(k) !== c.key_hash) return { plaintext: null, problems: [...problems, 'KEY_DOES_NOT_MATCH_COMMITMENT'] }
  if (c.payment.rail === 'rgb-ln-hodl' && c.payment.payment_hash !== c.key_hash) problems.push('HODL_INVOICE_NOT_LOCKED_TO_KEY')
  let bytes: Uint8Array
  try { bytes = unseal(s, k) } catch (err) { return { plaintext: null, problems: [...problems, (err as Error).message] } }
  if (sha256Hex(bytes) !== c.commitment) return { plaintext: null, problems: [...problems, 'PLAINTEXT_NOT_COMMITTED'] }
  const plaintext = JSON.parse(new TextDecoder().decode(bytes)) as CheckPlaintext
  if (plaintext.v !== 1 || plaintext.kind !== 'passbook-check-plaintext' || plaintext.negotiation_id !== c.negotiation_id || plaintext.request_nonce !== c.request_nonce || plaintext.consent_hash !== c.consent_hash) problems.push('PLAINTEXT_BINDING')
  return { plaintext, problems }
}

/** openResult on the phone: the same checks, no Node. */
export function openResultPortable(c: CheckCommitment, s: SealedResult, k: Hex, expect: { operator_pk: Hex; negotiation_id: Hex; borrower_pk: Hex; lender_pk: Hex }): OpenedResult | { plaintext: null; problems: string[] } {
  return openResultWith(unsealPortable, c, s, k, expect)
}
