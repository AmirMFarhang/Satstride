// Protocol payloads carried as signed Nostr events (NIP-01), with NIP-44
// encryption for everything between two parties.

import { finalizeEvent, nip44, verifyEvent, type Event } from 'nostr-tools'
import type { Hex, KeyPair } from '../core/crypto.js'
import type { Bps, Micro } from '../core/money.js'
import type { LoanTerms } from '../core/terms.js'
import { ENCRYPTED_KINDS, TOPIC } from './kinds.js'

export type { Event }

export interface OfferRequirements {
  income_evidence?: 'payer_signatures' | 'reconciled_tiers'
  reconciliation?: 'required' | 'optional'
  investigation?: 'required' | 'optional'
  affordability: boolean
  inflow_months: number
  /** required sum of verified inflows over the window, as bps of the repayment amount */
  inflow_multiple_bps: Bps
}

export interface OfferPayload {
  asset_id: string
  min: Micro
  max: Micro
  apr_bps: Bps
  term_blocks: number
  grace_blocks: number
  /** allowed LTV per ladder step, index 0 for a fresh key */
  ltv_ladder_bps: Bps[]
  requirements: OfferRequirements
  expires_height: number
  /**
   * Negotiated origination over Nostr (negotiate-nostr.ts): the structural part of the lender's signed policy
   * (never its APR floor or LTV cap). A borrower negotiates by sending this lender a p-tagged ASK (kind 7490).
   */
  negotiation?: import('./negotiate-nostr.js').NegotiationTerms
}

export interface RequestPayload {
  asset_id: string
  principal: Micro
  term_blocks: number
}

export interface ApplicationPayload {
  offer_id: string
  principal: Micro
  term_blocks: number
  /** the sandbox result, signed by the sandbox key (see sandbox/types.ts) */
  sandbox_result: unknown
  /** platform-signed sandbox declaration over { sandbox_pk, image_digest } */
  attestation: unknown
  /** txids of the inflows the borrower chose to disclose, subset of the sandbox proposal */
  disclosed_inflows: Hex[]
  /** Only approved items; hashes must occur in the signed lender result. */
  disclosure_items?: import('../sandbox/types.js').DisclosureItem[]
  /** for each disclosed txid, the payer's signature so the lender can re-verify it on its own */
  inflow_proofs?: { txid: Hex; amount: Micro; payer_pk: Hex; payer_sig: Hex }[]
  /** signed by the borrower: total outstanding Passbook debt across its keys */
  outstanding_statement: { outstanding_micro: Micro; sig: Hex }
  /** Borrower-carried signed history; verified locally by the lender. */
  passbook?: import('../registry/passbook-doc.js').PassbookDocument
  /** Negotiated origination: the signed, hash-chained negotiation ending in ACCEPT. */
  negotiation?: import('./negotiate.js').NegotiationMessage[]
  /** The borrower's consent receipt for this credit check; its hash goes into the term sheet. */
  consent?: import('../scorer/consent.js').ConsentReceipt
  /**
   * The deployment's scorer (scorer.provider compex): its evidence exactly as released, e.g. the
   * Compex DSSE envelope, the released artifact and its opening. It replaces the sandbox result and
   * attestation (both null then); the lender verifies it with its own compex-verify.
   */
  scorer_outcome?: import('../scorer/types.js').ScorerOutcome
  /** With scorer_outcome: the chain observer's signed terms of the scored bundle (loan request, asset, offer, lender requirements). */
  scorer_bundle_terms?: import('../scorer/bundle-terms.js').BundleTerms
  /**
   * Check market (docs/CHECK-MARKET.md): the hash of the KEY message the borrower forwarded to this lender
   * over Nostr (kind 7533) after paying a check node. The lender takes the check only from that message,
   * through verifyForwardedCheck; sandbox result and attestation are null then.
   */
  check_key?: Hex
  /** With check_key: the RGB contract id of the check receipt (UDA, hashes only) the node sent the borrower, as the borrower's node holds it. */
  check_receipt?: { contract_id: string }
}

export interface AcceptancePayload {
  offer_id: string
  terms: LoanTerms
  terms_hash: Hex
  /** Negotiated origination: the lender-signed term sheet; its hash is terms_hash. */
  termsheet?: import('./termsheet.js').TermSheet
  /** The lender's human approvals of that term sheet (two keys above the maker-checker threshold). */
  lender_approvals?: import('./approvals.js').Approval[]
  /** The lender's signed policy, whose hash its OFFER named: the borrower checks the approvals are complete under it before locking. */
  lender_policy?: import('./policy.js').LenderPolicy
  /**
   * The lender node's decision-log entries behind this acceptance (its sanctions screen of the application and its
   * approval of the term sheet), each signed by the node's gate key, so the borrower's screen can show them.
   */
  lender_decisions?: import('../governance/log.js').LogEntry[]
}

export interface SignRequestPayload {
  purpose: 'split' | 'release' | 'refund' | 'liquidate'
  loan_id: Hex
  psbt_base64: string
  terms_hash: Hex
  /** split: the borrower's witness invoice for the principal, so the lender can fund right after */
  disbursement_invoice?: string
  /** split, negotiated origination: the term sheet countersigned by the borrower, and the borrower's human approval */
  termsheet?: import('./termsheet.js').TermSheet
  borrower_approval?: import('./approvals.js').Approval
}

export type SignaturePayload = { loan_id: Hex; txid: Hex; signature: Hex; repayment_receipt?: import('../registry/passbook-doc.js').RgbRepaymentReceipt } | { loan_id: Hex; txid: Hex; refused: string }

export interface FundedPayload {
  loan_id: Hex
  disbursement_txid: Hex
  /** the lender's witness invoice for principal + fee, valid until after maturity */
  repayment_invoice?: string
  /** v2 only: platform-watched on-chain RGB invoice for explicit leaf C fallback. */
  fallback_repayment_invoice?: string
  iou_invoice?: string
}

export interface RepaidPayload {
  loan_id: Hex
  repayment_txid: Hex
  note_return_invoice?: string
}

export interface MarginCallPayload {
  loan_id: Hex
  ltv_bps: Bps
  cure_until_height: number
  oracle_quote: unknown
}

export function signEvent(key: KeyPair, kind: number, content: string, tags: string[][], createdAtMs: number): Event {
  return finalizeEvent({ kind, content, tags, created_at: Math.floor(createdAtMs / 1000) }, key.secretKey)
}

export function publicJson(key: KeyPair, kind: number, payload: unknown, tags: string[][], nowMs = Date.now()): Event {
  return signEvent(key, kind, JSON.stringify(payload), [['t', TOPIC], ...tags], nowMs)
}

export function encryptedJson(key: KeyPair, kind: number, payload: unknown, recipient: Hex, tags: string[][], nowMs = Date.now()): Event {
  const conversationKey = nip44.getConversationKey(key.secretKey, recipient)
  const content = nip44.encrypt(JSON.stringify(payload), conversationKey)
  return signEvent(key, kind, content, [['t', TOPIC], ['p', recipient], ...tags], nowMs)
}

/** Only the NIP-01 fields, so a cached verification flag on an in-process object cannot leak through. */
export function wireCopy(event: Event): Event {
  const { id, pubkey, created_at, kind, tags, content, sig } = event
  return { id, pubkey, created_at, kind, tags: tags.map((t) => [...t]), content, sig }
}

export function isAuthentic(event: Event): boolean {
  return verifyEvent(wireCopy(event))
}

export function readJson<T>(event: Event, key?: KeyPair): T {
  if (!isAuthentic(event)) throw new Error(`event ${event.id.slice(0, 8)} has an invalid signature`)
  if (!ENCRYPTED_KINDS.has(event.kind)) return JSON.parse(event.content) as T
  if (!key) throw new Error('encrypted event needs a key')
  const counterparty = event.pubkey === key.pubkey ? tag(event, 'p') : event.pubkey
  if (!counterparty) throw new Error('encrypted event has no counterparty')
  const conversationKey = nip44.getConversationKey(key.secretKey, counterparty)
  return JSON.parse(nip44.decrypt(event.content, conversationKey)) as T
}

export function tag(event: Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1]
}

/** NIP-44 to an arbitrary recipient outside an event (the sandbox bundle). */
export function encryptTo(sender: KeyPair, recipient: Hex, plaintext: string): string {
  return nip44.encrypt(plaintext, nip44.getConversationKey(sender.secretKey, recipient))
}

export function decryptFrom(me: KeyPair, sender: Hex, ciphertext: string): string {
  return nip44.decrypt(ciphertext, nip44.getConversationKey(me.secretKey, sender))
}

export function isOfferPayload(v: unknown): v is OfferPayload {
  const o = v as OfferPayload
  return (
    !!o &&
    typeof o.asset_id === 'string' &&
    Number.isInteger(o.min) &&
    Number.isInteger(o.max) &&
    o.min > 0 &&
    o.max >= o.min &&
    Number.isInteger(o.apr_bps) &&
    Number.isInteger(o.term_blocks) &&
    o.term_blocks > 0 &&
    Number.isInteger(o.grace_blocks) &&
    Array.isArray(o.ltv_ladder_bps) &&
    o.ltv_ladder_bps.length > 0 &&
    o.ltv_ladder_bps.every((b) => Number.isInteger(b) && b > 0 && b < 10_000) &&
    !!o.requirements &&
    typeof o.requirements.affordability === 'boolean' &&
    Number.isInteger(o.requirements.inflow_months) &&
    Number.isInteger(o.requirements.inflow_multiple_bps) &&
    Number.isInteger(o.expires_height)
  )
}


export interface AtomicRepaidPayload {
  loan_id: Hex
  payment_hash: Hex
  release_txid: Hex
  note_return_invoice?: string
}
