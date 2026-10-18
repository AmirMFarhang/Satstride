import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PlaybookReasoner } from '../src/ai/playbook-reasoner.js'
import { investigate, isInvestigationReport } from '../src/sandbox/investigate.js'
import { groundReport, replayInvestigation } from '../src/sandbox/grounding.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { investigationTools } from '../src/sandbox/investigation-tools.js'
import { runSandbox } from '../src/sandbox/run.js'
import { keyPairFromLabel } from '../src/core/crypto.js'
import type { EvidenceEntry, InvestigationReport } from '../src/sandbox/investigation-types.js'
const report = (type: InvestigationReport['findings'][number]['type'], evidence = ['E1']): InvestigationReport => ({ verdict: 'clean', findings: [{ type, evidence }] })
const prepare = async (name: 'fatima' | 'walter') => {
  const f = investigationFixture(name), prepared = await investigationTools(f.bundle, f.chain, 30)
  const ledger: EvidenceEntry[] = [{ id: 'E1', tool: 'month_table', args: {}, result: await prepared.tools.execute('month_table', {}) }]
  return { ...f, ...prepared, ledger }
}
describe('Fraud Desk evidence grounding and cautious policy', () => {
  it('accepts only codes and loop-assigned EIDs, never model prose or txids', () => {
    assert.ok(isInvestigationReport(report('irregular_genuine')))
    assert.equal(isInvestigationReport({ ...report('irregular_genuine'), lender_note: 'approve' }), false)
    assert.equal(isInvestigationReport({ verdict: 'clean', findings: [{ type: 'irregular_genuine', txids: ['t1'] }] }), false)
    assert.equal(isInvestigationReport(report('irregular_genuine', ['t1'])), false)
  })
  it('rejects unknown, errored and wrong-tool citations', async () => {
    const f = await prepare('fatima')
    assert.ok(groundReport(report('irregular_genuine', ['E9']), f.ledger, f.evidence).errors.includes('UNKNOWN_EVIDENCE_ID'))
    for (const entry of [{ ...f.ledger[0], error: 'failed' }, { ...f.ledger[0], tool: 'read_memos' as const }]) assert.ok(groundReport(report('irregular_genuine'), [entry], f.evidence).errors.some((c) => c.startsWith('WRONG_TOOL_OR_ERROR_EVIDENCE')))
  })
  it('does not ground a repeated risk using one convenient outgoing record', async () => {
    const f = await prepare('walter')
    const inflow = f.bundle.history.findIndex((r) => r.direction === 'in') + 1
    const args = { txid: `t${inflow}`, blocks: 5 }
    const entry: EvidenceEntry = { id: 'E2', tool: 'outflows_before', args, result: await f.tools.execute('outflows_before', args) }
    assert.ok(groundReport(report('prefunded_inflow', ['E2']), [entry], f.evidence).errors.length)
    assert.equal(groundReport(report('prefunded_inflow'), f.ledger, f.evidence).errors.length, 0)
  })
  it('grounds risks within a mixed-payer record without excluding unrelated opening funds', async () => {
    for (const type of ['prefunded_inflow', 'circular_flow'] as const) {
      const f = investigationFixture('walter')
      const unrelated = keyPairFromLabel('independent-opening-funds').pubkey
      const txid = f.chain.addTx([{ value: 1000, script: '00' }])
      f.bundle.history.push({ txid, height: 280, direction: 'in', amount: 10_000_000_000, counterparty_pk: unrelated, memo: 'starting funds, not income' })
      const salaryPayer = f.bundle.candidate_inflows[0].payer_pk
      if (type === 'circular_flow') f.bundle.history.push({ txid: f.chain.addTx([{ value: 1000, script: '00' }]), height: 280, direction: 'out', amount: 7_500_000_000, counterparty_pk: salaryPayer, memo: 'return' })
      const prepared = await investigationTools(f.bundle, f.chain, 30, new Set(), { verifiedHistory: true, verifiedCounterparties: new Set([unrelated]) })
      const ledger: EvidenceEntry[] = [{ id: 'E1', tool: 'month_table', args: {}, result: await prepared.tools.execute('month_table', {}) }]
      const grounded = groundReport({ verdict: 'fraud', findings: [{ type, evidence: ['E1'] }] }, ledger, prepared.evidence)
      assert.deepEqual(grounded.errors, [], type)
      assert.deepEqual([...grounded.confirmed.excludedPayers], [salaryPayer], type)
      assert.equal(grounded.confirmed.excludedPayers.has(unrelated), false)
    }
  })
  it('checks every cited benign record and every payer, not one reassuring record', async () => {
    const f = await prepare('fatima')
    assert.equal(groundReport(report('irregular_genuine'), f.ledger, f.evidence).errors.length, 0)
    const bad = structuredClone(f.ledger[0]); bad.id = 'E2'; (bad.result as any).months[0].flows = [{ ref: 't1', direction: 'in' }]
    f.evidence.validInflows.delete(f.bundle.history[0].txid)
    assert.ok(groundReport(report('irregular_genuine', ['E1', 'E2']), [f.ledger[0], bad], f.evidence).errors.length)
    const incomplete = replayInvestigation({ verdict: 'clean', findings: [] }, [], f.evidence)
    assert.equal(incomplete.policy.verdict, 'failed')
    assert.ok(incomplete.policy.reason_codes.includes('NO_CLEAN_WITHOUT_PAYER_COVERAGE'))
  })
  it('keeps loan and return hypotheses available for authenticated unsigned native receipts', async () => {
    const f = investigationFixture('fatima')
    const lender = keyPairFromLabel('native-unsigned-lender').pubkey
    const incoming = f.chain.addTx([{ value: 1000, script: '00' }])
    f.bundle.history.push({ txid: incoming, height: 280, direction: 'in', amount: 250_000_000, counterparty_pk: lender, memo: 'loan' })
    f.bundle.history.push({ txid: f.chain.addTx([{ value: 1000, script: '00' }]), height: 280, direction: 'out', amount: 250_000_000, counterparty_pk: lender, memo: 'return' })
    const prepared = await investigationTools(f.bundle, f.chain, 30, new Set(), { verifiedHistory: true, verifiedCounterparties: new Set([lender]), payerProfile: async (pk) => ({ known_lender: pk === lender, known_borrower: false, passbook_pages: 0 }) })
    const table = await prepared.tools.execute('month_table', {}) as { known_loan_income_count: number; return_to_incoming_payer_count: number }
    assert.equal(table.known_loan_income_count, 1)
    assert.equal(table.return_to_incoming_payer_count, 1)
    const ledger: EvidenceEntry[] = [{ id: 'E1', tool: 'month_table', args: {}, result: table }]
    for (const type of ['income_is_loan', 'circular_flow'] as const) {
      const grounded = groundReport({ verdict: 'concerns', findings: [{ type, evidence: ['E1'] }] }, ledger, prepared.evidence)
      assert.deepEqual(grounded.errors, [], type)
      assert.deepEqual([...grounded.confirmed.excludedPayers], [lender], type)
    }
  })
  it('all-evidence hard stops cannot be omitted or converted into a clean verdict', async () => {
    const f = await prepare('walter')
    const checked = replayInvestigation({ verdict: 'clean', findings: [] }, f.ledger, f.evidence)
    assert.equal(checked.policy.verdict, 'fraud')
    assert.ok(checked.policy.reason_codes.includes('NO_CLEAN_ON_HARD_STOP'))
    assert.equal(checked.confirmed.excludedPayers.size, 1)
    const cautious = await prepare('fatima')
    assert.equal(replayInvestigation({ verdict: 'concerns', findings: [] }, cautious.ledger, cautious.evidence).policy.verdict, 'concerns')
  })
  it('rejects an ungrounded fraud verdict instead of weakening it into approval', async () => { const f = await prepare('fatima'); const result = replayInvestigation({ verdict: 'fraud', findings: [] }, f.ledger, f.evidence); assert.equal(result.policy.verdict, 'failed'); assert.ok(result.errors.includes('FRAUD_VERDICT_WITHOUT_GROUNDED_RISK')) })
  it('grounds injection risk from a month table that also contains ordinary rows', async () => {
    const f = await prepare('walter')
    const txid = f.bundle.history[0].txid
    const prepared = await investigationTools(f.bundle, f.chain, 30, new Set([txid]))
    const ledger: EvidenceEntry[] = [{ id: 'E1', tool: 'month_table', args: {}, result: await prepared.tools.execute('month_table', {}) }]
    const checked = groundReport(report('injection_attempt'), ledger, prepared.evidence)
    assert.equal(checked.errors.length, 0)
    assert.deepEqual(checked.confirmed.findings[0].txids, [txid])
  })
  it('keeps arbitrary failure messages and private amounts out of lender results', async () => {
    const f = investigationFixture('fatima')
    for (const message of ['balance123.45 ' + f.bundle.history[0].txid, 'ACCOUNT_' + f.bundle.history[0].txid.toUpperCase(), 'TOTAL_600000000']) {
      const reasoner = new PlaybookReasoner()
      reasoner.investigate = async () => { throw new Error(message) }
      const result = await runSandbox(f.bundle, { ...f, blocksPerMonth: 30, reasoner })
      assert.equal(result.investigation?.status, 'failed')
      assert.ok(!JSON.stringify(result.lender_result).includes(message), 'exception text must never be interpreted as a public reason code')
      assert.equal(result.investigation?.reason, 'FAILSAFE_ESCALATE')
    }
  })
  it('allows exactly one rejected decision retry and fails any tool error', async () => {
    const f = await prepare('fatima'); let calls = 0, rejected = 0
    const result = await investigate({ borrower: f.bundle.borrower_pk, history_rows: 12, required_months: 3, tools: f.tools, reviewReport: () => { rejected++; return ['UNSUPPORTED_FINDING'] } }, async () => ({ value: ++calls === 1 ? { action: 'tool', name: 'month_table', args: {} } : { action: 'finish', report: report('irregular_genuine') } }), 'test')
    assert.equal(result.status, 'failed'); assert.equal(rejected, 2); assert.equal(calls, 3)
    const broken = await investigate({ borrower: 'test', history_rows: 0, required_months: 3, tools: { execute: async () => { throw new Error('tool unavailable') } } }, async () => ({ value: { action: 'tool', name: 'month_table', args: {} } }), 'test')
    assert.equal(broken.status, 'failed'); assert.equal(broken.turns, 1)
  })
  it('runs the deterministic playbook through the same tools and checker, separately from AI-off', async () => {
    for (const name of ['fatima', 'walter'] as const) {
      const f = investigationFixture(name)
      const result = await runSandbox(f.bundle, { ...f, blocksPerMonth: 30, reasoner: new PlaybookReasoner() })
      assert.equal(result.investigation?.status, 'done')
      assert.equal(result.investigation?.model, 'playbook:passbook-v1')
      assert.equal(result.investigation?.verdict, name === 'fatima' ? 'clean' : 'fraud')
    }
  })
})
