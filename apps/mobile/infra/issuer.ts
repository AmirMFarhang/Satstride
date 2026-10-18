// A regtest test-USDT issuer on the laptop, standing in for the lender until M3:
// one rgb-lib wallet (Node binding) opened from a regtest-only seed kept in
// data/mobile/issuer/ (gitignored), signed by the same worklet/keys.js the phone uses.
//   npx tsx infra/issuer.ts setup              fund, colored outputs, issue 1 000 000 test USDT once
//   npx tsx infra/issuer.ts pay <invoice> <usdt>   pay a phone's blinded invoice, mine, settle
//   npx tsx infra/issuer.ts invoice <usdt>     a blinded invoice for the phone to pay back
//   npx tsx infra/issuer.ts state              balances and transfers
// Env: BITCOIND_URL (default http://127.0.0.1:18603), PASSBOOK_ELECTRS_PORT (50171), PASSBOOK_PROXY_PORT (3260).
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { parseUnits, formatUnits } from '../src/core/amounts.ts'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../worklet/keys.js')
const { PhoneRgbWallet } = require('../worklet/rgb.js')
const rgblib = require('@utexo/rgb-lib')

const DIR = resolve(process.env.MOBILE_ISSUER_DIR ?? join(import.meta.dirname, '../../../data/mobile/issuer'))
const RPC = process.env.BITCOIND_URL ?? 'http://127.0.0.1:18603'
const ELECTRUM = `tcp://127.0.0.1:${process.env.PASSBOOK_ELECTRS_PORT ?? 50171}`
const PROXY = `rpc://127.0.0.1:${process.env.PASSBOOK_PROXY_PORT ?? 3260}/json-rpc`

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

function open() {
  mkdirSync(join(DIR, 'rgb'), { recursive: true, mode: 0o700 })
  const seedFile = join(DIR, 'words.txt')
  if (!existsSync(seedFile)) writeFileSync(seedFile, generateMnemonic(wordlist, 128) + '\n', { mode: 0o600 })
  const words = readFileSync(seedFile, 'utf8').trim()
  return new PhoneRgbWallet(rootFromSeed(mnemonicToSeedSync(words)), { network: 'Regtest', dataDir: join(DIR, 'rgb'), indexerUrl: ELECTRUM, proxyEndpoint: PROXY }, rgblib)
}
const stateFile = () => join(DIR, 'state.json')
const assetId = (): string => JSON.parse(readFileSync(stateFile(), 'utf8')).assetId

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  try { await rpc('loadwallet', ['miner']) } catch { /* loaded */ }
  const w = open()
  try {
    if (cmd === 'setup') {
      if (existsSync(stateFile())) { console.log(`already set up: ${assetId()}`); return }
      await rpc('sendtoaddress', [w.address(), 0.05], 'miner'); await mine(1); await wait(2000)
      w.createUtxos({ num: 10, size: 5000, feeRate: 2 }); await mine(1); await wait(2000)
      const asset = w._open().issueAssetNIA('USDT', 'Tether USD (regtest stand-in)', '6', ['1000000000000'])
      writeFileSync(stateFile(), JSON.stringify({ assetId: asset.assetId }, null, 1))
      console.log(`issued 1 000 000 test USDT: ${asset.assetId}`)
    } else if (cmd === 'pay') {
      const units = parseUnits(b ?? '')
      if (!a || units === null) throw new Error('usage: pay <invoice> <usdt>')
      const sent = w.send({ invoice: a, assetId: assetId(), amount: Number(units), feeRate: 2 })
      await mine(1)
      console.log(JSON.stringify({ paid: `${formatUnits(units)} test USDT`, txid: sent.txid }))
      for (let i = 0; i < 6; i++) { w.refresh(assetId()); await wait(1500) }
    } else if (cmd === 'invoice') {
      const units = parseUnits(a ?? '')
      if (units === null) throw new Error('usage: invoice <usdt>')
      console.log(w.blindReceive({ assetId: assetId(), amount: Number(units), durationSeconds: 86400 }).invoice)
    } else if (cmd === 'state') {
      w.refresh(null)
      console.log(JSON.stringify({ assets: w.assets(), transfers: existsSync(stateFile()) ? w.transfers(assetId()) : [] }, null, 1))
    } else {
      console.log('usage: issuer.ts setup | pay <invoice> <usdt> | invoice <usdt> | state'); process.exitCode = 2
    }
  } finally { w.close() }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
