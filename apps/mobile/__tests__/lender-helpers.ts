// Shared by the phone lender's tests (lane E3): an in-memory relay and a party key that
// behaves like the worklet's (signObject, signPassbookHash, signEvent, NIP-44), so the
// lender's own code runs unchanged with separate key holders.
import { nip44 } from 'nostr-tools'
import { signHash, signObject, type KeyPair } from '../../../src/core/crypto.ts'
import { signEvent } from '../../../src/market/messages.ts'
import type { NegotiationTransport, NostrEvent, NostrFilter } from '../../../src/market/negotiate-nostr.ts'

/** Stores every event, replays stored ones to new subscriptions, delivers asynchronously. */
export class MemoryRelay implements NegotiationTransport {
  readonly events: NostrEvent[] = []
  private readonly subs = new Set<{ filter: NostrFilter; onEvent: (e: NostrEvent) => void }>()
  async publish(event: NostrEvent): Promise<void> {
    this.events.push(event)
    for (const s of [...this.subs]) if (matches(s.filter, event)) queueMicrotask(() => s.onEvent(event))
  }
  subscribe(filter: NostrFilter, onEvent: (e: NostrEvent) => void): () => void {
    const sub = { filter, onEvent }
    this.subs.add(sub)
    for (const e of this.events) if (matches(filter, e)) queueMicrotask(() => { if (this.subs.has(sub)) onEvent(e) })
    return () => { this.subs.delete(sub) }
  }
}

export function matches(f: NostrFilter, e: NostrEvent): boolean {
  const tag = (name: string, values?: string[]) => !values || e.tags.some((t) => t[0] === name && values.includes(t[1]))
  return (!f.ids || f.ids.includes(e.id)) && (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (f.since === undefined || e.created_at >= f.since) && tag('p', f['#p']) && tag('t', f['#t']) && tag('n', f['#n'])
}

/** A KeyPair as the worklet's party key (the parts of PartySigner the lender uses). */
export function partyKey(k: KeyPair) {
  return {
    pubkey: k.pubkey,
    btc: { address: 'bcrt1ptest', script: '51' },
    signObject: async <T extends object>(v: T) => signObject(v, k.secretKey) as T & { sig: string },
    signPassbookHash: async (h: string) => signHash(h, k.secretKey),
    signEvent: async (t: { kind: number; created_at: number; tags: string[][]; content: string }) => signEvent(k, t.kind, t.content, t.tags, t.created_at * 1000) as unknown as NostrEvent,
    nip44Encrypt: async (peer: string, text: string) => nip44.encrypt(text, nip44.getConversationKey(k.secretKey, peer)),
    nip44Decrypt: async (peer: string, payload: string) => nip44.decrypt(payload, nip44.getConversationKey(k.secretKey, peer)),
  }
}
