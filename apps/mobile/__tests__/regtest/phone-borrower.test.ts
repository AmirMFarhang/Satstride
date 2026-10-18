// Laptop regtest proof of the on-device borrower agent (M3) before it runs on the phone:
// the same agent code (src/agent/borrower.ts) over the same worklet module (worklet/index.js,
// here under Node with the Node rgb-lib binding) against the laptop as service provider only:
// the platform API and a lender peer from src/, over the relay and the signed API.
//
// Needs the passbook-mobile stack and the provider started first:
//   ALL=1 apps/mobile/infra/regtest.sh up
//   apps/mobile/infra/provider.sh seed && apps/mobile/infra/provider.sh platform
//   apps/mobile/infra/provider.sh lender && apps/mobile/infra/provider.sh automine
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { verifyPassbook } from '../../../../src/registry/passbook-doc.js'
import { debtOf } from '../../../../src/core/terms.js'
import { verifyObject } from '../../../../src/core/crypto.js'
import { chainPort, partySigner, rgbPort, type PassbookModuleCalls } from '../../src/agent/device'
import { PhoneBorrower, type PhoneAgentState } from '../../src/agent/borrower'
import { PhonePlatform } from '../../src/agent/platform'
import { PhoneRelay } from '../../src/agent/relay'

const require = createRequire(import.meta.url)
const createPassbookModule = require('../../worklet/index.js')
const rgblib = require('@utexo/rgb-lib')

const ROOT = join(import.meta.dirname, '../../../..')
const STATE = process.env.PASSBOOK_STATE ?? join(ROOT, 'data/mobile/provider/state.json')
const RPC = process.env.BITCOIND_URL ?? 'http://127.0.0.1:18603'
const PLATFORM = process.env.PASSBOOK_URL ?? 'http://127.0.0.1:4301'
const RELAY = process.env.PASSBOOK_RELAYS ?? 'ws://127.0.0.1:7937'

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const r = await fetch(wallet ? `${RPC}/wallet/${wallet}` : RPC, { method: 'POST', headers: { authorization: `Basic ${Buffer.from('user:password').toString('base64')}` }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) })
  const j = (await r.json()) as { result: T; error: { message: string } | null }
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('the phone borrower agent takes, repays and closes a loan against the laptop provider', { timeout: 900_000 }, async () => {
  const assetId = (JSON.parse(readFileSync(STATE, 'utf8')) as { asset: { id: string } }).asset.id
  const words = generateMnemonic(wordlist, 128)
  const m = createPassbookModule({
    seed: mnemonicToSeedSync(words),
    rgblib,
    config: {
      rgb: { network: 'Regtest', dataDir: mkdtempSync(join(process.env.MOBILE_RGB_TEST_DIR ?? '/tmp', 'phone-')), indexerUrl: 'tcp://127.0.0.1:50171', proxyEndpoint: 'rpc://127.0.0.1:3260/json-rpc' },
      electrum: { host: '127.0.0.1', port: 50171 },
    },
  }) as PassbookModuleCalls & { rgbAddress(): Promise<string>; rgbCreateUtxos(o: object): Promise<number>; close(): Promise<void> }
  const key = await partySigner(m)
  const chain = chainPort(m)
  const rgb = rgbPort(m)
  const relay = new PhoneRelay(key, [RELAY])
  const platform = new PhonePlatform(PLATFORM, key)
  const state: PhoneAgentState = { loans: {}, labels: {} }
  const steps: string[] = []
  const agent = new PhoneBorrower(key, platform, relay, chain, rgb, assetId, state, (s) => { steps.push(s.step); console.log(`[phone] ${s.step}`) })
  try {
    // the phone's own coins: BTC at its party key (collateral) and at its RGB wallet (colored outputs)
    await rpc('sendtoaddress', [key.btc.address, 0.05], 'miner')
    await rpc('sendtoaddress', [await m.rgbAddress(), 0.002], 'miner')
    await wait(6000)
    assert.ok(Number(await m.rgbCreateUtxos({ num: 5, size: 5000, feeRate: 2 })) > 0)
    await wait(6000)
    // income: the laptop's payer pays the phone 2 000 test USDT on a blinded invoice
    const inv = await rgb.blindInvoice(2_000_000_000, null)
    execFileSync('npx', ['tsx', join(ROOT, 'apps/mobile/infra/salary.ts'), inv.invoice, '2000'], { cwd: ROOT, stdio: 'inherit', env: process.env })
    for (let i = 0; i < 20 && (await rgb.balance(assetId)).settled < 2_000_000_000; i++) { await rgb.refresh(null); await wait(2000) }
    assert.equal((await rgb.balance(assetId)).settled, 2_000_000_000)

    const principal = 100_000_000
    const offer = await agent.findOffer({ principal, timeoutMs: 60_000 })
    const ask = await agent.ask(principal, offer.payload.apr_bps, offer.payload.term_blocks)
    assert.ok(ask.btc_available >= ask.collateral_sats)
    const consentOk = await agent.recordApproval('consent', { offer_id: offer.id, lender_pk: offer.lender_pk, principal_micro: principal })
    assert.ok(verifyObject(consentOk, key.pubkey))
    const sandbox = await agent.runSandbox(offer, principal)
    assert.deepEqual(sandbox.result.checks.filter((c) => !c.ok).map((c) => c.id), [])
    await agent.apply(offer, principal, sandbox, agent.approve(sandbox.result))
    const accepted = await agent.awaitAcceptance(offer, principal)
    const preview = agent.splitPreview(accepted.loan_id)
    assert.ok(preview.lender_sats_on_default > 0)
    assert.ok(verifyObject(await agent.recordApproval('lock', { loan_id: accepted.loan_id, terms_hash: accepted.loan_id, collateral_sats: accepted.terms.collateral_sats }), key.pubkey))
    const lock = await agent.lockAndSplit(accepted.loan_id)
    const funding = await agent.awaitFunding(accepted.loan_id)
    assert.equal((await rgb.balance(assetId)).settled, 2_000_000_000 + principal)
    await agent.recordApproval('repay', { loan_id: accepted.loan_id, repay_micro: debtOf(accepted.terms) })
    const repayment = await agent.repay(accepted.loan_id)
    if (state.loans[accepted.loan_id].iou) await agent.awaitIouReturn(accepted.loan_id)
    const release = await agent.release(accepted.loan_id)
    const tx = await chain.getTx(release)
    assert.ok(tx?.height, 'release confirmed')
    assert.ok(tx!.outputs.some((o) => o.script === key.btc.script), 'release pays the phone\'s own key')
    const verified = await verifyPassbook(state.passbook!, chain)
    assert.equal(verified.pages.length, 1)
    assert.ok(verified.document_valid)
    // the laptop dashboard follows the phone by the same note titles as a laptop borrower
    for (const t of ['Offer found in the order book', 'Sandbox result received', 'Application sent to the lender (NIP-44)', 'Terms checked and accepted', 'Collateral locked with the terms hash in OP_RETURN', 'USDT received over RGB; loan open', 'Repaid over RGB', 'Collateral released; passbook page stamped']) assert.ok(steps.includes(t), `missing wire note: ${t}`)
    console.log(JSON.stringify({ borrower_pk: key.pubkey, loan_id: accepted.loan_id, lock_txid: lock.lock_txid, disbursement_txid: funding, repayment_txid: repayment, release_txid: release, debt_micro: debtOf(accepted.terms), ladder: verified.ladder }))
  } finally {
    relay.close()
    await m.close()
  }
})
