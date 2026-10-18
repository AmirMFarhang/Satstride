// Electrum discovers transactions; Bitcoin RPC independently verifies their
// inputs/outputs. Coverage is the supplied xpub branches up to a stated gap,
// never an assertion that a person disclosed every wallet they control.
import { connect } from 'node:net'
import { HDKey } from '@scure/bip32'
import type { ChainClient } from '../chain/types.js'
import { bytesToHex, hashObject, hexToBytes, sha256Hex, type Hex } from '../core/crypto.js'
import { keyPathOutput } from '../escrow/escrow.js'

export interface ElectrumReader { request<T>(method: string, params: unknown[]): Promise<T> }
export class TcpElectrum implements ElectrumReader {
  constructor(private readonly endpoint: string, private readonly timeoutMs = 5000) {}
  async request<T>(method: string, params: unknown[]): Promise<T> {
    const url = new URL(this.endpoint)
    if (url.protocol !== 'tcp:') throw new Error('BTC history reader requires a configured local tcp Electrum endpoint')
    return new Promise<T>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) })
      let buffer = ''
      const fail = (error: Error) => { socket.destroy(); reject(error) }
      socket.setTimeout(this.timeoutMs, () => fail(new Error('Electrum timeout')))
      socket.on('error', fail)
      socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'))
      socket.on('data', (data) => {
        buffer += data.toString()
        if (buffer.length > 2_000_000) return fail(new Error('Electrum response too large'))
        const at = buffer.indexOf('\n')
        if (at < 0) return
        try {
          const reply = JSON.parse(buffer.slice(0, at)) as { id: number; result: T; error?: { message: string } }
          if (reply.id !== 1 || reply.error) return fail(new Error(reply.error?.message ?? 'Electrum response id mismatch'))
          socket.destroy(); resolve(reply.result)
        } catch { fail(new Error('invalid Electrum response')) }
      })
      socket.on('end', () => { if (!buffer.includes('\n')) fail(new Error('Electrum closed without response')) })
    })
  }
}
export interface BtcHistoryRow { txid: Hex; height: number; received_sats: number; spent_sats: number; net_sats: number }
export interface BtcHistory {
  status: 'verified' | 'unknown'
  scope: 'declared_xpub_branches'
  xpubs_hash: Hex
  gap_limit: number
  scanned_scripts: number
  first_height: number | null
  current_sats: number | null
  rows: BtcHistoryRow[]
  reasons: string[]
}
export interface BtcAccount { xpub: string; branches: number[] }
export function xpubScript(xpub: string, branch: number, index: number): Hex {
  const key = HDKey.fromExtendedKey(xpub, xpub.startsWith('tpub') ? { public: 0x043587cf, private: 0x04358394 } : undefined).deriveChild(branch).deriveChild(index).publicKey
  if (!key) throw new Error('xpub has no public key')
  return keyPathOutput(bytesToHex(key.slice(1))).script
}
export async function readBtcHistory(accounts: BtcAccount[], electrum: ElectrumReader, chain: ChainClient, opts: { gapLimit?: number; maxAddressesPerBranch?: number; additionalScripts?: Hex[] } = {}): Promise<BtcHistory> {
  const gap = opts.gapLimit ?? 20, cap = opts.maxAddressesPerBranch ?? 200
  const out: BtcHistory = { status: 'unknown', scope: 'declared_xpub_branches', xpubs_hash: hashObject(accounts), gap_limit: gap, scanned_scripts: 0, first_height: null, current_sats: null, rows: [], reasons: [] }
  if (!Number.isInteger(gap) || gap < 1 || gap > 100 || !Number.isInteger(cap) || cap < gap || cap > 1000 || accounts.length < 1 || accounts.length > 4) { out.reasons.push('BTC_SCAN_BOUNDS_INVALID'); return out }
  try {
    const scripts = new Set<Hex>(), histories = new Map<Hex, number>()
    const scan = async (script: Hex) => {
      scripts.add(script); out.scanned_scripts++
      const scripthash = bytesToHex(hexToBytes(sha256Hex(hexToBytes(script))).reverse())
      const rows = await electrum.request<{ tx_hash: Hex; height: number }[]>('blockchain.scripthash.get_history', [scripthash])
      if (!Array.isArray(rows) || rows.length > 500) throw new Error('BTC history capacity exceeded')
      for (const r of rows) {
        if (!/^[0-9a-f]{64}$/.test(r.tx_hash) || !Number.isInteger(r.height) || r.height < 1) throw new Error('BTC history has pending or invalid entries')
        const prior = histories.get(r.tx_hash)
        if (prior !== undefined && prior !== r.height) throw new Error('BTC history height disagreement')
        histories.set(r.tx_hash, r.height)
      }
      return rows.length > 0
    }
    for (const account of accounts) {
      if (!account.branches.length || account.branches.length > 4 || account.branches.some((b) => !Number.isInteger(b) || b < 0 || b >= 0x80000000)) throw new Error('BTC branches invalid')
      for (const branch of account.branches) {
        let empty = 0
        for (let index = 0; index < cap && empty < gap; index++) empty = await scan(xpubScript(account.xpub, branch, index)) ? 0 : empty + 1
        if (empty < gap) throw new Error('BTC history gap limit not reached')
      }
    }
    for (const script of opts.additionalScripts ?? []) await scan(script)
    const txs = new Map<Hex, Awaited<ReturnType<ChainClient['getTx']>>>()
    const txOf = async (txid: Hex) => { if (!txs.has(txid)) txs.set(txid, await chain.getTx(txid)); return txs.get(txid) }
    for (const [txid, height] of histories) {
      const tx = await txOf(txid)
      if (!tx || tx.height !== height) throw new Error('BTC indexer anchor disagrees with Bitcoin')
      const received = tx.outputs.filter((o) => scripts.has(o.script)).reduce((s, o) => s + o.value, 0)
      let spent = 0
      for (const input of tx.inputs) {
        const previous = await txOf(input.txid), output = previous?.outputs[input.vout]
        if (!output) throw new Error('BTC previous output unavailable')
        if (scripts.has(output.script)) spent += output.value
      }
      out.rows.push({ txid, height, received_sats: received, spent_sats: spent, net_sats: received - spent })
    }
    out.rows.sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid))
    const balance = out.rows.reduce((sum, r) => sum + r.net_sats, 0)
    if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('BTC history does not reconcile')
    out.current_sats = balance; out.first_height = out.rows[0]?.height ?? null; out.status = 'verified'
  } catch { out.reasons.push('BTC_HISTORY_UNAVAILABLE_OR_INCOMPLETE') }
  return out
}
