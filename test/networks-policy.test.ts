// The lender's layer policy meets the borrower's shared layers: a missing
// required layer is NO_DEAL with the reason, a passing optional layer moves
// LTV by a bounded, clamped step, and the negotiation engine never crosses it.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm } from '../src/core/economics.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { engineParams, simulate } from '../src/market/negotiate.js'
import { signBorrowerPolicy, signLenderPolicy } from '../src/market/policy.js'
import { LocalKeySigner } from '../src/wallet/signer.js'
import { DEFAULT_LENDER_LAYER_POLICY, layerConsentProblems, layerPolicyProblems, negotiateLayers, signLayerConsent, withLayerLtv, type LayerResult, type LenderLayerPolicy } from '../src/networks/policy.js'
import type { LayerFeatures } from '../src/networks/features.js'
import type { LayerId } from '../src/networks/types.js'

const ok = (layer: LayerId, extra: Partial<LayerResult> = {}): LayerResult => ({ layer, shared: true, consented: true, control: [{ ok: true, layer, subject: 's', format: layer === 'btc-onchain' ? 'bip322-simple' : layer === 'lightning' ? 'ln-invoice' : 'bip340-text', reasons: [] }], recompute: layer === 'btc-onchain' ? { layer, ok: true, source: 'lender esplora', height: 1, matched: 3, tampered: [], missing: [], unknown: [], calls: [] } : null, wallet_age_days: 400, evidence: true, limits: [], ...extra })
const policy = (p: Partial<LenderLayerPolicy> = {}): LenderLayerPolicy => ({ ...DEFAULT_LENDER_LAYER_POLICY, ...p })
const all: LayerId[] = ['rgb', 'btc-onchain', 'lightning']

describe('layer policy intersection', () => {
  it('the default policy is valid and needs RGB only', () => {
    assert.deepEqual(layerPolicyProblems(DEFAULT_LENDER_LAYER_POLICY), [])
    assert.deepEqual(DEFAULT_LENDER_LAYER_POLICY.required_layers, ['rgb'])
    assert.deepEqual(DEFAULT_LENDER_LAYER_POLICY.evidence_weights, { chain_recomputable_known_payer_bps: 10_000, chain_recomputable_unknown_payer_bps: 7_000, counterparty_signed_bps: 10_000, client_side_validated_bps: 7_000, self_reported_bps: 0 })
  })

  it('a missing required layer is NO_DEAL with the reason', () => {
    const n = negotiateLayers(policy(), { shareable_layers: ['btc-onchain', 'lightning'], subjects: {} }, [ok('btc-onchain'), ok('lightning')], null)
    assert.equal(n.outcome, 'NO_DEAL')
    assert.deepEqual(n.reasons, ['required layer rgb not shared'])
    assert.equal(n.ltv_bonus_bps, 0)
  })

  it('a required layer that fails names why: a tampered row the lender recomputed', () => {
    const tampered = ok('btc-onchain', { recompute: { layer: 'btc-onchain', ok: false, source: 'lender esplora', height: 1, matched: 2, tampered: [{ txid: 'ab'.repeat(32), field: 'amount', claimed: '5000000', recomputed: '50000' }], missing: [], unknown: [], calls: [] } })
    const n = negotiateLayers(policy({ required_layers: ['rgb', 'btc-onchain'] }), { shareable_layers: all, subjects: {} }, [ok('rgb'), tampered, ok('lightning')], null)
    assert.equal(n.outcome, 'NO_DEAL')
    assert.match(n.reasons[0], /^required layer btc-onchain failed: row abababababab… amount: borrower 5000000, lender recomputed 50000$/)
  })

  it('each passing optional layer adds a fixed step, capped', () => {
    assert.equal(negotiateLayers(policy(), { shareable_layers: ['rgb'], subjects: {} }, [ok('rgb')], null).ltv_bonus_bps, 0)
    assert.equal(negotiateLayers(policy(), { shareable_layers: ['rgb', 'btc-onchain'], subjects: {} }, [ok('rgb'), ok('btc-onchain')], null).ltv_bonus_bps, 200)
    assert.equal(negotiateLayers(policy(), { shareable_layers: all, subjects: {} }, all.map((l) => ok(l)), null).ltv_bonus_bps, 400)
    assert.equal(negotiateLayers(policy({ ltv_step_bps: 300, ltv_max_bonus_bps: 400 }), { shareable_layers: all, subjects: {} }, all.map((l) => ok(l)), null).ltv_bonus_bps, 400)
  })

  it('a failing optional layer gives no bonus but no penalty; a young wallet does not pass', () => {
    const young = ok('btc-onchain', { wallet_age_days: 0 })
    const n = negotiateLayers(policy({ min_wallet_age_days: 30 }), { shareable_layers: ['rgb', 'btc-onchain'], subjects: {} }, [ok('rgb'), young], null)
    assert.equal(n.outcome, 'DEAL')
    assert.equal(n.ltv_bonus_bps, 0)
    assert.deepEqual(n.layers.find((l) => l.layer === 'btc-onchain')!.why, ["wallet age 0 days, under the lender's 30"])
  })

  it('proving control of an empty address or a bare node earns no LTV', () => {
    const empty = ok('btc-onchain', { evidence: false })
    const n = negotiateLayers(policy(), { shareable_layers: ['rgb', 'btc-onchain', 'lightning'], subjects: {} }, [ok('rgb'), empty, ok('lightning', { evidence: false })], null)
    assert.equal(n.outcome, 'DEAL')
    assert.equal(n.ltv_bonus_bps, 0)
    assert.match(n.layers.find((l) => l.layer === 'btc-onchain')!.why[0], /proving control alone earns no LTV/)
  })

  it('a shared layer the lender does not accept is not read and gives nothing', () => {
    const n = negotiateLayers(policy({ accepted_layers: { rgb: 10_000 } }), { shareable_layers: all, subjects: {} }, all.map((l) => ok(l)), null)
    assert.equal(n.outcome, 'DEAL')
    assert.equal(n.ltv_bonus_bps, 0)
    assert.equal(n.layers.find((l) => l.layer === 'lightning')!.status, 'not-accepted')
  })

  it('a blocking typology or a sanctions hit on any shared layer is NO_DEAL', () => {
    const f = (over: Partial<LayerFeatures>): LayerFeatures => ({ policy: 'passbook-layer-features-v1', features: [], rows: [], typologies: [], score: 0, disposition: 'clear', sanctions: { screen: 'stub', list_version: 'none', screened: { proven: 0, counterparties: 0 }, hits: [], status: 'not_screened' }, ...over })
    const blocked = negotiateLayers(policy(), { shareable_layers: all, subjects: {} }, all.map((l) => ok(l)), f({ typologies: [{ type: 'HIDDEN_LIABILITY', matched: true, weight: 100, disposition: 'block', support: [], layers: ['btc-onchain'], rules: [], limitations: [] }] }))
    assert.deepEqual(blocked.reasons, ['typology HIDDEN_LIABILITY blocks (btc-onchain)'])
    const hit = negotiateLayers(policy(), { shareable_layers: all, subjects: {} }, all.map((l) => ok(l)), f({ sanctions: { screen: 'offline-snapshot', list_version: 'ofac-sdn-xbt@2026-10-01', screened: { proven: 1, counterparties: 3 }, hits: [{ address: 'bc1qbadbadbadbadbad', hop: 1, via: 'bc1qmine', list_id: 'ofac-sdn-xbt' }], status: 'hit' } }))
    assert.equal(hit.outcome, 'NO_DEAL')
    assert.match(hit.reasons[0], /^sanctions hit on 1 address\(es\) \(ofac-sdn-xbt@2026-10-01\): hop 1 bc1qbadbadbadb…$/)
  })

  it('the btc-onchain trust mode is always the lender recomputing; self-reported always counts zero', () => {
    assert.ok(layerPolicyProblems(policy({ trust_mode_by_layer: { 'btc-onchain': 'borrower-device' } })).some((p) => p.includes('lender-recompute')))
    assert.ok(layerPolicyProblems(policy({ evidence_weights: { ...DEFAULT_LENDER_LAYER_POLICY.evidence_weights, self_reported_bps: 100 } })).length > 0)
  })
})

describe('consent per layer, per subject, per loan', () => {
  it('names the trust mode and fails for another lender, negotiation or after expiry', () => {
    const key = keyPairFromLabel('layers-consent'), L = randomHex(32), N = randomHex(32)
    const c = signLayerConsent(key, { lender_pk: L, negotiation_id: N, layer: 'btc-onchain', chain: 'bitcoin', subject: 'bc1qexample', trust_mode: 'lender-recompute', scope: 'proof-and-history', window_days: 365, issued_at: 100, expires_at: 200 })
    const expect = { borrower_pk: key.pubkey, lender_pk: L, negotiation_id: N, now: 150 }
    assert.deepEqual(layerConsentProblems(c, expect), [])
    assert.equal(c.trust_mode, 'lender-recompute')
    assert.ok(layerConsentProblems(c, { ...expect, lender_pk: randomHex(32) }).includes('CONSENT_WRONG_LENDER'))
    assert.ok(layerConsentProblems(c, { ...expect, negotiation_id: randomHex(32) }).includes('CONSENT_WRONG_NEGOTIATION'))
    assert.ok(layerConsentProblems(c, { ...expect, now: 201 }).includes('CONSENT_EXPIRED'))
    assert.ok(layerConsentProblems({ ...c, subject: 'bc1qother' }, expect).includes('CONSENT_SIGNATURE_INVALID'))
  })
})

describe('LTV bonus in the negotiation engine', () => {
  it('raises the lender bound by the bonus, clamped to the platform limit for the term; the engine never crosses it', async () => {
    const lender = keyPairFromLabel('layers-lender'), borrower = keyPairFromLabel('layers-borrower')
    const asset = 'rgb:usdt-test'
    const lp = await signLenderPolicy(new LocalKeySigner(lender), { asset_id: asset, max_per_loan: 1_000 * MICRO_PER_USDT, max_outstanding: 5_000 * MICRO_PER_USDT, min_apr_bps: 800, max_ltv_bps: 6_000, term_blocks: { min: 10, max: 30 }, required_checks: [], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [], maker_checker_above: 0 }, issued_at: 1 })
    const bp = await signBorrowerPolicy(new LocalKeySigner(borrower), { asset_id: asset, principal: { min: 100 * MICRO_PER_USDT, max: 600 * MICRO_PER_USDT }, max_apr_bps: 1_500, max_ltv_bps: 7_000, term_blocks: { min: 10, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], opening: { ltv_bps: 7_000 }, issued_at: 1 })
    const cap = maxLtvForTerm(30, DEFAULT_ECONOMICS)
    assert.equal(cap, 6_500)
    const raised = withLayerLtv(lp, 400)
    assert.equal(raised.max_ltv_bps, 6_400)
    assert.equal(raised.unsigned_copy, true)
    const clamped = withLayerLtv(lp, 2_000)
    assert.equal(clamped.max_ltv_bps, 6_500, 'never past the platform limit for the term')
    assert.equal(withLayerLtv(lp, -500).max_ltv_bps, 6_000, 'never below the signed bound')
    const params = engineParams({ negotiation: { enabled: true, max_rounds: 3, concession_bps: 2_500 }, settlement: { default: 'cosign-rgb', enabled: ['cosign-rgb', 'ln-rln'] } })
    const before = simulate(bp, lp, params)
    const after = simulate(bp, withLayerLtv(lp, 400), params)
    assert.ok('agreed' in before.outcome && 'agreed' in after.outcome)
    if ('agreed' in before.outcome && 'agreed' in after.outcome) {
      assert.ok(after.outcome.agreed.ltv_bps > before.outcome.agreed.ltv_bps)
      assert.ok(after.outcome.agreed.ltv_bps <= 6_400)
    }
  })
})
