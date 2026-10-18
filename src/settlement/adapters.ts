// The settlement adapters and the dispatcher F2's repayment proof uses.
//
//   cosign-rgb    the borrower pays over RGB, the lender (or the platform's
//                 watch-only copy) validates the receive and signs a receipt,
//                 then leaf A (or leaf C if the lender refuses) releases the
//                 collateral. Not atomic. Always enabled as the fallback.
//   ln-rln        the lender's RGB Lightning invoice hash is in the v2 terms;
//                 paying returns the preimage, which spends leaf E. Atomic.
//   onchain-swap  not built: one Bitcoin transaction paying the USDT and
//                 spending the escrow, via an extra-input rgb-lib swap.
//
// Money movement stays in the agents; an adapter's `repay` runs the executor
// the borrower agent supplies and returns evidence in this common shape.

import { isConfirmed, opReturnPayload, type ChainClient } from '../chain/types.js'
import { verifyObject, type Hex } from '../core/crypto.js'
import { debtOf, termsHash, type LoanTerms } from '../core/terms.js'
import { escrowFor, partiesOf, type Leaf } from '../escrow/escrow.js'
import { atomicWitnessPreimage, spentLeaf } from '../escrow/witness.js'
import { verifyOwnership } from '../market/iou.js'
import { createAtomicRepayment, payAtomicInvoice, type RgbLightningClient } from '../rgb/lightning.js'
import { SETTLEMENT_STATUS, type SettlementKind } from './kinds.js'
import type { CloseContext, CloseRef, DraftTerms, Loan, ProvenRepayment, RepaymentEvidence, SettlementAdapter, SettlementParams } from './types.js'

const fail = (reason: string): ProvenRepayment => ({ ok: false, reason })

/** The close must spend this loan's committed escrow output, through a derived leaf. */
export async function loadClose(terms: LoanTerms, chain: ChainClient, ref: CloseRef): Promise<CloseContext | string> {
  const lock = await chain.getTx(ref.lock_txid)
  if (!isConfirmed(lock)) return 'lock is not confirmed'
  if (!lock.outputs.some((o) => opReturnPayload(o.script) === termsHash(terms))) return 'lock does not commit to these terms'
  const out = lock.outputs[ref.lock_vout]
  if (!out || out.script !== escrowFor(partiesOf(terms)).script || out.value !== terms.collateral_sats) return 'lock output is not this loan’s escrow'
  const close = await chain.getTx(ref.outcome_txid)
  const input = close?.inputs.find((i) => i.txid === ref.lock_txid && i.vout === ref.lock_vout)
  if (!isConfirmed(close) || !input) return 'outcome is not a confirmed collateral spend'
  const leaf = spentLeaf(input, terms)
  if (!leaf) return 'outcome witness is not a derived escrow leaf'
  return { lock, close, input, leaf }
}

type Executor = (loan: Loan) => Promise<RepaymentEvidence>
const notWired = (kind: string): Executor => async () => { throw new Error(`${kind} repay executor not wired: the borrower agent supplies it`) }

export class CosignRgbAdapter implements SettlementAdapter {
  readonly kind = 'cosign-rgb' as const
  constructor(private readonly deps: { execute?: Executor } = {}) {}

  async originate(): Promise<SettlementParams> {
    return { kind: 'cosign-rgb' }
  }

  escrowLeaves(): Leaf[] {
    return []
  }

  repay(loan: Loan): Promise<RepaymentEvidence> {
    return (this.deps.execute ?? notWired(this.kind))(loan)
  }

  async verify(ev: RepaymentEvidence, terms: LoanTerms, chain: ChainClient, ref: CloseRef): Promise<ProvenRepayment> {
    if (ev.kind !== 'cosign-rgb') return fail('evidence is not a cosign-rgb receipt')
    const ctx = await loadClose(terms, chain, ref)
    if (typeof ctx === 'string') return fail(ctx)
    const r = ev.receipt
    const assignedHolder = ev.ownership && await verifyOwnership(ev.ownership, terms, chain) ? ev.ownership.holder_pk : null
    const validators = ev.ownership ? [assignedHolder] : [terms.lender_pk, terms.platform_pk]
    if (!['A', 'C'].includes(ctx.leaf) || !r || r.domain !== 'passbook-rgb-repayment-v1' || r.validation !== 'rgb-lib-settled' || !validators.includes(r.validator_pk) || !verifyObject(r, r.validator_pk) || r.loan_id !== termsHash(terms) || r.asset_id !== terms.asset_id || !Number.isSafeInteger(r.amount) || r.amount < debtOf(terms)) return fail('legacy repayment needs an authenticated RGB validation receipt')
    const repayment = await chain.getTx(r.repayment_txid)
    if (!isConfirmed(repayment) || repayment.height > ctx.close.height) return fail('RGB receipt witness is not confirmed before release')
    return { ok: true, repaid_height: repayment.height, assurance: 'signed_rgb_receipt' }
  }
}

export class LnRlnAdapter implements SettlementAdapter {
  readonly kind = 'ln-rln' as const
  constructor(private readonly deps: { node?: RgbLightningClient; execute?: Executor; now?: () => number } = {}) {}

  async originate(terms: DraftTerms): Promise<SettlementParams> {
    if (!this.deps.node) throw new Error('ln-rln needs the lender’s RGB Lightning node')
    return { kind: 'ln-rln', atomic: await createAtomicRepayment(this.deps.node, { ...terms, v: 1 }, this.deps.now?.()) }
  }

  escrowLeaves(): Leaf[] {
    return ['E']
  }

  repay(loan: Loan): Promise<RepaymentEvidence> {
    return (this.deps.execute ?? notWired(this.kind))(loan)
  }

  async verify(ev: RepaymentEvidence, terms: LoanTerms, chain: ChainClient, ref: CloseRef): Promise<ProvenRepayment> {
    if (ev.kind !== 'ln-rln') return fail('evidence is not an atomic preimage')
    if (terms.v !== 2 || !terms.atomic_repayment) return fail('terms carry no atomic repayment hash')
    const ctx = await loadClose(terms, chain, ref)
    if (typeof ctx === 'string') return fail(ctx)
    if (atomicWitnessPreimage(ctx.input, terms) !== ev.preimage) return fail('atomic proof is not the committed leaf-E witness preimage')
    return { ok: true, repaid_height: ctx.close.height, assurance: 'bitcoin_hashlock' }
  }
}

/** Pays the invoice (which returns the preimage) then hands it to the agent's leaf-E release. */
export function lnRlnExecutor(node: RgbLightningClient, release: (loan: Loan, preimage: Hex) => Promise<void>, opts: { escrowUnspent: (loan: Loan) => Promise<boolean> }): Executor {
  return async (loan) => {
    // Never pay into a loan whose collateral already moved.
    if (!(await opts.escrowUnspent(loan))) throw new Error('escrow is already spent; not paying')
    const preimage = await payAtomicInvoice(node, loan.terms)
    await release(loan, preimage)
    return { kind: 'ln-rln', preimage }
  }
}

export class OnchainSwapAdapter implements SettlementAdapter {
  readonly kind = 'onchain-swap' as const
  private refuse(): never {
    throw new Error(`onchain-swap is not built: ${SETTLEMENT_STATUS['onchain-swap'].note}`)
  }
  async originate(): Promise<SettlementParams> { return this.refuse() }
  escrowLeaves(): Leaf[] { return this.refuse() }
  async repay(): Promise<RepaymentEvidence> { return this.refuse() }
  async verify(): Promise<ProvenRepayment> { return fail('onchain-swap is not built') }
}

const DEFAULT_ADAPTERS: Record<SettlementKind, SettlementAdapter> = { 'cosign-rgb': new CosignRgbAdapter(), 'ln-rln': new LnRlnAdapter(), 'onchain-swap': new OnchainSwapAdapter() }

export function settlementAdapter(kind: SettlementKind): SettlementAdapter {
  return DEFAULT_ADAPTERS[kind]
}

/** The kinds the terms commit to: v2 binds ln-rln and keeps the co-signed leaf C fallback. */
export function settlementKindsFor(terms: LoanTerms): SettlementKind[] {
  return terms.v === 2 && terms.atomic_repayment ? ['ln-rln', 'cosign-rgb'] : ['cosign-rgb']
}

export function settlementOf(terms: LoanTerms): SettlementParams {
  return terms.v === 2 && terms.atomic_repayment ? { kind: 'ln-rln', atomic: terms.atomic_repayment } : { kind: 'cosign-rgb' }
}

/** Writes the kind into the terms, so the on-chain terms hash binds it. */
export function applySettlement(draft: DraftTerms, params: SettlementParams): LoanTerms {
  if (params.kind === 'cosign-rgb') return { ...draft, v: 1 }
  if (params.kind === 'ln-rln') return { ...draft, v: 2, atomic_repayment: params.atomic }
  throw new Error('onchain-swap is not built')
}

/** F2: one rule for repayment proof. Only a kind these terms commit to can prove it. */
export async function repaymentProven(terms: LoanTerms, ev: RepaymentEvidence | undefined, chain: ChainClient, ref: CloseRef, adapters: Partial<Record<SettlementKind, SettlementAdapter>> = {}): Promise<ProvenRepayment> {
  if (!ev) return fail('a closing spend alone does not prove repayment')
  if (!settlementKindsFor(terms).includes(ev.kind)) return fail(`these terms do not commit to ${ev.kind} settlement`)
  return (adapters[ev.kind] ?? settlementAdapter(ev.kind)).verify(ev, terms, chain, ref)
}
