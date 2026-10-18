// The credit check of the public Mutinynet run (infra/public-mutinynet-loan.ts): the platform
// sandbox in rules mode (RuleReasoner: no model), the same sandbox a regtest negotiated loan uses.
//
// The lender-paid Compex check is paid over RGB Lightning HODL, and there is no RGB Lightning
// on Mutinynet here, so this run makes no check payment and does not pretend one.
//
//   borrower (its own process, only its key): builds its bundle from its own Mutinynet RGB
//     history and a payer-signed income statement, signs a consent receipt naming this sandbox,
//     the lender and the negotiation, seals the bundle to the sandbox key, submits it, approves
//     the disclosure, and sends the lender the signed lender result NIP-44 over the public relays;
//   lender: re-verifies it on its own, with the checks LenderAgent.review makes (src/agents/lender.ts),
//     using the same exported functions; nothing here trusts the borrower's word.

import { finalizeEvent, type Event } from 'nostr-tools'
import { EsploraChain } from '../src/chain/esplora.js'
import type { PassbookConfig } from '../src/core/config.js'
import { canonicalJson, hashObject, verifyHash, verifyObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { termInterest } from '../src/core/economics.js'
import { collateralFor, type Micro } from '../src/core/money.js'
import type { OracleQuote } from '../src/core/terms.js'
import { TOPIC, KIND } from '../src/market/kinds.js'
import { decryptFrom, encryptTo, type OfferPayload } from '../src/market/messages.js'
import type { Position } from '../src/market/negotiate.js'
import type { NegotiationTransport, NostrEvent } from '../src/market/negotiate-nostr.js'
import type { TermSheetEvidence, TermSheetScorer } from '../src/market/termsheet.js'
import { rgbHistoryRows, type RgbRowLabel } from '../src/networks/rgb.js'
import { RgbWallet } from '../src/rgb/wallet.js'
import type { Attestation } from '../src/sandbox/broker.js'
import { INVESTIGATION_BUDGETS, INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from '../src/sandbox/investigate.js'
import { investigationAccepted } from '../src/sandbox/investigation-policy.js'
import { sandboxProvider, sandboxScorerId } from '../src/sandbox/provenance.js'
import { publishedRunMaterials } from '../src/sandbox/published-materials.js'
import { verifyRunRecord } from '../src/sandbox/run-record.js'
import type { Bundle, DisclosureItem, LenderSandboxResult, SandboxResult } from '../src/sandbox/types.js'
import { bundleCategories, consentHash, signConsent, type ConsentReceipt } from '../src/scorer/consent.js'
import { contractHash, loadScoringContract } from '../src/scorer/contract.js'
import { runRecordDigest } from '../src/scorer/evidence-digest.js'
import { recommend } from '../src/scorer/providers.js'
import { measureSource } from '../src/scorer/releases.js'
import { labelTags } from './public-nostr.js'

/** A payer's signed statement of one income payment (src/wallet/income.ts: payer signs { txid, amount, borrower_pk }). */
export interface IncomeStatement { txid: Hex; height: number; amount: Micro; payer_pk: Hex; payer_sig: Hex; memo: string }

/** What the borrower sends the lender: the sandbox's lender result and what the lender needs to verify it. */
export interface CheckPart {
  v: 1; kind: 'passbook-public-rules-check'; negotiation_id: Hex; offer_id: string
  lender_result: LenderSandboxResult; attestation: Attestation; consent: ConsentReceipt
  disclosure_items: DisclosureItem[]; inflow_proofs: { txid: Hex; amount: Micro; payer_pk: Hex; payer_sig: Hex }[]
}

/** The check as the record shows it. */
export interface CheckReport {
  scorer: 'platform sandbox, rules mode (RuleReasoner, no model)'
  payment: 'none: the lender-paid check rail is RGB Lightning HODL, not set up on Mutinynet'
  sandbox_pk: Hex; image_digest: string; consent_hash: Hex; result_hash: Hex; bundle_hash: Hex
  checks: { id: string; ok: boolean; detail: string }[]
  recommendation: string
  lender_checks: { id: string; ok: boolean; detail: string }[]
  lender_verified: boolean; passed: boolean; problems: string[]
  part_event_id: Hex | null
  /** The part as the lender received it (git-ignored run state; the record shows the summary). */
  part?: CheckPart
  termsheet_scorer: TermSheetScorer & { evidence: TermSheetEvidence }
}

const get = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** The borrower's side; returns the event id of the part it sent. */
export async function borrowerRulesCheck(o: {
  key: KeyPair; lenderPk: Hex; sandboxUrl: string; offer: OfferPayload; offerId: string; negotiationId: Hex; agreed: Position
  transport: NegotiationTransport; network: string; cfg: PassbookConfig; rgb: RgbWallet; income: IncomeStatement; labels: Record<Hex, RgbRowLabel>; allowedLtv: number; log: (m: string) => void
}): Promise<{ part_event_id: Hex; bundle_hash: Hex; checks: SandboxResult['checks'] }> {
  const p = o.cfg.network
  const chain = new EsploraChain(p.endpoints.esplora!)
  const { sandbox_pk, attestation } = await get<{ sandbox_pk: Hex; attestation: Attestation }>(`${o.sandboxUrl}/sandbox/pubkey`)
  if (!verifyObject(attestation, attestation.platform_pk) || attestation.sandbox_pk !== sandbox_pk) throw new Error('the platform\'s sandbox attestation does not verify')
  const quote = await get<OracleQuote>(`${o.sandboxUrl}/oracle/quote`)
  try { o.rgb.refresh() } catch (err) { o.log(`borrower: refresh ${(err as Error).message}`) }
  const asset = o.offer.asset_id
  const fee = termInterest({ principal: o.agreed.principal, apr_bps: o.agreed.apr_bps, term_blocks: o.agreed.term_blocks }, o.cfg.economics)
  const bundle: Bundle = {
    v: 1, borrower_pk: o.key.pubkey, own_pks: [], offer_id: o.offerId,
    loan_request: { principal: o.agreed.principal, fee, term_blocks: o.agreed.term_blocks, grace_blocks: o.offer.grace_blocks },
    lender_requirements: o.offer.requirements, balance: o.rgb.balance(asset).settled,
    history: await rgbHistoryRows({ wallet: o.rgb, assetId: asset, chain, inflows: [o.income], labels: o.labels }), asset_id: asset,
    candidate_inflows: [{ txid: o.income.txid, height: o.income.height, amount: o.income.amount, payer_pk: o.income.payer_pk, payer_sig: o.income.payer_sig }],
    scheduled_outflows: [],
    collateral: { sats: collateralFor(o.agreed.principal + fee, o.allowedLtv, quote.price_cents), oracle_quote: quote, allowed_ltv_bps: o.allowedLtv },
  }
  const now = Math.floor(Date.now() / 1000)
  const consent = signConsent(o.key, {
    purpose: `credit check for negotiation ${o.negotiationId.slice(0, 12)} (${o.network} test USDT)`, purpose_id: o.negotiationId,
    scorer_id: sandboxScorerId(sandbox_pk, attestation.image_digest), scorer_pk: sandbox_pk, contract_hash: contractHash(loadScoringContract()),
    lender_pk: o.lenderPk, data_categories: bundleCategories(bundle), issued_at: now, expires_at: now + 6 * 3600,
  })
  const sent = { ...bundle, consent }
  o.log(`borrower: bundle of ${bundle.history.length} history rows, 1 payer-signed inflow, balance ${bundle.balance / 1e6} test USDT, sealed to sandbox ${sandbox_pk.slice(0, 12)}…`)
  const res = await fetch(`${o.sandboxUrl}/sandbox/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender_pk: o.key.pubkey, ciphertext: encryptTo(o.key, sandbox_pk, JSON.stringify(sent)) }), signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`sandbox submit: ${res.status} ${await res.text()}`)
  const result = (await res.json()) as SandboxResult
  if (result.bundle_hash !== hashObject(sent)) throw new Error('the sandbox result is not about our bundle')
  if (result.consent_hash !== consentHash(consent) || result.lender_result?.consent_hash !== consentHash(consent)) throw new Error('the sandbox result does not commit to our consent receipt')
  o.log(`borrower: sandbox ${result.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}`).join(', ')}`)
  if (!result.lender_result) throw new Error('the sandbox gave no separately signed lender result')
  // the person approves each proposed item; here every proposed item (the one payer-signed income)
  const items = result.disclosure_proposal
  const part: CheckPart = {
    v: 1, kind: 'passbook-public-rules-check', negotiation_id: o.negotiationId, offer_id: o.offerId,
    lender_result: result.lender_result, attestation, consent, disclosure_items: items,
    inflow_proofs: items.map((i) => ({ txid: i.txid, amount: o.income.amount, payer_pk: o.income.payer_pk, payer_sig: o.income.payer_sig })).filter((x) => x.txid === o.income.txid),
  }
  const event = finalizeEvent({ kind: KIND.APPLICATION, created_at: Math.floor(Date.now() / 1000), tags: labelTags([['t', TOPIC], ['p', o.lenderPk], ['n', o.negotiationId]], o.network), content: encryptTo(o.key, o.lenderPk, JSON.stringify(part)) }, o.key.secretKey)
  await o.transport.publish(event as NostrEvent)
  o.log(`borrower: check part ${event.id.slice(0, 12)}… sent NIP-44 to the lender`)
  return { part_event_id: event.id, bundle_hash: result.bundle_hash, checks: result.checks }
}

/**
 * A disclosed inflow the sandbox committed to, whose payer signed { txid, amount, borrower_pk } (src/wallet/income.ts).
 * The proof must name the committed item's payer and amount, as LenderAgent.review requires: a valid signature by
 * another payer, or over another amount, for the same txid is refused.
 */
export function inflowProofOk(proof: CheckPart['inflow_proofs'][number], item: DisclosureItem | undefined, committed: Set<Hex>, borrowerPk: Hex): boolean {
  return !!item && item.txid === proof.txid && item.amount === proof.amount && item.payer_pk === proof.payer_pk && committed.has(hashObject(item))
    && verifyHash(proof.payer_sig, hashObject({ txid: proof.txid, amount: proof.amount, borrower_pk: borrowerPk }), proof.payer_pk)
}

/** Every check the lender makes on a part, as LenderAgent.review does for a negotiated sandbox application. */
export async function verifyPart(part: CheckPart, x: {
  borrowerPk: Hex; lenderPk: Hex; negotiationId: Hex; offerId: string; agreed: Position; offer: OfferPayload; sandboxPk: Hex; current: Attestation; platformPk: Hex; oraclePk: Hex
  cfg: PassbookConfig; chain: Pick<EsploraChain, 'getTx' | 'getHeight'>
}): Promise<{ id: string; ok: boolean; detail: string }[]> {
  const out: { id: string; ok: boolean; detail: string }[] = []
  const check = (id: string, ok: boolean, detail: string) => out.push({ id, ok, detail })
  const r = part.lender_result
  const fee = termInterest({ principal: x.agreed.principal, apr_bps: x.agreed.apr_bps, term_blocks: x.agreed.term_blocks }, x.cfg.economics)
  check('part', part.v === 1 && part.kind === 'passbook-public-rules-check' && part.negotiation_id === x.negotiationId && part.offer_id === x.offerId, 'for this negotiation and offer')
  check('sandbox-sig', verifyObject(r, x.sandboxPk) && r.borrower_pk === x.borrowerPk && r.offer_id === x.offerId, `signed by sandbox ${x.sandboxPk.slice(0, 12)} for this borrower and offer`)
  check('sandbox-request', !!r.loan_request && r.loan_request.principal === x.agreed.principal && r.loan_request.term_blocks === x.agreed.term_blocks && r.loan_request.grace_blocks === x.offer.grace_blocks && r.loan_request.fee === fee, 'principal, term, grace and the fee at the negotiated APR')
  check('attestation', verifyObject(part.attestation, x.platformPk) && part.attestation.sandbox_pk === x.sandboxPk && part.attestation.image_digest === x.current.image_digest, `platform attests ${part.attestation.image_digest}`)
  const c = part.consent
  check('consent-bound', !!c && verifyObject(c, x.borrowerPk) && r.consent_hash === consentHash(c) && c.scorer_pk === x.sandboxPk && c.scorer_id === sandboxScorerId(x.sandboxPk, x.current.image_digest) && c.purpose_id === x.negotiationId && c.lender_pk === x.lenderPk, 'the sandbox checked this receipt before processing and signed its hash')
  check('no-raw-rows', !('history' in r) && !('candidate_inflows' in r) && !canonicalJson(r).includes('"memo"'), 'the result carries checks and summaries only')
  const rr = r.run_record
  const materials = await publishedRunMaterials(r.investigation?.model ?? '', { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS })
  const run = rr ? verifyRunRecord(rr, materials, x.sandboxPk, INVESTIGATION_BUDGETS, r.investigation) : { ok: false, errors: ['RUN_RECORD_MISSING'] }
  check('sandbox-run-record', run.ok && rr?.image_digest === x.current.image_digest && rr?.bundle_hash === r.bundle_hash && rr?.status === r.investigation?.status && rr?.policy_sha256 === hashObject(r.investigation?.policy ?? null), run.errors.join(',') || 'signed run record; published materials and budgets verified')
  check('investigation-policy', investigationAccepted(x.offer.requirements.investigation, r.investigation), `policy ${x.offer.requirements.investigation ?? 'optional'}; investigation ${r.investigation?.status ?? 'missing'} (rules mode runs no model)`)
  // this lender's required checks: always injection, headroom, sybil; its policy also requires inflows (+ disclosure), and affordability
  const required = ['injection', 'headroom', 'sybil', 'inflows', 'disclosure', ...(x.offer.requirements.affordability ? ['affordability'] : [])]
  for (const id of required) { const s = r.checks.find((k) => k.id === id); check(`sandbox:${id}`, !!s?.ok, s?.detail ?? 'missing') }
  // re-verify each disclosed inflow without the sandbox: committed by the sandbox, payer signature, confirmed on Mutinynet
  const committed = new Set(r.disclosure_commitments ?? [])
  const tip = await x.chain.getHeight()
  for (const proof of part.inflow_proofs) {
    const item = part.disclosure_items.find((d) => d.txid === proof.txid)
    const tx = await x.chain.getTx(proof.txid)
    check(`inflow:${proof.txid.slice(0, 12)}`, inflowProofOk(proof, item, committed, x.borrowerPk) && !!tx?.height && tx.height <= tip,
      `committed by the sandbox, payer ${proof.payer_pk.slice(0, 12)} signed ${proof.amount / 1e6} test USDT, confirmed at ${tx?.height ?? 'none'} on ${x.cfg.network.name}`)
  }
  check('inflow-proofs', part.inflow_proofs.length > 0, `${part.inflow_proofs.length} disclosed inflow(s)`)
  return out
}

/** The lender's side: wait for the borrower's part on the relays, verify it, build the term sheet's scorer reference. */
export async function lenderVerifiesCheck(o: {
  key: KeyPair; borrowerPk: Hex; negotiationId: Hex; offerId: string; agreed: Position; offer: OfferPayload; transport: NegotiationTransport
  platform: { sandboxPubkey(): Promise<{ sandbox_pk: Hex; attestation: Attestation }> }; platformPk: Hex; oraclePk: Hex; cfg: PassbookConfig; chain: EsploraChain; timeoutMs: number; log: (m: string) => void
}): Promise<CheckReport> {
  const { sandbox_pk, attestation: current } = await o.platform.sandboxPubkey()
  const event = await new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error(`no check part from the borrower within ${o.timeoutMs} ms`)) }, o.timeoutMs)
    const stop = o.transport.subscribe({ kinds: [KIND.APPLICATION], authors: [o.borrowerPk], '#p': [o.key.pubkey], '#n': [o.negotiationId], since: Math.floor(Date.now() / 1000) - 600 }, (e) => { clearTimeout(timer); stop(); resolve(e as Event) })
  })
  const part = JSON.parse(decryptFrom(o.key, o.borrowerPk, event.content)) as CheckPart
  o.log(`lender: check part ${event.id.slice(0, 12)}… received; verifying`)
  const lenderChecks = await verifyPart(part, { borrowerPk: o.borrowerPk, lenderPk: o.key.pubkey, negotiationId: o.negotiationId, offerId: o.offerId, agreed: o.agreed, offer: o.offer, sandboxPk: sandbox_pk, current, platformPk: o.platformPk, oraclePk: o.oraclePk, cfg: o.cfg, chain: o.chain })
  for (const c of lenderChecks) o.log(`lender:   ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`)
  const r = part.lender_result
  const problems = lenderChecks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`)
  const digest = part.attestation.image_digest
  const rec = recommend(r as unknown as SandboxResult)
  return {
    scorer: 'platform sandbox, rules mode (RuleReasoner, no model)',
    payment: 'none: the lender-paid check rail is RGB Lightning HODL, not set up on Mutinynet',
    sandbox_pk, image_digest: digest, consent_hash: consentHash(part.consent), result_hash: hashObject(r), bundle_hash: r.bundle_hash,
    checks: r.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })), recommendation: rec,
    lender_checks: lenderChecks, lender_verified: problems.length === 0, passed: problems.length === 0, problems, part_event_id: event.id, part,
    termsheet_scorer: {
      provider: sandboxProvider(digest), scorer_id: sandboxScorerId(sandbox_pk, digest), code_measurement: sandboxProvider(digest) === 'container' ? digest : measureSource(),
      contract_hash: contractHash(loadScoringContract()), trust: 'dev-inprocess', result_hash: hashObject(r), fallback: false, recommendation: rec,
      evidence: runRecordDigest(r.run_record) as Extract<TermSheetEvidence, { kind: 'passbook-run-record' }>,
    },
  }
}
