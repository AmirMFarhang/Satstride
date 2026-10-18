// Passbook on public Nostr relays: which relays, the test labels every public event
// carries, and a publish rate limit (docs/SERVICE-PROVIDER.md "Public relays and Mutinynet").
//
// Every event that leaves for a public relay is test data and says so:
//   - a `network` tag (regtest, mutinynet);
//   - a NIP-31 `alt` tag: "Passbook test data: test USDT on <network>, no value";
//   - addressable offers also carry a NIP-40 `expiration` and, where the payload allows
//     extra fields (the 38388 OfferPayload does), the same words in the content.
// Signed message bodies (negotiation messages, check offers) keep their exact content:
// they are signed objects, so their label is in the tags.
// The relays were chosen by infra/public-relay-probe.ts on 18 Oct 2026 (docs/PUBLIC-NETWORK-RUN.json).

import './public-ws-guard.mjs'
import type { Event } from 'nostr-tools'
import { testLabel } from '../src/agents/relay.js'
import type { KeyPair } from '../src/core/crypto.js'
import { signEvent } from '../src/market/messages.js'
import { keyPairSigner, poolTransport, type NegotiationSigner, type NegotiationTransport, type NostrEvent, type PoolLike } from '../src/market/negotiate-nostr.js'

/** Accepted and stored every Passbook kind (38388, 38401, 7490, 7491, 7533, 7541, 38540) in the 18 Oct probe. */
export const PUBLIC_RELAYS: readonly string[] = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom']
/** Also accepted every kind; not in the default list (damus dropped one connection, the others were slower). */
export const PUBLIC_RELAY_ALTERNATES: readonly string[] = ['wss://relay.damus.io', 'wss://relay.snort.social', 'wss://offchain.pub']
/** Offers expire on public relays after this long unless republished (NIP-40). */
export const DEFAULT_OFFER_TTL_S = 6 * 3600
/** At most this many events per minute from one process to the public relays. */
export const DEFAULT_PUBLIC_PER_MINUTE = 30

/** The same words the agents' Relay puts in every labelled event (src/agents/relay.ts). */
export { testLabel }

/** A comma-separated relay list: public relays must be wss://; ws:// only for a local relay. */
export function parseRelays(value: string | undefined): string[] {
  const relays = [...new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
  for (const r of relays) {
    let u: URL
    try { u = new URL(r) } catch { throw new Error(`not a relay URL: ${r}`) }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && local)) throw new Error(`public relays must use wss:// (${r})`)
  }
  return relays
}

/** The tags plus the network and alt labels (each added once). */
export function labelTags(tags: string[][], network: string): string[][] {
  const out = tags.map((t) => [...t])
  if (!out.some((t) => t[0] === 'network')) out.push(['network', network])
  if (!out.some((t) => t[0] === 'alt')) out.push(['alt', testLabel(network)])
  return out
}

/** Carries both labels for this network. */
export function isLabelled(event: Pick<Event, 'tags'>, network?: string): boolean {
  const n = event.tags.find((t) => t[0] === 'network')?.[1]
  const alt = event.tags.find((t) => t[0] === 'alt')?.[1] ?? ''
  return !!n && (network === undefined || n === network) && alt.includes('test USDT')
}

/** The party key as a NegotiationSigner whose Nostr events carry the labels (negotiate-nostr signs through signEvent). */
export function labelledSigner(key: KeyPair, network: string): NegotiationSigner {
  const base = keyPairSigner(key)
  return { ...base, signEvent: async (t) => signEvent(key, t.kind, t.content, labelTags(t.tags, network), t.created_at * 1000) as NostrEvent }
}

/** A sliding one-minute window. */
export class RateLimit {
  private readonly sent: number[] = []
  constructor(readonly perMinute: number, private readonly now: () => number = Date.now) {}
  take(): boolean {
    const t = this.now()
    while (this.sent.length && this.sent[0] <= t - 60_000) this.sent.shift()
    if (this.sent.length >= this.perMinute) return false
    this.sent.push(t)
    return true
  }
}

/** Every event published here, for the run record (id, kind, relays that accepted). */
export interface PublishedEvent { id: string; kind: number; created_at: number; accepted_by: string[]; refused_by: { relay: string; reason: string }[] }

/**
 * A negotiation transport over public relays that refuses an unlabelled event or one over the rate limit (the
 * negotiation then ends with TRANSPORT) and records which relays accepted each event.
 */
export function publicTransport(pool: PoolLike, relays: string[], network: string, o: { perMinute?: number; log?: PublishedEvent[] } = {}): NegotiationTransport {
  const limit = new RateLimit(o.perMinute ?? DEFAULT_PUBLIC_PER_MINUTE)
  const base = poolTransport(pool, relays)
  return {
    subscribe: base.subscribe,
    async publish(event) {
      if (!isLabelled(event, network)) throw new Error(`refusing to publish unlabelled event ${event.id.slice(0, 8)} to public relays`)
      if (!limit.take()) throw new Error(`public relay rate limit (${limit.perMinute}/min) reached; event ${event.id.slice(0, 8)} not sent`)
      const results = await Promise.allSettled(pool.publish(relays, event))
      const row: PublishedEvent = { id: event.id, kind: event.kind, created_at: event.created_at, accepted_by: [], refused_by: [] }
      results.forEach((r, i) => { if (r.status === 'fulfilled') row.accepted_by.push(relays[i]); else row.refused_by.push({ relay: relays[i], reason: String(r.reason).slice(0, 120) }) })
      o.log?.push(row)
      if (!row.accepted_by.length) throw new Error(`no public relay accepted event ${event.id.slice(0, 8)}`)
    },
  }
}
