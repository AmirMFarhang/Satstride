// What the screens write: amounts in the canvas's style with test units, the market's
// ranking, and the stops' plain words, whose every number must be a field of the terms.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { btc, btcNum, blocksFrom, satsText, short, usd, usdNum } from '../src/ui/format.ts'
import { viewOffers } from '../src/app/offers.ts'
import { borrowerAgreement, lenderAgreement } from '../src/ui/words.ts'
import { debtOf, type LoanTerms } from '../../../src/core/terms.ts'
import { termInterest } from '../../../src/core/economics.ts'
import { splitLocktime, splitOutputs } from '../../../src/escrow/escrow.ts'
import { keyPairFromLabel } from '../../../src/core/crypto.ts'
import type { Offer } from '../../../src/market/orderbook.ts'

test('amounts read like the canvas, always in test units', () => {
  assert.equal(usdNum(2_000_000_000), '2,000.00')
  assert.equal(usdNum(100_900_000), '100.90')
  assert.equal(usdNum(1_234_567), '1.234567')
  assert.equal(usdNum(0), '0.00')
  assert.equal(usd(140_000), '0.14 test USDT')
  assert.equal(btcNum(1_212_000), '0.01212')
  assert.equal(btcNum(182_955), '0.00182955')
  assert.equal(btcNum(100_000_000), '1.00')
  assert.equal(btc(2_410_000), '0.0241 test BTC')
  assert.equal(satsText(4000), '4,000 sats')
  assert.equal(short('7c2e9a4b1d0ec4f31d'), '7c2e…f31d')
  assert.equal(blocksFrom(319, 309), 'in 10 blocks')
  assert.equal(blocksFrom(319, 320), '1 block ago')
  for (const s of [usd(1), btc(1)]) assert.match(s, /test (USDT|BTC)$/)
})

const offer = (id: string, apr: number, min: number, max: number, inflowMonths = 0): Offer => ({
  id, lender_pk: id.padEnd(64, '0'), created_at: 0,
  payload: { asset_id: 'rgb:x', min, max, apr_bps: apr, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: [5000, 5500, 6000, 6500], requirements: { affordability: true, inflow_months: inflowMonths, inflow_multiple_bps: 0, investigation: 'optional' }, expires_height: 1000 },
} as unknown as Offer)

test('the market ranks what fits first, cheapest first, and says why the rest do not fit', () => {
  const M = 1_000_000
  const rows = viewOffers([offer('a', 1500, 50 * M, 1000 * M), offer('b', 1100, 100 * M, 5000 * M), offer('c', 900, 500 * M, 5000 * M), offer('d', 1000, 100 * M, 5000 * M, 3)], 100 * M, 1250 * M)
  assert.deepEqual(rows.map((r) => [r.offer.id, r.fits]), [['b', true], ['a', true], ['c', false], ['d', false]])
  assert.equal(rows[0].payBack, 100 * M + termInterest({ principal: 100 * M, apr_bps: 1100, term_blocks: 30 }))
  assert.match(rows.find((r) => r.offer.id === 'c')!.why!, /from 500/)
  assert.match(rows.find((r) => r.offer.id === 'd')!.why!, /salary/)
  // the wallet's own offer (it lends too) is never in its borrowing list
  const own = 'b'.padEnd(64, '0')
  assert.deepEqual(viewOffers([offer('a', 1500, 50 * M, 1000 * M), offer('b', 1100, 100 * M, 5000 * M)], 100 * M, 1250 * M, own).map((r) => r.offer.id), ['a'])
  // over the earned limit: nothing fits, and it says so
  assert.ok(viewOffers([offer('b', 1100, 100 * M, 5000 * M)], 2000 * M, 1250 * M)[0].why!.includes('limit'))
})

test('the stops\' plain words use only the terms\' own numbers', () => {
  const B = keyPairFromLabel('b'), L = keyPairFromLabel('l'), P = keyPairFromLabel('p')
  const t = {
    v: 1, borrower_pk: B.pubkey, lender_pk: L.pubkey, platform_pk: P.pubkey, asset_id: 'rgb:x', principal: 100_000_000, fee: 900_000, collateral_sats: 183_455,
    oracle_quote: { price_cents: 10_000_000, height: 289, oracle_pk: P.pubkey, sig: '00'.repeat(64) }, open_height: 289, maturity_height: 319, grace_blocks: 5,
    recovery_height: 344, ladder_step: 1, ltv_bps: 5499, prev_passbook_txid: null, nonce: '11'.repeat(32),
  } as unknown as LoanTerms
  const outs = splitOutputs(t)
  const split = { lender_sats_on_default: outs[0].value, borrower_sats_on_default: outs[1]?.value ?? 0, locktime: splitLocktime(t) }
  const b = borrowerAgreement(t, 'the lender', split)
  assert.match(b.text, /100\.00 test USDT/)
  assert.ok(b.text.includes(usdNum(debtOf(t))))
  assert.ok(b.text.includes(`block ${t.maturity_height}`) && b.text.includes(`block ${split.locktime}`))
  assert.ok(b.text.includes(btc(split.lender_sats_on_default)))
  assert.ok(b.rows.some(([, v]) => v.includes(String(t.recovery_height))))
  const l = lenderAgreement(t, 'the borrower', split)
  assert.ok(l.text.includes(btc(t.collateral_sats)) && l.rows[0][1] === usd(debtOf(t)))
  // no number in the words that is not one of these
  const allowed = new Set([usdNum(t.principal), usdNum(debtOf(t)), btcNum(split.lender_sats_on_default), btcNum(t.collateral_sats), String(t.maturity_height), String(split.locktime), String(t.recovery_height), '10'])
  for (const text of [b.text, l.text, ...b.rows.flat(), ...l.rows.flat()]) {
    for (const n of text.match(/\d[\d,.]*\d|\d/g) ?? []) assert.ok(allowed.has(n), `"${n}" in "${text}" is not a field of the terms`)
  }
})
