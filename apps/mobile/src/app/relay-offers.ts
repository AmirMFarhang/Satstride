// Lender offers read straight from the Nostr relay (kind 38388), pure: see offerbook.ts.
import type { Hex } from '../../../../src/core/crypto.js'
import { DEFAULT_ECONOMICS } from '../../../../src/core/economics.js'
import { KIND } from '../../../../src/market/kinds.js'
import { isOfferPayload, type OfferPayload } from '../../../../src/market/messages.js'
import type { Offer } from '../../../../src/market/orderbook.js'

export interface RelayOffer extends Offer {
  /** the platform's order book lists this same event (null: the platform could not be asked) */
  listed: boolean | null
}

export interface RelayBook { offers: RelayOffer[]; height: number; seen: number; rejected: number; relay: string }

/** Read, verify and filter the relay's offers (pure enough to test with a fake session). */
export interface OfferSources {
  relay: { relays: string[]; list<T>(kind: number): Promise<{ payload: T; event: { id: string; pubkey: string; created_at: number; tags: string[][] } }[]> }
  chain: { getHeight(): Promise<number> }
  platform: { orderbook(): Promise<{ offers: Offer[] }> }
}

export async function readRelayOffers(s: OfferSources): Promise<RelayBook> {
  const [events, height, platform] = await Promise.all([
    s.relay.list<OfferPayload>(KIND.OFFER),
    s.chain.getHeight(),
    s.platform.orderbook().catch(() => null),
  ])
  let rejected = 0
  const offers: RelayOffer[] = []
  for (const { payload, event } of events) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1]
    if (!d || !isOfferPayload(payload) || payload.apr_bps > DEFAULT_ECONOMICS.max_apr_bps || payload.expires_height <= height) { rejected++; continue }
    const id = `${event.pubkey}:${d}`
    const listed = platform ? platform.offers.some((o) => o.id === id && (o as Offer & { event_id?: string }).event_id === event.id) : null
    offers.push({ id, lender_pk: event.pubkey as Hex, event_id: event.id as Hex, payload, updated_at: event.created_at * 1000, listed } as RelayOffer)
  }
  return { offers, height, seen: events.length, rejected, relay: s.relay.relays.join(', ') }
}

