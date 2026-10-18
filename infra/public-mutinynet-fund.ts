// Test USDT on Mutinynet for the phones (lane E1): Add-on 4's test asset, "Passbook test USDT (mutinynet,
// no value)", sent from its issuer wallet (the 17 Oct run's lender wallet, data/mutinynet, on this laptop) to an
// RGB invoice a phone shows. Test coins only; never mainnet.
//
//   npx tsx infra/public-mutinynet-fund.ts status                         the issuer's test USDT and BTC
//   npx tsx infra/public-mutinynet-fund.ts send --invoice <rgb invoice> --amount <test USDT> [--asset <rgb:…>] [--wait]
//   npx tsx infra/public-mutinynet-fund.ts utxos [--num 5]                 colored outputs on the issuer wallet
//   npx tsx infra/public-mutinynet-fund.ts send-btc --address <tb1…> --sats <n> [--from issuer]
//       test BTC from the old 17 Oct borrower key, or from the issuer RGB wallet's spare (uncolored) BTC
//
// `send` refuses an invoice for another network or another asset, or with another amount, and prints the txid with
// its mutinynet.com link. --wait waits until both sides see the transfer settled (the phone must be online).

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as bitcoin from 'bitcoinjs-lib'
import { EsploraChain } from '../src/chain/esplora.js'
import { loadConfig } from '../src/core/config.js'
import { extractHex, keyPathOutput, signKeyPath } from '../src/escrow/escrow.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { explorerTx, type NetworkProfile } from '../src/core/network.js'
import { RgbWallet } from '../src/rgb/wallet.js'
import { loadSeed, partyKey } from '../src/wallet/party.js'

const ROOT = resolve(process.env.MUTINYNET_DIR ?? 'data/mutinynet')
const CONFIG = process.env.PASSBOOK_CONFIG ?? 'infra/passbook.config.mutinynet.yaml'

/** Whole test USDT, at most six decimals, positive and at most `cap`. */
export function parseUsdt(value: string | undefined, cap = 500): number {
  if (!value || !/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('--amount must be test USDT with at most six decimals')
  const [w, f = ''] = value.split('.')
  const micro = Number(w) * MICRO_PER_USDT + Number(f.padEnd(6, '0'))
  if (micro <= 0 || micro > cap * MICRO_PER_USDT) throw new Error(`--amount must be between 0 and ${cap} test USDT (a test float, not a treasury)`)
  return micro
}

/** Why the issuer must not pay this invoice, or null. */
export function invoiceProblem(d: { assetId?: string; network?: string; assignment?: Record<string, unknown> }, assetId: string, amount: number): string | null {
  if (d.network && !['signet', 'Signet'].includes(d.network)) return `the invoice is for network ${d.network}, not Mutinynet (signet)`
  if (d.assetId && d.assetId !== assetId) return `the invoice names asset ${d.assetId}, not ${assetId}`
  // the decoder gives a fungible assignment as { type: 'Fungible', value } or as { Fungible: value } (src/wallet/panel.ts)
  const a = d.assignment as { type?: string; value?: unknown; Fungible?: unknown } | undefined
  const asked = a ? (a.type === 'Fungible' ? a.value : a.Fungible) : undefined
  if (asked !== undefined && asked !== null && typeof asked !== 'number') return 'the invoice\'s amount cannot be read'
  if (typeof asked === 'number' && asked !== 0 && asked !== amount) return `the invoice asks for ${asked / MICRO_PER_USDT}, not ${amount / MICRO_PER_USDT} test USDT`
  return null
}

/** Test BTC from the old 17 Oct borrower key (data/mutinynet) to a Mutinynet address: at most 50,000 sats, change back to the key. */
async function sendBtc(p: NetworkProfile, address: string | undefined, satsArg: string | undefined): Promise<void> {
  const net = bitcoin.networks[p.addressNetwork]
  const sats = Number(satsArg)
  if (!address) throw new Error('send-btc needs --address <a Mutinynet tb1… address>')
  try { bitcoin.address.toOutputScript(address, net) } catch { throw new Error(`${address} is not a Mutinynet (signet) address`) }
  if (!Number.isSafeInteger(sats) || sats < 546 || sats > 50_000) throw new Error('--sats must be 546 to 50,000 (a test float)')
  const chain = new EsploraChain(p.endpoints.esplora!)
  const key = partyKey(loadSeed('borrower', { dir: join(ROOT, 'wallets'), create: false }))
  const script = keyPathOutput(key.pubkey).script
  const from = bitcoin.address.fromOutputScript(Buffer.from(script, 'hex'), net)
  const fee = 500
  const inputs: { txid: string; vout: number; value: number }[] = []
  for (const u of (await chain.utxos(from)).filter((x) => x.status.confirmed).sort((a, b) => b.value - a.value)) {
    if (inputs.reduce((a, x) => a + x.value, 0) >= sats + fee + 546) break
    inputs.push(u)
  }
  const total = inputs.reduce((a, x) => a + x.value, 0)
  if (total < sats + fee + 546) throw new Error(`the old borrower key holds ${total} confirmed sats, less than ${sats + fee + 546}`)
  const psbt = new bitcoin.Psbt({ network: net })
  for (const u of inputs) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: Buffer.from(script, 'hex'), value: BigInt(u.value) }, tapInternalKey: Buffer.from(key.pubkey, 'hex') })
  psbt.addOutput({ script: Buffer.from(bitcoin.address.toOutputScript(address, net)), value: BigInt(sats) })
  psbt.addOutput({ script: Buffer.from(script, 'hex'), value: BigInt(total - sats - fee) })
  signKeyPath(psbt, key.secretKey).finalizeAllInputs()
  const txid = await chain.broadcast(extractHex(psbt))
  console.log(`sent ${sats} test sats (mutinynet) to ${address}: ${txid} ${explorerTx(p, txid)}`)
}

/**
 * Spare uncolored BTC from the issuer's RGB wallet to a Mutinynet address (at most 15,000 sats, and it keeps at least 8,000
 * vanilla for its own sends). The wrapper has no BTC send, so this uses the rgb-sdk wallet underneath (sendBtc).
 */
async function sendBtcFromIssuer(p: NetworkProfile, address: string | undefined, satsArg: string | undefined): Promise<void> {
  const net = bitcoin.networks[p.addressNetwork]
  const sats = Number(satsArg)
  if (!address) throw new Error('send-btc needs --address <a Mutinynet tb1… address>')
  try { bitcoin.address.toOutputScript(address, net) } catch { throw new Error(`${address} is not a Mutinynet (signet) address`) }
  if (!Number.isSafeInteger(sats) || sats < 546 || sats > 15_000) throw new Error('--sats must be 546 to 15,000 from the issuer')
  const issuer = await RgbWallet.open(loadSeed('lender1', { dir: join(ROOT, 'wallets'), create: false }), join(ROOT, 'wallets', 'lender1', 'rgb'), { network: p.rgbNetwork, indexerUrl: p.endpoints.rgb_indexer!, transportEndpoint: p.endpoints.rgb_proxy! })
  try {
    issuer.refresh()
    const vanilla = issuer.btcBalance().vanilla.spendable ?? issuer.btcBalance().vanilla.settled
    if (vanilla - sats < 8_000) throw new Error(`the issuer has ${vanilla} spendable vanilla sats; it keeps 8,000 for its own sends`)
    const rgb = (issuer as unknown as { account: { getRgbWallet(): { sendBtc(o: { address: string; amount: number; feeRate: number }): Promise<string> } } }).account.getRgbWallet()
    const txid = await rgb.sendBtc({ address, amount: sats, feeRate: 1 })
    console.log(`sent ${sats} test sats (mutinynet) from the issuer to ${address}: ${txid} ${explorerTx(p, txid)}`)
  } finally { issuer.close() }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status'
  const { values } = parseArgs({ args: process.argv.slice(3), options: { invoice: { type: 'string' }, amount: { type: 'string' }, wait: { type: 'boolean' }, num: { type: 'string' }, address: { type: 'string' }, sats: { type: 'string' }, from: { type: 'string' }, asset: { type: 'string' } } })
  const cfg = loadConfig(CONFIG, { checkFiles: false })
  if (cfg.network.name !== 'mutinynet') throw new Error(`${CONFIG} is a ${cfg.network.name} profile; this tool is Mutinynet only`)
  const p = cfg.network
  if (cmd === 'send-btc' && values.from === 'issuer') return sendBtcFromIssuer(p, values.address, values.sats)
  if (cmd === 'send-btc') return sendBtc(p, values.address, values.sats)
  const state = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8')) as { network: string; asset: { id: string; name: string } }
  if (state.network !== 'mutinynet') throw new Error('data/mutinynet/state.json is not the Mutinynet asset')
  // --asset: another asset this issuer issued (the end game's fresh TUSDT, $STATE/asset.json); default the 17 Oct one
  const asset = values.asset ? { id: values.asset, name: 'Passbook test USDT (mutinynet, no value)' } : state.asset
  const issuer = await RgbWallet.open(loadSeed('lender1', { dir: join(ROOT, 'wallets'), create: false }), join(ROOT, 'wallets', 'lender1', 'rgb'), { network: p.rgbNetwork, indexerUrl: p.endpoints.rgb_indexer!, transportEndpoint: p.endpoints.rgb_proxy! })
  try {
    try { issuer.refresh() } catch (err) { console.error(`refresh: ${(err as Error).message}`) }
    if (!issuer.knowsAsset(asset.id)) throw new Error(`the issuer does not hold ${asset.id}`)
    const usdt = issuer.balance(asset.id)
    const btc = issuer.btcBalance()
    if (cmd === 'status') {
      console.log(`issuer ${issuer.address()} (mutinynet): ${usdt.settled / MICRO_PER_USDT} test USDT (mutinynet) settled, ${usdt.spendable / MICRO_PER_USDT} spendable; BTC vanilla ${btc.vanilla.settled} sats, colored ${btc.colored.settled} sats`)
      console.log(`asset ${asset.id} "${asset.name}"`)
      return
    }
    if (cmd === 'utxos') {
      const n = await issuer.createUtxos(Number(values.num ?? 5), 3000)
      console.log(`created ${n} colored outputs of 3000 sats on the issuer wallet`)
      return
    }
    if (cmd === 'send') {
      if (!values.invoice) throw new Error('send needs --invoice <rgb invoice from the phone>')
      const amount = parseUsdt(values.amount)
      const problem = invoiceProblem(issuer.decodeInvoice(values.invoice), asset.id, amount)
      if (problem) throw new Error(`refusing: ${problem}`)
      if (usdt.spendable < amount) throw new Error(`the issuer has ${usdt.spendable / MICRO_PER_USDT} spendable test USDT, less than ${amount / MICRO_PER_USDT}`)
      const sent = await issuer.send({ invoice: values.invoice, assetId: asset.id, amount, feeRate: 1 })
      console.log(`sent ${amount / MICRO_PER_USDT} test USDT (mutinynet): ${sent.txid} ${explorerTx(p, sent.txid)}`)
      if (values.wait) {
        for (let i = 0; i < 120; i++) {
          try { issuer.refresh() } catch { /* retry */ }
          const t = issuer.transferByTxid(asset.id, sent.txid, 'Send')
          if (t?.status === 'Settled') { console.log('settled'); return }
          if (t?.status === 'Failed') throw new Error('the transfer failed')
          await new Promise((r) => setTimeout(r, 10_000))
        }
        throw new Error(`sent ${sent.txid} but not settled after 20 minutes: the phone must be online to take the consignment`)
      }
      return
    }
    throw new Error(`unknown command ${cmd}; use status | send | utxos`)
  } finally { issuer.close() }
}

if (import.meta.url === `file://${process.argv[1]}`) await main().then(() => process.exit(0), (err) => { console.error((err as Error).message); process.exit(1) })
