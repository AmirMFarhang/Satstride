// The rgb layer: Passbook's main story, now behind the same adapter as the
// others. `rgbHistoryRows` is the borrower wallet's history exactly as
// BorrowerAgent built it before (moved here unchanged): settled, anchored,
// non-issuance transfers of the asset, with the counterparty and memo from the
// wallet's own seeded inflows and labels. The sandbox bundle still receives
// these rows as plain HistoryRows; the adapter adds layer, provenance and
// evidence level for the multi-layer check.
//
// Evidence: an RGB transfer the wallet validated is client-side-validated; one
// whose payer also signed { txid, amount, borrower_pk } is counterparty-signed.
// Control is the Passbook party key signing the challenge (BIP-340 over the
// text's sha256), the same key the borrower already uses for everything else.

import { hashObject, sha256Hex, signHash, verifyHash, isHex, type Hex, type KeyPair } from '../core/crypto.js'
import type { ChainClient } from '../chain/types.js'
import type { CandidateInflow, HistoryRow } from '../sandbox/types.js'
import { challengeProblems } from './challenge.js'
import type { ChainId, ControlChallenge, ControlProof, ControlVerdict, HistoryWindow, LayerAdapter, LayerHistory, LayerVisibility, NormalizedRow, VerifyExpectation } from './types.js'

export interface RgbTransferView { kind: string; status: string; txid: string | null; amount: number }
export interface RgbWalletView { transfers(assetId?: string): RgbTransferView[] }
export interface RgbRowLabel { counterparty_pk: Hex; memo: string }

/** The borrower wallet's raw RGB history (unchanged from BorrowerAgent.history). Never leaves except encrypted to the sandbox. */
export async function rgbHistoryRows(args: { wallet: RgbWalletView; assetId: string; chain: Pick<ChainClient, 'getTx'>; inflows: readonly { txid: Hex; payer_pk: Hex; memo: string }[]; labels: Record<Hex, RgbRowLabel> }): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = []
  const byTxid = new Map(args.inflows.map((i) => [i.txid, i]))
  const labels = args.labels
  for (const t of args.wallet.transfers(args.assetId)) {
    if (t.status !== 'Settled' || !t.txid || t.kind === 'Issuance') continue
    const tx = await args.chain.getTx(t.txid)
    if (!tx?.height) continue
    const seeded = byTxid.get(t.txid)
    const label = labels[t.txid]
    rows.push({
      txid: t.txid,
      height: tx.height,
      direction: t.kind === 'Send' ? 'out' : 'in',
      amount: t.amount,
      counterparty_pk: seeded?.payer_pk ?? label?.counterparty_pk ?? '00'.repeat(32),
      memo: seeded?.memo ?? label?.memo ?? '',
    })
  }
  return rows
}

/** True when the payer signed this inflow for this borrower (the sandbox's own inflow check). */
export function payerSigned(row: Pick<HistoryRow, 'txid' | 'amount' | 'direction'>, borrowerPk: Hex, signed: readonly CandidateInflow[]): boolean {
  if (row.direction !== 'in') return false
  const c = signed.find((s) => s.txid === row.txid)
  return !!c && c.amount === row.amount && verifyHash(c.payer_sig, hashObject({ txid: c.txid, amount: c.amount, borrower_pk: borrowerPk }), c.payer_pk)
}

export function normalizeRgbRows(rows: readonly HistoryRow[], ctx: { chain: ChainId; assetId: string; borrowerPk: Hex; signed: readonly CandidateInflow[]; source: string; height: number | null }): NormalizedRow[] {
  return rows.map((r) => ({
    ...r,
    layer: 'rgb' as const,
    chain: ctx.chain,
    asset: ctx.assetId,
    unit: 'micro-usdt' as const,
    counterparty: r.counterparty_pk,
    time: null,
    provenance: { txid: r.txid, source: ctx.source, confirmations: ctx.height === null ? null : ctx.height - r.height + 1 },
    evidence_level: payerSigned(r, ctx.borrowerPk, ctx.signed) ? 'counterparty-signed' as const : 'client-side-validated' as const,
  }))
}

export interface RgbAdapterDeps {
  /** The Passbook party key on this device; needed only to prove control. */
  party?: KeyPair
  borrowerPk: Hex
  assetId: string
  /** The wallet's rows (rgbHistoryRows over the live wallet, or rows the device already holds). */
  rows: () => Promise<HistoryRow[]>
  /** Payer-signed inflow records the borrower holds. */
  signed: readonly CandidateInflow[]
  height?: () => Promise<number>
  /** Blocks per day on the loan chain (economics.blocks_per_day: 1 in the demo, 144 on mainnet); maps the time window to heights. */
  blocksPerDay?: number
  /** Defaults to 'rgb wallet (client-side validated)'. */
  source?: string
}

export class RgbAdapter implements LayerAdapter {
  readonly id = 'rgb' as const
  readonly visibility: LayerVisibility = {
    public_history: false,
    lender_recomputable: false,
    best_evidence: 'counterparty-signed',
    default_trust_mode: 'client-side-validated',
    limits: ['RGB state is private to its owners: the lender sees what the wallet validated, plus payer signatures where they exist.', 'Completeness from a fresh wallet needs the platform history observer (trusted_wallet_snapshot), already in the sandbox flow.'],
  }
  constructor(readonly chain: ChainId, private readonly deps: RgbAdapterDeps) {}

  async proveControl(challenge: ControlChallenge): Promise<ControlProof> {
    if (!this.deps.party) throw new Error('no Passbook party key on this device')
    if (challenge.subject !== this.deps.party.pubkey) throw new Error('the challenge names a different party key')
    return { layer: 'rgb', subject: this.deps.party.pubkey, challenge, format: 'bip340-text', signature: signHash(sha256Hex(challenge.text), this.deps.party.secretKey) }
  }

  verifyControl(proof: ControlProof, expect: VerifyExpectation): ControlVerdict {
    const reasons = challengeProblems(proof.challenge, proof.subject, 'rgb', expect)
    if (proof.format !== 'bip340-text') reasons.push('FORMAT_UNSUPPORTED')
    if (!isHex(proof.subject, 32)) reasons.push('PARTY_KEY_MALFORMED')
    else if (!verifyHash(proof.signature, sha256Hex(proof.challenge?.text ?? ''), proof.subject)) reasons.push('SIGNATURE_INVALID')
    return { ok: reasons.length === 0, layer: 'rgb', subject: proof.subject, format: 'bip340-text', reasons, key: proof.subject }
  }

  /**
   * RGB rows carry block heights, not times: the window maps to the last
   * `days x blocksPerDay` blocks below the chain height. The balance still
   * comes from the whole history; only windowed rows feed the features.
   */
  async history(_subjects: string[], window: HistoryWindow): Promise<LayerHistory> {
    const source = this.deps.source ?? 'rgb wallet (client-side validated)'
    const height = this.deps.height ? await this.deps.height() : null
    const all = normalizeRgbRows(await this.deps.rows(), { chain: this.chain, assetId: this.deps.assetId, borrowerPk: this.deps.borrowerPk, signed: this.deps.signed, source, height })
    const balance = all.reduce((s, r) => s + (r.direction === 'in' ? r.amount : -r.amount), 0)
    const limits = balance < 0 ? ['RGB_HISTORY_INCOMPLETE'] : []
    let rows = all
    if (height === null) limits.push('RGB_WINDOW_NOT_APPLIED: no chain height')
    else {
      const days = Math.max(1, Math.ceil((window.to_time - window.from_time) / 86_400))
      const fromHeight = height - days * (this.deps.blocksPerDay ?? 144) + 1
      rows = all.filter((r) => r.height >= fromHeight && r.height <= height)
    }
    return { layer: 'rgb', chain: this.chain, subjects: [this.deps.borrowerPk], rows, height, source, first_seen_time: null, balance: balance >= 0 ? balance : null, calls: [], limits }
  }
}
