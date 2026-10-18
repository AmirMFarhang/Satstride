// Laptop regtest proof of the on-device lender agent (M6) before it runs on the phone: the
// same agent code (src/agent/lender.ts) over the same worklet module (worklet/index.js, here
// under Node with the Node rgb-lib binding) lends to the laptop's seeded borrower peer
// (src/cli/peer.ts --role borrower), through the platform API and the relay.
//
// Needs the passbook-mobile stack, the platform and the miner first:
//   ALL=1 apps/mobile/infra/regtest.sh up
//   apps/mobile/infra/provider.sh seed && apps/mobile/infra/provider.sh platform && apps/mobile/infra/provider.sh automine
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { debtOf } from '../../../../src/core/terms.js'
import { chainPort, partySigner, repayPort, rgbPort, type LenderModuleCalls, type PassbookModuleCalls } from '../../src/agent/device'
import { PASSBOOK_ONLY, PhoneLender, type PhoneLenderState } from '../../src/agent/lender'
import { PhonePlatform } from '../../src/agent/platform'
import { PhoneRelay } from '../../src/agent/relay'

const require = createRequire(import.meta.url)
const createPassbookModule = require('../../worklet/index.js')
const rgblib = require('@utexo/rgb-lib')

const ROOT = join(import.meta.dirname, '../../../..')
const D = process.env.PASSBOOK_MOBILE_PROVIDER_DIR ?? join(ROOT, 'data/mobile/provider')
const STATE = process.env.PASSBOOK_STATE ?? join(D, 'state.json')
const RPC = process.env.BITCOIND_URL ?? 'http://127.0.0.1:18603'
const PLATFORM = process.env.PASSBOOK_URL ?? 'http://127.0.0.1:4301'
const RELAY = process.env.PASSBOOK_RELAYS ?? 'ws://127.0.0.1:7937'
const ELECTRUM = new URL(process.env.RGB_INDEXER_URL ?? `tcp://127.0.0.1:${process.env.PASSBOOK_ELECTRS_PORT ?? 50171}`)
const PROXY = process.env.RGB_TRANSPORT_URL ?? `rpc://127.0.0.1:${process.env.PASSBOOK_PROXY_PORT ?? 3260}/json-rpc`

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const r = await fetch(wallet ? `${RPC}/wallet/${wallet}` : RPC, { method: 'POST', headers: { authorization: `Basic ${Buffer.from('user:password').toString('base64')}` }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) })
  const j = (await r.json()) as { result: T; error: { message: string } | null }
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('the phone lender lends to the laptop borrower peer, sees it repaid, co-signs the release and pays the platform fee', { timeout: 1_800_000 }, async () => {
  const assetId = (JSON.parse(readFileSync(STATE, 'utf8')) as { asset: { id: string } }).asset.id
  const dir = mkdtempSync(join(process.env.MOBILE_RGB_TEST_DIR ?? '/tmp', 'phone-lender-'))
  for (const d of ['rgb', 'loans']) mkdirSync(join(dir, d))
  const m = createPassbookModule({
    seed: mnemonicToSeedSync(generateMnemonic(wordlist, 128)),
    rgblib,
    config: {
      rgb: { network: 'Regtest', dataDir: join(dir, 'rgb'), loansDir: join(dir, 'loans'), indexerUrl: ELECTRUM.href, proxyEndpoint: PROXY },
      electrum: { host: ELECTRUM.hostname, port: Number(ELECTRUM.port) },
    },
  }) as PassbookModuleCalls & LenderModuleCalls & { rgbAddress(): Promise<string>; rgbCreateUtxos(o: object): Promise<number>; close(): Promise<void> }
  const key = await partySigner(m)
  const chain = chainPort(m)
  const rgb = rgbPort(m)
  const repay = repayPort(m, async (loanId, b64) => {
    mkdirSync(join(dir, 'loans', loanId))
    const p = join(dir, `${loanId}.backup`)
    writeFileSync(p, Buffer.from(b64, 'base64'))
    return p
  })
  const relay = new PhoneRelay(key, [RELAY])
  const platform = new PhonePlatform(PLATFORM, key)
  const state: PhoneLenderState = { loans: {}, declined: [] }
  const lender = new PhoneLender(key, platform, relay, chain, rgb, repay, assetId, state, (s) => console.log(`[phone lender] ${s.step}`))
  const report = join(D, 'borrower-report.json')
  try {
    // the lender's coins: BTC for its RGB wallet (fees, the witness outputs it pays), then test USDT from the payer
    await rpc('sendtoaddress', [await m.rgbAddress(), 0.003], 'miner')
    await wait(6000)
    assert.ok(Number(await m.rgbCreateUtxos({ num: 4, size: 5000, feeRate: 2 })) > 0)
    await wait(6000)
    const inv = await rgb.blindInvoice(1_000_000_000, null)
    execFileSync('npx', ['tsx', join(ROOT, 'apps/mobile/infra/salary.ts'), inv.invoice, '1000'], { cwd: ROOT, stdio: 'inherit', env: process.env })
    for (let i = 0; i < 30 && (await rgb.balance(assetId)).settled < 1_000_000_000; i++) { await rgb.refresh(null); await wait(2000) }
    assert.equal((await rgb.balance(assetId)).settled, 1_000_000_000)

    await lender.publishOffer(PASSBOOK_ONLY)
    if (existsSync(report)) writeFileSync(report, '{}')
    execFileSync(join(ROOT, 'apps/mobile/infra/provider.sh'), ['borrower', key.pubkey, '100'], { cwd: ROOT, stdio: 'inherit' })

    const r = await lender.nextApplication(PASSBOOK_ONLY, 300_000)
    assert.ok('loan_id' in r, `declined: ${JSON.stringify((r as { declined?: unknown }).declined)}`)
    const id = r.loan_id
    const l = state.loans[id]
    assert.ok(l.checks.every((c) => c.ok))
    l.fund_approved = true // the person's stop on the phone
    const funded = await lender.fund(id)
    assert.equal((await rgb.balance(assetId)).settled, 1_000_000_000 - l.terms.principal)
    await lender.awaitIou(id)
    const repaid = await lender.confirmRepayment(id)
    const release = await lender.signRelease(id)
    const tx = await chain.getTx(release)
    assert.ok(tx?.height, 'release confirmed')
    assert.equal((await repay.balance(id, assetId)).settled, debtOf(l.terms), 'the repayment sits in the loan\'s own account')
    const record = await platform.loan(id)
    assert.equal(record.status, 'repaid')
    // the borrower peer finishes its side
    for (let i = 0; i < 60 && !(JSON.parse(readFileSync(report, 'utf8') || '{}') as { release_txid?: string }).release_txid; i++) await wait(2000)
    const peer = JSON.parse(readFileSync(report, 'utf8')) as { loan_id: string; release_txid: string; repayment_txid: string }
    assert.equal(peer.loan_id, id)
    assert.equal(peer.release_txid, release)
    assert.equal(peer.repayment_txid, repaid)
    // the platform's share of the interest, owed after close
    let due = await lender.feesDue(id)
    for (let i = 0; i < 20 && !due.length; i++) { await wait(3000); due = await lender.feesDue(id) }
    assert.equal(due.length, 1)
    const fee = await lender.payFee(id)
    assert.equal((await lender.feesDue(id)).length, 0)
    console.log(JSON.stringify({ lender_pk: key.pubkey, loan_id: id, disbursement_txid: funded.disbursement_txid, repayment_txid: repaid, release_txid: release, fee_txid: fee, debt_micro: debtOf(l.terms) }))
  } finally {
    relay.close()
    await m.close()
  }
})
