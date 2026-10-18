// The key holder behind the check market's borrower half. The phone keeps its
// key in its own keystore and lends the protocol code only these four calls;
// the laptop and the tests wrap a KeyPair. Browser-safe (no node: imports).

import { getEventHash, nip44, type Event } from 'nostr-tools'
import { hashObject, type Hex, type KeyPair } from '../core/crypto.js'
import { signHash } from '../core/crypto.js'
import { TOPIC } from '../market/kinds.js'

export interface CheckSigner {
  /** x-only, 32 bytes hex */
  readonly pubkey: Hex
  /** BIP-340 Schnorr signature over a 32-byte hash (hex). */
  signHash(hash32: Hex): Promise<Hex>
  /** NIP-44 v2 to a peer's x-only key. */
  nip44Encrypt(peerPk: Hex, plaintext: string): Promise<string>
  nip44Decrypt(peerPk: Hex, ciphertext: string): Promise<string>
}

/** A KeyPair as a CheckSigner: the laptop, the regtest borrower process and the tests. */
export function keyPairSigner(k: KeyPair): CheckSigner {
  return {
    pubkey: k.pubkey,
    signHash: async (hash32) => signHash(hash32, k.secretKey),
    nip44Encrypt: async (peerPk, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(k.secretKey, peerPk)),
    nip44Decrypt: async (peerPk, ciphertext) => nip44.decrypt(ciphertext, nip44.getConversationKey(k.secretKey, peerPk)),
  }
}

/** signObject through a signer: BIP-340 over hashObject of everything but `sig`. */
export async function signObjectWith<T extends object>(signer: CheckSigner, value: T): Promise<T & { sig: Hex }> {
  const { sig: _ignored, ...rest } = value as T & { sig?: Hex }
  return { ...(rest as T), sig: await signer.signHash(hashObject(rest)) }
}

/** A NIP-01 event, NIP-44 encrypted to `to`, signed through the signer (the id is the hash it signs). */
export async function encryptedEventWith(signer: CheckSigner, kind: number, payload: unknown, to: Hex, tags: string[][] = [], nowMs = Date.now()): Promise<Event> {
  const content = await signer.nip44Encrypt(to, JSON.stringify(payload))
  const unsigned = { kind, pubkey: signer.pubkey, created_at: Math.floor(nowMs / 1000), tags: [['t', TOPIC], ['p', to], ...tags], content }
  const id = getEventHash(unsigned)
  return { ...unsigned, id, sig: await signer.signHash(id) } as Event
}
