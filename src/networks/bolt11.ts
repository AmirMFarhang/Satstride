// Just enough BOLT11 to use an invoice as a node's signed statement: the node
// key signs sha256(hrp || data) of every invoice it creates, and the data
// carries the description. An invoice whose description is the challenge text
// therefore proves the node key saw and signed that text. Verify only; this
// module never creates or pays an invoice.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { ChainId } from './types.js'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const HRP_PREFIX: Record<ChainId, string> = { bitcoin: 'lnbc', signet: 'lntbs', regtest: 'lnbcrt' }

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]
  }
  return chk
}

/** bech32 (not bech32m) without the 90-character limit, as BOLT11 uses it. */
export function bech32DecodeLong(text: string): { hrp: string; words: number[] } {
  const s = text.toLowerCase()
  if (s !== text && text.toUpperCase() !== text) throw new Error('mixed case')
  const at = s.lastIndexOf('1')
  if (at < 1 || s.length - at < 7 || s.length > 7089) throw new Error('not bech32')
  const hrp = s.slice(0, at)
  const words = [...s.slice(at + 1)].map((c) => { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('bad character'); return i })
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)]
  if (polymod([...expand, ...words]) !== 1) throw new Error('bad checksum')
  return { hrp, words: words.slice(0, -6) }
}

function wordsToBytes(words: number[], pad: boolean): Uint8Array {
  let acc = 0, bits = 0
  const out: number[] = []
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff) }
    acc &= (1 << bits) - 1
  }
  if (pad && bits > 0) out.push((acc << (8 - bits)) & 0xff)
  return Uint8Array.from(out)
}

const toInt = (words: number[]) => words.reduce((n, w) => n * 32 + w, 0)

export interface DecodedInvoice {
  network: ChainId
  timestamp: number
  expiry: number
  description: string | null
  description_hash: string | null
  payment_hash: string | null
  /** The key that signed the invoice (recovered), compressed hex. */
  signer: string
  /** The payee key the invoice names, when it names one. */
  payee: string | null
}

/** Decodes a BOLT11 invoice and recovers the key that signed it. Throws on anything malformed or unsigned. */
export function decodeInvoice(invoice: string): DecodedInvoice {
  const { hrp, words } = bech32DecodeLong(invoice.trim())
  const network = (['regtest', 'signet', 'bitcoin'] as ChainId[]).find((c) => new RegExp(`^${HRP_PREFIX[c]}(\\d+[munp]?)?$`).test(hrp))
  if (!network) throw new Error('not a Lightning invoice for a supported chain')
  if (words.length < 7 + 104) throw new Error('invoice too short')
  const data = words.slice(0, -104)
  const sigBytes = wordsToBytes(words.slice(-104), false)
  if (sigBytes.length !== 65 || sigBytes[64] > 3) throw new Error('invoice signature malformed')
  const out: DecodedInvoice = { network, timestamp: toInt(data.slice(0, 7)), expiry: 3600, description: null, description_hash: null, payment_hash: null, signer: '', payee: null }
  for (let i = 7; i < data.length;) {
    const type = data[i], len = data[i + 1] * 32 + data[i + 2]
    const field = data.slice(i + 3, i + 3 + len)
    if (field.length !== len) throw new Error('invoice field truncated')
    const bytes = wordsToBytes(field, false)
    if (type === 13) out.description = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    else if (type === 23 && len === 52) out.description_hash = bytesToHex(bytes)
    else if (type === 1 && len === 52) out.payment_hash = bytesToHex(bytes)
    else if (type === 19 && len === 53) out.payee = bytesToHex(bytes)
    else if (type === 6) out.expiry = toInt(field)
    i += 3 + len
  }
  const hash = sha256(new Uint8Array([...utf8ToBytes(hrp), ...wordsToBytes(data, true)]))
  const sig = secp256k1.Signature.fromBytes(sigBytes.slice(0, 64), 'compact').addRecoveryBit(sigBytes[64])
  out.signer = bytesToHex(sig.recoverPublicKey(hash).toBytes(true))
  if (out.payee && out.payee !== out.signer) throw new Error('invoice payee does not match its signature')
  return out
}
