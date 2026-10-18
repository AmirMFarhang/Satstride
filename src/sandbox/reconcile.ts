// Bitcoin authenticates anchors, not RGB amounts or omitted history. A trusted
// observer must have watched this account from zero and validate RGB state.
import type { ChainClient } from '../chain/types.js'
import { hashObject, isHex, verifyObject, type Hex } from '../core/crypto.js'
import type { HistoryRow } from './types.js'
import type { BtcHistory } from '../wallet/btc-history.js'

export interface ObservedTransfer { txid: Hex; height: number; direction: 'in' | 'out'; amount: number; recipient_id: string; counterparty_pk: Hex }
export interface ProvenAllocation { txid: Hex; vout: number; amount: number; bitcoin_sats: number; script: Hex }
export interface HistoryProof {
  v: 1
  assurance: 'trusted_wallet_snapshot'
  observer_pk: Hex
  borrower_pk: Hex
  asset_id: string
  wallet_xpubs_hash: Hex
  observed_from_zero: boolean
  first_transfer_txid: Hex | null
  opening_balance: number
  current_balance: number
  height: number
  transfers: ObservedTransfer[]
  allocations: ProvenAllocation[]
  native_snapshot_hash: Hex
  btc_history: BtcHistory
  sig: Hex
}
export interface ReconcileResult {
  status: 'verified' | 'failed' | 'unknown'
  reasons: string[]
  assurance: 'trusted_wallet_snapshot' | 'none'
  verifiedOpeningBalanceMicro?: number
  provenCurrentBalanceMicro?: number
  verifiedCounterpartyPks?: Hex[]
  /** Private; never release the manifest or allocation identifiers to lenders. */
  proof_hash?: Hex
}
export interface ReconcileOptions {
  trustedSigners: Hex[]
  assetId: string
  currentHeight?: number
  maxAgeBlocks?: number
  /** Must query the sandbox's node, never a borrower-supplied response. */
  getUnspent?: (txid: Hex, vout: number) => Promise<{ value: number; script: Hex } | null>
}
export const historyLedger = (rows: Pick<HistoryRow, 'txid' | 'height' | 'direction' | 'amount' | 'counterparty_pk'>[]) => rows
  .map(({ txid, height, direction, amount, counterparty_pk }) => ({ txid, height, direction, amount, counterparty_pk }))
  .sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid) || a.direction.localeCompare(b.direction))
const safe = (n: number) => Number.isSafeInteger(n) && n >= 0

export async function reconcileHistory(
  bundle: { borrower_pk: Hex; balance: number; history: HistoryRow[]; history_proof?: HistoryProof },
  chain: ChainClient,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const reasons: string[] = []
  const result = (status: ReconcileResult['status']): ReconcileResult => ({ status, reasons, assurance: status === 'verified' ? 'trusted_wallet_snapshot' : 'none' })
  try {
    const p = bundle.history_proof
    if (!p) { reasons.push('HISTORY_PROOF_MISSING'); return result('unknown') }
    if (!opts.trustedSigners.includes(p.observer_pk)) { reasons.push('UNTRUSTED_HISTORY_OBSERVER'); return result('unknown') }
    if (!verifyObject(p, p.observer_pk)) { reasons.push('HISTORY_SIGNATURE_INVALID'); return result('failed') }
    if (p.v !== 1 || p.assurance !== 'trusted_wallet_snapshot' || p.borrower_pk !== bundle.borrower_pk || p.asset_id !== opts.assetId || !isHex(p.wallet_xpubs_hash, 32) || !isHex(p.native_snapshot_hash, 32)) reasons.push('HISTORY_IDENTITY_MISMATCH')
    if (!p.observed_from_zero || p.opening_balance !== 0) { reasons.push('FIRST_TRANSFER_NOT_INDEPENDENTLY_OBSERVED'); return result('unknown') }
    if (p.btc_history?.status !== 'verified') { reasons.push('BTC_HISTORY_NOT_VERIFIED'); return result('unknown') }
    const height = opts.currentHeight ?? await chain.getHeight()
    if (!safe(p.height) || p.height > height || height - p.height > (opts.maxAgeBlocks ?? 0)) reasons.push('HISTORY_PROOF_STALE')
    if (!safe(p.current_balance) || !safe(bundle.balance) || !Array.isArray(p.transfers) || p.transfers.length > 200 || !Array.isArray(p.allocations) || p.allocations.length > 200) { reasons.push('HISTORY_PROOF_INVALID'); return result('failed') }
    if (p.transfers.some((t) => !isHex(t.txid, 32) || !isHex(t.counterparty_pk, 32) || !safe(t.height) || t.height > p.height || !safe(t.amount) || t.amount === 0 || !['in', 'out'].includes(t.direction) || typeof t.recipient_id !== 'string')) reasons.push('HISTORY_MANIFEST_INVALID')
    const manifest = historyLedger(p.transfers)
    if (p.native_snapshot_hash !== hashObject({ ledger: manifest, balance: p.current_balance, allocations: p.allocations })) reasons.push('NATIVE_SNAPSHOT_HASH_MISMATCH')
    if (new Set(p.transfers.map((t) => t.txid)).size !== p.transfers.length || new Set(bundle.history.map((r) => r.txid)).size !== bundle.history.length) reasons.push('HISTORY_DUPLICATE_ANCHOR')
    if (hashObject(manifest) !== hashObject(historyLedger(bundle.history))) reasons.push('HISTORY_MANIFEST_MISMATCH')
    const first = [...p.transfers].sort((a, b) => a.height - b.height)[0]
    if ((first?.txid ?? null) !== p.first_transfer_txid) reasons.push('FIRST_TRANSFER_MISMATCH')
    let balance = 0n
    const netByHeight = new Map<number, bigint>()
    for (const t of manifest) {
      netByHeight.set(t.height, (netByHeight.get(t.height) ?? 0n) + (t.direction === 'in' ? BigInt(t.amount) : -BigInt(t.amount)))
      const tx = await chain.getTx(t.txid)
      if (!tx || tx.height === null || tx.height !== t.height) reasons.push('HISTORY_ANCHOR_INVALID')
    }
    // Bitcoin transaction ids do not encode order within a block. Check each
    // block's net rather than inventing chronology from lexicographic txids.
    for (const net of netByHeight.values()) { balance += net; if (balance < 0n || balance > BigInt(Number.MAX_SAFE_INTEGER)) reasons.push('HISTORY_BALANCE_INVALID') }
    if (balance !== BigInt(p.current_balance) || balance !== BigInt(bundle.balance)) reasons.push('HISTORY_BALANCE_MISMATCH')
    const allocations = new Set<string>()
    let allocated = 0n
    for (const a of p.allocations) {
      if (!isHex(a.txid, 32) || !safe(a.vout) || !safe(a.amount) || !safe(a.bitcoin_sats) || !isHex(a.script) || allocations.has(`${a.txid}:${a.vout}`)) { reasons.push('ALLOCATION_INVALID'); continue }
      allocations.add(`${a.txid}:${a.vout}`); allocated += BigInt(a.amount)
      const tx = await chain.getTx(a.txid)
      const output = tx?.outputs[a.vout]
      if (!tx || tx.height === null || tx.height > p.height || !output || output.value !== a.bitcoin_sats || output.script !== a.script) reasons.push('ALLOCATION_ANCHOR_INVALID')
      if (opts.getUnspent) {
        const actual = await opts.getUnspent(a.txid, a.vout)
        if (!actual || actual.value !== a.bitcoin_sats || actual.script !== a.script) reasons.push('ALLOCATION_SPENT_OR_CHANGED')
      }
    }
    if (allocated > BigInt(Number.MAX_SAFE_INTEGER) || allocated !== balance) reasons.push('ALLOCATION_BALANCE_MISMATCH')
    if (reasons.length) return result('failed')
    if (!opts.getUnspent && p.allocations.length) { reasons.push('ALLOCATION_UNSPENT_NOT_RECHECKED'); return result('unknown') }
    return { ...result('verified'), verifiedOpeningBalanceMicro: 0, provenCurrentBalanceMicro: Number(balance), verifiedCounterpartyPks: [...new Set(p.transfers.map((t) => t.counterparty_pk).filter((pk) => pk !== '00'.repeat(32)))], proof_hash: hashObject(p) }
  } catch { reasons.push('HISTORY_VERIFICATION_ERROR'); return result('unknown') }
}
