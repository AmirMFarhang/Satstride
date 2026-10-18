// A consumed Nostr split request must survive indexer lag and process restarts.
// Real signed sheets, approvals and Bitcoin PSBTs; no native wallet or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashObject, keyPairFromLabel, signObject, verifyHash, verifyObject, type Hex } from '../../../src/core/crypto.ts'
import { buildEscrowSpend, escrowFor, partiesOf, signLeaf, splitLocktime, splitOutputs } from '../../../src/escrow/escrow.ts'
import { approve } from '../../../src/market/approvals.ts'
import { KIND } from '../../../src/market/kinds.ts'
import type { SignRequestPayload } from '../../../src/market/messages.ts'
import { buildTermSheet, signTermSheet, termSheetHash } from '../../../src/market/termsheet.ts'
import { Oracle } from '../../../src/oracle/oracle.ts'
import { canResumeApprovedPayout, PhoneLender, type PhoneLenderState } from '../src/agent/lender.ts'
import type { PhoneLoanRecord } from '../src/agent/platform.ts'

const B = keyPairFromLabel('funding-resume-borrower'), L = keyPairFromLabel('funding-resume-lender'), P = keyPairFromLabel('funding-resume-platform')
const LOCK = '11'.repeat(32) as Hex, PAYOUT = '22'.repeat(32) as Hex
const sheet = signTermSheet(buildTermSheet({
  agreed: { principal: 10_000_000, apr_bps: 900, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' },
  negotiation: { id: '33'.repeat(32), accept_hash: '44'.repeat(32) }, borrower_pk: B.pubkey, lender_pk: L.pubkey, platform_pk: P.pubkey,
  asset_id: 'rgb:funding-resume', oracle_quote: new Oracle(P, 10_000_000).quote(100), grace_blocks: 5, ladder_step: 0,
  prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
  scorer: { provider: 'compex', scorer_id: 'compex:unit', code_measurement: `sha256:${'55'.repeat(32)}`, contract_hash: '66'.repeat(32), trust: 'software-evidence', result_hash: '77'.repeat(32), fallback: false, recommendation: 'QUALIFY', evidence: { kind: 'compex-dsse', envelope_sha256: '88'.repeat(32), evidence_root_hash: '99'.repeat(32), execution_id: 'unit-funding-resume' } },
  consent_hash: 'aa'.repeat(32), salt: 'bb'.repeat(32),
}), 'lender', L.secretKey)
const ID = termSheetHash(sheet), terms = sheet.terms, parties = partiesOf(terms)
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v))

function request(noncanonical = false): SignRequestPayload {
  const outputs = splitOutputs(terms)
  if (noncanonical) { outputs[0].value++; outputs[1].value-- }
  const split = buildEscrowSpend({ escrow: { txid: LOCK, vout: 0, value: terms.collateral_sats }, parties, leaf: 'A', outputs, locktime: splitLocktime(terms) })
  signLeaf(split, parties, 'A', B.secretKey)
  return { purpose: 'split', loan_id: ID, terms_hash: ID, psbt_base64: split.toBase64(), disbursement_invoice: 'rgb:original-borrower-invoice', termsheet: signTermSheet(sheet, 'borrower', B.secretKey), borrower_approval: approve(B, sheet, 'borrower') }
}

function fixture() {
  const counts = { receive: 0, send: 0, indexLock: 0, indexFunded: 0, fundedMessage: 0, seal: 0 }
  const controls = { failures: 0, lockError: '(422): lock transaction not confirmed', unspent: true, spentAfterIndex: false, asset: terms.asset_id, ambiguous: false }
  const record: PhoneLoanRecord = { status: 'pending' }
  let persisted: PhoneLenderState
  const state: PhoneLenderState = { loans: { [ID]: { terms, borrower_pk: B.pubkey, accepted_at: 1, checks: [], memo: '', fund_approved: true, termsheet: sheet, lender_approvals: [approve(L, sheet, 'lender')] } }, declined: [] }
  persisted = copy(state)
  const key = { pubkey: L.pubkey, signObject: async (v: object) => { if ('domain' in v && v.domain === 'passbook-validated-payout-request-v1') counts.seal++; return signObject(v, L.secretKey) } }
  const platform = {
    note: async () => ({}), loan: async () => copy(record),
    recordLock: async (id: Hex, txid: Hex) => {
      counts.indexLock++; assert.equal(id, ID); assert.equal(txid, LOCK)
      if (controls.failures-- > 0) throw new Error(controls.lockError)
      Object.assign(record, { status: 'locked', lock_txid: LOCK, lock_vout: 0 })
      if (controls.spentAfterIndex) controls.unspent = false
      return copy(record)
    },
    recordFunded: async (id: Hex, txid: Hex, sig: Hex) => {
      counts.indexFunded++; assert.equal(record.status, 'locked'); assert.equal(id, ID); assert.equal(txid, PAYOUT)
      assert.ok(verifyHash(sig, hashObject({ loan_id: ID, disbursement_txid: PAYOUT }), L.pubkey))
      Object.assign(record, { status: 'open', disbursement_txid: PAYOUT }); return copy(record)
    },
    repaymentWatch: async () => ({ invoice: 'rgb:repayment', recipient_id: 'repay-recipient', backup: 'synthetic-test-backup', password: 'synthetic-test-password' }),
  }
  const chain = {
    getTx: async (txid: Hex) => txid === LOCK ? { txid, height: 101, inputs: [], outputs: [{ script: escrowFor(parties).script, value: terms.collateral_sats }, { script: `6a20${ID}`, value: 0 }] } : null,
    utxos: async () => controls.unspent ? [{ txid: LOCK, vout: 0, value: terms.collateral_sats, height: 101 }] : [],
  }
  const rgb = {
    decode: async () => ({ assetId: controls.asset }),
    send: async (p: { invoice: string; assetId: string; amount: number }) => {
      counts.send++; assert.equal(p.invoice, 'rgb:original-borrower-invoice'); assert.equal(p.assetId, terms.asset_id); assert.equal(p.amount, terms.principal)
      if (controls.ambiguous) throw new Error(`AMBIGUOUS_SEND:${JSON.stringify({ txid: PAYOUT, batchTransferIdx: 7 })} synthetic proxy timeout`)
      return { txid: PAYOUT }
    },
    status: async () => ({ state: 'unknown', rgbStatus: null }),
    refresh: async () => {}, transfers: async () => [{ idx: 1, kind: 'Send', status: 'Settled', txid: PAYOUT, recipientId: null, amount: terms.principal }],
    witnessInvoice: async () => ({ invoice: 'rgb:iou', recipientId: 'iou-recipient' }),
  }
  const relay = {
    receive: async () => { counts.receive++; assert.equal(counts.receive, 1, 'the original relay event is consumed once'); return { payload: request() } },
    send: async (kind: number) => { if (kind === KIND.FUNDED) counts.fundedMessage++ },
  }
  const repay = { keys: async () => ({ account_xpub_vanilla: 'tpub-unit-vanilla', account_xpub_colored: 'tpub-unit-colored', master_fingerprint: '12345678' }), restore: async () => {} }
  const agent = (s: PhoneLenderState = state) => new PhoneLender(key as never, platform as never, relay as never, chain as never, rgb as never, repay as never, terms.asset_id, s, () => {}, async () => { persisted = copy(s) })
  return { state, counts, controls, record, agent, restored: () => copy(persisted) }
}

test('index lag is retried only as metadata: one consumed request, one principal send', async () => {
  const f = fixture(); f.controls.failures = 1
  await f.agent().fund(ID)
  assert.equal(f.counts.indexLock, 2)
  assert.equal(f.counts.receive, 1)
  assert.equal(f.counts.send, 1)
  assert.equal(f.counts.fundedMessage, 1)
})

test('after exhausted index retries a restart reuses the saved validated split, not another relay request', async () => {
  const f = fixture(); f.controls.failures = 3
  await assert.rejects(f.agent().fund(ID), /lock transaction not confirmed/)
  const restored = f.restored()
  assert.ok(restored.loans[ID].disbursement_request)
  assert.ok(verifyObject(restored.loans[ID].disbursement_request!, L.pubkey))
  assert.equal(restored.loans[ID].disbursement_attempted, undefined)
  assert.equal(f.counts.send, 0)
  const restarted = f.agent(restored)
  await restarted.fund(ID)
  assert.equal(f.counts.receive, 1)
  assert.equal(f.counts.send, 1)
  assert.equal(restored.loans[ID].disbursement_txid, PAYOUT)
  await assert.rejects(restarted.fund(ID), /disbursement already attempted/)
  assert.equal(f.counts.send, 1)
  assert.equal(f.counts.seal, 1, 'a cached payload is never silently resealed')
})

test('the saved seal authenticates same-asset recipient, signature, lender, loan and domain before reuse', async () => {
  const f = fixture(); f.controls.failures = 1; f.controls.lockError = '(403): signature refused'
  await assert.rejects(f.agent().fund(ID), /signature refused/)
  const base = f.restored()
  const attacks: ((s: PhoneLenderState) => void)[] = [
    (s) => { s.loans[ID].disbursement_request!.request.disbursement_invoice = 'rgb:other-recipient-same-asset' },
    (s) => { s.loans[ID].disbursement_request!.sig = '00'.repeat(64) },
    (s) => { s.loans[ID].disbursement_request = signObject({ ...s.loans[ID].disbursement_request!, lender_pk: B.pubkey }, B.secretKey) },
    (s) => { s.loans[ID].disbursement_request = signObject({ ...s.loans[ID].disbursement_request!, loan_id: 'ee'.repeat(32) }, L.secretKey) },
    (s) => { s.loans[ID].disbursement_request = signObject({ ...s.loans[ID].disbursement_request!, domain: 'another-domain' }, L.secretKey) as never },
    (s) => { s.loans[ID].disbursement_request = signObject({ ...s.loans[ID].disbursement_request!, v: 2 }, L.secretKey) as never },
    (s) => { s.loans[ID].disbursement_request = request() as never }, // unreleased raw-cache format: fail closed
  ]
  for (const attack of attacks) {
    const s = copy(base); attack(s)
    assert.equal(canResumeApprovedPayout(s.loans[ID], ID), false)
    await assert.rejects(f.agent(s).fund(ID), /saved payout request seal/)
  }
  assert.equal(f.controls.asset, terms.asset_id, 'the alternate recipient uses the same asset; asset checking alone cannot protect it')
  assert.equal(f.counts.seal, 1, 'tampered or unsealed caches are never signed again')
  assert.equal(f.counts.receive, 1)
  assert.equal(f.counts.send, 0)
})

test('saved requests are revalidated for loan, template, borrower approval, lender approval and invoice asset', async () => {
  const f = fixture(); f.controls.failures = 1; f.controls.lockError = '(403): signature refused'
  await assert.rejects(f.agent().fund(ID), /signature refused/)
  assert.equal(f.counts.indexLock, 1, 'authentication failures are not retried')
  const base = f.restored()
  const attacks: ((s: PhoneLenderState) => void)[] = [
    (s) => { s.loans[ID].disbursement_request!.request.loan_id = 'ee'.repeat(32) },
    (s) => { s.loans[ID].disbursement_request!.request.terms_hash = 'ee'.repeat(32) },
    (s) => { s.loans[ID].disbursement_request!.request.psbt_base64 = request(true).psbt_base64 },
    (s) => { s.loans[ID].disbursement_request!.request.borrower_approval!.sig = '00'.repeat(64) },
    (s) => { s.loans[ID].disbursement_request!.request.termsheet!.signatures.borrower = '00'.repeat(64) },
    (s) => { s.loans[ID].lender_approvals = [] },
  ]
  for (const attack of attacks) {
    const s = copy(base); attack(s)
    // A valid local seal is necessary but never replaces inner approval/PSBT validation.
    s.loans[ID].disbursement_request = signObject(s.loans[ID].disbursement_request!, L.secretKey)
    await assert.rejects(f.agent(s).fund(ID))
  }
  f.controls.asset = 'rgb:wrong-asset'
  await assert.rejects(f.agent(copy(base)).fund(ID), /invoice names another asset/)
  assert.equal(f.counts.receive, 1)
  assert.equal(f.counts.send, 0)
})

test('a saved request never overrides revoked approval, spent collateral, a closed loan or a concurrent indexed payout', async () => {
  const f = fixture(); f.controls.failures = 1; f.controls.lockError = '(422): lock rejected'
  await assert.rejects(f.agent().fund(ID), /lock rejected/)
  assert.equal(f.counts.indexLock, 1, 'policy failures are not retried')
  const base = f.restored()
  const revoked = copy(base); revoked.loans[ID].fund_approved = false
  await assert.rejects(f.agent(revoked).fund(ID), /person's OK/)
  f.controls.unspent = false
  await assert.rejects(f.agent(copy(base)).fund(ID), /no longer locked/)
  f.controls.unspent = true; f.record.status = 'refunded'
  await assert.rejects(f.agent(copy(base)).fund(ID), /platform has the loan as refunded/)
  Object.assign(f.record, { status: 'open', lock_txid: LOCK, lock_vout: 0, disbursement_txid: PAYOUT })
  await assert.rejects(f.agent(copy(base)).fund(ID), /platform has the loan as open/)
  assert.equal(f.counts.send, 0)
})

test('the escrow is checked again after indexing and before any principal send', async () => {
  const f = fixture(); f.controls.spentAfterIndex = true
  await assert.rejects(f.agent().fund(ID), /no longer locked/)
  assert.equal(f.counts.indexLock, 1)
  assert.equal(f.counts.send, 0)
})

test('attempted and ambiguous sends remain non-repeatable even with a saved request and after restart', async () => {
  const f = fixture(); f.controls.ambiguous = true
  await assert.rejects(f.agent().fund(ID), /AMBIGUOUS_SEND/)
  const saved = f.restored()
  assert.equal(saved.loans[ID].disbursement_pending, PAYOUT)
  assert.equal(saved.loans[ID].disbursement_attempted, true)
  const restarted = f.agent(saved)
  await assert.rejects(restarted.fund(ID), /disbursement already attempted/)
  await assert.rejects(restarted.resumePayout(ID), /Can't tell yet/)
  assert.equal(f.counts.receive, 1)
  assert.equal(f.counts.send, 1)
  for (const field of ['disbursement_pending', 'disbursement_txid'] as const) {
    const s = f.restored(); delete s.loans[ID].disbursement_attempted; s.loans[ID][field] = PAYOUT
    await assert.rejects(f.agent(s).fund(ID), /disbursement already attempted/)
  }
  assert.equal(f.counts.send, 1)
})

test('concurrent retries of the same saved request can initiate at most one principal send', async () => {
  const f = fixture(); f.controls.failures = 1; f.controls.lockError = '(422): lock rejected'
  await assert.rejects(f.agent().fund(ID), /lock rejected/)
  const state = f.restored()
  const [a, b] = await Promise.allSettled([f.agent(state).fund(ID), f.agent(state).fund(ID)])
  assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(f.counts.receive, 1)
  assert.equal(f.counts.send, 1)
})

test('the resume action is available only for the same saved request approved before any attempted payout', async () => {
  const f = fixture(); f.controls.failures = 1; f.controls.lockError = '(403): signature refused'
  assert.equal(canResumeApprovedPayout(f.state.loans[ID], ID), false)
  await assert.rejects(f.agent().fund(ID), /signature refused/)
  const ready = f.restored().loans[ID]
  assert.equal(canResumeApprovedPayout(ready, ID), true)
  assert.equal(canResumeApprovedPayout(ready, 'ee'.repeat(32)), false)
  for (const change of [
    { fund_approved: false }, { lock: undefined }, { disbursement_request: undefined },
    { disbursement_attempted: true }, { disbursement_pending: PAYOUT }, { disbursement_txid: PAYOUT },
    { release_txid: 'ff'.repeat(32) }, { cancelled: 'refunded' },
  ]) assert.equal(canResumeApprovedPayout({ ...ready, ...change }, ID), false)
})
