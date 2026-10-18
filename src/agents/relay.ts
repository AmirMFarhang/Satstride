// An agent's connection to the Nostr relays: publish signed events, and wait for
// the next event addressed to this key from a given counterparty and kind.
// Everything between borrower and lender travels here, NIP-44 encrypted.
//
// Public relays (docs/SERVICE-PROVIDER.md "Public relays and Mutinynet"): with
// PASSBOOK_PUBLIC_NETWORK set, every event this key signs carries the test labels,
// a `network` tag and a NIP-31 `alt` tag, and addressable offers a NIP-40
// expiration. The labels are added where the event is built and signed, so its id is
// final at creation; an event signed elsewhere by this key (a negotiation message,
// a check offer) is re-signed with the labels, same author, before any relay sees it.
// Nothing unlabelled reaches a relay off this machine. A labelled event counts as
// published only once a public relay acknowledged it (public relays first, then the
// local one), at most PASSBOOK_PUBLIC_PER_MINUTE (60) a minute per connection.
// Unset: unchanged.

import { finalizeEvent, SimplePool, type Event, type Filter } from 'nostr-tools'
import { isHex, type Hex, type KeyPair } from '../core/crypto.js'
import { isAddressable, KIND, TOPIC } from '../market/kinds.js'
import { encryptedJson, isAuthentic, publicJson, readJson } from '../market/messages.js'

export function relaysFromEnv(): string[] {
  return (process.env.PASSBOOK_RELAYS ?? `ws://127.0.0.1:${process.env.PASSBOOK_RELAY_PORT ?? 7777}`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** What every public Passbook event says about itself (the NIP-31 alt tag). */
export const testLabel = (network: string) => `Passbook test data: test USDT on ${network}, no value. Not real USDT.`

export interface PublicLabels {
  /** The test network the labels name (regtest, mutinynet). */
  network: string
  /** NIP-40 expiration for addressable events that carry none, seconds from creation. */
  offerTtlSec: number
  /** At most this many labelled events a minute from one connection; past it, publishing is refused. */
  perMinute: number
}

/** PASSBOOK_PUBLIC_NETWORK turns the labels on; absent, null and nothing changes. */
export function publicLabelsFromEnv(env: NodeJS.ProcessEnv = process.env): PublicLabels | null {
  const network = env.PASSBOOK_PUBLIC_NETWORK?.trim()
  if (!network) return null
  if (!/^[a-z0-9-]{1,32}$/.test(network) || ['mainnet', 'bitcoin', 'main'].includes(network)) throw new Error(`PASSBOOK_PUBLIC_NETWORK must name a test network, not ${network}`)
  const int = (v: string | undefined, d: number) => { const n = Number(v ?? d); if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not a positive integer: ${v}`); return n }
  return { network, offerTtlSec: int(env.PASSBOOK_PUBLIC_OFFER_TTL_S, 6 * 3600), perMinute: int(env.PASSBOOK_PUBLIC_PER_MINUTE, 60) }
}

/** A relay on this machine (the local test relay); anything else counts as public. */
export function isLocalRelay(url: string): boolean {
  try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname) } catch { return false }
}

/** The tags with the labels added once: network, alt, and for addressable kinds a NIP-40 expiration. */
export function labelTags(kind: number, tags: string[][], l: PublicLabels, createdAtSec: number): string[][] {
  const out = tags.map((t) => [...t])
  if (!out.some((t) => t[0] === 'network')) out.push(['network', l.network])
  if (!out.some((t) => t[0] === 'alt')) out.push(['alt', testLabel(l.network)])
  if (isAddressable(kind) && !out.some((t) => t[0] === 'expiration')) out.push(['expiration', String(createdAtSec + l.offerTtlSec)])
  return out
}

/** Carries both labels for this network. */
export function isLabelled(event: Pick<Event, 'tags'>, network: string): boolean {
  return event.tags.some((t) => t[0] === 'network' && t[1] === network) && (event.tags.find((t) => t[0] === 'alt')?.[1] ?? '').includes('test USDT')
}

/**
 * Node's WebSocket with an idempotent close(). With Node 22's built-in WebSocket (undici) and nostr-tools 2.25.x, a
 * relay that cannot be reached crashes the process: nostr-tools' onerror calls close() on a socket that is still
 * connecting, undici fires another error event at once, which calls close() again, until the stack overflows.
 */
export function guardedWebSocket(Base: typeof WebSocket = globalThis.WebSocket): typeof WebSocket {
  return class GuardedWebSocket extends Base {
    #closing = false
    override close(code?: number, reason?: string): void {
      if (this.#closing) return
      this.#closing = true
      try { super.close(code, reason) } catch { /* already failed or closed */ }
    }
  }
}

/** Private receive cursor for a controlled local demo, not public evidence. */
export interface RelayCheckpoint {
  v: 1
  pubkey: Hex
  relays: string[]
  since: number
  seen: Hex[]
}

export class Relay {
  // SimplePool spreads its options over its defaults at runtime; its type names only enablePing/enableReconnect
  private readonly pool = new SimplePool({ websocketImplementation: guardedWebSocket() } as ConstructorParameters<typeof SimplePool>[0])
  private readonly seen = new Set<string>()
  private readonly publicSent: number[] = []
  private openedSince = Math.floor(Date.now() / 1000) - 5
  /** Restored connections retain the original run's window for unseen events. */
  get since(): number { return this.openedSince }

  constructor(
    readonly key: KeyPair,
    readonly relays: string[] = relaysFromEnv(),
    readonly labels: PublicLabels | null = publicLabelsFromEnv(),
  ) {}

  exportCheckpoint(): RelayCheckpoint {
    return { v: 1, pubkey: this.key.pubkey, relays: [...this.relays], since: this.since, seen: [...this.seen] }
  }

  /** Restore before resuming receives; never forget an already consumed ID. */
  restoreCheckpoint(snapshot: RelayCheckpoint): void {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).sort().join(',') !== 'pubkey,relays,seen,since,v' || snapshot.v !== 1 || !isHex(snapshot.pubkey, 32) || snapshot.pubkey !== this.key.pubkey) throw new Error('Relay checkpoint belongs to another key or version')
    if (!Array.isArray(snapshot.relays) || snapshot.relays.length !== this.relays.length || !Array.from(snapshot.relays).every((url, i) => typeof url === 'string' && url === this.relays[i])) throw new Error('Relay checkpoint uses different relay URLs')
    if (!Number.isSafeInteger(snapshot.since) || snapshot.since < 0 || snapshot.since > Math.floor(Date.now() / 1000)) throw new Error('Invalid relay checkpoint since')
    if (!Array.isArray(snapshot.seen) || !Array.from(snapshot.seen).every((id) => isHex(id, 32)) || new Set(snapshot.seen).size !== snapshot.seen.length) throw new Error('Invalid relay checkpoint consumed IDs')
    const seen = new Set([...this.seen, ...snapshot.seen])
    this.openedSince = snapshot.since
    this.seen.clear()
    for (const id of seen) this.seen.add(id)
  }

  async publish(event: Event): Promise<Event> {
    const out = this.labels ? this.labelOwn(event) : event
    const targets = this.labels ? this.targetsFor(out) : this.relays
    if (!targets.length) throw new Error(`no relay may carry event ${out.id.slice(0, 8)}: it is not labelled test data and only public relays are configured`)
    const remote = this.labels ? targets.filter((r) => !isLocalRelay(r)) : []
    if (remote.length) {
      // With public relays configured, a labelled event counts as published only once a public relay acknowledged it.
      // The public relays go first and the local relay only after that, so a refusal leaves it nowhere: both sides of
      // a conversation see the same messages, whichever relays they read.
      const pub = await Promise.allSettled(this.pool.publish(remote, out))
      if (!pub.some((r) => r.status === 'fulfilled')) throw new Error(`no public relay accepted event ${out.id.slice(0, 8)} (${pub.map((r, i) => `${remote[i]}: ${String((r as PromiseRejectedResult).reason)}`).join('; ')}); not sent to the local relay either`)
      const local = targets.filter(isLocalRelay)
      if (local.length) await Promise.allSettled(this.pool.publish(local, out))
      return out
    }
    const results = await Promise.allSettled(this.pool.publish(targets, out))
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error(`no relay accepted event ${out.id.slice(0, 8)}: ${results.map((r) => (r as PromiseRejectedResult).reason).join('; ')}`)
    return out
  }

  publishPublic(kind: number, payload: unknown, tags: string[][] = []): Promise<Event> {
    const now = Date.now()
    return this.publish(publicJson(this.key, kind, payload, this.labels ? labelTags(kind, tags, this.labels, Math.floor(now / 1000)) : tags, now))
  }

  send(kind: number, payload: unknown, to: Hex, tags: string[][] = []): Promise<Event> {
    const now = Date.now()
    return this.publish(encryptedJson(this.key, kind, payload, to, this.labels ? labelTags(kind, tags, this.labels, Math.floor(now / 1000)) : tags, now))
  }

  /** This key's event with the labels (re-signed, same author, if it lacks them); another author's event unchanged. */
  private labelOwn(event: Event): Event {
    if (event.pubkey !== this.key.pubkey || isLabelled(event, this.labels!.network)) return event
    const labelled = finalizeEvent({ kind: event.kind, created_at: event.created_at, content: event.content, tags: labelTags(event.kind, event.tags, this.labels!, event.created_at) }, this.key.secretKey)
    if (labelled.pubkey !== event.pubkey) throw new Error('labelling changed the author; refusing to publish')
    return labelled
  }

  /** An unlabelled event: the local relays only. A labelled one: every relay, within the public rate limit (refused past it). */
  private targetsFor(event: Event): string[] {
    const remote = this.relays.filter((r) => !isLocalRelay(r))
    if (!remote.length || !isLabelled(event, this.labels!.network)) return this.relays.filter(isLocalRelay)
    const now = Date.now()
    while (this.publicSent.length && this.publicSent[0] <= now - 60_000) this.publicSent.shift()
    if (this.publicSent.length >= this.labels!.perMinute) throw new Error(`public relay limit (${this.labels!.perMinute} events a minute) reached; event ${event.id.slice(0, 8)} not published`)
    this.publicSent.push(now)
    return this.relays
  }

  /**
   * The next unseen event of `kind` from `from` (anyone when null) to this key, decrypted. Events
   * published before the wait started but after this connection opened are
   * included (the counterparty may be quicker), and each is handed out once.
   */
  async publicEvents(kind: number): Promise<Event[]> {
    const events = await this.pool.querySync(this.relays, { kinds: [kind], '#t': [TOPIC] }, { maxWait: 3000 })
    return events.filter(isAuthentic)
  }

  receive<T>(kind: number, from: Hex | null, opts: { timeoutMs?: number; since?: number; match?: (payload: T) => boolean } = {}): Promise<{ payload: T; event: Event }> {
    const filter: Filter = { kinds: [kind], '#p': [this.key.pubkey], '#t': [TOPIC], since: opts.since ?? this.since }
    if (from) filter.authors = [from]
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close()
        reject(new Error(`timed out waiting for kind ${kind} from ${from?.slice(0, 8) ?? 'anyone'}`))
      }, opts.timeoutMs ?? 60_000)
      const sub = this.pool.subscribeMany(this.relays, filter, {
        onevent: (event) => {
          if (this.seen.has(event.id) || !isAuthentic(event)) return
          let payload: T
          try {
            payload = readJson<T>(event, this.key)
          } catch {
            return
          }
          if (opts.match && !opts.match(payload)) return
          this.seen.add(event.id)
          clearTimeout(timer)
          sub.close()
          resolve({ payload, event })
        },
      })
    })
  }

  close(): void {
    this.pool.close(this.relays)
  }
}

export { KIND }
