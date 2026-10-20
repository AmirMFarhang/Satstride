import { portableScorerChecks, type PortableScorerKey } from '../scorer/portable-evidence.js'
import { verifyEvent, type Event, type Filter } from 'nostr-tools'
import { hashObject, isHex, verifyObject, type Hex } from '../core/crypto.js'
import { KIND } from '../market/kinds.js'
import type { Bundle } from '../sandbox/types.js'
import { consentHash, MAX_CONSENT_SECONDS, uncoveredCategories, type ConsentReceipt } from '../scorer/consent.js'
import { selfSignatureValid } from '../scorer/descriptor.js'
import type { EncryptedCheckRequest, PassbookCheckOutputs, ScorerOutcome } from '../scorer/types.js'
import { checkChainProblems, checkMessageHash, type CheckMessage } from './messages.js'
import type { FeedbackBody, RequestBody } from './node.js'
import { offerHash, offerProblems, releaseHash, scorerDescriptor, type CheckOffer } from './offer.js'
import { keyHash, openResultPortable, type CheckCommitment, type SealedResult } from './seal-core.js'
import { encryptedEventWith, signObjectWith, type CheckSigner } from './signer.js'
import { packWire, WireReassembler, type WireChunk } from './wire.js'
import { billedKeyProblems, type KeySource } from './bill.js'

export const CHECK_RELAY_DOMAIN = 'passbook-check-relay-v1' as const

export class CheckRefused extends Error {
  constructor(readonly reason: string) {
    super(`check refused: ${reason}`)
    this.name = 'CheckRefused'
  }
}

/** What the borrower hands the lender: consent and the sealed bundle, nothing the lender can read. */
export interface BorrowerCheckPart {
  v: 1
  domain: typeof CHECK_RELAY_DOMAIN
  type: 'PART'
  negotiation_id: Hex
  borrower_pk: Hex
  lender_pk: Hex
  operator_pk: Hex
  offer_hash: Hex
  release_hash: Hex
  consent: ConsentReceipt
  check_request: EncryptedCheckRequest
  /** Optional: the borrower's RGB invoice for the check receipt (a UDA holding hashes only). */
  receipt_invoice?: string
  issued_at: number
  sig: Hex
}

export interface CheckApprovalRequest {
  v: 1
  domain: typeof CHECK_RELAY_DOMAIN
  type: 'APPROVAL_REQUEST'
  negotiation_id: Hex
  from_pk: Hex
  to_pk: Hex
  part_hash: Hex
  /** The lender's REQUEST and the operator's FEEDBACK consent-required, as signed. */
  chain: CheckMessage[]
  sig: Hex
}

export interface CheckApproval {
  v: 1
  domain: typeof CHECK_RELAY_DOMAIN
  type: 'APPROVAL'
  negotiation_id: Hex
  from_pk: Hex
  to_pk: Hex
  part_hash: Hex
  feedback_hash: Hex
  approval_hash: Hex
  /** Optional provider approval, owned by an installed plugin. */
  approve_sig: Hex
  sig: Hex
}

export interface CheckRelayRefusal {
  v: 1
  domain: typeof CHECK_RELAY_DOMAIN
  type: 'REFUSED'
  negotiation_id: Hex
  from_pk: Hex
  to_pk: Hex
  /** Coded; never bundle contents. */
  reason: string
  sig: Hex
}

export type CheckRelayMessage = BorrowerCheckPart | CheckApprovalRequest | CheckApproval | CheckRelayRefusal

export function partHash(part: BorrowerCheckPart): Hex {
  return hashObject(part)
}

/** The signer of a relay message: the borrower for PART, from_pk otherwise. */
export function relayMessageAuthentic(m: CheckRelayMessage): boolean {
  if (!m || m.v !== 1 || m.domain !== CHECK_RELAY_DOMAIN) return false
  const signer = m.type === 'PART' ? m.borrower_pk : (m as { from_pk?: Hex }).from_pk
  return isHex(signer, 32) && verifyObject(m, signer!)
}



/**
 * Why a lender-paid consent does not fit this offer, lender and negotiation. The lender (before paying), the
 * node (before running) and the borrower (on the forwarded chain) all run it.
 */
export function lenderPaidConsentProblems(c: ConsentReceipt, x: { offer: CheckOffer; lenderPk: Hex; negotiationId: Hex; borrowerPk?: Hex; now?: number }): string[] {
  if (!c || c.v !== 1 || c.domain !== 'passbook-consent-v1') return ['CONSENT_MALFORMED']
  const problems: string[] = []
  const d = scorerDescriptor(x.offer)
  if (!isHex(c.borrower_pk, 32) || !verifyObject(c, c.borrower_pk) || (x.borrowerPk && c.borrower_pk !== x.borrowerPk)) problems.push('CONSENT_SIGNATURE')
  if (c.operator_pk !== x.offer.operator_pk) problems.push('CONSENT_NAMES_ANOTHER_OPERATOR')
  if (c.payer !== 'lender') problems.push('CONSENT_OTHER_PAYER')
  if (c.release_hash !== releaseHash(x.offer.release)) problems.push('CONSENT_OTHER_RELEASE')
  if (c.lender_pk !== x.lenderPk) problems.push('CONSENT_OTHER_LENDER')
  if (c.purpose_id !== x.negotiationId) problems.push('CONSENT_OTHER_NEGOTIATION')
  if (c.scorer_id !== d.scorer_id || c.contract_hash !== d.contract_hash || c.scorer_pk !== d.enclave_pubkey) problems.push('CONSENT_WRONG_SCORER')
  if (c.retention !== 'none') problems.push('CONSENT_RETENTION')
  if (!Array.isArray(c.data_categories) || !c.data_categories.length) problems.push('CONSENT_CATEGORIES')
  if (!Number.isSafeInteger(c.issued_at) || !Number.isSafeInteger(c.expires_at) || c.expires_at <= c.issued_at || c.expires_at - c.issued_at > MAX_CONSENT_SECONDS) problems.push('CONSENT_WINDOW')
  else if (x.now !== undefined && (x.now < c.issued_at - 300 || x.now >= c.expires_at)) problems.push('CONSENT_EXPIRED')
  return problems
}

/** Why the lender must not act on this part; empty when it may send the REQUEST. */
export function borrowerCheckPartProblems(part: BorrowerCheckPart, x: { lenderPk: Hex; negotiationId: Hex; offer: CheckOffer; now: number }): string[] {
  if (!part || part.v !== 1 || part.domain !== CHECK_RELAY_DOMAIN || part.type !== 'PART' || !isHex(part.borrower_pk, 32)) return ['PART_MALFORMED']
  const problems: string[] = []
  if (!verifyObject(part, part.borrower_pk)) problems.push('PART_SIGNATURE')
  if (part.negotiation_id !== x.negotiationId) problems.push('PART_OTHER_NEGOTIATION')
  if (part.lender_pk !== x.lenderPk) problems.push('PART_OTHER_LENDER')
  if (part.operator_pk !== x.offer.operator_pk || part.offer_hash !== offerHash(x.offer)) problems.push('PART_OTHER_OFFER')
  if (part.release_hash !== releaseHash(x.offer.release)) problems.push('PART_OTHER_RELEASE')
  if (!x.offer.payer_modes.includes('lender')) problems.push('OFFER_NOT_LENDER_PAID')
  problems.push(...lenderPaidConsentProblems(part.consent, { offer: x.offer, lenderPk: x.lenderPk, negotiationId: x.negotiationId, borrowerPk: part.borrower_pk, now: x.now }))
  const r = part.check_request
  const to = x.offer.scorer.enclave_pubkey
  if (!r || r.v !== 1 || r.kind !== 'passbook-check-request' || r.sender_pk !== part.borrower_pk || r.enclave_pubkey !== to || r.contract_hash !== x.offer.release.scoring_contract_hash || r.consent_hash !== consentHash(part.consent)) problems.push('PART_REQUEST_MISMATCH')
  if (typeof r?.ciphertext !== 'string' || r.ciphertext.length > Math.ceil(x.offer.max_bundle_bytes * 1.4)) problems.push('BUNDLE_TOO_LARGE')
  return [...new Set(problems)]
}

/**
 * Step 1 on the phone, after the consent screen: sign the consent and seal the bundle to the operator
 * (external provider) or the scorer's enclave key. Throws CheckRefused before anything leaves the device.
 */
export async function prepareBorrowerCheckPart(o: { signer: CheckSigner; offer: CheckOffer; lenderPk: Hex; negotiationId: Hex; bundle: Bundle; dataCategories: string[]; now: number; consentTtlSeconds?: number; receiptInvoice?: string }): Promise<BorrowerCheckPart> {
  const offerIssues = offerProblems(o.offer, o.now)
  if (offerIssues.length) throw new CheckRefused(offerIssues.join(','))
  if (!o.offer.payer_modes.includes('lender')) throw new CheckRefused('OFFER_NOT_LENDER_PAID')
  if (o.bundle.borrower_pk !== o.signer.pubkey) throw new CheckRefused('BUNDLE_NOT_THIS_BORROWER')
  const d = scorerDescriptor(o.offer)
  if (!(d.enclave_pubkey && selfSignatureValid(d))) throw new CheckRefused('OFFER_SCORER_KEY')
  const release_hash = releaseHash(o.offer.release)
  const consent = await signObjectWith(o.signer, {
    v: 1 as const, domain: 'passbook-consent-v1' as const, borrower_pk: o.signer.pubkey, retention: 'none' as const,
    purpose: `credit assessment for negotiation ${o.negotiationId.slice(0, 16)} by check node ${o.offer.operator_pk.slice(0, 16)}, paid by the lender`,
    purpose_id: o.negotiationId, scorer_id: d.scorer_id, ...(d.enclave_pubkey ? { scorer_pk: d.enclave_pubkey } : {}),
    contract_hash: d.contract_hash, operator_pk: o.offer.operator_pk, lender_pk: o.lenderPk, payer: 'lender' as const, release_hash,
    data_categories: [...new Set(o.dataCategories)], issued_at: o.now, expires_at: o.now + (o.consentTtlSeconds ?? 3600),
  }) as ConsentReceipt
  const uncovered = uncoveredCategories(consent, o.bundle, [])
  if (uncovered.length) throw new CheckRefused(`CONSENT_CATEGORIES_INCOMPLETE:${uncovered.join(',')}`)
  const to = d.enclave_pubkey!
  const check_request: EncryptedCheckRequest = { v: 1, kind: 'passbook-check-request', sender_pk: o.signer.pubkey, enclave_pubkey: to, contract_hash: d.contract_hash, consent_hash: consentHash(consent), ciphertext: await o.signer.nip44Encrypt(to, JSON.stringify(o.bundle)) }
  if (check_request.ciphertext.length > Math.ceil(o.offer.max_bundle_bytes * 1.4)) throw new CheckRefused('BUNDLE_TOO_LARGE')
  return signObjectWith(o.signer, {
    v: 1 as const, domain: CHECK_RELAY_DOMAIN, type: 'PART' as const, negotiation_id: o.negotiationId, borrower_pk: o.signer.pubkey, lender_pk: o.lenderPk,
    operator_pk: o.offer.operator_pk, offer_hash: offerHash(o.offer), release_hash, consent, check_request,
    ...(o.receiptInvoice ? { receipt_invoice: o.receiptInvoice } : {}), issued_at: o.now,
  })
}

/** Whether a REQUEST in a chain carries exactly this part (the lender cannot swap the consent or the bundle). */
function requestCarriesPart(request: CheckMessage | undefined, part: BorrowerCheckPart): boolean {
  const b = request?.body as unknown as RequestBody | undefined
  return request?.type === 'REQUEST' && request.from_pk === part.lender_pk && request.to_pk === part.operator_pk && !!b && b.payer === 'lender' && b.offer_hash === part.offer_hash &&
    hashObject(b.consent) === hashObject(part.consent) && hashObject(b.check_request) === hashObject(part.check_request)
}

/**
 * Step 2 on the phone (external provider): the operator's draft arrives through the lender. Approve the exact contract
 * version only when it binds this bundle, borrower, lender, negotiation, loan, workload and QVAC model.
 */
export async function answerApprovalRequest(_o: { signer: CheckSigner; part: BorrowerCheckPart; bundle: Bundle; offer: CheckOffer; request: CheckApprovalRequest; allowStandInModel?: boolean }): Promise<CheckApproval> {
 throw new CheckRefused('EXTERNAL_APPROVAL_PLUGIN_REQUIRED')
}

export interface CheckTick { id: string; ok: boolean; detail: string }

/** What the phone shows after opening the check the lender paid for. `ok` false is a failure screen, never a result. */
export interface BorrowerCheckView {
  ok: boolean
  ticks: CheckTick[]
  outputs: PassbookCheckOutputs | null
  operator_pk: Hex
  release_hash: Hex
  rail_label: string | null
  key_source: KeySource | null
  commitment: Hex | null
  execution_id: string | null
  /** checkMessageHash of the KEY the lender forwarded: the application names it (ApplicationPayload.check_key) with part.consent. */
  key_message_hash: Hex | null
  /** The opened scorer outcome (DSSE envelope and released text), for checking the term sheet's evidence digest and scored loan (awaitAcceptance's `scored`). Act on it only when `ok`. */
  outcome: ScorerOutcome | null
}

/**
 * Step 3 on the phone: open the KEY the lender forwarded and check everything without trusting the lender or
 * the operator. The external provider evidence root and agent claims are external verifier's, run at the lender.
 */
export async function openForwardedCheck(o: { key: CheckMessage; part: BorrowerCheckPart; bundle: Bundle; offer: CheckOffer; evidenceKeys: PortableScorerKey[]; allowDevelopment?: boolean; now: number }): Promise<BorrowerCheckView> {
  const ticks: CheckTick[] = []
  const tick = (id: string, ok: boolean, detail: string) => ticks.push({ id, ok, detail })
  const view = (extra: Partial<BorrowerCheckView> = {}): BorrowerCheckView => ({ ok: false, ticks, outputs: null, operator_pk: o.offer.operator_pk, release_hash: releaseHash(o.offer.release), rail_label: null, key_source: null, commitment: null, execution_id: null, outcome: null, key_message_hash: o.key ? checkMessageHash(o.key) : null, ...extra })
  const p = o.part
  const b = o.key?.body as unknown as { offer?: CheckOffer; chain?: CheckMessage[]; key?: Hex; key_source?: BorrowerCheckView['key_source']; rail_label?: string } | undefined
  const fromLender = o.key?.type === 'KEY' && o.key.from_pk === p.lender_pk && o.key.to_pk === p.borrower_pk && o.key.negotiation_id === p.negotiation_id
  tick('key-message', fromLender && !!b?.offer && Array.isArray(b.chain), fromLender ? 'the lender forwarded the operator chain and K' : 'not a KEY from this lender for this negotiation')
  if (!fromLender || !b?.offer || !Array.isArray(b.chain)) return view()
  tick('offer', offerHash(b.offer) === p.offer_hash && hashObject(b.offer) === hashObject(o.offer), 'the check ran on the offer this borrower consented to')
  const chain = [...b.chain, o.key]
  const chainIssues = checkChainProblems(chain, { negotiation_id: p.negotiation_id, payer_pk: p.lender_pk, operator_pk: p.operator_pk })
  tick('message-chain', chainIssues.length === 0, chainIssues.length ? chainIssues.join('; ') : `${chain.length} messages, hash-chained and signed; the lender paid`)
  tick('request-is-this-part', requestCarriesPart(chain[0], p), 'the lender\'s request carried exactly this consent and this sealed bundle')
  // 'payment-required' when the lender paid up front; 'billed' when the check was billed to the lender at close.
  const fb = chain.find((m) => m.type === 'FEEDBACK' && ['payment-required', 'billed'].includes((m.body as { status?: string }).status ?? ''))?.body as unknown as (FeedbackBody & { status: 'payment-required' | 'billed' }) | undefined
  if (!fb) { tick('commitment', false, 'no commitment in the chain'); return view() }
  const c: CheckCommitment = fb.commitment
  const sealed: SealedResult = fb.sealed
  tick('consent-in-commitment', hashObject(c?.consent) === hashObject(p.consent) && c?.consent_hash === consentHash(p.consent), 'the operator signed this borrower\'s consent into the commitment')
  const opened = openResultPortable(c, sealed, b.key ?? '', { operator_pk: p.operator_pk, negotiation_id: p.negotiation_id, borrower_pk: p.borrower_pk, lender_pk: p.lender_pk })
  tick('commitment', opened.problems.length === 0 && !!opened.plaintext, opened.problems.length ? opened.problems.join(',') : 'sha256(K) is the committed key hash; K opens the sealed result; its hash is the operator-signed commitment')
  const hodl = b.key_source === 'lightning-preimage'
  if (b.key_source === 'operator-billed') {
    const billIssues = billedKeyProblems(chain, c, b.key ?? '', { offer: o.offer, lenderPk: p.lender_pk, borrowerPk: p.borrower_pk })
    tick('key-binding', billIssues.length === 0, billIssues.length ? billIssues.join(',') : 'billed to the lender at close, not paid up front: K came in the operator\'s RESULT with a signed bill for this check')
  } else tick('key-binding', hodl ? c.payment.rail === 'rgb-ln-hodl' && isHex(b.key, 32) && c.payment.payment_hash === keyHash(b.key!) : b.key_source === 'operator-result' && c.payment.rail === 'rgb-ln-pay-then-deliver', hodl ? 'K is the preimage of the HODL invoice the lender paid' : 'FALLBACK: K came from the operator after the lender paid (pay, then deliver)')
  const base = { rail_label: typeof b.rail_label === 'string' ? b.rail_label : null, key_source: b.key_source ?? null, commitment: c.commitment ?? null }
  if (!opened.plaintext) return view(base)
  const outcome = opened.plaintext.outcome
  tick('scorer-is-offered-release', outcome?.descriptor?.code_measurement === o.offer.release.image_digest && outcome.descriptor.contract_hash === o.offer.release.scoring_contract_hash, 'the evidence comes from the release this borrower consented to')
  const evidence = portableScorerChecks(outcome, { borrower_pk: p.borrower_pk, lender_pk: p.lender_pk, negotiation_id: p.negotiation_id, bundle: o.bundle, image_digest: o.offer.release.image_digest, descriptor: scorerDescriptor(o.offer), operator_pk: o.offer.operator_pk, consent_hash: consentHash(p.consent), evidenceKeys: o.evidenceKeys, allowDevelopment: o.allowDevelopment })
  for (const t of evidence.ticks) ticks.push({ ...t, id: `evidence:${t.id}` })
  const execution_id = outcome.kind === 'external-evidence' ? outcome.reference ?? null : null
  return view({ ...base, ok: ticks.every((t) => t.ok), outputs: evidence.outputs, execution_id, outcome })
}

// ---- the phone's driver over a Nostr transport ----

/** The relay as the phone sees it: P1's transport shape (src/market/negotiate-nostr.ts). */
export interface CheckTransport {
  publish(event: Event): Promise<void>
  subscribe(filter: Filter, onEvent: (e: Event) => void): () => void
}

/** A relay message (or a KEY) as a NIP-44 event on kind 7533 to `to`, tagged with the negotiation id and any extra tags (a network label). */
export function relayEvent(signer: CheckSigner, payload: CheckRelayMessage | CheckMessage | WireChunk, to: Hex, negotiationId: Hex, extraTags: string[][] = []): Promise<Event> {
  return encryptedEventWith(signer, KIND.CHECK_KEY, payload, to, [['n', negotiationId], ...extraTags])
}

/** The events for one relay message: one when small, else hash-checked chunks under the public relays' size limit (wire.ts). Publish them all. */
export async function relayEvents(signer: CheckSigner, payload: CheckRelayMessage | CheckMessage, to: Hex, negotiationId: Hex, extraTags: string[][] = []): Promise<Event[]> {
  const out: Event[] = []
  for (const p of packWire(payload)) out.push(await relayEvent(signer, p as CheckRelayMessage | WireChunk, to, negotiationId, extraTags))
  return out
}

/** Decrypts a kind-7533 event addressed to this signer; throws on a bad signature or another recipient. */
export async function readRelayEvent(signer: CheckSigner, event: Event): Promise<unknown> {
  if (event.kind !== KIND.CHECK_KEY || !verifyEvent({ ...event })) throw new Error('RELAY_EVENT_INVALID')
  const to = event.tags.find((t) => t[0] === 'p')?.[1]
  if (to !== signer.pubkey) throw new Error('RELAY_EVENT_NOT_FOR_ME')
  return JSON.parse(await signer.nip44Decrypt(event.pubkey, event.content))
}

export type BorrowerCheckStage = 'part-sent' | 'approval-requested' | 'approved' | 'key-received' | 'opened' | 'refused'

/**
 * The whole borrower half over the relay: send the part (unless P1's negotiation carried it), answer the
 * lender's approval request, wait for K and open it. The phone shows the consent screen before calling this.
 */
export async function runBorrowerCheck(o: { transport: CheckTransport; signer: CheckSigner; offer: CheckOffer; lenderPk: Hex; negotiationId: Hex; bundle: Bundle; dataCategories: string[]; evidenceKeys: PortableScorerKey[]; part?: BorrowerCheckPart; sendPart?: boolean; allowDevelopment?: boolean; now?: () => number; timeoutMs?: number; onStage?: (stage: BorrowerCheckStage, detail: string) => void; /** Extra tags on every event this sends (a public network's labels). */ tags?: string[][] }): Promise<{ part: BorrowerCheckPart; view: BorrowerCheckView }> {
  const send = async (payload: CheckRelayMessage) => { for (const e of await relayEvents(o.signer, payload, o.lenderPk, o.negotiationId, o.tags ?? [])) await o.transport.publish(e) }
  // Large messages from the lender (the approval request, the KEY chain) arrive as hash-checked chunks.
  const assembler = new WireReassembler()
  const now = o.now ?? (() => Math.floor(Date.now() / 1000))
  const stage = (s: BorrowerCheckStage, d: string) => o.onStage?.(s, d)
  const inbox: unknown[] = []
  const seen = new Set<string>()
  let wake: (() => void) | null = null
  const unsubscribe = o.transport.subscribe({ kinds: [KIND.CHECK_KEY], authors: [o.lenderPk], '#p': [o.signer.pubkey], since: now() - 600 }, (e) => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    readRelayEvent(o.signer, e).then((raw) => {
      const whole = assembler.feed(e.pubkey, raw)
      if (!whole) return
      const payload = whole.payload
      if ((payload as { negotiation_id?: unknown })?.negotiation_id !== o.negotiationId) return
      inbox.push(payload)
      wake?.()
    }).catch(() => undefined)
  })
  const deadline = Date.now() + (o.timeoutMs ?? 900_000)
  const next = async (): Promise<unknown> => {
    for (;;) {
      const m = inbox.shift()
      if (m !== undefined) return m
      const left = deadline - Date.now()
      if (left <= 0) throw new CheckRefused('TIMEOUT: no answer from the lender')
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.min(left, 1000)); wake = () => { clearTimeout(t); resolve() } })
      wake = null
    }
  }
  const refuse = async (reason: string) => {
    const r = await signObjectWith(o.signer, { v: 1 as const, domain: CHECK_RELAY_DOMAIN, type: 'REFUSED' as const, negotiation_id: o.negotiationId, from_pk: o.signer.pubkey, to_pk: o.lenderPk, reason: reason.slice(0, 200) })
    await send(r).catch(() => undefined)
  }
  try {
    const part = o.part ?? await prepareBorrowerCheckPart({ signer: o.signer, offer: o.offer, lenderPk: o.lenderPk, negotiationId: o.negotiationId, bundle: o.bundle, dataCategories: o.dataCategories, now: now() })
    if (o.sendPart !== false) {
      await send(part)
      stage('part-sent', `consent and sealed bundle sent to the lender for check node ${o.offer.operator_pk.slice(0, 12)}…`)
    }
    for (;;) {
      const m = await next() as CheckRelayMessage | CheckMessage
      if ((m as CheckRelayMessage).domain === CHECK_RELAY_DOMAIN) {
        const r = m as CheckRelayMessage
        if (!relayMessageAuthentic(r) || (r.type !== 'PART' && r.from_pk !== o.lenderPk)) continue
        if (r.type === 'REFUSED') { stage('refused', r.reason); throw new CheckRefused(`lender: ${r.reason}`) }
        if (r.type !== 'APPROVAL_REQUEST') continue
        stage('approval-requested', 'external provider approval requested')
        let approval: CheckApproval
        try {
          approval = await answerApprovalRequest({ signer: o.signer, part, bundle: o.bundle, offer: o.offer, request: r, allowStandInModel: o.allowDevelopment })
        } catch (err) {
          await refuse(err instanceof CheckRefused ? err.reason : 'APPROVAL_FAILED')
          throw err
        }
        await send(approval)
        stage('approved', 'external provider approval submitted')
        continue
      }
      const key = m as CheckMessage
      if (key?.type !== 'KEY' || key.domain !== 'passbook-check-v1' || !verifyObject(key, o.lenderPk)) continue
      stage('key-received', 'the lender paid the check node and forwarded K')
      const view = await openForwardedCheck({ key, part, bundle: o.bundle, offer: o.offer, evidenceKeys: o.evidenceKeys, allowDevelopment: o.allowDevelopment, now: now() })
      stage('opened', view.ok ? `${view.outputs?.recommendation} (${view.outputs?.income_band})` : `does not verify: ${view.ticks.filter((t) => !t.ok).map((t) => t.id).join(', ')}`)
      return { part, view }
    }
  } finally {
    unsubscribe()
  }
}
