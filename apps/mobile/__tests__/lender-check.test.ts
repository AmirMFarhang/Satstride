import { unitOutcome } from './scorer-helpers.ts'
// Lane E3: the phone lender's credit check billed at close, and its review of the negotiated
// application. Only a verified QUALIFY of exactly the agreed loan is underwritten: a v1 output,
// a binding to another loan, ESCALATE, a KEY or bill for another negotiation, or a transcript
// this phone did not negotiate all decline, and nothing is registered or sent. A good one yields
// a term sheet that follows the agreement, binds the evidence digest and is signed by the lender.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { hashObject, keyPairFromLabel, randomHex, signHash, verifyHash, type Hex } from '../../../src/core/crypto.ts'
import { DEFAULT_ECONOMICS } from '../../../src/core/economics.ts'
import { MICRO_PER_USDT } from '../../../src/core/money.ts'
import { Oracle } from '../../../src/oracle/oracle.ts'
import { signPassbook } from '../../../src/registry/passbook-doc.ts'
import { signBorrowerPolicy } from '../../../src/market/policy.ts'
import { keyPairSigner, negotiateAsBorrower, serveNegotiations, type NegotiationResult } from '../../../src/market/negotiate-nostr.ts'
import { approvalStatus } from '../../../src/market/approvals.ts'
import { termSheetHash, termSheetProblems } from '../../../src/market/termsheet.ts'
import type { ApplicationPayload } from '../../../src/market/messages.ts'
import { checkMessageHash, type CheckMessage } from '../../../src/checknode/messages.ts'
import { signConsent } from '../../../src/scorer/consent.ts'
import { scoredSheetProblems } from '../../../src/scorer/bundle-terms.ts'
import { termSheetEvidenceProblems } from '../../../src/scorer/evidence-digest-core.ts'
import type { PassbookCheckOutputs, ScorerOutcome } from '../../../src/scorer/types.ts'
import { LocalKeySigner } from '../../../src/wallet/signer.ts'
import { PASSBOOK_ONLY } from '../src/agent/lender.ts'
import { agreedLoan, checkRecord, checkRefusals, runBilledCheck, CheckRefused, type CheckCore } from '../src/lender/check.ts'
import type { LenderBilledCheckResult } from '../src/lender/check.ts'
import { engineParams, offerTerms, signMarketPolicy } from '../src/lender/market-policy.ts'
import { acceptancePayload, lenderApproval, reviewNegotiated, sendProblems, type NegotiationRecord } from '../src/lender/review.ts'
import { lenderSigner } from '../src/lender/signer.ts'
import { MemoryRelay, partyKey } from './lender-helpers.ts'

const U = MICRO_PER_USDT
const L = keyPairFromLabel('e3c-lender'), B = keyPairFromLabel('e3c-borrower'), OP = keyPairFromLabel('e3c-operator'), P = keyPairFromLabel('e3c-platform'), O = keyPairFromLabel('e3c-oracle')
const ASSET = 'rgb:usdt-mutinynet'
const OFFER = { ...PASSBOOK_ONLY, apr_bps: 1200 }
const params = engineParams({ negotiation: { max_rounds: 4, concession_bps: 2500 } })


async function agreement() {
  const relay = new MemoryRelay()
  const policy = await signMarketPolicy(partyKey(L), ASSET, OFFER, { floor_apr_bps: 1000, check_operators: [OP.pubkey] }, 1_000)
  const bp = await signBorrowerPolicy(new LocalKeySigner(B), { asset_id: ASSET, principal: { min: 100 * U, max: 100 * U }, max_apr_bps: 1100, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: 1 })
  const results: NegotiationResult[] = []
  const signer = lenderSigner(partyKey(L))
  const server = serveNegotiations({ transport: relay, policy, params, signer: () => signer, min_principal: OFFER.min, timeoutMs: 2_000, onResult: (r) => results.push(r) })
  await negotiateAsBorrower({ transport: relay, signer: keyPairSigner(B), policy: bp, terms: offerTerms(policy, params, OFFER.min, 0), params, timeoutMs: 2_000 })
  for (let i = 0; i < 50 && !results.length; i++) await new Promise((r) => setTimeout(r, 20))
  server.close()
  const r = results[0]
  assert.ok(r && 'agreed' in r.outcome && r.verified.accept_hash)
  return { r, policy, agreed: r.outcome.agreed, accept_hash: r.verified.accept_hash! }
}

// filled before the tests run (the agreement comes from a real negotiation over the memory relay)
let A: Awaited<ReturnType<typeof agreement>>
let NEG: Hex
let LOAN: ReturnType<typeof agreedLoan>
let consent: ReturnType<typeof signConsent>
let X: Parameters<typeof checkRefusals>[1]
before(async () => {
  A = await agreement()
  NEG = A.r.negotiation_id
  LOAN = agreedLoan(A.agreed, OFFER, ASSET)
  consent = signConsent(B, { purpose: 'credit check', purpose_id: NEG, scorer_id: 'passbook-sandbox:mobile-unit', contract_hash: 'cd'.repeat(32), operator_pk: OP.pubkey, lender_pk: L.pubkey, payer: 'lender', release_hash: '02'.repeat(32), data_categories: ['transaction_history'], issued_at: 1, expires_at: 2_000_000_000 })
  X = { lenderPk: L.pubkey, borrowerPk: B.pubkey, negotiationId: NEG, operatorPk: OP.pubkey, loan: LOAN }
})

/** A billed check's result as E2's lender half returns it (a fake scorer release: signed result and released v2 outputs). */
function result(over: { outputs?: Partial<PassbookCheckOutputs> | null; ok?: boolean; negotiation?: Hex; bill?: Record<string, unknown> } = {}): LenderBilledCheckResult {
  const outputs: PassbookCheckOutputs = { v: 2, kind: 'passbook-check-outputs', recommendation: 'QUALIFY', income_band: '1000-2000', checks: [{ id: 'affordability', ok: true }], findings: [], lender_note: '', borrower_pk: B.pubkey, lender_pk: L.pubkey, purpose_id: NEG, bundle_hash: 'ab'.repeat(32), ...LOAN, ...(over.outputs ?? {}) } as PassbookCheckOutputs
  const outcome = unitOutcome(outputs)
  const key = { v: 1, domain: 'passbook-check-v1', negotiation_id: over.negotiation ?? NEG, seq: 6, type: 'KEY', from_pk: L.pubkey, to_pk: B.pubkey, prev_hash: null, body: {}, sig: '00' } as unknown as CheckMessage
  const bill = { v: 1, kind: 'passbook-check-bill', label: 'billed at close, not paid up front', negotiation_id: NEG, lender_pk: L.pubkey, borrower_pk: B.pubkey, operator_pk: OP.pubkey, offer_hash: '01'.repeat(32), release_hash: '02'.repeat(32), request_hash: '03'.repeat(32), commitment: '04'.repeat(32), fee: { asset_id: ASSET, amount: 500_000 }, due: 'at-close', issued_at: 1, expires_at: 2_000_000_000, sig: '00', ...(over.bill ?? {}) }
  return { ok: over.ok ?? true, ticks: [{ id: 'evidence:result-signature', ok: over.ok ?? true, detail: 'pinned key' }], not_run: ['hardware attestation'], outputs: over.outputs === null ? null : outputs, outcome, key, bill: bill as never, bill_hash: hashObject(bill), consent_hash: hashObject(consent), commitment: '04'.repeat(32), execution_id: 'gov-e3', rail_label: 'Billed at close, not paid up front' }
}

test('a verified QUALIFY of exactly the agreed loan, billed to this lender at close, may be underwritten', () => {
  assert.deepEqual(checkRefusals(result(), X), [])
})

test('negatives: v1 outputs, a binding to another loan, ESCALATE, a failed verification, another negotiation\'s KEY or bill', () => {
  assert.match(checkRefusals(result({ outputs: { v: 1, loan_request: undefined } }), X).join(), /outputs v1/)
  assert.match(checkRefusals(result({ outputs: { loan_request: { ...LOAN.loan_request, fee: LOAN.loan_request.fee + 1 } } }), X).join(), /scored fee/)
  assert.match(checkRefusals(result({ outputs: { asset_id: 'rgb:other' } }), X).join(), /scored asset/)
  assert.match(checkRefusals(result({ outputs: { lender_requirements_hash: 'aa'.repeat(32) } }), X).join(), /lender requirements/)
  assert.match(checkRefusals(result({ outputs: { recommendation: 'ESCALATE' } }), X).join(), /ESCALATE: only QUALIFY is funded/)
  assert.match(checkRefusals(result({ outputs: { recommendation: 'DECLINE' } }), X).join(), /DECLINE/)
  assert.match(checkRefusals(result({ ok: false }), X).join(), /did not verify/)
  assert.match(checkRefusals(result(), { ...X, minimumTrust: 'software-evidence' }).join(), /below this lender/)
  assert.match(checkRefusals(result({ outputs: null }), X).join(), /no released outputs/)
  assert.match(checkRefusals(result({ negotiation: 'ff'.repeat(32) }), X).join(), /another negotiation/)
  assert.match(checkRefusals(result({ bill: { lender_pk: B.pubkey } }), X).join(), /bill names another/)
  assert.match(checkRefusals(result({ bill: { fee: { asset_id: 'rgb:other', amount: 1 } } }), X).join(), /another asset/)
  assert.match(checkRefusals(result({ bill: { due: 'now' } }), X).join(), /no bill due at close/)
  assert.match(checkRefusals(result({ outputs: { lender_pk: B.pubkey } }), X).join(), /another borrower or lender/)
})

test('runBilledCheck: an absent signed offer refuses before anything runs', async () => {
  let ran = 0
  const core: CheckCore = {
    portableBus: () => ({ pubkey: L.pubkey, send: async () => {}, receive: async () => { throw new Error('unused') }, close: () => {} }),
    receivePartPortable: async () => ({ offer_hash: '09'.repeat(32), operator_pk: OP.pubkey }) as never,
    runLenderCheckBilled: async () => { ran++; return result() },
  }
  const base = { core, transport: new MemoryRelay(), signer: lenderSigner(partyKey(L)), borrowerPk: B.pubkey, negotiationId: NEG, agreed: A.agreed, offer: OFFER, assetId: ASSET, policy: A.policy, listOffers: async () => [] }
  await assert.rejects(runBilledCheck({ ...base, evidenceKeys: [] }), (e: unknown) => e instanceof CheckRefused && /OFFER_NOT_FOUND/.test(e.reason))
  assert.equal(ran, 0)
})

test('the lender half is E2\'s browser-safe module (#71): the stub is gone and check.ts imports lender-core', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/lender/check.ts', import.meta.url).pathname, 'utf8')
  assert.match(src, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/checknode\/lender-core\.js'/)
  assert.ok(!existsSync(new URL('../src/lender/lender-core-stub.ts', import.meta.url).pathname))
  const { E2_CORE } = await import('../src/lender/check.ts')
  assert.deepEqual(Object.keys(E2_CORE).filter((k) => ['portableBus', 'receivePartPortable', 'runLenderCheckBilled'].includes(k)).sort(), ['portableBus', 'receivePartPortable', 'runLenderCheckBilled'])
})

// ---- the review ----

const oracle = new Oracle(O, 6_000_000)
const ports = {
  pubkey: L.pubkey, assetId: ASSET, economics: DEFAULT_ECONOMICS, key: { signPassbookHash: async (h: Hex) => signHash(h, L.secretKey) },
  platform: { state: async () => ({ platform_pk: P.pubkey, oracle_pk: O.pubkey, height: 100 }), quote: async () => oracle.quote(100) },
  chain: { getTx: async () => null, getHeight: async () => 100 } as never,
}
const offerCtx = { ...OFFER, expires_height: 900 }
const record = (): NegotiationRecord => ({ negotiation_id: NEG, borrower_pk: B.pubkey, started_at: 1, messages: A.r.messages, outcome: { agreed: A.agreed, accept_hash: A.accept_hash }, verified: true, problems: [] })
function application(check: ReturnType<typeof checkRecord>, over: Partial<ApplicationPayload> = {}): ApplicationPayload {
  return {
    offer_id: `${L.pubkey}:${OFFER.d}`, principal: A.agreed.principal, term_blocks: 30, sandbox_result: null, attestation: null, check_key: check.key_hash, disclosed_inflows: [],
    passbook: signPassbook(B, []), outstanding_statement: { outstanding_micro: 0, sig: signHash(hashObject({ outstanding_micro: 0 }), B.secretKey) }, negotiation: A.r.messages, consent, ...over,
  } as ApplicationPayload
}
const review = (check: ReturnType<typeof checkRecord> | undefined, app: ApplicationPayload, rec: NegotiationRecord | null = record()) => reviewNegotiated(ports, { offer: offerCtx, market: { policy: A.policy, params }, record: rec ?? undefined, check }, app, B.pubkey)

test('QUALIFY: a term sheet that follows the agreement, binds the evidence digest and consent, signed by the lender; the acceptance is what the borrower phone checks', async () => {
  const check = checkRecord(result(), X)
  const r = await review(check, application(check))
  assert.ok('proposal' in r, JSON.stringify('declined' in r ? r.declined.failed : null))
  const p = r.proposal
  assert.equal(termSheetHash(p.sheet), p.loan_id)
  assert.ok(verifyHash(p.sheet.signatures.lender!, p.loan_id, L.pubkey), 'signed by the party key over the term-sheet hash')
  assert.deepEqual(termSheetProblems(p.sheet, { agreed: A.agreed, accept_hash: A.accept_hash }), [])
  assert.deepEqual(termSheetEvidenceProblems(p.sheet, check.outcome!), [])
  assert.deepEqual(scoredSheetProblems(p.sheet, check.outcome!), [])
  assert.equal(p.sheet.apr_bps, A.agreed.apr_bps)
  assert.equal(p.sheet.scorer.recommendation, 'QUALIFY')
  assert.equal(p.sheet.scorer.check_receipt, undefined, 'the phone borrower holds no receipt, so the sheet names none')
  // the lender's approval, then what the borrower phone checks (M7 sheetProblems): the policy its OFFER named, approvals complete
  const approval = await lenderApproval(partyKey(L), p)
  assert.deepEqual(sendProblems(p, [approval], A.policy, { pubkey: L.pubkey, assetId: ASSET }), [])
  const acc = acceptancePayload(`${L.pubkey}:${OFFER.d}`, p, [approval], A.policy)
  const named = A.r.messages.find((m) => m.type === 'OFFER' && m.from_pk === L.pubkey)?.body.policy_hash
  assert.equal(hashObject(acc.lender_policy), named, 'the acceptance carries the signed policy its OFFER named')
  const s = approvalStatus(p.sheet, acc.lender_approvals!, acc.lender_policy!, Number.MAX_SAFE_INTEGER)
  assert.equal(s.lender_approvers.length, 1)
  assert.equal(s.required_lender_approvals, 1)
  assert.deepEqual(s.problems, [])
  assert.ok(sendProblems(p, [approval], { ...A.policy, min_scorer_trust: 'software-evidence' }, { pubkey: L.pubkey, assetId: ASSET }).some((why) => /scorer trust/.test(why)), 'a saved stronger policy is not lowered to the local default')
  assert.deepEqual(sendProblems(p, [], A.policy, { pubkey: L.pubkey, assetId: ASSET }).length, 1, 'no approval, nothing sent')
})

test('ESCALATE gives no funding: declined, no sheet', async () => {
  const check = checkRecord(result({ outputs: { recommendation: 'ESCALATE' } }), X)
  const r = await review(check, application(check))
  assert.ok('declined' in r)
  const ids = r.declined.failed.map((c) => c.id)
  assert.ok(ids.includes('recommendation') && ids.includes('check-verified'), ids.join())
})

test('declined: v1 outputs, a binding mismatch, another KEY, no check at all, a transcript this phone did not negotiate', async () => {
  for (const over of [{ outputs: { v: 1 as const, loan_request: undefined } }, { outputs: { loan_request: { ...LOAN.loan_request, principal: LOAN.loan_request.principal + 1 } } }]) {
    const check = checkRecord(result(over), X)
    const r = await review(check, application(check))
    assert.ok('declined' in r && r.declined.failed.some((c) => c.id === 'check-verified'))
  }
  const check = checkRecord(result(), X)
  const other = await review(check, application(check, { check_key: randomHex(32) }))
  assert.ok('declined' in other && other.declined.failed.some((c) => c.id === 'check-key'))
  const none = await review(undefined, application(check))
  assert.ok('declined' in none && none.declined.failed.some((c) => c.id === 'check-key'))
  const notOurs = await review(check, application(check), { ...record(), messages: A.r.messages.slice(0, 2) })
  assert.ok('declined' in notOurs && notOurs.declined.failed.some((c) => c.id === 'negotiation'))
  const noRecord = await review(check, application(check), null)
  assert.ok('declined' in noRecord && noRecord.declined.failed.some((c) => c.id === 'negotiation'))
})

test('declined: a consent naming another payer, an LTV above the borrower\'s earned limit, a principal other than agreed', async () => {
  const check = checkRecord(result(), X)
  const borrowerPaid = signConsent(B, { ...consent, payer: 'borrower' } as never)
  const r1 = await review(check, application(check, { consent: borrowerPaid }))
  assert.ok('declined' in r1 && r1.declined.failed.some((c) => c.id === 'consent'))
  const r2 = await review(check, application(check, { principal: A.agreed.principal + U }))
  assert.ok('declined' in r2 && r2.declined.failed.some((c) => c.id === 'negotiated-terms'))
})
