// The platform API over Nostr for the phone (src/server/nostr-api.ts, wire in
// src/server/nostr-api-wire.ts): the same call() as platform.ts, signed by the party
// key in the worklet over the same digest with the same headers, but carried NIP-44
// encrypted through public relays instead of HTTP. The phone then needs no route to
// the laptop at all: no Wi-Fi, tunnel or open port, any network works.
//
// Wiring (mobile-app-real, one line plus a Setting): in PhonePlatform.call, when a
// NostrPlatformCall is configured, `return this.nostr.call<T>(method, path, body)`.
// Errors read exactly like platform.ts's: `${method} ${path} (${status}): ${error}`.
import { sha256Hex, type Hex } from '../../../../src/core/crypto.js'
import { isAuthentic, type Event } from '../../../../src/market/messages.js'
import { signNostrEvent, type NegotiationSigner, type NegotiationTransport, type NostrEvent } from '../../../../src/market/negotiate-nostr.js'
import { TOPIC } from '../../../../src/market/kinds.js'
import { decodeChunk, encodeChunk, PLATFORM_INFO_D, PLATFORM_NOSTR_KIND, platformInfoProblems, Reassembly, toChunks, type PlatformInfo, type PlatformRequest, type PlatformResponse } from '../../../../src/server/nostr-api-wire.js'

/** The party key: the negotiation signer's members (the check market's CheckSigner, plus signEvent) and the HTTP request signature. */
export interface PlatformNostrSigner extends NegotiationSigner {
  signRequest(r: { method: string; pathAndQuery: string; timestampMs: number; nonce: string; bodySha256: Hex }): Promise<Hex>
}

export interface PlatformNostrOptions {
  transport: NegotiationTransport
  signer: PlatformNostrSigner
  /** The platform key (its info event's author and /state's platform_pk), from the provider's QR. */
  platformPk: Hex
  /** Time between attempts; default 15 s. */
  timeoutMs?: number
  /** How long to wait for the answer in all; default attempts × timeoutMs, and 150 s for a sandbox credit check. */
  timeoutFor?: (method: string, path: string) => number
  /** Attempts at most; each publishes freshly signed events (same request id, same signed HTTP request) to every relay. Default 3. */
  attempts?: number
  /** Attempts happen only this long after the request was signed, inside the platform's 60 s signature window; default 45 s. */
  retryWindowMs?: number
}

let counter = 0
/** Same randomness as platform.ts's nonce (no crypto.getRandomValues needed on Hermes). */
const randomId = (bytes: number) => sha256Hex(`${Date.now()}:${Math.random()}:${++counter}`).slice(0, bytes * 2)

export class NostrPlatformCall {
  constructor(private readonly o: PlatformNostrOptions) {}

  private totalTimeout(method: string, path: string): number {
    return this.o.timeoutFor?.(method, path) ?? (path.split('?')[0] === '/sandbox/submit' ? 150_000 : (this.o.timeoutMs ?? 15_000) * (this.o.attempts ?? 3))
  }

  /** The same contract as PhonePlatform.call: resolves with the JSON body, throws on a non-2xx status or no answer. */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const ts = Date.now()
    const nonce = randomId(16)
    const sig = await this.o.signer.signRequest({ method, pathAndQuery: path, timestampMs: ts, nonce, bodySha256: sha256Hex(raw) })
    const request: PlatformRequest = { v: 1, method, path, headers: { 'x-passbook-key': this.o.signer.pubkey, 'x-passbook-ts': String(ts), 'x-passbook-nonce': nonce, 'x-passbook-sig': sig }, body: raw }
    const id = randomId(16)
    // throws for a body over the bridge's limit, before anything is sent
    const chunks = toChunks(id, JSON.stringify(request))
    // Fresh outer events for every attempt (new NIP-44 nonce, new event id) around the same request id and signed
    // request, so neither a relay nor the platform's duplicate filter swallows a retry, and a lost answer is resent.
    const events = async (): Promise<NostrEvent[]> => {
      const out: NostrEvent[] = []
      for (const c of chunks) {
        const content = await this.o.signer.nip44Encrypt(this.o.platformPk, encodeChunk(c))
        out.push(await signNostrEvent(this.o.signer, { kind: PLATFORM_NOSTR_KIND.REQUEST, created_at: Math.floor(Date.now() / 1000), tags: [['t', TOPIC], ['p', this.o.platformPk], ['q', id]], content }))
      }
      return out
    }
    const response = await this.exchange(id, events, ts, this.totalTimeout(method, path), `${method} ${path}`)
    if (response.status < 200 || response.status >= 300) throw new Error(`${method} ${path} (${response.status}): ${(response.body as { error?: string } | null)?.error ?? response.status}`)
    return response.body as T
  }

  /**
   * Publish the request, wait for the whole answer. Attempts repeat every timeoutMs, at most `attempts`, and only
   * while the signed request is still inside the platform's signature window; the wait itself lasts totalMs.
   */
  private exchange(id: Hex, events: () => Promise<NostrEvent[]>, signedAt: number, totalMs: number, what: string): Promise<PlatformResponse> {
    const attempts = this.o.attempts ?? 3, retryMs = this.o.timeoutMs ?? 15_000, windowMs = this.o.retryWindowMs ?? 45_000
    const parts = new Reassembly()
    return new Promise((resolve, reject) => {
      let done = false, attempt = 0, timer: ReturnType<typeof setTimeout> | undefined
      const failures: string[] = []
      const deadline = setTimeout(() => finish(() => reject(new Error(`${what}: no answer from the platform over Nostr after ${attempt} attempt(s) within ${totalMs} ms${failures.length ? ` (${failures.join('; ')})` : ''}`))), totalMs)
      const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(deadline); stop(); fn() }
      const stop = this.o.transport.subscribe({ kinds: [PLATFORM_NOSTR_KIND.RESPONSE], authors: [this.o.platformPk], '#p': [this.o.signer.pubkey], since: Math.floor(Date.now() / 1000) - 30 }, (e) => {
        void (async () => {
          if (done || e.pubkey !== this.o.platformPk || !e.tags.some((t) => t[0] === 'q' && t[1] === id) || !isAuthentic(e as Event)) return
          let message: string | null
          try { message = parts.add(decodeChunk(await this.o.signer.nip44Decrypt(this.o.platformPk, e.content))) } catch { return }
          if (message === null) return
          try {
            const r = JSON.parse(message) as PlatformResponse
            if (r?.v !== 1 || !Number.isSafeInteger(r.status)) throw new Error('malformed response')
            finish(() => resolve(r))
          } catch (err) { finish(() => reject(new Error(`${what}: ${(err as Error).message} from the platform over Nostr`))) }
        })()
      })
      const send = async () => {
        if (done || attempt >= attempts || (attempt > 0 && Date.now() - signedAt > windowMs)) return
        attempt++
        timer = setTimeout(() => void send(), retryMs)
        try { for (const e of await events()) await this.o.transport.publish(e) } catch (err) { failures.push((err as Error).message) }
      }
      void send()
    })
  }
}

/** The platform's info event (kind 38550) by its key, checked: relays, network and test-data label. */
export function readPlatformInfo(transport: NegotiationTransport, platformPk: Hex, timeoutMs = 10_000): Promise<PlatformInfo> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); stop(); fn() }
    const timer = setTimeout(() => finish(() => reject(new Error(`no platform info event from ${platformPk.slice(0, 12)}… within ${timeoutMs} ms`))), timeoutMs)
    const stop = transport.subscribe({ kinds: [PLATFORM_NOSTR_KIND.INFO], authors: [platformPk], '#d': [PLATFORM_INFO_D] } as Parameters<NegotiationTransport['subscribe']>[0], (e) => {
      if (done || e.pubkey !== platformPk || !isAuthentic(e as Event)) return
      try {
        const info = JSON.parse(e.content) as PlatformInfo
        if (platformInfoProblems(info).length || info.platform_pk !== platformPk || !e.tags.some((t) => t[0] === 'network' && t[1] === info.network)) return
        finish(() => resolve(info))
      } catch { /* not ours */ }
    })
  })
}
