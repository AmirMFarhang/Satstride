// M8: the agenda shows only loans whose collateral is locked, each at the stage its own records show.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agendaLoans, noteBlock } from '../src/app/agenda.ts'

const terms = (principal: number) => ({ principal, fee: 1_000_000, open_height: 100, maturity_height: 130, grace_blocks: 5 }) as never
const name = (r: string, pk: string) => `${r} ${pk.slice(0, 6)}`

test('agenda loans: locked only, stages from the records, the borrower page number and the lender side', () => {
  const borrower = { labels: {}, loans: {
    a: { terms: terms(100), lender_pk: 'aaaaaa11', lock: { txid: 't', vout: 0 } },
    b: { terms: terms(200), lender_pk: 'bbbbbb22', lock: { txid: 't', vout: 0 }, disbursement_txid: 'd' },
    c: { terms: terms(300), lender_pk: 'cccccc33', lock: { txid: 't', vout: 0 }, disbursement_txid: 'd', repayment_txid: 'r', release_txid: 'x' },
    d: { terms: terms(400), lender_pk: 'dddddd44' },
  } } as never
  const lender = { declined: [], loans: { e: { terms: terms(500), borrower_pk: 'eeeeee55', lock: { txid: 't', vout: 0 }, disbursement_txid: 'd', repayment_txid: 'r' }, f: { terms: terms(600), borrower_pk: 'ffffff66', lock: { txid: 't', vout: 0 }, cancelled: 'refunded' } } } as never
  const out = agendaLoans(borrower, lender, { flowLoanId: 'b', flowStage: 'repaying', pageIds: ['c', 'a', 'b'], name })
  assert.deepEqual(out.map((l) => [l.id, l.role, l.stage, l.pageNo ?? null]), [['a', 'borrower', 'locked', 2], ['b', 'borrower', 'repaying', 3], ['c', 'borrower', 'released', 1], ['e', 'lender', 'repaid', null]])
  assert.equal(out[0].debt, 1_000_100, 'principal plus fee')
  assert.equal(out[3].counterparty, 'Borrower eeeeee')
})

test('blocks seen: increasing heights only, the last few', () => {
  let seen = noteBlock([], 100, 1)
  seen = noteBlock(seen, 100, 2)
  seen = noteBlock(seen, 99, 3)
  seen = noteBlock(seen, 101, 4)
  assert.deepEqual(seen, [{ height: 100, time: 1 }, { height: 101, time: 4 }])
  for (let h = 102; h < 120; h++) seen = noteBlock(seen, h, h)
  assert.equal(seen.length, 8)
})

test('a raised margin call reaches the agenda loan, so its deadline comes from the cure window', () => {
  const borrower = { labels: {}, loans: { a: { terms: terms(100), lender_pk: 'aaaaaa11', lock: { txid: 't', vout: 0 }, disbursement_txid: 'd' } } } as never
  const lender = { declined: [], loans: { e: { terms: terms(500), borrower_pk: 'eeeeee55', lock: { txid: 't', vout: 0 }, disbursement_txid: 'd' } } } as never
  const out = agendaLoans(borrower, lender, { pageIds: [], name, marginCalls: { a: 120, e: 0 } })
  assert.equal(out.find((l) => l.id === 'a')!.margin_call_height, 120)
  assert.equal(out.find((l) => l.id === 'e')!.margin_call_height, undefined, 'no call raised')
})
