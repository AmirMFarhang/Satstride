// The order book as one borrower sees it (pure: no React, no device), so tests run it in Node.
import { MICRO_PER_USDT } from '../../../../src/core/money.js'
import { termInterest } from '../../../../src/core/economics.js'
import type { Offer } from '../../../../src/market/orderbook.js'

export interface OfferView {
  offer: Offer
  /** principal + term interest at the offer's APR, from src/core/economics */
  payBack: number
  fits: boolean
  why: string | null
  needsIncome: boolean
}

/** The order book as one borrower sees it for an amount: what fits, cheapest first, and what does not yet. */
export function viewOffers(offers: Offer[], principal: number, limit: number, ownPk?: string): OfferView[] {
  // this wallet's own offer (it lends too) is never one it borrows from
  return offers.filter((o) => !ownPk || o.lender_pk !== ownPk).map((offer) => {
    const p = offer.payload
    const payBack = principal + termInterest({ principal, apr_bps: p.apr_bps, term_blocks: p.term_blocks })
    // a lender that negotiates over Nostr takes income from the credit check it pays for (scorer reads the
    // history); only an offer without negotiation terms needs payer-signed salary records this wallet lacks
    const negotiable = (p as { negotiation?: unknown }).negotiation !== undefined
    const needsIncome = !negotiable && p.requirements.inflow_months > 0
    let why: string | null = null
    if (needsIncome) why = `Asks for ${p.requirements.inflow_months} months of signed salary payments. This wallet has none to show.`
    else if (principal < p.min) why = `Lends from ${(p.min / MICRO_PER_USDT).toLocaleString('en-US')} test USDT.`
    else if (principal > p.max) why = `Lends up to ${(p.max / MICRO_PER_USDT).toLocaleString('en-US')} test USDT.`
    else if (principal > limit) why = `More than your limit of ${(limit / MICRO_PER_USDT).toLocaleString('en-US')} test USDT now.`
    return { offer, payBack, fits: why === null, why, needsIncome }
  }).sort((a, b) => Number(b.fits) - Number(a.fits) || a.payBack - b.payBack)
}
