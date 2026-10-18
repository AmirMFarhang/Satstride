// Scorer descriptors: the operator's declaration and the enclave key's
// self-signature. Browser-safe (no node: imports): the phone checks a check
// node's offer with the same code as the laptop.

import { hashObject, isHex, signHash, verifyHash, verifyObject, type KeyPair } from '../core/crypto.js'
import type { ScorerDescriptor } from './types.js'

export function descriptorCore(d: ScorerDescriptor): Omit<ScorerDescriptor, 'operator_declaration' | 'sig'> {
  const { operator_declaration: _declaration, sig: _sig, ...core } = d
  return core
}

const DECLARATION_DOMAIN = 'passbook-scorer-declaration-v1'

/** The operator states which enclave key runs the measured image. A declaration, not an attestation. */
export function declareScorer(operator: KeyPair, d: ScorerDescriptor): ScorerDescriptor {
  return { ...d, operator_declaration: { operator_pk: operator.pubkey, sig: signHash(hashObject({ domain: DECLARATION_DOMAIN, ...descriptorCore(d) }), operator.secretKey) } }
}

export function declarationValid(d: ScorerDescriptor): boolean {
  const decl = d.operator_declaration
  return !!decl && isHex(decl.operator_pk, 32) && verifyHash(decl.sig, hashObject({ domain: DECLARATION_DOMAIN, ...descriptorCore(d) }), decl.operator_pk)
}

export function selfSignatureValid(d: ScorerDescriptor): boolean {
  return isHex(d.enclave_pubkey, 32) && typeof d.sig === 'string' && verifyObject({ ...descriptorCore(d), sig: d.sig }, d.enclave_pubkey)
}
