// Negotiation over the Nostr relay, one key holder per side (closes #30).
//
// The borrower (the phone) and the lender (the laptop peer) each run the engine
// in negotiate-engine.ts on their own side, from their own signed policy and the
// shared, signed, hash-chained transcript; neither ever holds the other's key.
// Browser-safe: no node: module, so the phone imports this file through Metro.
// Transport-agnostic: anything with publish(event) and subscribe(filter, onEvent)
// carries it (the phone's relay, the laptop agents' relay, an in-memory relay in
// tests). Keys stay with their owner behind NegotiationSigner (the same four
// members as the check market's CheckSigner, so the phone holds one key object).
//
// Wire (kinds and tags as in kinds.ts / negotiationEvent):
//   ASK      7490 public            tags t=passbook, p=<lender>, n=<negotiation id>
//   OFFER    7491 NIP-44 to the counterparty, tags t=passbook, p=<counterparty>, n=<id>
//   COUNTER  7492  "      ACCEPT 7493  "      NO_DEAL 7494  "
// Content is the NegotiationMessage itself (the ASK as JSON, the rest encrypted).
// The credit check of an agreed negotiation rides the check market's own messages
// (kind 7533, src/checknode), tagged with the same negotiation id.
//
// Before the ASK the borrower reads the lender's NegotiationTerms from its signed
// 38388 offer (OfferPayload.negotiation): the structural part of its policy only,
// never its APR floor or LTV cap. The borrower picks the structure (principal,
// term, settlement) from its own policy and those terms; the lender takes it only
// if it is inside its own signed policy, and from then on every position must keep
// it. Code decides every number: each side's moves come from nextMove, clamped to
// the platform's economics and to its own signed policy, and are checked again
// before they are signed. Each received message is checked against the whole
// transcript so far (verifyTranscript); a bad one ends the negotiation (PROTOCOL).

import { getEventHash } from 'nostr-tools'
import { hashObject, isHex, randomHex, signHash, type Hex, type KeyPair } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, type Economics } from '../core/economics.js'
import type { Micro } from '../core/money.js'
import { TRUST_LEVELS } from '../scorer/trust.js'
import { SETTLEMENT_KINDS } from '../settlement/kinds.js'
import { verifySigned, type Signer } from '../wallet/signer.js'
import { KIND, TOPIC } from './kinds.js'
import { decryptFrom, encryptTo, isAuthentic, signEvent, type Event } from './messages.js'
import {
  acceptable, appendMessage, baseStructure, EVENT_KIND, isPosition, moveBody, negotiationId, nextMove, verifyTranscript,
  type EngineParams, type LenderStructure, type Move, type NegotiationMessage, type Outcome, type Position, type Role, type Structure, type Turn,
} from './negotiate-engine.js'
import type { BorrowerPolicy, LenderPolicy } from './policy.js'

/** The negotiation's kinds (kinds.ts NEG_*). */
export const NEG_KIND = { ASK: KIND.NEG_ASK, OFFER: KIND.NEG_OFFER, COUNTER: KIND.NEG_COUNTER, ACCEPT: KIND.NEG_ACCEPT, NO_DEAL: KIND.NEG_NO_DEAL, TERMSHEET: KIND.NEG_TERMSHEET, APPROVED: KIND.NEG_APPROVED } as const

// ---- ports ----

/** NIP-01 event. */
export interface NostrEvent { id: Hex; pubkey: Hex; created_at: number; kind: number; tags: string[][]; content: string; sig: Hex }

/** The subset of a NIP-01 filter this module uses (nostr-tools' Filter is assignable to it). */
export interface NostrFilter { ids?: string[]; kinds?: number[]; authors?: string[]; since?: number; until?: number; limit?: number; '#p'?: string[]; '#t'?: string[]; '#n'?: string[] }

/** What carries the negotiation: the phone's relay, the laptop agents' relay, or an in-memory relay (same shape as the check market's CheckTransport). */
export interface NegotiationTransport {
  /** Resolves once at least one relay accepted the event; rejects otherwise. */
  publish(event: NostrEvent): Promise<void>
  /** Stored events from `since` and live ones matching the filter; returns the unsubscribe function. */
  subscribe(filter: NostrFilter, onEvent: (event: NostrEvent) => void): () => void
}

/** The structural shape of nostr-tools' SimplePool that poolTransport needs. */
export interface PoolLike {
  publish(relays: string[], event: NostrEvent): Promise<string>[]
  subscribeMany(relays: string[], filter: NostrFilter, params: { onevent: (event: NostrEvent) => void }): { close(): void }
}

/** A SimplePool on these relays. `publish` overrides the pool's (e.g. the laptop agent's kill-switch-guarded relay). */
export function poolTransport(pool: PoolLike, relays: string[], publish?: (event: NostrEvent) => Promise<unknown>): NegotiationTransport {
  return {
    publish: publish ? async (event) => { await publish(event) } : (async (event) => {
      const results = await Promise.allSettled(pool.publish(relays, event))
      if (!results.some((r) => r.status === 'fulfilled')) throw new Error(`no relay accepted event ${event.id.slice(0, 8)}`)
    }),
    subscribe(filter, onEvent) {
      const sub = pool.subscribeMany(relays, filter, { onevent: onEvent })
      return () => sub.close()
    },
  }
}

/**
 * One party's key, held by its owner: the same four members as the check market's CheckSigner (src/checknode),
 * so the phone holds one key object for the negotiation and the credit check. On the laptop keyPairSigner wraps
 * the party key (negotiation messages through the governance gate's session signer).
 */
export interface NegotiationSigner {
  /** x-only BIP-340 public key */
  readonly pubkey: Hex
  /** BIP-340 over a 32-byte hash the shared code computed (a message's hashObject, a Nostr event id); never a Bitcoin sighash. */
  signHash(hash32: Hex): Promise<Hex>
  nip44Encrypt(peerPk: Hex, plaintext: string): Promise<string>
  nip44Decrypt(peerPk: Hex, ciphertext: string): Promise<string>
  /** Optional: a signer that signs whole Nostr events itself; otherwise the event id is signed with signHash. */
  signEvent?(template: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent>
}

/** A signed Nostr event from either kind of signer. */
export async function signNostrEvent(s: NegotiationSigner, template: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent> {
  if (s.signEvent) return s.signEvent(template)
  const unsigned = { ...template, tags: template.tags.map((t) => [...t]), pubkey: s.pubkey }
  const id = getEventHash(unsigned)
  return { ...unsigned, id, sig: await s.signHash(id) }
}

/** The laptop side: a party key in memory; `messages` signs the negotiation messages instead (Agent.negotiationSigner: the gate's session key, so the kill switch stops it). */
export function keyPairSigner(key: KeyPair, messages?: Signer): NegotiationSigner {
  if (messages && messages.pubkey !== key.pubkey) throw new Error('the message signer belongs to another key')
  return {
    pubkey: key.pubkey,
    signHash: async (hash) => (messages ? messages.signHash(hash) : signHash(hash, key.secretKey)),
    signEvent: async (t) => signEvent(key, t.kind, t.content, t.tags, t.created_at * 1000),
    nip44Encrypt: async (peer, plaintext) => encryptTo(key, peer, plaintext),
    nip44Decrypt: async (peer, payload) => decryptFrom(key, peer, payload),
  }
}

const authentic = (e: NostrEvent): boolean => isAuthentic(e as Event)
const messageSigner = (s: NegotiationSigner): Signer => ({ kind: 'wdk', pubkey: s.pubkey, signHash: (h) => s.signHash(h) })

// ---- the lender's public terms ----

/**
 * The structural part of a lender's signed policy, published in its 38388 offer (OfferPayload.negotiation),
 * so the borrower can open at a structure the lender takes. Never the APR floor or the LTV cap.
 */
export interface NegotiationTerms {
  v: 1
  lender_pk: Hex
  /** hashObject of the lender's signed LenderPolicy (its OFFER names the same hash). */
  policy_hash: Hex
  asset_id: string
  min_principal: Micro
  /** min(max_per_loan, max_outstanding - outstanding) when published. */
  max_principal: Micro
  term_blocks: { min: number; max: number }
  accepted_settlements: LenderPolicy['accepted_settlements']
  min_scorer_trust: LenderPolicy['min_scorer_trust']
  /** Moves each way; the borrower uses the lender's number and both verify the transcript with it. */
  max_rounds: number
}

export function negotiationTerms(lp: LenderPolicy, o: { max_rounds: number; min_principal?: Micro; outstanding?: Micro }): NegotiationTerms {
  return {
    v: 1, lender_pk: lp.owner_pk, policy_hash: hashObject(lp), asset_id: lp.asset_id, min_principal: o.min_principal ?? 1,
    max_principal: Math.max(0, Math.min(lp.max_per_loan, lp.max_outstanding - (o.outstanding ?? 0))), term_blocks: { ...lp.term_blocks },
    accepted_settlements: [...lp.accepted_settlements], min_scorer_trust: lp.min_scorer_trust, max_rounds: o.max_rounds,
  }
}

const int = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min

export function negotiationTermsProblems(t: unknown): string[] {
  const x = t as NegotiationTerms
  if (!x || typeof x !== 'object' || x.v !== 1) return ['TERMS_MALFORMED']
  const problems: string[] = []
  if (!isHex(x.lender_pk, 32)) problems.push('lender_pk')
  if (!isHex(x.policy_hash, 32)) problems.push('policy_hash')
  if (typeof x.asset_id !== 'string' || !x.asset_id) problems.push('asset_id')
  if (!int(x.min_principal, 1) || !int(x.max_principal)) problems.push('principal')
  if (!x.term_blocks || !int(x.term_blocks.min, 1) || !int(x.term_blocks.max, x.term_blocks.min)) problems.push('term_blocks')
  if (!Array.isArray(x.accepted_settlements) || !x.accepted_settlements.length || !x.accepted_settlements.every((k) => (SETTLEMENT_KINDS as readonly string[]).includes(k))) problems.push('accepted_settlements')
  if (!(TRUST_LEVELS as readonly string[]).includes(x.min_scorer_trust)) problems.push('min_scorer_trust')
  if (!int(x.max_rounds, 1) || x.max_rounds > 10) problems.push('max_rounds')
  return problems
}

/** The terms as a lender-policy view for the structure step: no APR floor here, the lender enforces its own. */
const termsView = (t: NegotiationTerms): LenderStructure => ({ asset_id: t.asset_id, max_per_loan: t.max_principal, max_outstanding: t.max_principal, term_blocks: t.term_blocks, min_apr_bps: 0, accepted_settlements: t.accepted_settlements, min_scorer_trust: t.min_scorer_trust })

// ---- results ----

/**
 * no_deal reasons: the engine's (MAX_ROUNDS, ECONOMICS) and structure's (ASSET, PRINCIPAL, TERM, SETTLEMENT, APR_CAP),
 * the counterparty's own NO_DEAL reason, and here: TIMEOUT (no valid reply in time), STRUCTURE (a position changed
 * principal, term or settlement), PROTOCOL (a message failed verification; nothing more is sent), POLICY (a move would
 * leave the own signed policy; never sent), PARAMS (max_rounds differ), STALE_TERMS (the ASK named an older lender
 * policy), REFUSED:<code> (the lender's admission: kill switch, sanctions, capacity), SIGNER and TRANSPORT (the own key
 * or relay failed), ABORTED.
 */
export interface NegotiationResult {
  negotiation_id: Hex
  role: Role
  counterparty_pk: Hex
  outcome: Outcome
  /** The signed, hash-chained transcript: what APPLICATION.negotiation carries. */
  messages: NegotiationMessage[]
  structure: Structure
  /** verifyTranscript over `messages` on this side. */
  verified: ReturnType<typeof verifyTranscript>
  /** Why it ended early, for the screen and the log (never shown as a number source). */
  problems: string[]
}

export type MessageListener = (m: NegotiationMessage, direction: 'sent' | 'received') => void

// ---- one side's session ----

interface SessionCtx {
  role: Role
  transport: NegotiationTransport
  signer: NegotiationSigner
  policy: BorrowerPolicy | LenderPolicy
  params: EngineParams
  counterparty: Hex
  id: Hex
  s: Extract<Structure, { ok: true }>
  timeoutMs: number
  onMessage?: MessageListener
  signal?: AbortSignal
  now: () => number
}

const econ = (p: EngineParams): Economics => p.economics ?? DEFAULT_ECONOMICS
const sameStructure = (p: Position, s: Extract<Structure, { ok: true }>) => p.principal === s.principal && p.term_blocks === s.term_blocks && p.settlement === s.settlement

/** The transcript as engine turns. */
export function transcriptTurns(messages: NegotiationMessage[], borrowerPk: Hex): Turn[] {
  return messages.filter((m) => ['ASK', 'OFFER', 'COUNTER', 'ACCEPT', 'NO_DEAL'].includes(m.type)).map((m) => ({
    role: m.from_pk === borrowerPk ? 'borrower' : 'lender',
    move: (m.type === 'NO_DEAL' ? { type: 'NO_DEAL', reason: String(m.body.reason ?? '') } : { type: m.type, position: m.body.position as Position }) as Move,
  }))
}

/** Decrypted, signature-checked counterparty messages of one negotiation, in arrival order. */
class Inbox {
  private readonly queue: NegotiationMessage[] = []
  private readonly seenEvents = new Set<string>()
  private wake?: () => void
  private readonly close: () => void

  constructor(private readonly c: Pick<SessionCtx, 'transport' | 'signer' | 'counterparty' | 'id'>, kinds: number[], since: number) {
    this.close = c.transport.subscribe({ kinds, authors: [c.counterparty], '#p': [c.signer.pubkey], '#n': [c.id], since }, (e) => { void this.take(e) })
  }

  private async take(e: NostrEvent): Promise<void> {
    if (this.seenEvents.has(e.id)) return
    this.seenEvents.add(e.id)
    if (e.pubkey !== this.c.counterparty || !authentic(e) || !e.tags.some((t) => t[0] === 'n' && t[1] === this.c.id)) return
    let m: NegotiationMessage
    try { m = JSON.parse(await this.c.signer.nip44Decrypt(e.pubkey, e.content)) as NegotiationMessage } catch { return }
    // the event's kind must be the message's, and the message must be the event author's
    if (!m || typeof m !== 'object' || m.negotiation_id !== this.c.id || m.from_pk !== e.pubkey || EVENT_KIND[m.type] !== e.kind || !verifySigned(m, m.from_pk)) return
    this.queue.push(m)
    this.wake?.()
  }

  /** The next message at `seq`: earlier sequence numbers (duplicates, replays) are dropped; null on timeout or abort. */
  async next(seq: number, timeoutMs: number, signal?: AbortSignal): Promise<NegotiationMessage | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      while (this.queue.length) {
        const m = this.queue.shift()!
        if (m.seq === seq) return m
      }
      if (signal?.aborted) return null
      const left = deadline - Date.now()
      if (left <= 0) return null
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left)
        const onAbort = () => done()
        signal?.addEventListener('abort', onAbort, { once: true })
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve() }
        this.wake = done
      })
      this.wake = undefined
    }
  }

  stop(): void { this.close() }
}

async function publishMessage(c: SessionCtx, m: NegotiationMessage): Promise<void> {
  const tags = [['t', TOPIC], ['p', c.counterparty], ['n', c.id]]
  const content = m.type === 'ASK' ? JSON.stringify(m) : await c.signer.nip44Encrypt(c.counterparty, JSON.stringify(m))
  const event = await signNostrEvent(c.signer, { kind: EVENT_KIND[m.type], created_at: Math.floor(c.now() / 1000), tags, content })
  await c.transport.publish(event)
}

/** Sign and send one move: never outside the own signed policy and the economics (POLICY instead). */
async function send(c: SessionCtx, chain: NegotiationMessage[], move: Move, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string; problem: string }> {
  if ('position' in move && (!acceptable(c.role, c.policy, move.position, econ(c.params)) || !sameStructure(move.position, c.s))) {
    return { ok: false, reason: 'POLICY', problem: `refused to sign a ${move.type} outside this party's signed policy or the agreed structure` }
  }
  let m: NegotiationMessage
  try { m = await appendMessage(chain, messageSigner(c.signer), move.type, body, c.id) } catch (err) { return { ok: false, reason: 'SIGNER', problem: (err as Error).message } }
  try { await publishMessage(c, m) } catch (err) { return { ok: false, reason: 'TRANSPORT', problem: (err as Error).message } }
  c.onMessage?.(m, 'sent')
  return { ok: true }
}

const expectFor = (c: SessionCtx) => ({
  borrower_pk: c.role === 'borrower' ? c.signer.pubkey : c.counterparty,
  lender_pk: c.role === 'lender' ? c.signer.pubkey : c.counterparty,
  max_rounds: c.params.max_rounds,
  economics: econ(c.params),
})

function result(c: SessionCtx, chain: NegotiationMessage[], outcome: Outcome, problems: string[] = []): NegotiationResult {
  const verified = verifyTranscript(chain, expectFor(c))
  // an agreement stands only on a transcript that verifies and ends in exactly that position
  if ('agreed' in outcome && (!verified.ok || hashObject(verified.agreed) !== hashObject(outcome.agreed))) {
    return { negotiation_id: c.id, role: c.role, counterparty_pk: c.counterparty, outcome: { no_deal: 'PROTOCOL' }, messages: chain, structure: c.s, verified, problems: [...problems, ...verified.problems] }
  }
  return { negotiation_id: c.id, role: c.role, counterparty_pk: c.counterparty, outcome, messages: chain, structure: c.s, verified, problems }
}

/** Alternate moves until ACCEPT, NO_DEAL, a timeout or a bad message. `ourTurn`: whether the next message is ours. */
async function converse(c: SessionCtx, inbox: Inbox, chain: NegotiationMessage[], ourTurn: boolean): Promise<NegotiationResult> {
  const borrowerPk = expectFor(c).borrower_pk
  for (let guard = 0; guard < 2 * c.params.max_rounds + 4; guard++) {
    if (ourTurn) {
      const move = nextMove(c.role, c.policy, c.params, c.s, transcriptTurns(chain, borrowerPk))
      const nonce = String(chain[0]?.body.nonce ?? '')
      const sent = await send(c, chain, move, moveBody({ role: c.role, move }, c.policy, chain.at(-1), nonce))
      if (!sent.ok) return result(c, chain, { no_deal: sent.reason }, [sent.problem])
      if (move.type === 'ACCEPT') return result(c, chain, { agreed: move.position })
      if (move.type === 'NO_DEAL') return result(c, chain, { no_deal: move.reason })
      ourTurn = false
      continue
    }
    const m = await inbox.next(chain.length, c.timeoutMs, c.signal)
    if (!m) return result(c, chain, { no_deal: c.signal?.aborted ? 'ABORTED' : 'TIMEOUT' }, [`no valid message #${chain.length} from ${c.counterparty.slice(0, 12)}… within ${c.timeoutMs} ms`])
    const next = [...chain, m]
    const v = verifyTranscript(next, expectFor(c))
    if (!v.ok) return result(c, chain, { no_deal: 'PROTOCOL' }, v.problems)
    if (m.type === 'TERMSHEET' || m.type === 'APPROVED') return result(c, chain, { no_deal: 'PROTOCOL' }, [`#${m.seq} ${m.type} before an agreement`])
    chain.push(m)
    c.onMessage?.(m, 'received')
    if (m.type === 'NO_DEAL') return result(c, chain, { no_deal: String(m.body.reason ?? 'NO_DEAL') })
    if (!sameStructure(m.body.position as Position, c.s)) {
      // our turn: say why, and stop
      const sent = await send(c, chain, { type: 'NO_DEAL', reason: 'STRUCTURE' }, { reason: 'STRUCTURE' })
      return result(c, chain, { no_deal: 'STRUCTURE' }, [`#${m.seq} ${m.type} changed principal, term or settlement`, ...(sent.ok ? [] : [sent.problem])])
    }
    if (m.type === 'ACCEPT') return result(c, chain, { agreed: m.body.position as Position })
    ourTurn = true
  }
  return result(c, chain, { no_deal: 'PROTOCOL' }, ['negotiation did not terminate'])
}

const ownPolicyOk = (p: BorrowerPolicy | LenderPolicy, kind: BorrowerPolicy['kind'] | LenderPolicy['kind'], pk: Hex) => !!p && p.v === 1 && p.kind === kind && p.owner_pk === pk && verifySigned(p, pk)

// ---- the borrower ----

export interface BorrowerNegotiationOptions {
  transport: NegotiationTransport
  signer: NegotiationSigner
  /** The borrower's own signed policy; owner_pk is the signer's key. */
  policy: BorrowerPolicy
  /** The lender's terms from its signed 38388 offer (OfferPayload.negotiation); terms.lender_pk is the counterparty. */
  terms: NegotiationTerms
  /** The borrower's engine parameters; max_rounds is taken from the terms. */
  params: EngineParams
  /** 32 random bytes, hex; fresh by default. The negotiation id is negotiationId(borrower, nonce). */
  nonce?: Hex
  /** How long to wait for each lender message; default 30 s. */
  timeoutMs?: number
  /** Every message as it is signed or received (the phone shows the transcript live). */
  onMessage?: MessageListener
  signal?: AbortSignal
  now?: () => number
}

/** The borrower's side: ASK the lender, then alternate moves until ACCEPT or NO_DEAL. */
export async function negotiateAsBorrower(o: BorrowerNegotiationOptions): Promise<NegotiationResult> {
  if (!ownPolicyOk(o.policy, 'passbook-borrower-policy', o.signer.pubkey)) throw new Error('the borrower policy is not signed by this signer')
  const termProblems = negotiationTermsProblems(o.terms)
  if (termProblems.length) throw new Error(`invalid lender negotiation terms: ${termProblems.join(', ')}`)
  const nonce = o.nonce ?? randomHex(32)
  if (!isHex(nonce, 32)) throw new Error('the nonce must be 32 bytes of hex')
  const now = o.now ?? Date.now
  const params: EngineParams = { ...o.params, max_rounds: o.terms.max_rounds }
  const id = negotiationId(o.signer.pubkey, nonce)
  const lender = o.terms.lender_pk
  const s0 = baseStructure(o.policy, termsView(o.terms), params)
  const s = s0.ok && s0.principal < o.terms.min_principal ? ({ ok: false, reason: 'PRINCIPAL' } as const) : s0
  const empty = (reason: string): NegotiationResult => ({ negotiation_id: id, role: 'borrower', counterparty_pk: lender, outcome: { no_deal: reason }, messages: [], structure: s, verified: { ok: false, problems: ['EMPTY'] }, problems: [`no ASK sent: ${reason}`] })
  if (!s.ok) return empty(s.reason)
  const c: SessionCtx = { role: 'borrower', transport: o.transport, signer: o.signer, policy: o.policy, params, counterparty: lender, id, s, timeoutMs: o.timeoutMs ?? 30_000, onMessage: o.onMessage, signal: o.signal, now }
  const ask = nextMove('borrower', o.policy, params, s, [])
  if (ask.type !== 'ASK') return empty(ask.type === 'NO_DEAL' ? ask.reason : 'PROTOCOL')
  // listen before the ASK goes out: the lender may answer at once
  const inbox = new Inbox(c, [NEG_KIND.OFFER, NEG_KIND.COUNTER, NEG_KIND.ACCEPT, NEG_KIND.NO_DEAL], Math.floor(now() / 1000) - 5)
  try {
    const chain: NegotiationMessage[] = []
    const body = { ...moveBody({ role: 'borrower', move: ask }, o.policy, undefined, nonce), lender_pk: lender, lender_policy_hash: o.terms.policy_hash, max_rounds: params.max_rounds }
    const sent = await send(c, chain, ask, body)
    if (!sent.ok) return result(c, chain, { no_deal: sent.reason }, [sent.problem])
    return await converse(c, inbox, chain, false)
  } finally { inbox.stop() }
}

// ---- the lender ----

/** A verified ASK addressed to this lender, before it is answered. */
export interface AskInfo {
  negotiation_id: Hex
  borrower_pk: Hex
  nonce: Hex
  position: Position
  message: NegotiationMessage
  event: NostrEvent
}

/** Negotiation ids already answered (replay protection); a Set works, a durable store survives restarts. */
export interface ReplayStore { has(id: Hex): boolean; add(id: Hex): unknown }

export interface LenderNegotiationOptions {
  transport: NegotiationTransport
  /** The lender's own signed policy. */
  policy: LenderPolicy
  /** The deployment's engine parameters; ASKs must name the same max_rounds. */
  params: EngineParams
  /** The signer for one negotiation: on the laptop keyPairSigner(party key, agent.negotiationSigner(borrower, nonce)). */
  signer: (ask: AskInfo) => NegotiationSigner | Promise<NegotiationSigner>
  /** The lender's current outstanding principal, for the structure step. */
  outstanding?: () => Micro | Promise<Micro>
  /** The smallest principal this lender takes (its fixed offer's min). */
  min_principal?: Micro
  /** Governance before answering (kill switch, sanctions, capacity): true, or a code that ends it with NO_DEAL REFUSED:<code>. */
  admit?: (ask: AskInfo) => Promise<true | string> | true | string
  /** How long to wait for each borrower message; default 30 s. */
  timeoutMs?: number
  /** ASKs older than this are stale (replays); default 120 s. */
  maxAskAgeSec?: number
  seen?: ReplayStore
  onMessage?: (m: NegotiationMessage, direction: 'sent' | 'received', ask: AskInfo) => void
  signal?: AbortSignal
  now?: () => number
}

/** A fresh, signed ASK to this lender, or why it is ignored (not answered at all). */
export function readAsk(event: NostrEvent, lenderPk: Hex, o: { now?: () => number; maxAskAgeSec?: number } = {}): AskInfo | { ignored: string } {
  const nowSec = Math.floor((o.now ?? Date.now)() / 1000)
  if (event.kind !== NEG_KIND.ASK || !authentic(event)) return { ignored: 'not an authentic ASK event' }
  if (!event.tags.some((t) => t[0] === 'p' && t[1] === lenderPk)) return { ignored: 'addressed to another lender' }
  if (event.created_at < nowSec - (o.maxAskAgeSec ?? 120) || event.created_at > nowSec + 60) return { ignored: 'stale or future ASK' }
  let m: NegotiationMessage
  try { m = JSON.parse(event.content) as NegotiationMessage } catch { return { ignored: 'unreadable content' } }
  if (!m || typeof m !== 'object' || m.type !== 'ASK' || m.seq !== 0 || m.prev_hash !== null || m.from_pk !== event.pubkey || !verifySigned(m, m.from_pk)) return { ignored: 'not a signed opening ASK by the event author' }
  const nonce = m.body?.nonce
  if (!isHex(nonce, 32) || m.negotiation_id !== negotiationId(m.from_pk, nonce as Hex) || !event.tags.some((t) => t[0] === 'n' && t[1] === m.negotiation_id)) return { ignored: 'wrong negotiation id' }
  if (m.body.lender_pk !== lenderPk) return { ignored: 'the signed ASK names another lender' }
  if (!isPosition(m.body.position)) return { ignored: 'invalid position' }
  return { negotiation_id: m.negotiation_id, borrower_pk: m.from_pk, nonce: nonce as Hex, position: m.body.position as Position, message: m, event }
}

/**
 * The lender's side for one ASK event: null when the event is ignored (not a fresh, valid ASK to this lender, or a
 * replay); otherwise the negotiation's result. Governance (admit) decides before any other check is answered.
 */
export async function answerAsk(o: LenderNegotiationOptions, event: NostrEvent): Promise<NegotiationResult | null> {
  const lenderPk = o.policy.owner_pk
  if (!ownPolicyOk(o.policy, 'passbook-lender-policy', lenderPk)) throw new Error('the lender policy is not signed by its owner')
  const ask = readAsk(event, lenderPk, o)
  if ('ignored' in ask) return null
  const seen = o.seen ?? defaultSeen(o)
  if (seen.has(ask.negotiation_id)) return null
  seen.add(ask.negotiation_id)
  const now = o.now ?? Date.now
  const pos = ask.position
  const body = ask.message.body
  // the structure the borrower asked for, taken only if it is inside this lender's signed policy
  const bview = { asset_id: String(body.asset_id ?? ''), principal: { min: pos.principal, max: pos.principal }, term_blocks: { min: pos.term_blocks, max: pos.term_blocks }, accepted_settlements: [pos.settlement], min_scorer_trust: (TRUST_LEVELS as readonly string[]).includes(String(body.min_scorer_trust)) ? (body.min_scorer_trust as LenderPolicy['min_scorer_trust']) : o.policy.min_scorer_trust }
  const s0 = baseStructure(bview, o.policy, o.params, o.outstanding ? await o.outstanding() : 0)
  const s = s0.ok && pos.principal < (o.min_principal ?? 1) ? ({ ok: false, reason: 'PRINCIPAL' } as const) : s0
  const signer = await o.signer(ask)
  if (signer.pubkey !== lenderPk) throw new Error('the negotiation signer is not the lender policy owner')
  const sStructure: Extract<Structure, { ok: true }> = s.ok ? s : { ok: true, principal: pos.principal, term_blocks: pos.term_blocks, settlement: pos.settlement, scorer_trust: o.policy.min_scorer_trust }
  const c: SessionCtx = { role: 'lender', transport: o.transport, signer, policy: o.policy, params: o.params, counterparty: ask.borrower_pk, id: ask.negotiation_id, s: sStructure, timeoutMs: o.timeoutMs ?? 30_000, onMessage: o.onMessage ? (m, d) => o.onMessage!(m, d, ask) : undefined, signal: o.signal, now }
  const chain: NegotiationMessage[] = [ask.message]
  const first = verifyTranscript(chain, expectFor(c))
  if (!first.ok) return { ...result(c, chain, { no_deal: 'PROTOCOL' }, first.problems), messages: [] }
  c.onMessage?.(ask.message, 'received')
  const inbox = new Inbox(c, [NEG_KIND.COUNTER, NEG_KIND.ACCEPT, NEG_KIND.NO_DEAL], Math.max(0, ask.event.created_at - 5))
  try {
    const refuse = async (reason: string, problem: string) => {
      const sent = await send(c, chain, { type: 'NO_DEAL', reason }, { reason })
      return { ...result(c, chain, { no_deal: sent.ok ? reason : sent.reason }, [problem, ...(sent.ok ? [] : [sent.problem])]), structure: s }
    }
    // governance first: nothing else is decided for a borrower this lender's node refuses
    const admitted = o.admit ? await o.admit(ask) : true
    if (admitted !== true) return await refuse(`REFUSED:${admitted}`, `refused by this lender's governance: ${admitted}`)
    if (body.max_rounds !== o.params.max_rounds) return await refuse('PARAMS', `the ASK names ${String(body.max_rounds)} rounds; this lender negotiates ${o.params.max_rounds}`)
    if (body.lender_policy_hash !== hashObject(o.policy)) return await refuse('STALE_TERMS', 'the ASK names another version of this lender\'s policy')
    if (!s.ok) return await refuse(s.reason, `the asked structure is outside this lender's signed policy (${s.reason})`)
    return await converse(c, inbox, chain, true)
  } catch (err) {
    return result(c, chain, { no_deal: 'SIGNER' }, [(err as Error).message])
  } finally { inbox.stop() }
}

const seenByOptions = new WeakMap<object, ReplayStore>()
function defaultSeen(o: LenderNegotiationOptions): ReplayStore {
  let s = seenByOptions.get(o)
  if (!s) { s = new Set<Hex>(); seenByOptions.set(o, s) }
  return s
}

/** Answer every ASK to this lender as it arrives (each once). `close` stops listening; running negotiations finish. */
export function serveNegotiations(o: LenderNegotiationOptions & { onResult: (r: NegotiationResult) => void; onError?: (err: unknown) => void }): { close(): void } {
  const opts: LenderNegotiationOptions = { ...o, seen: o.seen ?? new Set<Hex>() }
  const since = Math.floor((o.now ?? Date.now)() / 1000) - (o.maxAskAgeSec ?? 120)
  const close = o.transport.subscribe({ kinds: [NEG_KIND.ASK], '#p': [o.policy.owner_pk], '#t': [TOPIC], since }, (event) => {
    answerAsk(opts, event).then((r) => { if (r) o.onResult(r) }, (err) => o.onError?.(err))
  })
  return { close }
}

/** The first negotiation with this lender that reaches an agreement (no-deal results go to onResult and it keeps listening). */
export function awaitNegotiation(o: LenderNegotiationOptions & { waitMs?: number; onResult?: (r: NegotiationResult) => void }): Promise<NegotiationResult> {
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (fn: () => void) => { if (finished) return; finished = true; clearTimeout(timer); server.close(); fn() }
    const timer = setTimeout(() => finish(() => reject(new Error(`no negotiation reached an agreement within ${o.waitMs ?? 300_000} ms`))), o.waitMs ?? 300_000)
    const server = serveNegotiations({ ...o, onResult: (r) => { o.onResult?.(r); if ('agreed' in r.outcome) finish(() => resolve(r)) }, onError: (err) => finish(() => reject(err)) })
  })
}
