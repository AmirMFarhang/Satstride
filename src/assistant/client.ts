// The phone's half of the agent on call: ask the provider's help agent over Nostr
// and fall back, labelled, to the on-phone template engine when it can't answer.
// Browser-safe; the phone imports it through Metro (apps/mobile/src/assistant).
//
// The phone asks with a throwaway key made for this purpose (ephemeralSigner), not
// the wallet's party key: the help agent never holds or sees a wallet key, and
// questions don't link to the person's lender identity on the relay. A question
// that looks like a secret is never sent. What was sent is returned as `shared`,
// so the sheet can show "What I shared".

import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import { signHash, type Hex } from '../core/crypto.js'
import { TOPIC } from '../market/kinds.js'
import {
  ASSIST_KIND, assistEvent, contextProblems, intentProblems, isLabel, looksSecret, newAsk, openAssistEvent, readInfo, replyProblems, TEMPLATE_LABEL,
  type AssistContext, type AssistInfo, type AssistIntent, type AssistReply, type AssistSigner, type AssistTransport, type Fallback, type Refusal,
} from './protocol.js'
import { templateAnswer } from './templates.js'

/** A fresh in-memory key for the help channel only: never the wallet's key, never stored. */
export function ephemeralSigner(): AssistSigner {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  return {
    pubkey,
    signHash: async (hash32) => signHash(hash32, secretKey),
    nip44Encrypt: async (peer, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(secretKey, peer)),
    nip44Decrypt: async (peer, payload) => nip44.decrypt(payload, nip44.getConversationKey(secretKey, peer)),
  }
}

/** One answer as the sheet shows it. */
export interface AssistAnswer {
  ask_id: Hex | null
  question: string
  text: string
  intent: AssistIntent | null
  /** `model (QVAC <model> on the provider)` or `template` */
  label: string
  source: 'model' | 'template'
  /** who produced the answer: the provider, or this phone's template engine */
  answered_by: 'provider' | 'phone'
  model: string | null
  refused: Refusal | null
  /** why a template stands in for the model; null when the model answered or for a refusal */
  fallback_reason: Fallback | null
  cites: string[]
  /** exactly what left the phone: the question and the context; null when nothing was sent */
  shared: { question: string; context: AssistContext; to: Hex } | null
  ms: number
}

export interface AskOptions {
  transport: AssistTransport | null
  signer?: AssistSigner
  /** the provider's help agent key (from its INFO event or the provider's info); null = ask no one */
  assistantPk: Hex | null
  question: string
  context: AssistContext
  /** how long to wait for the provider, default 30 s (its model has 20 s) */
  timeoutMs?: number
  now?: () => number
  /** the person closed the sheet: stop waiting */
  signal?: AbortSignal
  /** extra tags on the ASK, e.g. testDataTags(network) when it goes to public relays */
  tags?: string[][]
}

function onPhone(question: string, context: AssistContext, fallback: Fallback | null, shared: AssistAnswer['shared'], t0: number, now: () => number, askId: Hex | null = null): AssistAnswer {
  const t = templateAnswer(question, context)
  return {
    ask_id: askId, question, text: t.text, intent: t.intent, label: TEMPLATE_LABEL, source: 'template', answered_by: 'phone', model: null,
    refused: t.refused, fallback_reason: t.refused ? null : fallback, cites: t.cites, shared, ms: now() - t0,
  }
}

/**
 * Ask the provider's help agent; never throws. A reply that fails the schema, the label rule or the
 * allowlist is not shown: the phone answers by template and says why.
 */
export async function askAssistant(o: AskOptions): Promise<AssistAnswer> {
  const now = o.now ?? Date.now
  const t0 = now()
  const question = o.question.trim()
  if (contextProblems(o.context).length) throw new Error(`assistant context is malformed: ${contextProblems(o.context).join(', ')}`)
  // never sent: a secret, or nobody to send to
  if (looksSecret(question)) return onPhone(question, o.context, 'NOT_SENT', null, t0, now)
  if (!o.transport || !o.assistantPk) return onPhone(question, o.context, 'NO_ASSISTANT', null, t0, now)
  const signer = o.signer ?? ephemeralSigner()
  const ask = newAsk(question, o.context, t0)
  const shared = { question: ask.question, context: ask.context, to: o.assistantPk }
  const transport = o.transport
  const assistantPk = o.assistantPk

  return new Promise<AssistAnswer>((resolve) => {
    let done = false
    let unsubscribe: () => void = () => {}
    const finish = (a: AssistAnswer) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      resolve(a)
    }
    const timer = setTimeout(() => finish(onPhone(question, o.context, 'PROVIDER_TIMEOUT', shared, t0, now, ask.ask_id)), o.timeoutMs ?? 30_000)
    const onAbort = () => finish(onPhone(question, o.context, 'PROVIDER_TIMEOUT', shared, t0, now, ask.ask_id))
    o.signal?.addEventListener('abort', onAbort)
    unsubscribe = transport.subscribe(
      { kinds: [ASSIST_KIND.REPLY], authors: [assistantPk], '#p': [signer.pubkey], '#n': [ask.ask_id], since: Math.floor(t0 / 1000) - 5 },
      (event) => {
        void (async () => {
          let raw: unknown
          try { raw = await openAssistEvent(signer, event, ASSIST_KIND.REPLY) } catch { return /* not ours or not readable: keep waiting */ }
          if (event.pubkey !== assistantPk) return
          const problems = replyProblems(raw)
          const r = raw as AssistReply
          if (problems.length || r.ask_id !== ask.ask_id || !isLabel(r.label)) return finish(onPhone(question, o.context, 'REPLY_INVALID', shared, t0, now, ask.ask_id))
          // the allowlist again, on this side: an intent outside it, or naming a loan the phone did not share, is not shown
          const intent = r.intent && !intentProblems(r.intent, o.context).length ? r.intent : null
          finish({
            ask_id: ask.ask_id, question, text: r.text, intent, label: r.label, source: r.source, answered_by: 'provider', model: r.model,
            refused: r.refused, fallback_reason: r.fallback_reason, cites: r.cites, shared, ms: now() - t0,
          })
        })()
      },
    )
    void (async () => {
      try {
        await transport.publish(await assistEvent(signer, ASSIST_KIND.ASK, ask, assistantPk, o.tags ?? [], t0))
      } catch {
        finish(onPhone(question, o.context, 'PROVIDER_UNREACHABLE', null, t0, now, ask.ask_id))
      }
    })()
  })
}

/**
 * The newest valid INFO event on the relay: the help agent's key and what answers (its model label).
 * Pass `authors` to accept only a pinned key (the provider's info from service-provider.sh).
 */
export function discoverAssistant(transport: AssistTransport, o: { authors?: Hex[]; waitMs?: number } = {}): Promise<AssistInfo | null> {
  return new Promise((resolve) => {
    let best: AssistInfo | null = null
    const unsubscribe = transport.subscribe(
      { kinds: [ASSIST_KIND.INFO], '#t': [TOPIC], ...(o.authors ? { authors: o.authors } : {}), limit: 20 },
      (event) => {
        const info = readInfo(event)
        if (info && (!best || info.issued_at > best.issued_at)) best = info
      },
    )
    setTimeout(() => { unsubscribe(); resolve(best) }, o.waitMs ?? 3000)
  })
}

