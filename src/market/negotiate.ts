// Deterministic negotiation (the engine itself, with offer ranking, is in
// negotiate-engine.ts, which is browser-safe and re-exported here unchanged).
// This module adds the structure step with the check market and the
// single-process simulation.

import type { Hex } from '../core/crypto.js'
import type { PassbookConfig } from '../core/config.js'
import { DEFAULT_ECONOMICS } from '../core/economics.js'
import type { Micro } from '../core/money.js'
import type { CheckOffer } from '../checknode/offer.js'
import { pickCheckNode, type PayerConstraints } from '../checknode/select.js'
import type { TeeVerifierConfig } from '../checknode/tee.js'
import { strongerTrust } from '../scorer/trust.js'
import type { TrustPolicy } from '../scorer/verify.js'
import type { Signer } from '../wallet/signer.js'
import { appendMessage, baseStructure, DEFAULT_TOLERANCE, moveBody, negotiationId, nextMove, type EngineParams, type NegotiationMessage, type Outcome, type Role, type Structure, type Turn } from './negotiate-engine.js'
import type { BorrowerPolicy, LenderPolicy } from './policy.js'

export * from './negotiate-engine.js'

export function engineParams(cfg: Pick<PassbookConfig, 'negotiation' | 'settlement'> & Partial<Pick<PassbookConfig, 'economics'>>): EngineParams {
  if (!cfg.negotiation.enabled) throw new Error('negotiation is disabled in this deployment config')
  return { max_rounds: cfg.negotiation.max_rounds, concession_bps: cfg.negotiation.concession_bps, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: [...cfg.settlement.enabled], economics: cfg.economics ?? DEFAULT_ECONOMICS }
}

/** Check market (src/checknode): the offers on the relay and what the payer can pay with; I/O stays with the caller. */
export interface CheckMarketInput { offers: CheckOffer[]; payer: Omit<PayerConstraints, 'max_price'>; trust: TrustPolicy; tee: TeeVerifierConfig }

export function structure(bp: BorrowerPolicy, lp: LenderPolicy, params: EngineParams, lenderOutstanding: Micro = 0, market?: CheckMarketInput): Structure {
  const s = baseStructure(bp, lp, params, lenderOutstanding)
  if (!s.ok || !market) return s
  const { principal, term_blocks: hi, settlement, scorer_trust: scorerTrust } = s
  // The lender's check-node rules, the stronger trust floor of both policies, the borrower's price cap.
  const rules = { ...lp.check_nodes, min_trust: strongerTrust(lp.check_nodes?.min_trust ?? scorerTrust, scorerTrust) }
  const pick = pickCheckNode(market.offers, rules, { ...market.payer, ...(bp.max_check_price ? { max_price: bp.max_check_price } : {}) }, { trust: market.trust, tee: market.tee })
  const c = pick.picked
  if (!c || !c.rail || !c.pay_with) return { ok: false, reason: 'CHECK_NODE', why: pick.why }
  return { ok: true, principal, term_blocks: hi, settlement, scorer_trust: scorerTrust, check_node: { operator_pk: c.operator_pk, release_hash: c.release_hash, rail: c.rail, pay_with: c.pay_with.asset_id, cost: c.cost, why: pick.why, pick, ...(pick.second ? { second_operator_pk: pick.second.operator_pk } : {}) } }
}

/** Both sides locally (tests, single-laptop demo). Over Nostr each agent calls nextMove on its own side. */
export function simulate(bp: BorrowerPolicy, lp: LenderPolicy, params: EngineParams, lenderOutstanding = 0, market?: CheckMarketInput): { structure: Structure; turns: Turn[]; outcome: Outcome } {
  const s = structure(bp, lp, params, lenderOutstanding, market)
  if (!s.ok) return { structure: s, turns: [], outcome: { no_deal: s.reason } }
  const turns: Turn[] = []
  let role: Role = 'borrower'
  for (let guard = 0; guard < 2 * params.max_rounds + 3; guard++) {
    const move = nextMove(role, role === 'borrower' ? bp : lp, params, s, turns)
    turns.push({ role, move })
    if (move.type === 'ACCEPT') return { structure: s, turns, outcome: { agreed: move.position } }
    if (move.type === 'NO_DEAL') return { structure: s, turns, outcome: { no_deal: move.reason } }
    role = role === 'borrower' ? 'lender' : 'borrower'
  }
  throw new Error('negotiation did not terminate')
}

/** `market`: the check-node offers the borrower's agent fetched; the structure step then picks the node from both policies, or ends with CHECK_NODE. */
export async function runNegotiation(bp: BorrowerPolicy, lp: LenderPolicy, params: EngineParams, parties: { borrower: Signer; lender: Signer; nonce: Hex; lenderOutstanding?: Micro; market?: CheckMarketInput }): Promise<{ messages: NegotiationMessage[]; turns: Turn[]; outcome: Outcome; structure: Structure }> {
  if (parties.borrower.pubkey !== bp.owner_pk || parties.lender.pubkey !== lp.owner_pk) throw new Error('signers do not own these policies')
  const sim = simulate(bp, lp, params, parties.lenderOutstanding, parties.market)
  const messages: NegotiationMessage[] = []
  const id = negotiationId(bp.owner_pk, parties.nonce)
  for (const turn of sim.turns) {
    const policy = turn.role === 'borrower' ? bp : lp
    await appendMessage(messages, turn.role === 'borrower' ? parties.borrower : parties.lender, turn.move.type, moveBody(turn, policy, messages.at(-1), parties.nonce), id)
  }
  return { messages, turns: sim.turns, outcome: sim.outcome, structure: sim.structure }
}
