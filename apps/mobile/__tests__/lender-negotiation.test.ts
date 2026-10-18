// Lane E3: the phone lender's signed market policy and its negotiation over Nostr. The policy
// passes the laptop's own validation (policy.ts), its published terms carry no APR floor or LTV
// cap, and the phone's serveNegotiations, with the party key behind the signer, agrees only
// inside that policy with a separate borrower key holder; both hold one verified transcript.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashObject, keyPairFromLabel, type Hex } from '../../../src/core/crypto.ts'
import { MICRO_PER_USDT } from '../../../src/core/money.ts'
import { lenderPolicyProblems, policyValid, signBorrowerPolicy, type BorrowerPolicy } from '../../../src/market/policy.ts'
import { keyPairSigner, negotiateAsBorrower, serveNegotiations, type NegotiationResult } from '../../../src/market/negotiate-nostr.ts'
import { verifyTranscript, type Position } from '../../../src/market/negotiate-engine.ts'
import { LocalKeySigner } from '../../../src/wallet/signer.ts'
import { PASSBOOK_ONLY } from '../src/agent/lender.ts'
import { engineParams, marketPolicyInput, maxLtv, offerTerms, outsidePolicy, requiredChecks, signMarketPolicy } from '../src/lender/market-policy.ts'
import { lenderSigner } from '../src/lender/signer.ts'
import { MemoryRelay, partyKey } from './lender-helpers.ts'

const U = MICRO_PER_USDT
const L = keyPairFromLabel('e3-lender'), B = keyPairFromLabel('e3-borrower')
const OPERATOR = keyPairFromLabel('e3-operator').pubkey
const ASSET = 'rgb:usdt-mutinynet'
const OFFER = { ...PASSBOOK_ONLY, apr_bps: 1200 }
const choice = { floor_apr_bps: 1000, check_operators: [OPERATOR] }
const params = engineParams({ negotiation: { max_rounds: 4, concession_bps: 2500 } })

async function borrowerPolicy(over: Partial<BorrowerPolicy> = {}): Promise<BorrowerPolicy> {
  return signBorrowerPolicy(new LocalKeySigner(B), { asset_id: ASSET, principal: { min: 100 * U, max: 100 * U }, max_apr_bps: 1100, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: 1, ...over })
}

test('the phone\'s market policy passes the laptop\'s validation, signed by the party key', async () => {
  const policy = await signMarketPolicy(partyKey(L), ASSET, OFFER, choice, 1_000)
  assert.deepEqual(lenderPolicyProblems(policy), [])
  assert.ok(policyValid(policy), 'signed by its owner over hashObject without sig (signWith)')
  assert.equal(policy.min_apr_bps, 1000)
  assert.equal(policy.opening?.apr_bps, 1200, 'the agent opens at the posted APR')
  assert.equal(policy.max_ltv_bps, maxLtv(OFFER), 'the top of the ladder under the platform limit')
  assert.deepEqual(policy.approval_rules, { approvers: [L.pubkey], maker_checker_above: OFFER.max }, 'one key on the phone: never a loan that needs a second approver')
  assert.deepEqual(policy.check_nodes, { accepted_check_operators: [OPERATOR] })
  assert.deepEqual(requiredChecks(OFFER.requirements), ['affordability'])
  assert.throws(() => marketPolicyInput(L.pubkey, ASSET, OFFER, { ...choice, floor_apr_bps: 1300 }, 1), /lowest APR/)
  assert.throws(() => marketPolicyInput(L.pubkey, ASSET, OFFER, { ...choice, check_operators: [] }, 1), /check node/)
})

test('the published terms carry the structure only: never the APR floor or the LTV cap', async () => {
  const policy = await signMarketPolicy(partyKey(L), ASSET, OFFER, choice, 1_000)
  const t = offerTerms(policy, params, OFFER.min, 0)
  assert.equal(t.policy_hash, hashObject(policy))
  assert.equal(t.lender_pk, L.pubkey)
  assert.equal(t.max_rounds, 4)
  const words = JSON.stringify(t)
  assert.ok(!/min_apr|max_ltv|opening/.test(words), words)
  assert.equal(offerTerms(policy, params, OFFER.min, OFFER.max).max_principal, 0, 'nothing left to lend while a loan is outstanding')
})

test('outsidePolicy names every bound an agreement leaves', async () => {
  const policy = await signMarketPolicy(partyKey(L), ASSET, OFFER, choice, 1_000)
  const ok: Position = { principal: 100 * U, apr_bps: 1050, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' }
  assert.deepEqual(outsidePolicy(policy, ok), [])
  assert.match(outsidePolicy(policy, { ...ok, apr_bps: 999 }).join(), /below the floor/)
  assert.match(outsidePolicy(policy, { ...ok, ltv_bps: 7000 }).join(), /LTV/)
  assert.match(outsidePolicy(policy, { ...ok, principal: OFFER.max + 1 }).join(), /principal/)
  assert.match(outsidePolicy(policy, { ...ok, term_blocks: 60 }).join(), /term/)
  assert.match(outsidePolicy(policy, { ...ok, apr_bps: 2500 }).join(), /cap/)
})

async function negotiate(bp: BorrowerPolicy) {
  const relay = new MemoryRelay()
  const policy = await signMarketPolicy(partyKey(L), ASSET, OFFER, choice, 1_000)
  const terms = offerTerms(policy, params, OFFER.min, 0)
  const results: NegotiationResult[] = []
  const signer = lenderSigner(partyKey(L))
  const server = serveNegotiations({ transport: relay, policy, params, signer: () => signer, min_principal: OFFER.min, timeoutMs: 2_000, onResult: (r) => results.push(r) })
  try {
    const b = await negotiateAsBorrower({ transport: relay, signer: keyPairSigner(B), policy: bp, terms, params, timeoutMs: 2_000 })
    for (let i = 0; i < 50 && !results.length; i++) await new Promise((r) => setTimeout(r, 20))
    return { b, l: results[0], policy, relay }
  } finally { server.close() }
}

test('over Nostr: the phone lender agrees inside its policy with a separate borrower key; one verified transcript', async () => {
  const { b, l, policy } = await negotiate(await borrowerPolicy())
  assert.ok('agreed' in b.outcome, JSON.stringify(b.outcome))
  assert.ok(l && 'agreed' in l.outcome, 'the lender side reached the same agreement')
  assert.equal(hashObject(b.messages), hashObject(l.messages), 'both hold the same transcript')
  const v = verifyTranscript(l.messages, { borrower_pk: B.pubkey, lender_pk: L.pubkey, max_rounds: params.max_rounds })
  assert.ok(v.ok, v.problems.join('; '))
  assert.deepEqual(outsidePolicy(policy, v.agreed!), [])
  // every position the phone signed is inside its own policy, never below its floor
  for (const m of l.messages.filter((x) => x.from_pk === L.pubkey && x.body.position)) assert.ok((m.body.position as Position).apr_bps >= policy.min_apr_bps, `${m.type} at ${(m.body.position as Position).apr_bps}`)
  assert.equal(l.messages[0].type, 'ASK')
})

test('a borrower whose limit is under the floor gets no deal, and the phone never signs below its floor', async () => {
  const { b, l, policy } = await negotiate(await borrowerPolicy({ max_apr_bps: 900 }))
  assert.ok('no_deal' in b.outcome, JSON.stringify(b.outcome))
  assert.ok(l && 'no_deal' in l.outcome)
  for (const m of l.messages.filter((x) => x.from_pk === L.pubkey && x.body.position)) assert.ok((m.body.position as Position).apr_bps >= policy.min_apr_bps)
})

test('an ASK for more than the offer lends is refused with the structure code, nothing signed for it', async () => {
  const { b, l } = await negotiate(await borrowerPolicy({ principal: { min: 6_000 * U, max: 6_000 * U } }))
  // the borrower's own structure step already refuses: the terms publish max 5,000
  assert.ok('no_deal' in b.outcome && b.outcome.no_deal === 'PRINCIPAL', JSON.stringify(b.outcome))
  assert.equal(l, undefined, 'no ASK reached the lender')
})

test('the same ASK is answered once (replay store)', async () => {
  const relay = new MemoryRelay()
  const policy = await signMarketPolicy(partyKey(L), ASSET, OFFER, choice, 1_000)
  const terms = offerTerms(policy, params, OFFER.min, 0)
  const seen = new Set<Hex>()
  const results: NegotiationResult[] = []
  const signer = lenderSigner(partyKey(L))
  const opts = { transport: relay, policy, params, signer: () => signer, min_principal: OFFER.min, timeoutMs: 2_000, seen, onResult: (r: NegotiationResult) => results.push(r) }
  const s1 = serveNegotiations(opts)
  await negotiateAsBorrower({ transport: relay, signer: keyPairSigner(B), policy: await borrowerPolicy(), terms, params, timeoutMs: 2_000 })
  for (let i = 0; i < 50 && !results.length; i++) await new Promise((r) => setTimeout(r, 20))
  s1.close()
  // a restarted server with the same store sees the stored ASK again and ignores it
  const s2 = serveNegotiations(opts)
  await new Promise((r) => setTimeout(r, 100))
  s2.close()
  assert.equal(results.length, 1)
})

test('on a public network every event the lender signs whole is labelled test data; none on regtest', async () => {
  const t = { kind: 7491, created_at: 1, tags: [['t', 'passbook']], content: 'x' }
  const pub = await lenderSigner(partyKey(L), 'mutinynet').signEvent!(t)
  assert.deepEqual(pub.tags.find((x) => x[0] === 'network'), ['network', 'mutinynet'])
  assert.match(pub.tags.find((x) => x[0] === 'alt')![1], /test USDT on mutinynet, no value/)
  const reg = await lenderSigner(partyKey(L), 'regtest').signEvent!(t)
  assert.deepEqual(reg.tags, [['t', 'passbook']])
  assert.equal(typeof lenderSigner(partyKey(L)).signHash, 'function', 'the session\'s check signer: signHash over the party key')
})

test('the phone\'s offer lends from 10 test USDT; every other number is L2\'s, and a 10 test USDT loan negotiates inside it', async () => {
  const { PHONE_OFFER } = await import('../src/agent/lender.ts')
  assert.equal(PHONE_OFFER.min, 10 * U)
  assert.deepEqual({ ...PHONE_OFFER, min: PASSBOOK_ONLY.min }, PASSBOOK_ONLY, 'only the minimum differs from L2 (lender-parity holds PASSBOOK_ONLY to L2_POLICY)')
  const offer = { ...PHONE_OFFER, apr_bps: 1200 }
  const policy = await signMarketPolicy(partyKey(L), ASSET, offer, choice, 1_000)
  assert.deepEqual(lenderPolicyProblems(policy), [])
  const terms = offerTerms(policy, params, offer.min, 0)
  assert.equal(terms.min_principal, 10 * U)
  const relay = new MemoryRelay()
  const results: NegotiationResult[] = []
  const signer = lenderSigner(partyKey(L))
  const server = serveNegotiations({ transport: relay, policy, params, signer: () => signer, min_principal: offer.min, timeoutMs: 2_000, onResult: (r) => results.push(r) })
  try {
    const b = await negotiateAsBorrower({ transport: relay, signer: keyPairSigner(B), policy: await borrowerPolicy({ principal: { min: 10 * U, max: 10 * U } }), terms, params, timeoutMs: 2_000 })
    assert.ok('agreed' in b.outcome, JSON.stringify(b.outcome))
    assert.equal(b.outcome.agreed.principal, 10 * U)
    assert.deepEqual(outsidePolicy(policy, b.outcome.agreed), [])
    // under the minimum: the borrower's own structure step refuses before any ASK
    const small = await negotiateAsBorrower({ transport: relay, signer: keyPairSigner(B), policy: await borrowerPolicy({ principal: { min: 9 * U, max: 9 * U } }), terms, params, timeoutMs: 2_000 })
    assert.ok('no_deal' in small.outcome && small.outcome.no_deal === 'PRINCIPAL', JSON.stringify(small.outcome))
  } finally { server.close() }
})
