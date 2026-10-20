import { PROVIDER_TRUST, trustAtLeast, weakerTrust, type TrustLevel } from '../../../../src/scorer/trust.js'
// The lender phone's credit check of an agreed negotiation, billed at close (lane E2's
// rail, the user's "Bill at close" decision): the borrower's sealed part arrives over the
// relay (kind 7533), the lender asks the local check node to run it on credit and opens
// the result on this phone: the selected scorer signature, signed run record and v2 binding to this loan,
// the operator's bill) and forwards K to the borrower whatever it says. No money moves
// for the check now: the operator's signed bill is added to the platform fee this lender
// pays over RGB when the loan closes. Code decides: only a verified QUALIFY is ever
// underwritten, and this file checks the binding and the bill again on its own.
import { hashObject, type Hex } from '../../../../src/core/crypto.js'
import { DEFAULT_ECONOMICS, termInterest, type Economics } from '../../../../src/core/economics.js'
import { usdt } from '../../../../src/core/money.js'
import type { LenderPolicy as OfferPolicy } from '../../../../src/agents/lender.js'
import type { Position } from '../../../../src/market/negotiate-engine.js'
import { KIND } from '../../../../src/market/kinds.js'
import { latestOffers, offerHash, type CheckOffer } from '../../../../src/checknode/offer.js'
import { checkMessageHash } from '../../../../src/checknode/messages.js'
import type { BorrowerCheckPart, CheckTick, CheckTransport } from '../../../../src/checknode/borrower-check.js'
import type { CheckSigner } from '../../../../src/checknode/signer.js'
import { scoredLoanProblems } from '../../../../src/scorer/bundle-terms.js'
import type { PortableScorerKey } from '../../../../src/scorer/portable-evidence.js'
import type { ScoredLoan, ScorerOutcome } from '../../../../src/scorer/types.js'
import type { MarketPolicy } from './market-policy'
// Lane E2's browser-safe lender half (src/checknode/lender-core.ts, #71).
import * as core from '../../../../src/checknode/lender-core.js'
import type { LenderBilledCheckResult, PortableCheckBus } from '../../../../src/checknode/lender-core.js'
export type { LenderBilledCheckResult }

export { CheckRefused } from '../../../../src/checknode/lender-core.js'

/** How the rail is named everywhere on the phone (E2's label). */
export const BILLED_LABEL = 'Credit check billed at close, not paid up front'
export { BILL_RAIL_LABEL } from '../../../../src/checknode/bill.js'

/** The loan this lender agreed: the check's outputs (v2) must name exactly it (as LenderAgent.payForCheck builds it). */
export function agreedLoan(agreed: Position, offer: Pick<OfferPolicy, 'term_blocks' | 'grace_blocks' | 'requirements'>, assetId: string, e: Economics = DEFAULT_ECONOMICS): ScoredLoan {
  return {
    loan_request: { principal: agreed.principal, fee: termInterest({ principal: agreed.principal, apr_bps: agreed.apr_bps, term_blocks: offer.term_blocks }, e), term_blocks: offer.term_blocks, grace_blocks: offer.grace_blocks },
    asset_id: assetId,
    lender_requirements_hash: hashObject(offer.requirements),
  }
}

/** What the phone keeps of a check (the verified result, the KEY's hash, the bill; never the bundle), in app storage so a restart can still build the sheet. */
export interface CheckRecord {
  negotiation_id: Hex
  borrower_pk: Hex
  operator_pk: Hex
  ok: boolean
  ticks: CheckTick[]
  recommendation: string | null
  income_band: string | null
  execution_id: string | null
  /** checkMessageHash of the KEY forwarded to the borrower: the application must name exactly it */
  key_hash: Hex
  consent_hash: Hex
  /** The local scorer host and isolation limits this phone cannot prove. */
  not_run: string[]
  rail_label: string
  /** the operator-signed bill, charged with this lender's platform fee at close */
  bill: { bill_hash: Hex; operator_pk: Hex; asset_id: string; amount: number; expires_at: number; label: string }
  /** why this check does not allow underwriting; empty only for a verified QUALIFY of exactly this loan */
  refusals: string[]
  at: number
  /** the released outcome this phone verified (signed result and released text): the term sheet binds its digest; cleared once the sheet is sent */
  outcome: ScorerOutcome | null
}

/**
 * Whether this check allows underwriting, decided by code: E2's verification passed, the outputs are v2 and name
 * exactly the agreed loan, the recommendation is QUALIFY, the KEY is this negotiation's, and the bill is the
 * operator's for this lender, borrower and negotiation, due at close in the loan's asset. Every reason it does not.
 */
export function checkRefusals(r: LenderBilledCheckResult, x: { lenderPk: Hex; borrowerPk: Hex; negotiationId: Hex; operatorPk: Hex; loan: ScoredLoan; minimumTrust?: TrustLevel }): string[] {
  const out: string[] = []
  if (!r.ok) out.push(`the check did not verify on this phone: ${r.ticks.filter((t) => !t.ok).map((t) => t.id).join(', ') || 'no ticks'}`)
  if (!r.outcome) out.push('no signed scorer outcome')
  else if (x.minimumTrust && !trustAtLeast(weakerTrust(PROVIDER_TRUST[r.outcome.descriptor.provider], r.outcome.descriptor.trust), x.minimumTrust)) out.push(`scorer trust is below this lender's signed minimum ${x.minimumTrust}`)
  const o = r.outputs
  if (!o) out.push('no released outputs')
  else {
    out.push(...scoredLoanProblems(o, x.loan))
    if (o.borrower_pk !== x.borrowerPk || o.lender_pk !== x.lenderPk) out.push('the outputs are bound to another borrower or lender')
    if (o.recommendation !== 'QUALIFY') out.push(`recommendation ${o.recommendation}: only QUALIFY is funded`)
  }
  if (r.key?.negotiation_id !== x.negotiationId) out.push('the KEY is for another negotiation')
  const b = r.bill
  if (!b || b.kind !== 'passbook-check-bill' || b.due !== 'at-close') out.push('no bill due at close')
  else {
    if (b.lender_pk !== x.lenderPk || b.borrower_pk !== x.borrowerPk || b.negotiation_id !== x.negotiationId) out.push('the bill names another lender, borrower or negotiation')
    if (b.operator_pk !== x.operatorPk) out.push('the bill is from another check node')
    if (b.fee.asset_id !== x.loan.asset_id) out.push('the bill is in another asset than the loan')
    if (!Number.isSafeInteger(b.fee.amount) || b.fee.amount < 0) out.push('the bill has no valid amount')
  }
  return out
}

export function checkRecord(r: LenderBilledCheckResult, x: Parameters<typeof checkRefusals>[1], at = Math.floor(Date.now() / 1000)): CheckRecord {
  return {
    negotiation_id: x.negotiationId, borrower_pk: x.borrowerPk, operator_pk: x.operatorPk, ok: r.ok, ticks: r.ticks,
    recommendation: r.outputs?.recommendation ?? null, income_band: r.outputs?.income_band ?? null, execution_id: r.execution_id,
    not_run: r.not_run ?? [], rail_label: r.rail_label,
    key_hash: checkMessageHash(r.key), consent_hash: r.consent_hash,
    bill: { bill_hash: r.bill_hash, operator_pk: r.bill?.operator_pk, asset_id: r.bill?.fee.asset_id, amount: r.bill?.fee.amount, expires_at: r.bill?.expires_at, label: BILLED_LABEL },
    refusals: checkRefusals(r, x), at, outcome: r.outcome,
  }
}

/** The words the phone shows for the bill. */
export function billWords(amount: number, unit = 'test USDT'): string {
  return `${BILLED_LABEL}: ${usdt(amount).replace(/ ?USDT$/, '')} ${unit}, added to the platform fee`
}

/** The functions of E2's lender half the phone calls (injectable for tests). */
export interface CheckCore {
  portableBus: typeof core.portableBus
  receivePartPortable(bus: PortableCheckBus, borrowerPk: Hex, negotiationId: Hex, timeoutMs?: number): Promise<BorrowerCheckPart>
  runLenderCheckBilled: typeof core.runLenderCheckBilled
}
export const E2_CORE: CheckCore = core

/** The check node's current offer with this hash, from the relay's kind-38401 offers (checked and signed by their operators). */
export async function findCheckOffer(list: (kind: number) => Promise<{ payload: unknown; event: { created_at: number; pubkey: string } }[]>, hash: Hex, nowS = Math.floor(Date.now() / 1000)): Promise<CheckOffer | null> {
  const events = await list(KIND.CHECK_OFFER)
  const { valid } = latestOffers(events.map((e) => ({ offer: e.payload, created_at: e.event.created_at, pubkey: e.event.pubkey as Hex })), nowS)
  return valid.find((o) => offerHash(o) === hash) ?? null
}

export type CheckStage = 'waiting-part' | 'part' | 'requested' | 'approval' | 'running' | 'result' | 'forwarded' | 'refused'

/**
 * The whole lender side of one billed check: the borrower's part, the check node's offer (from the
 * relay, which must list bill-at-close for a lender payer, and be one this lender's signed policy
 * accepts), E2's run, and the record. Throws CheckRefused before the node runs anything.
 */
export async function runBilledCheck(o: {
  core?: CheckCore
  transport: CheckTransport
  signer: CheckSigner
  borrowerPk: Hex
  negotiationId: Hex
  agreed: Position
  offer: Pick<OfferPolicy, 'term_blocks' | 'grace_blocks' | 'requirements'>
  assetId: string
  policy: MarketPolicy
  evidenceKeys: PortableScorerKey[]
  /** Public-network test-data labels, included before every check event is signed. */
  tags?: string[][]
  /** Explicitly permit a development signer in a labelled test rehearsal. */
  allowDevelopment?: boolean
  listOffers: (kind: number) => Promise<{ payload: unknown; event: { created_at: number; pubkey: string } }[]>
  partTimeoutMs?: number
  timeoutMs?: number
  approvalTimeoutMs?: number
  onStage?: (stage: CheckStage, detail?: Record<string, unknown>) => void
  economics?: Economics
}): Promise<CheckRecord> {
  const c = o.core ?? E2_CORE
  const stage = (s: CheckStage, d?: Record<string, unknown>) => o.onStage?.(s, d)
  const bus = c.portableBus(o.transport, o.signer, { tags: o.tags })
  try {
    stage('waiting-part')
    const part = await c.receivePartPortable(bus, o.borrowerPk, o.negotiationId, o.partTimeoutMs ?? 600_000)
    stage('part', { operator: part.operator_pk })
    const offer = await findCheckOffer(o.listOffers, part.offer_hash)
    if (!offer) throw new core.CheckRefused('OFFER_NOT_FOUND: the check node\'s offer the part names is not on the relay')
    const loan = agreedLoan(o.agreed, o.offer, o.assetId, o.economics)
    const rules = o.policy.check_nodes ?? {}
    stage('requested', { operator: offer.operator_pk })
    const r = await c.runLenderCheckBilled({
      bus, signer: o.signer, part, offer, loan, evidenceKeys: o.evidenceKeys, requiredChecks: [...o.policy.required_checks], ...(o.allowDevelopment ? { allowDevelopment: true } : {}),
      rules: { accepted_check_operators: rules.accepted_check_operators, accepted_releases: rules.accepted_releases, max_price: rules.max_price },
      timeoutMs: o.timeoutMs, approvalTimeoutMs: o.approvalTimeoutMs,
      onStage: (s, d) => stage(s === 'approval-relayed' || s === 'approved' ? 'approval' : s === 'billed' ? 'running' : s === 'key-forwarded' || s === 'verified' ? 'result' : 'requested', { node: s, detail: d }),
    })
    stage('forwarded', { ok: r.ok, recommendation: r.outputs?.recommendation ?? null })
    return checkRecord(r, { lenderPk: o.signer.pubkey, borrowerPk: o.borrowerPk, negotiationId: o.negotiationId, operatorPk: offer.operator_pk, loan, minimumTrust: o.policy.min_scorer_trust })
  } finally { bus.close() }
}
