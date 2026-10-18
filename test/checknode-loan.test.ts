// The loan demo's --check-market path at the lender (docs/CHECK-MARKET.md): a
// negotiated application that names a forwarded check. LenderAgent takes the
// check only from the KEY message, through verifyForwardedCheck, binds it to the
// loan it agreed, and names the receipt in the term sheet next to the evidence
// digest. Memory relay and in-memory HODL Lightning for the paid check; fake
// platform, relay and chain for the agent. No service, chain or wallet runs.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { L2_POLICY, LenderAgent, type LenderCheckMarket } from '../src/agents/lender.js'
import type { Relay } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { FakeChain } from '../src/chain/fake.js'
import { MemoryBus, MemoryHub } from '../src/checknode/bus.js'
import { forwardKey, listOffers, runPaidCheck, verifyForwardedCheck, type PaidCheckResult } from '../src/checknode/client.js'
import { checkMessageHash, type CheckMessage } from '../src/checknode/messages.js'
import { CheckNode } from '../src/checknode/node.js'
import { receiptDetailsLine, receiptEvidenceDigest, receiptProblemsFor, type CheckReceiptData } from '../src/checknode/receipt.js'
import { channelsToClose, type RlnChannel } from '../src/checknode/regtest-ln.js'
import { releaseHash } from '../src/checknode/offer.js'
import { freshKey } from '../src/checknode/seal.js'
import { noTeeVerifier } from '../src/checknode/tee.js'
import { hashObject, keyPairFromLabel, randomHex, signHash, signObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { termInterest } from '../src/core/economics.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { KIND } from '../src/market/kinds.js'
import type { ApplicationPayload } from '../src/market/messages.js'
import { runNegotiation, verifyTranscript, type NegotiationMessage } from '../src/market/negotiate.js'
import { signBorrowerPolicy, signLenderPolicy, type LenderPolicy } from '../src/market/policy.js'
import { Oracle } from '../src/oracle/oracle.js'
import { signPassbook } from '../src/registry/passbook-doc.js'
import { bundleLoan } from '../src/scorer/bundle-terms.js'
import { bundleCategories, signConsent } from '../src/scorer/consent.js'
import { evidenceDigest } from '../src/scorer/evidence-digest.js'
import type { Party } from '../src/wallet/party.js'
import { LocalKeySigner } from '../src/wallet/signer.js'
import { MemoryLightning, NOW, sandboxEngine, trustPolicy, USDT } from './checknode-helpers.js'

const U = MICRO_PER_USDT
const borrower = keyPairFromLabel('fatima')
const lenderKey = keyPairFromLabel('check-loan-lender')
const opA = keyPairFromLabel('check-operator-A')
const opB = keyPairFromLabel('check-operator-B')
const oracle = new Oracle(keyPairFromLabel('check-loan-oracle'), 10_000_000)
const PARAMS = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb' as const] }
const failed = (e: unknown) => [...(e as Error).message.matchAll(/(?:declined: |; )([a-z:-]+) \(/g)].map((m) => m[1])
const market: LenderCheckMarket = { trust: trustPolicy(), tee: noTeeVerifier }

function node(hub: MemoryHub, ln: MemoryLightning, operator: KeyPair, price: number): CheckNode {
  const { engine } = sandboxEngine(undefined, keyPairFromLabel(`enclave-${operator.pubkey.slice(0, 8)}`))
  return new CheckNode({ operator, engine, bus: new MemoryBus(hub, operator), rails: { 'rgb-ln-hodl': ln.operatorRail('rgb-ln-hodl', operator.pubkey) }, assets: [{ asset_id: USDT, ticker: 'USDT', amount: price, kind: 'payment' }], now: () => NOW, paymentTimeoutMs: 2000 })
}

async function policies(rules: LenderPolicy['check_nodes'] = { accepted_check_operators: [opA.pubkey, opB.pubkey], min_execution: 'software', max_price: { asset_id: USDT, amount: U } }) {
  const bp = await signBorrowerPolicy(new LocalKeySigner(borrower), { asset_id: USDT, principal: { min: 600 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], max_check_price: { asset_id: USDT, amount: 600_000 }, issued_at: NOW })
  const lp = await signLenderPolicy(new LocalKeySigner(lenderKey), { asset_id: USDT, max_per_loan: 5_000 * U, max_outstanding: 50_000 * U, min_apr_bps: 1000, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, required_checks: ['injection'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [], maker_checker_above: 5_000 * U }, check_nodes: rules, issued_at: NOW })
  return { bp, lp }
}

/** A negotiated loan and its check bought from node B (0.50, under the borrower's 0.60 cap), forwarded to the lender. */
async function boughtCheck() {
  const { bp, lp } = await policies()
  const n = await runNegotiation(bp, lp, PARAMS, { borrower: new LocalKeySigner(borrower), lender: new LocalKeySigner(lenderKey), nonce: randomHex() })
  const v = verifyTranscript(n.messages, { borrower_pk: borrower.pubkey, lender_pk: lenderKey.pubkey, max_rounds: 3 })
  assert.ok(v.agreed, v.problems.join('; '))
  const neg = n.messages[0].negotiation_id
  const hub = new MemoryHub()
  const ln = new MemoryLightning()
  const nodeB = node(hub, ln, opB, 500_000)
  await node(hub, ln, opA, 800_000).publishOffer()
  await nodeB.publishOffer()
  // The bundle asks for exactly the agreed loan under this lender's offer requirements.
  const { f } = sandboxEngine()
  const bundle = { ...f.bundle, asset_id: USDT, lender_requirements: L2_POLICY.requirements, loan_request: { principal: 600 * U, fee: termInterest({ principal: 600 * U, apr_bps: v.agreed.apr_bps, term_blocks: 30 }), term_blocks: 30, grace_blocks: 5 } }
  const borrowerBus = new MemoryBus(hub, borrower)
  const offerB = (await listOffers(borrowerBus, NOW)).valid.find((o) => o.operator_pk === opB.pubkey)!
  const served = (async () => { const { payload, event } = await new MemoryBus(hub, opB).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 }); return nodeB.handle(payload, event.pubkey) })()
  const paid = await runPaidCheck({ bus: borrowerBus, payer: borrower, borrower, lenderPk: lenderKey.pubkey, negotiationId: neg, bundle, offer: offerB, rail: 'rgb-ln-hodl', payWith: USDT, payerRail: ln.payerRail(), dataCategories: bundleCategories(bundle), now: NOW, timeoutMs: 5000 })
  assert.equal((await served).status, 'paid')
  const key = await forwardKey(borrowerBus, borrower, lenderKey.pubkey, paid)
  return { messages: n.messages as NegotiationMessage[], lp, paid, key, bundle, neg }
}

function application(b: { messages: NegotiationMessage[]; paid: PaidCheckResult; key: CheckMessage }, over: Partial<ApplicationPayload> = {}): ApplicationPayload {
  return {
    offer_id: `${lenderKey.pubkey}:${L2_POLICY.d}`, principal: 600 * U, term_blocks: 30, sandbox_result: null, attestation: null,
    check_key: checkMessageHash(b.key), check_receipt: { contract_id: 'rgb:check-receipt-unit-test-0001' },
    disclosed_inflows: [], passbook: signPassbook(borrower, []), outstanding_statement: { outstanding_micro: 0, sig: signHash(hashObject({ outstanding_micro: 0 }), borrower.secretKey) },
    negotiation: b.messages, consent: b.paid.consent, ...over,
  }
}

async function propose(app: ApplicationPayload, key: CheckMessage | null, opts: { policy: LenderPolicy; checkMarket?: LenderCheckMarket }) {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-check-loan-'))
  const platform = { state: async () => ({ platform_pk: keyPairFromLabel('check-loan-platform').pubkey, oracle_pk: oracle.key.pubkey, height: 300 }), quote: async () => oracle.quote(300), note: async () => {}, sandboxPubkey: async () => { throw new Error('the sandbox must not be asked') } }
  // The application, then the KEY message the borrower forwarded: the lender reads the check only from there.
  const relay = {
    receive: async (kind: number, _from: Hex | null, o: { match?: (p: unknown) => boolean } = {}) => {
      if (kind === KIND.APPLICATION) return { payload: app, event: { pubkey: borrower.pubkey } }
      if (kind === KIND.CHECK_KEY && key && (!o.match || o.match(key))) return { payload: key, event: { pubkey: borrower.pubkey } }
      throw new Error(`timed out waiting for kind ${kind}`)
    },
    send: async () => { throw new Error('nothing is sent before approval') }, close() {},
  } as unknown as Relay
  const agent = new LenderAgent({ party: { role: 'lender2', key: lenderKey, rgb: { dataDir: join(dir, 'rgb') } } as unknown as Party, platform: platform as never, relay, chain: new FakeChain(300) as never, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: USDT, lightning: null, mine: async () => { throw new Error('unit must never mine') } })
  try { return await agent.proposeTermSheet({ negotiation: { policy: opts.policy, maxRounds: 3, makerCheckerAboveMicro: 5_000 * U }, ...(opts.checkMarket ? { checkMarket: opts.checkMarket } : {}) }) } finally { agent.close(); rmSync(dir, { recursive: true, force: true }) }
}

describe('lender: a negotiated application whose check was bought on the check market', () => {
  it('verifies the forwarded check itself, binds it to the agreed loan and names the receipt next to the evidence digest', async () => {
    const b = await boughtCheck()
    const proposal = await propose(application(b), b.key, { policy: b.lp, checkMarket: market })
    assert.ok(proposal.check?.ok)
    assert.ok(proposal.checks.some((c) => c.id === 'check:key-binding' && c.ok && /preimage of the paid HODL invoice/.test(c.detail)))
    assert.ok(proposal.checks.some((c) => c.id === 'check:scorer:scored-loan' && c.ok), 'the released outputs name exactly the agreed loan')
    assert.ok(proposal.checks.some((c) => c.id === 'check-verified' && c.ok && /\(FALLBACK\) evidence from check node/.test(c.detail)))
    const s = proposal.sheet.scorer
    assert.deepEqual(s.evidence, evidenceDigest(b.paid.outcome))
    assert.deepEqual(s.check_receipt, { contract_id: 'rgb:check-receipt-unit-test-0001', commitment: b.paid.commitment.commitment, operator_pk: opB.pubkey })
    assert.equal(s.provider, 'container')
    assert.equal(s.fallback, true)
    assert.deepEqual(proposal.scored, b.paid.outcome, 'the approval can refuse a sheet that names other evidence')
    // Without a receipt the sheet names none; the rest stands.
    const bare = await propose(application(b, { check_receipt: undefined }), b.key, { policy: b.lp, checkMarket: market })
    assert.equal(bare.sheet.scorer.check_receipt, undefined)
  })

  it('declines without its own verifier, without the KEY message, or with a forged K', async () => {
    const b = await boughtCheck()
    await assert.rejects(propose(application(b), b.key, { policy: b.lp }), (e) => failed(e).includes('check-verifier'))
    await assert.rejects(propose(application(b), null, { policy: b.lp, checkMarket: market }), (e) => failed(e).includes('check-key'))
    const forged = signObject({ ...b.key, body: { ...b.key.body, key: freshKey() } }, borrower.secretKey) as CheckMessage
    await assert.rejects(propose(application(b, { check_key: checkMessageHash(forged) }), forged, { policy: b.lp, checkMarket: market }), (e) => failed(e).includes('check:commitment'))
  })

  it('declines a node outside its own check-node rules, a consent other than the operator signed, and a check scored for another loan', async () => {
    const b = await boughtCheck()
    const { lp: onlyA } = await policies({ accepted_check_operators: [opA.pubkey], min_execution: 'software' })
    await assert.rejects(propose(application(b), b.key, { policy: onlyA, checkMarket: market }), (e) => failed(e).includes('check:lender-rules'))
    const { v: _v, domain: _d, borrower_pk: _b, retention: _r, sig: _s, ...rest } = b.paid.consent
    const other = signConsent(borrower, { ...rest, issued_at: rest.issued_at + 1 })
    await assert.rejects(propose(application(b, { consent: other }), b.key, { policy: b.lp, checkMarket: market }), (e) => failed(e).includes('consent-bound'))
    // The same KEY, verified for a 100 USDT loan: the outputs name the 600 USDT one.
    const v = await verifyForwardedCheck(b.key, { negotiation_id: b.neg, borrower_pk: borrower.pubkey, lender_pk: lenderKey.pubkey, payer_pk: borrower.pubkey, rules: {}, trust: trustPolicy(), tee: noTeeVerifier(NOW), requiredChecks: [], now: NOW, loan: { ...bundleLoan(b.bundle), loan_request: { ...bundleLoan(b.bundle).loan_request, principal: 100 * U } } })
    assert.equal(v.ok, false)
    assert.ok(v.ticks.some((t) => t.id === 'scorer:scored-loan' && !t.ok))
  })
})

describe('the borrower before and after paying a check node', () => {
  it('keeps one RGB channel per check node: closes another asset, an unusable channel and one with less than the price', () => {
    const ch = (id: string, over: Partial<RlnChannel>): RlnChannel => ({ channel_id: id, peer_pubkey: 'B', asset_id: USDT, is_usable: true, asset_local_amount: 2_000_000, ...over })
    const channels = [ch('keep', {}), ch('voucher', { asset_id: 'rgb:pbchk' }), ch('down', { is_usable: false }), ch('empty', { asset_local_amount: 100_000 }), ch('other-node', { peer_pubkey: 'A', asset_id: 'rgb:pbchk' })]
    assert.deepEqual(channelsToClose(channels, 'B', USDT, 500_000).map((c) => c.channel_id), ['voucher', 'down', 'empty'])
  })

  it('accepts a receipt only when it names the commitment, operator, release and evidence digest of the check it paid for', async () => {
    const b = await boughtCheck()
    const expect = { commitment: b.paid.commitment.commitment, operator_pk: opB.pubkey, release_hash: releaseHash(b.paid.offer.release), evidence_digest: receiptEvidenceDigest(b.paid.outcome) }
    // The receipt's digest is the one the term sheet binds for a sandbox run record.
    assert.equal(expect.evidence_digest, (evidenceDigest(b.paid.outcome) as { run_record_sha256: Hex }).run_record_sha256)
    const good: CheckReceiptData = { v: 1, kind: 'passbook-check-receipt', ...expect, tier: 'software-evidence', date: '2026-10-18' }
    assert.deepEqual(receiptProblemsFor(good, receiptDetailsLine(good), expect), [])
    const otherEvidence = { ...good, evidence_digest: 'ab'.repeat(32) }
    assert.deepEqual(receiptProblemsFor(otherEvidence, receiptDetailsLine(otherEvidence), expect), ['RECEIPT_OTHER_EVIDENCE'], 'a well-formed receipt for other evidence is refused')
    assert.deepEqual(receiptProblemsFor({ ...good, commitment: 'cd'.repeat(32) }, receiptDetailsLine({ ...good, commitment: 'cd'.repeat(32) }), expect), ['RECEIPT_OTHER_COMMITMENT'])
    assert.deepEqual(receiptProblemsFor(good, receiptDetailsLine(otherEvidence), expect), ['RECEIPT_DETAILS_NOT_ITS_HASH'], 'the token details must be this JSON\'s hash')
    assert.ok(receiptProblemsFor({ ...good, outputs: 'QUALIFY' } as unknown as CheckReceiptData, null, expect).length, 'a receipt carrying anything else is malformed')
  })
})
