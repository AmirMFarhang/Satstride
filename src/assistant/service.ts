// The provider's help agent on the relay: it reads ASSIST_ASK events addressed to
// its key, answers each once and replies NIP-44 to the asker. Every event is
// checked before any work: a valid signature, addressed to this key, inside the
// replay window (both the event's created_at and the ask's issued_at), never seen
// before (event id and ask id), and under the per-key and global rate limits. The
// question is never logged or stored: the log holds the time, a short key prefix,
// the ask id and outcome codes. Transport-agnostic (the laptop's relay pool, or an
// in-memory relay in tests).

import type { Hex } from '../core/crypto.js'
import { answerQuestion, type AssistantModel, type DropRecord } from './answer.js'
import { corpusHash } from './corpus.js'
import {
  ASSIST_DOMAIN, ASSIST_KIND, askProblems, assistEvent, authentic, infoEvent, modelLabel, openAssistEvent, tagOf, TEMPLATE_LABEL, testDataTags,
  type AssistAsk, type AssistInfo, type AssistReply, type AssistSigner, type AssistTransport, type NostrEvent,
} from './protocol.js'
import { TOPIC } from '../market/kinds.js'

/** One line of the service log: codes only. */
export interface ServiceLogEntry {
  at: number
  event: 'answered' | 'dropped' | 'refused' | 'model-output-dropped' | 'published-info' | 'error'
  from?: string
  ask_id?: Hex
  label?: string
  outcome?: string
  ms?: number
  reasons?: string[]
}

export interface RateLimits { perKeyPerMinute: number; perKeyPerHour: number; globalPerMinute: number }
export const DEFAULT_LIMITS: RateLimits = { perKeyPerMinute: 6, perKeyPerHour: 60, globalPerMinute: 60 }

/** Sliding-window limits per key and in total. `take` records the request when it is allowed. */
export class RateLimiter {
  private readonly perKey = new Map<string, number[]>()
  private global: number[] = []
  constructor(private readonly limits: RateLimits = DEFAULT_LIMITS) {}

  /** null = allowed; otherwise the seconds until the next request would be. */
  take(key: string, nowMs: number): number | null {
    const minute = nowMs - 60_000
    const hour = nowMs - 3_600_000
    this.global = this.global.filter((t) => t > minute)
    const mine = (this.perKey.get(key) ?? []).filter((t) => t > hour)
    const lastMinute = mine.filter((t) => t > minute)
    let waitMs = 0
    if (lastMinute.length >= this.limits.perKeyPerMinute) waitMs = Math.max(waitMs, lastMinute[lastMinute.length - this.limits.perKeyPerMinute] + 60_000 - nowMs)
    if (mine.length >= this.limits.perKeyPerHour) waitMs = Math.max(waitMs, mine[mine.length - this.limits.perKeyPerHour] + 3_600_000 - nowMs)
    if (this.global.length >= this.limits.globalPerMinute) waitMs = Math.max(waitMs, this.global[this.global.length - this.limits.globalPerMinute] + 60_000 - nowMs)
    if (waitMs > 0) { this.perKey.set(key, mine); return Math.ceil(waitMs / 1000) }
    mine.push(nowMs)
    this.perKey.set(key, mine)
    this.global.push(nowMs)
    if (this.perKey.size > 10_000) for (const [k, v] of this.perKey) if (!v.some((t) => t > hour)) this.perKey.delete(k)
    return null
  }
}

/** Ids seen inside the replay window; older ones are refused by time anyway, so the set stays bounded. */
export class ReplayWindow {
  private readonly seen = new Map<string, number>()
  constructor(readonly windowSec = 120) {}
  /** Whether a timestamp (unix seconds) is inside the window around now. */
  fresh(at: number, nowMs: number): boolean {
    return Math.abs(Math.floor(nowMs / 1000) - at) <= this.windowSec
  }
  /** true the first time an id is offered; false for a replay. */
  first(id: string, nowMs: number): boolean {
    const cutoff = Math.floor(nowMs / 1000) - 2 * this.windowSec
    if (this.seen.size > 5_000) for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k)
    if (this.seen.has(id)) return false
    this.seen.set(id, Math.floor(nowMs / 1000))
    return true
  }
}

export interface ServeAssistantOptions {
  transport: AssistTransport
  /** the assistant's own key (not a lender's or the platform's) */
  signer: AssistSigner
  model?: AssistantModel | null
  /** per answer, default 20 s */
  answerTimeoutMs?: number
  replayWindowSec?: number
  limits?: RateLimits
  log?: (e: ServiceLogEntry) => void
  now?: () => number
  /** re-publish the INFO event this often, default 10 minutes; 0 publishes it once */
  infoEveryMs?: number
  /** set when public relays carry the events (PASSBOOK_PUBLIC_NETWORK): every event gets testDataTags */
  publicNetwork?: string
}

export interface AssistantService {
  readonly info: AssistInfo
  /** answers in flight */
  pending(): number
  close(): void
}

const rateLimitedReply = (ask: AssistAsk, waitSec: number, nowMs: number): AssistReply => ({
  v: 1, domain: ASSIST_DOMAIN, type: 'REPLY', ask_id: ask.ask_id,
  text: `Too many questions at once. Try again in ${waitSec} seconds.`,
  intent: null, label: TEMPLATE_LABEL, source: 'template', model: null, refused: 'RATE_LIMITED', fallback_reason: null, cites: [], issued_at: Math.floor(nowMs / 1000),
})

export function serveAssistant(o: ServeAssistantOptions): AssistantService {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const replay = new ReplayWindow(o.replayWindowSec ?? 120)
  const limiter = new RateLimiter(o.limits ?? DEFAULT_LIMITS)
  const limitedNotified = new Map<string, number>()
  const limits = o.limits ?? DEFAULT_LIMITS
  const info: AssistInfo = {
    v: 1, domain: ASSIST_DOMAIN, type: 'INFO', assistant_pk: o.signer.pubkey,
    label: o.model ? modelLabel(o.model.name) : TEMPLATE_LABEL, corpus_hash: corpusHash(), network: 'regtest', test_data: true,
    per_minute: limits.perKeyPerMinute, issued_at: Math.floor(now() / 1000),
  }
  const labelTags = testDataTags(o.publicNetwork)
  let inFlight = 0
  let closed = false
  const short = (pk: string) => pk.slice(0, 16)
  const drop = (event: NostrEvent, reasons: string[], askId?: Hex) => log({ at: Math.floor(now() / 1000), event: 'dropped', from: short(event.pubkey), ask_id: askId, reasons })

  const publishInfo = async () => {
    try {
      await o.transport.publish(await infoEvent(o.signer, { ...info, issued_at: Math.floor(now() / 1000) }, now(), labelTags))
      log({ at: Math.floor(now() / 1000), event: 'published-info', label: info.label })
    } catch (err) {
      log({ at: Math.floor(now() / 1000), event: 'error', reasons: ['INFO_PUBLISH', String((err as Error).message).slice(0, 80)] })
    }
  }

  const handle = async (event: NostrEvent) => {
    const t0 = now()
    // cheap checks first, before decrypting anything
    if (event.kind !== ASSIST_KIND.ASK) return
    if (!replay.fresh(event.created_at, t0)) return drop(event, ['STALE_EVENT'])
    if (!authentic(event)) return drop(event, ['SIGNATURE'])
    if (tagOf(event, 'p') !== o.signer.pubkey) return
    if (!replay.first(`e:${event.id}`, t0)) return drop(event, ['REPLAY_EVENT'])
    // the limit before any decryption: a flood costs a signature check each, not a NIP-44 decrypt
    const wait = limiter.take(event.pubkey, t0)
    if (wait !== null && t0 - (limitedNotified.get(event.pubkey) ?? 0) < 60_000) return drop(event, ['RATE_LIMITED'])
    let raw: unknown
    try { raw = await openAssistEvent(o.signer, event, ASSIST_KIND.ASK) } catch (err) { return drop(event, [(err as Error).message]) }
    const problems = askProblems(raw)
    if (problems.length) return drop(event, problems.slice(0, 8))
    const ask = raw as AssistAsk
    if (tagOf(event, 'n') !== ask.ask_id) return drop(event, ['ASK_ID_TAG'], ask.ask_id)
    if (!replay.fresh(ask.issued_at, t0)) return drop(event, ['STALE_ASK'], ask.ask_id)
    if (!replay.first(`a:${ask.ask_id}`, t0)) return drop(event, ['REPLAY_ASK'], ask.ask_id)
    let answer: AssistReply
    if (wait !== null) {
      // one notice per key per minute, then silence: a flood gets no amplification
      limitedNotified.set(event.pubkey, t0)
      answer = rateLimitedReply(ask, wait, t0)
    } else {
      inFlight += 1
      try {
        answer = await answerQuestion(ask.ask_id, ask.question, ask.context, {
          model: o.model, timeoutMs: o.answerTimeoutMs, now,
          log: (r: DropRecord) => log({ at: Math.floor(now() / 1000), event: 'model-output-dropped', from: short(event.pubkey), ask_id: r.ask_id, reasons: r.dropped }),
        })
      } finally { inFlight -= 1 }
    }
    if (closed) return
    try {
      await o.transport.publish(await assistEvent(o.signer, ASSIST_KIND.REPLY, answer, event.pubkey, [['e', event.id], ...labelTags], now()))
      log({ at: Math.floor(now() / 1000), event: answer.refused ? 'refused' : 'answered', from: short(event.pubkey), ask_id: ask.ask_id, label: answer.label, outcome: answer.refused ?? answer.fallback_reason ?? 'OK', ms: now() - t0 })
    } catch (err) {
      log({ at: Math.floor(now() / 1000), event: 'error', from: short(event.pubkey), ask_id: ask.ask_id, reasons: ['REPLY_PUBLISH', String((err as Error).message).slice(0, 80)] })
    }
  }

  const unsubscribe = o.transport.subscribe(
    { kinds: [ASSIST_KIND.ASK], '#p': [o.signer.pubkey], '#t': [TOPIC], since: Math.floor(now() / 1000) - (o.replayWindowSec ?? 120) },
    (event) => { void handle(event).catch((err) => log({ at: Math.floor(now() / 1000), event: 'error', reasons: ['HANDLER', String((err as Error).message).slice(0, 80)] })) },
  )
  void publishInfo()
  const every = o.infoEveryMs ?? 600_000
  const timer = every > 0 ? setInterval(() => { void publishInfo() }, every) : undefined
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
  return {
    info,
    pending: () => inFlight,
    close() { closed = true; unsubscribe(); if (timer) clearInterval(timer) },
  }
}
