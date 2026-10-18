// Picking a check node: code decides, deterministically, from both policies and
// the offers on the relay. No node is special, ours included.
//
//   1 the lender's accepted_check_operators and accepted_releases (absent = any)
//   2 min_trust: the scorer trust the release manifest grants this release
//     (verify.ts verifyDescriptor), never a claim from the offer
//   3 min_execution: 'tee' needs an attestation that already passes the
//     vendor-chain, enclave-key and measurement checks (tee.ts); freshness and
//     the result signature are checked again on the result itself
//   4 max_price, from the lender's rules and the payer's own policy
//   5 an asset and rail the payer can use; a voucher of this operator that the
//     payer holds counts as prepaid
//   then cheapest, then fastest (p50), then the operator key, so the order is total.

import type { Hex } from '../core/crypto.js'
import { trustAtLeast, TRUST_LEVELS, type TrustLevel } from '../scorer/trust.js'
import { verifyDescriptor, type TrustPolicy } from '../scorer/verify.js'
import { isHex } from '../core/crypto.js'
import { usdt } from '../core/money.js'
import { CHECK_RAILS, releaseHash, scorerDescriptor, type CheckAsset, type CheckOffer, type CheckRail } from './offer.js'
import { deriveExecution, executionAtLeast, type DerivedExecution, type MinExecution, type TeeVerifierConfig } from './tee.js'

/** The lender's rules for which check nodes it accepts (an optional LenderPolicy field). */
export interface CheckNodeRules {
  accepted_check_operators?: Hex[]
  accepted_releases?: Hex[]
  min_trust?: TrustLevel
  min_execution?: MinExecution
  max_price?: { asset_id: string; amount: number }
  /**
   * 2-of-N agreement: the borrower runs the check on two different operators
   * (the two best eligible offers) and the lender accepts only when both
   * verify and agree (verifyAgreement). 1 is the default.
   */
  agreement?: { required: 1 | 2 }
}

export interface PayerConstraints {
  payer: 'borrower' | 'lender'
  /** The asset the payer pays with (USDT on regtest). */
  payment_asset_id: string
  /** Voucher assets the payer holds at least one unit of. */
  vouchers_held?: string[]
  max_price?: { asset_id: string; amount: number }
  rails: CheckRail[]
}

export interface Candidate {
  offer: CheckOffer
  operator_pk: Hex
  release_hash: Hex
  trust: TrustLevel | null
  execution: DerivedExecution & { attestable: boolean }
  pay_with: CheckAsset | null
  /** In the payment asset's units; a held voucher is prepaid (0). */
  cost: number
  rail: CheckRail | null
  problems: string[]
}

export interface CheckNodePick {
  picked: Candidate | null
  /** 2-of-N: the second node, another operator. Null when one check is enough or none is left. */
  second: Candidate | null
  ranked: Candidate[]
  rejected: Candidate[]
  why: string[]
}

export function checkNodeRulesProblems(r: CheckNodeRules | undefined): string[] {
  if (r === undefined) return []
  const problems: string[] = []
  if (!r || typeof r !== 'object') return ['check_nodes']
  if (r.accepted_check_operators !== undefined && (!Array.isArray(r.accepted_check_operators) || !r.accepted_check_operators.every((k) => isHex(k, 32)))) problems.push('check_nodes.accepted_check_operators')
  if (r.accepted_releases !== undefined && (!Array.isArray(r.accepted_releases) || !r.accepted_releases.every((k) => isHex(k, 32)))) problems.push('check_nodes.accepted_releases')
  if (r.min_trust !== undefined && !(TRUST_LEVELS as readonly string[]).includes(r.min_trust)) problems.push('check_nodes.min_trust')
  if (r.min_execution !== undefined && r.min_execution !== 'software' && r.min_execution !== 'tee') problems.push('check_nodes.min_execution')
  if (r.max_price !== undefined && (typeof r.max_price?.asset_id !== 'string' || !Number.isSafeInteger(r.max_price.amount) || r.max_price.amount < 0)) problems.push('check_nodes.max_price')
  if (r.agreement !== undefined && r.agreement?.required !== 1 && r.agreement?.required !== 2) problems.push('check_nodes.agreement: required is 1 or 2')
  return problems
}

// Prefer the provider rail. The remaining demo rails are removed at the final default cutover.
const RAIL_PREFERENCE: CheckRail[] = ['bill-at-close', 'rgb-ln-hodl', 'rgb-ln-pay-then-deliver', 'rgb-onchain']

function evaluate(offer: CheckOffer, lender: CheckNodeRules, payer: PayerConstraints, ctx: { trust: TrustPolicy; tee: TeeVerifierConfig }): Candidate {
  const problems: string[] = []
  const rh = releaseHash(offer.release)
  // The offer's signer declares the scorer key; whether that operator is acceptable is the lender's rule (step 1).
  const descriptor = verifyDescriptor(scorerDescriptor(offer), { ...ctx.trust, minTrust: 'dev-inprocess', marketOperators: [offer.operator_pk] })
  const trust = descriptor.ok ? descriptor.trust : null
  const execution = deriveExecution(offer.execution, offer.release, ctx.tee)
  if (lender.accepted_check_operators?.length && !lender.accepted_check_operators.includes(offer.operator_pk)) problems.push('OPERATOR_NOT_ACCEPTED')
  if (lender.accepted_releases?.length && !lender.accepted_releases.includes(rh)) problems.push('RELEASE_NOT_ACCEPTED')
  if (!trust) problems.push(`RELEASE_NOT_APPROVED (${descriptor.ticks.filter((t) => !t.ok).map((t) => t.id).join(',')})`)
  else if (lender.min_trust && !trustAtLeast(trust, lender.min_trust)) problems.push(`TRUST_BELOW_MIN (${trust} < ${lender.min_trust})`)
  const minExecution = lender.min_execution ?? 'software'
  if (minExecution === 'tee' && !execution.attestable) problems.push(`EXECUTION_BELOW_MIN (${offer.execution.tee === 'none' ? 'no TEE' : 'TEE claim not attestable'}: software evidence)`)
  else if (!executionAtLeast(execution.attestable ? 'tee-attested' : 'software-evidence', minExecution)) problems.push('EXECUTION_BELOW_MIN')
  const voucher = offer.accepted_assets.find((a) => a.kind === 'voucher' && payer.vouchers_held?.includes(a.asset_id))
  const payment = offer.accepted_assets.find((a) => a.kind === 'payment' && a.asset_id === payer.payment_asset_id)
  const payWith = voucher ?? payment ?? null
  if (!payWith) problems.push('NO_ACCEPTED_ASSET')
  const cost = voucher ? 0 : payment?.amount ?? Number.MAX_SAFE_INTEGER
  for (const cap of [lender.max_price, payer.max_price]) {
    if (!cap || voucher) continue
    if (cap.asset_id !== payer.payment_asset_id) problems.push('MAX_PRICE_OTHER_ASSET')
    else if (cost > cap.amount) problems.push(`PRICE_ABOVE_MAX (${cost} > ${cap.amount})`)
  }
  // A voucher is redeemed on chain unless the payer holds it in a channel; a payment prefers the HODL rail.
  const rails = RAIL_PREFERENCE.filter((r) => offer.rails.includes(r) && payer.rails.includes(r) && (CHECK_RAILS as readonly string[]).includes(r))
  const rail = rails[0] ?? null
  if (!rail) problems.push('NO_COMMON_RAIL')
  if (!offer.payer_modes.includes(payer.payer)) problems.push('PAYER_MODE')
  return { offer, operator_pk: offer.operator_pk, release_hash: rh, trust, execution, pay_with: payWith, cost, rail, problems }
}

export function pickCheckNode(offers: CheckOffer[], lender: CheckNodeRules, payer: PayerConstraints, ctx: { trust: TrustPolicy; tee: TeeVerifierConfig }): CheckNodePick {
  const all = offers.map((o) => evaluate(o, lender, payer, ctx))
  const eligible = all.filter((c) => c.problems.length === 0)
  const ranked = [...eligible].sort((a, b) => a.cost - b.cost || a.offer.p50_seconds - b.offer.p50_seconds || (a.operator_pk < b.operator_pk ? -1 : a.operator_pk > b.operator_pk ? 1 : 0))
  const rejected = all.filter((c) => c.problems.length > 0)
  const two = lender.agreement?.required === 2
  const first = ranked[0] ?? null
  const second = two && first ? ranked.find((c) => c.operator_pk !== first.operator_pk) ?? null : null
  const picked = two && !second ? null : first
  const why: string[] = []
  if (two && first && !second) why.push('The lender asks for 2-of-N agreement, and only one operator meets both policies.')
  else if (!picked) why.push(offers.length ? 'No check node meets both policies.' : 'No check node offer on the relay.')
  else {
    const next = ranked[1]
    why.push(`${eligible.length} of ${offers.length} offers meet the lender's rules and the payer's limits.`)
    why.push(picked.cost === 0 ? `Paid with a voucher held for operator ${picked.operator_pk.slice(0, 8)}.` : `Cheapest: ${picked.pay_with?.ticker === 'USDT' ? usdt(picked.cost) : `${picked.cost} base units of ${picked.pay_with?.ticker ?? '?'}`}${next && next.cost !== picked.cost ? ` (next: ${picked.pay_with?.ticker === 'USDT' ? usdt(next.cost) : next.cost})` : ''}.`)
    if (next && next.cost === picked.cost) why.push(next.offer.p50_seconds === picked.offer.p50_seconds ? 'Same price and speed: the lower operator key breaks the tie.' : `Same price; faster (p50 ${picked.offer.p50_seconds}s against ${next.offer.p50_seconds}s).`)
    if (second) why.push(`2-of-N agreement: also ${second.operator_pk.slice(0, 8)}, the next eligible operator.`)
    for (const r of rejected) why.push(`Not ${r.operator_pk.slice(0, 8)}: ${r.problems.join(', ')}.`)
  }
  return { picked, second: picked ? second : null, ranked, rejected, why }
}

/**
 * 2-of-N: the lender accepts only when every forwarded check verified, the
 * operators differ, and the results agree on the recommendation and income
 * band. Code compares; nothing is averaged or chosen.
 */
export function agreementProblems(results: { ok: boolean; operator_pk: string | null; outputs?: { recommendation: string; income_band: string } | null }[], required: 1 | 2): string[] {
  const problems: string[] = []
  if (results.length < required) problems.push(`AGREEMENT_NEEDS_${required}_CHECKS`)
  if (results.some((r) => !r.ok || !r.outputs)) problems.push('AGREEMENT_A_CHECK_FAILED')
  if (new Set(results.map((r) => r.operator_pk)).size !== results.length) problems.push('AGREEMENT_SAME_OPERATOR')
  const outs = results.map((r) => r.outputs).filter((o): o is NonNullable<typeof o> => !!o)
  if (outs.length > 1 && outs.some((o) => o.recommendation !== outs[0].recommendation || o.income_band !== outs[0].income_band)) problems.push('AGREEMENT_RESULTS_DIFFER')
  return problems
}
