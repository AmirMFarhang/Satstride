// The btc-onchain layer: Bitcoin addresses the borrower proves with BIP-322
// and whose history anyone can recompute. The person makes a fresh address in
// their own wallet and signs the challenge there; this adapter only verifies.
// It never asks for, derives or stores a key, and never builds a transaction
// (BIP-322's two virtual transactions are unspendable; see bip322.ts).
//
// History: every transaction touching the proven addresses, each checked
// against its raw bytes, merkle branch and header work (bitcoin-source.ts).
// Amounts are recomputed from raw bytes: received = outputs paying a proven
// address, spent = proven outputs this transaction consumes. A transaction
// that only moves money between proven addresses is a self-transfer and nets
// to its fee. The lender runs the same code against its OWN source and names
// every row that differs, is missing or is unknown to it.

import * as bitcoin from 'bitcoinjs-lib'
import { bytesToHex, type Hex } from '../core/crypto.js'
import { decodeAddress, scriptToAddress, verifyBip322Simple } from './bip322.js'
import { rawTxProblems, txRecordProblems, type BitcoinSource, type TxRecord } from './bitcoin-source.js'
import { challengeProblems } from './challenge.js'
import type { ChainId, ControlChallenge, ControlProof, ControlVerdict, HistoryWindow, LayerAdapter, LayerHistory, LayerVisibility, NormalizedRow, RecomputeResult, RowLinks, VerifyExpectation } from './types.js'

const ZERO_PK = '00'.repeat(32)
/** A transaction with at least this many inputs and equal outputs looks like a CoinJoin. */
export const COINJOIN_MIN_INPUTS = 5
export const COINJOIN_MIN_EQUAL_OUTPUTS = 3
/** Previous transactions fetched for payer scripts per history read. */
export const MAX_PREV_FETCHES = 120

const reversedHex = (b: Uint8Array) => bytesToHex(Uint8Array.from(b).reverse())

export function isCoinjoinLike(tx: bitcoin.Transaction): boolean {
  if (tx.ins.length < COINJOIN_MIN_INPUTS) return false
  const counts = new Map<bigint, number>()
  for (const o of tx.outs) counts.set(o.value, (counts.get(o.value) ?? 0) + 1)
  return Math.max(...counts.values()) >= COINJOIN_MIN_EQUAL_OUTPUTS
}

export class BtcOnchainAdapter implements LayerAdapter {
  readonly id = 'btc-onchain' as const
  readonly visibility: LayerVisibility = {
    public_history: true,
    lender_recomputable: true,
    best_evidence: 'chain-recomputable',
    default_trust_mode: 'lender-recompute',
    limits: ['Covers the addresses the borrower proved, not every wallet the person has.', 'A source can leave transactions out; the lender reads its own source and names what differs.', 'Block height is as each source reports it; header work is checked against a floor, not against the best chain.'],
  }
  constructor(readonly chain: ChainId, private readonly source: BitcoinSource) {}

  get sourceLabel(): string { return this.source.label }

  /** The person signs `challenge.text` in their own wallet; this only packages the signature they paste. */
  async proveControl(challenge: ControlChallenge, external?: { signature: string }): Promise<ControlProof> {
    if (!external?.signature) throw new Error(`sign this message with ${challenge.subject} in your own wallet (BIP-322), then pass the signature: ${challenge.text}`)
    return { layer: 'btc-onchain', subject: challenge.subject, challenge, format: 'bip322-simple', signature: external.signature.trim() }
  }

  verifyControl(proof: ControlProof, expect: VerifyExpectation): ControlVerdict {
    const reasons = challengeProblems(proof.challenge, proof.subject, 'btc-onchain', expect)
    if (proof.format !== 'bip322-simple') reasons.push('FORMAT_UNSUPPORTED')
    if (proof.challenge?.chain !== this.chain) reasons.push('CHAIN_MISMATCH')
    const r = verifyBip322Simple(proof.subject, proof.challenge?.text ?? '', proof.signature, this.chain)
    reasons.push(...r.reasons)
    return { ok: reasons.length === 0, layer: 'btc-onchain', subject: proof.subject, format: 'bip322-simple', reasons, ...(r.key ? { key: r.key } : {}) }
  }

  async history(subjects: string[], window: HistoryWindow): Promise<LayerHistory> {
    const limits: string[] = []
    const scripts = new Map<Hex, string>()
    for (const a of subjects) scripts.set(bytesToHex(decodeAddress(a, this.chain).script), a)
    const height = await this.source.tipHeight()
    const heights = new Map<Hex, number>()
    for (const a of subjects) for (const r of await this.source.addressTxids(a)) heights.set(r.txid, r.height)
    // Parse and check every transaction first: own outputs are known before spends are matched.
    const records: { rec: TxRecord; tx: bitcoin.Transaction }[] = []
    for (const [txid] of [...heights].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
      let rec: TxRecord
      try { rec = await this.source.tx(txid) } catch (e) { limits.push(`TX_UNAVAILABLE:${txid}:${(e as Error).message.slice(0, 60)}`); continue }
      const problems = txRecordProblems(rec, this.chain)
      if (problems.length) { limits.push(`TX_PROOF_FAILED:${txid}:${problems.join('+')}`); continue }
      if (rec.block_height !== heights.get(txid)) limits.push(`TX_HEIGHT_DISAGREES:${txid}`)
      records.push({ rec, tx: bitcoin.Transaction.fromHex(rec.hex) })
    }
    const ownOutputs = new Map<string, bigint>()
    for (const { rec, tx } of records) tx.outs.forEach((o, vout) => { if (scripts.has(bytesToHex(o.script))) ownOutputs.set(`${rec.txid}:${vout}`, o.value) })
    let prevBudget = MAX_PREV_FETCHES
    const rows: NormalizedRow[] = []
    let balance = 0n
    for (const { rec, tx } of records) {
      let ownIn = 0n, ownOut = 0n
      const spends = tx.ins.map((i) => reversedHex(i.hash))
      tx.ins.forEach((i) => { ownIn += ownOutputs.get(`${reversedHex(i.hash)}:${i.index}`) ?? 0n })
      const outputs: NonNullable<RowLinks['outputs']> = tx.outs.map((o, vout) => {
        const script = bytesToHex(o.script), own = scripts.has(script)
        if (own) ownOut += o.value
        return { vout, script, value: Number(o.value), own }
      })
      balance += ownOut - ownIn
      const coinjoin = isCoinjoinLike(tx)
      const external = outputs.filter((o) => !o.own && !o.script.startsWith('6a'))
      const selfTransfer = ownIn > 0n && external.length === 0
      // Payer scripts for receipts: read from the previous transactions' own bytes, never from an indexer's summary.
      let inputScripts: Hex[] | undefined
      if (ownIn === 0n && !coinjoin) {
        inputScripts = []
        for (const i of tx.ins) {
          const prev = reversedHex(i.hash)
          if (/^0+$/.test(prev)) { inputScripts.push('coinbase'); continue }
          if (prevBudget-- <= 0) { limits.push('PAYER_SCRIPTS_PARTIAL'); break }
          try {
            const raw = await this.source.rawTx(prev)
            if (rawTxProblems(prev, raw).length) { limits.push(`PREV_TX_MISMATCH:${prev}`); continue }
            inputScripts.push(bytesToHex(bitcoin.Transaction.fromHex(raw).outs[i.index].script))
          } catch { inputScripts.push('unknown') }
        }
      }
      const net = ownOut - ownIn
      const direction: 'in' | 'out' = net > 0n ? 'in' : 'out'
      const amount = Number(net > 0n ? net : -net)
      const counterparty = selfTransfer ? 'self'
        : direction === 'in' ? (inputScripts?.map((s) => (s === 'coinbase' || s === 'unknown' ? s : scriptToAddress(s, this.chain) ?? `script:${s}`)).sort()[0] ?? 'unknown')
          : (external.map((o) => scriptToAddress(o.script, this.chain) ?? `script:${o.script}`)[0] ?? 'unknown')
      rows.push({
        txid: rec.txid, height: rec.block_height, direction, amount, counterparty_pk: ZERO_PK, memo: '',
        layer: 'btc-onchain', chain: this.chain, asset: 'BTC', unit: 'sat', counterparty, time: rec.block_time,
        provenance: { txid: rec.txid, source: this.source.label, confirmations: height - rec.block_height + 1 },
        evidence_level: 'chain-recomputable',
        links: { spends, outputs, ...(inputScripts ? { input_scripts: inputScripts } : {}), ...(selfTransfer ? { self_transfer: true } : {}), ...(coinjoin ? { coinjoin_like: true } : {}) },
      })
    }
    if (balance < 0n) limits.push('BALANCE_NEGATIVE')
    const first = rows[0]?.time ?? null
    const inWindow = rows.filter((r) => r.time !== null && r.time >= window.from_time && r.time <= window.to_time)
    return { layer: 'btc-onchain', chain: this.chain, subjects: [...subjects], rows: inWindow, height, source: this.source.label, first_seen_time: first, balance: Number(balance), calls: [...this.source.calls], limits }
  }

  /** The lender's side: re-read the proven addresses from this adapter's own source and compare row by row. */
  async recompute(claimed: LayerHistory, window: HistoryWindow): Promise<RecomputeResult> {
    const mine = await this.history(claimed.subjects, window)
    const byTxid = new Map(mine.rows.map((r) => [r.txid, r]))
    const tampered: RecomputeResult['tampered'] = []
    const unknown: Hex[] = []
    let matched = 0
    for (const c of claimed.rows) {
      const m = byTxid.get(c.txid)
      if (!m) { unknown.push(c.txid); continue }
      const fields: [string, unknown, unknown][] = [['height', c.height, m.height], ['direction', c.direction, m.direction], ['amount', c.amount, m.amount], ['counterparty', c.counterparty, m.counterparty], ['time', c.time, m.time], ['self_transfer', !!c.links?.self_transfer, !!m.links?.self_transfer], ['coinjoin_like', !!c.links?.coinjoin_like, !!m.links?.coinjoin_like]]
      const bad = fields.filter(([, a, b]) => a !== b)
      for (const [field, a, b] of bad) tampered.push({ txid: c.txid, field, claimed: String(a), recomputed: String(b) })
      if (!bad.length) matched++
    }
    const claimedIds = new Set(claimed.rows.map((r) => r.txid))
    const missing = mine.rows.filter((r) => !claimedIds.has(r.txid)).map((r) => r.txid)
    return { layer: 'btc-onchain', ok: !tampered.length && !missing.length && !unknown.length && !mine.limits.some((l) => l.startsWith('TX_')), source: mine.source, height: mine.height, matched, tampered, missing, unknown, calls: mine.calls, lender_history: mine }
  }
}
