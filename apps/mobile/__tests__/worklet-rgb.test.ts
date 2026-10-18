// worklet/rgb.js speaks two rgb-lib APIs: the laptop's Node binding (durations) and
// the phone's Bare build of rgb-lib's newer C API (absolute expiry timestamps, found on
// the device: "RgbLib(InvalidExpiration)" when given a duration).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mnemonicToSeedSync } from '@scure/bip39'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../worklet/keys.js')
const { PhoneRgbWallet } = require('../worklet/rgb.js')

const root = rootFromSeed(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))
const config = { network: 'Regtest', dataDir: '/tmp/x', indexerUrl: 'tcp://127.0.0.1:1', proxyEndpoint: 'rpc://127.0.0.1:2/json-rpc' }

function fakeLib(newApi: boolean) {
  const calls: unknown[][] = []
  class Wallet {
    constructor(_d: unknown) {}
    blindReceive(...a: unknown[]) { calls.push(a); return { invoice: 'rgb:x', recipientId: 'r' } }
  }
  ;(Wallet.prototype as unknown as { sendBegin: unknown }).sendBegin = newApi
    ? function (_o: unknown, _m: unknown, _d: unknown, _f: unknown, _c: unknown, _e: unknown, _r: unknown) { return '' }
    : function () { return '' }
  class WalletData { constructor(_d: unknown) {} }
  return { lib: { Wallet, WalletData }, calls }
}

test('the Bare (newer) rgb-lib API gets an absolute expiry; the Node one a duration', () => {
  const now = Math.floor(Date.now() / 1000)
  const bare = fakeLib(true)
  new PhoneRgbWallet(root, config, bare.lib).blindReceive({ amount: 5, durationSeconds: 3600 })
  const exp = Number(bare.calls[0][2])
  assert.ok(exp >= now + 3600 && exp <= now + 3700, `absolute expiry, got ${exp}`)
  assert.equal(bare.calls[0][1], '{"Fungible":5}')
  const node = fakeLib(false)
  new PhoneRgbWallet(root, config, node.lib).blindReceive({ amount: 5, durationSeconds: 3600 })
  assert.equal(node.calls[0][2], '3600')
})

test('refuses anything but regtest, and a non-positive amount', () => {
  assert.throws(() => new PhoneRgbWallet(root, { ...config, network: 'Mainnet' }, fakeLib(true).lib), /regtest or Mutinynet only/)
  assert.throws(() => new PhoneRgbWallet(root, config, fakeLib(true).lib).blindReceive({ amount: 0 }), /positive/)
})

test('reads an invoice whether the binding returns JSON text (Bare) or an object (Node)', () => {
  const data = { recipientId: 'bcrt:utxob:x', assetId: 'rgb:a', transportEndpoints: ['rpc://127.0.0.1:3260/json-rpc'] }
  for (const asText of [true, false]) {
    class Invoice { constructor(_s: string) {} invoiceData() { return asText ? JSON.stringify(data) : data } drop() {} }
    const { lib } = fakeLib(true)
    const w = new PhoneRgbWallet(root, config, { ...lib, Invoice })
    assert.deepEqual(w.decodeInvoice(' rgb:invoice '), data)
  }
})

test('takes the PSBT from a bare string (Node) or a SendBeginResult JSON (Bare)', async () => {
  // a real rgb-lib-shaped PSBT is not needed: the wallet refuses to sign it, but only after reading it
  const fake = 'cHNidP8BAAoCAAAAAAAAAAAAAAAA'
  for (const begun of [fake, JSON.stringify({ psbt: fake, batchTransferIdx: 3, details: {} })]) {
    class Invoice { constructor(_s: string) {} invoiceData() { return { recipientId: 'bcrt:utxob:x', transportEndpoints: ['rpc://p'] } } drop() {} }
    const { lib } = fakeLib(true)
    ;(lib.Wallet.prototype as unknown as Record<string, unknown>).goOnline = () => ({})
    ;(lib.Wallet.prototype as unknown as Record<string, unknown>).sendBegin = function (_o: unknown, _m: unknown, _d: unknown, _f: unknown, _c: unknown, _e: unknown, _r: unknown) { return begun }
    const w = new PhoneRgbWallet(root, config, { ...lib, Invoice })
    // the fake PSBT has no inputs: getting as far as the signer proves the PSBT was extracted
    assert.throws(() => w.send({ invoice: 'rgb:i', assetId: 'rgb:a', amount: 1 }), (e: Error) => !/no PSBT/.test(e.message))
  }
  const { lib } = fakeLib(true)
  ;(lib.Wallet.prototype as unknown as Record<string, unknown>).goOnline = () => ({})
  ;(lib.Wallet.prototype as unknown as Record<string, unknown>).sendBegin = function (_o: unknown, _m: unknown, _d: unknown, _f: unknown, _c: unknown, _e: unknown, _r: unknown) { return '{"batchTransferIdx":1}' }
  class Invoice { constructor(_s: string) {} invoiceData() { return { recipientId: 'r', transportEndpoints: [] } } drop() {} }
  assert.throws(() => new PhoneRgbWallet(root, config, { ...lib, Invoice }).send({ invoice: 'rgb:i', assetId: 'rgb:a', amount: 1 }), /no PSBT/)
})

test('a send that fails after send_begin releases its reserved batch (never signed, never broadcast)', () => {
  const failed: unknown[][] = []
  const { lib } = fakeLib(true)
  const proto = lib.Wallet.prototype as unknown as Record<string, unknown>
  proto.goOnline = () => ({})
  proto.sendBegin = function (_o: unknown, _m: unknown, _d: unknown, _f: unknown, _c: unknown, _e: unknown, _r: unknown) { return JSON.stringify({ psbt: 'cHNidP8BAAoCAAAAAAAAAAAAAAAA', batchTransferIdx: 7, details: {} }) }
  proto.failTransfers = (...a: unknown[]) => { failed.push(a); return '{"transfersChanged":true,"cannotFail":false}' }
  proto.sendEnd = () => { throw new Error('must not be reached') }
  class Invoice { constructor(_s: string) {} invoiceData() { return { recipientId: 'bcrt:utxob:x', transportEndpoints: ['rpc://p'] } } drop() {} }
  const w = new PhoneRgbWallet(root, config, { ...lib, Invoice })
  assert.throws(() => w.send({ invoice: 'rgb:i', assetId: 'rgb:a', amount: 1 }))
  assert.equal(failed.length, 1)
  assert.equal(failed[0][1], '7')
})

test('cancelling unsent sends names each Initiated send by its batch index', () => {
  const failed: unknown[][] = []
  const { lib } = fakeLib(true)
  const proto = lib.Wallet.prototype as unknown as Record<string, unknown>
  proto.goOnline = () => ({})
  proto.listAssets = () => ({ nia: [{ assetId: 'rgb:a', ticker: 'USDT', name: 'x', precision: 6 }] })
  proto.getAssetBalance = () => ({ settled: 1, future: 1, spendable: 1 })
  proto.listTransfers = (id: string | null) => id === 'rgb:a'
    ? [{ kind: 'Send', status: 'Initiated', batchTransferIdx: 4 }, { kind: 'Send', status: 'Settled', batchTransferIdx: 2 }, { kind: 'ReceiveBlind', status: 'WaitingCounterparty', batchTransferIdx: 3 }]
    : []
  proto.failTransfers = (...a: unknown[]) => { failed.push(a); return '{"transfersChanged":true,"cannotFail":false}' }
  const out = new PhoneRgbWallet(root, config, lib).failPending()
  assert.deepEqual(failed.map((a) => a[1]), ['4'])
  assert.deepEqual(out, [{ batchTransferIdx: 4, transfersChanged: true, cannotFail: false }])
})

test('outputs as the reserve reads them: free, holding, pending, vanilla; JSON or objects', () => {
  const unspents = [
    { utxo: { outpoint: { txid: 'aa', vout: 0 }, btcAmount: 5000, colorable: true, exists: true }, rgbAllocations: [], pendingBlinded: 0 },
    { utxo: { outpoint: { txid: 'aa', vout: 1 }, btcAmount: 5000, colorable: true, exists: true }, rgbAllocations: [{ assetId: 'rgb:a', assignment: { Fungible: 7 }, settled: true }], pendingBlinded: 0 },
    { utxo: { outpoint: { txid: 'bb', vout: 0 }, btcAmount: 5000, colorable: true, exists: true }, rgbAllocations: [], pendingBlinded: 1 },
    { utxo: { outpoint: { txid: 'cc', vout: 2 }, btcAmount: 90000, colorable: false, exists: true }, rgbAllocations: [] },
  ]
  for (const shape of [unspents, JSON.stringify(unspents)]) {
    const { lib } = fakeLib(true)
    const seen: unknown[][] = []
    ;(lib.Wallet.prototype as unknown as { listUnspents: unknown }).listUnspents = (...a: unknown[]) => { seen.push(a); return shape }
    const online = { handle: 'online' }
    ;(lib.Wallet.prototype as unknown as { goOnline: unknown }).goOnline = () => online
    const w = new PhoneRgbWallet(root, config, lib)
    const rows = w.unspents(true)
    // rgb-lib's C API needs the online handle even with skipSync (null crashed on the phone)
    assert.deepEqual(seen[0], [online, false, true], 'skipSync still passes the online handle')
    ;(lib.Wallet.prototype as unknown as { getBtcBalance: unknown }).getBtcBalance = (...a: unknown[]) => { seen.push(a); return { vanilla: {}, colored: {} } }
    w.btcBalance(true)
    assert.deepEqual(seen.at(-1), [online, true])
    assert.deepEqual(rows.map((u: { outpoint: string; free: boolean }) => [u.outpoint, u.free]), [['aa:0', true], ['aa:1', false], ['bb:0', false], ['cc:2', false]])
    assert.deepEqual(rows[1].allocations, [{ assetId: 'rgb:a', amount: 7, settled: true }])
    assert.equal(rows[3].sats, 90000)
  }
})

/** A PSBT whose one input this wallet owns (its vanilla keychain), as rgb-lib writes them. */
function ownPsbt(): string {
  const btc = require('@scure/btc-signer')
  const { base64 } = require('@scure/base')
  const path = "m/86'/1'/0'/1/0"
  const node = root.derive(path)
  const xonly = node.publicKey.slice(1)
  const net = { ...btc.TEST_NETWORK, bech32: 'bcrt' }
  const out = btc.p2tr(xonly, undefined, net)
  const tx = new btc.Transaction()
  tx.addInput({ txid: '11'.repeat(32), index: 0, witnessUtxo: { script: out.script, amount: 10_000n }, tapInternalKey: xonly, tapBip32Derivation: [[xonly, { hashes: [], der: { fingerprint: root.fingerprint, path: btc.bip32Path(path) } }]] })
  tx.addOutputAddress(out.address, 9_000n, net)
  return base64.encode(tx.toPSBT())
}

test('a send that fails in sendEnd after signing is reported ambiguous with its txid, and its batch is left alone', () => {
  const failed: unknown[][] = []
  const { lib } = fakeLib(true)
  const proto = lib.Wallet.prototype as unknown as Record<string, unknown>
  proto.goOnline = () => ({})
  proto.sendBegin = function (_o: unknown, _m: unknown, _d: unknown, _f: unknown, _c: unknown, _e: unknown, _r: unknown) { return JSON.stringify({ psbt: ownPsbt(), batchTransferIdx: 9, details: {} }) }
  proto.sendEnd = () => { throw new Error('proxy timeout') }
  proto.failTransfers = (...a: unknown[]) => { failed.push(a); return '{"transfersChanged":true}' }
  class Invoice { constructor(_s: string) {} invoiceData() { return { recipientId: 'bcrt:utxob:x', transportEndpoints: ['rpc://p'] } } drop() {} }
  const w = new PhoneRgbWallet(root, config, { ...lib, Invoice })
  let message = ''
  assert.throws(() => w.send({ invoice: 'rgb:i', assetId: 'rgb:a', amount: 1 }), (e: Error) => { message = e.message; return true })
  assert.match(message, /^AMBIGUOUS_SEND:\{"txid":"[0-9a-f]{64}","batchTransferIdx":9\}/)
  assert.match(message, /may have been broadcast/)
  assert.equal(failed.length, 0, 'a signed, possibly broadcast batch is never failed by the send itself')
})

function walletWith(rows: object[], onChain: string[] | 'error', failed: unknown[][]) {
  const { lib } = fakeLib(true)
  const proto = lib.Wallet.prototype as unknown as Record<string, unknown>
  proto.goOnline = () => ({})
  proto.listAssets = () => ({ nia: [{ assetId: 'rgb:a', ticker: 'USDT', name: 'x', precision: 6 }] })
  proto.getAssetBalance = () => ({ settled: 1, future: 1, spendable: 1 })
  proto.listTransfers = (id: string | null) => (id === 'rgb:a' ? rows : [])
  proto.listTransactions = () => { if (onChain === 'error') throw new Error('indexer down'); return onChain.map((txid) => ({ txid })) }
  proto.failTransfers = (...a: unknown[]) => { failed.push(a); return '{"transfersChanged":true,"cannotFail":false}' }
  return new PhoneRgbWallet(root, config, lib)
}

test('cancelling refuses a batch whose transaction is on the network, unreadable, or too recent; cancels only proven-unsent ones', () => {
  const now = 1_800_000_000
  const old = now - 3600
  const rows = [
    { kind: 'Send', status: 'Initiated', batchTransferIdx: 4, txid: 'aa'.repeat(32), updatedAt: old }, // live: never cancelled
    { kind: 'Send', status: 'Initiated', batchTransferIdx: 5, txid: 'bb'.repeat(32), updatedAt: now - 10 }, // not seen yet, but just now
    { kind: 'Send', status: 'Initiated', batchTransferIdx: 6, txid: 'cc'.repeat(32), updatedAt: old }, // not on the network: cancel
    { kind: 'Send', status: 'Initiated', batchTransferIdx: 7, txid: null, updatedAt: old }, // no transaction recorded: cancel
  ]
  const failed: unknown[][] = []
  const out = walletWith(rows, ['aa'.repeat(32)], failed).failPending(null, now)
  assert.deepEqual(failed.map((a) => a[1]), ['6', '7'])
  assert.deepEqual(out.map((o: { batchTransferIdx: number; refused?: string }) => [o.batchTransferIdx, o.refused ?? 'cancelled']), [[4, 'may be broadcast'], [5, 'too recent to tell'], [6, 'cancelled'], [7, 'cancelled']])
  // the network could not be read: nothing with a transaction is cancelled
  const failed2: unknown[][] = []
  const out2 = walletWith(rows.slice(2, 3), 'error', failed2).failPending(null, now)
  assert.equal(failed2.length, 0)
  assert.equal(out2[0].refused, 'may be broadcast')
  // naming one batch cancels only that one, under the same rule
  const failed3: unknown[][] = []
  walletWith(rows, [], failed3).failPending(4, now)
  assert.deepEqual(failed3.map((a) => a[1]), ['4'])
})

test('sendStatus says whether a signed send reached the network', () => {
  const rows = [{ kind: 'Send', status: 'Initiated', batchTransferIdx: 4, txid: 'aa'.repeat(32) }]
  assert.equal(walletWith(rows, ['aa'.repeat(32)], []).sendStatus({ txid: 'aa'.repeat(32) }).state, 'broadcast')
  const notSeen = walletWith(rows, [], []).sendStatus({ txid: 'aa'.repeat(32) })
  assert.deepEqual([notSeen.state, notSeen.rgbStatus, notSeen.batchTransferIdx], ['not-seen', 'Initiated', 4])
  assert.equal(walletWith(rows, 'error', []).sendStatus({ txid: 'aa'.repeat(32) }).state, 'unknown')
  assert.throws(() => walletWith(rows, [], []).sendStatus({ txid: 'zz' }), /bad txid/)
})
