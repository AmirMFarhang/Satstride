// One credit agent, several layers of the borrower's money. Each layer sits
// behind a LayerAdapter: what the lender can see of it, how the borrower proves
// control (a signature, never a key), where its history comes from and, where
// the layer allows it, how the lender recomputes that history from its own
// source. Every history row is normalised to one shape that names its layer,
// chain, provenance and how strong its evidence is.
//
// Built here: the Bitcoin family (btc-onchain, lightning, rgb). The ids are a
// closed union so another chain is a deliberate addition, not a string typo.

import type { Hex } from '../core/crypto.js'
import type { HistoryRow } from '../sandbox/types.js'

export const LAYER_IDS = ['btc-onchain', 'lightning', 'rgb'] as const
export type LayerId = (typeof LAYER_IDS)[number]
export const CHAIN_IDS = ['bitcoin', 'signet', 'regtest'] as const
export type ChainId = (typeof CHAIN_IDS)[number]

/**
 * How strong one row's evidence is, from strongest to weakest:
 * - chain-recomputable: anyone with their own Bitcoin source can re-derive it (txid, raw bytes, merkle proof, header work).
 * - counterparty-signed: the payer signed it (a Passbook payer signature over txid, amount and borrower).
 * - client-side-validated: an RGB transfer the wallet validated, anchored on Bitcoin, without a payer signature.
 * - self-reported: the borrower's device says so and nothing else does.
 */
export const EVIDENCE_LEVELS = ['chain-recomputable', 'counterparty-signed', 'client-side-validated', 'self-reported'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

/**
 * What the lender does with a layer's numbers, named on every number:
 * - lender-recompute: the lender re-derives the rows from its own source and compares them row by row.
 * - signature-verified: the lender checks a signature (node key, payer key) and nothing else.
 * - client-side-validated: an RGB wallet or the history observer validated the consignments; the lender sees the signed result.
 * - borrower-device: only the borrower's device saw it.
 */
export const TRUST_MODES = ['lender-recompute', 'signature-verified', 'client-side-validated', 'borrower-device'] as const
export type TrustMode = (typeof TRUST_MODES)[number]

/** Integer unit of a row's amount. Amounts are never floats. */
export type AmountUnit = 'sat' | 'msat' | 'micro-usdt'

export interface RowProvenance {
  /** On-chain anchor: a Bitcoin txid (btc-onchain, and the anchor of an RGB transfer). */
  txid?: Hex
  /** Lightning payment hash, when the row is a Lightning payment (payment proofs: after the hackathon). */
  payment_hash?: Hex
  /** Which source produced the row: an endpoint, 'recorded mainnet data, block N', 'rgb wallet', 'rln node'. */
  source: string
  /** Confirmations at the source's tip when read; null when the layer has none (an off-chain payment). */
  confirmations: number | null
}

/** Links that let code net out the borrower's own movements across layers. */
export interface RowLinks {
  /** txids of the outputs this transaction spends (on-chain). */
  spends?: Hex[]
  /** Outputs of this transaction, as `txid:vout` with their script and value (on-chain). */
  outputs?: { vout: number; script: Hex; value: number; own: boolean }[]
  /** Input scripts of this transaction, as read from the previous transactions (on-chain). */
  input_scripts?: Hex[]
  /** Set by the adapter when the transaction is a self-transfer between declared own addresses. */
  self_transfer?: boolean
  /** Many inputs and several equal outputs: a CoinJoin-like transaction. Privacy tools are neutral. */
  coinjoin_like?: boolean
}

/**
 * Today's sandbox HistoryRow, plus where it came from. `amount` stays the row's
 * integer amount in `unit`; `counterparty_pk` keeps the HistoryRow meaning
 * (a Passbook party key, or 32 zero bytes when the counterparty is not a party)
 * and `counterparty` names it in the layer's own terms (an address, a node key).
 */
export interface NormalizedRow extends HistoryRow {
  layer: LayerId
  chain: ChainId
  /** 'BTC' for on-chain and Lightning BTC; the RGB asset id for RGB rows. */
  asset: string
  unit: AmountUnit
  counterparty: string
  /** Block time (Unix seconds) of the anchor; null when unknown. */
  time: number | null
  provenance: RowProvenance
  evidence_level: EvidenceLevel
  links?: RowLinks
}

/** What a lender can learn about a layer without asking the borrower for more. */
export interface LayerVisibility {
  /** The layer's history is public: anyone can read it from a node or an indexer. */
  public_history: boolean
  /** The lender can recompute the borrower's rows from its own source. */
  lender_recomputable: boolean
  /** The strongest evidence level a row on this layer can reach. */
  best_evidence: EvidenceLevel
  /** The trust mode the lender uses by default. */
  default_trust_mode: TrustMode
  /** What the lender cannot see, said plainly. */
  limits: string[]
}

/** The text a borrower signs to prove control of an address, node or key. Issued by the verifier (the lender). */
export interface ControlChallenge {
  v: 1
  kind: 'passbook-layer-challenge'
  layer: LayerId
  chain: ChainId
  /** Address (btc-onchain), node public key (lightning) or party key (rgb). */
  subject: string
  negotiation_id: Hex
  lender_pk: Hex
  /** 16 random bytes, single use. */
  nonce: Hex
  issued_at: number
  expires_at: number
  /** Exactly what is signed. */
  text: string
}

export type ProofFormat = 'bip322-simple' | 'ln-signmessage' | 'ln-invoice' | 'bip340-text'

export interface ControlProof {
  layer: LayerId
  subject: string
  challenge: ControlChallenge
  format: ProofFormat
  /** BIP-322 simple signature (base64, optional `smp` prefix), LDK zbase32 signature, a BOLT11 invoice whose description is the text, or a BIP-340 signature over sha256(text) (hex). */
  signature: string
}

export interface ControlVerdict {
  ok: boolean
  layer: LayerId
  subject: string
  format: ProofFormat
  /** Stable reason codes; empty when ok. */
  reasons: string[]
  /** The key the proof recovered or checked (compressed or x-only hex). */
  key?: Hex
}

export interface VerifyExpectation {
  negotiation_id: Hex
  lender_pk: Hex
  /** Unix seconds. */
  now: number
  /** The challenge the verifier issued; a proof for any other challenge fails. */
  issued?: ControlChallenge
}

export interface HistoryWindow {
  /** Unix seconds; rows anchored before it are outside the window. */
  from_time: number
  /** Unix seconds. */
  to_time: number
}

/** One logged call to a history source: endpoint and the block height the source reported. */
export interface SourceCall {
  at: number
  source: string
  endpoint: string
  ok: boolean
  /** Tip height the source reported at the time of the call, when known. */
  height: number | null
  note?: string
}

export interface LayerHistory {
  layer: LayerId
  chain: ChainId
  /** The borrower's subjects this history covers (addresses, node key, RGB wallet key). */
  subjects: string[]
  rows: NormalizedRow[]
  /** Tip height of the source when read. */
  height: number | null
  /** Label of the source, e.g. 'https://mempool.space/api' or 'recorded mainnet data, block 971896'. */
  source: string
  /** Unix seconds of the first transaction seen for the subjects, inside or outside the window. */
  first_seen_time: number | null
  /** Integer balance in the layer's unit at the source's tip, when the layer has one. */
  balance: number | null
  calls: SourceCall[]
  /** Reasons the history is partial or unavailable; empty when complete for the declared subjects. */
  limits: string[]
}

/** The lender's row-by-row comparison of the borrower's history with its own. */
export interface RecomputeResult {
  layer: LayerId
  ok: boolean
  /** The lender's own source label. */
  source: string
  height: number | null
  matched: number
  /** Rows the borrower sent that differ from the lender's recomputation, named by txid and field. */
  tampered: { txid: Hex; field: string; claimed: string; recomputed: string }[]
  /** Rows the lender found that the borrower did not send. */
  missing: Hex[]
  /** Rows the borrower sent that the lender's source does not have. */
  unknown: Hex[]
  calls: SourceCall[]
  /** The lender's own reading the comparison was made against. */
  lender_history?: LayerHistory
}

/**
 * A layer behind one interface. `proveControl` runs on the borrower's device and
 * never sees a key it should not: btc-onchain only packages a signature the
 * person made in their own wallet; lightning asks the person's node to sign;
 * rgb signs with the Passbook party key already on the device.
 */
export interface LayerAdapter {
  readonly id: LayerId
  readonly chain: ChainId
  readonly visibility: LayerVisibility
  proveControl(challenge: ControlChallenge, external?: { signature: string }): Promise<ControlProof>
  verifyControl(proof: ControlProof, expect: VerifyExpectation): ControlVerdict
  history(subjects: string[], window: HistoryWindow): Promise<LayerHistory>
  recompute?(claimed: LayerHistory, window: HistoryWindow): Promise<RecomputeResult>
}

export const isLayerId = (x: unknown): x is LayerId => typeof x === 'string' && (LAYER_IDS as readonly string[]).includes(x)
export const isChainId = (x: unknown): x is ChainId => typeof x === 'string' && (CHAIN_IDS as readonly string[]).includes(x)
