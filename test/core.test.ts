import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalJson, hashObject, keyPairFromLabel, randomHex, signObject, verifyObject } from '../src/core/crypto.js'
import { collateralFor, ltvBps, microToSats, priceAtLtv, satsToMicro } from '../src/core/money.js'
import { termsHash, validateTerms, type LoanTerms } from '../src/core/terms.js'
import { Oracle, verifyQuote } from '../src/oracle/oracle.js'
import { opReturnPayload, opReturnScript } from '../src/chain/types.js'

describe('money', () => {
  it('converts sats to dollars at a price', () => {
    // 0.012 BTC at $100,000 = $1,200
    assert.equal(satsToMicro(1_200_000, 10_000_000), 1_200_000_000)
    assert.equal(microToSats(1_200_000_000, 10_000_000), 1_200_000)
  })
  it('computes LTV in bps', () => {
    // $606 debt against $1,000 of BTC = 60.6%
    assert.equal(ltvBps(606_000_000, 1_000_000, 10_000_000), 6060)
  })
  it('round-trips collateral for a target LTV', () => {
    const sats = collateralFor(606_000_000, 5000, 10_000_000)
    assert.equal(sats, 1_212_000)
    assert.equal(ltvBps(606_000_000, sats, 10_000_000), 5000)
  })
  it('finds the price at which a loan hits a threshold', () => {
    // $606 against 0.01 BTC: 80% LTV at $75,750
    assert.equal(priceAtLtv(606_000_000, 1_000_000, 8000), 7_575_000)
  })
})

describe('crypto', () => {
  it('canonical JSON sorts keys and drops undefined', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } }), '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}')
    assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }))
  })
  it('signs and verifies objects, ignoring the sig field', () => {
    const k = keyPairFromLabel('t')
    const signed = signObject({ x: 1, y: 'two' }, k.secretKey)
    assert.ok(verifyObject(signed, k.pubkey))
    assert.ok(!verifyObject({ ...signed, x: 2 }, k.pubkey))
    assert.ok(!verifyObject(signed, keyPairFromLabel('other').pubkey))
  })
})

describe('terms', () => {
  it('hashes canonically and validates structure', () => {
    const oracle = new Oracle(keyPairFromLabel('oracle'), 10_000_000)
    const t: LoanTerms = {
      v: 1,
      borrower_pk: keyPairFromLabel('b').pubkey,
      lender_pk: keyPairFromLabel('l').pubkey,
      platform_pk: keyPairFromLabel('p').pubkey,
      asset_id: 'rgb:test',
      principal: 600_000_000,
      fee: 6_000_000,
      collateral_sats: 1_212_000,
      oracle_quote: oracle.quote(150),
      open_height: 150,
      maturity_height: 180,
      grace_blocks: 5,
      recovery_height: 205,
      ladder_step: 0,
      ltv_bps: 5000,
      prev_passbook_txid: null,
      nonce: randomHex(),
    }
    validateTerms(t)
    assert.equal(termsHash(t).length, 64)
    assert.ok(verifyQuote(t.oracle_quote, oracle.pubkey))
    assert.ok(!verifyQuote({ ...t.oracle_quote, price_cents: 1 }, oracle.pubkey))
    assert.throws(() => validateTerms({ ...t, recovery_height: 180 }), /recovery_height/)
    assert.throws(() => validateTerms({ ...t, borrower_pk: 'zz' }), /borrower_pk/)
  })
})

describe('op_return', () => {
  it('wraps and unwraps a 32-byte commitment', () => {
    const h = randomHex()
    assert.equal(opReturnPayload(opReturnScript(h)), h)
    assert.equal(opReturnPayload('0014deadbeef'), null)
  })
})
