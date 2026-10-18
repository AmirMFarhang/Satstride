// The phone's Nostr connection: the laptop agents' protocol (src/agents/relay.ts,
// src/market/messages.ts) with the signing and NIP-44 done by the party key in
// the worklet. Same kinds, tags (t=passbook, p=recipient), NIP-44 v2, same
// "each event once" rule and the same receive window.
import { SimplePool, verifyEvent, type Event, type Filter } from 'nostr-tools'
import { ENCRYPTED_KINDS, TOPIC } from '../../../../src/market/kinds.js'
import type { Hex } from '../../../../src/core/crypto.js'
import { eventOnNetwork } from '../core/network'
import type { NostrEvent, PartySigner } from './ports'

const wireCopy = (e: Event): Event => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags.map((t) => [...t]), content: e.content, sig: e.sig })

export class PhoneRelay {
  private readonly pool = new SimplePool()
  private readonly seen: Set<string>
  /** the receive window's start; the app passes one that survives restarts (relayWindow) */
  readonly since: number

  /** Tags added to every event this phone signs (the test-data labels on a public network) and the network an event must name to be read. */
  private readonly labels: string[][]
  private readonly network: { name: string; public: boolean }

  constructor(private readonly key: PartySigner, readonly relays: string[], opts: { since?: number; seen?: Iterable<string>; onSeen?: (id: string) => void; labels?: string[][]; network?: { name: string; public: boolean } } = {}) {
    this.since = opts.since ?? Math.floor(Date.now() / 1000) - 5
    this.seen = new Set(opts.seen ?? [])
    this.onSeen = opts.onSeen ?? (() => {})
    this.labels = opts.labels ?? []
    this.network = opts.network ?? { name: 'regtest', public: false }
  }
  private readonly onSeen: (id: string) => void

  private async publish(event: NostrEvent): Promise<NostrEvent> {
    const results = await Promise.allSettled(this.pool.publish(this.relays, event as Event))
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error(`no relay accepted event ${event.id.slice(0, 8)}`)
    return event
  }

  /** A public JSON event (an offer, a request), tagged like src/market/messages.ts publicJson. */
  async publishPublic(kind: number, payload: unknown, tags: string[][] = []): Promise<NostrEvent> {
    const event = await this.key.signEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [['t', TOPIC], ...tags, ...this.labels], content: JSON.stringify(payload) })
    return this.publish(event)
  }

  /**
   * The current public events of an addressable kind: verified, parsed, the newest per author
   * and `d` tag, without the ones whose NIP-40 expiration has passed (a withdrawn request).
   */
  async list<T>(kind: number, opts: { authors?: Hex[]; limit?: number } = {}): Promise<{ payload: T; event: Event }[]> {
    const filter: Filter = { kinds: [kind], '#t': [TOPIC], limit: opts.limit ?? 200 }
    if (opts.authors) filter.authors = opts.authors
    const events = await this.pool.querySync(this.relays, filter, { maxWait: 4000 })
    const now = Math.floor(Date.now() / 1000)
    const latest = new Map<string, Event>()
    for (const e of events) {
      // on a public network only events that name it (another network's offers share these relays)
      if (!verifyEvent(wireCopy(e)) || !eventOnNetwork(e.tags, this.network)) continue
      const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? ''
      const k = `${e.pubkey}:${d}`
      const prev = latest.get(k)
      if (!prev || prev.created_at < e.created_at) latest.set(k, e)
    }
    const out: { payload: T; event: Event }[] = []
    for (const e of latest.values()) {
      const exp = Number(e.tags.find((t) => t[0] === 'expiration')?.[1] ?? Infinity)
      if (exp <= now) continue
      try { out.push({ payload: JSON.parse(e.content) as T, event: e }) } catch { /* not JSON: not ours */ }
    }
    return out.sort((a, b) => b.event.created_at - a.event.created_at)
  }

  /** NIP-44 encrypted to `to`, tagged like the laptop agents' events. */
  async send(kind: number, payload: unknown, to: Hex, tags: string[][] = []): Promise<NostrEvent> {
    const content = await this.key.nip44Encrypt(to, JSON.stringify(payload))
    const event = await this.key.signEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [['t', TOPIC], ['p', to], ...tags, ...this.labels], content })
    return this.publish(event)
  }

  /** The next unseen event of `kind` from `from` to this key, checked and decrypted; each is handed out once. */
  receive<T>(kind: number, from: Hex | null, opts: { timeoutMs?: number; match?: (payload: T) => boolean } = {}): Promise<{ payload: T; event: Event }> {
    const filter: Filter = { kinds: [kind], '#p': [this.key.pubkey], '#t': [TOPIC], since: this.since }
    if (from) filter.authors = [from]
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => { done = true; sub.close(); reject(new Error(`timed out waiting for kind ${kind} from ${from?.slice(0, 8) ?? 'anyone'}`)) }, opts.timeoutMs ?? 60_000)
      const sub = this.pool.subscribeMany(this.relays, filter, {
        onevent: async (event: Event) => {
          if (done || this.seen.has(event.id) || !verifyEvent(wireCopy(event))) return
          let payload: T
          try {
            const text = ENCRYPTED_KINDS.has(event.kind) ? await this.key.nip44Decrypt(event.pubkey, event.content) : event.content
            payload = JSON.parse(text) as T
          } catch { return }
          if (done || (opts.match && !opts.match(payload))) return
          done = true
          this.seen.add(event.id)
          this.onSeen(event.id)
          clearTimeout(timer)
          sub.close()
          resolve({ payload, event })
        },
      })
    })
  }

  /**
   * The relay as the shared negotiation and check protocols take it (src/market/negotiate-nostr.ts,
   * src/checknode/borrower-check.ts): publish a signed event, subscribe with a filter. Events whose
   * signature does not verify are dropped here, before any protocol code sees them.
   */
  transport(): { publish(event: Event): Promise<void>; subscribe(filter: Filter, onEvent: (e: Event) => void): () => void } {
    return {
      publish: async (event) => { await this.publish(event as unknown as NostrEvent) },
      subscribe: (filter, onEvent) => {
        const sub = this.pool.subscribeMany(this.relays, filter, { onevent: (e: Event) => { if (verifyEvent(wireCopy(e))) onEvent(e) } })
        return () => sub.close()
      },
    }
  }

  close(): void { this.pool.close(this.relays) }
}

/** The worklet signer for the shared negotiation and check code, with this network's labels on every event it signs. */
export function labelledEventSigner(key: PartySigner, labels: string[][]): (t: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<NostrEvent> {
  return (t) => key.signEvent({ ...t, tags: [...t.tags, ...labels] })
}
