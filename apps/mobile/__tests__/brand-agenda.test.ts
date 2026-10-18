// The personal agenda: deadlines from block heights, time estimates that say what they assumed,
// what each loan waits on, the ladder and the stamped pages, all from the state passed in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LADDER_BPS, CURE_BLOCKS } from '../../../src/registry/ladder.ts'
import { agenda, durationWords, paceOf, TARGET_SECONDS, type AgendaLoan } from '../src/ui/agenda/agenda-model.ts'

const U = 1_000_000
const loan = (over: Partial<AgendaLoan>): AgendaLoan => ({ id: 'l1', role: 'borrower', pageNo: 3, counterparty: 'Lender 3f9a1c', principal: 100 * U, debt: 100_900_000, open_height: 300, maturity_height: 330, grace_blocks: 5, stage: 'funded', ...over })
const base = { now: Date.UTC(2026, 9, 18, 6), pages: [], ladder: { steps: LADDER_BPS, at: 2 }, cureBlocks: CURE_BLOCKS }

test('a deadline is its block; the time is an estimate that names its basis', () => {
  const a = agenda({ ...base, height: 310, loans: [loan({})] })
  const d = a.deadlines[0]
  assert.equal(d.title, 'Pay page 3')
  assert.equal(d.dueHeight, 330)
  assert.equal(d.blocksLeft, 20)
  assert.equal(d.left, 20 / 30)
  assert.equal(d.tone, 'ok')
  assert.equal(d.eta, 'about 3 h 20 min', '20 blocks at 10 minutes')
  assert.equal(d.note, '100.90 test USDT by block 330')
  assert.equal(a.pace.basis, 'target')
  assert.match(a.pace.words, /10-minute target/)
  // seen blocks give the chain's own pace (regtest mines when it is told to)
  const seen = [{ height: 300, time: 0 }, { height: 304, time: 120_000 }]
  assert.deepEqual(paceOf(seen), { secondsPerBlock: 30, basis: 'observed', words: "at this chain's recent pace (30 s a block)" })
  assert.equal(agenda({ ...base, height: 310, seen, loans: [loan({})] }).deadlines[0].eta, 'about 10 min')
  assert.equal(paceOf([{ height: 5, time: 10 }]).secondsPerBlock, TARGET_SECONDS, 'one block is not a pace')
})

test('soon, grace, past due and a margin call each read as what they are, most urgent first', () => {
  const a = agenda({ ...base, height: 333, loans: [
    loan({ id: 'ok', pageNo: 4, open_height: 330, maturity_height: 400 }),
    loan({ id: 'grace' }),
    loan({ id: 'soon', pageNo: 5, open_height: 320, maturity_height: 336 }),
    loan({ id: 'call', pageNo: 6, open_height: 320, maturity_height: 400, margin_call_height: 330 }),
    loan({ id: 'late', pageNo: 7, open_height: 290, maturity_height: 320 }),
  ] })
  assert.deepEqual(a.deadlines.map((d) => [d.loanId, d.tone]), [['late', 'late'], ['call', 'late'], ['grace', 'grace'], ['soon', 'soon'], ['ok', 'ok']])
  const call = a.deadlines.find((d) => d.loanId === 'call')!
  assert.equal(call.dueHeight, 330 + CURE_BLOCKS)
  assert.equal(call.title, 'Margin call on page 6')
  // a call raised close to maturity: the earlier deadline wins (the default spend unlocks at maturity + grace)
  const late = agenda({ ...base, height: 329, loans: [loan({ id: 'near', maturity_height: 330, grace_blocks: 5, margin_call_height: 329 })] }).deadlines[0]
  assert.equal(late.dueHeight, 335, 'not 339: the grace period ends first')
  assert.equal(late.blocksLeft, 6)
  assert.match(late.note, /before the grace period ends at block 335/)
  const early = agenda({ ...base, height: 329, loans: [loan({ id: 'far', maturity_height: 400, margin_call_height: 329 })] }).deadlines[0]
  assert.equal(early.dueHeight, 329 + CURE_BLOCKS, 'far from maturity the cure window is the deadline')
  assert.match(early.note, /within 10 blocks/)
  assert.match(a.deadlines.find((d) => d.loanId === 'grace')!.note, /2 blocks of grace left/)
  assert.equal(a.deadlines[0].eta, null, 'no estimate for a deadline that has passed')
})

test('what comes next on each loan, the person\'s own steps first; released loans leave the list', () => {
  const a = agenda({ ...base, height: 310, loans: [
    loan({ id: 'b-locked', stage: 'locked' }),
    loan({ id: 'b-repaid', stage: 'repaid' }),
    loan({ id: 'l-repaid', role: 'lender', pageNo: undefined, counterparty: 'Borrower 77aa01', stage: 'repaid' }),
    loan({ id: 'b-funded', stage: 'funded' }),
    loan({ id: 'done', stage: 'released' }),
  ] })
  assert.deepEqual(a.next.map((n) => [n.loanId, n.waitingOn]), [['l-repaid', 'you'], ['b-funded', 'you'], ['b-locked', 'them'], ['b-repaid', 'them']])
  assert.equal(a.next.find((n) => n.loanId === 'l-repaid')!.text, 'Co-sign the release')
  assert.equal(a.next.find((n) => n.loanId === 'b-locked')!.text, 'Waiting for Lender 3f9a1c to pay in 100.00 test USDT')
  assert.deepEqual(a.deadlines.map((d) => d.loanId), ['b-funded'], 'only a loan that is paid in has a payment deadline')
  assert.equal(a.deadlines.length + a.next.length, 5)
})

test('the ladder and the past pages, numbered in the order they were opened', () => {
  const pages = [
    { loan_id: 'p2', outcome: 'on_time', principal: 100 * U, open_height: 200, maturity_height: 230, ladder_step: 1, close_txid: 'ab'.repeat(32) },
    { loan_id: 'p1', outcome: 'late', principal: 50 * U, open_height: 100, maturity_height: 130, ladder_step: 0 },
    { loan_id: 'p3', outcome: 'open', principal: 100 * U, open_height: 300, maturity_height: 330, ladder_step: 2 },
  ]
  const a = agenda({ ...base, height: 310, loans: [], pages })
  assert.deepEqual(a.past.map((p) => [p.loanId, p.label]), [['p2', 'Page 2'], ['p1', 'Page 1']], 'newest first; the open page is not past')
  assert.deepEqual(a.past.map((p) => p.closeWord), ['release', 'release'])
  assert.equal(agenda({ ...base, height: 1, loans: [], pages: [{ ...pages[0], outcome: 'defaulted' }] }).past[0].closeWord, 'default claim', 'a defaulted page is not closed by a release')
  assert.deepEqual(a.ladder, { at: 2, of: 4, percent: 6000, next: 'Pay your next page on time to reach 65%' })
  assert.equal(agenda({ ...base, height: 1, loans: [], pages: [], ladder: { steps: LADDER_BPS, at: 3 } }).ladder!.next, 'Top of the ladder')
  assert.equal(agenda({ ...base, height: 1, loans: [], pages: [], ladder: undefined }).ladder, null)
  assert.deepEqual([durationWords(20_000), durationWords(12 * 60_000), durationWords(60 * 60_000), durationWords((50 * 60 + 5) * 60_000)], ['under a minute', '12 min', '1 h', '2 days 2 h'])
})
