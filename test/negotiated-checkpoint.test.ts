// W1 negotiated loans in the restartable demo: the lender's term-sheet origination
// splits around the human approval, and the lender and borrower checkpoints carry
// (and strictly check) the sheet, approvals, policy and threshold that funding needs.
// Fake platform and relay only; no service, chain, mining or RGB wallet runs.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { borrowerCheckpointProblems, type BorrowerLoan } from '../src/agents/borrower.js'
import { LenderAgent, L2_POLICY, type LenderCheckpoint, type TermSheetProposal } from '../src/agents/lender.js'
import type { Relay } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { keyPairFromLabel, randomHex, type Hex } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { approve } from '../src/market/approvals.js'
import { signLenderPolicy, type LenderPolicy } from '../src/market/policy.js'
import { buildTermSheet, signTermSheet, termSheetHash, type TermSheet } from '../src/market/termsheet.js'
import { Oracle } from '../src/oracle/oracle.js'
import type { PassbookDocument } from '../src/registry/passbook-doc.js'
import type { Party } from '../src/wallet/party.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const U = MICRO_PER_USDT
const ASSET = 'rgb:negotiated-checkpoint-unit'
const lender = keyPairFromLabel('negotiated-checkpoint-lender'), checker = keyPairFromLabel('negotiated-checkpoint-checker')
const borrower = keyPairFromLabel('negotiated-checkpoint-borrower'), platform = keyPairFromLabel('negotiated-checkpoint-platform'), stranger = keyPairFromLabel('negotiated-checkpoint-stranger')
const oracle = new Oracle(keyPairFromLabel('negotiated-checkpoint-oracle'), 10_000_000)

function policy(over: Partial<Parameters<typeof signLenderPolicy>[1]> = {}): Promise<LenderPolicy> {
  return signLenderPolicy(new LocalKeySigner(lender), { asset_id: ASSET, max_per_loan: 5_000 * U, max_outstanding: 50_000 * U, min_apr_bps: 1000, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, required_checks: ['investigation', 'inflows'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [checker.pubkey], maker_checker_above: 5_000 * U }, issued_at: 1, ...over })
}
function sheet(principal = 600 * U): TermSheet {
  return signTermSheet(buildTermSheet({
    agreed: { principal, apr_bps: 1200, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' }, negotiation: { id: '01'.repeat(32), accept_hash: '02'.repeat(32) },
    borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, asset_id: ASSET, oracle_quote: oracle.quote(100), grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
    scorer: { provider: 'in-process', scorer_id: 'passbook-sandbox:in-process:unit', code_measurement: 'source:' + 'ab'.repeat(32), contract_hash: 'cd'.repeat(32), trust: 'dev-inprocess', result_hash: 'ef'.repeat(32), fallback: false, recommendation: 'QUALIFY', evidence: { kind: 'passbook-run-record', run_record_sha256: '9a'.repeat(32) } },
    consent_hash: '12'.repeat(32), salt: randomHex(),
  }), 'lender', lender.secretKey)
}
async function negotiatedSnapshot(): Promise<{ snapshot: LenderCheckpoint; id: Hex; sheet: TermSheet; policy: LenderPolicy }> {
  const s = sheet(), p = await policy(), id = termSheetHash(s)
  const snapshot: LenderCheckpoint = { v: 1, asset_id: ASSET, pubkey: lender.pubkey, loans: [[id, { terms: s.terms, borrower_pk: borrower.pubkey, termsheet: s, lender_approvals: [approve(lender, s, 'lender', 1_790_000_000)], negotiation_policy: p, maker_checker_above: 5_000 * U, has_repayment_account: false }]] }
  return { snapshot, id, sheet: s, policy: p }
}
function fixture(platformClient?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-negotiated-checkpoint-'))
  const sent: unknown[] = []
  const party = { role: 'lender1', key: lender, rgb: { dataDir: join(dir, 'rgb') } } as unknown as Party
  const relay = { receive: async () => { throw new Error('unit must never receive') }, send: async (_kind: number, payload: unknown) => { sent.push(payload) }, close() {} } as unknown as Relay
  const agent = new LenderAgent({ party, relay, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: ASSET, mine: async () => { throw new Error('unit must never mine') }, ...(platformClient ? { platform: platformClient as never } : {}) })
  return { agent, sent, dispose() { agent.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('negotiated loans in lender demo checkpoints', () => {
  it('round trips the term sheet, approvals, signed policy and maker-checker threshold', async () => {
    const f = fixture()
    try {
      const { snapshot } = await negotiatedSnapshot()
      await f.agent.restoreCheckpoint(structuredClone(snapshot))
      assert.deepEqual(f.agent.exportCheckpoint(), snapshot)
      // the borrower's countersigned sheet replaces the lender's copy at funding; it restores too
      const countersigned = structuredClone(snapshot)
      countersigned.loans[0][1].termsheet = signTermSheet(snapshot.loans[0][1].termsheet!, 'borrower', borrower.secretKey)
      await f.agent.restoreCheckpoint(countersigned)
      assert.deepEqual(f.agent.exportCheckpoint(), countersigned)
    } finally { f.dispose() }
  })

  it('refuses a partial, altered or under-approved negotiated loan and keeps the previous state', async () => {
    const f = fixture()
    try {
      const { snapshot, sheet: s } = await negotiatedSnapshot()
      await f.agent.restoreCheckpoint(snapshot)
      const before = f.agent.exportCheckpoint()
      const other = sheet()
      type Loan = LenderCheckpoint['loans'][number][1]
      const attacks: [string, (l: Loan) => void | Promise<void>][] = [
        ['policy missing', (l) => { delete l.negotiation_policy }],
        ['threshold missing', (l) => { delete l.maker_checker_above }],
        ['approvals missing', (l) => { delete l.lender_approvals }],
        ['sheet missing', (l) => { delete l.termsheet }],
        ['threshold not an integer', (l) => { l.maker_checker_above = 1.5 }],
        ['unknown sheet field', (l) => { (l.termsheet as unknown as Record<string, unknown>).note = 'x' }],
        ['sheet of another loan', (l) => { l.termsheet = other }],
        ['sheet figures altered', (l) => { l.termsheet = { ...s, apr_bps: 1300 } }],
        ['lender signature removed', (l) => { l.termsheet = { ...s, signatures: {} } }],
        ['empty approvals', (l) => { l.lender_approvals = [] }],
        ['approval of another sheet', (l) => { l.lender_approvals = [approve(lender, other, 'lender', 1)] }],
        ['approval from an unlisted key', (l) => { l.lender_approvals = [approve(stranger, s, 'lender', 1)] }],
        ['approval as borrower', (l) => { l.lender_approvals = [approve(lender, s, 'borrower', 1)] }],
        ['approval signature altered', (l) => { l.lender_approvals = [{ ...l.lender_approvals![0], approved_at: 2 }] }],
        ['approval extra field', (l) => { l.lender_approvals = [{ ...l.lender_approvals![0], extra: 1 } as never] }],
        // 600 USDT above a 100 USDT threshold needs the second (checker) key
        ['maker-checker unmet', (l) => { l.maker_checker_above = 100 * U }],
        ['policy unsigned change', (l) => { l.negotiation_policy = { ...l.negotiation_policy!, min_apr_bps: 1 } }],
        ['policy extra field', (l) => { l.negotiation_policy = { ...l.negotiation_policy!, extra: true } as never }],
        ['policy of another asset', async (l) => { l.negotiation_policy = await policy({ asset_id: 'rgb:other' }) }],
        ['policy of another owner', async (l) => { l.negotiation_policy = await signLenderPolicy(new LocalKeySigner(stranger), { ...structuredClone(l.negotiation_policy!), approval_rules: l.negotiation_policy!.approval_rules }) }],
      ]
      for (const [label, attack] of attacks) {
        const bad = structuredClone(snapshot); await attack(bad.loans[0][1])
        await assert.rejects(f.agent.restoreCheckpoint(bad), Error, label)
        assert.deepEqual(f.agent.exportCheckpoint(), before, label)
      }
      // two approvals satisfy the stricter threshold
      const checked = structuredClone(snapshot)
      checked.loans[0][1].maker_checker_above = 100 * U
      checked.loans[0][1].lender_approvals!.push(approve(checker, s, 'lender', 1))
      await f.agent.restoreCheckpoint(checked)
    } finally { f.dispose() }
  })
})

describe('negotiated origination split around the lender approval', () => {
  async function proposal(): Promise<TermSheetProposal> {
    const s = sheet(), p = await policy()
    return JSON.parse(JSON.stringify({ loan_id: termSheetHash(s), borrower_pk: borrower.pubkey, sheet: s, passbook: { borrower_pk: borrower.pubkey } as unknown as PassbookDocument, negotiation: { policy: p, maxRounds: 3, makerCheckerAboveMicro: 5_000 * U }, checks: [{ id: 'negotiation', ok: true, detail: 'unit' }], memo: { adjustment_bps: 0, applied_bps: 0, clamped: false, flags: [], text: 'unit' } }))
  }

  it('registers and sends a journaled proposal once its approvals are complete', async () => {
    const registered: unknown[] = []
    const pr = await proposal()
    const f = fixture({ registerLoan: async (terms: unknown) => { registered.push(terms); return { loan: { id: pr.loan_id } } }, note: async () => {} })
    try {
      const uw = await f.agent.sendTermSheet(pr, [approve(lender, pr.sheet, 'lender', 1)])
      assert.equal(uw.loan_id, pr.loan_id); assert.equal(uw.apr_bps, 1200)
      assert.deepEqual(registered, [pr.sheet.terms]); assert.equal(f.sent.length, 1)
      const loan = f.agent.exportCheckpoint().loans[0][1]
      assert.deepEqual([loan.termsheet, loan.negotiation_policy, loan.maker_checker_above], [pr.sheet, pr.negotiation.policy, 5_000 * U])
    } finally { f.dispose() }
  })

  it('refuses an altered proposal or missing approvals before anything is registered or sent', async () => {
    let registered = 0
    const f = fixture({ registerLoan: async () => { registered++; throw new Error('must not register') }, note: async () => {} })
    try {
      const pr = await proposal()
      const other = sheet()
      const attacks: [string, (p: TermSheetProposal) => void][] = [
        ['another loan id', (p) => { p.loan_id = termSheetHash(other) }],
        ['another borrower', (p) => { p.borrower_pk = stranger.pubkey }],
        ['sheet altered', (p) => { p.sheet = { ...p.sheet, apr_bps: 1300 } }],
        ['sheet unsigned', (p) => { p.sheet = { ...p.sheet, signatures: {} } }],
        ['policy altered', (p) => { p.negotiation.policy = { ...p.negotiation.policy, min_apr_bps: 1 } }],
      ]
      for (const [label, attack] of attacks) {
        const bad = structuredClone(pr); attack(bad)
        await assert.rejects(f.agent.sendTermSheet(bad, [approve(lender, pr.sheet, 'lender', 1)]), /does not bind/, label)
      }
      await assert.rejects(f.agent.sendTermSheet(pr, []), /lender approval incomplete: 0\/1/)
      await assert.rejects(f.agent.sendTermSheet(pr, [approve(stranger, pr.sheet, 'lender', 1)]), /LENDER_APPROVAL_FROM_UNLISTED_KEY/)
      const big = structuredClone(pr); big.negotiation.makerCheckerAboveMicro = 100 * U
      await assert.rejects(f.agent.sendTermSheet(big, [approve(lender, pr.sheet, 'lender', 1)]), /lender approval incomplete: 1\/2/)
      assert.equal(registered, 0); assert.equal(f.sent.length, 0)
      assert.deepEqual(f.agent.exportCheckpoint().loans, [])
    } finally { f.dispose() }
  })
})

describe('negotiated loans in borrower demo checkpoints', () => {
  function accepted(): { id: Hex; loan: BorrowerLoan; sheet: TermSheet } {
    const s = sheet(), id = termSheetHash(s)
    return { id, sheet: s, loan: { terms: s.terms, lender_pk: lender.pubkey, termsheet: s, lender_approvals: [approve(lender, s, 'lender', 1)] } }
  }
  function approved(): { id: Hex; loan: BorrowerLoan } {
    const { id, loan } = accepted()
    const countersigned = signTermSheet(loan.termsheet!, 'borrower', borrower.secretKey)
    return { id, loan: { ...loan, termsheet: countersigned, borrower_approval: approve(borrower, countersigned, 'borrower', 2) } }
  }

  it('accepts a fixed-offer loan, an accepted sheet and a countersigned, approved sheet', () => {
    const { sheet: s } = accepted()
    assert.deepEqual(borrowerCheckpointProblems(termSheetHash(s), { terms: s.terms, lender_pk: lender.pubkey, lock: { txid: '11'.repeat(32), vout: 0 } }, borrower.pubkey), [])
    const a = accepted(); assert.deepEqual(borrowerCheckpointProblems(a.id, a.loan, borrower.pubkey), [])
    const b = approved(); assert.deepEqual(borrowerCheckpointProblems(b.id, b.loan, borrower.pubkey), [])
  })

  it('refuses unknown fields and a missing, altered or unbound sheet or approval', () => {
    const other = sheet()
    const attacks: [string, () => { id: Hex; loan: BorrowerLoan }][] = [
      ['unknown field', () => { const x = approved(); (x.loan as unknown as Record<string, unknown>).extra = 1; return x }],
      ['approvals without a sheet', () => { const x = approved(); delete x.loan.termsheet; return x }],
      ['sheet without lender approvals', () => { const x = accepted(); delete x.loan.lender_approvals; return x }],
      ['sheet of another loan', () => { const x = accepted(); x.loan.termsheet = other; return x }],
      ['altered sheet', () => { const x = accepted(); x.loan.termsheet = { ...x.sheet, apr_bps: 1300 }; return x }],
      ['unsigned sheet', () => { const x = accepted(); x.loan.termsheet = { ...x.sheet, signatures: {} }; return x }],
      ['another lender', () => { const x = accepted(); x.loan.lender_pk = stranger.pubkey; return x }],
      ['lender approval of another sheet', () => { const x = accepted(); x.loan.lender_approvals = [approve(lender, other, 'lender', 1)]; return x }],
      ['only an unlisted approver', () => { const x = accepted(); x.loan.lender_approvals = [approve(stranger, x.sheet, 'lender', 1)]; return x }],
      ['tampered lender approval', () => { const x = accepted(); x.loan.lender_approvals = [{ ...x.loan.lender_approvals![0], approved_at: 9 }]; return x }],
      ['countersigned without approval', () => { const x = approved(); delete x.loan.borrower_approval; return x }],
      ['approval without countersignature', () => { const x = approved(); x.loan.termsheet = accepted().sheet; return x }],
      ['borrower approval by another key', () => { const x = approved(); x.loan.borrower_approval = approve(stranger, x.loan.termsheet!, 'borrower', 2); return x }],
      ['borrower approval as lender', () => { const x = approved(); x.loan.borrower_approval = approve(borrower, x.loan.termsheet!, 'lender', 2); return x }],
    ]
    for (const [label, make] of attacks) {
      const { id, loan } = make()
      assert.notDeepEqual(borrowerCheckpointProblems(id, JSON.parse(JSON.stringify(loan)), borrower.pubkey), [], label)
    }
  })
})
