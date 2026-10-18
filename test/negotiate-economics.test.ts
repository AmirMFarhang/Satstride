// The negotiation engine under the platform's economics: every ASK, OFFER,
// COUNTER and ACCEPT is clamped to the APR cap and the LTV limit for the term
// before either policy bound applies, and a move that would cross them is
// never sent.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm } from '../src/core/economics.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { appendMessage, runNegotiation, simulate, verifyTranscript, type EngineParams, type NegotiationMessage, type Position } from '../src/market/negotiate.js'
import { signBorrowerPolicy, signLenderPolicy, type BorrowerPolicy, type LenderPolicy } from '../src/market/policy.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const U = MICRO_PER_USDT
const borrowerKey = keyPairFromLabel('econ-neg-borrower')
const lenderKey = keyPairFromLabel('econ-neg-lender')
const borrower = new LocalKeySigner(borrowerKey)
const lender = new LocalKeySigner(lenderKey)
const PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb', 'ln-rln'] }
const CAP = DEFAULT_ECONOMICS.max_apr_bps

const bpolicy = (over: Partial<BorrowerPolicy> = {}) => signBorrowerPolicy(borrower, { asset_id: 'rgb:usdt', principal: { min: 300 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: 1, ...over })
const lpolicy = (over: Partial<LenderPolicy> = {}) => signLenderPolicy(lender, { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: [], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [], maker_checker_above: 5_000 * U }, issued_at: 1, ...over })

describe('negotiation inside the economics', () => {
  it('property: never emits an APR above the cap or an LTV above the term limit', async () => {
    let seed = 20261017
    const rand = (lo: number, hi: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return lo + (seed % (hi - lo + 1)) }
    const reasons = new Map<string, number>()
    let agreed = 0
    for (let i = 0; i < 300; i++) {
      const bTerm = rand(10, 120), lTerm = rand(10, 120)
      const bp = await bpolicy({ max_apr_bps: rand(200, 4000), max_ltv_bps: rand(2000, 9000), term_blocks: { min: Math.min(bTerm, 30), max: bTerm }, ...(rand(0, 1) ? { opening: { apr_bps: undefined, ltv_bps: undefined } } : {}) })
      const lp = await lpolicy({ min_apr_bps: rand(200, 3000), max_ltv_bps: rand(2000, 9000), term_blocks: { min: 10, max: lTerm } })
      const r = simulate(bp, lp, PARAMS)
      for (const t of r.turns) {
        if (!('position' in t.move)) continue
        const p = t.move.position
        assert.ok(p.apr_bps <= CAP, `${t.role} ${t.move.type} at ${p.apr_bps} bps APR`)
        assert.ok(p.ltv_bps <= maxLtvForTerm(p.term_blocks), `${t.role} ${t.move.type} at ${p.ltv_bps} bps LTV for ${p.term_blocks} blocks`)
      }
      if ('agreed' in r.outcome) agreed++
      else reasons.set(r.outcome.no_deal, (reasons.get(r.outcome.no_deal) ?? 0) + 1)
    }
    assert.ok(agreed > 30, `some negotiations agree (${agreed})`)
    assert.ok((reasons.get('APR_CAP') ?? 0) > 0, 'a lender whose floor is above the cap never gets to offer')
  })

  it('clamps an opening above the cap and the 65% step on a 60-day term', async () => {
    // the borrower would open at 23% and 65%; the lender at its 18% floor + 4 = 22%
    const r = simulate(await bpolicy({ max_apr_bps: 2400, max_ltv_bps: 6500, opening: { apr_bps: 2300 }, term_blocks: { min: 60, max: 60 } }), await lpolicy({ min_apr_bps: 1800, max_ltv_bps: 5000, opening: { ltv_bps: 4000 } }), PARAMS)
    assert.ok(r.structure.ok && r.structure.term_blocks === 60)
    const moves = r.turns.flatMap((t) => ('position' in t.move ? [{ type: t.move.type, ...t.move.position }] : []))
    assert.deepEqual([moves[0].type, moves[0].apr_bps, moves[0].ltv_bps], ['ASK', CAP, 6000], 'the ASK is clamped to the cap and the 60-day limit')
    assert.deepEqual([moves[1].type, moves[1].apr_bps], ['OFFER', CAP], 'the lender opens at 22% but the cap is 19%')
    assert.ok(r.turns.every((t) => !('position' in t.move) || t.move.position.apr_bps <= CAP))
  })

  it('caps the term at the longest LTV bucket', async () => {
    const r = simulate(await bpolicy({ term_blocks: { min: 30, max: 120 } }), await lpolicy({ term_blocks: { min: 10, max: 120 } }), PARAMS)
    assert.ok(r.structure.ok && r.structure.term_blocks === 90)
    assert.deepEqual(simulate(await bpolicy({ term_blocks: { min: 100, max: 120 } }), await lpolicy({ term_blocks: { min: 10, max: 120 } }), PARAMS).outcome, { no_deal: 'TERM' })
  })

  it('a transcript with a position above the cap does not verify, even correctly signed', async () => {
    const { messages } = await runNegotiation(await bpolicy(), await lpolicy(), PARAMS, { borrower, lender, nonce: randomHex() })
    const chain: NegotiationMessage[] = [messages[0]]
    const above: Position = { ...(messages[0].body.position as Position), apr_bps: CAP + 1 }
    await appendMessage(chain, lender, 'OFFER', { position: above, policy_hash: 'ab'.repeat(32), required_checks: [], min_scorer_trust: 'dev-inprocess' })
    const v = verifyTranscript(chain, { borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, max_rounds: 3 })
    assert.ok(v.problems.some((p) => p.includes("outside the platform's APR cap or LTV limit")), JSON.stringify(v.problems))
    assert.equal(verifyTranscript(messages, { borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, max_rounds: 3 }).ok, true)
  })
})
