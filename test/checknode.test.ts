import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashObject, keyPairFromLabel, randomHex, signHash, signObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { KIND } from '../src/market/kinds.js'
import { signConsent } from '../src/scorer/consent.js'
import { MemoryBus, MemoryHub } from '../src/checknode/bus.js'
import { CheckRefused, forwardKey, listOffers, pickAndRun, runPaidCheck, verifyForwardedCheck } from '../src/checknode/client.js'
import { appendCheckMessage, checkChainProblems, type CheckMessage } from '../src/checknode/messages.js'
import { CheckNode } from '../src/checknode/node.js'
import { CHECK_OFFER_SCHEMA, offerProblems, releaseHash, type CheckOffer } from '../src/checknode/offer.js'
import { isInboundPayment, isOutboundPayment, RAIL_LABEL } from '../src/checknode/rail.js'
import { freshKey, keyHash, openResult, plaintextCommitment, reportData, seal, sealedHash, signCommitment, type CheckPlaintext } from '../src/checknode/seal.js'
import { agreementProblems, checkNodeRulesProblems, pickCheckNode, type PayerConstraints } from '../src/checknode/select.js'
import { deriveExecution, noTeeVerifier, testVendorDocumentHash, testVendorVerifier, type TeeVerifierConfig } from '../src/checknode/tee.js'
import { schemaErrors, type JsonSchema } from '../src/core/schema.js'
import { TERMSHEET_SCHEMA } from '../src/market/termsheet.js'
import { receiptDataProblems, receiptDetails, type CheckReceiptData } from '../src/checknode/receipt.js'
import { runNegotiation, structure, type CheckMarketInput, type EngineParams } from '../src/market/negotiate.js'
import { signBorrowerPolicy, signLenderPolicy, type BorrowerPolicy, type LenderPolicy } from '../src/market/policy.js'
import { LocalKeySigner } from '../src/wallet/signer.js'
import { contract, MemoryLightning, NOW, sandboxEngine, SOURCE, trustPolicy, USDT, CONTRACT } from './checknode-helpers.js'

const borrower = keyPairFromLabel('fatima')
const lender = keyPairFromLabel('check-test-lender')
const opA = keyPairFromLabel('check-operator-A')
const opB = keyPairFromLabel('check-operator-B')
const NEG = 'ee'.repeat(32)
const payerOf = (over: Partial<PayerConstraints> = {}): PayerConstraints => ({ payer: 'borrower', payment_asset_id: USDT, rails: ['rgb-ln-hodl', 'rgb-ln-pay-then-deliver'], ...over })

function makeNode(hub: MemoryHub, ln: MemoryLightning, operator: KeyPair, price: number, opts: { p50?: number; rails?: ('rgb-ln-hodl' | 'rgb-ln-pay-then-deliver')[]; voucher?: string; execution?: CheckOffer['execution'] } = {}) {
  const { engine } = sandboxEngine(undefined, keyPairFromLabel(`enclave-${operator.pubkey.slice(0, 8)}`))
  const rails = Object.fromEntries((opts.rails ?? ['rgb-ln-hodl']).map((r) => [r, ln.operatorRail(r, operator.pubkey)]))
  return new CheckNode({
    operator, engine, bus: new MemoryBus(hub, operator), rails,
    assets: [{ asset_id: USDT, ticker: 'USDT', amount: price, kind: 'payment' }, ...(opts.voucher ? [{ asset_id: opts.voucher, ticker: 'PBCHK', amount: 1, kind: 'voucher' as const }] : [])],
    p50Seconds: opts.p50 ?? 30, execution: opts.execution, now: () => NOW, paymentTimeoutMs: 2000,
  })
}

const ctx = (tee: TeeVerifierConfig = noTeeVerifier(NOW)) => ({ trust: trustPolicy(), tee })

describe('check offer (passbook-check/v1)', () => {
  it('is signed by its operator, carries the release and has no trust field', () => {
    const node = makeNode(new MemoryHub(), new MemoryLightning(), opA, 800_000)
    const offer = node.currentOffer()
    assert.deepEqual(offerProblems(offer, NOW), [])
    assert.equal(offer.retention, 0)
    assert.deepEqual(offer.bond, { status: 'designed-not-live' })
    assert.deepEqual(offer.execution, { tee: 'none' })
    assert.equal(offer.release.image_digest, SOURCE)
    assert.equal(offer.release.scoring_contract_hash, CONTRACT)
    assert.ok(!('trust' in offer))
    // A trust claim is not part of the protocol: the closed schema refuses it.
    const withTrust = signObject({ ...offer, trust: 'hardware-attested' }, opA.secretKey)
    assert.ok(schemaErrors(withTrust, CHECK_OFFER_SCHEMA).some((e) => e.includes('trust')))
    assert.ok(offerProblems(withTrust, NOW).length > 0)
  })

  it('is refused when expired, re-signed by someone else or priced off its first payment asset', () => {
    const offer = makeNode(new MemoryHub(), new MemoryLightning(), opA, 800_000).currentOffer()
    assert.ok(offerProblems(offer, offer.expires).includes('OFFER_EXPIRED'))
    assert.ok(offerProblems({ ...offer, price: { asset_id: USDT, amount: 1 } }, NOW).includes('OFFER_SIGNATURE'))
    const { sig: _sig, ...unsigned } = offer
    assert.ok(offerProblems(signObject({ ...unsigned, price: { asset_id: USDT, amount: 1 } }, opA.secretKey), NOW).includes('OFFER_PRICE_NOT_FIRST_PAYMENT_ASSET'))
    assert.ok(offerProblems({ ...offer, operator_pk: opB.pubkey }, NOW).includes('OFFER_SIGNATURE'))
  })

  it('is published on an addressable kind outside Passbook\'s and the DVM ranges', async () => {
    assert.equal(KIND.CHECK_OFFER, 38401)
    const passbook = new Set<number>(Object.entries(KIND).filter(([name]) => !name.startsWith('CHECK_')).map(([, k]) => k))
    for (const k of [KIND.CHECK_OFFER, KIND.CHECK_REQUEST, KIND.CHECK_FEEDBACK, KIND.CHECK_RESULT, KIND.CHECK_KEY] as number[]) {
      assert.ok(!(k >= 5000 && k <= 7000) && !(k >= 7470 && k <= 7496) && !passbook.has(k), `kind ${k}`)
    }
    const hub = new MemoryHub()
    const node = makeNode(hub, new MemoryLightning(), opA, 800_000)
    await node.publishOffer()
    await node.publishOffer()
    const { valid } = await listOffers(new MemoryBus(hub, borrower), NOW)
    assert.equal(valid.length, 1, 'a replaceable offer: one per operator')
  })
})

describe('sealed result', () => {
  const plaintext: CheckPlaintext = { v: 1, kind: 'passbook-check-plaintext', negotiation_id: NEG, request_nonce: 'ab'.repeat(32), consent_hash: '00'.repeat(32), outcome: { kind: 'passbook-signed' } as never }
  function committed(over: { operator?: KeyPair; key?: Hex } = {}) {
    const operator = over.operator ?? opA
    const consent = signConsent(borrower, { purpose: 'test', purpose_id: NEG, scorer_id: 's', contract_hash: CONTRACT, operator_pk: opA.pubkey, lender_pk: lender.pubkey, data_categories: ['transaction_history'], issued_at: NOW, expires_at: NOW + 60 })
    const p = { ...plaintext, consent_hash: hashObject(consent) }
    const k = over.key ?? freshKey()
    const s = seal(p, k)
    const c = signCommitment(operator, { negotiation_id: NEG, request_nonce: p.request_nonce, request_hash: '11'.repeat(32), offer_hash: '22'.repeat(32), release_hash: '33'.repeat(32), consent, commitment: plaintextCommitment(p), ciphertext_hash: sealedHash(s), key_hash: keyHash(k), payment: { rail: 'rgb-ln-hodl', asset_id: USDT, amount: 500_000, invoice: 'lnbcrt-x', payment_hash: keyHash(k) }, issued_at: NOW })
    return { c, s, k, p }
  }
  const expect = { operator_pk: opA.pubkey, negotiation_id: NEG, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey }

  it('opens with K and the plaintext hash equals the operator-signed commitment', () => {
    const { c, s, k, p } = committed()
    const opened = openResult(c, s, k, expect)
    assert.deepEqual(opened.problems, [])
    assert.deepEqual(opened.plaintext, p)
    assert.equal(c.report_data, reportData(c.commitment, c.request_nonce))
  })

  it('refuses a wrong K, a swapped blob, another negotiation and a consent for another operator', () => {
    const { c, s } = committed()
    assert.ok(openResult(c, s, freshKey(), expect).problems.includes('KEY_DOES_NOT_MATCH_COMMITMENT'))
    const other = committed()
    assert.ok(openResult(c, other.s, other.k, expect).problems.includes('SEALED_NOT_COMMITTED'))
    assert.ok(openResult(c, s, committed().k, { ...expect, negotiation_id: 'ff'.repeat(32) }).problems.includes('COMMITMENT_OTHER_NEGOTIATION'))
    const forged = committed({ operator: opB })
    assert.ok(openResult(forged.c, forged.s, forged.k, { ...expect, operator_pk: opB.pubkey }).problems.includes('CONSENT_NAMES_ANOTHER_OPERATOR'))
  })

  it('refuses a K that decrypts a blob whose plaintext was never committed', () => {
    const { c, k, p } = committed()
    const s2 = seal({ ...p, request_nonce: 'cd'.repeat(32) }, k)
    const c2 = signCommitment(opA, { ...c, ciphertext_hash: sealedHash(s2) })
    assert.ok(openResult(c2, s2, k, expect).problems.includes('PLAINTEXT_NOT_COMMITTED'))
  })
})

describe('message chain', () => {
  it('carries the negotiation id, sequence and previous hash; a reordered or re-signed chain fails', () => {
    const chain: CheckMessage[] = []
    appendCheckMessage(chain, borrower, opA.pubkey, 'REQUEST', { x: 1 }, NEG)
    appendCheckMessage(chain, opA, borrower.pubkey, 'FEEDBACK', { status: 'error', reason: 'X' })
    const expect = { negotiation_id: NEG, payer_pk: borrower.pubkey, operator_pk: opA.pubkey }
    assert.deepEqual(checkChainProblems(chain, expect), [])
    assert.ok(checkChainProblems([chain[1], chain[0]], expect).length > 0)
    assert.ok(checkChainProblems([chain[0], { ...chain[1], body: { status: 'error', reason: 'Y' } }], expect).some((p) => p.includes('bad signature')))
    assert.ok(checkChainProblems(chain, { ...expect, negotiation_id: 'ff'.repeat(32) }).some((p) => p.includes('wrong negotiation id')))
  })
})

describe('picking a check node', () => {
  const hub = new MemoryHub()
  const ln = new MemoryLightning()
  const a = makeNode(hub, ln, opA, 800_000, { p50: 20 }).currentOffer()
  const b = makeNode(hub, ln, opB, 500_000, { p50: 40 }).currentOffer()

  it('is deterministic: the lender\'s rules first, then cheapest, then fastest', () => {
    const pick = pickCheckNode([a, b], {}, payerOf(), ctx())
    assert.equal(pick.picked?.operator_pk, opB.pubkey, '0.50 test USDT beats 0.80')
    assert.equal(pick.picked?.rail, 'rgb-ln-hodl')
    assert.deepEqual(pickCheckNode([b, a], {}, payerOf(), ctx()).ranked.map((c) => c.operator_pk), pick.ranked.map((c) => c.operator_pk), 'order of offers does not matter')
    const samePrice = makeNode(hub, ln, opA, 500_000, { p50: 20 }).currentOffer()
    assert.equal(pickCheckNode([samePrice, b], {}, payerOf(), ctx()).picked?.operator_pk, opA.pubkey, 'same price: faster wins')
    assert.ok(pick.why.some((w) => w.includes('Cheapest')))
  })

  it('honours accepted_check_operators, accepted_releases, min_trust and max_price', () => {
    assert.equal(pickCheckNode([a, b], { accepted_check_operators: [opA.pubkey] }, payerOf(), ctx()).picked?.operator_pk, opA.pubkey)
    assert.equal(pickCheckNode([a, b], { accepted_releases: ['00'.repeat(32)] }, payerOf(), ctx()).picked, null)
    assert.equal(pickCheckNode([a, b], { accepted_releases: [releaseHash(b.release)] }, payerOf(), ctx()).picked?.operator_pk, opB.pubkey)
    const strict = pickCheckNode([a, b], { min_trust: 'software-evidence' }, payerOf(), ctx())
    assert.equal(strict.picked, null, 'the sandbox release is granted dev-inprocess, whatever is claimed')
    assert.ok(strict.rejected.every((c) => c.problems.some((p) => p.startsWith('TRUST_BELOW_MIN'))))
    assert.equal(pickCheckNode([a, b], { max_price: { asset_id: USDT, amount: 400_000 } }, payerOf(), ctx()).picked, null)
    assert.equal(pickCheckNode([a, b], {}, payerOf({ max_price: { asset_id: USDT, amount: 600_000 } }), ctx()).picked?.operator_pk, opB.pubkey)
  })

  it('min_execution tee refuses software nodes and unattested TEE claims', () => {
    const claimed = makeNode(hub, ln, opA, 100_000, { execution: { tee: 'aws-nitro', attestation: 'bm90LWFuLWF0dGVzdGF0aW9u', result_key: 'aa'.repeat(32) } }).currentOffer()
    const pick = pickCheckNode([claimed, b], { min_execution: 'tee' }, payerOf(), ctx())
    assert.equal(pick.picked, null)
    assert.ok(pick.rejected.every((c) => c.problems.some((p) => p.startsWith('EXECUTION_BELOW_MIN'))))
    // Without min_execution the Nitro claim is just software evidence, and it is cheapest.
    const open = pickCheckNode([claimed, b], {}, payerOf(), ctx())
    assert.equal(open.picked?.operator_pk, opA.pubkey)
    assert.equal(open.picked?.execution.tier, 'software-evidence')
  })

  it('treats a held voucher of that operator as prepaid', () => {
    const v = 'rgb:pbchk-B'
    const withVoucher = makeNode(hub, ln, opB, 900_000, { voucher: v }).currentOffer()
    const pick = pickCheckNode([a, withVoucher], {}, payerOf({ vouchers_held: [v] }), ctx())
    assert.equal(pick.picked?.operator_pk, opB.pubkey)
    assert.equal(pick.picked?.pay_with?.kind, 'voucher')
    assert.equal(pickCheckNode([a, withVoucher], {}, payerOf({ vouchers_held: ['rgb:pbchk-other'] }), ctx()).picked?.operator_pk, opA.pubkey, 'another operator\'s voucher is no use here')
  })

  it('validates the lender\'s check-node rules', () => {
    assert.deepEqual(checkNodeRulesProblems({ accepted_check_operators: [opA.pubkey], min_execution: 'tee', max_price: { asset_id: USDT, amount: 1 }, agreement: { required: 2 } }), [])
    assert.ok(checkNodeRulesProblems({ agreement: { required: 3 } } as never).length > 0)
    assert.ok(checkNodeRulesProblems({ min_execution: 'enclave' } as never).length > 0)
  })

  it('2-of-N agreement picks two different operators, or none when only one is eligible', () => {
    const pick = pickCheckNode([a, b], { agreement: { required: 2 } }, payerOf(), ctx())
    assert.equal(pick.picked?.operator_pk, opB.pubkey)
    assert.equal(pick.second?.operator_pk, opA.pubkey)
    const lonely = pickCheckNode([a, b], { agreement: { required: 2 }, accepted_check_operators: [opB.pubkey] }, payerOf(), ctx())
    assert.equal(lonely.picked, null)
    assert.ok(lonely.why[0].includes('2-of-N'))
    assert.equal(pickCheckNode([a, b], {}, payerOf(), ctx()).second, null, 'one check by default')
  })
})

describe('TEE verifier: the five checks', () => {
  const root = keyPairFromLabel('test-vendor-root')
  const leaf = keyPairFromLabel('test-vendor-leaf')
  const resultKey = keyPairFromLabel('enclave-result-key')
  const releaseObj = { provider: 'container' as const, image_digest: SOURCE, scoring_contract_hash: CONTRACT, model_hash: null }
  const MEASUREMENT = 'pcr0:' + '77'.repeat(48)
  const commitmentHash = '12'.repeat(32)
  const nonce = '34'.repeat(32)
  function doc(over: { measurement?: string; public_key?: Hex; report_data?: Hex; timestamp?: number; root?: KeyPair } = {}) {
    const unsigned = { vendor: 'test-vendor' as const, measurement: over.measurement ?? MEASUREMENT, public_key: over.public_key ?? resultKey.pubkey, report_data: over.report_data ?? reportData(commitmentHash, nonce), timestamp: over.timestamp ?? NOW, leaf_pk: leaf.pubkey, leaf_sig: signHash(hashObject({ domain: 'passbook-test-vendor-leaf-v1', leaf_pk: leaf.pubkey }), (over.root ?? root).secretKey) }
    return Buffer.from(JSON.stringify({ ...unsigned, sig: signHash(testVendorDocumentHash(unsigned), leaf.secretKey) })).toString('base64')
  }
  const cfg: TeeVerifierConfig = { vendors: { 'test-vendor': testVendorVerifier(root.pubkey) }, measurementFor: () => MEASUREMENT, maxAgeSeconds: 600, now: NOW }
  const execution = { tee: 'test-vendor' as const, attestation: doc(), result_key: resultKey.pubkey }
  const result = (attestation: string, key: KeyPair = resultKey) => ({ attestation, result_sig: signHash(commitmentHash, key.secretKey), commitment_hash: commitmentHash, report_data: reportData(commitmentHash, nonce) })
  const failedIds = (d: { ticks: { id: string; ok: boolean }[] }) => d.ticks.filter((t) => !t.ok).map((t) => t.id)

  it('grants tee-attested only when all five pass for a pinned vendor', () => {
    const d = deriveExecution(execution, releaseObj, cfg, result(doc()))
    assert.equal(d.tier, 'tee-attested', JSON.stringify(d.ticks))
    assert.deepEqual(d.ticks.map((t) => t.id), ['enclave-key', 'vendor-chain', 'measurement', 'fresh-report', 'result-signature'])
  })

  it('refusal fixtures: no attestation, wrong measurement, stale nonce, key mismatch', () => {
    assert.equal(deriveExecution({ tee: 'none' }, releaseObj, cfg).tier, 'software-evidence')
    const nitro = deriveExecution({ tee: 'aws-nitro', attestation: 'eA==', result_key: resultKey.pubkey }, releaseObj, cfg, result(doc()))
    assert.equal(nitro.tier, 'software-evidence', 'a claim without a verifiable attestation is software evidence')
    assert.match(nitro.ticks[0].detail, /not built yet/)
    const wrongMeasurement = deriveExecution(execution, releaseObj, cfg, result(doc({ measurement: 'pcr0:' + '00'.repeat(48) })))
    assert.equal(wrongMeasurement.tier, 'software-evidence')
    assert.deepEqual(failedIds(wrongMeasurement), ['measurement'])
    const stale = deriveExecution(execution, releaseObj, cfg, result(doc({ report_data: reportData(commitmentHash, '99'.repeat(32)) })))
    assert.deepEqual(failedIds(stale), ['fresh-report'])
    const old = deriveExecution(execution, releaseObj, cfg, result(doc({ timestamp: NOW - 3600 })))
    assert.deepEqual(failedIds(old), ['fresh-report'])
    const otherKey = keyPairFromLabel('not-the-enclave')
    const keyMismatch = deriveExecution(execution, releaseObj, cfg, result(doc({ public_key: otherKey.pubkey })))
    assert.deepEqual(failedIds(keyMismatch), ['enclave-key'])
    const signedByOther = deriveExecution(execution, releaseObj, cfg, result(doc(), otherKey))
    assert.deepEqual(failedIds(signedByOther), ['result-signature'])
    const wrongRoot = deriveExecution(execution, releaseObj, cfg, result(doc({ root: keyPairFromLabel('other-root') })))
    assert.deepEqual(failedIds(wrongRoot), ['vendor-chain'])
    assert.equal(deriveExecution(execution, releaseObj, noTeeVerifier(NOW), result(doc())).tier, 'software-evidence', 'no pinned root: no TEE tier')
  })
})

describe('a paid check end to end (memory relay, in-memory HODL Lightning)', () => {
  async function market(opts: { railsB?: ('rgb-ln-hodl' | 'rgb-ln-pay-then-deliver')[] } = {}) {
    const hub = new MemoryHub()
    const ln = new MemoryLightning()
    const nodeA = makeNode(hub, ln, opA, 800_000, { p50: 20 })
    const nodeB = makeNode(hub, ln, opB, 500_000, { p50: 40, rails: opts.railsB })
    await nodeA.publishOffer()
    await nodeB.publishOffer()
    const { f } = sandboxEngine()
    return { hub, ln, nodeA, nodeB, bundle: f.bundle, borrowerBus: new MemoryBus(hub, borrower), lenderBus: new MemoryBus(hub, lender) }
  }
  const serveOnce = async (node: CheckNode, hub: MemoryHub, op: KeyPair) => {
    const { payload, event } = await new MemoryBus(hub, op).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 })
    return node.handle(payload, event.pubkey)
  }
  const lenderExpect = { negotiation_id: NEG, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, payer_pk: borrower.pubkey, rules: {}, trust: trustPolicy(), tee: noTeeVerifier(NOW), requiredChecks: ['injection'], now: NOW }

  it('the borrower picks the cheaper node, pays, learns K from the preimage; the lender verifies without trusting the borrower', async () => {
    const m = await market()
    const served = serveOnce(m.nodeB, m.hub, opB)
    const paid = await pickAndRun({ bus: m.borrowerBus, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: NEG, bundle: m.bundle, payerRail: m.ln.payerRail(), dataCategories: [...contract.inputs.data_categories], rules: {}, constraints: payerOf(), trust: trustPolicy(), tee: noTeeVerifier(NOW), now: NOW, timeoutMs: 5000 })
    const entry = await served
    assert.equal(entry.status, 'paid')
    assert.equal(paid.offer.operator_pk, opB.pubkey)
    assert.equal(paid.key_source, 'lightning-preimage')
    assert.equal(paid.commitment.payment.payment_hash, keyHash(paid.key), 'the invoice is locked to sha256(K)')
    assert.equal(paid.commitment.consent.operator_pk, opB.pubkey, 'the consent names the operator')
    assert.equal(paid.outcome.kind, 'passbook-signed')
    assert.ok(!JSON.stringify(m.nodeB.status()).includes(m.bundle.history[0].txid), 'the node keeps no bundle data')
    // NIP-44 carries at most 64 KiB; the sealed result is gzipped before encryption.
    assert.ok(JSON.stringify(paid.chain[1]).length < 60_000, `feedback is ${JSON.stringify(paid.chain[1]).length} bytes`)

    const keyMsg = await forwardKey(m.borrowerBus, borrower, lender.pubkey, paid)
    const received = await m.lenderBus.receive<CheckMessage>(KIND.CHECK_KEY, borrower.pubkey, { timeoutMs: 2000 })
    assert.equal(received.payload.sig, keyMsg.sig)
    const v = await verifyForwardedCheck(received.payload, lenderExpect)
    assert.ok(v.ok, JSON.stringify(v.ticks.filter((t) => !t.ok)))
    assert.equal(v.execution?.tier, 'software-evidence')
    assert.equal(v.scorer?.trust, 'dev-inprocess')
    assert.ok(v.ticks.some((t) => t.id === 'scorer:fallback' && /FALLBACK/.test(t.detail)), 'the container scorer is labelled as the fallback')

    // The lender's own rules decide: a tee floor refuses this software node, a forged K fails.
    const strict = await verifyForwardedCheck(received.payload, { ...lenderExpect, rules: { min_execution: 'tee' } })
    assert.equal(strict.ok, false)
    const forged = { ...received.payload, body: { ...received.payload.body, key: freshKey() } }
    const bad = await verifyForwardedCheck(signObject(forged, borrower.secretKey), lenderExpect)
    assert.equal(bad.ok, false)
    assert.ok(bad.ticks.some((t) => t.id === 'commitment' && !t.ok))
  })

  it('pay-then-deliver is labelled and trusts the node: a refusal after payment is caught but not prevented', async () => {
    const m = await market({ railsB: ['rgb-ln-pay-then-deliver'] })
    const served = serveOnce(m.nodeB, m.hub, opB)
    const offers = (await listOffers(m.borrowerBus, NOW)).valid
    const offerB = offers.find((o) => o.operator_pk === opB.pubkey)!
    const paid = await runPaidCheck({ bus: m.borrowerBus, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: NEG, bundle: m.bundle, offer: offerB, rail: 'rgb-ln-pay-then-deliver', payWith: USDT, payerRail: m.ln.payerRail(), dataCategories: [...contract.inputs.data_categories], now: NOW, timeoutMs: 5000 })
    await served
    assert.equal(paid.key_source, 'operator-result')
    const keyMsg = await forwardKey(m.borrowerBus, borrower, lender.pubkey, paid)
    const v = await verifyForwardedCheck(keyMsg, lenderExpect)
    assert.ok(v.ok)
    assert.equal(v.rail_label, RAIL_LABEL['rgb-ln-pay-then-deliver'])
    assert.match(v.rail_label!, /FALLBACK: pay, then deliver \(trusts the node\)/)

    // An operator that takes the money and stays silent: the payer is left with PAID_BUT_NO_KEY.
    const m2 = await market({ railsB: ['rgb-ln-pay-then-deliver'] })
    const silentBus = new MemoryBus(m2.hub, opB)
    const silent = (async () => {
      const { payload, event } = await silentBus.receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 })
      const node = m2.nodeB as unknown as { o: { bus: unknown } }
      node.o.bus = { ...silentBus, key: opB, send: async (kind: number, payload: CheckMessage, to: Hex, tags?: string[][]) => (kind === KIND.CHECK_RESULT ? payload as never : silentBus.send(kind, payload, to, tags)) }
      return m2.nodeB.handle(payload, event.pubkey)
    })()
    const offerB2 = (await listOffers(m2.borrowerBus, NOW)).valid.find((o) => o.operator_pk === opB.pubkey)!
    await assert.rejects(runPaidCheck({ bus: m2.borrowerBus, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: NEG, bundle: m2.bundle, offer: offerB2, rail: 'rgb-ln-pay-then-deliver', payWith: USDT, payerRail: m2.ln.payerRail(), dataCategories: [...contract.inputs.data_categories], now: NOW, timeoutMs: 300 }), /PAID_BUT_NO_KEY/)
    await silent
  })

  it('on the HODL rail an operator that never reveals K is never paid', async () => {
    const m = await market()
    const bus = new MemoryBus(m.hub, opB)
    const refuser = (async () => {
      const { payload, event } = await bus.receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 })
      const rails = (m.nodeB as unknown as { o: { rails: Record<string, { claim: unknown }> } }).o.rails
      rails['rgb-ln-hodl'].claim = async () => { throw new Error('operator refuses to reveal K') }
      return m.nodeB.handle(payload, event.pubkey)
    })()
    const offerB = (await listOffers(m.borrowerBus, NOW)).valid.find((o) => o.operator_pk === opB.pubkey)!
    await assert.rejects(runPaidCheck({ bus: m.borrowerBus, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: NEG, bundle: m.bundle, offer: offerB, rail: 'rgb-ln-hodl', payWith: USDT, payerRail: m.ln.payerRail(), dataCategories: [...contract.inputs.data_categories], now: NOW, timeoutMs: 3000 }), /cancelled/)
    const entry = await refuser
    assert.equal(entry.status, 'unpaid')
    assert.equal([...m.ln.invoices.values()][0].status, 'Cancelled', 'the held HTLC goes back to the payer')
  })

  it('refuses a request whose consent names another operator, before running anything', async () => {
    const m = await market()
    const served = serveOnce(m.nodeB, m.hub, opB)
    const offerB = (await listOffers(m.borrowerBus, NOW)).valid.find((o) => o.operator_pk === opB.pubkey)!
    const lie = { ...offerB, operator_pk: opA.pubkey }
    // The borrower's consent would name opA while the request goes to opB: the node refuses.
    const chain: CheckMessage[] = []
    const consent = signConsent(borrower, { purpose: 'x', purpose_id: NEG, scorer_id: offerB.scorer.scorer_id, scorer_pk: offerB.scorer.enclave_pubkey, contract_hash: CONTRACT, operator_pk: lie.operator_pk, lender_pk: lender.pubkey, data_categories: [...contract.inputs.data_categories], issued_at: NOW, expires_at: NOW + 60 })
    const req = appendCheckMessage(chain, borrower, opB.pubkey, 'REQUEST', { offer_hash: hashObject(offerB), request_nonce: randomHex(32), consent, check_request: { ciphertext: 'x' }, rail: 'rgb-ln-hodl', pay_with: USDT, payer: 'borrower' }, NEG)
    await m.borrowerBus.send(KIND.CHECK_REQUEST, req, opB.pubkey)
    const entry = await served
    assert.equal(entry.status, 'refused')
    assert.match(entry.reason!, /CONSENT_NAMES_ANOTHER_OPERATOR/)
    await assert.rejects(Promise.reject(new CheckRefused('x')), /check refused/)
  })
})

describe('the negotiation\'s structure step picks the check node', () => {
  const U = 1_000_000
  const PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb', 'ln-rln'] }
  const bSigner = new LocalKeySigner(keyPairFromLabel('neg-borrower'))
  const lSigner = new LocalKeySigner(keyPairFromLabel('neg-lender'))
  const bp = (over: Partial<BorrowerPolicy> = {}) => signBorrowerPolicy(bSigner, { asset_id: 'rgb:usdt', principal: { min: 300 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb', 'ln-rln'], issued_at: 1, ...over })
  const lp = (over: Partial<LenderPolicy> = {}) => signLenderPolicy(lSigner, { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: ['investigation'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [], maker_checker_above: 5_000 * U }, issued_at: 1, ...over })
  const hub = new MemoryHub()
  const ln = new MemoryLightning()
  const offers = [makeNode(hub, ln, opA, 800_000, { p50: 20 }).currentOffer(), makeNode(hub, ln, opB, 500_000, { p50: 40 }).currentOffer()]
  const market: CheckMarketInput = { offers, payer: { payer: 'borrower', payment_asset_id: USDT, rails: ['rgb-ln-hodl'] }, trust: trustPolicy(), tee: noTeeVerifier(NOW) }

  it('without a market the structure is unchanged; with one it adds the deterministic pick', async () => {
    const b = await bp(), l = await lp()
    const plain = structure(b, l, PARAMS)
    assert.ok(plain.ok && !('check_node' in plain))
    const s = structure(b, l, PARAMS, 0, market)
    assert.ok(s.ok)
    assert.equal(s.check_node?.operator_pk, opB.pubkey)
    assert.equal(s.check_node?.rail, 'rgb-ln-hodl')
    assert.ok(s.check_node?.why.length)
  })

  it('applies the lender\'s accepted operators and the borrower\'s price cap, or ends with CHECK_NODE', async () => {
    const only = structure(await bp(), await lp({ check_nodes: { accepted_check_operators: [opA.pubkey] } }), PARAMS, 0, market)
    assert.ok(only.ok && only.check_node?.operator_pk === opA.pubkey)
    const capped = structure(await bp({ max_check_price: { asset_id: USDT, amount: 400_000 } }), await lp(), PARAMS, 0, market)
    assert.equal(capped.ok, false)
    assert.ok(!capped.ok && capped.reason === 'CHECK_NODE')
    const tee = structure(await bp(), await lp({ check_nodes: { min_execution: 'tee' } }), PARAMS, 0, market)
    assert.ok(!tee.ok && tee.reason === 'CHECK_NODE', 'a tee floor refuses software nodes')
    await assert.rejects(lp({ check_nodes: { min_execution: 'enclave' as never } }), /check_nodes.min_execution/)
  })
})

describe('vouchers and receipts', () => {
  it('a check paid in another asset or amount is refused before K is revealed (receive checks)', async () => {
    const hub = new MemoryHub()
    const ln = new MemoryLightning()
    const node = makeNode(hub, ln, opB, 500_000)
    await node.publishOffer()
    const borrowerBus = new MemoryBus(hub, borrower)
    const served = (async () => { const { payload, event } = await new MemoryBus(hub, opB).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 }); return node.handle(payload, event.pubkey) })()
    const offer = (await listOffers(borrowerBus, NOW)).valid[0]
    const { f } = sandboxEngine()
    await assert.rejects(runPaidCheck({ bus: borrowerBus, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: NEG, bundle: f.bundle, offer, rail: 'rgb-ln-hodl', payWith: USDT, payerRail: ln.payerRail({ asset_id: 'rgb:pbchk-another-operator', amount: 1 }), dataCategories: [...contract.inputs.data_categories], now: NOW, timeoutMs: 3000 }))
    const entry = await served
    assert.equal(entry.status, 'unpaid')
    assert.match(entry.reason!, /RECEIVE_REFUSED/)
    assert.equal([...ln.invoices.values()][0].status, 'Cancelled', 'K stays secret and the HTLC goes back')
  })

  it('a voucher of another operator is refused before anything runs', async () => {
    const hub = new MemoryHub()
    const node = makeNode(hub, new MemoryLightning(), opB, 500_000, { voucher: 'rgb:pbchk-B' })
    const offer = node.currentOffer()
    const chain: CheckMessage[] = []
    const consent = signConsent(borrower, { purpose: 'x', purpose_id: NEG, scorer_id: offer.scorer.scorer_id, scorer_pk: offer.scorer.enclave_pubkey, contract_hash: CONTRACT, operator_pk: opB.pubkey, lender_pk: lender.pubkey, data_categories: [...contract.inputs.data_categories], issued_at: NOW, expires_at: NOW + 60 })
    const req = appendCheckMessage(chain, borrower, opB.pubkey, 'REQUEST', { offer_hash: hashObject(offer), request_nonce: randomHex(32), consent, check_request: { ciphertext: 'x' }, rail: 'rgb-ln-hodl', pay_with: 'rgb:pbchk-A', payer: 'borrower' }, NEG)
    assert.ok(node.requestProblems(req).includes('ASSET_NOT_ACCEPTED'))
    const own = appendCheckMessage([], borrower, opB.pubkey, 'REQUEST', { ...req.body, pay_with: 'rgb:pbchk-B' }, NEG)
    assert.deepEqual(node.requestProblems(own), [], 'its own voucher is accepted')
    assert.deepEqual(offer.accepted_assets.find((a) => a.kind === 'voucher'), { asset_id: 'rgb:pbchk-B', ticker: 'PBCHK', amount: 1, kind: 'voucher' }, '1 unit = 1 check')
  })

  it('the receipt holds hashes only, and the term sheet names it next to the evidence digest', () => {
    const data: CheckReceiptData = { v: 1, kind: 'passbook-check-receipt', commitment: '11'.repeat(32), evidence_digest: '22'.repeat(32), release_hash: '33'.repeat(32), operator_pk: opB.pubkey, tier: 'software-evidence', date: '2026-10-17' }
    assert.deepEqual(receiptDataProblems(data), [])
    assert.ok(receiptDataProblems({ ...data, recommendation: 'QUALIFY' }).length > 0, 'no result')
    assert.ok(receiptDataProblems({ ...data, borrower_pk: borrower.pubkey }).length > 0, 'no personal data')
    assert.ok(receiptDetails(data).length < 512)
    const scorerSchema = (TERMSHEET_SCHEMA as { properties: Record<string, JsonSchema> }).properties.scorer
    const scorer = { provider: 'container', scorer_id: 's', code_measurement: SOURCE, contract_hash: CONTRACT, trust: 'dev-inprocess', result_hash: '44'.repeat(32), fallback: true, recommendation: 'QUALIFY', evidence: { kind: 'passbook-run-record', run_record_sha256: '22'.repeat(32) } }
    assert.deepEqual(schemaErrors({ ...scorer, check_receipt: { contract_id: 'rgb:abcDEF12-345678~_9', commitment: '11'.repeat(32), operator_pk: opB.pubkey } }, scorerSchema), [])
    assert.deepEqual(schemaErrors(scorer, scorerSchema), [], 'optional: sheets without a check market are unchanged')
    assert.ok(schemaErrors({ ...scorer, check_receipt: { contract_id: 'rgb:x', commitment: '11'.repeat(32), operator_pk: opB.pubkey, outputs: {} } }, scorerSchema).length > 0)
  })
})

describe('2-of-N agreement end to end', () => {
  it('the borrower pays two different nodes; the lender accepts only when both verify and agree', async () => {
    const hub = new MemoryHub()
    const ln = new MemoryLightning()
    const nodes = [makeNode(hub, ln, opA, 800_000), makeNode(hub, ln, opB, 500_000)]
    for (const n of nodes) await n.publishOffer()
    const borrowerBus = new MemoryBus(hub, borrower)
    const { f } = sandboxEngine()
    const offers = (await listOffers(borrowerBus, NOW)).valid
    const pick = pickCheckNode(offers, { agreement: { required: 2 } }, payerOf(), ctx())
    const verified = []
    for (const [i, c] of [pick.picked!, pick.second!].entries()) {
      const node = nodes.find((n) => n.currentOffer().operator_pk === c.operator_pk)!
      const op = c.operator_pk === opA.pubkey ? opA : opB
      const neg = (i === 0 ? 'e1' : 'e2').repeat(32)
      const served = (async () => { const { payload, event } = await new MemoryBus(hub, op).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 }); return node.handle(payload, event.pubkey) })()
      const paid = await runPaidCheck({ bus: borrowerBus, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: neg, bundle: f.bundle, offer: c.offer, rail: 'rgb-ln-hodl', payWith: USDT, payerRail: ln.payerRail(), dataCategories: [...contract.inputs.data_categories], now: NOW, timeoutMs: 5000 })
      await served
      const keyMsg = await forwardKey(borrowerBus, borrower, lender.pubkey, paid)
      verified.push(await verifyForwardedCheck(keyMsg, { negotiation_id: neg, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, payer_pk: borrower.pubkey, rules: { agreement: { required: 2 } }, trust: trustPolicy(), tee: noTeeVerifier(NOW), requiredChecks: [], now: NOW }))
    }
    assert.deepEqual(verified.map((v) => v.ticks.filter((t) => !t.ok).map((t) => `${t.id}: ${t.detail}`)), [[], []])
    assert.deepEqual(agreementProblems(verified, 2), [])
    assert.ok(agreementProblems([verified[0]], 2).includes('AGREEMENT_NEEDS_2_CHECKS'))
    assert.ok(agreementProblems([verified[0], verified[0]], 2).includes('AGREEMENT_SAME_OPERATOR'))
    assert.ok(agreementProblems([verified[0], { ...verified[1], outputs: { ...verified[1].outputs!, recommendation: verified[0].outputs!.recommendation === 'QUALIFY' ? 'DECLINE' : 'QUALIFY' } }], 2).includes('AGREEMENT_RESULTS_DIFFER'))
    assert.ok(agreementProblems([verified[0], { ...verified[1], ok: false }], 2).includes('AGREEMENT_A_CHECK_FAILED'))
  })
})

describe('RGB Lightning payment direction', () => {
  it('reads the pinned node\'s `inbound` and the HODL build\'s `payment_type`', () => {
    assert.ok(isInboundPayment({ inbound: true }) && isInboundPayment({ payment_type: 'InboundHodl' }) && isInboundPayment({ payment_type: 'InboundAutoClaim' }))
    assert.ok(!isInboundPayment({ payment_type: 'Outbound' }) && !isInboundPayment({ inbound: false }) && !isInboundPayment(null))
    assert.ok(isOutboundPayment({ payment_type: 'Outbound' }) && isOutboundPayment({ inbound: false }) && !isOutboundPayment({ payment_type: 'InboundHodl' }))
  })
})

describe('review fixes', () => {
  const root = keyPairFromLabel('review-test-vendor-root')
  const leaf = keyPairFromLabel('review-test-vendor-leaf')
  const resultKey = keyPairFromLabel('review-enclave-result-key')
  const MEASUREMENT = 'pcr0:' + '42'.repeat(48)
  const vendorDoc = (reportDataHex: Hex) => {
    const unsigned = { vendor: 'test-vendor' as const, measurement: MEASUREMENT, public_key: resultKey.pubkey, report_data: reportDataHex, timestamp: NOW, leaf_pk: leaf.pubkey, leaf_sig: signHash(hashObject({ domain: 'passbook-test-vendor-leaf-v1', leaf_pk: leaf.pubkey }), root.secretKey) }
    return Buffer.from(JSON.stringify({ ...unsigned, sig: signHash(testVendorDocumentHash(unsigned), leaf.secretKey) })).toString('base64')
  }
  const teeCfg: TeeVerifierConfig = { vendors: { 'test-vendor': testVendorVerifier(root.pubkey) }, measurementFor: () => MEASUREMENT, maxAgeSeconds: 600, now: NOW }
  const lenderExpectFor = (neg: Hex, rules: Parameters<typeof verifyForwardedCheck>[1]['rules']) => ({ negotiation_id: neg, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, payer_pk: borrower.pubkey, rules, trust: trustPolicy(), tee: teeCfg, requiredChecks: [], now: NOW })

  async function teeMarket(withResultAttestation: boolean) {
    const hub = new MemoryHub()
    const ln = new MemoryLightning()
    const { engine } = sandboxEngine(undefined, keyPairFromLabel('review-tee-enclave'))
    const node = new CheckNode({
      operator: opB, engine, bus: new MemoryBus(hub, opB), rails: { 'rgb-ln-hodl': ln.operatorRail('rgb-ln-hodl') }, assets: [{ asset_id: USDT, ticker: 'USDT', amount: 500_000, kind: 'payment' }], now: () => NOW, paymentTimeoutMs: 2000,
      execution: { tee: 'test-vendor', attestation: vendorDoc('00'.repeat(32)), result_key: resultKey.pubkey },
      ...(withResultAttestation ? { attestResult: async (c: { report_data: Hex; commitment: Hex }) => ({ attestation: vendorDoc(c.report_data), result_sig: signHash(c.commitment, resultKey.secretKey) }) } : {}),
    })
    await node.publishOffer()
    const bus = new MemoryBus(hub, borrower)
    const served = (async () => { const { payload, event } = await new MemoryBus(hub, opB).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 }); return node.handle(payload, event.pubkey) })()
    const offer = (await listOffers(bus, NOW)).valid[0]
    const neg = randomHex(32)
    const paid = await runPaidCheck({ bus, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: neg, bundle: sandboxEngine().f.bundle, offer, rail: 'rgb-ln-hodl', payWith: USDT, payerRail: ln.payerRail(), dataCategories: [...contract.inputs.data_categories], now: NOW, timeoutMs: 5000 })
    await served
    return { neg, offer, key: await forwardKey(bus, borrower, lender.pubkey, paid) }
  }

  it('min_execution tee: the lender accepts only a result whose own attestation and result_key signature verify', async () => {
    const good = await teeMarket(true)
    assert.equal(pickCheckNode([good.offer], { min_execution: 'tee' }, payerOf(), { trust: trustPolicy(), tee: teeCfg }).picked?.operator_pk, opB.pubkey, 'the offer is attestable')
    const v = await verifyForwardedCheck(good.key, lenderExpectFor(good.neg, { min_execution: 'tee' }))
    assert.ok(v.ok, JSON.stringify(v.ticks.filter((t) => !t.ok)))
    assert.equal(v.execution?.tier, 'tee-attested')
    // An attestable offer whose result carries no fresh attestation is software evidence, and refused.
    const bare = await teeMarket(false)
    const refused = await verifyForwardedCheck(bare.key, lenderExpectFor(bare.neg, { min_execution: 'tee' }))
    assert.equal(refused.ok, false)
    assert.equal(refused.execution?.tier, 'software-evidence')
    assert.ok(refused.ticks.some((t) => t.id === 'execution-tier' && !t.ok && /no attestation for this result/.test(t.detail)))
    assert.ok((await verifyForwardedCheck(bare.key, lenderExpectFor(bare.neg, {}))).ok, 'without a tee floor the same result is fine')
  })

  it('a sealed blob that does not match the signed commitment is refused before paying', async () => {
    const hub = new MemoryHub()
    const ln = new MemoryLightning()
    const node = makeNode(hub, ln, opB, 500_000)
    await node.publishOffer()
    const opBus = new MemoryBus(hub, opB)
    ;(node as unknown as { o: { bus: unknown } }).o.bus = { ...opBus, key: opB, send: (kind: number, m: CheckMessage, to: Hex, tags?: string[][]) => {
      const b = m.body as { status?: string; sealed?: { ciphertext: string } }
      // A dishonest node: the blob it sends is not the one it committed to.
      const swapped = b.status === 'payment-required' ? signObject({ ...m, body: { ...m.body, sealed: { ...b.sealed!, ciphertext: Buffer.from('not the committed blob').toString('base64') } } }, opB.secretKey) : m
      return opBus.send(kind, swapped, to, tags)
    } }
    const served = (async () => { const { payload, event } = await opBus.receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000 }); return node.handle(payload, event.pubkey) })()
    const offer = (await listOffers(new MemoryBus(hub, borrower), NOW)).valid[0]
    await assert.rejects(runPaidCheck({ bus: new MemoryBus(hub, borrower), payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: NEG, bundle: sandboxEngine().f.bundle, offer, rail: 'rgb-ln-hodl', payWith: USDT, payerRail: ln.payerRail(), dataCategories: [...contract.inputs.data_categories], now: NOW, timeoutMs: 400 }), /not paying: .*SEALED_NOT_COMMITTED/)
    assert.equal([...ln.invoices.values()][0].status, 'Open', 'nothing was paid')
    await served
  })

  it('the signed negotiation runs the structure step with the market: the pick, or no deal with CHECK_NODE', async () => {
    const U = 1_000_000
    const PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb', 'ln-rln'] }
    const bS = new LocalKeySigner(keyPairFromLabel('neg-borrower')), lS = new LocalKeySigner(keyPairFromLabel('neg-lender'))
    const bp = (over: Partial<BorrowerPolicy> = {}) => signBorrowerPolicy(bS, { asset_id: 'rgb:usdt', principal: { min: 300 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb', 'ln-rln'], issued_at: 1, ...over })
    const lp = await signLenderPolicy(lS, { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: ['investigation'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [], maker_checker_above: 5_000 * U }, check_nodes: { accepted_check_operators: [opA.pubkey, opB.pubkey] }, issued_at: 1 })
    const hub = new MemoryHub(), ln = new MemoryLightning()
    const market: CheckMarketInput = { offers: [makeNode(hub, ln, opA, 800_000).currentOffer(), makeNode(hub, ln, opB, 500_000).currentOffer()], payer: { payer: 'borrower', payment_asset_id: USDT, rails: ['rgb-ln-hodl'] }, trust: trustPolicy(), tee: noTeeVerifier(NOW) }
    const run = await runNegotiation(await bp(), lp, PARAMS, { borrower: bS, lender: lS, nonce: 'aa'.repeat(32), market })
    assert.ok(run.structure.ok && run.structure.check_node?.operator_pk === opB.pubkey)
    assert.ok('agreed' in run.outcome)
    const capped = await runNegotiation(await bp({ max_check_price: { asset_id: USDT, amount: 100_000 } }), lp, PARAMS, { borrower: bS, lender: lS, nonce: 'bb'.repeat(32), market })
    assert.deepEqual(capped.outcome, { no_deal: 'CHECK_NODE' })
    assert.equal(capped.messages.length, 0, 'nothing is sent when no check node meets both policies')
  })
})
