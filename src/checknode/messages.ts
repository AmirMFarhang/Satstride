// passbook-check/v1 messages: NIP-90's shape (announce -> request -> feedback
// -> result) on Passbook's own kinds, NIP-44 encrypted between the two parties.
// Like the loan negotiation, every message carries the negotiation id, a
// sequence number, the previous message's hash and its sender's signature, so
// the exchange is one auditable chain that the payer can hand to the other
// party (KEY) together with K.
//
//   REQUEST   payer -> operator   offer hash, consent receipt, nonce, rail, the
//                                 bundle encrypted to the scorer's enclave key
//                                 (external provider: to the operator key)
//   [FEEDBACK consent-required -> APPROVE]  external provider only: the borrower approves
//                                 the exact external provider contract version
//   FEEDBACK  operator -> payer   status 'payment-required' with the signed
//                                 commitment, the sealed result and the invoice;
//                                 or 'error' with a coded reason
//   RESULT    operator -> payer   status 'settled' with K (pay-then-deliver
//                                 needs it; on the HODL rail the payment
//                                 preimage already is K)
//   KEY       payer -> other party  the chain so far plus K

import { hashObject, isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { KIND } from '../market/kinds.js'

export const CHECK_MESSAGE_TYPES = ['REQUEST', 'FEEDBACK', 'APPROVE', 'RESULT', 'KEY'] as const
export type CheckMessageType = (typeof CHECK_MESSAGE_TYPES)[number]

/** APPROVE travels as a REQUEST-kind event: it is the payer's continuation of its request. */
export const CHECK_EVENT_KIND: Record<CheckMessageType, number> = { REQUEST: KIND.CHECK_REQUEST, FEEDBACK: KIND.CHECK_FEEDBACK, APPROVE: KIND.CHECK_REQUEST, RESULT: KIND.CHECK_RESULT, KEY: KIND.CHECK_KEY }

export interface CheckMessage {
  v: 1
  domain: 'passbook-check-v1'
  negotiation_id: Hex
  seq: number
  type: CheckMessageType
  from_pk: Hex
  to_pk: Hex
  prev_hash: Hex | null
  body: Record<string, unknown>
  sig: Hex
}

export function checkMessageHash(m: CheckMessage): Hex {
  return hashObject(m)
}

export function appendCheckMessage(chain: CheckMessage[], key: KeyPair, to: Hex, type: CheckMessageType, body: Record<string, unknown>, negotiationId?: Hex): CheckMessage {
  const prev = chain.at(-1)
  const id = prev?.negotiation_id ?? negotiationId
  if (!id) throw new Error('the first check message needs a negotiation id')
  const m = signObject({ v: 1 as const, domain: 'passbook-check-v1' as const, negotiation_id: id, seq: chain.length, type, from_pk: key.pubkey, to_pk: to, prev_hash: prev ? checkMessageHash(prev) : null, body }, key.secretKey)
  chain.push(m)
  return m
}

/** The order the protocol allows; anyone holding the chain can check it. */
const NEXT: Record<CheckMessageType | 'START', CheckMessageType[]> = { START: ['REQUEST'], REQUEST: ['FEEDBACK'], FEEDBACK: ['APPROVE', 'RESULT', 'KEY'], APPROVE: ['FEEDBACK'], RESULT: ['KEY'], KEY: [] }

export function checkChainProblems(chain: CheckMessage[], expect: { negotiation_id: Hex; payer_pk: Hex; operator_pk: Hex }): string[] {
  const problems: string[] = []
  if (!chain.length) return ['CHAIN_EMPTY']
  let last: CheckMessageType | 'START' = 'START'
  chain.forEach((m, i) => {
    const at = `#${i} ${m?.type}`
    if (!m || m.v !== 1 || m.domain !== 'passbook-check-v1' || !(CHECK_MESSAGE_TYPES as readonly string[]).includes(m.type)) { problems.push(`${at}: malformed`); return }
    if (m.negotiation_id !== expect.negotiation_id) problems.push(`${at}: wrong negotiation id`)
    if (m.seq !== i) problems.push(`${at}: wrong sequence`)
    if (m.prev_hash !== (i === 0 ? null : checkMessageHash(chain[i - 1]))) problems.push(`${at}: broken hash chain`)
    if (!NEXT[last].includes(m.type)) problems.push(`${at}: not allowed after ${last}`)
    const fromOperator = m.type === 'FEEDBACK' || m.type === 'RESULT'
    if (m.type !== 'KEY' && (m.from_pk !== (fromOperator ? expect.operator_pk : expect.payer_pk) || m.to_pk !== (fromOperator ? expect.payer_pk : expect.operator_pk))) problems.push(`${at}: wrong sender or recipient`)
    if (m.type === 'KEY' && m.from_pk !== expect.payer_pk) problems.push(`${at}: only the payer forwards the key`)
    if (!isHex(m.from_pk, 32) || !verifyObject(m, m.from_pk)) problems.push(`${at}: bad signature`)
    last = m.type
  })
  return problems
}
