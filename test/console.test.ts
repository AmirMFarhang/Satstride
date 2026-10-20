import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { FakeChain } from '../src/chain/fake.js'
import { keyPairFromLabel, randomHex, signObject, type KeyPair } from '../src/core/crypto.js'
import { NodeGovernance } from '../src/governance/node.js'
import { Store } from '../src/registry/store.js'
import { createApp, type App } from '../src/server/app.js'
import { newDashboardSession, requestDigest, sessionMac, signRequest } from '../src/server/auth.js'
import { csvField, negotiationState, usdtString } from '../src/server/console.js'
import type { FeeRecord } from '../src/server/fees.js'
import { partyKeyFromSeed } from '../src/wallet/signer.js'

const platformKey = keyPairFromLabel('console-platform')
const operator = keyPairFromLabel('console-operator')
const stranger = keyPairFromLabel('console-stranger')
const session = newDashboardSession()

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

describe('operator console (src/server/console.ts)', () => {
  let app: App, base: string, dir: string, wallets: string, lenderSeed: string
  let checkNode: Server
  let retiredPaymentRequests = 0
  const saved = { ...process.env }
  const paymentHash = randomHex(32)
  const negotiation = randomHex(32)

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'passbook-console-'))
    wallets = join(dir, 'wallets')
    // a governed lender node, as the lender peer leaves it: seed, policy, decision log
    lenderSeed = generateMnemonic(wordlist)
    mkdirSync(join(wallets, 'lender1'), { recursive: true })
    writeFileSync(join(wallets, 'lender1', 'seed'), `${lenderSeed}\n`)
    new NodeGovernance({ ownerKey: partyKeyFromSeed(lenderSeed), dir: join(wallets, 'lender1', 'governance') })
    // the check node's public /status
    checkNode = createServer((req, res) => {
      if (req.url !== '/status') retiredPaymentRequests++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'provider', operator_pk: operator.pubkey, scorer_label: 'Local in-process scorer (test)', release: { provider: 'in-process', image_digest: `sha256:${'a'.repeat(64)}`, scoring_contract_hash: 'b'.repeat(64), model_hash: null }, release_hash: 'c'.repeat(64), execution: { label: 'software evidence' }, price: { asset: 'rgb:test-usdt', amount: 500_000 }, payer_modes: ['lender'],
        log: [{ negotiation_id: negotiation, status: 'billed', bill_hash: paymentHash, rail: 'bill-at-close', at: 1_760_760_010_000 }, { negotiation_id: randomHex(32), status: 'refused', reason: 'CONSENT', at: 1_760_760_020_000 }] }))
    })
    const checkPort = await listen(checkNode)
    const lenderPk = partyKeyFromSeed(lenderSeed).pubkey
    writeFileSync(join(dir, 'provider.json'), JSON.stringify({ project: 'passbook-console-test', asset: { asset_id: 'rgb:test-usdt', ticker: 'USDT', note: 'regtest test USDT stand-in, not real USDT' }, lenders: [{ name: 'lender1', pubkey: lenderPk, status: 'running' }], check_nodes: [{ name: 'provider', operator_pk: operator.pubkey, status_url: `http://127.0.0.1:${checkPort}/status`, release_hash: 'c'.repeat(64), payer_modes: ['lender'], scorer_label: 'Local in-process scorer (test)', status: 'running' }] }))
    Object.assign(process.env, { PASSBOOK_SP_STATE: dir, PASSBOOK_WALLETS: wallets, PASSBOOK_SP_RLN_CHECK_URL: `http://127.0.0.1:${checkPort}` })
    const store = new Store()
    app = createApp({ platformKey, store, chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth: { mode: 'enforce', operators: [platformKey.pubkey, operator.pubkey], localConsole: false, sessions: [session] } })
    const now = Date.now()
    const fee = (loan_id: string, status: FeeRecord['status'], amount: number): FeeRecord => ({ loan_id, lender_pk: lenderPk, asset_id: 'rgb:test-usdt', outcome: 'repaid_on_time', interest: amount * 10, share_bps: 1000, amount, status, invoice: null, recipient_id: null, closed_height: 90, grace_until_height: 190, created_at: now, updated_at: now, ...(status === 'fee_paid' ? { paid_txid: 'e'.repeat(64), paid_height: 95 } : {}) })
    store.insertFee({ ...fee('a'.repeat(64), 'fee_paid', 1_340_000), share_amount: 840_000, check_fees: [{ bill_hash: paymentHash, negotiation_id: negotiation, operator_pk: operator.pubkey, asset_id: 'rgb:test-usdt', amount: 500_000 }] } as FeeRecord)
    store.insertFee({ ...fee('=cmd|'.padEnd(64, 'f'), 'fee_due', 320_000), share_amount: 120_000, check_fees: [{ bill_hash: 'f'.repeat(64), negotiation_id: 'd'.repeat(64), operator_pk: operator.pubkey, asset_id: 'rgb:test-usdt', amount: 200_000 }] } as FeeRecord)
    base = `http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`
  })

  after(async () => {
    await app.close()
    checkNode.close()
    assert.equal(retiredPaymentRequests, 0, 'a stale payment-node URL is never contacted')
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async (path: string, key?: KeyPair) => {
    const res = await fetch(base + path, { headers: key ? signRequest(key, 'GET', path) : {} })
    return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
  }
  const json = async (path: string) => { const r = await get(path, operator); assert.equal(r.status, 200, r.text); return JSON.parse(r.text) }
  const post = async (path: string, body: unknown, key: KeyPair = operator) => {
    const raw = JSON.stringify(body)
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(key, 'POST', path, raw) }, body: raw })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }

  it('answers only the operator: unsigned 401, another key 403, the operator key and the dashboard session 200', async () => {
    for (const path of ['/console/api/overview', '/console/api/revenue', '/console/api/revenue.csv', '/console/api/market', '/console/api/security', '/console/api/feed', '/console/api/workflows', '/console/api/redteam']) {
      assert.equal((await get(path)).status, 401, path)
      assert.equal((await get(path, stranger)).status, 403, path)
      assert.equal((await get(path, operator)).status, 200, path)
    }
    const ts = Date.now(), nonce = randomHex(12), path = '/console/api/overview'
    const res = await fetch(base + path, { headers: { 'x-passbook-session': session.id, 'x-passbook-ts': String(ts), 'x-passbook-nonce': nonce, 'x-passbook-hmac': sessionMac(session.secret, requestDigest('GET', path, ts, nonce, '')) } })
    assert.equal(res.status, 200)
    assert.equal((await post('/console/api/kill-switch', { node: 'all', confirm: 'STOP' }, stranger)).status, 403)
  })

  it('overview names the network, the provider, its nodes and the counters, from real sources only', async () => {
    const o = await json('/console/api/overview')
    assert.equal(o.network.name, 'regtest')
    assert.equal(o.network.test_coins_only, true)
    assert.equal(o.project, 'passbook-console-test')
    assert.equal(o.platform.pubkey, platformKey.pubkey)
    assert.equal(o.platform.api_auth, 'enforce')
    assert.equal(o.check_nodes[0].status, 'running')
    assert.equal(o.scorer.status, 'answering', 'status comes from the actual check-node response')
    assert.equal(o.scorer.provider, 'in-process')
    assert.equal(o.assistant.status, 'not-running')
    assert.equal(o.counters.platform_fees_earned, 840_000)
    assert.equal(o.counters.check_fees_earned, 500_000)
  })

  it('workflow notes are operator-only and omit private evidence while retaining the reported stage', async () => {
    const note = signObject({ actor_pk: operator.pubkey, role: 'lender', title: 'Term sheet approved and sent', detail: { private_bundle: 'must not leave the note', approval: { sig: 'private approval' } } }, operator.secretKey)
    assert.equal((await post('/wire', note)).status, 200)
    const w = await json('/console/api/workflows')
    const reported = w.notes.find((n: { from: string }) => n.from === operator.pubkey)
    assert.equal(reported.label, 'Term sheet approved and sent')
    assert.equal(reported.detail, 'lender')
    assert.equal(reported.source, 'platform')
    assert.equal(typeof reported.at, 'number')
    assert.doesNotMatch(JSON.stringify(w), /private_bundle|private approval|must not leave/)
    assert.deepEqual(Object.keys(reported).sort(), ['at', 'detail', 'from', 'id', 'kind', 'label', 'source', 'to'])
  })

  it('revenue splits paid close-time check bills from the platform share, never counting a due fee as earned', async () => {
    const r = await json('/console/api/revenue')
    assert.equal(r.totals.platform_fees.earned, 840_000)
    assert.equal(r.totals.platform_fees.due, 120_000)
    assert.equal(r.totals.check_fees.earned, 500_000)
    assert.equal(r.totals.check_fees.settled_count, 1)
    assert.equal(r.totals.check_fees.pending, 1, 'a due bill is pending, not earned')
    assert.equal(r.totals.all_earned, 1_340_000)
    const settled = r.check_fees.find((c: { status: string }) => c.status === 'settled')
    assert.equal(settled.negotiation_id, negotiation, 'the durable bill is joined to its negotiation without a payment node')
    assert.ok(r.check_fees.some((c: { status: string; amount: number }) => c.status === 'refused' && c.amount === 0))
    assert.ok(r.series.length >= 1)
    const csv = await get('/console/api/revenue.csv', operator)
    assert.match(csv.type ?? '', /text\/csv/)
    const lines = csv.text.trim().split('\n')
    assert.equal(lines[0], 'stream,id,counterparty,status,amount_micro,amount_test_usdt,asset_id,reference,at_iso,network')
    assert.ok(lines.some((l) => l.startsWith('platform_fee_share,') && l.includes(',840000,0.84,')))
    assert.ok(lines.some((l) => l.startsWith("platform_fee_share,'=cmd|")), 'a formula-looking id is neutralised')
    assert.ok(lines.some((l) => l.startsWith('check_fee,') && l.includes(',500000,0.5,')))
    assert.ok(lines.every((l, i) => i === 0 || l.endsWith(',regtest')))
  })

  it('security shows the auth mode, the gate, each node\'s policy and a verified decision log, and catches a tampered log', async () => {
    const s = await json('/console/api/security')
    assert.equal(s.api_auth.mode, 'enforce')
    assert.equal(s.api_auth.enforced, true)
    assert.equal(s.signing_gate.enforced, true)
    const lender = s.nodes.find((n: { role: string }) => n.role === 'lender1')
    assert.equal(lender.policy.version, 1)
    assert.equal(lender.policy.quorum.threshold, 1)
    assert.equal(lender.kill_switch.stopped, false)
    assert.equal(lender.log.verified, true)
    assert.equal(lender.log.anchor, 'gate key derived from the node key')
    assert.equal(s.scorer.provider, 'in-process')
    assert.equal(s.scorer.trust_ceiling, 'dev-inprocess')
    assert.match(s.scorer.verification, /local host/)
    // alter one entry's result: the chain breaks at that entry
    const file = join(wallets, 'lender1', 'governance', 'decision-log.jsonl')
    const original = readFileSync(file, 'utf8')
    const lines = original.trim().split('\n')
    const first = JSON.parse(lines[0]); first.result = 'forged'
    writeFileSync(file, [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n')
    const broken = (await json('/console/api/security')).nodes.find((n: { role: string }) => n.role === 'lender1')
    assert.equal(broken.log.verified, false)
    assert.match(broken.log.problems.join(), /altered/)
    writeFileSync(file, original)
  })

  it('the red-team self-test: every known-bad request is refused, each by the code that refuses it', async () => {
    const { probes } = await json('/console/api/redteam')
    assert.deepEqual(probes.map((p: { id: string }) => p.id), ['unsigned-write', 'wrong-party', 'replayed-request', 'tampered-termsheet', 'replayed-negotiation', 'mismatched-binding', 'ungated-signature'])
    const run = async (id: string) => { const r = await post(`/console/api/redteam/${id}`, {}); assert.equal(r.status, 200); return r.body }
    const unsigned = await run('unsigned-write')
    assert.deepEqual([unsigned.status, unsigned.pass, unsigned.refused_by.file], [401, true, 'src/server/auth.ts'])
    const wrong = await run('wrong-party')
    assert.deepEqual([wrong.status, wrong.pass], [403, true])
    assert.match(wrong.reason, /borrower or lender/)
    const replay = await run('replayed-request')
    assert.deepEqual([replay.status, replay.pass, replay.control.ok], [401, true, true])
    assert.match(replay.reason, /replayed/)
    const neg = await run('replayed-negotiation')
    assert.equal(neg.pass, true)
    assert.equal(neg.control.ok, true, neg.control.detail)
    assert.match(neg.reason, /wrong sequence|broken hash chain/)
    assert.equal(neg.refused_by.file, 'src/market/negotiate-engine.ts')
    const binding = await run('mismatched-binding')
    assert.equal(binding.pass, true)
    assert.match(binding.reason, /scored principal/)
    const gate = await run('ungated-signature')
    assert.equal(gate.pass, true)
    assert.match(gate.reason, /NO_GATE_TOKEN/)
    const tampered = await run('tampered-termsheet')
    assert.deepEqual([tampered.skipped, tampered.pass], [true, false], 'without a registered loan there is nothing to tamper with: skipped, never a pass')
    assert.equal((await post('/console/api/redteam/nope', {})).status, 404)
    // each probe left a labelled event on the feed
    const feed = await json('/console/api/feed?after=0')
    assert.ok(feed.items.some((i: { source: string; label: string }) => i.source === 'platform' && /Red-team probe: Unsigned write/.test(i.label)))
    assert.ok(feed.items.some((i: { source: string; label: string }) => i.source === 'decision-log' && i.label.startsWith('lender1')))
  })

  it('the kill switch needs the typed confirmation, then stops the node through passbook agent stop', async () => {
    assert.equal((await post('/console/api/kill-switch', { node: 'lender1' })).status, 400)
    assert.equal((await post('/console/api/kill-switch', { node: 'nobody', confirm: 'STOP' })).status, 404)
    assert.equal((await json('/console/api/security')).nodes[0].kill_switch.stopped, false, 'nothing happened without the confirmation')
    const r = await post('/console/api/kill-switch', { node: 'lender1', confirm: 'STOP', reason: 'test' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.match(r.body.lines.join(), /node lender1: stopped \*/)
    const lender = (await json('/console/api/security')).nodes.find((n: { role: string }) => n.role === 'lender1')
    assert.equal(lender.kill_switch.stopped, true)
    assert.equal(lender.log.verified, true, 'the kill-switch entry extends the chain')
    assert.ok((await json('/console/api/market')).agenda.some((a: { kind: string }) => a.kind === 'agent-stopped'))
    // the live platform runs on in-memory governance here (a fixed key, no seeded platform dir): it is shown and stopped at its own gate
    const live = (await json('/console/api/security')).nodes.find((n: { role: string }) => n.role === 'platform')
    assert.deepEqual([live.kind, live.kill_switch.stopped, live.log.verified], ['platform (live gate, in-memory governance)', false, true])
    const all = await post('/console/api/kill-switch', { node: 'all', confirm: 'STOP', reason: 'test all' })
    assert.equal(all.status, 200, JSON.stringify(all.body))
    assert.match(all.body.lines.join(), /platform \(live gate, in-memory governance\): stopped \*/, '"all" reaches the live platform, not only disk nodes')
    const after = (await json('/console/api/security')).nodes.find((n: { role: string }) => n.role === 'platform')
    assert.equal(after.kill_switch.stopped, true)
    assert.equal(after.log.verified, true, 'the kill-switch entry extends the live gate\'s chain')
    const again = await post('/console/api/kill-switch', { node: 'platform', confirm: 'STOP' })
    assert.deepEqual([again.status, again.body.lines], [200, ['platform (live gate, in-memory governance): already stopped.']])
  })

  it("the copilot is D2's module: labelled template answers from this node's records, its own decision log cited, operator actions refused", async () => {
    const earn = await post('/console/api/copilot', { question: 'What did we earn?', screen: 'revenue' })
    assert.equal(earn.status, 200)
    assert.deepEqual([earn.body.source, earn.body.label, earn.body.fallback_reason, earn.body.refused], ['template', 'template', 'NO_MODEL', null], 'no PASSBOOK_ASSIST_AI: a labelled template, never a silent model')
    assert.match(earn.body.text, /1\.34 test USDT/, 'the service revenue: the fee share plus the settled check fees')
    assert.deepEqual(earn.body.intent, { go: 'revenue' })
    const act = await post('/console/api/copilot', { question: 'stop the agent now' })
    assert.equal(act.body.refused, 'OPERATOR_ACTION')
    const { suggestions } = await json('/console/api/copilot')
    const why = suggestions.find((q: string) => /^Why was /.test(q))
    assert.ok(why, 'the first suggestion names the lender\'s latest gate decision')
    const answer = await post('/console/api/copilot', { question: why })
    assert.ok(answer.body.cites.length > 0, 'cites decision-log entries')
    assert.ok(answer.body.why.length > 0, 'whyLines verbatim')
    assert.equal(answer.body.intent.go, 'decision')
    assert.equal((await post('/console/api/copilot', { question: '' })).status, 400)
  })

  it('serves its own files from a fixed list and nothing else', async () => {
    const page = await get('/console/')
    assert.equal(page.status, 200)
    assert.match(page.type ?? '', /text\/html/)
    assert.equal((await get('/console/js/..%2F..%2Fpackage.json')).status, 404)
    assert.equal((await get('/console/package.json')).status, 404)
  })

  it('apps/console/server.mjs serves its fixed files and proxies the signed API unchanged', async () => {
    const free = createServer(); const port = await listen(free); await new Promise((r) => free.close(r))
    const child = spawn(process.execPath, ['apps/console/server.mjs', '--port', String(port), '--platform', base], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.on('data', (d) => { if (String(d).includes('operator console')) resolve() }); child.on('exit', (c) => reject(new Error(`server.mjs exited ${c}`))) })
      const at = `http://127.0.0.1:${port}`
      assert.equal((await fetch(`${at}/`)).status, 200)
      assert.equal((await fetch(`${at}/server.mjs`)).status, 404)
      assert.equal((await fetch(`${at}/js/..%2F..%2F..%2Fpackage.json`)).status, 404)
      assert.equal((await fetch(`${at}/console/api/overview`)).status, 401, 'the proxy adds no credentials')
      const path = '/console/api/overview'
      const res = await fetch(at + path, { headers: signRequest(operator, 'GET', path) })
      assert.equal(res.status, 200, 'the signature over method, path and query survives the proxy')
      assert.equal((await res.json() as { network: { name: string } }).network.name, 'regtest')
    } finally { child.kill() }
  })

  it('consolidates provider-owned lender revenue without counting internal fee transfers twice', async () => {
    const now = Date.now()
    const lenderPk = partyKeyFromSeed(lenderSeed).pubkey
    for (const [id, status, interest] of [['a'.repeat(64), 'repaid', 8_400_000], ['b'.repeat(64), 'defaulted', 2_000_000], ['c'.repeat(64), 'liquidated', 3_000_000]] as const) {
      app.store.insertLoan({ id, status, terms: { v: 1, borrower_pk: stranger.pubkey, lender_pk: lenderPk, platform_pk: platformKey.pubkey, asset_id: 'rgb:test-usdt', principal: 600_000_000, fee: interest, collateral_sats: 100_000, oracle_quote: { price_cents: 10_000_000, height: 1, oracle_pk: platformKey.pubkey, sig: '0'.repeat(128) }, open_height: 1, maturity_height: 31, grace_blocks: 5, recovery_height: 100, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex(32) }, created_at: now, updated_at: now })
    }
    const r = await json('/console/api/revenue')
    assert.equal(r.totals.lender_interest.count, 3)
    assert.equal(r.totals.lender_interest.earned, 13_400_000 - 1_340_000)
    assert.equal(r.totals.all_earned, 13_400_000, 'platform and check transfers within this provider add no extra revenue')
  })

  it('helpers', () => {
    assert.equal(csvField('a,b'), '"a,b"')
    assert.equal(csvField('=1+1'), "'=1+1")
    assert.equal(csvField(null), '')
    assert.equal(usdtString(500_000), '0.5')
    assert.equal(usdtString(8_400_000), '8.4')
    assert.equal(usdtString(1), '0.000001')
    assert.equal(negotiationState([7490]), 'asked')
    assert.equal(negotiationState([7490, 7491, 7492]), 'negotiating')
    assert.equal(negotiationState([7490, 7491, 7493]), 'agreed')
    assert.equal(negotiationState([7490, 7494]), 'no-deal')
    assert.equal(negotiationState([7490, 7491, 7493, 7495]), 'term-sheet')
  })

  it('retains workflow observations when the mixed newest-200 feed is crowded', async () => {
    const note = signObject({ actor_pk: operator.pubkey, role: 'lender', title: 'Term sheet approved and sent' }, operator.secretKey)
    assert.equal((await post('/wire', note)).status, 200)
    const reported = (await json('/console/api/workflows')).notes.at(-1)
    for (let i = 0; i < 240; i++) app.api.emit({ type: 'console-transport-test', at: reported.at + 1 })
    const mixed = await json('/console/api/feed')
    assert.ok(!mixed.items.some((item: { id: string }) => item.id === reported.id))
    assert.ok((await json('/console/api/workflows')).notes.some((item: { id: string }) => item.id === reported.id))
  })
})

describe('operator console revenue matches the ledger exactly', () => {
  let app: App, base: string, dir: string
  const saved = { ...process.env }
  const lender = keyPairFromLabel('console-provider-lender')
  const external = keyPairFromLabel('console-external-lender')
  const borrower = keyPairFromLabel('console-borrower')

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'passbook-console-ledger-'))
    writeFileSync(join(dir, 'provider.json'), JSON.stringify({ project: 'ledger', asset: { asset_id: 'rgb:test-usdt', ticker: 'USDT', note: 'test' }, lenders: [{ name: 'lender1', pubkey: lender.pubkey, status: 'running' }] }))
    Object.assign(process.env, { PASSBOOK_SP_STATE: dir, PASSBOOK_WALLETS: join(dir, 'wallets') })
    const store = new Store()
    app = createApp({ platformKey, store, chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth: { mode: 'enforce', operators: [platformKey.pubkey, operator.pubkey], localConsole: false, sessions: [session] } })
    const now = Date.now()
    const loan = (id: string, lenderPk: string, status: string, fee: number) => store.insertLoan({ id, status, terms: { v: 1, borrower_pk: borrower.pubkey, lender_pk: lenderPk, platform_pk: platformKey.pubkey, asset_id: 'rgb:test-usdt', principal: 100_000_000, fee, collateral_sats: 200_000, open_height: 10, maturity_height: 40, grace_blocks: 6, recovery_height: 60, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: id }, created_at: now, updated_at: now } as never)
    const fee = (loan_id: string, lender_pk: string, status: FeeRecord['status'], amount: number, extra: object = {}) => store.insertFee({ loan_id, lender_pk, asset_id: 'rgb:test-usdt', outcome: 'repaid_on_time', interest: 0, share_bps: 1500, amount, status, invoice: null, recipient_id: null, closed_height: 50, grace_until_height: 150, created_at: now, updated_at: now, ...(status === 'fee_paid' ? { paid_txid: 'e'.repeat(64), paid_height: 51 } : {}), ...extra } as FeeRecord)
    // the provider's own lender: repaid (paid its share and a credit check billed at close), defaulted (paid), liquidated (fee still due), and an open loan
    loan('a'.repeat(64), lender.pubkey, 'repaid', 6_000_000); fee('a'.repeat(64), lender.pubkey, 'fee_paid', 1_100_000, { share_amount: 900_000, check_fees: [{ bill_hash: '1'.repeat(64), negotiation_id: '2'.repeat(64), operator_pk: operator.pubkey, asset_id: 'rgb:test-usdt', amount: 200_000 }] })
    loan('b'.repeat(64), lender.pubkey, 'defaulted', 3_000_000); fee('b'.repeat(64), lender.pubkey, 'fee_paid', 450_000)
    loan('c'.repeat(64), lender.pubkey, 'liquidated', 2_000_000); fee('c'.repeat(64), lender.pubkey, 'fee_due', 300_000)
    loan('d'.repeat(64), lender.pubkey, 'open', 4_000_000)
    // an external lender's loan: only its paid platform share is the provider's revenue
    loan('e'.repeat(64), external.pubkey, 'repaid', 10_000_000); fee('e'.repeat(64), external.pubkey, 'fee_paid', 1_500_000)
    base = `http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`
  })

  after(async () => {
    await app.close()
    process.env = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('counts interest from defaulted and liquidated loans, nets a provider lender\'s paid fees, and adds up to gross interest plus external fees', async () => {
    const res = await fetch(`${base}/console/api/revenue`, { headers: signRequest(operator, 'GET', '/console/api/revenue') })
    assert.equal(res.status, 200)
    const r = await res.json() as { totals: Record<string, Record<string, number>> & { all_earned: number }; lender_interest: { loan_id: string; interest: number; status: string }[] }
    const interest = Object.fromEntries(r.lender_interest.map((x) => [x.loan_id[0], [x.status, x.interest]]))
    assert.deepEqual(interest, {
      a: ['repaid', 6_000_000 - 1_100_000], // net of the share and the check fee it paid to the provider's own platform and check node
      b: ['defaulted', 3_000_000 - 450_000], // a default's split pays the full debt, interest included
      c: ['liquidated', 2_000_000], // its fee is still due: nothing paid yet, nothing netted
    }, 'the open loan earns nothing yet; the external lender\'s interest is not the provider\'s')
    assert.equal(r.totals.platform_fees.earned, 900_000 + 450_000 + 1_500_000)
    assert.equal(r.totals.platform_fees.due, 300_000)
    assert.equal(r.totals.check_fees.earned, 200_000)
    assert.equal(r.totals.lender_interest.earned, 4_900_000 + 2_550_000 + 2_000_000)
    // consolidated: every internal payment (the provider lender's share and check fee) appears once
    const grossProviderInterest = 6_000_000 + 3_000_000 + 2_000_000
    assert.equal(r.totals.all_earned, grossProviderInterest + 1_500_000)
  })
})

