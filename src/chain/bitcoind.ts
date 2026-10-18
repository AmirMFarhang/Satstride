// bitcoind JSON-RPC client. Needs txindex=1 on the node (set in infra/compose.yaml)
// so getrawtransaction works for any confirmed transaction.

import type { Hex } from '../core/crypto.js'
import type { ChainClient, ChainTx } from './types.js'

export interface BitcoindConfig {
  url: string
  user: string
  password: string
}

interface RawTx {
  txid: string
  vin: { txid?: string; vout?: number; coinbase?: string; txinwitness?: string[] }[]
  vout: { value: number; n: number; scriptPubKey: { hex: string } }[]
  blockhash?: string
  confirmations?: number
}

export class BitcoindChain implements ChainClient {
  readonly kind = 'bitcoind'

  constructor(private readonly cfg: BitcoindConfig) {}

  static fromEnv(): BitcoindChain {
    return new BitcoindChain({
      url: process.env.BITCOIND_URL ?? 'http://127.0.0.1:18443',
      user: process.env.BITCOIND_USER ?? 'user',
      password: process.env.BITCOIND_PASSWORD ?? 'password',
    })
  }

  async rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const res = await fetch(wallet ? `${this.cfg.url}/wallet/${wallet}` : this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString('base64')}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'passbook', method, params }),
    })
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } }
    if (body.error) throw new Error(`bitcoind ${method}: ${body.error.message} (${body.error.code})`)
    return body.result as T
  }

  async getHeight(): Promise<number> {
    return this.rpc<number>('getblockcount')
  }

  async getTx(txid: Hex): Promise<ChainTx | null> {
    let raw: RawTx
    try {
      raw = await this.rpc<RawTx>('getrawtransaction', [txid, true])
    } catch (err) {
      if (/No such mempool or blockchain transaction/i.test((err as Error).message)) return null
      throw err
    }
    let height: number | null = null
    if (raw.blockhash) {
      const header = await this.rpc<{ height: number }>('getblockheader', [raw.blockhash])
      height = header.height
    }
    return {
      txid: raw.txid,
      height,
      inputs: raw.vin.filter((v) => v.txid !== undefined).map((v) => ({ txid: v.txid!, vout: v.vout!, witness: v.txinwitness })),
      outputs: raw.vout.map((o) => ({ value: Math.round(o.value * 1e8), script: o.scriptPubKey.hex })),
    }
  }
}
