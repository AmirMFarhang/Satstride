// The proof-of-control challenge every layer uses. The lender (the verifier)
// issues it; the borrower signs its text with the address, node or key it
// claims. The text binds the negotiation, the lender, an expiry and a single-use
// nonce, so a signature made for one loan, lender or hour proves nothing for
// another. One line, plain ASCII, so a wallet's message box cannot reflow it.

import { isHex, randomHex, type Hex } from '../core/crypto.js'
import { isChainId, isLayerId, type ChainId, type ControlChallenge, type LayerId, type VerifyExpectation } from './types.js'

export const CHALLENGE_TTL_SECONDS = 2 * 3600
const MAX_TTL_SECONDS = 24 * 3600

const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function challengeText(c: Omit<ControlChallenge, 'text' | 'v' | 'kind'>): string {
  return `Passbook proof of control. Layer ${c.layer} on ${c.chain}, subject ${c.subject}. Negotiation ${c.negotiation_id}. Lender ${c.lender_pk}. Nonce ${c.nonce}. Expires ${iso(c.expires_at)}. This is not a transaction and moves no funds.`
}

export function issueChallenge(args: { layer: LayerId; chain: ChainId; subject: string; negotiation_id: Hex; lender_pk: Hex; now?: number; ttl_seconds?: number; nonce?: Hex }): ControlChallenge {
  const now = args.now ?? Math.floor(Date.now() / 1000)
  const ttl = args.ttl_seconds ?? CHALLENGE_TTL_SECONDS
  if (!isLayerId(args.layer) || !isChainId(args.chain)) throw new Error('challenge layer or chain unknown')
  if (!isHex(args.negotiation_id, 32) || !isHex(args.lender_pk, 32)) throw new Error('challenge needs a 32-byte negotiation id and lender key')
  if (typeof args.subject !== 'string' || !/^[A-Za-z0-9]{20,100}$/.test(args.subject)) throw new Error('challenge subject must be an address or a hex key')
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) throw new Error('challenge lifetime must be 1 minute to 24 hours')
  const nonce = args.nonce ?? randomHex(16)
  if (!isHex(nonce, 16)) throw new Error('challenge nonce must be 16 bytes')
  const base = { layer: args.layer, chain: args.chain, subject: args.subject, negotiation_id: args.negotiation_id, lender_pk: args.lender_pk, nonce, issued_at: now, expires_at: now + ttl }
  return { v: 1, kind: 'passbook-layer-challenge', ...base, text: challengeText(base) }
}

/**
 * Field checks a verifier runs before any signature: the challenge is well
 * formed, its text is exactly what its fields say, it is for this negotiation
 * and this lender, it has not expired, and it is the one the verifier issued.
 */
export function challengeProblems(c: ControlChallenge, subject: string, layer: LayerId, expect: VerifyExpectation): string[] {
  const problems: string[] = []
  if (!c || c.v !== 1 || c.kind !== 'passbook-layer-challenge') return ['CHALLENGE_MALFORMED']
  if (c.text !== challengeText(c)) problems.push('CHALLENGE_TEXT_MISMATCH')
  if (c.layer !== layer) problems.push('LAYER_MISMATCH')
  if (c.subject !== subject) problems.push('SUBJECT_MISMATCH')
  if (c.negotiation_id !== expect.negotiation_id) problems.push('NEGOTIATION_MISMATCH')
  if (c.lender_pk !== expect.lender_pk) problems.push('LENDER_MISMATCH')
  if (!Number.isSafeInteger(c.expires_at) || expect.now > c.expires_at) problems.push('CHALLENGE_EXPIRED')
  if (!Number.isSafeInteger(c.issued_at) || c.issued_at > expect.now + 300) problems.push('CHALLENGE_FROM_FUTURE')
  if (expect.issued && (expect.issued.nonce !== c.nonce || expect.issued.text !== c.text)) problems.push('CHALLENGE_NOT_ISSUED')
  return problems
}
