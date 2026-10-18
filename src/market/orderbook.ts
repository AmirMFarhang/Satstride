// The platform's view of the order book: every valid, unexpired offer event
// seen on the relays, keyed by (lender, d-tag) so a republished offer replaces
// the old one. Offers are data from strangers: signature-checked, schema-
// checked, never trusted beyond that. Offers above the APR cap are refused,
// and a lender with an overdue platform fee (the gate) has new offers refused
// and its listed offers hidden until it pays. That enforcement is only as
// strong as this indexer: the same offer can still sit on an open relay.

import { SimplePool, type Event, type Filter } from 'nostr-tools'
import type { Hex } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, type Economics } from '../core/economics.js'
import type { Store } from '../registry/store.js'
import { KIND, TOPIC } from './kinds.js'
import { isAuthentic, isOfferPayload, tag, wireCopy, type OfferPayload } from './messages.js'

export interface Offer {
  id: string
  lender_pk: Hex
  event_id: string
  payload: OfferPayload
  updated_at: number
}

export type OfferListener = (offer: Offer, action: 'upsert' | 'delete') => void

export class OrderBook {
  private readonly listeners: OfferListener[] = []
  private pool?: SimplePool
  private closers: { close(): void }[] = []

  constructor(
    private readonly store: Store,
    private readonly opts: { economics?: Economics; gate?: (lenderPk: Hex, height: number) => string | null } = {},
  ) {}

  onChange(l: OfferListener): void {
    this.listeners.push(l)
  }

  /** Validate and record an offer event. Returns the offer, or a reason it was rejected. */
  ingest(input: Event, height?: number): { offer?: Offer; rejected?: string } {
    const event = wireCopy(input)
    if (event.kind !== KIND.OFFER) return { rejected: `kind ${event.kind} is not an offer` }
    if (!isAuthentic(event)) return { rejected: 'bad signature' }
    if (tag(event, 't') !== TOPIC) return { rejected: 'not a passbook event' }
    const d = tag(event, 'd')
    if (!d) return { rejected: 'missing d tag' }
    let payload: unknown
    try {
      payload = JSON.parse(event.content)
    } catch {
      return { rejected: 'content is not JSON' }
    }
    if (!isOfferPayload(payload)) return { rejected: 'offer payload failed validation' }
    const cap = (this.opts.economics ?? DEFAULT_ECONOMICS).max_apr_bps
    if (payload.apr_bps > cap) return { rejected: `APR ${payload.apr_bps} bps is above the platform cap of ${cap} bps` }
    const blocked = height !== undefined ? this.opts.gate?.(event.pubkey, height) : null
    if (blocked) return { rejected: blocked }
    const id = `${event.pubkey}:${d}`
    const existing = this.store.listOffers().find((o) => o.id === id)
    if (existing && existing.updated_at >= event.created_at * 1000) return { rejected: 'older than the offer on record' }
    const offer: Offer = { id, lender_pk: event.pubkey, event_id: event.id, payload, updated_at: event.created_at * 1000 }
    this.store.upsertOffer(offer)
    for (const l of this.listeners) l(offer, 'upsert')
    return { offer }
  }

  list(currentHeight?: number): Offer[] {
    return this.store
      .listOffers()
      .map((o) => ({ ...o, payload: o.payload as OfferPayload }))
      .filter((o) => currentHeight === undefined || (o.payload.expires_height > currentHeight && !this.opts.gate?.(o.lender_pk, currentHeight)))
  }

  get(id: string): Offer | undefined {
    return this.list().find((o) => o.id === id)
  }

  /** Follow real relays. Returns once subscriptions are open; events arrive through ingest(). */
  subscribe(relays: string[]): void {
    this.pool ??= new SimplePool()
    const filter: Filter = { kinds: [KIND.OFFER], '#t': [TOPIC] }
    const sub = this.pool.subscribeMany(relays, filter, {
      onevent: (e) => {
        this.ingest(e)
      },
    })
    this.closers.push(sub)
  }

  close(): void {
    for (const c of this.closers) c.close()
    this.closers = []
  }
}
