import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { tierIncomeEvidence } from '../src/sandbox/income-tiers.js'
import { randomHex } from '../src/core/crypto.js'

describe('deterministic income evidence haircuts', () => {
  it('counts real signed income at 100% and never accepts a model amount', () => {
    const f = investigationFixture('fatima')
    const result = tierIncomeEvidence(f.bundle, { currentHeight: 280, blocksPerMonth: 30, months: 3, reconciliationVerified: true })
    assert.ok(result.payers.every((p) => p.tier === 1 && p.haircut_bps === 10000))
    assert.equal(result.median_monthly_micro, 3_800_000_000)
  })
  it('counts unsigned recurring counterparts at 70% only after three stable months', () => {
    const f = investigationFixture('walter'); f.bundle.history = f.bundle.history.filter((r) => r.direction === 'in'); f.bundle.candidate_inflows = []
    const opts = { currentHeight: 280, blocksPerMonth: 30, months: 3, reconciliationVerified: true, verifiedCounterpartyPks: new Set(f.bundle.history.map((r) => r.counterparty_pk)) }
    const result = tierIncomeEvidence(f.bundle, opts)
    assert.equal(result.payers[0].tier, 2); assert.equal(result.median_monthly_micro, 1_750_000_000)
    f.bundle.history[0].height += 10
    assert.equal(tierIncomeEvidence(f.bundle, opts).payers[0].tier, 'out')
  })
  it('counts code-confirmed irregular unsigned work at 50%; a proposed tier grants nothing', () => {
    const f = investigationFixture('fatima'); f.bundle.candidate_inflows = []
    const pks = new Set(f.bundle.history.filter((r) => r.direction === 'in').map((r) => r.counterparty_pk))
    for (const row of f.bundle.history) row.memo = 'invoice logo design'
    // Break stable timing while retaining all three nonempty months.
    for (let i = 0; i < f.bundle.history.length; i++) f.bundle.history[i].height += i % 3 * 5
    const opts = { currentHeight: 290, blocksPerMonth: 30, months: 3, reconciliationVerified: true, irregularPayers: pks, verifiedCounterpartyPks: pks }
    const result = tierIncomeEvidence(f.bundle, opts)
    assert.ok(result.payers.some((p) => p.tier === 3 && p.haircut_bps === 5000))
    const bogus = tierIncomeEvidence(f.bundle, { ...opts, irregularPayers: undefined, proposals: [...pks].map((payer_pk) => ({ payer_pk, tier: 1 })) })
    assert.ok(bogus.rejected_proposals > 0); assert.ok(bogus.payers.every((p) => p.tier !== 1))
  })
  it('gives self transfers, loans, refunds, gifts, flagged payers and loops zero regardless of signatures', () => {
    for (const change of ['self', 'loan', 'gift', 'refund', 'flag', 'loop']) {
      const f = investigationFixture('walter'), pk = f.bundle.candidate_inflows[0].payer_pk
      if (change !== 'loop') f.bundle.history = f.bundle.history.filter((r) => r.direction === 'in')
      if (change === 'self') f.bundle.own_pks.push(pk)
      if (['loan', 'gift', 'refund'].includes(change)) for (const r of f.bundle.history) r.memo = change
      const result = tierIncomeEvidence(f.bundle, { currentHeight: 280, blocksPerMonth: 30, months: 3, reconciliationVerified: true, excludedPayers: change === 'flag' ? new Set([pk]) : new Set() })
      assert.equal(result.payers[0].tier, 'out', change); assert.equal(result.median_monthly_micro, 0, change)
    }
  })
  it('never counts unverified history or fabricated signed candidates', () => {
    const f = investigationFixture('fatima')
    const opts = { currentHeight: 280, blocksPerMonth: 30, months: 3, reconciliationVerified: false, proposals: [{ payer_pk: randomHex(), tier: 1 as const }] }
    assert.equal(tierIncomeEvidence(f.bundle, opts).median_monthly_micro, 0)
    for (const c of f.bundle.candidate_inflows) c.payer_sig = '00'.repeat(64)
    assert.ok(tierIncomeEvidence(f.bundle, { ...opts, reconciliationVerified: true }).payers.every((p) => p.tier !== 1))
  })
  it('cannot create unsigned income from borrower supplied counterparty labels alone', () => {
    const f = investigationFixture('walter'); f.bundle.history = f.bundle.history.filter((r) => r.direction === 'in'); f.bundle.candidate_inflows = []
    const result = tierIncomeEvidence(f.bundle, { currentHeight: 280, blocksPerMonth: 30, months: 3, reconciliationVerified: true })
    assert.equal(result.payers[0].tier, 'out'); assert.equal(result.payers[0].reason, 'UNSIGNED_COUNTERPARTY_NOT_INDEPENDENTLY_IDENTIFIED')
  })
  it('rejects unsafe aggregate amounts and applies large haircuts with exact integer arithmetic', () => {
    const f = investigationFixture('walter'); f.bundle.history = f.bundle.history.filter((r) => r.direction === 'in'); f.bundle.candidate_inflows = []
    const opts = { currentHeight: 280, blocksPerMonth: 30, months: 3, reconciliationVerified: true, verifiedCounterpartyPks: new Set(f.bundle.history.map((r) => r.counterparty_pk)) }
    const amount = 1_000_000_000_003
    for (const r of f.bundle.history) r.amount = amount
    assert.equal(tierIncomeEvidence(f.bundle, opts).median_monthly_micro, Number(BigInt(amount) * 7000n / 10000n))
    for (const r of f.bundle.history) r.amount = Number.MAX_SAFE_INTEGER
    assert.throws(() => tierIncomeEvidence(f.bundle, opts), /safe arithmetic capacity/)
  })
})
