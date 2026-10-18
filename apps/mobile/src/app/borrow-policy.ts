// The borrower's own rules, set on the phone and signed by the party key (src/market/policy.ts
// BorrowerPolicy, signed with PartySigner.signObject): how much, the highest
// APR, the highest share of the bitcoin's value to borrow against, the term. The phone's agent
// never goes past them. The relay's offers are filtered and ranked against them with the shared
// engine (summarizeOffer, rankOffers, explainRanking with its template, no model); an offer is
// negotiable only when its signed 38388 event carries the lender's NegotiationTerms.
import type { Hex } from '../../../../src/core/crypto.js'
import { MICRO_PER_USDT } from '../../../../src/core/money.js'
import type { BorrowerPolicy } from '../../../../src/market/policy.js'
import type { Offer } from '../../../../src/market/orderbook.js'
import type { PartySigner } from '../agent/ports'
import { explainRanking, rankOffers, summarizeOffer, type OfferSummary, type Position } from '../../../../src/market/negotiate-engine.js'
import { negotiationTermsProblems, type NegotiationTerms } from '../../../../src/market/negotiate-nostr.js'

export interface PolicyInput { asset_id: string; principal: number; max_apr_bps: number; max_ltv_bps: number; term_blocks: number }

/** Signed with the party key over hashObject of the policy without `sig` (src/wallet/signer.ts signWith). */
export async function signPolicy(key: PartySigner, i: PolicyInput, nowS = Math.floor(Date.now() / 1000)): Promise<BorrowerPolicy> {
  return await key.signObject({
    v: 1 as const,
    kind: 'passbook-borrower-policy' as const,
    owner_pk: key.pubkey,
    asset_id: i.asset_id,
    // the amount and term are exact: the agent borrows this, for this long, or nothing
    principal: { min: i.principal, max: i.principal },
    max_apr_bps: i.max_apr_bps,
    max_ltv_bps: i.max_ltv_bps,
    term_blocks: { min: i.term_blocks, max: i.term_blocks },
    min_scorer_trust: 'dev-inprocess' as const,
    accepted_settlements: ['cosign-rgb' as const],
    issued_at: nowS,
  }) as BorrowerPolicy
}

/** The rules' plain limits, checked again on any agreement before anything is shared (code, not the model). */
export function withinRules(p: BorrowerPolicy, x: Position): string | null {
  if (x.principal < p.principal.min || x.principal > p.principal.max) return 'amount'
  if (x.apr_bps > p.max_apr_bps) return 'APR'
  if (x.ltv_bps > p.max_ltv_bps) return 'LTV'
  if (x.term_blocks < p.term_blocks.min || x.term_blocks > p.term_blocks.max) return 'term'
  if (!p.accepted_settlements.includes(x.settlement)) return 'settlement'
  return null
}

/** The lender's negotiation terms from its signed offer, if it publishes valid ones. */
export function offerTerms(offer: Offer): NegotiationTerms | null {
  const t = (offer.payload as { negotiation?: unknown }).negotiation
  if (t === undefined || negotiationTermsProblems(t).length) return null
  const terms = t as NegotiationTerms
  return terms.lender_pk === offer.lender_pk ? terms : null
}

export interface Shortlisted { offer: Offer; terms: NegotiationTerms; summary: OfferSummary; withinPolicy: boolean; why: string | null }

/**
 * The relay's offers against the signed rules: negotiable over Nostr, the same asset, the amount
 * and term inside the lender's terms, co-signed RGB settlement. The LTV is the lower of the
 * lender's ladder at this borrower's step, the rules' maximum and the passbook's allowance.
 * Ranked by total cost, then collateral (src rankOffers). An offer whose posted APR is above the
 * rules may still come down in negotiation, so it stays, marked, after the rest.
 */
export function shortlist(offers: Offer[], policy: BorrowerPolicy, ctx: { price_cents: number; step: number; allowed_ltv_bps: number; own_pk?: Hex }): { ranked: Shortlisted[]; left: { offer: Offer; why: string }[] } {
  const principal = policy.principal.max
  const term = policy.term_blocks.max
  const left: { offer: Offer; why: string }[] = []
  const kept: Shortlisted[] = []
  for (const offer of offers) {
    const p = offer.payload
    const terms = offerTerms(offer)
    let why: string | null = null
    if (ctx.own_pk && offer.lender_pk === ctx.own_pk) why = 'your own offer'
    else if (!terms) why = 'does not negotiate over Nostr'
    else if (terms.asset_id !== policy.asset_id || p.asset_id !== policy.asset_id) why = 'another asset'
    else if (principal < Math.max(p.min, terms.min_principal) || principal > Math.min(p.max, terms.max_principal)) why = `lends ${Math.max(p.min, terms.min_principal) / MICRO_PER_USDT}–${Math.min(p.max, terms.max_principal) / MICRO_PER_USDT} test USDT`
    else if (term < terms.term_blocks.min || term > terms.term_blocks.max) why = `terms of ${terms.term_blocks.min}–${terms.term_blocks.max} blocks`
    else if (!terms.accepted_settlements.includes('cosign-rgb')) why = 'settles another way than co-signed RGB'
    if (why || !terms) { left.push({ offer, why: why ?? 'no terms' }); continue }
    const ladder = p.ltv_ladder_bps[Math.min(ctx.step, p.ltv_ladder_bps.length - 1)]
    const ltv = Math.min(ladder, policy.max_ltv_bps, ctx.allowed_ltv_bps)
    const summary = summarizeOffer(offer.lender_pk, { principal, apr_bps: p.apr_bps, ltv_bps: ltv, term_blocks: term, settlement: 'cosign-rgb' }, { price_cents: ctx.price_cents })
    const withinPolicy = p.apr_bps <= policy.max_apr_bps
    const income = p.requirements.inflow_months > 0 ? `checks ${p.requirements.inflow_months} months of income in the credit check` : null
    kept.push({ offer, terms, summary, withinPolicy, why: withinPolicy ? income : `posts ${p.apr_bps / 100}%, above your ${policy.max_apr_bps / 100}%: only if it comes down in negotiation` })
  }
  const order = kept.length ? rankOffers(kept.map((k) => k.summary)) : []
  const ranked = order.map((s) => kept.find((k) => k.summary === s)!).sort((a, b) => Number(b.withinPolicy) - Number(a.withinPolicy))
  return { ranked, left }
}

/** Why the first is first, in words written from the numbers by a fixed template (no model). */
export async function rankingWords(ranked: Shortlisted[]): Promise<string> {
  return (await explainRanking(ranked.map((r) => r.summary))).text
}
