import { unitOutcome } from './scorer-helpers.ts'
import { evidenceDigest, scorerResultHash } from '../../../src/scorer/evidence-digest-core.ts'
import { termInterest } from '../../../src/core/economics.ts'
import type { PassbookCheckOutputs } from '../../../src/scorer/types.ts'
// M7: the phone's signed borrowing rules are a valid src BorrowerPolicy; a negotiated term sheet
// is accepted only when it follows the agreement, names the check this phone opened and carries
// the lender's approvals under its own signed policy; the phone countersigns it with the party
// key, nothing locks before that, and the lender's governance decisions are kept only when signed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mnemonicToSeedSync } from '@scure/bip39'
import { hashObject, keyPairFromLabel, signHash, verifyHash, verifyObject, type Hex } from '../../../src/core/crypto.ts'
import { MICRO_PER_USDT } from '../../../src/core/money.ts'
import { approvalStatus, approve } from '../../../src/market/approvals.ts'
import type { NegotiationMessage, Position } from '../../../src/market/negotiate.ts'
import { appendMessage, messageHash, negotiationId } from '../../../src/market/negotiate-engine.ts'
import { policyValid, signLenderPolicy } from '../../../src/market/policy.ts'
import { buildTermSheet, signTermSheet, termSheetHash } from '../../../src/market/termsheet.ts'
import { Oracle } from '../../../src/oracle/oracle.ts'
import { lenderDecisions, PhoneBorrower, type NegotiatedAcceptance, type PhoneAgentState } from '../src/agent/borrower.ts'
import type { PartySigner } from '../src/agent/ports.ts'
import { signPolicy, withinRules } from '../src/app/borrow-policy.ts'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../worklet/keys.js')
const { PartyKey } = require('../worklet/party.js')
const party = new PartyKey(rootFromSeed(mnemonicToSeedSync('legal winner thank year wave sausage worth useful legal winner thank yellow')))
const key = { pubkey: party.pubkey, btc: party.btcOutput(), signObject: async (v: object) => party.signObject(v), signPassbookHash: async (h: Hex) => party.signPassbookHash(h) } as unknown as PartySigner

const U = MICRO_PER_USDT
const L = keyPairFromLabel('m7-lender'), checker = keyPairFromLabel('m7-checker'), P = keyPairFromLabel('m7-platform')
const oracle = new Oracle(keyPairFromLabel('m7-oracle'), 10_000_000)
const lenderSigner = { kind: 'wdk' as const, pubkey: L.pubkey, signHash: async (h: Hex) => signHash(h, L.secretKey) }
const agreed: Position = { principal: 100 * U, apr_bps: 1100, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' }
const RUN = 'exec-m7-test-0001'

async function fixture(scorerOver: Record<string, unknown> = {}, run = RUN, immediate = false, commitment?: string, offeredCommitment?: string, askBody: Record<string, unknown> = {}, acceptBody: Record<string, unknown> = {}) {
  const lp = await signLenderPolicy(lenderSigner, { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 900, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: [], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [checker.pubkey], maker_checker_above: 500 * U }, issued_at: 1 })
  const borrowerSigner = { kind: 'wdk' as const, pubkey: party.pubkey, signHash: key.signPassbookHash }
  const nonce = 'aa'.repeat(32) as Hex
  const messages: NegotiationMessage[] = []
  await appendMessage(messages, borrowerSigner, 'ASK', { position: immediate ? agreed : { ...agreed, apr_bps: 900 }, nonce, lender_pk: L.pubkey, lender_policy_hash: commitment ?? hashObject(lp), max_rounds: 6, ...askBody }, negotiationId(party.pubkey, nonce))
  if (!immediate) await appendMessage(messages, lenderSigner, 'OFFER', { position: agreed, policy_hash: offeredCommitment ?? hashObject(lp) })
  const accepted = await appendMessage(messages, immediate ? lenderSigner : borrowerSigner, 'ACCEPT', { position: agreed, accepted_hash: messageHash(messages.at(-1)!), ...acceptBody })
  const acceptHash = messageHash(accepted)
  const score = unitOutcome({ v: 2, kind: 'passbook-check-outputs', recommendation: 'QUALIFY', income_band: '1000–2000 USDT/month', checks: [{ id: 'affordability', ok: true }], findings: [], lender_note: run, borrower_pk: party.pubkey, lender_pk: L.pubkey, purpose_id: messages[0].negotiation_id, bundle_hash: '56'.repeat(32), loan_request: { principal: agreed.principal, fee: termInterest(agreed), term_blocks: agreed.term_blocks, grace_blocks: 5 }, asset_id: 'rgb:usdt', lender_requirements_hash: '78'.repeat(32) })
  const sheet = signTermSheet(buildTermSheet({
    agreed, negotiation: { id: messages[0].negotiation_id, accept_hash: acceptHash }, borrower_pk: party.pubkey, lender_pk: L.pubkey, platform_pk: P.pubkey,
    asset_id: 'rgb:usdt', oracle_quote: oracle.quote(300), grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
    scorer: { provider: score.descriptor.provider, scorer_id: score.descriptor.scorer_id, code_measurement: score.descriptor.code_measurement, contract_hash: score.descriptor.contract_hash, trust: score.descriptor.trust, result_hash: scorerResultHash(score), fallback: false, recommendation: 'QUALIFY', evidence: evidenceDigest(score), ...scorerOver } as never,
    consent_hash: '12'.repeat(32), salt: '34'.repeat(32),
  }), 'lender', L.secretKey)
  const id = termSheetHash(sheet)
  const payload = { offer_id: `${L.pubkey}:usdt-30`, terms: sheet.terms, terms_hash: id, termsheet: sheet, lender_approvals: [approve(L, sheet, 'lender')], lender_policy: lp }
  const n: NegotiatedAcceptance = { agreed, accept_hash: acceptHash, messages, maker_checker_above_micro: Number.MAX_SAFE_INTEGER, check: { execution_id: run, operator_pk: 'cc'.repeat(32) as Hex, commitment: null, recommendation: 'QUALIFY', outcome: score } }
  return { lp, sheet, id, payload, n }
}

function agent(state: PhoneAgentState) {
  return new PhoneBorrower(key, { note: async () => ({}) } as never, {} as never, {} as never, {} as never, 'rgb:usdt', state)
}

test('the signed rules are a valid src BorrowerPolicy, and an agreement past them is caught', async () => {
  const p = await signPolicy(key, { asset_id: 'rgb:usdt', principal: 100 * U, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: 30 }, 1_800_000_000)
  assert.equal(p.owner_pk, party.pubkey)
  assert.ok(verifyObject(p, party.pubkey))
  assert.ok(policyValid(p), 'src accepts the policy the phone signed')
  assert.equal(withinRules(p, agreed), null)
  assert.equal(withinRules(p, { ...agreed, apr_bps: 1300 }), 'APR')
  assert.equal(withinRules(p, { ...agreed, ltv_bps: 5100 }), 'LTV')
  assert.equal(withinRules(p, { ...agreed, principal: 101 * U }), 'amount')
})

test('a negotiated sheet passes only when it follows the agreement, the opened check and the lender policy', async () => {
  const { payload, n, lp } = await fixture()
  const a = agent({ loans: {}, labels: {} })
  assert.deepEqual(a.sheetProblems(payload.terms, payload as never, n), [])
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, check: { ...n.check!, outcome: undefined } }).join(), /signed check outcome is missing/)
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, agreed: { ...agreed, apr_bps: 1000 } }).join(), /term sheet/)
  assert.match(a.sheetProblems(payload.terms, { ...payload, lender_approvals: [] } as never, n).join(), /no lender approval/)
  assert.match(a.sheetProblems(payload.terms, { ...payload, lender_policy: { ...lp, min_apr_bps: 100 } } as never, n).join(), /lender policy/)
  // above the lender's own maker-checker threshold a second, listed key must approve
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, maker_checker_above_micro: 50 * U }).join(), /lender approvals incomplete: 1\/2/)
})

test('an immediate signed ASK to ACCEPT binds the lender policy without requiring an OFFER', async () => {
  const { payload, n } = await fixture({}, RUN, true)
  const a = agent({ loans: {}, labels: {} })
  assert.deepEqual(n.messages.map((m) => m.type), ['ASK', 'ACCEPT'])
  assert.deepEqual(a.sheetProblems(payload.terms, payload as never, n), [])
  const tampered = n.messages.map((m, i) => i === 0 ? { ...m, body: { ...m.body, lender_policy_hash: 'ef'.repeat(32) } } : m)
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, messages: tampered }).join(), /lender policy/)
  const missing = n.messages.map((m, i) => i === 0 ? { ...m, body: { ...m.body, lender_policy_hash: undefined } } : m)
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, messages: missing }).join(), /lender policy/)
  const wrongRole = n.messages.map((m, i) => i === 0 ? { ...m, from_pk: L.pubkey } : m)
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, messages: wrongRole }).join(), /lender policy/)
  const badSignature = n.messages.map((m, i) => i === 1 ? { ...m, sig: '00'.repeat(64) as Hex } : m)
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, messages: badSignature }).join(), /lender policy/)
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, messages: n.messages.slice(0, 1) }).join(), /lender policy/)
  assert.match(a.sheetProblems(payload.terms, payload as never, { ...n, accept_hash: 'ef'.repeat(32) as Hex }).join(), /different ACCEPT/)
})

test('authenticated policy commitments must match the revealed policy and each other', async () => {
  const a = agent({ loans: {}, labels: {} })
  for (const f of [await fixture({}, RUN, true, 'ef'.repeat(32)), await fixture({}, RUN, false, undefined, 'ef'.repeat(32)), await fixture({}, RUN, true, ''), await fixture({}, RUN, true, undefined, undefined, { lender_pk: checker.pubkey }), await fixture({}, RUN, true, undefined, undefined, {}, { accepted_hash: 'ef'.repeat(32) })]) {
    assert.match(a.sheetProblems(f.payload.terms, f.payload as never, f.n).join(), /lender policy/)
  }
  const f = await fixture({}, RUN, true)
  const { sig: _sig, ...policy } = f.lp
  const replaced = await signLenderPolicy(lenderSigner, { ...policy, issued_at: 2 })
  assert.match(a.sheetProblems(f.payload.terms, { ...f.payload, lender_policy: replaced } as never, f.n).join(), /lender policy/)
})

test('the phone countersigns exactly this sheet after its lock, and nothing locks before', async () => {
  const { sheet, id, payload, lp } = await fixture()
  const state: PhoneAgentState = { loans: { [id]: { terms: sheet.terms, lender_pk: L.pubkey, termsheet: sheet, lender_approvals: payload.lender_approvals, lender_policy: lp } }, labels: {} }
  const a = agent(state)
  await assert.rejects(a.lockAndSplit(id), /approve the term sheet before locking/)
  const approval = await a.approveTermSheet(id)
  const signed = state.loans[id].termsheet!
  assert.ok(verifyHash(signed.signatures.borrower!, id, party.pubkey), 'the borrower signature is over the terms hash')
  assert.ok(verifyObject(approval, party.pubkey))
  assert.equal(approval.termsheet_hash, id)
  const status = approvalStatus(signed, [...payload.lender_approvals, approval], lp, Number.MAX_SAFE_INTEGER)
  assert.ok(status.complete, status.problems.join())
  assert.equal(await a.approveTermSheet(id), approval, 'a second call returns the same approval')
})

test("the lender's governance decisions are kept only when signed and about this loan", () => {
  const node = keyPairFromLabel('m7-gate')
  const entry = (loan: Hex | null, result: string) => {
    const body = { v: 1, domain: 'passbook-decision-log-v1', seq: 0, prev_hash: null, at: 1, kind: 'sanctions-result', action_id: null, loan_id: loan, policy_version: 1, input_hashes: {}, decided_by: { kind: 'service' }, result, detail: null, node_pk: node.pubkey }
    const hash = hashObject(body)
    return { ...body, hash, sig: signHash(hash, node.secretKey) }
  }
  const id = 'aa'.repeat(32) as Hex
  const good = entry(id, 'clear')
  const kept = lenderDecisions({ lender_decisions: [good, { ...entry(id, 'clear'), result: 'edited' }, entry('bb'.repeat(32) as Hex, 'clear'), entry(null, 'approved')] }, id)
  assert.deepEqual(kept.map((e) => e.result), ['clear', 'approved'])
  assert.deepEqual(lenderDecisions({}, id), [])
})

test('checking a loan on the phone ticks every link and flags a lock that does not commit the terms', async () => {
  const { sheet, id, payload, lp } = await fixture()
  const { checkLoan } = await import('../src/app/loan-check.ts')
  const { escrowFor, partiesOf } = await import('../../../src/escrow/escrow.ts')
  const { opReturnScript } = await import('../../../src/chain/types.ts')
  const state: PhoneAgentState = { loans: { [id]: { terms: sheet.terms, lender_pk: L.pubkey, termsheet: sheet, lender_approvals: payload.lender_approvals, lender_policy: lp, lock: { txid: '77'.repeat(32) as Hex, vout: 0 } } }, labels: {} }
  const escrow = escrowFor(partiesOf(sheet.terms))
  const lockTx = (commit: Hex) => ({ txid: '77'.repeat(32), height: 301, inputs: [], outputs: [{ value: sheet.terms.collateral_sats, script: escrow.script }, { value: 0, script: opReturnScript(commit) }] })
  const make = (commit: Hex, unspent: boolean) => new PhoneBorrower(key, { note: async () => ({}), loan: async () => ({ status: 'locked' }) } as never, {} as never, {
    getHeight: async () => 310, getTx: async () => lockTx(commit), utxos: async () => (unspent ? [{ txid: '77'.repeat(32), vout: 0, value: sheet.terms.collateral_sats, height: 301 }] : []),
  } as never, {} as never, 'rgb:usdt', state)
  await make(id, true).approveTermSheet(id)
  const ok = await checkLoan(make(id, true), id, state.loans[id])
  const failed = ok.ticks.filter((x) => x.ok === false).map((x) => x.id)
  assert.deepEqual(failed, [], JSON.stringify(ok.ticks))
  for (const want of ['terms-hash', 'sheet-bound', 'sheet-signed', 'approvals', 'lock', 'lock-commits', 'escrow', 'escrow-unspent']) assert.ok(ok.ticks.some((x) => x.id === want && x.ok === true), want)
  const bad = await checkLoan(make('ee'.repeat(32) as Hex, false), id, state.loans[id])
  assert.deepEqual(bad.ticks.filter((x) => x.ok === false).map((x) => x.id), ['lock-commits', 'escrow-unspent'])
})

test('the negotiated application names the forwarded check by its KEY hash, with the consent and transcript, as applyChecked does', async () => {
  const sent: { kind: number; payload: Record<string, unknown>; to: Hex }[] = []
  const relay = { send: async (kind: number, payload: Record<string, unknown>, to: Hex) => { sent.push({ kind, payload, to }) } }
  const k = { ...key, signPassbookHash: async (h: Hex) => party.signPassbookHash(h) } as PartySigner
  const a = new PhoneBorrower(k, { note: async () => ({}) } as never, relay as never, {} as never, {} as never, 'rgb:usdt', { loans: {}, labels: {} })
  const offer = { id: `${L.pubkey}:usdt-30`, lender_pk: L.pubkey, payload: { term_blocks: 30 } }
  const negotiation = [{ type: 'ASK', negotiation_id: 'aa'.repeat(32) }] as unknown as NegotiationMessage[]
  const consent = { v: 1, domain: 'passbook-consent-v1' } as never
  await a.applyNegotiated(offer as never, 100 * U, { negotiation, consent, check_key: 'ab'.repeat(32) as Hex })
  const { KIND } = await import('../../../src/market/kinds.ts')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, KIND.APPLICATION)
  assert.equal(sent[0].to, L.pubkey)
  const p = sent[0].payload
  assert.equal(p.check_key, 'ab'.repeat(32))
  assert.equal(p.consent, consent)
  assert.equal(p.negotiation, negotiation)
  assert.equal(p.sandbox_result, null)
  assert.equal(p.attestation, null)
  assert.deepEqual(p.disclosed_inflows, [])
  assert.ok(!('disclosure_items' in p) && !('inflow_proofs' in p), 'no disclosures travel')
  assert.ok(verifyHash((p.outstanding_statement as { sig: Hex }).sig, hashObject({ outstanding_micro: 0 }), party.pubkey))
})

test('with the opened outcome, the sheet must lend exactly the scored loan, from the same scorer, naming no receipt', async () => {
  const { sheet, payload, n } = await fixture()
  const a = agent({ loans: {}, labels: {} })
  const t = sheet.terms
  const outcome = (loan: { principal: number; fee: number }, fallback = false) => unitOutcome({
    ...(n.check!.outcome!.kind === 'passbook-signed' ? n.check!.outcome!.result.outputs : {}),
    loan_request: { ...loan, term_blocks: t.maturity_height - t.open_height, grace_blocks: t.grace_blocks }, asset_id: t.asset_id,
  } as PassbookCheckOutputs, fallback)
  const scored = { principal: t.principal, fee: t.fee }
  const own = (ps: string[]) => ps.filter((p) => /assessed|another scorer|receipt|scored loan/.test(p))
  assert.deepEqual(own(a.sheetProblems(t, payload as never, { ...n, check: { ...n.check!, outcome: outcome(scored) } })), [])
  assert.match(a.sheetProblems(t, payload as never, { ...n, check: { ...n.check!, outcome: outcome({ ...scored, fee: t.fee + 1 }) } }).join(), /scorer assessed/)
  assert.match(a.sheetProblems(t, payload as never, { ...n, check: { ...n.check!, outcome: outcome(scored, true) } }).join(), /another scorer/)
  const withReceipt = { ...payload, termsheet: { ...sheet, scorer: { ...sheet.scorer, check_receipt: { contract_id: 'rgb:x', commitment: '01'.repeat(32), operator_pk: 'cc'.repeat(32) } } } }
  assert.match(a.sheetProblems(t, withReceipt as never, n).join(), /check receipt this phone does not hold|term sheet/)
})

test('the sheet must name the exact signed local evidence this phone opened (the digest the lock commits)', async () => {
  const { payload, n } = await fixture()
  const A = n.check!.outcome!
  assert.equal(A.kind, 'passbook-signed')
  if (A.kind !== 'passbook-signed') throw new Error('expected local result')
  const B = unitOutcome({ ...A.result.outputs, lender_note: 'another local run' })
  const a = agent({ loans: {}, labels: {} })
  const evidence = (ps: string[]) => ps.filter((p) => /scorer result|evidence/.test(p))
  assert.deepEqual(evidence(a.sheetProblems(payload.terms, payload as never, n)), [])
  const other = evidence(a.sheetProblems(payload.terms, payload as never, { ...n, check: { ...n.check!, outcome: B } }))
  assert.ok(other.some((p) => /different scorer result/.test(p)) && other.some((p) => /evidence digest does not match/.test(p)), other.join())
})

test('a lender that negotiates is shortlisted even when it asks for income: it checks income in the credit check', async () => {
  const { shortlist } = await import('../src/app/borrow-policy.ts')
  const { viewOffers } = await import('../src/app/offers.ts')
  const p = await signPolicy(key, { asset_id: 'rgb:usdt', principal: 500 * U, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: 30 })
  const negotiation = { v: 1, lender_pk: L.pubkey, policy_hash: 'ab'.repeat(32), asset_id: 'rgb:usdt', min_principal: 100 * U, max_principal: 5000 * U, term_blocks: { min: 10, max: 60 }, accepted_settlements: ['cosign-rgb'], min_scorer_trust: 'dev-inprocess', max_rounds: 3 }
  const payload = { asset_id: 'rgb:usdt', min: 100 * U, max: 5000 * U, apr_bps: 1200, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: [5000, 5500], requirements: { inflow_months: 3, affordability: true }, expires_height: 1000 }
  const negotiable = { id: `${L.pubkey}:n`, lender_pk: L.pubkey, payload: { ...payload, negotiation } } as never
  const legacy = { id: `${L.pubkey}:l`, lender_pk: L.pubkey, payload } as never
  const r = shortlist([negotiable, legacy], p, { price_cents: 10_000_000, step: 0, allowed_ltv_bps: 5000 })
  assert.equal(r.ranked.length, 1)
  assert.match(r.ranked[0].why ?? '', /3 months of income in the credit check/)
  assert.deepEqual(r.left.map((x) => x.why), ['does not negotiate over Nostr'])
  const v = viewOffers([negotiable, legacy], 500 * U, 1000 * U)
  assert.deepEqual(v.map((o) => o.fits), [true, false])
})
