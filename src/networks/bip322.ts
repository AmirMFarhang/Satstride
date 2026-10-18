// BIP-322 "simple" signature verification for P2WPKH and P2TR (key path), the
// two address types a person's own wallet gives them today. Verify only: this
// module never signs and never holds a key. The two BIP-322 transactions are
// virtual: to_spend spends the null outpoint (0000...:0xffffffff) and to_sign
// spends to_spend, so neither can ever be mined. They exist only to compute the
// sighash the person's wallet signed.
//
// Sighashes come from bitcoinjs-lib (BIP-143 and BIP-341, already pinned in
// package-lock.json); signatures are checked with @noble/curves (low-S ECDSA,
// BIP-340 Schnorr). Test vectors: test/fixtures/networks/bip322-vectors.json,
// from bitcoin/bips (CC0).

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import * as bitcoin from 'bitcoinjs-lib'
import type { ChainId } from './types.js'

export const BIP322_TAG = 'BIP0322-signed-message'
const HRP: Record<ChainId, string> = { bitcoin: 'bc', signet: 'tb', regtest: 'bcrt' }
const SIGHASH_DEFAULT = 0x00
const SIGHASH_ALL = 0x01

export type Bip322AddressType = 'p2wpkh' | 'p2tr'

export function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const t = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(t, t, data))
}

export function bip322MessageHash(message: string): Uint8Array {
  return taggedHash(BIP322_TAG, utf8ToBytes(message))
}

/** The address's scriptPubKey and type, for the chain it must belong to. Throws on anything else. */
export function decodeAddress(address: string, chain: ChainId): { type: Bip322AddressType; script: Uint8Array; program: Uint8Array } {
  let decoded: ReturnType<typeof bitcoin.address.fromBech32>
  try {
    decoded = bitcoin.address.fromBech32(address)
  } catch {
    throw new Error('ADDRESS_INVALID')
  }
  if (decoded.prefix !== HRP[chain]) throw new Error('ADDRESS_WRONG_CHAIN')
  const program = Uint8Array.from(decoded.data)
  if (decoded.version === 0 && program.length === 20) return { type: 'p2wpkh', script: concatBytes(Uint8Array.of(0x00, 0x14), program), program }
  if (decoded.version === 1 && program.length === 32) return { type: 'p2tr', script: concatBytes(Uint8Array.of(0x51, 0x20), program), program }
  throw new Error('ADDRESS_TYPE_UNSUPPORTED')
}

/** The address a scriptPubKey pays, for P2WPKH, P2WSH and P2TR on the given chain; null for anything else. */
export function scriptToAddress(scriptHex: string, chain: ChainId): string | null {
  try {
    const network = chain === 'bitcoin' ? bitcoin.networks.bitcoin : chain === 'signet' ? bitcoin.networks.testnet : bitcoin.networks.regtest
    return bitcoin.address.fromOutputScript(Uint8Array.from(Buffer.from(scriptHex, 'hex')), network)
  } catch {
    return null
  }
}

export function toSpendTx(messageHash: Uint8Array, scriptPubKey: Uint8Array): bitcoin.Transaction {
  const tx = new bitcoin.Transaction()
  tx.version = 0
  tx.locktime = 0
  tx.addInput(new Uint8Array(32), 0xffffffff, 0, concatBytes(Uint8Array.of(0x00, 0x20), messageHash))
  tx.addOutput(scriptPubKey, 0n)
  return tx
}

export function toSignTx(toSpend: bitcoin.Transaction, witness: Uint8Array[] = []): bitcoin.Transaction {
  const tx = new bitcoin.Transaction()
  tx.version = 0
  tx.locktime = 0
  tx.addInput(toSpend.getHash(), 0, 0)
  tx.addOutput(Uint8Array.of(0x6a), 0n)
  if (witness.length) tx.setWitness(0, witness)
  return tx
}

function readVarInt(buf: Uint8Array, at: number): [number, number] {
  const first = buf[at]
  if (first === undefined) throw new Error('truncated')
  if (first < 0xfd) return [first, at + 1]
  const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
  if (at + 1 + width > buf.length) throw new Error('truncated')
  let n = 0
  for (let i = width - 1; i >= 0; i--) n = n * 256 + buf[at + 1 + i]
  if (!Number.isSafeInteger(n)) throw new Error('varint too large')
  return [n, at + 1 + width]
}

/** A consensus-encoded witness stack (vector of byte vectors). Every byte must be consumed. */
export function decodeWitness(buf: Uint8Array): Uint8Array[] {
  let [count, at] = readVarInt(buf, 0)
  if (count > 1000) throw new Error('too many witness items')
  const items: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const [len, next] = readVarInt(buf, at)
    if (next + len > buf.length) throw new Error('truncated')
    items.push(buf.slice(next, next + len))
    at = next + len
  }
  if (at !== buf.length) throw new Error('trailing bytes')
  return items
}

/** Strip the `smp` prefix (BIP-322 v2); an unprefixed signature is read as simple. Full and proof-of-funds are refused. */
export function decodeSimpleSignature(signature: string): Uint8Array {
  const s = signature.trim()
  if (/^(ful|pof)/.test(s)) throw new Error('FORMAT_UNSUPPORTED')
  const body = s.startsWith('smp') ? s.slice(3) : s
  if (!body || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error('SIGNATURE_NOT_BASE64')
  const bytes = Uint8Array.from(Buffer.from(body, 'base64'))
  if (bytes.length < 2) throw new Error('SIGNATURE_TOO_SHORT')
  return bytes
}

export interface Bip322Result {
  ok: boolean
  type?: Bip322AddressType
  /** Compressed public key (P2WPKH) or x-only output key (P2TR), hex. */
  key?: string
  reasons: string[]
}

const fail = (reason: string, type?: Bip322AddressType): Bip322Result => ({ ok: false, reasons: [reason], ...(type ? { type } : {}) })

/** Verifies a BIP-322 simple signature of `message` by `address` on `chain`. */
export function verifyBip322Simple(address: string, message: string, signature: string, chain: ChainId = 'bitcoin'): Bip322Result {
  let decoded: ReturnType<typeof decodeAddress>
  try {
    decoded = decodeAddress(address, chain)
  } catch (e) {
    return fail((e as Error).message)
  }
  let witness: Uint8Array[]
  try {
    witness = decodeWitness(decodeSimpleSignature(signature))
  } catch (e) {
    const m = (e as Error).message
    return fail(/^[A-Z0-9_]+$/.test(m) ? m : 'WITNESS_MALFORMED', decoded.type)
  }
  const toSpend = toSpendTx(bip322MessageHash(message), decoded.script)
  const toSign = toSignTx(toSpend, witness)
  if (decoded.type === 'p2wpkh') {
    if (witness.length !== 2) return fail('WITNESS_SHAPE', 'p2wpkh')
    const [sigWithType, pub] = witness
    if (pub.length !== 33 || (pub[0] !== 0x02 && pub[0] !== 0x03)) return fail('PUBKEY_NOT_COMPRESSED', 'p2wpkh')
    if (bytesToHex(ripemd160(sha256(pub))) !== bytesToHex(decoded.program)) return fail('PUBKEY_NOT_FOR_ADDRESS', 'p2wpkh')
    if (sigWithType.length < 9 || sigWithType[sigWithType.length - 1] !== SIGHASH_ALL) return fail('SIGHASH_UNSUPPORTED', 'p2wpkh')
    const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), decoded.program, Uint8Array.of(0x88, 0xac))
    const sighash = toSign.hashForWitnessV0(0, scriptCode, 0n, SIGHASH_ALL)
    let ok = false
    try {
      ok = secp256k1.verify(sigWithType.slice(0, -1), sighash, pub, { prehash: false, format: 'der', lowS: true })
    } catch {
      ok = false
    }
    return ok ? { ok: true, type: 'p2wpkh', key: bytesToHex(pub), reasons: [] } : fail('SIGNATURE_INVALID', 'p2wpkh')
  }
  // P2TR key path only: one witness item, no annex, no script path.
  if (witness.length !== 1) return fail('P2TR_KEY_PATH_ONLY', 'p2tr')
  const sig = witness[0]
  if (sig.length !== 64 && !(sig.length === 65 && sig[64] === SIGHASH_ALL)) return fail('SIGHASH_UNSUPPORTED', 'p2tr')
  const hashType = sig.length === 64 ? SIGHASH_DEFAULT : SIGHASH_ALL
  const sighash = toSign.hashForWitnessV1(0, [decoded.script], [0n], hashType)
  let ok = false
  try {
    ok = schnorr.verify(sig.slice(0, 64), sighash, decoded.program)
  } catch {
    ok = false
  }
  return ok ? { ok: true, type: 'p2tr', key: bytesToHex(decoded.program), reasons: [] } : fail('SIGNATURE_INVALID', 'p2tr')
}
