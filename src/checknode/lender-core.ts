import { portableScorerChecks, type PortableScorerKey } from '../scorer/portable-evidence.js'
import { verifyEvent, type Event } from 'nostr-tools'
import { hashObject, randomHex, type Hex } from '../core/crypto.js'
import { KIND } from '../market/kinds.js'
import { consentHash } from '../scorer/consent.js'
import type { PassbookCheckOutputs, ScoredLoan, ScorerOutcome } from '../scorer/types.js'
import { BILL_AT_CLOSE, BILL_RAIL_LABEL, billHash, billInChain, billedKeyProblems, type BilledCheckReceipt } from './bill.js'
import { borrowerCheckPartProblems, CHECK_RELAY_DOMAIN, CheckRefused, lenderPaidConsentProblems, type BorrowerCheckPart, type CheckRelayMessage, type CheckTick, type CheckTransport } from './borrower-check.js'
import { checkChainProblems, checkMessageHash, type CheckMessage, type CheckMessageType } from './messages.js'
import type { FeedbackBody, RequestBody, ResultBody } from './node.js'
import { offerHash, offerProblems, releaseHash, scorerDescriptor, type CheckOffer } from './offer.js'
import { openResultPortable, type CheckCommitment, type SealedResult } from './seal-core.js'
import { encryptedEventWith, signObjectWith, type CheckSigner } from './signer.js'
import { packWire, WireReassembler } from './wire.js'

export { CheckRefused }

// ---- the relay as the phone's check bus ----

/** The phone's check-market bus: NIP-44 events to and from one key, through its CheckTransport. */
export interface PortableCheckBus {
  readonly pubkey: Hex
  send(kind: number, payload: unknown, to: Hex, tags?: string[][]): Promise<void>
  receive<T>(kind: number, from: Hex | null, o?: { timeoutMs?: number; match?: (payload: T) => boolean }): Promise<T>
}

const LISTENED: number[] = [KIND.CHECK_REQUEST, KIND.CHECK_FEEDBACK, KIND.CHECK_RESULT, KIND.CHECK_KEY]

/** A PortableCheckBus over the phone's relay connection and signer. Events are decrypted once and handed out once. */
export function portableBus(transport: CheckTransport, signer: CheckSigner, opts: { since?: number; tags?: string[][] } = {}): PortableCheckBus & { close(): void } {
  const inbox: { kind: number; from: Hex; payload: unknown }[] = []
  // Large messages arrive as hash-checked chunks (wire.ts); only whole messages reach the inbox.
  const assembler = new WireReassembler()
  const seen = new Set<string>()
  const waiters = new Set<() => void>()
  const unsubscribe = transport.subscribe({ kinds: LISTENED, '#p': [signer.pubkey], since: opts.since ?? Math.floor(Date.now() / 1000) - 600 }, (e: Event) => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    if (!LISTENED.includes(e.kind) || e.tags.find((t) => t[0] === 'p')?.[1] !== signer.pubkey || !verifyEvent({ ...e })) return
    signer.nip44Decrypt(e.pubkey, e.content).then((text) => {
      const whole = assembler.feed(e.pubkey, JSON.parse(text))
      if (!whole) return
      inbox.push({ kind: e.kind, from: e.pubkey, payload: whole.payload })
      for (const w of [...waiters]) w()
    }).catch(() => undefined)
  })
  return {
    pubkey: signer.pubkey,
    async send(kind, payload, to, tags = []) {
      // Under the public relays' size limit: a large message goes as signed chunks (wire.ts). opts.tags label every event.
      for (const p of packWire(payload)) await transport.publish(await encryptedEventWith(signer, kind, p, to, [...tags, ...(opts.tags ?? [])]))
    },
    async receive<T>(kind: number, from: Hex | null, o: { timeoutMs?: number; match?: (payload: T) => boolean } = {}): Promise<T> {
      const deadline = Date.now() + (o.timeoutMs ?? 60_000)
      for (;;) {
        const i = inbox.findIndex((x) => x.kind === kind && (!from || x.from === from) && (!o.match || o.match(x.payload as T)))
        if (i >= 0) return inbox.splice(i, 1)[0].payload as T
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`timed out waiting for kind ${kind} from ${from?.slice(0, 8) ?? 'anyone'}`)
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(t); waiters.delete(done); resolve() }
          const t = setTimeout(done, Math.min(left, 1000))
          waiters.add(done)
        })
      }
    },
    close: unsubscribe,
  }
}

/** appendCheckMessage through a signer: the phone never hands the protocol its secret key. */
async function appendWith(chain: CheckMessage[], signer: CheckSigner, to: Hex, type: CheckMessageType, body: Record<string, unknown>, negotiationId?: Hex): Promise<CheckMessage> {
  const prev = chain.at(-1)
  const id = prev?.negotiation_id ?? negotiationId
  if (!id) throw new Error('the first check message needs a negotiation id')
  const m = await signObjectWith(signer, { v: 1 as const, domain: 'passbook-check-v1' as const, negotiation_id: id, seq: chain.length, type, from_pk: signer.pubkey, to_pk: to, prev_hash: prev ? checkMessageHash(prev) : null, body })
  chain.push(m)
  return m
}

/** The borrower's PART on kind 7533 (when the negotiation does not carry it). */
export async function receivePartPortable(bus: PortableCheckBus, borrowerPk: Hex, negotiationId: Hex, timeoutMs = 300_000): Promise<BorrowerCheckPart> {
  return bus.receive<BorrowerCheckPart>(KIND.CHECK_KEY, borrowerPk, { timeoutMs, match: (m) => m?.domain === CHECK_RELAY_DOMAIN && m.type === 'PART' && m.negotiation_id === negotiationId && m.borrower_pk === borrowerPk })
}

/** The lender's own check-node rules, as far as the phone can check them (the release is pinned by hash). */
export interface PortableCheckRules {
  accepted_check_operators?: Hex[]
  accepted_releases?: Hex[]
  max_price?: { asset_id: string; amount: number }
}

/** Why this lender must not ask this node for a billed check; empty when it may. */
export function billedOfferProblems(offer: CheckOffer, rules: PortableCheckRules, loan: ScoredLoan, now: number): string[] {
  const problems = offerProblems(offer, now)
  if (problems.length) return problems
  if (!offer.rails.includes(BILL_AT_CLOSE)) problems.push('BILL_NOT_OFFERED')
  if (!offer.payer_modes.includes('lender')) problems.push('PAYER_MODE')
  if (rules.accepted_check_operators && !rules.accepted_check_operators.includes(offer.operator_pk)) problems.push('OPERATOR_NOT_ACCEPTED')
  if (rules.accepted_releases && !rules.accepted_releases.includes(releaseHash(offer.release))) problems.push('RELEASE_NOT_ACCEPTED')
  if (rules.max_price && (rules.max_price.asset_id !== offer.price.asset_id || offer.price.amount > rules.max_price.amount)) problems.push(`PRICE_ABOVE_MAX (${offer.price.amount} > ${rules.max_price.amount})`)
  // The bill is added to the platform fee for this loan, in the loan's asset.
  if (offer.price.asset_id !== loan.asset_id) problems.push('BILL_ASSET_NOT_THE_LOAN_ASSET')
  return problems
}

export interface LenderBilledCheckOptions {
  bus: PortableCheckBus
  signer: CheckSigner
  part: BorrowerCheckPart
  offer: CheckOffer
  rules: PortableCheckRules
  /** The loan this lender agreed: the draft and the outputs (v2) must name exactly it. */
  loan: ScoredLoan
  /**
   * The lender's required check ids (its policy's required_checks and requirements), as the laptop review uses them:
   * each must be present and passing in the outputs; `reconcile` is external provider's history_reconciliation, and `investigation`
   * counts only on the pinned QVAC model and when the run did not fail safe to ESCALATE.
   */
  requiredChecks?: string[]
  evidenceKeys: PortableScorerKey[]
  /** external provider development keys and the LOCAL_STANDIN model: demo only, labelled. */
  allowDevelopment?: boolean
  now?: number
  timeoutMs?: number
  approvalTimeoutMs?: number
  onStage?: (stage: 'request-sent' | 'approval-relayed' | 'approved' | 'billed' | 'key-forwarded' | 'verified', detail: string) => void
}

export interface LenderBilledCheckResult {
  /** Every check below passed. Only then may the lender underwrite (and only a QUALIFY). */
  ok: boolean
  ticks: CheckTick[]
  /** What this device did not check, said plainly. */
  not_run: string[]
  outputs: PassbookCheckOutputs | null
  outcome: ScorerOutcome | null
  /** The KEY already forwarded to the borrower; its application names checkMessageHash(key) as check_key. */
  key: CheckMessage
  bill: BilledCheckReceipt
  bill_hash: Hex
  consent_hash: Hex
  commitment: Hex
  execution_id: string | null
  rail_label: string
}

export async function runLenderCheckBilled(o: LenderBilledCheckOptions): Promise<LenderBilledCheckResult> {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const lender = o.signer.pubkey
  const part = o.part
  const neg = part?.negotiation_id
  const offer = o.offer
  const timeoutMs = o.timeoutMs ?? 600_000
  const stage = (s: Parameters<NonNullable<LenderBilledCheckOptions['onStage']>>[0], d: string) => o.onStage?.(s, d)
  const tell = (payload: CheckRelayMessage | CheckMessage) => o.bus.send(KIND.CHECK_KEY, payload, part.borrower_pk, [['n', neg]])
  const refuse = async (reason: string): Promise<never> => {
    const r = await signObjectWith(o.signer, { v: 1 as const, domain: CHECK_RELAY_DOMAIN, type: 'REFUSED' as const, negotiation_id: neg, from_pk: lender, to_pk: part.borrower_pk, reason: reason.slice(0, 200) })
    await tell(r).catch(() => undefined)
    throw new CheckRefused(reason)
  }

  // 1. The offer against this lender's rules, and the borrower's part.
  const offerIssues = billedOfferProblems(offer, o.rules, o.loan, now)
  if (offerIssues.length) return refuse(offerIssues.join(','))
  const partIssues = borrowerCheckPartProblems(part, { lenderPk: lender, negotiationId: neg, offer, now })
  if (partIssues.length) return refuse(partIssues.join(','))

  // 2. REQUEST on bill-at-close, carrying the part unchanged.
  const chain: CheckMessage[] = []
  const body: RequestBody = { offer_hash: offerHash(offer), request_nonce: randomHex(32), consent: part.consent, check_request: part.check_request, rail: BILL_AT_CLOSE, pay_with: offer.price.asset_id, payer: 'lender', ...(part.receipt_invoice ? { receipt_invoice: part.receipt_invoice } : {}) }
  const request = await appendWith(chain, o.signer, offer.operator_pk, 'REQUEST', body as unknown as Record<string, unknown>, neg)
  const ours = (m: CheckMessage) => m?.negotiation_id === neg && m.prev_hash === checkMessageHash(chain.at(-1)!)
  await o.bus.send(KIND.CHECK_REQUEST, request, offer.operator_pk, [['n', neg]])
  stage('request-sent', `credit check requested from ${offer.operator_pk.slice(0, 12)}…, billed at close, not paid up front`)
  let fb = await o.bus.receive<CheckMessage>(KIND.CHECK_FEEDBACK, offer.operator_pk, { timeoutMs, match: ours }).catch(() => null)
  if (!fb) return refuse('OPERATOR_TIMEOUT')
  chain.push(fb)

  if ((fb.body as unknown as FeedbackBody).status === 'consent-required') return refuse('EXTERNAL_APPROVAL_PLUGIN_REQUIRED')
  const feedback = fb.body as unknown as FeedbackBody
  if (feedback.status === 'error') return refuse(`operator: ${feedback.reason}`)
  // This lender has no Lightning: a node asking to be paid up front is not the rail it asked for.
  if (feedback.status !== 'billed') return refuse('NOT_BILLED')
  const result = await o.bus.receive<CheckMessage>(KIND.CHECK_RESULT, offer.operator_pk, { timeoutMs: Math.min(timeoutMs, 120_000), match: ours }).catch(() => null)
  if (!result) return refuse('OPERATOR_SENT_NO_KEY')
  chain.push(result)
  const r = result.body as unknown as ResultBody
  if (r?.status !== 'billed' || !r.bill) return refuse('NOT_BILLED')
  stage('billed', `billed at close, not paid up front: ${r.bill.fee.amount} of ${r.bill.fee.asset_id.slice(0, 16)}… due when the loan closes`)

  // 4. Forward K to the borrower at once: its own result is never withheld.
  const keyBody = { offer, chain: [...chain], key: r.key, key_source: 'operator-billed' as const, rail_label: BILL_RAIL_LABEL }
  const keyMsg = await appendWith(chain, o.signer, part.borrower_pk, 'KEY', keyBody as unknown as Record<string, unknown>)
  await tell(keyMsg)
  stage('key-forwarded', 'K forwarded to the borrower')

  // 5. Verify everything this device can.
  const ticks: CheckTick[] = []
  const tick = (id: string, ok: boolean, detail: string) => ticks.push({ id, ok, detail })
  const chainIssues = checkChainProblems(chain, { negotiation_id: neg, payer_pk: lender, operator_pk: offer.operator_pk })
  tick('message-chain', chainIssues.length === 0, chainIssues.length ? chainIssues.join('; ') : `${chain.length} messages, hash-chained and signed`)
  const c: CheckCommitment = feedback.commitment
  const sealed: SealedResult = feedback.sealed
  const consentIssues = lenderPaidConsentProblems(c?.consent, { offer, lenderPk: lender, negotiationId: neg, borrowerPk: part.borrower_pk, now })
  tick('consent', consentIssues.length === 0 && hashObject(c.consent) === hashObject(part.consent), consentIssues.length ? consentIssues.join(',') : 'the operator signed in the borrower\'s consent: this operator, this release, paid by this lender')
  const opened = openResultPortable(c, sealed, r.key, { operator_pk: offer.operator_pk, negotiation_id: neg, borrower_pk: part.borrower_pk, lender_pk: lender })
  tick('commitment', opened.problems.length === 0 && !!opened.plaintext, opened.problems.length ? opened.problems.join(',') : 'sha256(K) is the committed key hash; K opens the sealed result; its hash is the operator-signed commitment')
  const billIssues = billedKeyProblems(chain, c, r.key, { offer, lenderPk: lender, borrowerPk: part.borrower_pk, now })
  tick('bill', billIssues.length === 0, billIssues.length ? billIssues.join(',') : `${BILL_RAIL_LABEL}: the operator's signed bill names this check, this lender and the offered price`)
  const bill = billInChain(chain) ?? r.bill
  const base = { not_run: ['hardware isolation and full local model materials are not verified by this phone; the approved scorer host is trusted'], key: keyMsg, bill, bill_hash: billHash(bill), consent_hash: consentHash(part.consent), commitment: c.commitment, rail_label: BILL_RAIL_LABEL }
  if (!opened.plaintext) return { ok: false, ticks, outputs: null, outcome: null, execution_id: null, ...base }
  const outcome = opened.plaintext.outcome
  tick('scorer-is-offered-release', outcome?.descriptor?.code_measurement === offer.release.image_digest && outcome.descriptor.contract_hash === offer.release.scoring_contract_hash, 'the evidence comes from the release the offer named')
  const evidence = portableScorerChecks(outcome, { borrower_pk: part.borrower_pk, lender_pk: lender, negotiation_id: neg, loan: o.loan, image_digest: offer.release.image_digest, descriptor: scorerDescriptor(offer), operator_pk: offer.operator_pk, consent_hash: consentHash(part.consent), evidenceKeys: o.evidenceKeys, allowDevelopment: o.allowDevelopment })
  for (const t of evidence.ticks) ticks.push({ ...t, id: `evidence:${t.id}` })
  if (o.requiredChecks?.length) {
    const out = evidence.outputs
    const passed = (id: string) => !!out?.checks.some((c) => c.id === id && c.ok)
    const missing = o.requiredChecks.filter((id) => !passed(id))
    tick('required-checks', missing.length === 0, missing.length ? `required checks missing or failed: ${missing.join(', ')}` : `required checks passed: ${o.requiredChecks.join(', ')}`)
  }
  const ok = ticks.every((t) => t.ok)
  stage('verified', ok ? `${evidence.outputs?.recommendation} (${evidence.outputs?.income_band})` : `does not verify: ${ticks.filter((t) => !t.ok).map((t) => t.id).join(', ')}`)
  return { ok, ticks, outputs: evidence.outputs, outcome, execution_id: outcome.kind === 'external-evidence' ? outcome.reference ?? null : null, ...base }
}
