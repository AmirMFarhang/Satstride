// In-memory chain for tests and for running the server without regtest.
// Transactions are added unconfirmed and confirmed by mine().

import { randomHex, type Hex } from '../core/crypto.js'
import type { ChainClient, ChainInput, ChainOutput, ChainTx } from './types.js'

export class FakeChain implements ChainClient {
  readonly kind = 'fake'
  private height: number
  private readonly txs = new Map<Hex, ChainTx>()
  private readonly mempool: Hex[] = []

  constructor(startHeight = 100) {
    this.height = startHeight
  }

  async getHeight(): Promise<number> {
    return this.height
  }

  async getTx(txid: Hex): Promise<ChainTx | null> {
    const tx = this.txs.get(txid)
    return tx ? structuredClone(tx) : null
  }

  /** Add an unconfirmed transaction. Returns its (random) txid unless one is given. */
  addTx(outputs: ChainOutput[], inputs: ChainInput[] = [], txid: Hex = randomHex()): Hex {
    this.txs.set(txid, { txid, height: null, inputs, outputs })
    this.mempool.push(txid)
    return txid
  }

  mine(blocks = 1): number {
    for (let i = 0; i < blocks; i++) {
      this.height += 1
      for (const txid of this.mempool.splice(0)) this.txs.get(txid)!.height = this.height
    }
    return this.height
  }
}
