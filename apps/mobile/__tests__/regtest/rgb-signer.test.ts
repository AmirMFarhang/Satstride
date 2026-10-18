// Laptop regtest proof of the worklet's RGB path before it runs on the phone: two
// wallets opened by worklet/rgb.js from seeds only (watch-only rgb-lib, the Node
// binding here), every PSBT signed by worklet/keys.js. Issue test USDT, blinded
// receive, send there and back, settle. Needs the passbook-mobile stack with the
// RGB proxy:  ALL=1 apps/mobile/infra/regtest.sh up
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../../worklet/keys.js')
const { PhoneRgbWallet } = require('../../worklet/rgb.js')
const rgblib = require('@utexo/rgb-lib')

const RPC = process.env.BITCOIND_URL ?? 'http://127.0.0.1:18603'
const ELECTRUM = process.env.PASSBOOK_INDEXER ?? `tcp://127.0.0.1:${process.env.PASSBOOK_ELECTRS_PORT ?? 50171}`
const PROXY = process.env.PASSBOOK_PROXY ?? `rpc://127.0.0.1:${process.env.PASSBOOK_PROXY_PORT ?? 3260}/json-rpc`

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const r = await fetch(wallet ? `${RPC}/wallet/${wallet}` : RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('user:password').toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
  })
  const j = (await r.json()) as { result: T; error: { message: string } | null }
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const mine = async (n = 1) => { await rpc('generatetoaddress', [n, await rpc<string>('getnewaddress', [], 'miner')], 'miner') }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function open(name: string) {
  const words = generateMnemonic(wordlist, 128)
  const dataDir = mkdtempSync(join(process.env.MOBILE_RGB_TEST_DIR ?? '/tmp', `rgb-${name}-`))
  return new PhoneRgbWallet(rootFromSeed(mnemonicToSeedSync(words)), { network: 'Regtest', dataDir, indexerUrl: ELECTRUM, proxyEndpoint: PROXY }, rgblib)
}

async function settle(wallets: InstanceType<typeof PhoneRgbWallet>[], assetId: string, done: () => boolean) {
  for (let i = 0; i < 12 && !done(); i++) {
    for (const w of wallets) w.refresh(assetId)
    if (done()) return
    await mine(1)
    await wait(1500)
  }
}

test('seed-only rgb-lib wallets with the worklet signer: issue, blinded receive, send both ways', { timeout: 300_000 }, async () => {
  try { await rpc('loadwallet', ['miner']) } catch { /* loaded or missing */ }
  const issuer = open('issuer')
  const phone = open('phone')
  try {
    for (const w of [issuer, phone]) await rpc('sendtoaddress', [w.address(), 0.01], 'miner')
    await mine(1); await wait(2000)
    assert.ok(Number(phone.btcBalance().vanilla.spendable) >= 1_000_000)

    // createUtxos: PSBT built by rgb-lib, signed by keys.js, finalized, broadcast by rgb-lib
    assert.ok(Number(issuer.createUtxos({ num: 4, size: 5000, feeRate: 2 })) > 0)
    assert.ok(Number(phone.createUtxos({ num: 4, size: 5000, feeRate: 2 })) > 0)
    await mine(1); await wait(2000)

    const asset = issuer._open().issueAssetNIA('USDT', 'Test USDT (regtest)', '6', ['1000000000'])
    const assetId = asset.assetId as string
    assert.match(assetId, /^rgb:/)

    // the phone receives blinded; the issuer pays (send PSBT signed by keys.js)
    const inv = phone.blindReceive({ amount: 25_000_000, durationSeconds: 3600 })
    assert.match(inv.invoice, /^rgb:/)
    const sent = issuer.send({ invoice: inv.invoice, assetId, amount: 25_000_000, feeRate: 2 })
    assert.match(sent.txid, /^[0-9a-f]{64}$/)
    await settle([phone, issuer], assetId, () => phone.transfers(assetId).some((t: { kind: string; status: string }) => t.kind === 'ReceiveBlind' && t.status === 'Settled'))
    assert.equal(phone.assets().find((a: { assetId: string }) => a.assetId === assetId)?.balance.settled, 25_000_000)

    // the phone pays back part of it (its own send PSBT, signed by keys.js)
    const back = issuer.blindReceive({ assetId, amount: 10_000_000, durationSeconds: 3600 })
    const repay = phone.send({ invoice: back.invoice, assetId, amount: 10_000_000, feeRate: 2 })
    await settle([issuer, phone], assetId, () => phone.transfers(assetId).some((t: { kind: string; status: string; txid: string | null }) => t.kind === 'Send' && t.status === 'Settled' && t.txid === repay.txid))
    assert.equal(phone.assets().find((a: { assetId: string }) => a.assetId === assetId)?.balance.settled, 15_000_000)
    console.log(JSON.stringify({ assetId, issue_to_phone: sent.txid, phone_to_issuer: repay.txid }))

    // a wrong-asset invoice is refused before anything is signed
    const other = issuer.blindReceive({ assetId, amount: 1, durationSeconds: 3600 })
    assert.throws(() => phone.send({ invoice: other.invoice, assetId: 'rgb:not-this-one', amount: 1 }), /invoice is for/)
  } finally {
    issuer.close(); phone.close()
  }
})
