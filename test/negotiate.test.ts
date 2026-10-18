import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { hashObject, keyPairFromLabel, randomHex, signObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { termsHash } from '../src/core/terms.js'
import { escrowFor, partiesOf } from '../src/escrow/escrow.js'
import { approvalStatus, approve } from '../src/market/approvals.js'
import { readJson } from '../src/market/messages.js'
import { appendMessage, explainRanking, negotiationEvent, rankOffers, runNegotiation, simulate, structure, summarizeOffer, verifyTranscript, type EngineParams, type NegotiationMessage, type Position } from '../src/market/negotiate.js'
import { loadPolicy, policyValid, savePolicy, signBorrowerPolicy, signLenderPolicy, type BorrowerPolicy, type LenderPolicy } from '../src/market/policy.js'
import { bindingNonce, buildTermSheet, renderTermSheet, signTermSheet, termSheetHash, termSheetProblems, type TermSheet, type TermSheetInput } from '../src/market/termsheet.js'
import { CURE_BLOCKS } from '../src/registry/ladder.js'
import { Oracle } from '../src/oracle/oracle.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const borrowerKey = keyPairFromLabel('neg-borrower')
const lenderKey = keyPairFromLabel('neg-lender')
const checkerKey = keyPairFromLabel('neg-lender-checker')
const platform = keyPairFromLabel('neg-platform')
const borrower = new LocalKeySigner(borrowerKey)
const lender = new LocalKeySigner(lenderKey)
const U = MICRO_PER_USDT
const PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb', 'ln-rln'] }
const NONCE = 'aa'.repeat(32)
const oracle = new Oracle(keyPairFromLabel('neg-oracle'), 10_000_000)

/** The demo policies from the plan: up to 600 USDT, at most 12% APR and 50% LTV, 30 days. */
async function borrowerPolicy(over: Partial<BorrowerPolicy> = {}): Promise<BorrowerPolicy> {
  return signBorrowerPolicy(borrower, { asset_id: 'rgb:usdt', principal: { min: 300 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb', 'ln-rln'], issued_at: 1, ...over })
}
/** Up to 1,000 per loan, at least 10% APR, investigation required. */
async function lenderPolicy(over: Partial<LenderPolicy> = {}): Promise<LenderPolicy> {
  return signLenderPolicy(lender, { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: ['investigation', 'inflows'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [checkerKey.pubkey], maker_checker_above: 5_000 * U }, issued_at: 1, ...over })
}

describe('policies', () => {
  it('are signed by their owners, validated, and stored with the signature checked on load', async () => {
    const bp = await borrowerPolicy()
    assert.ok(policyValid(bp))
    assert.ok(!policyValid({ ...bp, max_apr_bps: 5000 }), 'an edited bound breaks the signature')
    await assert.rejects(borrowerPolicy({ max_ltv_bps: 12_000 }), /max_ltv_bps/)
    await assert.rejects(lenderPolicy({ max_outstanding: 1 }), /max_per_loan\/max_outstanding/)
    const dir = mkdtempSync(join(tmpdir(), 'passbook-policy-'))
    try {
      const file = join(dir, 'borrower.json')
      savePolicy(file, bp)
      assert.deepEqual(loadPolicy(file), bp)
      writeFileSync(file, readFileSync(file, 'utf8').replace('"max_apr_bps": 1200', '"max_apr_bps": 9000'))
      assert.throws(() => loadPolicy(file), /does not verify/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('negotiation engine', () => {
  it('reaches an agreement inside both policies within three rounds', async () => {
    const r = simulate(await borrowerPolicy(), await lenderPolicy(), PARAMS)
    assert.ok('agreed' in r.outcome, JSON.stringify(r.turns))
    const a = r.outcome.agreed
    assert.ok(a.apr_bps >= 1000 && a.apr_bps <= 1200, `apr ${a.apr_bps}`)
    assert.ok(a.ltv_bps <= 5000)
    assert.equal(a.principal, 600 * U)
    assert.equal(a.settlement, 'cosign-rgb')
    const types = r.turns.map((t) => t.move.type)
    assert.equal(types[0], 'ASK')
    assert.equal(types[1], 'OFFER')
    assert.equal(types.at(-1), 'ACCEPT')
    for (const role of ['borrower', 'lender'] as const) assert.ok(r.turns.filter((t) => t.role === role && ['OFFER', 'COUNTER'].includes(t.move.type)).length <= 3)
  })

  it('ends in no deal when the bounds never meet, or when structure does not fit', async () => {
    const r = simulate(await borrowerPolicy({ max_apr_bps: 800 }), await lenderPolicy(), PARAMS)
    assert.deepEqual(r.outcome, { no_deal: 'MAX_ROUNDS' })
    assert.equal(r.turns.filter((t) => t.move.type === 'COUNTER' || t.move.type === 'OFFER').length, 6, 'three rounds each way, then stop')
    assert.deepEqual(simulate(await borrowerPolicy({ principal: { min: 2_000 * U, max: 3_000 * U } }), await lenderPolicy(), PARAMS).outcome, { no_deal: 'PRINCIPAL' })
    assert.deepEqual(simulate(await borrowerPolicy({ term_blocks: { min: 90, max: 120 } }), await lenderPolicy(), PARAMS).outcome, { no_deal: 'TERM' })
    assert.deepEqual(simulate(await borrowerPolicy({ accepted_settlements: ['ln-rln'] }), await lenderPolicy(), PARAMS).outcome, { no_deal: 'SETTLEMENT' })
    assert.deepEqual(simulate(await borrowerPolicy({ asset_id: 'rgb:other' }), await lenderPolicy(), PARAMS).outcome, { no_deal: 'ASSET' })
  })

  it('prefers atomic settlement when both sides and the deployment allow it', async () => {
    const bp = await borrowerPolicy(), lp = await lenderPolicy({ accepted_settlements: ['cosign-rgb', 'ln-rln'] })
    const s = structure(bp, lp, PARAMS)
    assert.ok(s.ok && s.settlement === 'ln-rln')
    const off = structure(bp, lp, { ...PARAMS, enabled_settlements: ['cosign-rgb'] })
    assert.ok(off.ok && off.settlement === 'cosign-rgb')
  })

  it('never crosses a policy bound and always terminates (300 seeded random policy pairs)', async () => {
    let seed = 7
    const rand = (lo: number, hi: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return lo + (seed % (hi - lo + 1)) }
    let deals = 0
    for (let i = 0; i < 300; i++) {
      const bp = await borrowerPolicy({ max_apr_bps: rand(200, 3000), max_ltv_bps: rand(2000, 8000) })
      const lp = await lenderPolicy({ min_apr_bps: rand(200, 3000), max_ltv_bps: rand(2000, 8000) })
      const params = { ...PARAMS, max_rounds: rand(1, 5), concession_bps: rand(500, 9000) }
      const r = simulate(bp, lp, params)
      for (const t of r.turns) {
        if (!('position' in t.move)) continue
        const p = t.move.position
        if (t.role === 'borrower' && t.move.type !== 'ACCEPT') assert.ok(p.apr_bps <= bp.max_apr_bps && p.ltv_bps <= bp.max_ltv_bps, `borrower crossed: ${JSON.stringify(p)}`)
        if (t.role === 'lender' && t.move.type !== 'ACCEPT') assert.ok(p.apr_bps >= lp.min_apr_bps && p.ltv_bps <= lp.max_ltv_bps, `lender crossed: ${JSON.stringify(p)}`)
      }
      if ('agreed' in r.outcome) {
        deals++
        const a = r.outcome.agreed
        assert.ok(a.apr_bps <= bp.max_apr_bps && a.apr_bps >= lp.min_apr_bps && a.ltv_bps <= Math.min(bp.max_ltv_bps, lp.max_ltv_bps), 'agreement inside both policies')
      }
      assert.ok(r.turns.length <= 2 * params.max_rounds + 2)
    }
    assert.ok(deals > 30 && deals < 300, `both outcomes exercised (${deals} deals)`)
  })

  it('gives the same transcript for the same inputs', async () => {
    const bp = await borrowerPolicy(), lp = await lenderPolicy()
    const a = await runNegotiation(bp, lp, PARAMS, { borrower, lender, nonce: NONCE })
    const b = await runNegotiation(bp, lp, PARAMS, { borrower, lender, nonce: NONCE })
    // Signatures use random aux data, so drop them and the hashes that cover them.
    const unsigned = (ms: NegotiationMessage[]) => ms.map(({ sig: _s, prev_hash: _p, body: { accepted_hash: _a, ...body }, ...m }) => ({ ...m, body }))
    assert.deepEqual(unsigned(a.messages), unsigned(b.messages))
    assert.deepEqual(simulate(bp, lp, PARAMS), simulate(bp, lp, PARAMS))
  })
})

describe('signed message chain', () => {
  async function transcript() {
    return runNegotiation(await borrowerPolicy(), await lenderPolicy(), PARAMS, { borrower, lender, nonce: NONCE })
  }
  const expect = { borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, max_rounds: 3 }

  it('verifies an honest transcript and yields the accepted position', async () => {
    const { messages, outcome } = await transcript()
    const v = verifyTranscript(messages, expect)
    assert.deepEqual(v.problems, [])
    assert.ok('agreed' in outcome)
    assert.deepEqual(v.agreed, outcome.agreed)
  })

  it('rejects a tampered, reordered, truncated or re-signed chain', async () => {
    const { messages } = await transcript()
    const edited = structuredClone(messages)
    ;(edited[1].body.position as Position).apr_bps = 1
    assert.ok(verifyTranscript(edited, expect).problems.some((p) => p.includes('bad signature')))
    const resigned = structuredClone(messages)
    resigned[1] = signObject({ ...resigned[1], body: { ...resigned[1].body, position: { ...(resigned[1].body.position as Position), apr_bps: 1 } } }, lenderKey.secretKey)
    assert.ok(verifyTranscript(resigned, expect).problems.some((p) => p.includes('broken hash chain') || p.includes('must accept the previous position')), 'a re-signed edit breaks the next link')
    assert.ok(!verifyTranscript([messages[0], messages[2], messages[1], ...messages.slice(3)], expect).ok)
    assert.ok(!verifyTranscript([messages[0], ...messages.slice(2)], expect).ok)
    assert.ok(verifyTranscript(messages, { ...expect, max_rounds: 1 }).problems.some((p) => p.includes('more than 1 rounds')))
    assert.ok(!verifyTranscript(messages, { ...expect, lender_pk: keyPairFromLabel('stranger').pubkey }).ok)
  })

  it('rejects an ACCEPT of a different position and moves after a no-deal', async () => {
    const { messages } = await transcript()
    const chain = messages.slice(0, -1)
    await appendMessage(chain, borrower.pubkey === messages.at(-2)!.from_pk ? lender : borrower, 'ACCEPT', { accepted_hash: hashObject(chain.at(-1)), position: { ...(chain.at(-1)!.body.position as Position), apr_bps: 1 } })
    assert.ok(verifyTranscript(chain, expect).problems.some((p) => p.includes('must accept the previous position exactly')))
    const failed = await runNegotiation(await borrowerPolicy({ max_apr_bps: 800 }), await lenderPolicy(), PARAMS, { borrower, lender, nonce: NONCE })
    await appendMessage(failed.messages, lender, 'TERMSHEET', { termsheet_hash: '00'.repeat(32) })
    assert.ok(verifyTranscript(failed.messages, expect).problems.some((p) => p.includes('ended without a deal')))
  })

  it('travels as Nostr events: ASK public, the rest encrypted to the counterparty', async () => {
    const { messages } = await transcript()
    const ask = negotiationEvent(borrowerKey, messages[0])
    assert.deepEqual(readJson(ask), messages[0])
    const offer = negotiationEvent(lenderKey, messages[1], borrowerKey.pubkey)
    assert.ok(!offer.content.includes('apr_bps'))
    assert.deepEqual(readJson(offer, borrowerKey), messages[1])
    assert.throws(() => negotiationEvent(borrowerKey, messages[1], lenderKey.pubkey), /only the sender/)
  })
})

describe('term sheet and approvals', () => {
  async function sheet(over: Partial<TermSheetInput> = {}): Promise<{ sheet: TermSheet; agreed: Position; accept_hash: Hex }> {
    const neg = await runNegotiation(await borrowerPolicy(), await lenderPolicy(), PARAMS, { borrower, lender, nonce: NONCE })
    const v = verifyTranscript(neg.messages, { borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, max_rounds: 3 })
    const agreed = v.agreed!
    const built = buildTermSheet({
      agreed, negotiation: { id: neg.messages[0].negotiation_id, accept_hash: v.accept_hash! }, borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, platform_pk: platform.pubkey,
      asset_id: 'rgb:usdt', oracle_quote: oracle.quote(500), grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
      scorer: { provider: 'container', scorer_id: 'passbook-sandbox:container:abc', code_measurement: 'sha256:' + 'ab'.repeat(32), contract_hash: 'cd'.repeat(32), trust: 'dev-inprocess', result_hash: 'ef'.repeat(32), fallback: true, recommendation: 'QUALIFY', evidence: { kind: 'passbook-run-record', run_record_sha256: '9a'.repeat(32) } },
      consent_hash: '12'.repeat(32), salt: randomHex(), ...over,
    })
    return { sheet: built, agreed, accept_hash: v.accept_hash! }
  }

  it('hashes to the on-chain terms hash and binds every other field through the terms nonce', async () => {
    const { sheet: s, agreed, accept_hash } = await sheet()
    assert.equal(termSheetHash(s), termsHash(s.terms))
    assert.deepEqual(termSheetProblems(s, { agreed, accept_hash }), [])
    const chain = new FakeChain(500)
    const lock = chain.addTx([{ value: s.terms.collateral_sats, script: escrowFor(partiesOf(s.terms)).script }, { value: 0, script: opReturnScript(termSheetHash(s)) }])
    chain.mine()
    assert.equal((await chain.getTx(lock))!.outputs[1].script, opReturnScript(termsHash(s.terms)), 'the lock commits to the sheet')
    const swapped = { ...s, scorer: { ...s.scorer, trust: 'software-evidence' as const, fallback: false } }
    assert.throws(() => termSheetHash(swapped), /not bound/)
    assert.ok(termSheetProblems(swapped, {}).includes('terms nonce does not bind this sheet'))
    assert.ok(termSheetProblems(s, { agreed: { ...agreed, apr_bps: agreed.apr_bps + 1 } }).includes('sheet does not follow the accepted position'))
    assert.ok(termSheetProblems({ ...s, apr_bps: s.apr_bps + 1 } as TermSheet, {}).length > 0)
    assert.ok(termSheetProblems({ ...s, leak: 1 } as unknown as TermSheet, {}).some((p) => p.includes('field not allowed')))
  })

  it('refuses a correctly bound and signed sheet that advertises a different cure window', async () => {
    const { sheet: s } = await sheet()
    assert.equal(s.collateral.cure_blocks, CURE_BLOCKS)
    // built outside buildTermSheet: a longer cure window, the terms nonce re-bound to it, then both signatures
    const forged: TermSheet = { ...s, collateral: { ...s.collateral, cure_blocks: CURE_BLOCKS * 10 } }
    forged.terms = { ...forged.terms, nonce: bindingNonce(forged) }
    const signed = signTermSheet(signTermSheet(forged, 'lender', lenderKey.secretKey), 'borrower', borrowerKey.secretKey)
    const problems = termSheetProblems(signed, { requireSignatures: true })
    assert.deepEqual(problems, ['collateral figures do not follow from the terms'])
  })

  it('both agents sign it; a ln-rln sheet carries v2 terms with the invoice hash', async () => {
    const { sheet: s } = await sheet()
    const signed = signTermSheet(signTermSheet(s, 'lender', lenderKey.secretKey), 'borrower', borrowerKey.secretKey)
    assert.deepEqual(termSheetProblems(signed, { requireSignatures: true }), [])
    assert.ok(termSheetProblems(signTermSheet(s, 'lender', borrowerKey.secretKey), {}).includes('lender signature invalid'))
    assert.ok(termSheetProblems(s, { requireSignatures: true }).includes('borrower signature missing'))
    const atomic = { invoice: 'lnbcrt1fake', btc_amount_msat: 3_000_000 as const, payment_hash: '34'.repeat(32), expires_at: 1_800_000_000, payee_pubkey: '02' + 'ab'.repeat(32) }
    await assert.rejects(sheet({ settlement: { kind: 'ln-rln', atomic } }), /settlement params are ln-rln, the agreement says cosign-rgb/)
  })

  it('renders plain language with every number from code', async () => {
    const { sheet: s } = await sheet()
    const r = renderTermSheet(s, { audience: 'borrower' })
    assert.match(r.title, /^Borrow 600\.00 USDT against 0\.\d{8} BTC$/)
    assert.ok(r.lines.some((l) => l.includes('You repay')))
    assert.match(r.scorer, /FALLBACK/)
    assert.match(r.final, /can.t be undone/)
    assert.ok(r.if_price_falls.length === 2 && r.if_not_repaid.length === 2)
  })

  async function approvals(principal: number, deploymentAbove = 5_000 * U) {
    const lp = await lenderPolicy()
    const { sheet: s } = await sheet()
    const big = principal === s.terms.principal ? s : buildTermSheet({ agreed: { ...s.scorer && { principal, apr_bps: s.apr_bps, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' } }, negotiation: s.negotiation, borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:usdt', oracle_quote: s.terms.oracle_quote, grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' }, scorer: s.scorer as TermSheetInput['scorer'], consent_hash: s.consent_hash, salt: randomHex() })
    return { lp, s: big, status: (keys: [KeyPair, 'borrower' | 'lender'][], other?: TermSheet) => approvalStatus(big, keys.map(([k, role]) => approve(k, other ?? big, role, 2)), lp, deploymentAbove) }
  }

  it('needs the borrower and one lender key below the maker-checker threshold', async () => {
    const { status } = await approvals(600 * U)
    assert.equal(status([[lenderKey, 'lender']]).complete, false, 'nothing moves before the borrower approves')
    const ok = status([[borrowerKey, 'borrower'], [lenderKey, 'lender']])
    assert.equal(ok.required_lender_approvals, 1)
    assert.equal(ok.complete, true)
  })

  it('needs two distinct lender keys above the threshold (four eyes)', async () => {
    const { status } = await approvals(6_000 * U)
    const one = status([[borrowerKey, 'borrower'], [lenderKey, 'lender'], [lenderKey, 'lender']])
    assert.equal(one.required_lender_approvals, 2)
    assert.equal(one.complete, false, 'the same key twice is still one approver')
    assert.equal(status([[borrowerKey, 'borrower'], [lenderKey, 'lender'], [checkerKey, 'lender']]).complete, true)
    const rogue = status([[borrowerKey, 'borrower'], [lenderKey, 'lender'], [keyPairFromLabel('rogue'), 'lender']])
    assert.equal(rogue.complete, false)
    assert.ok(rogue.problems.includes('LENDER_APPROVAL_FROM_UNLISTED_KEY'))
  })

  it('applies the stricter deployment threshold and rejects an approval for another term sheet', async () => {
    const { status } = await approvals(600 * U, 500 * U)
    assert.equal(status([[borrowerKey, 'borrower'], [lenderKey, 'lender']]).required_lender_approvals, 2)
    const other = (await sheet()).sheet
    const { status: s2 } = await approvals(600 * U)
    const replay = s2([[borrowerKey, 'borrower'], [lenderKey, 'lender']], other)
    assert.equal(replay.complete, false)
    assert.ok(replay.problems.includes('APPROVAL_FOR_ANOTHER_TERMSHEET'))
  })
})

describe('the model explains, code decides', () => {
  const offers = [
    summarizeOffer(keyPairFromLabel('lender-b').pubkey, { principal: 600 * U, apr_bps: 1000, ltv_bps: 4500, term_blocks: 30, settlement: 'cosign-rgb' }, { price_cents: 10_000_000 }),
    summarizeOffer(keyPairFromLabel('lender-a').pubkey, { principal: 600 * U, apr_bps: 1100, ltv_bps: 5000, term_blocks: 30, settlement: 'ln-rln' }, { price_cents: 10_000_000, lender_record_steps: 2 }),
  ]

  it('ranks by total cost, then collateral, then the lender record', () => {
    const ranked = rankOffers(offers)
    assert.equal(ranked[0].position.apr_bps, 1000)
    const tie = rankOffers([{ ...offers[1], fee: offers[0].fee, collateral_sats: offers[0].collateral_sats }, offers[0]])
    assert.equal(tie[0].lender_record_steps, 2, 'equal cost and collateral: the longer record wins')
  })

  it('discards any model text that contains a number and falls back to the code template', async () => {
    const ranked = rankOffers(offers)
    const numeric = await explainRanking(ranked, async () => 'Lender B is cheaper by 0.8 USDT, take it.')
    assert.equal(numeric.by, 'template')
    assert.match(numeric.text, /^Best: /)
    const spelled = await explainRanking(ranked, async () => 'Lender B costs five dollars less.')
    assert.equal(spelled.by, 'template')
    const words = await explainRanking(ranked, async () => 'Lender B is cheaper but asks for more collateral than the next offer.')
    assert.deepEqual(words, { text: 'Lender B is cheaper but asks for more collateral than the next offer.', by: 'model' })
    assert.equal((await explainRanking(ranked, async () => { throw new Error('model down') })).by, 'template')
  })
})
