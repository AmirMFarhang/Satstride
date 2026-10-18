// Where check-market messages travel: the Nostr relay (agents/relay.ts) in the
// demo and on regtest. MemoryBus is an in-process relay for unit tests: it
// carries the same signed NIP-01 events with the same NIP-44 encryption, it
// just keeps them in memory instead of on a relay.

import { type Event, type Filter } from 'nostr-tools'
import type { Hex, KeyPair } from '../core/crypto.js'
import { TOPIC } from '../market/kinds.js'
import { encryptedJson, isAuthentic, publicJson, readJson } from '../market/messages.js'
import { isWireChunk, packWire, WireReassembler } from './wire.js'

export interface CheckBus {
  readonly key: KeyPair
  publish(event: Event): Promise<Event>
  publicEvents(kind: number): Promise<Event[]>
  send(kind: number, payload: unknown, to: Hex, tags?: string[][]): Promise<Event>
  receive<T>(kind: number, from: Hex | null, opts?: { timeoutMs?: number; match?: (payload: T) => boolean }): Promise<{ payload: T; event: Event }>
}

type Listener = (e: Event) => void

/** TEST-ONLY in-memory relay; addressable kinds keep the latest event per author and `d` tag, as NIP-01 relays do. */
export class MemoryHub {
  readonly events: Event[] = []
  private readonly listeners = new Set<Listener>()
  publish(e: Event): void {
    if (e.kind >= 30000 && e.kind < 40000) {
      const d = e.tags.find((t) => t[0] === 'd')?.[1]
      const i = this.events.findIndex((x) => x.kind === e.kind && x.pubkey === e.pubkey && x.tags.find((t) => t[0] === 'd')?.[1] === d)
      if (i >= 0) this.events.splice(i, 1)
    }
    this.events.push(e)
    for (const l of [...this.listeners]) l(e)
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

const matches = (e: Event, f: Filter) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1])))

export class MemoryBus implements CheckBus {
  private readonly seen = new Set<string>()
  constructor(readonly hub: MemoryHub, readonly key: KeyPair) {}

  async publish(event: Event): Promise<Event> {
    this.hub.publish(event)
    return event
  }

  async publicEvents(kind: number): Promise<Event[]> {
    return this.hub.events.filter((e) => e.kind === kind && e.tags.some((t) => t[0] === 't' && t[1] === TOPIC) && isAuthentic(e))
  }

  send(kind: number, payload: unknown, to: Hex, tags: string[][] = []): Promise<Event> {
    return this.publish(encryptedJson(this.key, kind, payload, to, tags))
  }

  publishPublic(kind: number, payload: unknown, tags: string[][] = []): Promise<Event> {
    return this.publish(publicJson(this.key, kind, payload, tags))
  }

  receive<T>(kind: number, from: Hex | null, opts: { timeoutMs?: number; match?: (payload: T) => boolean } = {}): Promise<{ payload: T; event: Event }> {
    const filter: Filter = { kinds: [kind], '#p': [this.key.pubkey], ...(from ? { authors: [from] } : {}) }
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {}
      const timer = setTimeout(() => { unsubscribe(); reject(new Error(`timed out waiting for kind ${kind} from ${from?.slice(0, 8) ?? 'anyone'}`)) }, opts.timeoutMs ?? 60_000)
      const consider = (e: Event): boolean => {
        if (this.seen.has(e.id) || !matches(e, filter) || !isAuthentic(e)) return false
        let payload: T
        try { payload = readJson<T>(e, this.key) } catch { return false }
        if (opts.match && !opts.match(payload)) return false
        this.seen.add(e.id)
        clearTimeout(timer)
        unsubscribe()
        resolve({ payload, event: e })
        return true
      }
      for (const e of this.hub.events) if (consider(e)) return
      unsubscribe = this.hub.subscribe((e) => { consider(e) })
    })
  }
}

/**
 * A CheckBus that keeps every event under the public relays' size limit (wire.ts): it sends a large message as
 * signed chunks and hands back whole, hash-checked messages. Receivers on one wrapped bus share what they collect,
 * so a chunk picked up by one waiting receive still reaches the receive it belongs to.
 */
const wrapped = new WeakMap<CheckBus, CheckBus>()

export function chunkedBus(inner: CheckBus): CheckBus {
  if ((inner as { chunked?: boolean }).chunked) return inner
  // One wrapper per bus, so every receive on it shares the chunks and messages collected so far.
  const known = wrapped.get(inner)
  if (known) return known
  const assembler = new WireReassembler()
  const pending: { kind: number; from: Hex; payload: unknown; event: Event }[] = []
  const bus: CheckBus & { chunked: true } = {
    chunked: true,
    get key() { return inner.key },
    publish: (e) => inner.publish(e),
    publicEvents: (kind) => inner.publicEvents(kind),
    async send(kind, payload, to, tags = []) {
      let last: Event | undefined
      for (const p of packWire(payload)) last = await inner.send(kind, p, to, tags)
      return last!
    },
    async receive<T>(kind: number, from: Hex | null, opts: { timeoutMs?: number; match?: (payload: T) => boolean } = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
      for (;;) {
        const i = pending.findIndex((x) => x.kind === kind && (!from || x.from === from) && (!opts.match || opts.match(x.payload as T)))
        if (i >= 0) { const x = pending.splice(i, 1)[0]; return { payload: x.payload as T, event: x.event } }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`timed out waiting for kind ${kind} from ${from?.slice(0, 8) ?? 'anyone'}`)
        let got: { payload: unknown; event: Event }
        const slice = Math.min(left, 2000)
        const started = Date.now()
        try {
          got = await inner.receive<unknown>(kind, from, { timeoutMs: slice, match: (p) => isWireChunk(p) || !opts.match || opts.match(p as T) })
        } catch (e) {
          // A slice that ran out: keep waiting. An error well before that is the bus's own answer (closed, refused): pass it on.
          if (Date.now() - started < slice / 2) throw e
          continue
        }
        const whole = assembler.feed(got.event.pubkey, got.payload)
        if (!whole) continue
        if (!opts.match || opts.match(whole.payload as T)) return { payload: whole.payload as T, event: got.event }
        pending.push({ kind, from: got.event.pubkey, payload: whole.payload, event: got.event })
      }
    },
  }
  wrapped.set(inner, bus)
  return bus
}
