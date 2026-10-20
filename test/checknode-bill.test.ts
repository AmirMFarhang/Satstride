import { localCheckEngine, memoryTransport, type LocalCheckOptions } from './local-check-helpers.js'
// Bill at close (the user's decision): a lender with no Lightning (a phone
// lender) gets the borrower's local scorer check on credit. The check node hands over
// the result and K at once with a signed bill; the fee is added to the lender's
// platform fee at close (test/fees-check-bill.test.ts). Here: the phone
// lender's browser-safe half (src/checknode/lender-core.ts) and the borrower's
// half, as separate key holders over the in-memory relay; the node's rate limit
// and its refusal of lenders blocked for unpaid fees; the bill's own checks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { keyPairFromLabel, randomHex, sha256Hex, signObject } from '../src/core/crypto.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { bundleLoan } from '../src/scorer/bundle-terms.js'
import { bundleCategories } from '../src/scorer/consent.js'
import { contractHash, loadScoringContract } from '../src/scorer/contract.js'
import { signReleaseManifest } from '../src/scorer/releases.js'
import type { TrustPolicy } from '../src/scorer/verify.js'
import { BILL_LABEL, billHash, billProblems, billSignatureProblems, signBill, type BilledCheckReceipt } from '../src/checknode/bill.js'
import { billingFromEnv, MemoryBillLedger } from '../src/checknode/bill-ledger.js'
import { CheckRefused, prepareBorrowerCheckPart, runBorrowerCheck } from '../src/checknode/borrower-check.js'
import { receiveBorrowerCheckPart, runLenderCheck } from '../src/agents/lender-check.js'
import { buildNode } from '../src/checknode/market.js'
import { MemoryBus, MemoryHub } from '../src/checknode/bus.js'
import { listOffers, verifyForwardedCheck } from '../src/checknode/client.js'
import { portableBus, receivePartPortable, runLenderCheckBilled } from '../src/checknode/lender-core.js'
import { checkMessageHash, type CheckMessage } from '../src/checknode/messages.js'
import { CheckNode, type CheckBilling, type RequestBody } from '../src/checknode/node.js'
import { offerProblems, releaseHash, type CheckOffer } from '../src/checknode/offer.js'
import { keyPairSigner } from '../src/checknode/signer.js'
import { noTeeVerifier } from '../src/checknode/tee.js'
import { KIND } from '../src/market/kinds.js'
import type { Event } from 'nostr-tools'
import { NOW, USDT, SOURCE } from './checknode-helpers.js'

const borrowerKey = keyPairFromLabel('fatima')
const lenderKey = keyPairFromLabel('bill-phone-lender')
const operator = keyPairFromLabel('bill-operator')
const contract = loadScoringContract()
const NEG = '3' + sha256Hex('bill-negotiation').slice(1)
const f = investigationFixture('fatima')
const bundle = f.bundle
const loan = { ...bundleLoan(bundle), asset_id: USDT }
// The bill is charged with the platform fee in the loan's asset, so the bundle asks for a loan in the check's asset.
const loanBundle = { ...bundle, asset_id: USDT }
const categories = bundleCategories(loanBundle)

async function setup(billing: Partial<CheckBilling> = {}, nodeOver: { approvalTimeoutMs?: number; bus?: (hub: MemoryHub) => MemoryBus; hub?: MemoryHub; local?: LocalCheckOptions } = {}) {
  const hub = nodeOver.hub ?? new MemoryHub()
  const cx=localCheckEngine(nodeOver.local,f)
  const engine=cx.engine
  const ledger = new MemoryBillLedger()
  const gates: string[] = []
  const node = new CheckNode({
    operator, engine, bus: nodeOver.bus ? nodeOver.bus(hub) : new MemoryBus(hub, operator), rails: {}, assets: [{ asset_id: USDT, ticker: 'USDT', amount: 500_000, kind: 'payment' }], now: () => NOW, approvalTimeoutMs: nodeOver.approvalTimeoutMs ?? 3000,
    billing: { maxPerDay: 3, ttlSeconds: 30 * 24 * 3600, ledger, feeGate: async (pk) => { gates.push(pk); return null }, ...billing },
  })
  await node.publishOffer()
  const offer = (await listOffers(new MemoryBus(hub, lenderKey), NOW)).valid[0]
  return { hub, cx, engine, node, offer, ledger, gates }
}

const serveOnce = async (node: CheckNode, hub: MemoryHub) => {
  const { payload, event } = await new MemoryBus(hub, operator).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000, match: (x) => x.type === 'REQUEST' })
  return node.handle(payload, event.pubkey)
}

/** The phone lender: only its key, behind a signer, over the relay. */
async function phoneLender(s: Awaited<ReturnType<typeof setup>>, offer: CheckOffer = s.offer) {
  const signer = keyPairSigner(lenderKey)
  const bus = portableBus(memoryTransport(s.hub), signer)
  try {
    const part = await receivePartPortable(bus, borrowerKey.pubkey, NEG, 4000)
    return await runLenderCheckBilled({ bus, signer, part, offer, rules: { accepted_check_operators: [operator.pubkey], max_price: { asset_id: USDT, amount: 1_000_000 } }, loan, requiredChecks: ['reconcile', 'inflows', 'affordability', 'investigation'], evidenceKeys: [], allowDevelopment: true, now: NOW, timeoutMs: 4000, approvalTimeoutMs: 4000 })
  } finally {
    bus.close()
  }
}

const phoneBorrower = (s: Awaited<ReturnType<typeof setup>>) => runBorrowerCheck({ transport: memoryTransport(s.hub), signer: keyPairSigner(borrowerKey), offer: s.offer, lenderPk: lenderKey.pubkey, negotiationId: NEG, bundle: loanBundle, dataCategories: categories, evidenceKeys: [], allowDevelopment: true, now: () => NOW, timeoutMs: 8000 })

describe('bill at close: a phone lender gets the check on credit', () => {
  it('the node hands over the result and K at once with a signed bill; both phones verify; nothing is paid up front', async () => {
    const s = await setup()
    assert.deepEqual(s.offer.rails, ['bill-at-close'])
    assert.ok(s.offer.payer_modes.includes('lender'))
    const served = serveOnce(s.node, s.hub)
    const [b, l] = await Promise.all([phoneBorrower(s), phoneLender(s)])
    const entry = await served
    assert.equal(entry.status, 'billed')
    assert.equal(entry.bill_hash, l.bill_hash)
    assert.ok(l.ok, JSON.stringify(l.ticks.filter((t) => !t.ok)))
    assert.equal(l.outputs?.v, 2)
    assert.equal(l.outputs?.recommendation, 'QUALIFY')
    assert.match(l.not_run.join(' '), /hardware isolation/, 'the phone states its software trust limitation')
    for (const id of ['required-checks', 'message-chain', 'consent', 'commitment', 'bill', 'evidence:signature', 'evidence:binding', 'evidence:run-record-signature', 'evidence:scored-loan']) assert.ok(l.ticks.some((t) => t.id === id && t.ok), id)
    // The bill: this check, this lender and borrower, the offered price, due at close, labelled.
    assert.equal(l.bill.label, BILL_LABEL)
    assert.equal(l.bill.due, 'at-close')
    assert.deepEqual([l.bill.lender_pk, l.bill.borrower_pk, l.bill.operator_pk], [lenderKey.pubkey, borrowerKey.pubkey, operator.pubkey])
    assert.deepEqual(l.bill.fee, { asset_id: USDT, amount: 500_000 })
    assert.equal(l.bill.commitment, l.commitment)
    assert.deepEqual(s.ledger.bills.map(billHash), [l.bill_hash], 'the node recorded the bill once the RESULT with K was out')
    assert.deepEqual(s.gates, [lenderKey.pubkey], 'the node asked the platform about this lender\'s fees first')
    // The chain: billed, not payment-required; K from the operator's RESULT.
    const chain = [...(l.key.body as { chain: CheckMessage[] }).chain, l.key]
    assert.deepEqual(chain.map((m) => `${m.type}${m.type === 'FEEDBACK' || m.type === 'RESULT' ? `:${(m.body as { status: string }).status}` : ''}`), ['REQUEST', 'FEEDBACK:billed', 'RESULT:billed', 'KEY'])
    assert.equal((l.key.body as { key_source: string }).key_source, 'operator-billed')
    // The borrower's phone opens the same result and sees the bill was the lender's.
    assert.ok(b.view.ok, JSON.stringify(b.view.ticks.filter((t) => !t.ok)))
    assert.equal(b.view.key_source, 'operator-billed')
    assert.equal(b.view.key_message_hash, checkMessageHash(l.key))
    assert.match(b.view.ticks.find((t) => t.id === 'key-binding')!.detail, /billed to the lender at close, not paid up front/)
    // The laptop verifier accepts the same KEY (the provider console, an auditor).
    const releaseSigner = keyPairFromLabel('bill-release-signer')
    const trust: TrustPolicy = { minTrust: 'dev-inprocess', releases: signReleaseManifest(releaseSigner, { builds: [{ label: 'local scorer (test)', provider: 'container', code_measurement: SOURCE, contract_hash: contractHash(contract), max_trust: 'dev-inprocess' }], issued_at: 1 }), releaseSignerPk: releaseSigner.pubkey, contract }
    const v = await verifyForwardedCheck(l.key, { negotiation_id: NEG, borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, payer_pk: lenderKey.pubkey, rules: { min_trust: 'dev-inprocess' }, trust, tee: noTeeVerifier(NOW), requiredChecks: [], loan, now: NOW })
    assert.ok(v.ok, JSON.stringify(v.ticks.filter((t) => !t.ok)))
    assert.match(v.ticks.find((t) => t.id === 'key-binding')!.detail, /Billed at close, not paid up front/)
  })

  it('the desktop lender gets the same billed check and performs its full verifier without a payer node', async () => {
    const s = await setup()
    const served = serveOnce(s.node, s.hub)
    const releaseSigner = keyPairFromLabel('bill-release-signer')
    const trust: TrustPolicy = { minTrust: 'dev-inprocess', releases: signReleaseManifest(releaseSigner, { builds: [{ label: 'local scorer (test)', provider: 'container', code_measurement: SOURCE, contract_hash: contractHash(contract), max_trust: 'dev-inprocess' }], issued_at: 1 }), releaseSignerPk: releaseSigner.pubkey, contract }
    let approved = false
    const desktop = async () => {
      const bus = new MemoryBus(s.hub, lenderKey)
      const part = await receiveBorrowerCheckPart(bus, borrowerKey.pubkey, NEG, 4000)
      return runLenderCheck({ bus, part, offer: s.offer, rules: { min_trust: 'dev-inprocess' }, trust, tee: noTeeVerifier(NOW), loan, requiredChecks: ['inflows'], now: NOW, timeoutMs: 4000, beforeBill: () => { assert.equal(s.cx.calls.length, 0, 'approval precedes the request and scorer work'); approved = true } })
    }
    const [b, l] = await Promise.all([phoneBorrower(s), desktop()])
    assert.equal((await served).status, 'billed')
    assert.ok(approved)
    assert.ok(l.verification.ok, JSON.stringify(l.verification.ticks.filter((t) => !t.ok)))
    assert.ok(b.view.ok)
    assert.equal(l.bill?.due, 'at-close')
    assert.equal((l.key.body as { key_source: string }).key_source, 'operator-billed')
  })

  it('a billed provider never probes a stale payment-node URL and its status advertises its usable rail', async () => {
    const s = await setup()
    const oldFetch = globalThis.fetch
    let probes = 0
    globalThis.fetch = async () => { probes++; throw new Error('retired transport') }
    try {
      const n = await buildNode({ name: 'no-payment-node', operator, demoKey: true, priceMicro: 500_000, p50Seconds: 1, lnUrl: 'http://retired.invalid', rails: [], paymentAssetId: USDT }, new MemoryBus(s.hub, operator), s.engine, { payerModes: ['lender'], billing: { maxPerDay: 3, ttlSeconds: 3600, ledger: s.ledger, feeGate: async () => null } })
      assert.equal(probes, 0)
      assert.deepEqual(n.status().rails.map((r) => r.rail), ['bill-at-close'])
      assert.equal(n.currentOffer().ln_node_pubkey, undefined)
    } finally { globalThis.fetch = oldFetch }
  })

  it('rejects malformed limits instead of disabling provider-funded check protection', () => {
    for (const max of ['NaN', '0', '-1', '1.5', 'Infinity']) assert.throws(() => billingFromEnv({ env: { PASSBOOK_CHECK_BILLS: '/unused', PASSBOOK_URL: 'http://127.0.0.1:9', PASSBOOK_CHECK_BILL_MAX_PER_DAY: max } }), /BILL_RATE_LIMIT_CONFIG/)
  })

  it('rate-limits bills per lender key: past the limit the node refuses before anything runs', async () => {
    const s = await setup({ maxPerDay: 1 })
    // One bill already issued to this lender today.
    s.ledger.append(signBill(operator, { negotiation_id: randomHex(32), lender_pk: lenderKey.pubkey, borrower_pk: borrowerKey.pubkey, offer_hash: randomHex(32), release_hash: randomHex(32), request_hash: randomHex(32), commitment: randomHex(32), fee: { asset_id: USDT, amount: 500_000 }, issued_at: NOW - 60, expires_at: NOW + 3600 }))
    const served = serveOnce(s.node, s.hub)
    const [b, l] = await Promise.allSettled([phoneBorrower(s), phoneLender(s)])
    const entry = await served
    assert.equal(entry.status, 'refused')
    assert.equal(entry.reason, 'BILL_RATE_LIMITED')
    assert.ok(l.status === 'rejected' && l.reason instanceof CheckRefused && /BILL_RATE_LIMITED/.test(l.reason.reason))
    assert.ok(b.status === 'rejected' && /BILL_RATE_LIMITED/.test(String((b.reason as Error).message)), 'the borrower is told, with the code')
    assert.deepEqual(s.cx.calls, [], 'local scorer never ran')
    assert.equal(s.ledger.bills.length, 1, 'no new bill')
  })

  it('refuses a lender blocked for unpaid fees, and fails closed when the platform cannot say', async () => {
    for (const [gate, code] of [[async () => 'Pay your outstanding platform fee to publish offers.', 'BILL_LENDER_BLOCKED'], [async () => { throw new Error('ECONNREFUSED') }, 'BILL_FEE_STATUS_UNAVAILABLE']] as const) {
      const s = await setup({ feeGate: gate })
      const served = serveOnce(s.node, s.hub)
      const [, l] = await Promise.allSettled([phoneBorrower(s), phoneLender(s)])
      assert.equal((await served).reason, code)
      assert.ok(l.status === 'rejected' && (l.reason as CheckRefused).reason.includes(code), code)
      assert.deepEqual(s.cx.calls, [], 'local scorer never ran')
      assert.equal(s.ledger.bills.length, 0)
    }
  })

  it('bills only a lender: a borrower-paid request on the bill rail is refused; an offer must name the lender as payer', async () => {
    const s = await setup()
    const part = await prepareBorrowerCheckPart({ signer: keyPairSigner(borrowerKey), offer: s.offer, lenderPk: lenderKey.pubkey, negotiationId: NEG, bundle: loanBundle, dataCategories: categories, now: NOW })
    const body: RequestBody = { offer_hash: part.offer_hash, request_nonce: randomHex(32), consent: part.consent, check_request: part.check_request, rail: 'bill-at-close', pay_with: USDT, payer: 'borrower' }
    const m = signObject({ v: 1 as const, domain: 'passbook-check-v1' as const, negotiation_id: NEG, seq: 0, type: 'REQUEST' as const, from_pk: borrowerKey.pubkey, to_pk: operator.pubkey, prev_hash: null, body: body as unknown as Record<string, unknown> }, borrowerKey.secretKey)
    assert.ok(s.node.requestProblems(m).includes('BILL_LENDER_ONLY'))
    const { sig: _sig, ...unsigned } = s.offer
    assert.ok(offerProblems(signObject({ ...unsigned, payer_modes: ['borrower'] as ('borrower' | 'lender')[] }, operator.secretKey), NOW).includes('OFFER_BILL_NEEDS_LENDER_PAYER'))
  })

  it('the bill names exactly this check: another price, lender, commitment, label or signer is refused', async () => {
    const s = await setup()
    const served = serveOnce(s.node, s.hub)
    const [, l] = await Promise.all([phoneBorrower(s), phoneLender(s)])
    await served
    const chain = (l.key.body as { chain: CheckMessage[] }).chain
    const ctx = { offer: s.offer, request: chain[0], commitment: l.commitment, lenderPk: lenderKey.pubkey, borrowerPk: borrowerKey.pubkey, now: NOW }
    assert.deepEqual(billProblems(l.bill, ctx), [])
    const resign = (b: Partial<BilledCheckReceipt>) => { const { sig: _s, ...rest } = { ...l.bill, ...b }; return signObject(rest, operator.secretKey) as BilledCheckReceipt }
    assert.ok(billProblems(resign({ fee: { asset_id: USDT, amount: 1 } }), ctx).includes('BILL_NOT_THE_OFFERED_PRICE'))
    assert.ok(billProblems(resign({ lender_pk: keyPairFromLabel('another-lender').pubkey }), ctx).includes('BILL_OTHER_PARTIES'))
    assert.ok(billProblems(resign({ commitment: randomHex(32) }), ctx).includes('BILL_OTHER_COMMITMENT'))
    assert.ok(billSignatureProblems({ ...l.bill, label: 'paid' as never }).includes('BILL_LABEL'))
    const { sig: _s, ...rest } = l.bill
    const forged = signObject(rest, keyPairFromLabel('someone-else').secretKey) as BilledCheckReceipt
    assert.ok(billSignatureProblems(forged).includes('BILL_SIGNATURE'))
    assert.ok(billProblems(resign({ expires_at: NOW - 1, issued_at: NOW - 100 }), ctx).includes('BILL_WINDOW'))
    assert.equal(releaseHash(s.offer.release), l.bill.release_hash)
  })
})

describe('bill at close: review fixes', () => {
  /** A lender REQUEST on the bill rail for its own negotiation, built from the borrower's real part. */
  async function request(s: Awaited<ReturnType<typeof setup>>, neg: string): Promise<CheckMessage> {
    const part = await prepareBorrowerCheckPart({ signer: keyPairSigner(borrowerKey), offer: s.offer, lenderPk: lenderKey.pubkey, negotiationId: neg, bundle: loanBundle, dataCategories: categories, now: NOW })
    const body: RequestBody = { offer_hash: part.offer_hash, request_nonce: randomHex(32), consent: part.consent, check_request: part.check_request, rail: 'bill-at-close', pay_with: USDT, payer: 'lender' }
    return signObject({ v: 1 as const, domain: 'passbook-check-v1' as const, negotiation_id: neg, seq: 0, type: 'REQUEST' as const, from_pk: lenderKey.pubkey, to_pk: operator.pubkey, prev_hash: null, body: body as unknown as Record<string, unknown> }, lenderKey.secretKey)
  }

  it('concurrent requests cannot exceed the per-lender limit: capacity is reserved before the check runs, and released after', async () => {
    // One bill a day; the first request holds its slot while it waits for the borrower's approval (which never comes here).
    const s = await setup({ maxPerDay: 1 }, { local: {fail:true} })
    const [m1, m2, m3] = await Promise.all(['a', 'b', 'c'].map((x) => request(s, '4' + sha256Hex(`bill-concurrent-${x}`).slice(1))))
    const [r1, r2] = await Promise.all([s.node.handle(m1, lenderKey.pubkey), s.node.handle(m2, lenderKey.pubkey)])
    assert.equal(r2.reason, 'BILL_RATE_LIMITED', 'the second concurrent request is refused while the first holds the only slot')
    assert.notEqual(r1.reason, 'BILL_RATE_LIMITED')
    assert.equal(r1.status, 'refused', 'the first ran and stopped at the approval timeout, billing nothing')
    assert.equal(s.ledger.bills.length, 0)
    // The slot came back when the first ended without a bill.
    const r3 = await s.node.handle(m3, lenderKey.pubkey)
    assert.notEqual(r3.reason, 'BILL_RATE_LIMITED')
  })

  it('a check whose RESULT never reached the lender is not billed', async () => {
    class DropResult extends MemoryBus {
      override send(kind: number, payload: unknown, to: string, tags: string[][] = []) {
        if ((payload as CheckMessage)?.type === 'RESULT') return Promise.reject(new Error('relay unreachable'))
        return super.send(kind, payload, to, tags)
      }
    }
    const s = await setup({}, { bus: (hub) => new DropResult(hub, operator) })
    const served = serveOnce(s.node, s.hub)
    const [, l] = await Promise.allSettled([phoneBorrower(s), phoneLender(s)])
    const entry = await served
    assert.equal(entry.status, 'undelivered')
    assert.match(entry.reason ?? '', /RESULT_NOT_DELIVERED: not billed/)
    assert.equal(s.ledger.bills.length, 0, 'nothing for the platform to charge')
    assert.ok(l.status === 'rejected' && /OPERATOR_SENT_NO_KEY/.test((l.reason as CheckRefused).reason))
  })
})

describe('check messages on public relays', () => {
  /** A relay that, like nos.lol and nostr.mom, does not store events over 60 KiB. */
  class CappedHub extends MemoryHub {
    largest = 0
    dropped = 0
    override publish(e: Event): void {
      const n = new TextEncoder().encode(JSON.stringify(e)).length
      this.largest = Math.max(this.largest, n)
      if (n > 61_440) { this.dropped++; return }
      super.publish(e)
    }
  }

  it('large generic requests stay below the relay limit after chunking', async () => {
    const hub=new CappedHub(),signer=keyPairSigner(borrowerKey)
    const {relayEvents}=await import('../src/checknode/borrower-check.js')
    const payload={domain:'passbook-check-relay-v1',type:'REFUSED',reason:randomHex(50_000),negotiation_id:NEG} as never
    const events=await relayEvents(signer,payload,lenderKey.pubkey,NEG)
    for(const e of events)hub.publish(e)
    assert.ok(events.length>1);assert.equal(hub.dropped,0);assert.ok(hub.largest<=61_440)
  })
})

describe('the phone lender half runs without Node', () => {
  it('lender-core.ts and bill.ts import no node: module and only browser-safe packages, transitively', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const allowed = [/^@noble\/curves\//, /^@noble\/hashes\//, /^@noble\/ciphers\/aes\.js$/, /^nostr-tools$/]
    const seen = new Set<string>()
    const bare = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/^(?:import|export)\s+(?!type\b)[^'";]*?from\s+'([^']+)'/gm)) {
        if (m[1].startsWith('.')) visit(resolve(dirname(file), m[1].replace(/\.js$/, '.ts')))
        else bare.add(m[1])
      }
      // No Node call at import time either (Metro maps node: to stubs that throw only when called).
      assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /^(?:export )?const [^=]+=\s*(?:fileURLToPath|readFileSync|process\.)/m, file)
    }
    for (const entry of ['src/checknode/lender-core.ts', 'src/checknode/bill.ts']) visit(join(root, entry))
    assert.deepEqual([...bare].filter((s) => !allowed.some((r) => r.test(s))), [])
    assert.ok(![...seen].some((x) => /(bill-ledger|node|client|rail|provider|market)\.ts$/.test(x) && x.includes('/checknode/')), 'no laptop-only check-market module in the phone closure')
    assert.ok(![...seen].some((x) => /src\/scorer\/(providers|verify|contract|external|releases)\.ts$/.test(x)))
  })
})
