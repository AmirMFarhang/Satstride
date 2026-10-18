// The phone lender's signed market policy (src/market/policy.ts LenderPolicy) and what its
// 38388 offer publishes from it (NegotiationTerms: the structure only, never the APR floor
// or the LTV cap), built from the offer the person posts. The person approves it on the
// post stop; the agent then never signs a move outside it (negotiate-nostr.ts enforces it
// before signing, and the review checks the agreement against it again).
// policy.ts itself loads node:fs, so the phone signs the same object with the party key
// (signObject: BIP-340 over hashObject without `sig`, as signWith); a laptop parity test
// runs policy.ts's lenderPolicyProblems and policyValid on it.
import type { Hex } from '../../../../src/core/crypto.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm, type Economics } from '../../../../src/core/economics.js'
import type { Micro } from '../../../../src/core/money.js'
import type { LenderPolicy as OfferPolicy } from '../../../../src/agents/lender.js'
import type { LenderPolicy as MarketPolicy } from '../../../../src/market/policy.js'
import { DEFAULT_TOLERANCE, type EngineParams, type Position } from '../../../../src/market/negotiate-engine.js'
import { negotiationTerms, negotiationTermsProblems, type NegotiationTerms } from '../../../../src/market/negotiate-nostr.js'
import type { PartySigner } from '../agent/ports'

export type { MarketPolicy }

/** What the person chooses on the post stop, besides the offer itself. */
export interface MarketChoice {
  /** the lowest APR the agent may agree to (the offer's APR is where it opens) */
  floor_apr_bps: number
  /** the check nodes this lender accepts (operator keys); the check is billed at close */
  check_operators: Hex[]
  /** the most a check may cost, billed at close; none = any price the node offers */
  max_check_price?: { asset_id: string; amount: Micro }
}

/**
 * The post stop's choice for the check node the person picked: its operator, and its price as the most a check
 * may be billed, so the approval caps exactly the charge on screen (a later, dearer offer from the same node is refused).
 */
export function marketChoice(node: { operator_pk: Hex; price: Micro }, floorAprBps: number, assetId: string): MarketChoice {
  return { floor_apr_bps: floorAprBps, check_operators: [node.operator_pk], max_check_price: { asset_id: assetId, amount: node.price } }
}

/** This offer's requirements as the scorer's check ids (src/agents/lender.ts requiredScorerChecks, without a market policy's own list). */
export function requiredChecks(req: OfferPolicy['requirements']): string[] {
  return [...new Set([...(req.investigation === 'required' ? ['investigation'] : []), ...(req.reconciliation === 'required' ? ['reconcile'] : []), ...(req.affordability ? ['affordability'] : []), ...(req.inflow_months > 0 ? ['inflows'] : [])])]
}

/** The highest LTV this offer ever lends at: the top of its ladder, under the platform's limit for the term. */
export function maxLtv(offer: Pick<OfferPolicy, 'ltv_ladder_bps' | 'term_blocks'>, e: Economics = DEFAULT_ECONOMICS): number {
  return Math.min(Math.max(...offer.ltv_ladder_bps), maxLtvForTerm(offer.term_blocks, e))
}

/** The unsigned market policy for this offer and choice: every bound written out, nothing implied. */
export function marketPolicyInput(pubkey: Hex, assetId: string, offer: OfferPolicy, c: MarketChoice, issuedAt: number, e: Economics = DEFAULT_ECONOMICS): Omit<MarketPolicy, 'sig'> {
  if (!Number.isSafeInteger(c.floor_apr_bps) || c.floor_apr_bps < 0 || c.floor_apr_bps > offer.apr_bps) throw new Error('the lowest APR must be between 0 and the offer\'s APR')
  if (offer.apr_bps > e.max_apr_bps) throw new Error(`the offer's APR is above the platform's ${e.max_apr_bps / 100}% cap`)
  if (!c.check_operators.length) throw new Error('pick at least one check node')
  return {
    v: 1, kind: 'passbook-lender-policy', owner_pk: pubkey, asset_id: assetId,
    max_per_loan: offer.max,
    // the phone lends from its own wallet: at most one offer's maximum outstanding at a time
    max_outstanding: offer.max,
    min_apr_bps: c.floor_apr_bps,
    max_ltv_bps: maxLtv(offer, e),
    term_blocks: { min: offer.term_blocks, max: offer.term_blocks },
    required_checks: requiredChecks(offer.requirements) as MarketPolicy['required_checks'],
    // the Compex check's signed evidence; the phone checks its DSSE signature and binding itself
    min_scorer_trust: 'software-evidence',
    accepted_settlements: ['cosign-rgb'],
    // one key on this phone: the person's own approval is the only one, so no loan needs a second approver
    approval_rules: { approvers: [pubkey], maker_checker_above: offer.max },
    opening: { apr_bps: offer.apr_bps },
    check_nodes: { accepted_check_operators: [...c.check_operators], ...(c.max_check_price ? { max_price: c.max_check_price } : {}) },
    issued_at: issuedAt,
  }
}

export async function signMarketPolicy(key: Pick<PartySigner, 'pubkey' | 'signObject'>, assetId: string, offer: OfferPolicy, c: MarketChoice, issuedAt = Math.floor(Date.now() / 1000)): Promise<MarketPolicy> {
  return await key.signObject(marketPolicyInput(key.pubkey, assetId, offer, c, issuedAt)) as MarketPolicy
}

/** The engine's parameters: the concession step and round limit the platform publishes (as the borrower phone reads them). */
export function engineParams(deployment: { negotiation?: { max_rounds?: number; concession_bps?: number } | null } | null | undefined, e: Economics = DEFAULT_ECONOMICS): EngineParams {
  const n = deployment?.negotiation
  const rounds = Number.isSafeInteger(n?.max_rounds) && n!.max_rounds! >= 1 && n!.max_rounds! <= 10 ? n!.max_rounds! : 6
  const step = Number.isSafeInteger(n?.concession_bps) && n!.concession_bps! > 0 && n!.concession_bps! <= 10_000 ? n!.concession_bps! : 2_500
  return { max_rounds: rounds, concession_bps: step, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: ['cosign-rgb'], economics: e }
}

/** The terms the 38388 offer carries for this policy, checked before they are published. */
export function offerTerms(policy: MarketPolicy, params: EngineParams, minPrincipal: Micro, outstanding: Micro): NegotiationTerms {
  const t = negotiationTerms(policy, { max_rounds: params.max_rounds, min_principal: minPrincipal, outstanding })
  const problems = negotiationTermsProblems(t)
  if (problems.length) throw new Error(`the offer's negotiation terms are invalid: ${problems.join(', ')}`)
  return t
}

/**
 * The agreed position against the lender's own signed policy and the platform's economics, checked again
 * after the negotiation: every reason it is outside, none means the agent stayed inside it.
 */
export function outsidePolicy(p: MarketPolicy, x: Position, e: Economics = DEFAULT_ECONOMICS): string[] {
  const out: string[] = []
  if (x.principal < 1 || x.principal > p.max_per_loan) out.push(`principal ${x.principal} outside 1..${p.max_per_loan}`)
  if (x.apr_bps < p.min_apr_bps) out.push(`APR ${x.apr_bps / 100}% below the floor ${p.min_apr_bps / 100}%`)
  if (x.apr_bps > e.max_apr_bps) out.push(`APR ${x.apr_bps / 100}% above the platform cap`)
  if (x.ltv_bps > p.max_ltv_bps || x.ltv_bps > maxLtvForTerm(x.term_blocks, e)) out.push(`LTV ${x.ltv_bps / 100}% above the cap ${Math.min(p.max_ltv_bps, maxLtvForTerm(x.term_blocks, e)) / 100}%`)
  if (x.term_blocks < p.term_blocks.min || x.term_blocks > p.term_blocks.max) out.push(`term ${x.term_blocks} blocks outside ${p.term_blocks.min}..${p.term_blocks.max}`)
  if (!p.accepted_settlements.includes(x.settlement)) out.push(`settlement ${x.settlement} not accepted`)
  return out
}
