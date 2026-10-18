// The wallet panel over the user's own node (src/wallet/panel.ts, src/server/wallet-routes.ts):
// signed operator API only; seed encrypted at rest with a 3-word backup check;
// every send is previewed (decoded, "Can't be undone") and goes through the gate;
// no gate means no send; failures are recorded as failures, never as sent.
// The BTC and RGB wallets are fakes here; the regtest suite drives the real ones.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { FakeChain } from '../src/chain/fake.js'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { networkProfile } from '../src/core/network.js'
import { Store } from '../src/registry/store.js'
import { createApp, type App } from '../src/server/app.js'
import { authFromEnv, newDashboardSession, signRequest } from '../src/server/auth.js'
import { SeedVault, VAULT_FILE } from '../src/wallet/seed-vault.js'
import { InterimSendGate, intentHash, type SendGate } from '../src/wallet/send-gate.js'
import { WalletPanel, type BtcPort, type RgbPort } from '../src/wallet/panel.js'
import { signedHeaders } from '../web/session-auth.js'

const regtest = networkProfile('regtest', {}, {})
const ASSET = 'rgb:fake-asset-id-0000000000000000000000000000000000000000'
const OWN = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
const DEST = 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk'
const MAINNET = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

/** A real (unsigned-input) transaction hex paying `to`, so the panel's decode-and-compare runs for real. */
function txPaying(to: string, sats: number): string {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 7), 0)
  tx.addOutput(bitcoin.address.toOutputScript(to, bitcoin.networks.regtest), BigInt(sats))
  tx.addOutput(bitcoin.address.toOutputScript(OWN, bitcoin.networks.regtest), 1000n)
  return tx.toHex()
}

interface Calls { broadcast: string[]; rgbSend: unknown[] }
function fakes(calls: Calls, o: { balance?: number; signTo?: string; signFails?: string; broadcastFails?: string; rgbFails?: string } = {}) {
  const btc: BtcPort = {
    address: async () => OWN,
    balanceSats: async () => o.balance ?? 500_000,
    quote: async (_to, _sats) => ({ fee: 141 }),
    sign: async (to, sats) => { if (o.signFails) throw new Error(o.signFails); return txPaying(o.signTo ?? to, sats) },
    signedFee: async () => 141,
    broadcast: async (hex) => { if (o.broadcastFails) throw new Error(o.broadcastFails); calls.broadcast.push(hex); return { txid: bitcoin.Transaction.fromHex(hex).getId(), fee: 141 } },
    transfers: async () => [{ txid: 'aa'.repeat(32), height: 120, sats: 500_000, direction: 'in', fee: null, counterparty: null }],
    close: () => undefined,
  }
  const rgb: RgbPort = {
    address: () => 'bcrt1prgbvanilla',
    btcBalance: () => ({ vanilla: { settled: 9000, future: 9000, spendable: 9000 }, colored: { settled: 3000, future: 3000, spendable: 3000 } }),
    balance: () => ({ settled: 600_000_000, future: 600_000_000, spendable: 600_000_000 }),
    blindInvoice: (amount) => ({ invoice: `rgb:~/~/bcrt:utxob:blinded?amount=${amount}`, recipientId: 'bcrt:utxob:blinded', expirationTimestamp: 1 }),
    invoice: () => ({ invoice: 'rgb:witness', recipientId: 'bcrt:wvout:x', expirationTimestamp: 1 }),
    decodeInvoice: (inv) => {
      if (!inv.startsWith('rgb:')) throw new Error('invalid invoice')
      return { recipientId: inv.includes('wvout') ? 'bcrt:wvout:abc' : 'bcrt:utxob:abc', assetId: inv.includes('other') ? 'rgb:other' : undefined, network: inv.includes('signet') ? 'Signet' : 'Regtest', assignment: { type: 'Fungible', value: inv.includes('amount=5') ? 5_000_000 : 0 }, transportEndpoints: ['rpc://127.0.0.1:3230/json-rpc'] }
    },
    send: async (x) => { if (o.rgbFails) throw new Error(o.rgbFails); calls.rgbSend.push(x); return { txid: 'bb'.repeat(32) } },
    createUtxos: async () => 3,
    transfers: () => [{ idx: 1, kind: 'ReceiveWitness', status: 'Settled', txid: 'cc'.repeat(32), amount: 600_000_000, recipientId: null }],
    refresh: () => undefined,
    close: () => undefined,
  }
  return { btc, rgb }
}

describe('wallet panel', () => {
  const platformKey = keyPairFromLabel('platform')
  const session = newDashboardSession()
  let dir: string, app: App, base: string, panel: WalletPanel, calls: Calls, fake: ReturnType<typeof fakes>
  let gate: SendGate | undefined = new InterimSendGate()

  const call = async (method: string, path: string, body?: unknown, s: { id: string; secret: string } | null = session) => {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const headers = { ...(raw ? { 'content-type': 'application/json' } : {}), ...(s ? await signedHeaders(s, method, path, raw) : {}) }
    const res = await fetch(base + path, { method, headers, ...(raw ? { body: raw } : {}) })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }

  const boot = async (o: Parameters<typeof fakes>[1] = {}) => {
    await app?.close()
    calls = { broadcast: [], rgbSend: [] }
    fake = fakes(calls, o)
    panel = new WalletPanel({ profile: regtest, dir, gate, assetId: () => ASSET, openBtc: async () => fake.btc, openRgb: async () => fake.rgb, probe: async () => [] })
    app = createApp({ platformKey, store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth: authFromEnv(platformKey.pubkey, {}, [session]), wallet: panel })
    base = `http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`
  }

  before(() => { dir = mkdtempSync(join(tmpdir(), 'passbook-wallet-')) })
  after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
  beforeEach(async () => { gate = new InterimSendGate(); rmSync(dir, { recursive: true, force: true }); await boot() })

  it('serves the page and the network badge to anyone, and nothing else without the operator session', async () => {
    const page = await fetch(`${base}/wallet`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /mountWallet/)
    const net = await call('GET', '/wallet/api/network', undefined, null)
    assert.equal(net.status, 200)
    assert.deepEqual(net.body.network, { name: 'regtest', label: 'regtest', coin: 'regtest BTC', asset: 'test USDT (regtest)', public: false, explorer: null })
    for (const [m, p] of [['GET', '/wallet/api/status'], ['GET', '/wallet/api/balances'], ['POST', '/wallet/api/create'], ['POST', '/wallet/api/send/confirm']] as const) {
      assert.equal((await call(m, p, m === 'POST' ? {} : undefined, null)).status, 401, `${m} ${p} unsigned`)
    }
    // an agent's key is not the operator: 403
    const agent = keyPairFromLabel('borrower')
    const res = await fetch(`${base}/wallet/api/status`, { headers: signRequest(agent, 'GET', '/wallet/api/status', '') })
    assert.equal(res.status, 403)
    const about = await call('GET', '/wallet/api/about', undefined, null)
    assert.match(about.body.what, /YOUR OWN Passbook node/)
    assert.match(about.body.modules['@tetherto/wdk-wallet-btc'], /^1\.0\.0-beta\.17$/)
  })

  it('creates a seed encrypted at rest, shows the words once and needs 3 of them back before the first loan', async () => {
    assert.equal((await call('GET', '/wallet/api/status')).body.has_wallet, false)
    assert.equal((await call('POST', '/wallet/api/create', { passphrase: 'short' })).status, 400)
    const created = await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })
    assert.equal(created.status, 200)
    const words: string[] = created.body.words
    assert.equal(words.length, 12)
    const file = readFileSync(join(dir, VAULT_FILE), 'utf8')
    for (const w of words) assert.doesNotMatch(file, new RegExp(`\\b${w}\\b`), 'no word in the clear at rest')
    assert.equal((await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })).status, 409, 'never overwritten')
    // not ready to borrow until the backup is proven
    const notReady = await call('GET', '/wallet/api/ready-to-borrow')
    assert.equal(notReady.status, 400)
    assert.match(notReady.body.error, /prove your backup first/)
    // a wrong answer fails and uses up the challenge
    let ch = (await call('POST', '/wallet/api/backup/challenge')).body.positions as number[]
    assert.equal(new Set(ch).size, 3)
    const wrong = Object.fromEntries(ch.map((n) => [String(n), 'zoo']))
    assert.equal((await call('POST', '/wallet/api/backup/verify', { passphrase: 'correct horse', answers: wrong })).body.verified, false)
    assert.equal((await call('POST', '/wallet/api/backup/verify', { passphrase: 'correct horse', answers: wrong })).status, 400, 'one attempt per challenge')
    ch = (await call('POST', '/wallet/api/backup/challenge')).body.positions
    const right = Object.fromEntries(ch.map((n) => [String(n), ` ${words[n - 1].toUpperCase()} `]))
    assert.equal((await call('POST', '/wallet/api/backup/verify', { passphrase: 'wrong passphrase', answers: right })).status, 401)
    ch = (await call('POST', '/wallet/api/backup/challenge')).body.positions
    const right2 = Object.fromEntries(ch.map((n) => [String(n), words[n - 1]]))
    assert.equal((await call('POST', '/wallet/api/backup/verify', { passphrase: 'correct horse', answers: right2 })).body.verified, true)
    assert.equal((await call('GET', '/wallet/api/ready-to-borrow')).status, 200)
    // lock, wrong passphrase, unlock
    await call('POST', '/wallet/api/lock')
    assert.equal((await call('GET', '/wallet/api/balances')).status, 423)
    assert.equal((await call('POST', '/wallet/api/unlock', { passphrase: 'not it at all' })).status, 401)
    assert.equal((await call('POST', '/wallet/api/unlock', { passphrase: 'correct horse' })).body.unlocked, true)
  })

  it('restores from words into a new vault, counted as a proven backup; bad words are refused', async () => {
    const words = new SeedVault(join(dir, 'other'), 'regtest').create('another passphrase')
    assert.equal((await call('POST', '/wallet/api/restore', { words: 'abandon abandon abandon', passphrase: 'pass words!' })).status, 400)
    const restored = await call('POST', '/wallet/api/restore', { words: `  ${words.toUpperCase()}  `, passphrase: 'pass words!' })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.backup.verified, true)
    assert.equal(restored.body.backup.origin, 'restored')
    assert.equal(new SeedVault(dir, 'regtest').unlock('pass words!'), words)
    // a vault made for another network does not open here
    assert.throws(() => new SeedVault(dir, 'mutinynet').unlock('pass words!'), /made for regtest/)
  })

  it('labels every amount with the network; the dollar asset is never plain USDT', async () => {
    await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })
    const b = (await call('GET', '/wallet/api/balances')).body
    assert.equal(b.btc.label, '0.005 regtest BTC')
    assert.equal(b.usdt.label, '600.00 test USDT (regtest)')
    const h = (await call('GET', '/wallet/api/history')).body
    for (const r of h.rows) assert.match(r.label, /regtest BTC$|test USDT \(regtest\)$/)
    assert.deepEqual(h.credit_rows, [{ txid: 'cc'.repeat(32), height: 0, direction: 'in', amount: 600_000_000, counterparty_pk: '', memo: 'wallet panel (regtest)' }])
    const inv = (await call('POST', '/wallet/api/receive/rgb', { amount_micro: 5_000_000 })).body
    assert.match(inv.invoice, /utxob/, 'a blinded invoice')
    assert.equal((await call('GET', '/wallet/api/receive/btc')).body.address, OWN)
  })

  it('previews a BTC send decoded with "Can\'t be undone", then sends it through the gate', async () => {
    await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })
    const mainnet = await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: MAINNET, amount: 10_000 })
    assert.equal(mainnet.status, 400)
    assert.match(mainnet.body.error, /not a regtest address. Mainnet/)
    const tooMuch = await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 499_990 })
    assert.equal(tooMuch.status, 422)
    const p = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    assert.equal(p.irreversible, "Can't be undone")
    assert.equal(p.network, 'regtest')
    assert.deepEqual({ to: p.decoded.to, type: p.decoded.to_type, amount: p.decoded.amount_label, fee: p.decoded.fee_label, total: p.decoded.total_label }, { to: DEST, type: 'P2WPKH (native SegWit)', amount: '0.0001 regtest BTC', fee: '0.00000141 regtest BTC', total: '0.00010141 regtest BTC' })
    assert.equal(p.gate.adapter, true)
    assert.equal(calls.broadcast.length, 0, 'nothing signed or sent by a preview')
    // the person must confirm
    const unconfirmed = await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: false })
    assert.equal(unconfirmed.status, 403)
    assert.match(unconfirmed.body.error, /gate refused this send: confirmed: not confirmed/)
    assert.equal((await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: true })).status, 404, 'a preview is used once')
    const p2 = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    const sent = await call('POST', '/wallet/api/send/confirm', { preview_id: p2.id, confirm: true })
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.match(sent.body.txid, /^[0-9a-f]{64}$/)
    assert.equal(sent.body.explorer, null, 'no public explorer on regtest')
    assert.equal(sent.body.gate.intent_hash.length, 64)
    assert.equal(calls.broadcast.length, 1)
    const attempts = (await call('GET', '/wallet/api/history')).body.attempts
    assert.deepEqual(attempts.map((a: { status: string }) => a.status), ['sent', 'refused'])
  })

  it('refuses every send when the node has no gate', async () => {
    gate = undefined
    await boot()
    await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })
    const p = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    assert.equal(p.gate, null)
    const r = await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: true })
    assert.equal(r.status, 403)
    assert.match(r.body.error, /no send gate/)
    const rp = (await call('POST', '/wallet/api/send/preview', { kind: 'rgb', to: 'rgb:~/~/bcrt:utxob:abc', amount: 1_000_000 })).body
    assert.equal((await call('POST', '/wallet/api/send/confirm', { preview_id: rp.id, confirm: true })).status, 403)
    assert.equal((await call('POST', '/wallet/api/prepare-rgb', { confirm: true })).status, 403)
    assert.equal(calls.broadcast.length + calls.rgbSend.length, 0)
  })

  it('refuses a gate decision made for another send, and a send over the gate\'s cap', async () => {
    const real = new InterimSendGate({ regtest: { maxSats: 5_000, maxMicro: 1_000_000 } })
    gate = { name: 'swapping gate', adapter: false, decide: async (i) => ({ ...(await real.decide({ ...i, amount: 1 })), allow: true }) }
    await boot()
    await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })
    let p = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    let r = await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: true })
    assert.equal(r.status, 403)
    assert.match(r.body.error, /different send; nothing was signed/)
    gate = real
    await boot()
    await call('POST', '/wallet/api/unlock', { passphrase: 'correct horse' })
    p = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    r = await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: true })
    assert.equal(r.status, 403)
    assert.match(r.body.error, /amount: 10000 sats, cap 5000/)
    assert.equal(calls.broadcast.length, 0)
    assert.equal(intentHash({ action: 'wallet.send.btc', network: 'regtest', preview_id: 'x', preview_hash: 'ab'.repeat(32), amount: 1, unit: 'sats', to: DEST, fee_sats: 1, confirmed: true }).length, 64)
  })

  it('records failed sends as failed, with the reason, and never as sent', async () => {
    // the network refuses the broadcast
    await boot({ broadcastFails: 'bad-txns-inputs-missingorspent' })
    await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })
    let p = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    let r = await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: true })
    assert.equal(r.status, 502)
    assert.match(r.body.error, /did not accept it: bad-txns-inputs-missingorspent\. Check History before trying again/)
    // signing fails (coins moved since the preview)
    await boot({ signFails: 'Insufficient balance' })
    await call('POST', '/wallet/api/unlock', { passphrase: 'correct horse' })
    p = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    r = await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: true })
    assert.equal(r.status, 422)
    assert.match(r.body.error, /Not sent: Insufficient balance\. Nothing left your wallet/)
    // the signed transaction pays someone else: not broadcast
    await boot({ signTo: OWN })
    await call('POST', '/wallet/api/unlock', { passphrase: 'correct horse' })
    p = (await call('POST', '/wallet/api/send/preview', { kind: 'btc', to: DEST, amount: 10_000 })).body
    r = await call('POST', '/wallet/api/send/confirm', { preview_id: p.id, confirm: true })
    assert.equal(r.status, 409)
    assert.match(r.body.error, /differs from what you approved; it was not broadcast/)
    // an RGB send that rgb-lib refuses
    await boot({ rgbFails: 'InsufficientAllocationSlots' })
    await call('POST', '/wallet/api/unlock', { passphrase: 'correct horse' })
    const rp = (await call('POST', '/wallet/api/send/preview', { kind: 'rgb', to: 'rgb:~/~/bcrt:utxob:abc', amount: 1_000_000 })).body
    assert.equal(rp.decoded.amount_label, '1.00 test USDT (regtest)')
    assert.equal(rp.irreversible, "Can't be undone")
    r = await call('POST', '/wallet/api/send/confirm', { preview_id: rp.id, confirm: true })
    assert.equal(r.status, 422)
    assert.match(r.body.error, /Not sent: InsufficientAllocationSlots/)
    assert.equal(calls.broadcast.length + calls.rgbSend.length, 0)
    const attempts = (await call('GET', '/wallet/api/history')).body.attempts as { status: string; reason?: string }[]
    assert.deepEqual(attempts.map((a) => a.status), ['failed', 'refused', 'failed', 'unknown'])
    assert.ok(attempts.every((a) => a.reason), 'every failure keeps its reason')
  })

  it('checks an RGB invoice against the asset, the network and the amount it asks for', async () => {
    await call('POST', '/wallet/api/create', { passphrase: 'correct horse' })
    assert.match((await call('POST', '/wallet/api/send/preview', { kind: 'rgb', to: 'not an invoice', amount: 1 })).body.error, /not an RGB invoice/)
    assert.match((await call('POST', '/wallet/api/send/preview', { kind: 'rgb', to: 'rgb:other', amount: 1 })).body.error, /another asset/)
    assert.match((await call('POST', '/wallet/api/send/preview', { kind: 'rgb', to: 'rgb:signet', amount: 1 })).body.error, /for Signet, this wallet is on regtest/)
    assert.match((await call('POST', '/wallet/api/send/preview', { kind: 'rgb', to: 'rgb:amount=5', amount: 1_000_000 })).body.error, /asks for 5.00 test USDT \(regtest\), not 1.00/)
    const ok = await call('POST', '/wallet/api/send/preview', { kind: 'rgb', to: 'rgb:wvout:amount=5', amount: 5_000_000 })
    assert.equal(ok.status, 200)
    assert.match(ok.body.decoded.fee_label, /incl. 1,000 sats for the receiver's output/)
    const sent = await call('POST', '/wallet/api/send/confirm', { preview_id: ok.body.id, confirm: true })
    assert.equal(sent.status, 200)
    assert.deepEqual(calls.rgbSend, [{ invoice: 'rgb:wvout:amount=5', assetId: ASSET, amount: 5_000_000, feeRate: 1 }])
  })

  it('keeps answering with the platform API off: it is the user\'s own node', async () => {
    app.api.setPlatformOnline(false)
    assert.equal((await call('GET', '/state', undefined, null)).status, 503)
    assert.equal((await call('GET', '/wallet/api/network', undefined, null)).status, 200)
    assert.equal((await call('GET', '/wallet/api/status')).status, 200)
  })

  it('opens no wallet, and makes no seed, when an endpoint serves another chain', async () => {
    const p = new WalletPanel({ profile: regtest, dir: join(dir, 'probe'), gate, openBtc: async () => fake.btc, openRgb: async () => fake.rgb, probe: async () => { throw new Error('network profile refused: rgb_indexer serves testnet4') } })
    await assert.rejects(p.create('correct horse'), /rgb_indexer serves testnet4/)
    assert.equal(p.vault.exists(), false, 'no unseen words left behind')
  })
})
