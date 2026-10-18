// The team's pricing decisions (17 Oct 2026, docs/REVENUE.md) as tests: the
// borrower pays principal + the lender's term interest only, ACT/365 with one
// rounding rule; APR capped at 19%; 65% LTV only for 30-day terms; no
// liquidation penalty on any terms version; no platform output anywhere.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { opReturnScript } from '../src/chain/types.js'
import { parseConfig, loadConfig } from '../src/core/config.js'
import { keyPairFromLabel, randomHex, sha256Hex, hexToBytes } from '../src/core/crypto.js'
import { DEFAULT_ECONOMICS, economicsProblems, feeWithinApr, impliedAprBps, lenderReturn, maxLtvForTerm, platformShare, roundHalfUpCents, termInterest } from '../src/core/economics.js'
import { FakeChain } from '../src/chain/fake.js'
import { bytesToHex } from '../src/core/crypto.js'
import { rgbRepaymentReceipt, signPassbook, verifyPassbook } from '../src/registry/passbook-doc.js'
import { collateralFor, microToSats, MICRO_PER_USDT } from '../src/core/money.js'
import { debtOf, termsHash, validateTerms, type LoanTerms } from '../src/core/terms.js'
import { buildLock, escrowFor, keyPathOutput, liquidationOutputs, partiesOf, releaseOutputs, splitOutputs, TX_FEE_SATS } from '../src/escrow/escrow.js'
import * as ladder from '../src/registry/ladder.js'
import { Oracle } from '../src/oracle/oracle.js'

const U = MICRO_PER_USDT
const B = keyPairFromLabel('econ-borrower')
const L = keyPairFromLabel('econ-lender')
const P = keyPairFromLabel('econ-platform')
const PRICE = 10_000_000

/** Terms for `principal` at `aprBps` over `termBlocks`, at `ltvBps`, with the fee from termInterest. */
function termsAt(o: { principal?: number; aprBps?: number; termBlocks?: number; ltvBps?: number; v?: 1 | 2 } = {}): LoanTerms {
  const principal = o.principal ?? 600 * U, term = o.termBlocks ?? 30, ltv = o.ltvBps ?? 5000
  const fee = termInterest({ principal, apr_bps: o.aprBps ?? 1200, term_blocks: term })
  const sats = collateralFor(principal + fee, ltv, PRICE)
  const preimage = randomHex(32)
  return {
    v: o.v ?? 1,
    ...(o.v === 2 ? { atomic_repayment: { invoice: 'lnbcrt-econ-test-only', btc_amount_msat: 3_000_000 as const, payment_hash: sha256Hex(hexToBytes(preimage)), expires_at: 2_000_000_000, payee_pubkey: `02${L.pubkey}` } } : {}),
    borrower_pk: B.pubkey, lender_pk: L.pubkey, platform_pk: P.pubkey, asset_id: 'rgb:econ',
    principal, fee, collateral_sats: sats, oracle_quote: new Oracle(P, PRICE).quote(100),
    open_height: 100, maturity_height: 100 + term, grace_blocks: 5, recovery_height: 100 + term + 25,
    ladder_step: 0, ltv_bps: ltv, prev_passbook_txid: null, nonce: randomHex(32),
  }
}

describe('term interest, ACT/365, one rounding rule', () => {
  it('prices the worked loan at 5.92 USDT, not 6.00, and splits it 0.89 / 5.03', () => {
    const interest = termInterest({ principal: 600 * U, apr_bps: 1200, term_blocks: 30 })
    assert.equal(interest, 5_920_000)
    assert.equal(platformShare(interest), 890_000, '15% of 5.92 is 0.888, half-up to 0.89')
    const r = lenderReturn({ principal: 600 * U, fee: interest, term_blocks: 30 })
    assert.deepEqual(r, { gross: 5_920_000, platform: 890_000, net: 5_030_000, net_apr_bps: 1019, share_bps: 1500 })
    assert.equal(r.gross, r.platform + r.net, 'gross = platform + net, always')
  })

  it('rounds half-up to 0.01 USDT, and only there', () => {
    assert.equal(roundHalfUpCents(4_999n, 1n), 0)
    assert.equal(roundHalfUpCents(5_000n, 1n), 10_000)
    assert.equal(roundHalfUpCents(14_999n, 1n), 10_000)
    assert.equal(roundHalfUpCents(15_000n, 1n), 20_000)
    for (let principal = 100 * U; principal <= 5_000 * U; principal += 137 * U) {
      const i = termInterest({ principal, apr_bps: 1150, term_blocks: 30 })
      assert.equal(i % 10_000, 0, 'whole cents')
      assert.equal(platformShare(i) % 10_000, 0, 'whole cents')
    }
  })

  it('bounds a fee by an APR without tripping on cent rounding', () => {
    // 150 USDT at 14% for 30 days: 1.726 rounds to 1.73, which reads back as 14.03%
    const fee = termInterest({ principal: 150 * U, apr_bps: 1400, term_blocks: 30 })
    assert.equal(fee, 1_730_000)
    assert.equal(impliedAprBps({ principal: 150 * U, fee, open_height: 0, maturity_height: 30 }), 1403)
    assert.ok(feeWithinApr({ principal: 150 * U, fee, term_blocks: 30 }, 1400), 'the fee the APR produces is within that APR')
    assert.ok(!feeWithinApr({ principal: 150 * U, fee: fee + 10_000, term_blocks: 30 }, 1400))
  })

  it('reads the APR back from the fee and maps blocks to days', () => {
    assert.equal(impliedAprBps(termsAt({ aprBps: 1200 })), 1200)
    // mainnet-like mapping: 144 blocks a day gives the same interest over the same days
    assert.equal(termInterest({ principal: 600 * U, apr_bps: 1200, term_blocks: 30 * 144 }, { blocks_per_day: 144 }), 5_920_000)
  })

  it('has no unused borrower fee or penalty constants left', () => {
    for (const name of ['FEE_BPS', 'ORIGINATION_BPS', 'LIQUIDATION_PENALTY_BPS']) assert.equal(name in ladder, false, name)
  })
})

describe('validateTerms: the usury cap, LTV by term, no borrower-side fee', () => {
  it('rejects 1901 bps and accepts 1900', () => {
    // 5,000 USDT over 30 days: one basis point is 0.41 USDT, so the cap binds at whole cents
    validateTerms(termsAt({ principal: 5_000 * U, aprBps: 1900 }))
    assert.throws(() => validateTerms(termsAt({ principal: 5_000 * U, aprBps: 1901 })), /APR, above the 19\.00% cap/)
    assert.throws(() => validateTerms(termsAt({ aprBps: 2500 })), /cap/)
  })

  it('rejects 65% LTV on a 60-day term and accepts it on a 30-day term', () => {
    validateTerms(termsAt({ termBlocks: 30, ltvBps: 6500 }))
    assert.throws(() => validateTerms(termsAt({ termBlocks: 60, ltvBps: 6500 })), /above the 60\.00% limit for a 60-day term/)
    validateTerms(termsAt({ termBlocks: 60, ltvBps: 6000 }))
    assert.throws(() => validateTerms(termsAt({ termBlocks: 90, ltvBps: 6000 })), /55\.00% limit for a 90-day term/)
    assert.throws(() => validateTerms(termsAt({ termBlocks: 91, ltvBps: 5000 })), /longer than any allowed LTV bucket/)
    assert.equal(maxLtvForTerm(10), 6500)
    assert.equal(maxLtvForTerm(31), 6000)
  })

  it('rejects any borrower-side fee field, and any unknown field', () => {
    const t = termsAt()
    for (const field of ['origination_fee', 'platform_fee', 'borrower_fee', 'liquidation_penalty_bps', 'commission']) {
      assert.throws(() => validateTerms({ ...t, [field]: 1 }), /no borrower-side fee/, field)
    }
    assert.throws(() => validateTerms({ ...t, memo: 'x' }), /unknown field/)
  })

  it('checks a page already on chain for structure only, so later pricing bounds never unverify history', async () => {
    const old = termsAt({ aprBps: 2500, termBlocks: 60, ltvBps: 6500 })
    assert.throws(() => validateTerms(old), /cap/)
    validateTerms(old, null)
    assert.throws(() => validateTerms({ ...old, origination_fee: 1 }, null), /no borrower-side fee/)
    const chain = new FakeChain(100)
    const e = escrowFor(partiesOf(old))
    const lock = chain.addTx([{ value: old.collateral_sats, script: e.script }, { value: 0, script: opReturnScript(termsHash(old)) }])
    chain.mine()
    const repayment = chain.addTx([{ value: 1000, script: '00' }])
    chain.mine()
    const close = chain.addTx(releaseOutputs(old), [{ txid: lock, vout: 0, witness: ['00'.repeat(64), '00'.repeat(64), bytesToHex(e.leaves.A.script), bytesToHex(e.leaves.A.controlBlock)] }])
    chain.mine()
    const pb = await verifyPassbook(signPassbook(B, [{ terms: old, lock_txid: lock, lock_vout: 0, outcome_txid: close, outcome: 'repaid', repayment: { kind: 'rgb_receipt', receipt: rgbRepaymentReceipt(L, old, repayment, debtOf(old)) } }]), chain)
    assert.equal(pb.unverified, 0)
    assert.equal(pb.ladder.step, 1)
  })

  it('keeps existing terms, hashes and escrow addresses valid', () => {
    // the pre-decision fixtures: 6.00 USDT on 600 for 30 days (12.17% ACT/365), 50% LTV
    const legacy: LoanTerms = { ...termsAt(), fee: 6_000_000, collateral_sats: 1_212_000, nonce: '11'.repeat(32) }
    validateTerms(legacy)
    assert.equal(termsHash(legacy), termsHash(JSON.parse(JSON.stringify(legacy))))
    assert.equal(escrowFor(partiesOf(legacy)).address, escrowFor(partiesOf({ ...legacy })).address)
  })
})

describe('no liquidation penalty, no platform output', () => {
  it('gives the lender exactly the debt at the liquidation price, on v1 and v2', () => {
    for (const v of [1, 2] as const) {
      const t = termsAt({ v })
      for (const price of [6_000_000, 6_250_000, 7_100_000]) {
        const outs = liquidationOutputs(t, price)
        assert.equal(outs[0].script, keyPathOutput(L.pubkey).script)
        assert.equal(outs[0].value, microToSats(debtOf(t), price), `v${v} at ${price}: exactly the debt`)
        assert.equal(outs[1].value, t.collateral_sats - TX_FEE_SATS - outs[0].value, 'the rest to the borrower')
      }
    }
    // the worked loan at $60,000: 606 USDT of debt -> 1,010,000 sats (v1 used to pay 1,060,500)
    const worked = { ...termsAt(), fee: 6_000_000, collateral_sats: 1_212_000 }
    assert.equal(liquidationOutputs(worked, 6_000_000)[0].value, 1_010_000)
  })

  it('never pays the platform from the lock, the release, the split, a liquidation or a refund', () => {
    for (const v of [1, 2] as const) {
      const t = termsAt({ v })
      const allowed = new Set([keyPathOutput(B.pubkey).script, keyPathOutput(L.pubkey).script])
      const lock = buildLock({ inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: t.collateral_sats + 100_000, internal_pk: B.pubkey }], terms: t, changeScript: keyPathOutput(B.pubkey).script })
      const lockScripts = lock.txOutputs.map((o) => Buffer.from(o.script).toString('hex'))
      assert.deepEqual(lockScripts, [escrowFor(partiesOf(t)).script, opReturnScript(termsHash(t)), keyPathOutput(B.pubkey).script], 'collateral, terms hash, change: nothing else')
      const spends = [releaseOutputs(t), splitOutputs(t), ...[5_000_000, 6_000_000, 7_000_000, 1_000_000].map((p) => liquidationOutputs(t, p))]
      for (const outs of spends) for (const o of outs) {
        assert.ok(allowed.has(o.script), `v${v}: output pays only the borrower or the lender`)
        assert.ok(!o.script.includes(P.pubkey), 'no output script carries the platform key')
        assert.notEqual(o.script, keyPathOutput(P.pubkey).script)
      }
    }
  })
})

describe('the economics config', () => {
  it('passbook.config.yaml publishes exactly the economics the code enforces', () => {
    const cfg = loadConfig('passbook.config.yaml')
    assert.deepEqual({ ...cfg.economics, max_ltv_bps_by_term: { ...cfg.economics.max_ltv_bps_by_term } }, { ...DEFAULT_ECONOMICS, max_ltv_bps_by_term: { ...DEFAULT_ECONOMICS.max_ltv_bps_by_term } })
    assert.deepEqual(economicsProblems(DEFAULT_ECONOMICS), [])
  })

  it('refuses economics that would breach the decisions', () => {
    const base = readFileSync('passbook.config.yaml', 'utf8')
    const bad = (from: string, to: string) => () => parseConfig(base.replace(from, to), { checkFiles: false })
    assert.throws(bad('max_ltv_bps_by_term: { 30: 6500, 60: 6000, 90: 5500 }', 'max_ltv_bps_by_term: { 30: 6000, 60: 6500 }'), /must not allow a higher LTV for a longer term/)
    assert.throws(bad("day_count: 'ACT/365'", "day_count: '30/360'"), /economics.day_count/)
    assert.throws(bad('platform_share_bps: 1500', 'platform_share_bps: 20000'), /economics.platform_share_bps/)
    assert.throws(bad('  fee_grace_blocks: 6\n', '  fee_grace_blocks: 6\n  origination_bps: 100\n'), /economics.origination_bps: unknown setting/)
  })
})
