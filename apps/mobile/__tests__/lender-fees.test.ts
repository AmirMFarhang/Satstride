// Lane E3: what the phone lender pays at close. One platform fee: the platform's share of the
// interest plus the credit checks billed to this lender at close (E2's FeeRecord.share_amount
// and check_fees). The phone pays only an amount it can account for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Hex } from '../../../src/core/crypto.ts'
import { closeFeeLines, closeFees, type CloseFeeRecord, type HeldBill } from '../src/lender/fees.ts'

const ASSET = 'rgb:usdt-mutinynet'
const OP = 'aa'.repeat(32) as Hex
const BORROWER = 'dd'.repeat(32) as Hex
const bill = (n: number, amount = 500_000, borrower: Hex = BORROWER): HeldBill => ({ bill_hash: String(n).padStart(2, '0').repeat(32) as Hex, negotiation_id: String(n + 50).repeat(32).slice(0, 64) as Hex, borrower_pk: borrower, operator_pk: OP, asset_id: ASSET, amount })
const LOAN = { borrower_pk: BORROWER }
const fee = (over: Partial<CloseFeeRecord> = {}): CloseFeeRecord => ({ loan_id: 'bb'.repeat(32) as Hex, lender_pk: 'cc'.repeat(32) as Hex, asset_id: ASSET, outcome: 'repaid', interest: 900_000, share_bps: 1500, amount: 140_000, status: 'fee_due', invoice: 'rgb:fee', recipient_id: 'r', closed_height: 130, grace_until_height: 136, ...over } as CloseFeeRecord)
const charged = (b: HeldBill) => ({ bill_hash: b.bill_hash, negotiation_id: b.negotiation_id, operator_pk: b.operator_pk, commitment: '04'.repeat(32) as Hex, asset_id: b.asset_id, amount: b.amount })

test('no billed checks: the fee is the platform share, as before', () => {
  const c = closeFees(fee(), [])
  assert.deepEqual(c.problems, [])
  assert.equal(c.share, 140_000)
  assert.equal(c.total, 140_000)
  assert.equal(c.checks_total, 0)
})

test('with this loan\'s check billed at close: share plus check, every part accounted for', () => {
  const b = bill(1)
  const c = closeFees(fee({ share_amount: 140_000, amount: 640_000, check_fees: [charged(b)] }), [b], { ...LOAN, own: [b] })
  assert.deepEqual(c.problems, [])
  assert.equal(c.share, 140_000)
  assert.equal(c.checks_total, 500_000)
  assert.equal(c.total, 640_000)
  assert.deepEqual(c.not_charged, [])
  const lines = closeFeeLines(c, 'test USDT (mutinynet)')
  assert.deepEqual(lines.map((l) => l.k), ['Platform share of the interest', 'Credit check billed at close', 'You pay now'])
  assert.equal(lines.at(-1)!.v, '0.64 test USDT (mutinynet)')
  assert.ok(lines.every((l) => !/\$|EUR|USD\b|fiat/i.test(l.v)), 'no fiat')
})

test('an earlier check with the same borrower that led to no loan is charged here too (E2: first loan to close); the phone knows it', () => {
  const own = bill(1), earlier = bill(2, 300_000)
  const c = closeFees(fee({ share_amount: 140_000, amount: 940_000, check_fees: [charged(own), charged(earlier)] }), [own, earlier], { ...LOAN, own: [own] })
  assert.deepEqual(c.problems, [])
  assert.equal(c.checks_total, 800_000)
})

test('refused: a check this phone never asked for, another price, charged twice, parts that do not add up, no share', () => {
  const b = bill(1)
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 640_000, check_fees: [charged(b)] }), [], LOAN).problems.join(), /never asked for/)
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 740_000, check_fees: [{ ...charged(b), amount: 600_000 }] }), [b]).problems.join(), /another price/)
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 1_140_000, check_fees: [charged(b), charged(b)] }), [b]).problems.join(), /twice/)
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 700_000, check_fees: [charged(b)] }), [b]).problems.join(), /is not the share/)
  assert.match(closeFees(fee({ amount: 640_000, check_fees: [charged(b)] }), [b]).problems.join(), /not its own share/)
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 640_000, check_fees: [{ ...charged(b), asset_id: 'rgb:other' }] }), [{ ...b, asset_id: 'rgb:other' }], LOAN).problems.join(), /another asset than the fee/)
})

test('a platform that does not charge bills: this loan\'s bill is shown as not charged, the fee is the share', () => {
  const b = bill(1)
  const c = closeFees(fee(), [b], { ...LOAN, own: [b] })
  assert.deepEqual(c.problems, [])
  assert.equal(c.total, 140_000)
  assert.equal(c.not_charged.length, 1)
  assert.ok(closeFeeLines(c).some((l) => /not charged/.test(l.k)))
})

test('refused: a bill from another borrower\'s check, or one whose borrower the phone did not record, charged on this loan', () => {
  const other = bill(3, 500_000, 'ee'.repeat(32) as Hex)
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 640_000, check_fees: [charged(other)] }), [other], LOAN).problems.join(), /another borrower/)
  const legacy = { ...bill(4), borrower_pk: undefined }
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 640_000, check_fees: [charged(legacy)] }), [legacy], LOAN).problems.join(), /did not record/)
  const b = bill(1)
  assert.match(closeFees(fee({ share_amount: 140_000, amount: 640_000, check_fees: [charged(b)] }), [b], {}).problems.join(), /not this loan's/, 'no loan on this phone: no bill is accepted')
})
