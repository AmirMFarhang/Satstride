// The browser-safe core of the negotiation engine (src/market/negotiate.ts):
// positions, moves, the signed hash-chained messages and their verification.
// It imports no node: module and nothing from the scorer or check-node code, so
// the phone (apps/mobile, through Metro) and the relay protocol in
// negotiate-nostr.ts run the very same engine as the laptop. negotiate.ts
// re-exports all of it and adds the check-market structure step, the
// single-process simulation and the ranking.
//
// Deterministic negotiation: ASK -> OFFER -> COUNTER... -> ACCEPT | NO_DEAL,
// then TERMSHEET and APPROVED. Every message carries the negotiation id, a
// sequence number, the previous message's hash and its sender's signature, so
// the whole negotiation is an auditable chain.
//
// The engine is pure. APR and LTV are negotiated; each move covers a fixed
// share of the gap to the counterparty's last position and is clamped first to
// the platform's economics (APR cap, LTV limit for the term) and then to the
// mover's own policy bound, so no position ever crosses either. A move that
// would still cross the economics is never sent: the mover ends with NO_DEAL. A party accepts
// a position inside its own bounds when the gap is under tolerance, when it is
// no worse than its own, or on its last allowed move; otherwise after
// max_rounds moves each way it is no deal. Principal, term,
// settlement kind and the scorer trust floor are structural: computed once
// from both policies. A local model may explain offers; it never produces a
// number (explainRanking drops any text that contains one).

import { hashObject, isHex, type Hex, type KeyPair } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm, maxTermBlocks, termInterest, type Economics } from '../core/economics.js'
import { BPS, collateralFor, pct, usdt, type Bps, type Micro, type Sats } from '../core/money.js'
import type { CheckNodePick } from '../checknode/select.js'
import type { CheckRail } from '../checknode/offer.js'
import { strongerTrust, type TrustLevel } from '../scorer/trust.js'
import { SETTLEMENT_PREFERENCE, type SettlementKind } from '../settlement/kinds.js'
import { signWith, verifySigned, type Signer } from '../wallet/signer.js'
import { KIND } from './kinds.js'
import { encryptedJson, publicJson, type Event } from './messages.js'
import type { BorrowerPolicy, LenderPolicy } from './policy.js'

export interface Position { principal: Micro; apr_bps: Bps; ltv_bps: Bps; term_blocks: number; settlement: SettlementKind }

export interface EngineParams {
  max_rounds: number
  /** Share of the gap covered per move, in bps (2,500 = a quarter). */
  concession_bps: number
  tolerance: { apr_bps: number; ltv_bps: number }
  enabled_settlements: SettlementKind[]
  /** The platform's bounds, applied before either policy; DEFAULT_ECONOMICS when absent. */
  economics?: Economics
}

export const DEFAULT_TOLERANCE = Object.freeze({ apr_bps: 25, ltv_bps: 100 })

const econOf = (params: Pick<EngineParams, 'economics'>): Economics => params.economics ?? DEFAULT_ECONOMICS

/** Whether a position is inside the platform's economics: APR at or under the cap, LTV at or under the term's limit. */
export function withinEconomics(x: Pick<Position, 'apr_bps' | 'ltv_bps' | 'term_blocks'>, e: Economics = DEFAULT_ECONOMICS): boolean {
  return x.apr_bps <= e.max_apr_bps && x.ltv_bps <= maxLtvForTerm(x.term_blocks, e)
}

export type Structure =
  | { ok: true; principal: Micro; term_blocks: number; settlement: SettlementKind; scorer_trust: TrustLevel; check_node?: CheckNodeChoice }
  | { ok: false; reason: 'ASSET' | 'PRINCIPAL' | 'TERM' | 'SETTLEMENT' | 'APR_CAP' | 'CHECK_NODE'; why?: string[] }

/** Which check node the structure step picked, and why; deterministic from both policies and the offers. */
export interface CheckNodeChoice { operator_pk: Hex; release_hash: Hex; rail: CheckRail; pay_with: string; cost: number; why: string[]; pick: CheckNodePick; second_operator_pk?: Hex }

/** The structural part of each policy: what fixes principal, term, settlement and the trust floor (never the APR or LTV bounds). */
export type BorrowerStructure = Pick<BorrowerPolicy, 'asset_id' | 'principal' | 'term_blocks' | 'accepted_settlements' | 'min_scorer_trust'>
export type LenderStructure = Pick<LenderPolicy, 'asset_id' | 'max_per_loan' | 'max_outstanding' | 'term_blocks' | 'min_apr_bps' | 'accepted_settlements' | 'min_scorer_trust'>

/** The structure step without the check market (negotiate.ts structure() adds the check-node pick on top). */
export function baseStructure(bp: BorrowerStructure, lp: LenderStructure, params: EngineParams, lenderOutstanding: Micro = 0): Structure {
  if (bp.asset_id !== lp.asset_id) return { ok: false, reason: 'ASSET' }
  const principal = Math.min(bp.principal.max, lp.max_per_loan, lp.max_outstanding - lenderOutstanding)
  if (principal < bp.principal.min) return { ok: false, reason: 'PRINCIPAL' }
  const e = econOf(params)
  // the longest common term the economics give any LTV for
  const lo = Math.max(bp.term_blocks.min, lp.term_blocks.min), hi = Math.min(bp.term_blocks.max, lp.term_blocks.max, maxTermBlocks(e))
  if (lo > hi) return { ok: false, reason: 'TERM' }
  // a lender whose floor is above the cap can never make a lawful offer
  if (lp.min_apr_bps > e.max_apr_bps) return { ok: false, reason: 'APR_CAP' }
  const settlement = SETTLEMENT_PREFERENCE.find((k) => bp.accepted_settlements.includes(k) && lp.accepted_settlements.includes(k) && params.enabled_settlements.includes(k))
  if (!settlement) return { ok: false, reason: 'SETTLEMENT' }
  const scorerTrust = strongerTrust(bp.min_scorer_trust, lp.min_scorer_trust)
  return { ok: true, principal, term_blocks: hi, settlement, scorer_trust: scorerTrust }
}

export type Role = 'borrower' | 'lender'
type Policy = BorrowerPolicy | LenderPolicy

/** Inside the mover's own policy and the platform's economics. A party never accepts anything else. */
export function acceptable(role: Role, policy: Policy, x: Position, e: Economics = DEFAULT_ECONOMICS): boolean {
  if (!withinEconomics(x, e)) return false
  return role === 'borrower'
    ? x.apr_bps <= (policy as BorrowerPolicy).max_apr_bps && x.ltv_bps <= policy.max_ltv_bps
    : x.apr_bps >= (policy as LenderPolicy).min_apr_bps && x.ltv_bps <= policy.max_ltv_bps
}

/** Economics first (APR cap, LTV limit for the term), then the mover's policy bounds. */
function clamp(role: Role, policy: Policy, x: Pick<Position, 'apr_bps' | 'ltv_bps'>, termBlocks: number, e: Economics): Pick<Position, 'apr_bps' | 'ltv_bps'> {
  const apr = Math.min(x.apr_bps, e.max_apr_bps), ltv = Math.min(x.ltv_bps, maxLtvForTerm(termBlocks, e))
  return role === 'borrower'
    ? { apr_bps: Math.max(0, Math.min(apr, (policy as BorrowerPolicy).max_apr_bps)), ltv_bps: Math.max(1, Math.min(ltv, policy.max_ltv_bps)) }
    : { apr_bps: Math.max(apr, (policy as LenderPolicy).min_apr_bps), ltv_bps: Math.max(1, Math.min(ltv, policy.max_ltv_bps)) }
}

export function opening(role: Role, policy: Policy, s: Extract<Structure, { ok: true }>, e: Economics = DEFAULT_ECONOMICS): Position {
  const base = { principal: s.principal, term_blocks: s.term_blocks, settlement: s.settlement }
  if (role === 'borrower') {
    const bp = policy as BorrowerPolicy
    return { ...base, ...clamp(role, bp, { apr_bps: bp.opening?.apr_bps ?? Math.floor((bp.max_apr_bps * 3) / 4), ltv_bps: bp.opening?.ltv_bps ?? bp.max_ltv_bps }, s.term_blocks, e) }
  }
  const lp = policy as LenderPolicy
  return { ...base, ...clamp(role, lp, { apr_bps: lp.opening?.apr_bps ?? lp.min_apr_bps + 400, ltv_bps: lp.opening?.ltv_bps ?? lp.max_ltv_bps - 1000 }, s.term_blocks, e) }
}

/** Moves a share of the gap, at least one unit while a gap remains, never past the target. */
function toward(own: number, target: number, shareBps: number): number {
  const gap = target - own
  if (gap === 0) return own
  return own + Math.sign(gap) * Math.min(Math.abs(gap), Math.ceil((Math.abs(gap) * shareBps) / BPS))
}

export type Move =
  | { type: 'ASK' | 'OFFER' | 'COUNTER'; position: Position }
  | { type: 'ACCEPT'; position: Position }
  | { type: 'NO_DEAL'; reason: string }

export interface Turn { role: Role; move: Move }

const lastPosition = (history: Turn[], role: Role) => [...history].reverse().find((t) => t.role === role && 'position' in t.move)?.move as { position: Position } | undefined

function atLeastAsGood(role: Role, x: Position, own: Position): boolean {
  return role === 'borrower' ? x.apr_bps <= own.apr_bps && x.ltv_bps >= own.ltv_bps : x.apr_bps >= own.apr_bps && x.ltv_bps <= own.ltv_bps
}

/** One party's next move, from its own policy and the shared history only. */
export function nextMove(role: Role, policy: Policy, params: EngineParams, s: Extract<Structure, { ok: true }>, history: Turn[]): Move {
  const e = econOf(params)
  // a position outside the economics is never sent, whatever produced it
  const send = (type: 'ASK' | 'OFFER' | 'COUNTER', position: Position): Move => (withinEconomics(position, e) ? { type, position } : { type: 'NO_DEAL', reason: 'ECONOMICS' })
  const theirs = lastPosition(history, role === 'borrower' ? 'lender' : 'borrower')?.position
  const mine = lastPosition(history, role)?.position
  if (!theirs) {
    if (role === 'borrower') return send('ASK', opening(role, policy, s, e))
    throw new Error('the lender moves only after an ASK')
  }
  const moves = history.filter((t) => t.role === role && (t.move.type === 'OFFER' || t.move.type === 'COUNTER')).length
  const lastMove = moves >= params.max_rounds
  if (acceptable(role, policy, theirs, e)) {
    const close = mine && Math.abs(theirs.apr_bps - mine.apr_bps) <= params.tolerance.apr_bps && Math.abs(theirs.ltv_bps - mine.ltv_bps) <= params.tolerance.ltv_bps
    // Accept inside its own bounds before its first move, when the gap is under
    // tolerance, when the offer is no worse than its own, or on its last move.
    if (!mine || close || atLeastAsGood(role, theirs, mine) || lastMove) return { type: 'ACCEPT', position: theirs }
  }
  if (lastMove) return { type: 'NO_DEAL', reason: 'MAX_ROUNDS' }
  if (!mine) return send('OFFER', opening(role, policy, s, e))
  const next = clamp(role, policy, { apr_bps: toward(mine.apr_bps, theirs.apr_bps, params.concession_bps), ltv_bps: toward(mine.ltv_bps, theirs.ltv_bps, params.concession_bps) }, mine.term_blocks, e)
  return send('COUNTER', { ...mine, ...next })
}

export type Outcome = { agreed: Position } | { no_deal: string }

// ---- signed, hash-chained messages ----

export const MESSAGE_TYPES = ['ASK', 'OFFER', 'COUNTER', 'ACCEPT', 'NO_DEAL', 'TERMSHEET', 'APPROVED'] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

export interface NegotiationMessage {
  v: 1
  domain: 'passbook-negotiation-v1'
  negotiation_id: Hex
  seq: number
  type: MessageType
  from_pk: Hex
  prev_hash: Hex | null
  body: Record<string, unknown>
  sig: Hex
}

export function negotiationId(borrowerPk: Hex, nonce: Hex): Hex {
  return hashObject({ domain: 'passbook-negotiation-id-v1', borrower_pk: borrowerPk, nonce })
}

export function messageHash(m: NegotiationMessage): Hex {
  return hashObject(m)
}

export async function appendMessage(chain: NegotiationMessage[], signer: Signer, type: MessageType, body: Record<string, unknown>, negotiation_id?: Hex): Promise<NegotiationMessage> {
  const prev = chain.at(-1)
  const id = prev?.negotiation_id ?? negotiation_id
  if (!id) throw new Error('the first message needs a negotiation id')
  const m = await signWith(signer, { v: 1 as const, domain: 'passbook-negotiation-v1' as const, negotiation_id: id, seq: chain.length, type, from_pk: signer.pubkey, prev_hash: prev ? messageHash(prev) : null, body })
  chain.push(m)
  return m
}

/** The body of a move's message; the policy hash commits to the signed policy without revealing it (same as policy.ts policyHash). */
export function moveBody(turn: Turn, policy: BorrowerPolicy | LenderPolicy, prev: NegotiationMessage | undefined, nonce: Hex): Record<string, unknown> {
  const m = turn.move
  const policyHash = hashObject(policy)
  if (m.type === 'ASK') return { position: m.position, asset_id: policy.asset_id, accepted_settlements: policy.accepted_settlements, min_scorer_trust: policy.min_scorer_trust, policy_hash: policyHash, nonce }
  if (m.type === 'OFFER') return { position: m.position, policy_hash: policyHash, required_checks: (policy as LenderPolicy).required_checks, min_scorer_trust: policy.min_scorer_trust, ...((policy as LenderPolicy).check_nodes ? { check_nodes: (policy as LenderPolicy).check_nodes } : {}) }
  if (m.type === 'COUNTER') return { position: m.position }
  if (m.type === 'ACCEPT') return { accepted_hash: messageHash(prev!), position: m.position }
  if (m.type === 'NO_DEAL') return { reason: m.reason }
  throw new Error(`unexpected move ${m.type}`)
}

export const EVENT_KIND: Record<MessageType, number> = { ASK: KIND.NEG_ASK, OFFER: KIND.NEG_OFFER, COUNTER: KIND.NEG_COUNTER, ACCEPT: KIND.NEG_ACCEPT, NO_DEAL: KIND.NEG_NO_DEAL, TERMSHEET: KIND.NEG_TERMSHEET, APPROVED: KIND.NEG_APPROVED }

/** The Nostr event carrying a message: ASK public, everything else NIP-44 to the counterparty. */
export function negotiationEvent(key: KeyPair, m: NegotiationMessage, counterparty?: Hex, nowMs = Date.now()): Event {
  if (key.pubkey !== m.from_pk) throw new Error('only the sender publishes its message')
  const tags = [['n', m.negotiation_id]]
  if (m.type === 'ASK') return publicJson(key, EVENT_KIND.ASK, m, tags, nowMs)
  if (!counterparty) throw new Error(`${m.type} is encrypted and needs the counterparty key`)
  return encryptedJson(key, EVENT_KIND[m.type], m, counterparty, tags, nowMs)
}

const POSITION_KEYS = ['apr_bps', 'ltv_bps', 'principal', 'settlement', 'term_blocks'].join()
export const isPosition = (p: unknown): p is Position => {
  const x = p as Position
  return !!x && typeof x === 'object' && Object.keys(x).sort().join() === POSITION_KEYS && [x.principal, x.apr_bps, x.ltv_bps, x.term_blocks].every((n) => Number.isSafeInteger(n) && n >= 0) && typeof x.settlement === 'string'
}

/** Anyone holding the messages can check the chain; the private policies are not needed. */
export function verifyTranscript(messages: NegotiationMessage[], expect: { borrower_pk: Hex; lender_pk: Hex; max_rounds: number; economics?: Economics }): { ok: boolean; problems: string[]; agreed?: Position; accept_hash?: Hex } {
  const e = expect.economics ?? DEFAULT_ECONOMICS
  const problems: string[] = []
  if (!messages.length) return { ok: false, problems: ['EMPTY'] }
  const ask = messages[0]
  const id = negotiationId(expect.borrower_pk, String(ask.body?.nonce ?? ''))
  let phase: 'positions' | 'closed' | 'agreed' = 'positions'
  const rounds = { borrower: 0, lender: 0 }
  let agreed: Position | undefined
  let acceptHash: Hex | undefined
  messages.forEach((m, i) => {
    const at = `#${i} ${m?.type}`
    if (!m || m.v !== 1 || m.domain !== 'passbook-negotiation-v1' || !(MESSAGE_TYPES as readonly string[]).includes(m.type)) { problems.push(`${at}: malformed`); return }
    if (m.negotiation_id !== id) problems.push(`${at}: wrong negotiation id`)
    if (m.seq !== i) problems.push(`${at}: wrong sequence`)
    if (m.prev_hash !== (i === 0 ? null : messageHash(messages[i - 1]))) problems.push(`${at}: broken hash chain`)
    if (![expect.borrower_pk, expect.lender_pk].includes(m.from_pk) || !verifySigned(m, m.from_pk)) problems.push(`${at}: bad signature or unknown sender`)
    const role: Role = m.from_pk === expect.borrower_pk ? 'borrower' : 'lender'
    if (i === 0 && (m.type !== 'ASK' || role !== 'borrower' || !isHex(m.body.nonce, 32))) problems.push(`${at}: must open with the borrower's ASK`)
    if (phase === 'positions') {
      if (i > 0 && messages[i - 1].from_pk === m.from_pk) problems.push(`${at}: parties must alternate`)
      if (m.type === 'OFFER' || m.type === 'COUNTER') {
        if (++rounds[role] > expect.max_rounds) problems.push(`${at}: more than ${expect.max_rounds} rounds`)
        if ((m.type === 'OFFER') !== (role === 'lender' && rounds.lender === 1)) problems.push(`${at}: OFFER is only the lender's first position`)
      }
      if (['ASK', 'OFFER', 'COUNTER', 'ACCEPT'].includes(m.type) && !isPosition(m.body.position)) problems.push(`${at}: invalid position`)
      else if (['ASK', 'OFFER', 'COUNTER', 'ACCEPT'].includes(m.type) && !withinEconomics(m.body.position as Position, e)) problems.push(`${at}: position outside the platform's APR cap or LTV limit for the term`)
      if (m.type === 'ACCEPT') {
        const prev = messages[i - 1]
        if (!prev || m.body.accepted_hash !== messageHash(prev) || hashObject(m.body.position) !== hashObject(prev.body?.position)) problems.push(`${at}: must accept the previous position exactly`)
        agreed = m.body.position as Position
        acceptHash = messageHash(m)
        phase = 'agreed'
      } else if (m.type === 'NO_DEAL') phase = 'closed'
      else if (m.type === 'TERMSHEET' || m.type === 'APPROVED') problems.push(`${at}: no agreement yet`)
    } else if (phase === 'closed') problems.push(`${at}: negotiation already ended without a deal`)
    else if (m.type !== 'TERMSHEET' && m.type !== 'APPROVED') problems.push(`${at}: only TERMSHEET and APPROVED follow an ACCEPT`)
  })
  return { ok: problems.length === 0, problems, ...(agreed ? { agreed, accept_hash: acceptHash } : {}) }
}

// ---- ranking and explanation: code decides, the model may only narrate ----

export interface OfferSummary { lender_pk: Hex; position: Position; fee: Micro; collateral_sats: Sats; lender_record_steps: number }

/** The borrower's cost of an offer is the lender's term interest (termInterest, ACT/365), nothing else. */
export function summarizeOffer(lenderPk: Hex, position: Position, ctx: { price_cents: number; economics?: Economics; lender_record_steps?: number }): OfferSummary {
  const fee = termInterest(position, ctx.economics)
  return { lender_pk: lenderPk, position, fee, collateral_sats: collateralFor(position.principal + fee, position.ltv_bps, ctx.price_cents), lender_record_steps: ctx.lender_record_steps ?? 0 }
}

/** Total cost, then collateral, then the lender's record; the key breaks ties so the order is total. */
export function rankOffers(offers: OfferSummary[]): OfferSummary[] {
  return [...offers].sort((a, b) => a.fee - b.fee || a.collateral_sats - b.collateral_sats || b.lender_record_steps - a.lender_record_steps || (a.lender_pk < b.lender_pk ? -1 : a.lender_pk > b.lender_pk ? 1 : 0))
}

const NUMERIC = /\d|USDT|BTC|sats?\b|%|\$|€|percent|hundred|thousand|million|billion|\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|fifty)\b/i

export async function explainRanking(ranked: OfferSummary[], narrate?: (facts: string[]) => Promise<string>): Promise<{ text: string; by: 'model' | 'template' }> {
  if (!ranked.length) return { text: 'No offer met both policies.', by: 'template' }
  const [best, next] = ranked
  const facts = [`Best: ${best.lender_pk.slice(0, 8)}, cost ${usdt(best.fee)}, ${pct(best.position.apr_bps)} APR, ${pct(best.position.ltv_bps)} LTV.`]
  if (next) facts.push(next.fee === best.fee ? `Next: same cost, ${next.collateral_sats > best.collateral_sats ? 'more' : 'no less'} collateral.` : `Next: costs ${usdt(next.fee - best.fee)} more.`)
  const template = facts.join(' ')
  if (!narrate) return { text: template, by: 'template' }
  try {
    const text = (await narrate(facts)).trim()
    // The model may explain trade-offs in words; any number it writes is discarded.
    if (text && text.length <= 400 && !NUMERIC.test(text)) return { text, by: 'model' }
  } catch { /* fall through to the template, visibly */ }
  return { text: template, by: 'template' }
}
