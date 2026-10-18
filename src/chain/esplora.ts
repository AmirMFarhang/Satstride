// Esplora REST: what the platform needs from Bitcoin (ChainClient) on a public
// test network, where there is no bitcoind of ours to ask. Also the small
// read/broadcast surface the wallet panel and the Mutinynet run use. Read-only
// except broadcast, which only relays a transaction the caller already signed.

import type { Hex } from '../core/crypto.js'
import type { ChainClient, ChainTx } from './types.js'

interface EsploraTx {
  txid: string
  vin: { txid: string; vout: number; witness?: string[]; is_coinbase?: boolean; prevout?: { scriptpubkey: string; value: number } | null }[]
  vout: { scriptpubkey: string; scriptpubkey_address?: string; value: number }[]
  fee?: number
  status: { confirmed: boolean; block_height?: number; block_time?: number }
}

export interface EsploraUtxo { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }

export class EsploraChain implements ChainClient {
  readonly kind = 'esplora'

  constructor(readonly base: string, private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly retries = 3) {}

  private async get(path: string, as: 'json' | 'text' = 'json'): Promise<unknown> {
    let last: unknown
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.base}${path}`, { signal: AbortSignal.timeout(15_000) })
        if (res.status === 404) return null
        // public Esplora rate-limits shared egress IPs (429): back off and retry
        if (res.status === 429 || res.status >= 500) throw new Error(`esplora ${path}: HTTP ${res.status}`)
        if (!res.ok) throw Object.assign(new Error(`esplora ${path}: HTTP ${res.status} ${await res.text()}`), { final: true })
        return as === 'json' ? await res.json() : (await res.text()).trim()
      } catch (err) {
        if ((err as { final?: boolean }).final) throw err
        last = err
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      }
    }
    throw last
  }

  async getHeight(): Promise<number> {
    return Number(await this.get('/blocks/tip/height', 'text'))
  }

  async getTx(txid: Hex): Promise<ChainTx | null> {
    const t = (await this.get(`/tx/${txid}`)) as EsploraTx | null
    if (!t) return null
    return {
      txid: t.txid,
      height: t.status.confirmed ? t.status.block_height ?? null : null,
      inputs: t.vin.filter((v) => !v.is_coinbase).map((v) => ({ txid: v.txid, vout: v.vout, witness: v.witness })),
      outputs: t.vout.map((o) => ({ value: o.value, script: o.scriptpubkey })),
    }
  }

  async rawTx(txid: Hex): Promise<string | null> {
    return (await this.get(`/tx/${txid}/hex`, 'text')) as string | null
  }

  async utxos(address: string): Promise<EsploraUtxo[]> {
    return ((await this.get(`/address/${address}/utxo`)) as EsploraUtxo[] | null) ?? []
  }

  async addressStats(address: string): Promise<{ confirmed: number; unconfirmed: number }> {
    const a = (await this.get(`/address/${address}`)) as { chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { funded_txo_sum: number; spent_txo_sum: number } } | null
    if (!a) return { confirmed: 0, unconfirmed: 0 }
    return { confirmed: a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum, unconfirmed: a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum }
  }

  /** Every transaction touching an address, newest first (mempool, then confirmed pages of 25). */
  async addressTxs(address: string, maxPages = 8): Promise<EsploraTx[]> {
    const out: EsploraTx[] = ((await this.get(`/address/${address}/txs`)) as EsploraTx[] | null) ?? []
    let confirmed = out.filter((t) => t.status.confirmed)
    for (let page = 1; page < maxPages && confirmed.length >= 25 * page; page++) {
      const more = ((await this.get(`/address/${address}/txs/chain/${confirmed[confirmed.length - 1].txid}`)) as EsploraTx[] | null) ?? []
      if (!more.length) break
      out.push(...more)
      confirmed = out.filter((t) => t.status.confirmed)
    }
    return out
  }

  /** Confirmation of a transaction: its block height and the block's header timestamp (Unix seconds). */
  async txStatus(txid: Hex): Promise<{ confirmed: boolean; block_height?: number; block_time?: number } | null> {
    return (await this.get(`/tx/${txid}/status`)) as { confirmed: boolean; block_height?: number; block_time?: number } | null
  }

  /** For each output of a transaction: whether it is spent, and by which transaction. */
  async outspends(txid: Hex): Promise<{ spent: boolean; txid?: string; vin?: number; status?: { confirmed: boolean; block_height?: number } }[]> {
    return ((await this.get(`/tx/${txid}/outspends`)) as { spent: boolean; txid?: string }[] | null) ?? []
  }

  /** sat/vB by confirmation target. */
  async feeEstimates(): Promise<Record<string, number>> {
    return ((await this.get('/fee-estimates')) as Record<string, number> | null) ?? {}
  }

  async broadcast(hex: string): Promise<Hex> {
    const res = await this.fetchImpl(`${this.base}/tx`, { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(20_000) })
    const body = (await res.text()).trim()
    if (!res.ok) throw new Error(`broadcast refused: ${body}`)
    return body
  }
}
