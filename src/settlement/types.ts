// Pluggable settlement. The kind and its parameters are written into the loan
// terms (v1 = cosign-rgb, v2 = ln-rln with its invoice hash), so the terms hash
// on chain binds the method, and repayment proof dispatches to that kind's
// `verify` only.

import type { ChainClient, ChainInput, ChainTx } from '../chain/types.js'
import type { Hex } from '../core/crypto.js'
import type { AtomicRepayment, LoanTerms } from '../core/terms.js'
import type { Leaf } from '../escrow/escrow.js'
import type { IouOwnership } from '../market/iou.js'
import type { RgbRepaymentReceipt } from '../registry/passbook-doc.js'
import type { SettlementKind } from './kinds.js'

export type SettlementParams =
  | { kind: 'cosign-rgb' }
  | { kind: 'ln-rln'; atomic: AtomicRepayment }
  | { kind: 'onchain-swap'; swap_offer: unknown }

/** Terms before the settlement kind is applied: always v1 shape, no atomic fields. */
export type DraftTerms = Omit<LoanTerms, 'v' | 'atomic_repayment'>

export type RepaymentEvidence =
  | { kind: 'cosign-rgb'; receipt: RgbRepaymentReceipt; ownership?: IouOwnership }
  | { kind: 'ln-rln'; preimage: Hex }

/** Where the collateral was locked and which transaction closed it. */
export interface CloseRef { lock_txid: Hex; lock_vout: number; outcome_txid: Hex }

export interface CloseContext { lock: ChainTx & { height: number }; close: ChainTx & { height: number }; input: ChainInput; leaf: string }

export type ProvenRepayment =
  | { ok: true; repaid_height: number; assurance: 'bitcoin_hashlock' | 'signed_rgb_receipt' }
  | { ok: false; reason: string }

export interface Loan { terms: LoanTerms; lock: { txid: Hex; vout: number } }

export interface SettlementAdapter {
  readonly kind: SettlementKind
  /** Parameters fixed at origination, e.g. the lender's invoice and its payment hash. */
  originate(terms: DraftTerms): Promise<SettlementParams>
  /** Extra Taproot leaves this kind needs beyond A–D. */
  escrowLeaves(params: SettlementParams): Leaf[]
  /** Moves the money and releases the collateral; the borrower agent supplies the executor. */
  repay(loan: Loan): Promise<RepaymentEvidence>
  /** Used by repaymentProven and passbook verification. Self-contained: re-reads the lock and the close. */
  verify(ev: RepaymentEvidence, terms: LoanTerms, chain: ChainClient, ref: CloseRef): Promise<ProvenRepayment>
}
