// What the platform needs from Bitcoin: the tip height, and for a txid whether
// it is confirmed, at which height, and what it spends and creates. The real
// client talks to bitcoind over JSON-RPC (regtest with txindex=1); tests use
// the in-memory fake.

import type { Hex } from '../core/crypto.js'
import type { Sats } from '../core/money.js'

export interface ChainInput {
  txid: Hex
  vout: number
  /** Bitcoin witness stack, as hex; populated by bitcoind for script-path proof verification. */
  witness?: Hex[]
}

export interface ChainOutput {
  value: Sats
  /** scriptPubKey hex */
  script: Hex
}

export interface ChainTx {
  txid: Hex
  /** null while unconfirmed */
  height: number | null
  inputs: ChainInput[]
  outputs: ChainOutput[]
}

export interface ChainClient {
  readonly kind: string
  getHeight(): Promise<number>
  getTx(txid: Hex): Promise<ChainTx | null>
}

/** OP_RETURN <32 bytes>: 6a 20 <hash> */
export function opReturnScript(hash32: Hex): Hex {
  if (hash32.length !== 64) throw new RangeError('expected 32-byte hash')
  return `6a20${hash32}`
}

export function opReturnPayload(script: Hex): Hex | null {
  return script.length === 68 && script.startsWith('6a20') ? script.slice(4) : null
}

export function isConfirmed(tx: ChainTx | null): tx is ChainTx & { height: number } {
  return !!tx && tx.height !== null
}
