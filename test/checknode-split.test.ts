import { localCheckEngine, memoryTransport, type LocalCheckOptions } from './local-check-helpers.js'
// The lender-paid check split in two key holders: the borrower half
// (src/checknode/borrower-check.ts, browser-safe, the phone's) holds only the
// borrower's key behind a CheckSigner and talks to the relay through a
// CheckTransport; the lender half (src/agents/lender-check.ts) holds only the
// lender's key, sends the REQUEST, relays the local scorer approval, accepts a close-time bill and forwards K. The check node runs the local scorer engine against a
// TEST-ONLY fake local scorer API (test/checknode-split-helpers.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { hashObject, keyPairFromLabel, randomHex, sha256Hex, signObject, type Hex } from '../src/core/crypto.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { bundleLoan } from '../src/scorer/bundle-terms.js'
import { bundleCategories } from '../src/scorer/consent.js'
import { contractHash, loadScoringContract } from '../src/scorer/contract.js'
import { signReleaseManifest } from '../src/scorer/releases.js'
import type { TrustPolicy } from '../src/scorer/verify.js'
import { borrowerCheckPartProblems, CheckRefused, openForwardedCheck, prepareBorrowerCheckPart, runBorrowerCheck, type BorrowerCheckPart } from '../src/checknode/borrower-check.js'
import { MemoryBus, MemoryHub, type CheckBus } from '../src/checknode/bus.js'
import { listOffers } from '../src/checknode/client.js'
import { checkMessageHash, type CheckMessage } from '../src/checknode/messages.js'
import { MemoryBillLedger } from '../src/checknode/bill-ledger.js'
import { CheckNode, type RequestBody } from '../src/checknode/node.js'
import { releaseHash, type CheckOffer } from '../src/checknode/offer.js'
import { gunzip } from '../src/checknode/portable.js'
import { freshKey, keyHash, plaintextCommitment, seal, unseal, unsealPortable, type CheckPlaintext } from '../src/checknode/seal.js'
import { keyPairSigner } from '../src/checknode/signer.js'
import { noTeeVerifier } from '../src/checknode/tee.js'
import { KIND } from '../src/market/kinds.js'
import { receiveBorrowerCheckPart, runLenderCheck } from '../src/agents/lender-check.js'
import { evidenceDigest } from '../src/scorer/evidence-digest.js'
import { evidenceDigest as evidenceDigestCore } from '../src/scorer/evidence-digest-core.js'
import { NOW, USDT, SOURCE } from './checknode-helpers.js'

const borrowerKey = keyPairFromLabel('fatima')
const lenderKey = keyPairFromLabel('split-lender')
const operator = keyPairFromLabel('split-operator')
const releaseSigner = keyPairFromLabel('split-release-signer')
const contract = loadScoringContract()
const CONTRACT = contractHash(contract)
// Most negotiation ids start with a digit, which local scorer refuses as a purpose: the engine prefixes it.
const NEG = '7' + sha256Hex('split-negotiation').slice(1)
const f = investigationFixture('fatima')
const bundle = f.bundle
const categories = bundleCategories(bundle)
const trust: TrustPolicy = { minTrust: 'dev-inprocess', releases: signReleaseManifest(releaseSigner, { builds: [{ label: 'local scorer passbook-credit workload (test)', provider: 'container', code_measurement: SOURCE, contract_hash: CONTRACT, max_trust: 'dev-inprocess' }], issued_at: 1 }), releaseSignerPk: releaseSigner.pubkey, contract }

async function setup(over: LocalCheckOptions = {}, nodeBus?: (hub: MemoryHub) => CheckBus) {
  const hub = new MemoryHub()
  const ledger = new MemoryBillLedger()
  const cx=localCheckEngine(over,f)
  const engine=cx.engine
  const node = new CheckNode({ operator, engine, bus: nodeBus ? nodeBus(hub) : new MemoryBus(hub, operator), rails: {}, billing: { maxPerDay: 3, ttlSeconds: 3600, ledger, feeGate: async () => null }, assets: [{ asset_id: USDT, ticker: 'USDT', amount: 500_000, kind: 'payment' }], now: () => NOW, paymentTimeoutMs: 3000, approvalTimeoutMs: 3000 })
  await node.publishOffer()
  const lenderBus = new MemoryBus(hub, lenderKey)
  const offer = (await listOffers(lenderBus, NOW)).valid[0]
  return { hub, ledger, cx, node, offer, lenderBus }
}

/** The operator answers one REQUEST, as `passbook check-node provide` does. */
async function serveOnce(node: CheckNode, hub: MemoryHub) {
  const { payload, event } = await new MemoryBus(hub, operator).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 5000, match: (x) => x.type === 'REQUEST' })
  return node.handle(payload, event.pubkey)
}

function lenderRun(s: Awaited<ReturnType<typeof setup>>, part: BorrowerCheckPart, over: Partial<Parameters<typeof runLenderCheck>[0]> = {}) {
  return runLenderCheck({ bus: s.lenderBus, part, rules: { min_trust: 'dev-inprocess', accepted_check_operators: [operator.pubkey] }, trust, tee: noTeeVerifier(NOW), requiredChecks: ['reconcile'], loan: bundleLoan(bundle), now: NOW, timeoutMs: 4000, approvalTimeoutMs: 4000, ...over })
}

const prepare = (offer: CheckOffer, over: Partial<Parameters<typeof prepareBorrowerCheckPart>[0]> = {}) => prepareBorrowerCheckPart({ signer: keyPairSigner(borrowerKey), offer, lenderPk: lenderKey.pubkey, negotiationId: NEG, bundle, dataCategories: categories, now: NOW, ...over })

/** Re-signs a part with a changed consent, as a borrower (or an attacker holding its key) could. */
async function partWithConsent(offer: CheckOffer, change: Record<string, unknown>): Promise<BorrowerCheckPart> {
  const p = await prepare(offer)
  const consent = signObject({ ...p.consent, ...change }, borrowerKey.secretKey)
  const { sig: _s, ...rest } = p
  return signObject({ ...rest, consent, check_request: { ...p.check_request, consent_hash: hashObject(consent) } }, borrowerKey.secretKey)
}

describe('lender-paid local scorer check: borrower and lender as separate key holders', () => {
  it('the borrower process holds only its key; the lender accepts a bill due at close; both verify the v2-bound result', async () => {
    const s = await setup()
    assert.deepEqual(s.offer.payer_modes, ['borrower', 'lender'])
    const served = serveOnce(s.node, s.hub)
    const stages: string[] = []
    const borrower = runBorrowerCheck({ transport: memoryTransport(s.hub), signer: keyPairSigner(borrowerKey), offer: s.offer, lenderPk: lenderKey.pubkey, negotiationId: NEG, bundle, dataCategories: categories, evidenceKeys: [], allowDevelopment: true, now: () => NOW, timeoutMs: 8000, onStage: (st) => stages.push(st) })
    const lender = (async () => lenderRun(s, await receiveBorrowerCheckPart(s.lenderBus, borrowerKey.pubkey, NEG, 4000)))()
    const [b, l] = await Promise.all([borrower, lender])
    assert.equal((await served).status, 'billed')
    assert.deepEqual(stages, ['part-sent', 'key-received', 'opened'])
    assert.ok(l.verification.ok, JSON.stringify(l.verification.ticks.filter((t) => !t.ok)))
    assert.ok(l.verification.ticks.some((t) => t.id === 'scorer:scored-loan' && t.ok))
    assert.ok(l.verification.ticks.some((t) => t.id === 'consent-payer-release' && t.ok))
    assert.ok(b.view.ok, JSON.stringify(b.view.ticks.filter((t) => !t.ok)))
    assert.equal(b.view.outputs?.v, 2)
    assert.equal(b.view.outputs?.recommendation, 'QUALIFY')
    assert.equal(b.view.outputs?.purpose_id, NEG, 'a digit-first negotiation id is assessed under its prefixed purpose')
    assert.equal(b.view.key_source, 'operator-billed')
    assert.equal(b.view.key_message_hash, checkMessageHash(l.key), 'the borrower names the KEY the lender forwarded in its application')
    assert.equal(b.view.outcome?.kind, 'passbook-signed', 'the opened outcome, for checking the term sheet\'s evidence digest')
    assert.equal(hashObject(b.view.outcome), hashObject(l.verification.outcome), 'the borrower opened exactly what the lender verified')
    // The browser-safe digest equals the one the lender's term sheet would carry (evidence-digest.ts re-exports it).
    assert.deepEqual(evidenceDigestCore(b.view.outcome!), evidenceDigest(l.verification.outcome!))
    for (const id of ['evidence:signature', 'evidence:binding', 'evidence:run-record-signature', 'evidence:scored-loan', 'request-is-this-part']) assert.ok(b.view.ticks.some((t) => t.id === id && t.ok), id)
    assert.equal(s.ledger.bills.length, 1, 'the lender received one close-time bill')
    assert.equal(b.part.consent.payer, 'lender')
    assert.equal(b.part.consent.release_hash, releaseHash(s.offer.release))
    assert.equal(b.part.consent.operator_pk, operator.pubkey)
    // The chain: the lender requests and approves (with the borrower's signature), the operator answers, the lender forwards K.
    const chain = [...(l.key.body as { chain: CheckMessage[] }).chain, l.key]
    assert.deepEqual(chain.map((m) => `${m.type}:${m.from_pk === lenderKey.pubkey ? 'lender' : m.from_pk === operator.pubkey ? 'operator' : '?'}`), ['REQUEST:lender', 'FEEDBACK:operator', 'RESULT:operator', 'KEY:lender'])
    // The lender never saw the bundle: everything it sent or received is NIP-44 between two parties, and its own copy is the sealed request.
    assert.ok(!JSON.stringify(l.key).includes(bundle.history[0].txid), 'the bundle is not in the forwarded chain')
  })

  it('consent naming another payer or operator, or the wrong release: refused before any request or payment', async () => {
    const s = await setup()
    for (const [change, code] of [[{ payer: 'borrower' }, 'CONSENT_OTHER_PAYER'], [{ operator_pk: keyPairFromLabel('other-operator').pubkey }, 'CONSENT_NAMES_ANOTHER_OPERATOR'], [{ release_hash: releaseHash({ ...s.offer.release, image_digest: 'sha256:' + 'ee'.repeat(32) }) }, 'CONSENT_OTHER_RELEASE']] as const) {
      const part = await partWithConsent(s.offer, change)
      assert.ok(borrowerCheckPartProblems(part, { lenderPk: lenderKey.pubkey, negotiationId: NEG, offer: s.offer, now: NOW }).includes(code), code)
      await assert.rejects(lenderRun(s, part), (e: Error) => e instanceof CheckRefused && e.reason.includes(code), code)
    }
    assert.equal(s.node.log.length, 0, 'the operator saw no request')
    assert.equal(s.ledger.bills.length, 0, 'nothing was billed')
    // The node refuses the same consents on its own, whoever sends them.
    for (const [change, code] of [[{ payer: 'borrower' }, 'CONSENT_OTHER_PAYER'], [{ release_hash: 'ab'.repeat(32) }, 'CONSENT_OTHER_RELEASE']] as const) {
      const part = await partWithConsent(s.offer, change)
      const body: RequestBody = { offer_hash: part.offer_hash, request_nonce: randomHex(32), consent: part.consent, check_request: part.check_request, rail: 'bill-at-close', pay_with: USDT, payer: 'lender' }
      const m = signObject({ v: 1 as const, domain: 'passbook-check-v1' as const, negotiation_id: NEG, seq: 0, type: 'REQUEST' as const, from_pk: lenderKey.pubkey, to_pk: operator.pubkey, prev_hash: null, body: body as unknown as Record<string, unknown> }, lenderKey.secretKey)
      assert.ok(s.node.requestProblems(m).includes(code), code)
    }
    // A consent for a borrower-paid check names payer borrower; the lender cannot reuse it.
    const own = await prepare(s.offer)
    assert.deepEqual(borrowerCheckPartProblems(own, { lenderPk: lenderKey.pubkey, negotiationId: NEG, offer: s.offer, now: NOW }), [])
    assert.ok(borrowerCheckPartProblems(own, { lenderPk: keyPairFromLabel('another-lender').pubkey, negotiationId: NEG, offer: s.offer, now: NOW }).includes('CONSENT_OTHER_LENDER'))
  })

  it('a v1 output for a scored loan: K reaches the borrower, and both refuse the result', async () => {
    const s = await setup({ outputs: (o) => { const { loan_request: _l, asset_id: _a, lender_requirements_hash: _h, ...v1 } = o; return { ...v1, v: 1 } } })
    const served = serveOnce(s.node, s.hub)
    const borrower = runBorrowerCheck({ transport: memoryTransport(s.hub), signer: keyPairSigner(borrowerKey), offer: s.offer, lenderPk: lenderKey.pubkey, negotiationId: NEG, bundle, dataCategories: categories, evidenceKeys: [], allowDevelopment: true, now: () => NOW, timeoutMs: 8000 })
    const lender = (async () => lenderRun(s, await receiveBorrowerCheckPart(s.lenderBus, borrowerKey.pubkey, NEG, 4000)))()
    const [b, l] = await Promise.all([borrower, lender])
    assert.equal((await served).status, 'billed')
    assert.equal(l.verification.ok, false)
    // Under scoring contract 1.3.0 a v1 artifact is outside the output schema; either way no scored loan is accepted.
    assert.ok(l.verification.ticks.some((t) => ['scorer:output-schema', 'scorer:scored-loan'].includes(t.id) && !t.ok), JSON.stringify(l.verification.ticks.filter((t) => !t.ok)))
    assert.equal(b.view.ok, false, 'the phone shows a failure screen, not a result')
    assert.ok(b.view.ticks.some(t=>!t.ok),'malformed outputs are refused')
  })

  it('outputs naming another loan or borrower are refused by both holders', async () => {
    for(const outputs of [(o: import('../src/scorer/types.js').PassbookCheckOutputs)=>({...o,borrower_pk:keyPairFromLabel('another-borrower').pubkey}),(o:import('../src/scorer/types.js').PassbookCheckOutputs)=>({...o,loan_request:{...o.loan_request!,principal:o.loan_request!.principal+1}})]) {
      const s=await setup({outputs}),served=serveOnce(s.node,s.hub)
      const [b,l]=await Promise.all([runBorrowerCheck({transport:memoryTransport(s.hub),signer:keyPairSigner(borrowerKey),offer:s.offer,lenderPk:lenderKey.pubkey,negotiationId:NEG,bundle,dataCategories:categories,evidenceKeys:[],now:()=>NOW,timeoutMs:8000}),(async()=>lenderRun(s,await receiveBorrowerCheckPart(s.lenderBus,borrowerKey.pubkey,NEG,4000)))()])
      await served;assert.equal(b.view.ok,false);assert.equal(l.verification.ok,false)
    }
  })

  it('a modified sealed result is rejected by both parties without an up-front payment', async () => {
    class TamperBus extends MemoryBus {
      private alteredFeedback: string | undefined
      override send(kind: number, payload: unknown, to: Hex, tags: string[][] = []) {
        const m = payload as CheckMessage
        if (m?.type === 'FEEDBACK' && (m.body as { status?: string }).status === 'billed') {
          const body = m.body as { sealed: { iv: string } }
          const changed = signObject({ ...m, body: { ...body, sealed: { ...body.sealed, iv: 'ff'.repeat(12) } } }, operator.secretKey)
          this.alteredFeedback = checkMessageHash(changed)
          payload = changed
        } else if (m?.type === 'RESULT' && this.alteredFeedback) payload = signObject({ ...m, prev_hash: this.alteredFeedback }, operator.secretKey)
        return super.send(kind, payload, to, tags)
      }
    }
    const s = await setup({}, (hub) => new TamperBus(hub, operator))
    const served = serveOnce(s.node, s.hub)
    const [b, l] = await Promise.all([
      runBorrowerCheck({ transport: memoryTransport(s.hub), signer: keyPairSigner(borrowerKey), offer: s.offer, lenderPk: lenderKey.pubkey, negotiationId: NEG, bundle, dataCategories: categories, evidenceKeys: [], allowDevelopment: true, now: () => NOW, timeoutMs: 8000 }),
      (async () => lenderRun(s, await receiveBorrowerCheckPart(s.lenderBus, borrowerKey.pubkey, NEG, 4000)))(),
    ])
    assert.equal((await served).status, 'billed')
    assert.equal(l.verification.ok, false)
    assert.equal(b.view.ok, false)
    assert.equal(b.view.outputs, null)
  })

  it('K not matching key_hash: the phone refuses a KEY whose K is not the committed key', async () => {
    const s = await setup()
    const served = serveOnce(s.node, s.hub)
    const part = await prepare(s.offer)
    const l = await lenderRun(s, part)
    await served
    const good = await openForwardedCheck({ key: l.key, part, bundle, offer: s.offer, evidenceKeys: [], allowDevelopment: true, now: NOW })
    assert.ok(good.ok, JSON.stringify(good.ticks.filter((t) => !t.ok)))
    // The same KEY, re-signed by the lender, with another K.
    const forged = signObject({ ...l.key, body: { ...l.key.body, key: freshKey() } }, lenderKey.secretKey)
    const bad = await openForwardedCheck({ key: forged, part, bundle, offer: s.offer, evidenceKeys: [], allowDevelopment: true, now: NOW })
    assert.equal(bad.ok, false)
    assert.match(bad.ticks.find((t) => t.id === 'commitment')!.detail, /KEY_DOES_NOT_MATCH_COMMITMENT/)
    assert.ok(bad.ticks.some((t) => t.id === 'key-binding' && !t.ok))
    assert.equal(bad.outputs, null, 'nothing is shown from an unopened result')
    // An explicit signer pin overrides the operator declaration.
    const strict = await openForwardedCheck({ key: l.key, part, bundle, offer: s.offer, evidenceKeys: [{public_key_hex:keyPairFromLabel('unpinned-signer').pubkey}], now: NOW })
    assert.ok(strict.ticks.some((t) => t.id === 'evidence:scorer-key' && !t.ok))
    // A KEY from anyone but the lender is not opened.
    const fromOther = signObject({ ...l.key, from_pk: operator.pubkey }, operator.secretKey)
    assert.equal((await openForwardedCheck({ key: fromOther, part, bundle, offer: s.offer, evidenceKeys: [], allowDevelopment: true, now: NOW })).ok, false)
  })
})

describe('the borrower half runs without Node', () => {
  it('borrower-check.ts and the term-sheet checks import no node: module and only browser-safe packages, transitively', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const allowed = [/^@noble\/curves\//, /^@noble\/hashes\//, /^@noble\/ciphers\/aes\.js$/, /^nostr-tools$/]
    const seen = new Set<string>()
    const bare = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      // Static value imports and re-exports only; `import type` and type-position import() are erased.
      for (const m of src.matchAll(/^(?:import|export)\s+(?!type\b)[^'";]*?from\s+'([^']+)'/gm)) {
        const spec = m[1]
        if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
        else bare.add(spec)
      }
    }
    // The borrower half, plus what the phone checks a lender's term sheet with.
    for (const entry of ['src/checknode/borrower-check.ts', 'src/scorer/evidence-digest-core.ts', 'src/scorer/bundle-terms.ts']) visit(join(root, entry))
    assert.ok(seen.size > 10)
    const offending = [...bare].filter((s) => !allowed.some((r) => r.test(s)))
    assert.deepEqual(offending, [], `not browser-safe: ${offending.join(', ')}`)
    assert.ok(![...seen].some((f) => /src\/scorer\/(providers|verify|contract|external|releases)\.ts$/.test(f)), 'no Node-only scorer module in the graph')
  })

  it('portable gunzip and AES-GCM open what the operator sealed with node:zlib and node:crypto', () => {
    for (const size of [0, 1, 100, 70_000, 250_000]) {
      const buf = randomBytes(size)
      assert.deepEqual(Buffer.from(gunzip(new Uint8Array(gzipSync(buf)), 1_000_000)), buf)
      const text = Buffer.from(JSON.stringify({ x: 'y'.repeat(size % 997), n: [...buf.subarray(0, 300)] }))
      assert.deepEqual(Buffer.from(gunzip(new Uint8Array(gzipSync(text, { level: 9 })))), text)
    }
    const s = {kind:'external-evidence',descriptor:{},evidence:{test:'portable encryption vector'},outputs:{},fallback:false} as unknown as import('../src/scorer/types.js').ScorerOutcome
    const plaintext: CheckPlaintext = { v: 1, kind: 'passbook-check-plaintext', negotiation_id: NEG, request_nonce: randomHex(32), consent_hash: randomHex(32), outcome: s }
    const k = freshKey()
    const sealed = seal(plaintext, k)
    // Node unseal and portable unseal agree byte for byte on a real local scorer outcome (DSSE envelope included), and both refuse a wrong K.
    assert.deepEqual(Buffer.from(unsealPortable(sealed, k)), Buffer.from(unseal(sealed, k)))
    assert.equal(sha256Hex(unsealPortable(sealed, k)), plaintextCommitment(plaintext))
    assert.throws(() => unsealPortable(sealed, freshKey()), /SEALED_WRONG_KEY_OR_TAMPERED/)
    assert.throws(() => unsealPortable({ ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + 'AAAA' }, k), /SEALED_WRONG_KEY_OR_TAMPERED/)
    assert.equal(keyHash(k).length, 64)
  })

})
