// The check market on real regtest: two check nodes on the relay, the
// borrower picks by policy, pays in USDT over RGB Lightning with a HODL
// invoice locked to sha256(K), opens the result with the preimage, forwards K,
// and the lender verifies the same commitment on its own.
//
// Opt-in: needs the isolated check-market stack with the HODL RGB Lightning
// build (infra/check-market.sh build && infra/check-market.sh start), then
//   eval "$(infra/check-market.sh env)"
//   PASSBOOK_CHECK_MARKET_LIVE=1 npx tsx --test test/regtest/check-market.test.ts
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { writeRecord } from '../../src/checknode/market.js'
import { runRegtestCheckMarket } from '../../infra/check-market-run.js'
import { DEFAULT_RECORD } from '../../src/server/checknodes.js'

describe('check market on regtest (RGB Lightning HODL)', { skip: !process.env.PASSBOOK_CHECK_MARKET_LIVE }, () => {
  it('picks the cheaper node, pays over RGB Lightning, reveals K by paying, the lender verifies; receipt and voucher', { timeout: 900_000 }, async () => {
    const record = await runRegtestCheckMarket({
      lnBorrower: process.env.PASSBOOK_CHECK_LN_BORROWER ?? 'http://127.0.0.1:3181',
      lnA: process.env.PASSBOOK_CHECK_LN_A ?? 'http://127.0.0.1:3182',
      lnB: process.env.PASSBOOK_CHECK_LN_B ?? 'http://127.0.0.1:3183',
      vouchers: true,
    })
    // Recorded before the assertions, so a failed run still leaves its evidence.
    if (process.env.PASSBOOK_CHECK_MARKET_REPORT) writeFileSync(process.env.PASSBOOK_CHECK_MARKET_REPORT, `${JSON.stringify(record, null, 2)}\n`)
    assert.equal(record.nodes.length, 2)
    assert.equal(record.pick.operator_pk, record.nodes.find((n) => n.name === 'B')?.operator_pk, 'B at 0.50 test USDT is cheaper than A at 0.80')
    assert.equal(record.paid?.rail, 'rgb-ln-hodl')
    assert.equal(record.paid?.amount, 500_000)
    assert.equal(record.paid?.key_source, 'lightning-preimage', 'paying the HODL invoice revealed K')
    assert.ok(record.lender?.ok, JSON.stringify(record.lender?.ticks.filter((t) => !t.ok)))
    assert.ok(record.nodes.every((n) => n.execution.label === 'no TEE: software evidence'))
    assert.ok(record.nodes.every((n) => n.bond === 'designed, not live'))
    assert.equal(record.platform_cut, 0)
    // The receipt: a UDA holding hashes only, settled in the borrower's RGB wallet.
    assert.match(record.receipt?.contract_id ?? '', /^rgb:/)
    assert.match(record.receipt?.status ?? '', /^settled/)
    // Vouchers: the lender sent one PBCHK to the borrower, who paid a check with it over RGB Lightning.
    assert.equal(record.voucher?.error, undefined, record.voucher?.error)
    assert.equal(record.voucher?.borrower_received, 1)
    assert.ok(record.voucher?.picked_with_voucher)
    assert.equal(record.voucher?.paid?.amount, 1)
    assert.equal(record.voucher?.paid?.key_source, 'lightning-preimage')
    assert.ok(record.voucher?.lender_verified)
    writeRecord(process.env.PASSBOOK_CHECK_MARKET_RECORD ?? DEFAULT_RECORD, record)
  })
})
