// Where Bitcoin history comes from, and why neither side has to trust the
// other's indexer. A source only discovers transactions; every transaction it
// returns is checked here before anyone uses it:
//   - the raw bytes hash to the txid,
//   - a merkle branch links the txid to a block header,
//   - the header hashes to the block hash and carries real proof of work
//     (its hash is under its own target, and on mainnet that target is at or
//     under a work floor, so a header cannot be made up cheaply).
// What a source can still do is leave transactions out or report a stale
// chain, so each side reads from its OWN source and the lender compares.
//
// Sources: Esplora over HTTPS (mainnet default https://mempool.space/api), a
// recorded snapshot labelled "recorded mainnet data, block N" for offline use,
// and Electrum (the regtest stack's electrs). Every call is logged with its
// endpoint and the tip height the source reported.

import { sha256 } from '@noble/hashes/sha2.js'
import * as bitcoin from 'bitcoinjs-lib'
import { readFileSync, writeFileSync } from 'node:fs'
import { bytesToHex, hexToBytes, isHex, type Hex } from '../core/crypto.js'
import { TcpElectrum, type ElectrumReader } from '../wallet/btc-history.js'
import { decodeAddress } from './bip322.js'
import type { ChainId, SourceCall } from './types.js'

export interface TxRecord {
  txid: Hex
  hex: Hex
  block_height: number
  block_hash: Hex
  block_time: number
  merkle: { merkle: Hex[]; pos: number }
  header: Hex
}

export interface BitcoinSource {
  /** Shown on every number that came from this source. */
  readonly label: string
  readonly kind: 'esplora' | 'snapshot' | 'electrum'
  readonly chain: ChainId
  readonly calls: SourceCall[]
  tipHeight(): Promise<number>
  /** Confirmed transactions touching the address, oldest first. */
  addressTxids(address: string): Promise<{ txid: Hex; height: number }[]>
  /** A confirmed transaction with what is needed to check it: raw bytes, merkle branch, header. */
  tx(txid: Hex): Promise<TxRecord>
  /** Raw bytes of any transaction (previous outputs); the caller checks they hash to the txid. */
  rawTx(txid: Hex): Promise<Hex>
}

export const MAX_ADDRESS_TXS = 500
const dsha = (b: Uint8Array) => sha256(sha256(b))
const reversedHex = (b: Uint8Array) => bytesToHex(Uint8Array.from(b).reverse())

/** Target encoded by a header's nBits. */
export function bitsToTarget(bits: number): bigint {
  const exponent = bits >>> 24, mantissa = BigInt(bits & 0x007fffff)
  if (bits & 0x00800000) return 0n
  return exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3))
}

/**
 * Mainnet headers must carry at least this much work per block: difficulty
 * 10^12 (mainnet has been far above it since 2019). Forging one costs on the
 * order of 4 * 10^21 hashes. It is a floor against made-up headers, not a check
 * that the block is on the best chain; each side trusts its own source for that.
 */
export const MAINNET_MAX_TARGET = (0xffffn << 208n) / 1_000_000_000_000n

export function headerProblems(headerHex: Hex, blockHash: Hex, chain: ChainId): string[] {
  if (!isHex(headerHex, 80)) return ['HEADER_MALFORMED']
  const header = hexToBytes(headerHex)
  const problems: string[] = []
  const hash = dsha(header)
  if (reversedHex(hash) !== blockHash) problems.push('HEADER_HASH_MISMATCH')
  const bits = header[72] | (header[73] << 8) | (header[74] << 16) | (header[75] << 24)
  const target = bitsToTarget(bits >>> 0)
  if (BigInt(`0x${reversedHex(hash)}`) > target || target === 0n) problems.push('HEADER_WORK_INVALID')
  if (chain === 'bitcoin' && target > MAINNET_MAX_TARGET) problems.push('HEADER_WORK_BELOW_FLOOR')
  return problems
}

export function merkleRootFromBranch(txid: Hex, branch: Hex[], pos: number): Hex {
  let node = hexToBytes(txid).reverse()
  let index = pos
  for (const sibling of branch) {
    const s = hexToBytes(sibling).reverse()
    node = dsha(index & 1 ? concat(s, node) : concat(node, s))
    index >>>= 1
  }
  return bytesToHex(node.reverse())
}

const concat = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out }

/** Everything a reader checks about one transaction before using it. Empty when the record proves itself. */
export function txRecordProblems(r: TxRecord, chain: ChainId): string[] {
  const problems: string[] = []
  try {
    if (bitcoin.Transaction.fromHex(r.hex).getId() !== r.txid) problems.push('TX_BYTES_MISMATCH')
  } catch {
    return ['TX_BYTES_MALFORMED']
  }
  problems.push(...headerProblems(r.header, r.block_hash, chain))
  if (!Array.isArray(r.merkle?.merkle) || !Number.isSafeInteger(r.merkle.pos) || r.merkle.pos < 0 || !r.merkle.merkle.every((h) => isHex(h, 32))) problems.push('MERKLE_MALFORMED')
  else if (isHex(r.header, 80) && merkleRootFromBranch(r.txid, r.merkle.merkle, r.merkle.pos) !== reversedHex(hexToBytes(r.header).slice(36, 68))) problems.push('MERKLE_MISMATCH')
  return problems
}

export function rawTxProblems(txid: Hex, hex: Hex): string[] {
  try {
    return bitcoin.Transaction.fromHex(hex).getId() === txid ? [] : ['TX_BYTES_MISMATCH']
  } catch {
    return ['TX_BYTES_MALFORMED']
  }
}

abstract class LoggedSource {
  readonly calls: SourceCall[] = []
  protected tip: number | null = null
  abstract readonly label: string
  protected log(endpoint: string, ok: boolean, note?: string): void {
    this.calls.push({ at: Math.floor(Date.now() / 1000), source: this.label, endpoint, ok, height: this.tip, ...(note ? { note } : {}) })
  }
}

/** An Esplora HTTP API (mempool.space, Blockstream, or the lender's own instance). */
export class EsploraSource extends LoggedSource implements BitcoinSource {
  readonly kind = 'esplora' as const
  readonly label: string
  private readonly headers = new Map<Hex, Hex>()
  constructor(readonly baseUrl: string, readonly chain: ChainId = 'bitcoin', private readonly timeoutMs = 15_000, private readonly fetcher: typeof fetch = fetch) {
    super()
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('Esplora source must be an http(s) URL')
    this.label = baseUrl.replace(/\/$/, '')
  }
  private async get(path: string, as: 'text' | 'json'): Promise<unknown> {
    try {
      const res = await this.fetcher(`${this.label}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = as === 'json' ? await res.json() : (await res.text()).trim()
      this.log(path, true)
      return body
    } catch (e) {
      this.log(path, false, (e as Error).message.slice(0, 120))
      throw new Error(`Esplora ${path}: ${(e as Error).message}`)
    }
  }
  async tipHeight(): Promise<number> {
    const n = Number(await this.get('/blocks/tip/height', 'text'))
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Esplora tip height malformed')
    this.tip = n
    return n
  }
  async addressTxids(address: string): Promise<{ txid: Hex; height: number }[]> {
    decodeAddress(address, this.chain)
    const out: { txid: Hex; height: number }[] = []
    let last: Hex | null = null
    for (let page = 0; page < MAX_ADDRESS_TXS / 25 + 1; page++) {
      const rows = await this.get(`/address/${address}/txs/chain${last ? `/${last}` : ''}`, 'json') as { txid: Hex; status: { confirmed: boolean; block_height?: number } }[]
      if (!Array.isArray(rows)) throw new Error('Esplora address history malformed')
      for (const r of rows) if (r.status?.confirmed && isHex(r.txid, 32) && Number.isSafeInteger(r.status.block_height)) out.push({ txid: r.txid, height: r.status.block_height! })
      if (out.length > MAX_ADDRESS_TXS) throw new Error('ADDRESS_HISTORY_TOO_LARGE')
      if (rows.length < 25) break
      last = rows[rows.length - 1].txid
    }
    return out.sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid))
  }
  async tx(txid: Hex): Promise<TxRecord> {
    const hex = await this.get(`/tx/${txid}/hex`, 'text') as Hex
    const status = await this.get(`/tx/${txid}/status`, 'json') as { confirmed: boolean; block_height: number; block_hash: Hex; block_time: number }
    if (!status?.confirmed) throw new Error('TX_UNCONFIRMED')
    const merkle = await this.get(`/tx/${txid}/merkle-proof`, 'json') as { merkle: Hex[]; pos: number; block_height: number }
    if (merkle.block_height !== status.block_height) throw new Error('MERKLE_HEIGHT_MISMATCH')
    let header = this.headers.get(status.block_hash)
    if (!header) { header = await this.get(`/block/${status.block_hash}/header`, 'text') as Hex; this.headers.set(status.block_hash, header) }
    return { txid, hex, block_height: status.block_height, block_hash: status.block_hash, block_time: status.block_time, merkle: { merkle: merkle.merkle, pos: merkle.pos }, header }
  }
  async rawTx(txid: Hex): Promise<Hex> {
    return await this.get(`/tx/${txid}/hex`, 'text') as Hex
  }
}

export interface RecordedSnapshot {
  v: 1
  kind: 'passbook-bitcoin-snapshot'
  chain: ChainId
  recorded_from: string
  recorded_at: number
  tip_height: number
  addresses: Record<string, { txid: Hex; height: number }[]>
  txs: Record<Hex, TxRecord>
  /** Raw bytes of previous transactions, for input scripts. */
  raw: Record<Hex, Hex>
}

/** Offline fallback: data recorded earlier from a live source, labelled with the block it was recorded at. */
export class SnapshotSource extends LoggedSource implements BitcoinSource {
  readonly kind = 'snapshot' as const
  readonly label: string
  readonly chain: ChainId
  constructor(readonly snapshot: RecordedSnapshot) {
    super()
    if (snapshot?.v !== 1 || snapshot.kind !== 'passbook-bitcoin-snapshot') throw new Error('not a Passbook Bitcoin snapshot')
    this.chain = snapshot.chain
    this.label = `recorded ${snapshot.chain === 'bitcoin' ? 'mainnet' : snapshot.chain} data, block ${snapshot.tip_height}`
    this.tip = snapshot.tip_height
  }
  static fromFile(path: string): SnapshotSource { return new SnapshotSource(JSON.parse(readFileSync(path, 'utf8')) as RecordedSnapshot) }
  async tipHeight(): Promise<number> { this.log('tip', true); return this.snapshot.tip_height }
  async addressTxids(address: string): Promise<{ txid: Hex; height: number }[]> {
    const rows = this.snapshot.addresses[address]
    this.log(`address/${address}`, !!rows, rows ? undefined : 'address not in the recording')
    if (!rows) throw new Error('ADDRESS_NOT_RECORDED')
    return rows.map((r) => ({ ...r }))
  }
  async tx(txid: Hex): Promise<TxRecord> {
    const r = this.snapshot.txs[txid]
    this.log(`tx/${txid}`, !!r)
    if (!r) throw new Error('TX_NOT_RECORDED')
    return { ...r, merkle: { merkle: [...r.merkle.merkle], pos: r.merkle.pos } }
  }
  async rawTx(txid: Hex): Promise<Hex> {
    const hex = this.snapshot.raw[txid] ?? this.snapshot.txs[txid]?.hex
    this.log(`raw/${txid}`, !!hex)
    if (!hex) throw new Error('TX_NOT_RECORDED')
    return hex
  }
}

/** Electrum (electrs) for the regtest and signet stacks: the same checks, a different transport. */
export class ElectrumSource extends LoggedSource implements BitcoinSource {
  readonly kind = 'electrum' as const
  readonly label: string
  private readonly client: ElectrumReader
  /** Electrum needs a height for the merkle branch; it comes from the address history read first. */
  private readonly heights = new Map<Hex, number>()
  constructor(readonly endpoint: string, readonly chain: ChainId, client?: ElectrumReader) {
    super()
    this.label = endpoint
    this.client = client ?? new TcpElectrum(endpoint)
  }
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    try {
      const r = await this.client.request<T>(method, params)
      this.log(`${method} ${JSON.stringify(params).slice(0, 90)}`, true)
      return r
    } catch (e) {
      this.log(`${method} ${JSON.stringify(params).slice(0, 90)}`, false, (e as Error).message.slice(0, 120))
      throw e
    }
  }
  async tipHeight(): Promise<number> {
    const r = await this.call<{ height: number }>('blockchain.headers.subscribe', [])
    this.tip = r.height
    return r.height
  }
  async addressTxids(address: string): Promise<{ txid: Hex; height: number }[]> {
    const { script } = decodeAddress(address, this.chain)
    const scripthash = reversedHex(sha256(script))
    const rows = await this.call<{ tx_hash: Hex; height: number }[]>('blockchain.scripthash.get_history', [scripthash])
    if (!Array.isArray(rows) || rows.length > MAX_ADDRESS_TXS) throw new Error('ADDRESS_HISTORY_TOO_LARGE')
    const out = rows.filter((r) => r.height > 0).map((r) => ({ txid: r.tx_hash, height: r.height })).sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid))
    for (const r of out) this.heights.set(r.txid, r.height)
    return out
  }
  async tx(txid: Hex): Promise<TxRecord> {
    const hex = await this.call<Hex>('blockchain.transaction.get', [txid])
    const height = this.heights.get(txid)
    if (height === undefined) throw new Error('ELECTRUM_HEIGHT_UNKNOWN: read the address history first')
    const merkle = await this.call<{ block_height: number; merkle: Hex[]; pos: number }>('blockchain.transaction.get_merkle', [txid, height])
    const header = await this.call<Hex>('blockchain.block.header', [height])
    const block_hash = reversedHex(dsha(hexToBytes(header)))
    const time = new DataView(hexToBytes(header).buffer).getUint32(68, true)
    return { txid, hex, block_height: merkle.block_height, block_hash, block_time: time, merkle: { merkle: merkle.merkle, pos: merkle.pos }, header }
  }
  async rawTx(txid: Hex): Promise<Hex> { return this.call<Hex>('blockchain.transaction.get', [txid]) }
}

/**
 * Live first; if the live source cannot even report its tip, every call of this
 * read goes to the recorded snapshot instead, and the label says so. A read
 * never mixes live and recorded data.
 */
export class FallbackSource implements BitcoinSource {
  private active: BitcoinSource
  constructor(private readonly live: BitcoinSource, private readonly recorded: BitcoinSource | null) {
    this.active = live
    if (recorded && recorded.chain !== live.chain) throw new Error('snapshot chain differs from the live source chain')
  }
  get label(): string { return this.active.label }
  get kind() { return this.active.kind }
  get chain(): ChainId { return this.active.chain }
  get calls(): SourceCall[] { return [...this.live.calls, ...(this.recorded && this.active === this.recorded ? this.recorded.calls : [])] }
  get usingRecording(): boolean { return this.active !== this.live }
  async tipHeight(): Promise<number> {
    try {
      return await this.live.tipHeight()
    } catch (e) {
      if (!this.recorded) throw e
      this.active = this.recorded
      return this.recorded.tipHeight()
    }
  }
  addressTxids(address: string) { return this.active.addressTxids(address) }
  tx(txid: Hex) { return this.active.tx(txid) }
  rawTx(txid: Hex) { return this.active.rawTx(txid) }
}

/** Records what a later offline read needs, from a live source, for the given addresses. Public chain data only. */
/** Previous transactions above this size (exchange batch payouts) are not kept; their inputs read as an unknown payer. */
export const MAX_PREV_TX_BYTES = 20_000

export async function recordSnapshot(source: BitcoinSource, addresses: string[], opts: { maxPrevTxs?: number; maxPrevBytes?: number } = {}): Promise<RecordedSnapshot> {
  const tip = await source.tipHeight()
  const snap: RecordedSnapshot = { v: 1, kind: 'passbook-bitcoin-snapshot', chain: source.chain, recorded_from: source.label, recorded_at: Math.floor(Date.now() / 1000), tip_height: tip, addresses: {}, txs: {}, raw: {} }
  let prevBudget = opts.maxPrevTxs ?? 200
  for (const address of addresses) {
    const rows = await source.addressTxids(address)
    snap.addresses[address] = rows
    for (const { txid } of rows) {
      if (snap.txs[txid]) continue
      const rec = await source.tx(txid)
      const problems = txRecordProblems(rec, source.chain)
      if (problems.length) throw new Error(`refusing to record ${txid}: ${problems.join(', ')}`)
      snap.txs[txid] = rec
      for (const input of bitcoin.Transaction.fromHex(rec.hex).ins) {
        const prev = reversedHex(input.hash)
        if (/^0+$/.test(prev) || snap.raw[prev] || snap.txs[prev] || prevBudget <= 0) continue
        const raw = await source.rawTx(prev)
        prevBudget--
        if (raw.length / 2 <= (opts.maxPrevBytes ?? MAX_PREV_TX_BYTES)) snap.raw[prev] = raw
      }
    }
  }
  return snap
}

export function saveSnapshot(path: string, snap: RecordedSnapshot): void {
  writeFileSync(path, `${JSON.stringify(snap, null, 1)}\n`)
}
