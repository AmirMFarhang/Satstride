// The lender phone's review of a negotiated application, then its term sheet: the laptop
// lender's reviewChecked and originateNegotiated (src/agents/lender.ts), from browser-safe
// code only. The application must carry exactly the transcript this phone negotiated, the
// consent the operator signed into its commitment, and the hash of the KEY this phone
// forwarded; the check must be a verified QUALIFY of exactly the agreed loan; the borrower's
// own record is checked on Bitcoin. Then the sheet follows the agreement exactly, binds the
// evidence digest and the consent, and is signed with the party key. Nothing is registered or
// sent here: the person approves the sheet first (lend-flow's stop), then approveAndSend.
import { hashObject, randomHex, verifyHash, verifyObject, type Hex } from '../../../../src/core/crypto.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm, type Economics } from '../../../../src/core/economics.js'
import { usdt } from '../../../../src/core/money.js'
import type { LenderPolicy as OfferPolicy } from '../../../../src/agents/lender.js'
import { KIND } from '../../../../src/market/kinds.js'
import type { AcceptancePayload, ApplicationPayload } from '../../../../src/market/messages.js'
import { verifyTranscript, type EngineParams, type NegotiationMessage, type Position } from '../../../../src/market/negotiate-engine.js'
import { approvalStatus, type Approval } from '../../../../src/market/approvals.js'
import { buildTermSheet, termSheetHash, termSheetProblems, type TermSheet } from '../../../../src/market/termsheet.js'
import { verifyQuote } from '../../../../src/oracle/oracle.js'
import { verifyPassbook, type PassbookDocument } from '../../../../src/registry/passbook-doc.js'
import { consentHash } from '../../../../src/scorer/consent.js'
import { scoredSheetProblems } from '../../../../src/scorer/bundle-terms.js'
import { evidenceDigest, scorerResultHash, sheetDigestProblems } from '../../../../src/scorer/evidence-digest-core.js'
import { PROVIDER_TRUST, trustAtLeast, weakerTrust } from '../../../../src/scorer/trust.js'
import type { Check } from '../agent/platform'
import type { CheckRecord } from './check'
import { outsidePolicy, type MarketPolicy } from './market-policy'

/** One negotiation this phone served, as it stands (public data and signatures only). */
export interface NegotiationRecord {
  negotiation_id: Hex
  borrower_pk: Hex
  started_at: number
  messages: NegotiationMessage[]
  /** 'open' while it runs; the engine's outcome after */
  outcome: 'open' | { agreed: Position; accept_hash: Hex } | { no_deal: string }
  verified: boolean
  problems: string[]
  check_stage?: string
  check?: CheckRecord
  check_error?: string
}

/** A term sheet waiting for the person's approval on this phone. */
export interface SheetProposal {
  loan_id: Hex
  negotiation_id: Hex
  borrower_pk: Hex
  sheet: TermSheet
  passbook: PassbookDocument
  checks: Check[]
  at: number
}

/** What the review needs from the lender agent (PhoneLender has all of it). */
export interface ReviewPorts {
  pubkey: Hex
  assetId: string
  economics: Economics
  key: { signPassbookHash(hash: Hex): Promise<Hex> }
  platform: { state(): Promise<{ platform_pk: Hex; oracle_pk: Hex; height: number }>; quote(): Promise<AcceptancePayload['terms']['oracle_quote']> }
  chain: Parameters<typeof verifyPassbook>[1]
}

export interface ReviewContext {
  offer: OfferPolicy & { expires_height: number; withdrawn?: boolean }
  market: { policy: MarketPolicy; params: EngineParams }
  record: NegotiationRecord | undefined
  /** the check this phone ran for this negotiation, as kept in app storage (its verified outcome for the sheet) */
  check: CheckRecord | undefined
  now?: number
}

export type ReviewResult = { proposal: SheetProposal } | { declined: { failed: Check[]; checks: Check[] } }

/** Every check of a negotiated application; a sheet only when all pass. */
export async function reviewNegotiated(a: ReviewPorts, x: ReviewContext, app: ApplicationPayload, borrowerPk: Hex): Promise<ReviewResult> {
  const e = a.economics ?? DEFAULT_ECONOMICS
  const p = x.offer
  const checks: Check[] = []
  const check = (id: string, ok: boolean, detail: string) => { checks.push({ id, ok, detail }) }
  const state = await a.platform.state()
  check('offer-live', !p.withdrawn && state.height < p.expires_height, p.withdrawn ? 'offer withdrawn' : `offer valid until block ${p.expires_height}, now ${state.height}`)
  check('amount', app.principal >= p.min && app.principal <= p.max && app.term_blocks === p.term_blocks, `${usdt(app.principal)} for ${app.term_blocks} blocks`)

  // the transcript: verified, and exactly the one this phone negotiated and agreed
  const negotiation = Array.isArray(app.negotiation) ? app.negotiation as NegotiationMessage[] : []
  const t = negotiation.length ? verifyTranscript(negotiation, { borrower_pk: borrowerPk, lender_pk: a.pubkey, max_rounds: x.market.params.max_rounds, economics: e }) : { ok: false, problems: ['no negotiation transcript in the application'] } as ReturnType<typeof verifyTranscript>
  const r = x.record
  const agreedHere = r && typeof r.outcome === 'object' && 'agreed' in r.outcome ? r.outcome : null
  const same = !!r && !!agreedHere && r.borrower_pk === borrowerPk && hashObject(r.messages) === hashObject(negotiation)
  check('negotiation', t.ok && !!t.agreed && same, !t.ok ? t.problems.slice(0, 2).join('; ') : same ? `${negotiation.length} signed, hash-chained messages ending in ACCEPT, the same this phone negotiated` : 'not a negotiation this phone agreed with this borrower')
  const agreed = t.agreed
  const outside = agreed ? outsidePolicy(x.market.policy, agreed, e) : ['no agreement']
  check('negotiated-terms', !!agreed && agreed.principal === app.principal && agreed.term_blocks === p.term_blocks && x.market.policy.owner_pk === a.pubkey && outside.length === 0,
    agreed ? `${usdt(agreed.principal)} for ${agreed.term_blocks} blocks at ${agreed.apr_bps / 100}% APR, ${agreed.ltv_bps / 100}% LTV, ${agreed.settlement}${outside.length ? `: ${outside.join('; ')}` : ', inside this lender\'s signed policy'}` : 'no agreement')

  // the check: the consent the operator signed, the KEY this phone forwarded, a verified QUALIFY of exactly this loan
  const c = app.consent
  const negId = negotiation[0]?.negotiation_id
  const purposeOk = !!c && !!negId && c.purpose_id === negId
  check('consent', !!c && verifyObject(c, borrowerPk) && c.borrower_pk === borrowerPk && c.lender_pk === a.pubkey && purposeOk && c.retention === 'none' && c.payer === 'lender', 'borrower-signed consent for this negotiation and lender, lender as payer')
  const k = x.check
  check('check-key', !!k && k.negotiation_id === negId && k.borrower_pk === borrowerPk && app.check_key === k.key_hash, k ? `names the KEY ${k.key_hash.slice(0, 12)}… this phone forwarded` : 'no credit check ran on this phone for this negotiation')
  const outcome = k?.outcome ?? null
  if (outcome) check('scorer-trust', trustAtLeast(weakerTrust(PROVIDER_TRUST[outcome.descriptor.provider], outcome.descriptor.trust), x.market.policy.min_scorer_trust), `local scorer assurance must meet the signed policy minimum ${x.market.policy.min_scorer_trust}`)
  if (k) {
    for (const tick of k.ticks) check(`check:${tick.id}`, tick.ok, tick.detail)
    check('check-verified', k.refusals.length === 0, k.refusals.length ? k.refusals.join('; ') : `local scorer signature and loan binding verified on this phone; development assurance trusts the selected scorer host`)
    check('recommendation', k.recommendation === 'QUALIFY', `${k.recommendation ?? 'none'}${k.income_band ? `, income ${k.income_band}` : ''}`)
    check('consent-bound', !!c && !!outcome && k.consent_hash === consentHash(c) && c.operator_pk === k.operator_pk && c.scorer_id === outcome.descriptor.scorer_id && c.contract_hash === outcome.descriptor.contract_hash, 'the consent in the application is the one in the check this phone ran (E2 checks it against the operator\'s commitment), naming that operator and scorer')
  }
  check('no-disclosures', app.disclosed_inflows.length === 0 && !app.disclosure_items?.length && !app.inflow_proofs?.length, "income evidence is the check's band; no inflow is disclosed")

  // the borrower's own record: its signed outstanding debt, its passbook on Bitcoin, the agreed LTV within its earned limit
  const outstandingOk = !!app.outstanding_statement && verifyHash(app.outstanding_statement.sig, hashObject({ outstanding_micro: app.outstanding_statement.outstanding_micro }), borrowerPk)
  check('outstanding', outstandingOk && app.outstanding_statement.outstanding_micro === 0, `${usdt(app.outstanding_statement?.outstanding_micro ?? 0)} outstanding, signed by the borrower`)
  const passbook = app.passbook && app.passbook.borrower_pk === borrowerPk ? await verifyPassbook(app.passbook, a.chain) : null
  check('passbook', !!passbook && passbook.document_valid && passbook.unverified === 0 && passbook.ladder.open === 0, passbook ? `${passbook.pages.length} page(s), step ${passbook.ladder.step}, ${passbook.ladder.on_time} on time, all confirmed on Bitcoin` : 'no borrower-signed passbook')
  if (agreed && passbook) {
    const cap = Math.min(passbook.ladder.allowed_ltv_bps, p.ltv_ladder_bps[Math.min(passbook.ladder.step, p.ltv_ladder_bps.length - 1)], maxLtvForTerm(p.term_blocks, e))
    check('negotiated-ltv', agreed.ltv_bps <= cap, `agreed ${agreed.ltv_bps / 100}% within the earned limit ${cap / 100}%`)
  }

  const failed = checks.filter((ch) => !ch.ok)
  if (failed.length || !agreed || !t.accept_hash || !passbook || !k || !outcome || !c || !negId) return { declined: { failed, checks } }

  // the term sheet: the agreement exactly, the evidence digest and the consent bound into the terms hash
  const quote = await a.platform.quote()
  if (!verifyQuote(quote, state.oracle_pk)) throw new Error('oracle quote does not verify')
  const lastClose = [...passbook.pages].reverse().find((pg) => pg.verified.close && pg.close_txid)?.close_txid ?? null
  const scorer = {
    provider: outcome.descriptor.provider, scorer_id: outcome.descriptor.scorer_id, code_measurement: outcome.descriptor.code_measurement, contract_hash: outcome.descriptor.contract_hash,
    // the evidence class of the provider; the ticks above say which checks ran on this phone
    trust: weakerTrust(PROVIDER_TRUST[outcome.descriptor.provider], outcome.descriptor.trust), result_hash: scorerResultHash(outcome), fallback: outcome.fallback,
    recommendation: k.recommendation as 'QUALIFY', evidence: evidenceDigest(outcome),
  }
  const unsigned = buildTermSheet({
    agreed, negotiation: { id: negId, accept_hash: t.accept_hash }, borrower_pk: borrowerPk, lender_pk: a.pubkey, platform_pk: state.platform_pk, asset_id: a.assetId,
    oracle_quote: quote, grace_blocks: p.grace_blocks, ladder_step: passbook.ladder.step, prev_passbook_txid: lastClose, economics: e,
    settlement: { kind: 'cosign-rgb' }, scorer, consent_hash: consentHash(c), salt: randomHex(32),
  })
  const loanId = termSheetHash(unsigned)
  const sheet: TermSheet = { ...unsigned, signatures: { lender: await a.key.signPassbookHash(loanId) } }
  const problems = [
    ...termSheetProblems(sheet, { economics: e, agreed, accept_hash: t.accept_hash }),
    ...sheetDigestProblems(sheet, scorer.evidence, scorer.result_hash),
    ...scoredSheetProblems(sheet, outcome),
  ]
  // nothing is put in front of the person unless the sheet is exactly the agreement and the evidence this phone verified
  if (problems.length) throw new Error(`not asking for approval: ${problems.join('; ')}`)
  return { proposal: { loan_id: loanId, negotiation_id: negId, borrower_pk: borrowerPk, sheet, passbook: app.passbook!, checks, at: Math.floor(Date.now() / 1000) } }
}

/** The lender's approval of exactly this sheet, signed by the party key after the phone's lock (the laptop's approve(), from the worklet). */
export async function lenderApproval(key: { pubkey: Hex; signObject<T extends object>(v: T): Promise<T & { sig: Hex }> }, p: SheetProposal, approvedAt = Math.floor(Date.now() / 1000)): Promise<Approval> {
  return await key.signObject({ v: 1 as const, domain: 'passbook-approval-v1' as const, termsheet_hash: p.loan_id, approver_pk: key.pubkey, role: 'lender' as const, approved_at: approvedAt }) as Approval
}

/** Why the proposal and approvals may not be sent: the sheet still binds this lender, and its own approval is complete under its signed policy. */
export function sendProblems(p: SheetProposal, approvals: Approval[], policy: MarketPolicy, x: { pubkey: Hex; assetId: string; economics?: Economics }): string[] {
  const problems = termSheetProblems(p.sheet, { economics: x.economics ?? DEFAULT_ECONOMICS })
  if (!p.sheet.signatures.lender || p.sheet.terms.lender_pk !== x.pubkey || p.sheet.terms.asset_id !== x.assetId || p.sheet.terms.borrower_pk !== p.borrower_pk || termSheetHash(p.sheet) !== p.loan_id) problems.push('the proposal does not bind this lender\'s signed sheet')
  if (!trustAtLeast(p.sheet.scorer.trust, policy.min_scorer_trust)) problems.push('scorer trust is below this lender’s signed minimum')
  if (policy.owner_pk !== x.pubkey) problems.push('the policy is not this lender\'s')
  const s = approvalStatus(p.sheet, approvals, policy, Number.MAX_SAFE_INTEGER)
  if (s.lender_approvers.length < s.required_lender_approvals || s.problems.length) problems.push(`lender approval incomplete: ${s.lender_approvers.length}/${s.required_lender_approvals}${s.problems.length ? ` (${s.problems.join(', ')})` : ''}`)
  return problems
}

/** The ACCEPTANCE the borrower checks (its sheetProblems): the sheet, the lender's approvals, the signed policy its OFFER named. */
export function acceptancePayload(offerId: string, p: SheetProposal, approvals: Approval[], policy: MarketPolicy): AcceptancePayload {
  return { offer_id: offerId, terms: p.sheet.terms, terms_hash: p.loan_id, termsheet: p.sheet, lender_approvals: approvals, lender_policy: policy }
}
