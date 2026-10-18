// The wallet panel with its real wallets on regtest: WDK BTC (@tetherto/wdk-wallet-btc
// over electrs) and the RGB wallet (rgb-lib), behind the signed API, through the gate.
// The live probe checks bitcoind, electrs and the proxy first. Needs `infra/regtest.sh start`.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Regtest } from '../../src/chain/regtest.js'
import { keyPairFromLabel } from '../../src/core/crypto.js'
import { networkProfile } from '../../src/core/network.js'
import { RgbWallet } from '../../src/rgb/wallet.js'
import { Store } from '../../src/registry/store.js'
import { createApp, type App } from '../../src/server/app.js'
import { authFromEnv, newDashboardSession } from '../../src/server/auth.js'
import { newSeedPhrase } from '../../src/wallet/party.js'
import { WalletPanel } from '../../src/wallet/panel.js'
import { InterimSendGate } from '../../src/wallet/send-gate.js'
import { signedHeaders } from '../../web/session-auth.js'

describe('wallet panel on regtest (real WDK BTC and RGB wallets)', () => {
  const regtest = new Regtest()
  const session = newDashboardSession()
  const profile = networkProfile('regtest')
  let dir: string, app: App, base: string, issuer: RgbWallet, assetId: string | undefined

  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const res = await fetch(base + path, { method, headers: { ...(raw ? { 'content-type': 'application/json' } : {}), ...(await signedHeaders(session, method, path, raw)) }, ...(raw ? { body: raw } : {}) })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body)
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`)
    return r.body
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'passbook-wallet-live-'))
    await regtest.ensureMiner()
    const panel = new WalletPanel({ profile, dir: join(dir, 'panel'), gate: new InterimSendGate({ regtest: { maxSats: 2_000_000, maxMicro: 100_000_000 } }), assetId: () => assetId })
    app = createApp({ platformKey: keyPairFromLabel('platform'), store: new Store(), chain: regtest.chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth: authFromEnv(keyPairFromLabel('platform').pubkey, {}, [session]), wallet: panel })
    base = `http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`
    // an issuer with its own seed: the test USDT the panel receives
    issuer = await RgbWallet.open(newSeedPhrase(), join(dir, 'issuer'), { network: 'regtest', indexerUrl: profile.endpoints.rgb_indexer, transportEndpoint: profile.endpoints.rgb_proxy })
    await regtest.fund(issuer.address(), 0.01)
    issuer.refresh()
    await issuer.createUtxos(4, 5000)
    await regtest.mine(1)
    issuer.refresh()
    assetId = issuer.issueNia({ ticker: 'TUSDT', name: 'Passbook test USDT (regtest, no value)', precision: 6, amount: 1_000_000_000 })
  })

  after(async () => {
    issuer?.close()
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a wallet after probing every endpoint, receives and sends regtest BTC through the gate', async () => {
    const created = await ok('POST', '/wallet/api/create', { passphrase: 'regtest passphrase' })
    assert.equal(created.words.length, 12)
    const status = await ok('GET', '/wallet/api/status')
    assert.deepEqual(status.endpoints_checked.map((r: { endpoint: string; ok: boolean }) => [r.endpoint, r.ok]), [['bitcoin_rpc', true], ['rgb_indexer', true], ['rgb_proxy', true]])
    const { address } = await ok('GET', '/wallet/api/receive/btc')
    assert.match(address, /^bcrt1q/, 'BIP-84 native SegWit from WDK')
    await regtest.fund(address, 0.01)
    let b = await ok('GET', '/wallet/api/balances')
    for (let i = 0; i < 10 && b.btc.sats !== 1_000_000; i++) { await new Promise((r) => setTimeout(r, 1000)); b = await ok('GET', '/wallet/api/balances') }
    assert.equal(b.btc.label, '0.01 regtest BTC')

    const dest = await regtest.chain.rpc<string>('getnewaddress', [], 'miner')
    const preview = await ok('POST', '/wallet/api/send/preview', { kind: 'btc', to: dest, amount: 250_000 })
    assert.equal(preview.irreversible, "Can't be undone")
    assert.equal(preview.decoded.amount_label, '0.0025 regtest BTC')
    assert.ok(preview.decoded.fee_sats > 0 && preview.decoded.fee_sats < 2000, `fee ${preview.decoded.fee_sats}`)
    const sent = await ok('POST', '/wallet/api/send/confirm', { preview_id: preview.id, confirm: true })
    await regtest.mine(1)
    const tx = await regtest.chain.getTx(sent.txid)
    assert.ok(tx?.height, 'confirmed')
    const destScript = (await regtest.chain.rpc<{ scriptPubKey: string }>('getaddressinfo', [dest], 'miner')).scriptPubKey
    assert.ok(tx!.outputs.some((o) => o.script === destScript && o.value === 250_000), 'paid exactly what the preview showed')

    // over the gate's cap: refused, nothing broadcast, recorded as refused
    const big = await ok('POST', '/wallet/api/send/preview', { kind: 'btc', to: dest, amount: 600_000 })
    const gate = (await ok('GET', '/wallet/api/status')).gate
    assert.equal(gate.adapter, true)
    const p2 = await call('POST', '/wallet/api/send/confirm', { preview_id: big.id, confirm: false })
    assert.equal(p2.status, 403)
    const h = await ok('GET', '/wallet/api/history')
    assert.deepEqual(h.attempts.map((a: { status: string }) => a.status), ['refused', 'sent'])
    assert.ok(h.rows.some((r: { layer: string; direction: string; amount: number }) => r.layer === 'btc' && r.direction === 'in' && r.amount === 1_000_000))
  })

  it('receives test USDT on a blinded invoice and pays it back over RGB, labelled test USDT (regtest)', async () => {
    // the panel's RGB wallet needs its own bitcoin for colored outputs
    const before = await call('POST', '/wallet/api/receive/rgb', { amount_micro: 25_000_000 })
    assert.equal(before.status, 409, 'no colored output yet: says so instead of guessing')
    await regtest.fund(before.body.detail.rgb_btc_address, 0.001)
    await ok('POST', '/wallet/api/prepare-rgb', { confirm: true })
    await regtest.mine(1)
    const inv = await ok('POST', '/wallet/api/receive/rgb', { amount_micro: 25_000_000 })
    assert.equal(inv.kind, 'blinded')
    const paid = await issuer.send({ invoice: inv.invoice, assetId: assetId!, amount: 25_000_000 })
    // the panel refreshes on every balance read; mine until it sees the transfer settled
    let b = await ok('GET', '/wallet/api/balances')
    for (let i = 0; i < 6 && b.usdt.settled !== 25_000_000; i++) { issuer.refresh(); await regtest.mine(1); b = await ok('GET', '/wallet/api/balances') }
    assert.equal(b.usdt.label, '25.00 test USDT (regtest)')
    assert.doesNotMatch(JSON.stringify(b), /(?<!test )USDT/, 'never plain USDT')
    assert.match(paid.txid, /^[0-9a-f]{64}$/)

    // pay 5 back to the issuer's witness invoice through preview + gate
    const back = issuer.invoice(5_000_000, assetId)
    const preview = await ok('POST', '/wallet/api/send/preview', { kind: 'rgb', to: back.invoice, amount: 5_000_000 })
    assert.equal(preview.decoded.amount_label, '5.00 test USDT (regtest)')
    assert.equal(preview.irreversible, "Can't be undone")
    const sent = await ok('POST', '/wallet/api/send/confirm', { preview_id: preview.id, confirm: true })
    for (let i = 0; i < 6; i++) {
      issuer.refresh()
      const t = issuer.transferByTxid(assetId!, sent.txid)
      if (t?.status === 'Settled') break
      await regtest.mine(1)
      await ok('GET', '/wallet/api/balances')
    }
    assert.equal(issuer.transferByTxid(assetId!, sent.txid)?.status, 'Settled')
    const h = await ok('GET', '/wallet/api/history')
    const rgbRows = h.rows.filter((r: { layer: string }) => r.layer === 'rgb')
    assert.ok(rgbRows.some((r: { direction: string; label: string }) => r.direction === 'in' && r.label === '+25.00 test USDT (regtest)'))
    assert.ok(rgbRows.some((r: { direction: string; label: string }) => r.direction === 'out' && r.label === '-5.00 test USDT (regtest)'))
    assert.ok(h.credit_rows.some((r: { direction: string; amount: number }) => r.direction === 'in' && r.amount === 25_000_000), 'the credit agent reads the settled receive')
  })
})
