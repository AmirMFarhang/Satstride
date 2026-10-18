// G2b part 1: the joint (v3, rgb-onchain-joint) loan orchestration between two
// separate parties, over #56's native adapter port. The adapter here is an
// in-memory fake (test/joint-fakes.ts), not a native proof; these tests prove
// the order, the per-party checks and the refusals, not chain or RGB validity.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hashObject, sha256Hex } from '../src/core/crypto.js'
import { JointBorrower } from '../src/joint/borrower.js'
import { JointLender } from '../src/joint/lender.js'
import { sealJointMessage, type JointMessage } from '../src/joint/messages.js'
import { FileJointStore, JointRefused, MemoryJointStore, type JointStore } from '../src/joint/ports.js'
import { ONCHAIN_NATIVE_REVISION, type OnchainDecodedSummary, type OnchainEnforcementPreparation, type OnchainJointIntent } from '../src/joint/contract-stub.js'
import type { JointPartyDeps } from '../src/joint/session.js'
import { agreementFor, borrowerFunding, borrowerKey, decodePsbt, encodePsbt, FakeAdapter, FakeArtifacts, FakeBuilder, FakeChain, FakeGate, FakeSigner, jointTerms, lenderKey, strangerKey } from './joint-fakes.js'

function world(opts: { store?: () => JointStore; terms?: ReturnType<typeof jointTerms> } = {}) {
  const chain = new FakeChain()
  let clock = 1_800_000_000
  const now = () => clock
  const agreement = agreementFor(opts.terms ?? jointTerms())
  const bGate = new FakeGate('borrower', now), lGate = new FakeGate('lender', now)
  const bAdapter = new FakeAdapter('borrower', 'wallet-b', chain, bGate.key.pubkey, 'receive-b')
  const lAdapter = new FakeAdapter('lender', 'wallet-l', chain, lGate.key.pubkey, 'receive-l')
  const bSigner = new FakeSigner('borrower'), lSigner = new FakeSigner('lender')
  const bBuilder = new FakeBuilder(bAdapter, 'borrower'), lBuilder = new FakeBuilder(lAdapter, 'lender')
  const bStore = opts.store?.() ?? new MemoryJointStore(), lStore = opts.store?.() ?? new MemoryJointStore()
  const options = { activation: 'isolated-regtest-acceptance' as const, now }
  const bDeps: JointPartyDeps = { key: borrowerKey, agreement, local: { role: 'borrower', wallet_id: 'wallet-b', receive_id: 'receive-b' }, adapter: bAdapter, gate: bGate, signer: bSigner, artifacts: new FakeArtifacts(bAdapter), builder: bBuilder, store: bStore, options }
  const lDeps: JointPartyDeps = { key: lenderKey, agreement, local: { role: 'lender', wallet_id: 'wallet-l', receive_id: 'receive-l' }, adapter: lAdapter, gate: lGate, signer: lSigner, artifacts: new FakeArtifacts(lAdapter), builder: lBuilder, store: lStore, options }
  return { chain, agreement, bGate, lGate, bAdapter, lAdapter, bSigner, lSigner, bBuilder, lBuilder, bDeps, lDeps, tick: (s: number) => { clock += s } }
}

async function parties(w: ReturnType<typeof world>) {
  return { B: await new JointBorrower(w.bDeps).open(), L: await new JointLender(w.lDeps).open() }
}

/** Runs origination to settled on both sides; returns the messages exchanged. */
async function originate(w: ReturnType<typeof world>, B: JointBorrower, L: JointLender) {
  const offer = await B.offerFunding(borrowerFunding())
  const [proposal] = await L.receive(offer)
  const [enforcement] = await B.receive(proposal)
  const [signature] = await L.receive(enforcement)
  const [broadcast] = await B.receive(signature)
  assert.deepEqual(await L.receive(broadcast), [])
  w.chain.mine()
  await B.settleOrigination(); await L.settleOrigination()
  return { offer, proposal, enforcement, signature, broadcast }
}

async function repay(w: ReturnType<typeof world>, B: JointBorrower, L: JointLender) {
  const proposal = await B.startRepayment()
  const [signature] = await L.receive(proposal)
  const [broadcast] = await B.receive(signature)
  await L.receive(broadcast)
  w.chain.mine()
  await B.settleRepayment(); await L.settleRepayment()
  return { proposal, signature, broadcast }
}

const refused = (code: string) => (e: unknown) => e instanceof JointRefused && e.code === code
const exports = (a: FakeAdapter) => a.calls.filter(c => c.startsWith('recordSignedExport'))

test('joint loan: one-transaction origination and repayment settle on both sides and close with natively verified evidence', async () => {
  const w = world()
  const { B, L } = await parties(w)
  const o = await originate(w, B, L)
  assert.equal(B.phase, 'origination:settled'); assert.equal(L.phase, 'origination:settled')
  // Enforcement (default + both liquidation templates) is recorded by the lender before its first funding export.
  const lc = w.lAdapter.calls
  assert.ok(lc.indexOf('recordEnforcement') < lc.indexOf('recordSignedExport:origination'))
  assert.deepEqual(exports(w.bAdapter).slice(0, 4), ['recordSignedExport:enforcement', 'recordSignedExport:enforcement', 'recordSignedExport:enforcement', 'recordSignedExport:origination'])
  // The borrower held the principal proof bytes before it verified anything, and took the consignment at the end.
  const bc = w.bAdapter.calls
  assert.ok(bc.indexOf('importArtifact') < bc.indexOf('verifyProposal'))
  assert.equal(bc.at(-1), 'handoverReceive')
  assert.equal((o.signature.body as { action: string }).action, 'origination')

  await repay(w, B, L)
  assert.equal(L.snapshot.statuses[L.snapshot.repayment!.operation_id].phase, 'settled', 'the lender received the debt consignment')
  const { evidence, verification } = await B.evidence()
  assert.equal(verification.ok, true)
  assert.equal(evidence.repayment.intent.action === 'repayment' && evidence.repayment.intent.collateral.txid, evidence.funding.txid)
  const lenderView = await L.evidence()
  assert.equal(hashObject(lenderView.evidence), hashObject(evidence), 'both parties derive the same portable evidence')
  assert.equal(B.phase, 'closed')
  // Each party's gate authorized every one of its exports, bound to that operation.
  assert.equal(w.bGate.requests.length, 5); assert.equal(w.lGate.requests.length, 2)
  assert.deepEqual(B.snapshot.refusals, []); assert.deepEqual(L.snapshot.refusals, [])
})

test('joint loan: the borrower refuses a lender proposal that is not the agreed principal to its own receive, before any signature', async () => {
  const cases: [string, (w: ReturnType<typeof world>) => void][] = [
    ['JOINT_WRONG_DESTINATION', w => { w.lBuilder.tamper.origination = s => { s.outputs[2].script_pubkey = `5120${sha256Hex('lender-own')}` } }],
    ['JOINT_WRONG_AMOUNT', w => { w.lBuilder.tamper.origination = s => { s.outputs[2].allocations[0].amount = '99000000' } }],
    ['JOINT_WRONG_ASSET', w => { w.lBuilder.tamper.origination = s => { s.outputs[2].allocations[0].asset = { ...s.outputs[2].allocations[0].asset, contract_id: 'rgb:other' } } }],
    ['JOINT_WRONG_VALUE', w => { w.lBuilder.tamper.origination = s => { s.outputs[1].value_sats = '200000'; s.outputs[4].value_sats = (BigInt(s.outputs[4].value_sats) + 50000n).toString() } }],
    ['JOINT_HIDDEN_RGB', w => { w.lBuilder.tamper.origination = s => { s.outputs[3].allocations.push({ asset: s.outputs[2].allocations[0].asset, amount: '1' }) } }],
    ['JOINT_SIGHASH', w => { w.lBuilder.tamper.origination = s => { (s.inputs[1] as { sighash: string }).sighash = 'SINGLE|ANYONECANPAY' } }],
    ['JOINT_LAYOUT', w => { w.lBuilder.tamper.origination = s => { s.outputs.push({ vout: 5, value_sats: '1000', script_pubkey: `5120${sha256Hex('extra')}`, allocations: [] }); s.outputs[4].value_sats = (BigInt(s.outputs[4].value_sats) - 1000n).toString() } }],
    ['JOINT_FEE_CAP', w => { w.lBuilder.tamper.origination = s => { s.fee_sats = '2500'; s.outputs[4].value_sats = (BigInt(s.outputs[4].value_sats) - 500n).toString() } }],
  ]
  for (const [code, tamper] of cases) {
    const w = world()
    const { B } = await parties(w)
    // The lender's own pre-proposal check would refuse too; a dishonest lender skips it, so drive its adapter directly.
    tamper(w)
    const prep = await w.lBuilder.origination(w.agreement, borrowerFunding())
    const op = await w.lAdapter.prepare({ context: { request_id: 'x', idempotency_key: 'x', wallet_id: 'wallet-l', network: w.agreement.terms.settlement.network, obligation_id: w.agreement.loan_id }, ...prep })
    await B.offerFunding(borrowerFunding())
    const artifacts = [...op.proposal.input_history, op.proposal.transfer_consignment].map(a => ({ artifact: a, bytes_base64: w.lAdapter.store.get(a.sha256)! }))
    const msg = sealJointMessage(lenderKey, w.agreement.loan_id, borrowerKey.pubkey, { type: 'proposal', proposal: op.proposal, artifacts })
    await assert.rejects(B.receive(msg), refused(code), code)
    assert.deepEqual(exports(w.bAdapter), [], `${code}: the borrower exported no signature`)
    assert.equal(w.bGate.requests.length, 0)
    assert.equal(B.snapshot.refusals.at(-1)!.code, code)
  }
})

test('joint loan: the lender also refuses to propose a transaction its own check rejects', async () => {
  const w = world()
  const { B, L } = await parties(w)
  w.lBuilder.tamper.origination = s => { s.outputs[2].allocations[0].amount = '1' }
  await assert.rejects(L.receive(await B.offerFunding(borrowerFunding())), refused('JOINT_WRONG_AMOUNT'))
  assert.equal(L.phase, 'agreed')
  const w2 = world(); w2.lBuilder.tamper = { recipient: 'utxob:someone-else' }
  const p2 = await parties(w2)
  await assert.rejects(p2.L.receive(await p2.B.offerFunding(borrowerFunding())), refused('JOINT_WRONG_DESTINATION'))
})

test('joint loan: terms, artifacts and proofs must be exactly the agreed ones before the borrower verifies', async () => {
  const run = async (mutate: (m: JointMessage) => JointMessage, code: string, verified = false) => {
    const w = world()
    const { B, L } = await parties(w)
    const [proposal] = await L.receive(await B.offerFunding(borrowerFunding()))
    await assert.rejects(B.receive(mutate(structuredClone(proposal))), refused(code), code)
    assert.equal(w.bAdapter.calls.includes('verifyProposal'), verified)
    assert.deepEqual(exports(w.bAdapter), [])
  }
  const reseal = (m: JointMessage) => sealJointMessage(lenderKey, m.loan_id, m.to, m.body)
  const body = (m: JointMessage) => m.body as Extract<JointMessage['body'], { type: 'proposal' }>
  await run(m => { body(m).proposal.terms.fee = '0'; return reseal(m) }, 'JOINT_TERMS_CHANGED')
  await run(m => { body(m).artifacts.pop(); return reseal(m) }, 'JOINT_ARTIFACTS')
  await run(m => { body(m).artifacts[0].bytes_base64 = Buffer.from('forged history').toString('base64'); return reseal(m) }, 'JOINT_ARTIFACT_BYTES')
  await run(m => { body(m).proposal.intent.amount = '1'; return reseal(m) }, 'JOINT_WRONG_AMOUNT')
  await run(m => m.body.type === 'proposal' ? { ...m, sig: m.sig.replace(/^./, c => (c === '0' ? '1' : '0')) } : m, 'JOINT_BAD_SIGNATURE')
  await run(m => sealJointMessage(strangerKey, m.loan_id, m.to, m.body), 'JOINT_WRONG_PARTY')
  await run(m => sealJointMessage(lenderKey, sha256Hex('another loan'), m.to, m.body), 'JOINT_WRONG_LOAN')
})

test('joint loan: the lender never signs funding without the borrower\'s complete, matching enforcement set', async () => {
  const setup = async () => {
    const w = world()
    w.lAdapter.permissive = true // the orchestration, not only the adapter, must hold the line
    const { B, L } = await parties(w)
    const [proposal] = await L.receive(await B.offerFunding(borrowerFunding()))
    const [enforcement] = await B.receive(proposal)
    return { w, L, enforcement: enforcement as JointMessage & { body: Extract<JointMessage['body'], { type: 'enforcement' }> } }
  }
  const resealB = (m: JointMessage) => sealJointMessage(borrowerKey, m.loan_id, m.to, m.body)
  {
    const { w, L, enforcement } = await setup()
    const m = structuredClone(enforcement); m.body.spends = m.body.spends.filter(s => s.template_id !== 'liq-85')
    await assert.rejects(L.receive(resealB(m)), refused('JOINT_ENFORCEMENT_SET'))
    assert.equal(w.lAdapter.calls.includes('recordEnforcement'), false)
    assert.deepEqual(exports(w.lAdapter), []); assert.equal(w.lSigner.signed.length, 0)
  }
  {
    const { w, L, enforcement } = await setup()
    const m = structuredClone(enforcement); m.body.spends.push({ ...m.body.spends[1] })
    await assert.rejects(L.receive(resealB(m)), refused('JOINT_ENFORCEMENT_SET'))
    assert.deepEqual(exports(w.lAdapter), [])
  }
  {
    const { w, L, enforcement } = await setup()
    const m = structuredClone(enforcement); m.body.parent_proposal_hash = sha256Hex('other proposal')
    await assert.rejects(L.receive(resealB(m)), refused('JOINT_ENFORCEMENT_SET'))
    assert.deepEqual(exports(w.lAdapter), [])
  }
  {
    // Native refuses an unsigned spend: the error propagates, nothing is signed, no other rail is tried.
    const { w, L, enforcement } = await setup()
    const m = structuredClone(enforcement); m.body.spends[0].signed_psbt_base64 = encodePsbt({ ...decodePsbt(m.body.spends[0].signed_psbt_base64), sigs: [] })
    await assert.rejects(L.receive(resealB(m)), /FAKE_ENFORCEMENT_UNSIGNED/)
    assert.deepEqual(exports(w.lAdapter), [])
    assert.equal(L.snapshot.refusals.at(-1)!.code, 'JOINT_NATIVE_ERROR')
    assert.equal(L.phase, 'origination:proposed')
  }
})

test('joint loan: the borrower only pre-signs default and liquidation spends that pay exactly the agreed amounts', async () => {
  const cases: [string, (p: OnchainEnforcementPreparation) => OnchainEnforcementPreparation][] = [
    ['JOINT_WRONG_VALUE', p => p.kind === 'default' ? { ...p, decoded_summary: { ...p.decoded_summary, outputs: [{ ...p.decoded_summary.outputs[0], value_sats: '210000' }, { ...p.decoded_summary.outputs[1], value_sats: '39000' }] } } : p],
    ['JOINT_WRONG_LOCKTIME', p => p.template_id === 'liq-80' ? { ...p, decoded_summary: { ...p.decoded_summary, locktime: 101 } } : p],
    ['JOINT_WRONG_COLLATERAL', p => p.kind === 'default' ? { ...p, decoded_summary: { ...p.decoded_summary, inputs: [{ ...p.decoded_summary.inputs[0], outpoint: { txid: sha256Hex('other'), vout: 1 } }] } } : p],
    ['JOINT_ENFORCEMENT_SET', p => p.template_id === 'liq-85' ? { ...p, template_id: 'liq-99' } : p],
  ]
  for (const [code, tamper] of cases) {
    const w = world()
    const { B, L } = await parties(w)
    w.bAdapter.enforcementTamper = tamper
    const [proposal] = await L.receive(await B.offerFunding(borrowerFunding()))
    await assert.rejects(B.receive(proposal), refused(code), code)
    assert.deepEqual(exports(w.bAdapter), [], `${code}: no enforcement signature left the borrower`)
  }
})

test('joint loan: every export needs a live authorization from the party\'s own gate for exactly that operation', async () => {
  {
    const w = world()
    const { B, L } = await parties(w)
    w.lGate.stopped = true
    const [proposal] = await L.receive(await B.offerFunding(borrowerFunding()))
    const [enforcement] = await B.receive(proposal)
    await assert.rejects(L.receive(enforcement), /GATE_KILL_SWITCH/)
    assert.deepEqual(exports(w.lAdapter), []); assert.equal(w.lSigner.signed.length, 0)
    // No fallback: nothing else was attempted after the refusal.
    assert.equal(w.lAdapter.calls.at(-1), 'recordEnforcement')
    // Once the kill switch is lifted the same message completes, exactly once.
    w.lGate.stopped = false
    const [signature] = await L.receive(enforcement)
    assert.equal(signature.body.type, 'signature')
    assert.deepEqual(await L.receive(enforcement), [signature])
    assert.equal(exports(w.lAdapter).length, 1)
  }
  {
    const w = world()
    const { B, L } = await parties(w)
    w.bGate.tamper = a => ({ ...a, operation_id: 'some-other-operation' })
    const [proposal] = await L.receive(await B.offerFunding(borrowerFunding()))
    await assert.rejects(B.receive(proposal), refused('JOINT_AUTHORIZATION_MISMATCH'))
    assert.equal(w.bSigner.signed.length, 0); assert.deepEqual(exports(w.bAdapter), [])
  }
  {
    const w = world()
    const { B, L } = await parties(w)
    w.bGate.tamper = a => ({ ...a, issued_at: a.issued_at - 600, expires_at: a.issued_at - 300 })
    const [proposal] = await L.receive(await B.offerFunding(borrowerFunding()))
    await assert.rejects(B.receive(proposal), refused('JOINT_AUTHORIZATION_EXPIRED'))
    assert.equal(w.bSigner.signed.length, 0)
  }
})

test('joint loan: the lender signs repayment only for the exact debt to it and this loan\'s full collateral back', async () => {
  const cases: [string, (s: OnchainDecodedSummary, i: OnchainJointIntent) => void][] = [
    ['JOINT_WRONG_AMOUNT', s => { s.outputs[1].allocations[0].amount = '100000000' }],
    ['JOINT_WRONG_DESTINATION', s => { s.outputs[1].script_pubkey = `5120${sha256Hex('borrower-keeps-it')}` }],
    ['JOINT_WRONG_VALUE', s => { s.outputs[2].value_sats = '240000'; s.outputs[3].value_sats = (BigInt(s.outputs[3].value_sats) + 10000n).toString() }],
    ['JOINT_WRONG_COLLATERAL', (_s, i) => { if (i.action === 'repayment') i.collateral = { ...i.collateral, txid: sha256Hex('another loan C') } }],
  ]
  for (const [code, tamper] of cases) {
    const w = world()
    const { B, L } = await parties(w)
    await originate(w, B, L)
    // A dishonest borrower skips its own check: build and color directly, then send.
    w.bBuilder.tamper.repayment = tamper
    const collateral = { txid: B.snapshot.origination_txid!, vout: 1, value_sats: w.agreement.terms.collateral_sats, script_pubkey: (await w.bAdapter.inspectCollateral(w.agreement.terms)).script_pubkey }
    const prep = await w.bBuilder.repayment(w.agreement, collateral)
    const op = await w.bAdapter.prepare({ context: { request_id: 'r', idempotency_key: 'r', wallet_id: 'wallet-b', network: w.agreement.terms.settlement.network, obligation_id: w.agreement.loan_id }, ...prep })
    const artifacts = [...op.proposal.input_history, op.proposal.transfer_consignment].map(a => ({ artifact: a, bytes_base64: w.bAdapter.store.get(a.sha256)! }))
    const msg = sealJointMessage(borrowerKey, w.agreement.loan_id, lenderKey.pubkey, { type: 'proposal', proposal: op.proposal, artifacts })
    await assert.rejects(L.receive(msg), refused(code), code)
    assert.deepEqual(exports(w.lAdapter), ['recordSignedExport:origination'], `${code}: no repayment signature from the lender`)
  }
})

test('joint loan: the borrower\'s own repayment check refuses a short collateral return before proposing', async () => {
  const w = world()
  const { B, L } = await parties(w)
  await originate(w, B, L)
  w.bBuilder.tamper.repayment = s => { s.outputs[2].value_sats = '249000'; s.outputs[3].value_sats = (BigInt(s.outputs[3].value_sats) + 1000n).toString() }
  await assert.rejects(B.startRepayment(), refused('JOINT_WRONG_VALUE'))
})

test('joint loan: steps run in order, duplicates replay the same reply, and a second different offer is refused', async () => {
  const w = world()
  const { B, L } = await parties(w)
  const offer = await B.offerFunding(borrowerFunding())
  assert.deepEqual(await B.offerFunding({ ...borrowerFunding(), fee_sats: '2500' }), offer, 'a repeated local step returns what was already sent')
  const [proposal] = await L.receive(offer)
  assert.deepEqual(await L.receive(offer), [proposal])
  assert.equal(w.lAdapter.calls.filter(c => c === 'prepare').length, 1)
  const second = sealJointMessage(borrowerKey, w.agreement.loan_id, lenderKey.pubkey, { type: 'funding-inputs', borrower_btc_inputs: borrowerFunding().borrower_btc_inputs, fee_sats: '1500' })
  await assert.rejects(L.receive(second), refused('JOINT_OUT_OF_ORDER'))
  await assert.rejects(B.startRepayment(), refused('JOINT_OUT_OF_ORDER'))
  await assert.rejects(B.settleOrigination(), refused('JOINT_OUT_OF_ORDER'))
  const [enforcement] = await B.receive(proposal)
  assert.deepEqual(await B.receive(proposal), [enforcement])
  assert.equal(exports(w.bAdapter).length, 3, 'enforcement signatures exported once')
})

test('joint loan: refuses to run unless explicitly activated for isolated regtest acceptance on the pinned fork', async () => {
  const w = world()
  assert.throws(() => new JointBorrower({ ...w.bDeps, options: {} as never }), refused('JOINT_V3_NOT_LIVE'))
  assert.throws(() => new JointBorrower({ ...w.bDeps, key: strangerKey }), refused('JOINT_WRONG_PARTY'))
  assert.throws(() => new JointLender({ ...w.bDeps }), refused('JOINT_WRONG_PARTY'))
  const signet = agreementFor(); (signet.terms.settlement.network as { chain: string }).chain = 'signet'
  assert.throws(() => new JointBorrower({ ...w.bDeps, agreement: signet }), refused('JOINT_WRONG_NETWORK'))
  const ln = agreementFor(); (ln.terms.settlement as { kind: string }).kind = 'ln-rln'
  assert.throws(() => new JointBorrower({ ...w.bDeps, agreement: ln }), refused('JOINT_WRONG_SETTLEMENT'))
  w.bAdapter.revision = 'upstream-rgb-lib'
  await assert.rejects(new JointBorrower(w.bDeps).open(), refused('JOINT_NATIVE_MISMATCH'))
  await assert.rejects(new JointBorrower(w.bDeps).offerFunding(borrowerFunding()), refused('JOINT_NOT_OPEN'))
  const over = { ...borrowerFunding(), fee_sats: '3001' }
  w.bAdapter.revision = ONCHAIN_NATIVE_REVISION
  await assert.rejects((await new JointBorrower(w.bDeps).open()).offerFunding(over), refused('JOINT_FEE_CAP'))
})

test('joint loan: both parties resume from their durable state after a restart mid-origination', async () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'joint-b-')), mkdtempSync(join(tmpdir(), 'joint-l-'))]
  let n = 0
  const w = world({ store: () => new FileJointStore(dirs[n++ % 2]) })
  const first = await parties(w)
  const [proposal] = await first.L.receive(await first.B.offerFunding(borrowerFunding()))
  const [enforcement] = await first.B.receive(proposal)
  // Both processes stop here; new instances read their own files.
  const { B, L } = await parties(w)
  assert.equal(B.phase, 'origination:enforcement-signed'); assert.equal(L.phase, 'origination:proposed')
  const [signature] = await L.receive(enforcement)
  await B.receive(signature)
  w.chain.mine()
  await B.settleOrigination(); await L.settleOrigination()
  const again = await parties(w)
  await repay(w, again.B, again.L)
  assert.equal((await again.B.evidence()).verification.ok, true)
})

test('joint loan: a conflicting spend stops settlement as conflicted, with no retry and no second rail', async () => {
  const w = world()
  const { B, L } = await parties(w)
  const [proposal] = await L.receive(await B.offerFunding(borrowerFunding()))
  const [enforcement] = await B.receive(proposal)
  const [signature] = await L.receive(enforcement)
  // The borrower's Bitcoin input is double-spent before the joint funding broadcast lands.
  const input = borrowerFunding().borrower_btc_inputs[0]
  w.chain.conflict(`${input.txid}:${input.vout}`)
  await assert.rejects(B.receive(signature), /FAKE_CHAIN_CONFLICT/)
  await assert.rejects(L.settleOrigination(), refused('JOINT_CONFLICTED'))
  const lCalls = w.lAdapter.calls.slice(w.lAdapter.calls.lastIndexOf('reconcile'))
  assert.deepEqual(lCalls, ['reconcile'], 'nothing after the conflict: recovery is a separate, explicit step')
  assert.equal(L.snapshot.statuses[L.snapshot.origination!.operation_id].phase, 'conflicted')
})

test('joint loan: unconfirmed steps stay pending, and refused native evidence never closes the loan', async () => {
  const w = world()
  const { B, L } = await parties(w)
  const offer = await B.offerFunding(borrowerFunding())
  const [proposal] = await L.receive(offer)
  const [enforcement] = await B.receive(proposal)
  const [signature] = await L.receive(enforcement)
  await B.receive(signature)
  const pending = await B.settleOrigination()
  assert.equal(pending.confirmations, 0); assert.equal(B.phase, 'origination:broadcast')
  w.chain.mine()
  await B.settleOrigination(); await L.settleOrigination()
  await repay(w, B, L)
  w.bAdapter.verifyResult = { ok: false, code: 'RGB_HISTORY_INVALID' }
  await assert.rejects(B.evidence(), refused('JOINT_EVIDENCE_REFUSED'))
  assert.equal(B.phase, 'repayment:settled')
})

test('joint loan: concurrent retries replay one result without preparing or signing twice', async () => {
  const w = world()
  const { B, L } = await parties(w)
  const twice = async <T>(run: () => Promise<T>): Promise<T> => {
    const [first, second] = await Promise.all([run(), run()])
    assert.deepEqual(second, first)
    return first
  }
  const offer = await twice(() => B.offerFunding(borrowerFunding()))
  const [proposal] = await twice(() => L.receive(offer))
  const [enforcement] = await twice(() => B.receive(proposal))
  const [signature] = await twice(() => L.receive(enforcement))
  const [broadcast] = await twice(() => B.receive(signature))
  await twice(() => L.receive(broadcast))
  w.chain.mine()
  await twice(() => B.settleOrigination())
  await twice(() => L.settleOrigination())

  const repayment = await twice(() => B.startRepayment())
  const [debtSignature] = await twice(() => L.receive(repayment))
  const [repaid] = await twice(() => B.receive(debtSignature))
  await twice(() => L.receive(repaid))
  w.chain.mine()
  await twice(() => B.settleRepayment())
  await twice(() => L.settleRepayment())
  assert.equal((await twice(() => B.evidence())).verification.ok, true)

  assert.equal(w.bGate.requests.length, 5, 'three enforcement exports, funding and repayment')
  assert.equal(w.lGate.requests.length, 2, 'funding and repayment')
  assert.equal(w.bSigner.signed.length, 5)
  assert.equal(w.lSigner.signed.length, 2)
  for (const adapter of [w.bAdapter, w.lAdapter]) {
    assert.equal(adapter.calls.filter(c => c === 'prepare').length, 1)
    assert.equal(adapter.calls.filter(c => c === 'verifyProposal').length, 1)
    assert.equal(adapter.calls.filter(c => c === 'apply').length, 2)
  }
  assert.equal(w.bAdapter.calls.filter(c => c === 'verifyRepayment').length, 1)
  assert.deepEqual(B.snapshot.refusals, [])
  assert.deepEqual(L.snapshot.refusals, [])
})

test('joint loan: a refused command does not block a queued valid command', async () => {
  const w = world()
  const { B, L } = await parties(w)
  const earlyRepayment = B.startRepayment()
  const offered = B.offerFunding(borrowerFunding())
  await assert.rejects(earlyRepayment, refused('JOINT_OUT_OF_ORDER'))
  const [proposal] = await L.receive(await offered)
  assert.equal(proposal.body.type, 'proposal')
  assert.equal(B.phase, 'origination:inputs-offered')
  assert.deepEqual(B.snapshot.refusals.map(r => r.code), ['JOINT_OUT_OF_ORDER'])
})

test('joint loan: a concurrent different funding offer cannot start another native operation', async () => {
  const w = world()
  const { B, L } = await parties(w)
  const offer = await B.offerFunding(borrowerFunding())
  const different = sealJointMessage(borrowerKey, w.agreement.loan_id, lenderKey.pubkey, {
    type: 'funding-inputs', ...borrowerFunding(), fee_sats: '1500',
  })
  const [first, second] = await Promise.allSettled([L.receive(offer), L.receive(different)])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  if (second.status === 'rejected') assert.ok(refused('JOINT_OUT_OF_ORDER')(second.reason))
  assert.equal(w.lAdapter.calls.filter(c => c === 'prepare').length, 1)
  assert.equal(L.phase, 'origination:proposed')
})
