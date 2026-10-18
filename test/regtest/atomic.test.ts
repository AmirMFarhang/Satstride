// Leaf E is always tested against Bitcoin. The separate opt-in suite uses
// real RLN daemons and the same RGB asset as the WDK disbursement.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { schnorr } from '@noble/curves/secp256k1.js'
import { tapleafHash } from 'bitcoinjs-lib/src/payments/bip341'
import { Regtest } from '../../src/chain/regtest.js'
import { hexToBytes, randomHex, randomKeyPair, sha256Hex } from '../../src/core/crypto.js'
import type { LoanTerms } from '../../src/core/terms.js'
import { buildEscrowSpend, buildLock, escrowFor, extractHex, finalizeEscrowSpend, keyPathOutput, partiesOf, releaseOutputs, signKeyPath, signLeaf } from '../../src/escrow/escrow.js'
import { Oracle } from '../../src/oracle/oracle.js'

describe('atomic leaf E on real regtest (script only, no Lightning)', () => {
  it('accepts the right secret and rejects the wrong secret or a lender signature', async () => {
    const regtest = new Regtest()
    await regtest.ensureMiner()
    const borrower = randomKeyPair(), lender = randomKeyPair(), platform = randomKeyPair()
    const preimage = randomHex(32)
    const fundingTxid = await regtest.fund(keyPathOutput(borrower.pubkey).address, 0.05)
    const funding = (await regtest.chain.getTx(fundingTxid))!
    const vout = funding.outputs.findIndex((o) => o.script === keyPathOutput(borrower.pubkey).script)
    const height = await regtest.chain.getHeight()
    const t: LoanTerms = { v: 2, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:script-test-only', principal: 600_000_000, fee: 6_000_000, collateral_sats: 2_000_000, oracle_quote: new Oracle(platform, 10_000_000).quote(height), open_height: height, maturity_height: height + 30, grace_blocks: 5, recovery_height: height + 55, ladder_step: 0, ltv_bps: 3030, prev_passbook_txid: null, nonce: randomHex(32), atomic_repayment: { invoice: 'lnbcrt-script-test-only', btc_amount_msat: 3_000_000, payment_hash: sha256Hex(hexToBytes(preimage)), expires_at: Math.floor(Date.now() / 1000) + 2_592_000, payee_pubkey: `02${lender.pubkey}` } }
    const lock = buildLock({ inputs: [{ txid: fundingTxid, vout, value: funding.outputs[vout].value, internal_pk: borrower.pubkey }], terms: t, changeScript: keyPathOutput(borrower.pubkey).script })
    signKeyPath(lock, borrower.secretKey).finalizeAllInputs()
    const lockTxid = await regtest.chain.rpc<string>('sendrawtransaction', [extractHex(lock)])
    await regtest.mine(1)
    const parties = partiesOf(t)
    const release = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: t.collateral_sats }, parties, leaf: 'E', outputs: releaseOutputs(t) })
    signLeaf(release, parties, 'E', borrower.secretKey)
    finalizeEscrowSpend(release, parties, 'E', preimage)
    const tx = release.extractTransaction()
    const verdict = async (raw: string) => (await regtest.chain.rpc<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[raw]]))[0]
    const wrongSecret = bitcoin.Transaction.fromHex(tx.toHex())
    wrongSecret.ins[0].witness[1] = hexToBytes(randomHex(32))
    assert.equal((await verdict(wrongSecret.toHex())).allowed, false, 'consensus enforces SHA256 preimage')
    const wrongKey = bitcoin.Transaction.fromHex(tx.toHex())
    const leaf = escrowFor(parties).leaves.E!
    const sighash = tx.hashForWitnessV1(0, [hexToBytes(escrowFor(parties).script)], [BigInt(t.collateral_sats)], bitcoin.Transaction.SIGHASH_DEFAULT, tapleafHash({ output: leaf.script, version: 0xc0 }))
    wrongKey.ins[0].witness[0] = schnorr.sign(sighash, lender.secretKey)
    assert.equal((await verdict(wrongKey.toHex())).allowed, false, 'consensus requires borrower signature')
    assert.equal((await verdict(tx.toHex())).allowed, true)
    const txid = await regtest.chain.rpc<string>('sendrawtransaction', [tx.toHex()])
    await regtest.mine(1)
    const raw = await regtest.chain.rpc<{ confirmations: number; vin: { txinwitness: string[] }[] }>('getrawtransaction', [txid, true])
    assert.ok(raw.confirmations >= 1)
    assert.equal(raw.vin[0].txinwitness[1], preimage, 'public preimage is read back from bitcoind')
  })
})

describe('real RGB Lightning atomic loan', { skip: !process.env.PASSBOOK_ATOMIC_LIVE }, () => {
  it('WDK asset → RGB channel → invoice paid → borrower-only E release with public preimage', { timeout: 300_000 }, async () => {
    const { runAtomicSpike } = await import('../../infra/lightning-spike.js')
    const result = await runAtomicSpike()
    assert.equal(result.status, 'paid_and_released')
  })

  it('full Nostr agents repay, return the IOU and verify the next limit with the platform off', { timeout: 400_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-atomic-peers-'))
    const { PLATFORM_SECRET: _platformSecret, ...inherited } = process.env
    const env = { ...inherited, PASSBOOK_WALLETS: join(dir, 'wallets'), PASSBOOK_STATE: join(dir, 'state.json'), PASSBOOK_DB: ':memory:', PORT: '0' }
    try {
      const seed = spawnSync('npx', ['tsx', 'infra/seed.ts'], { env, encoding: 'utf8', timeout: 180_000 })
      assert.equal(seed.status, 0, seed.stdout + seed.stderr)
      const demo = spawnSync('npx', ['tsx', 'src/cli/demo.ts', '--atomic', '--platform-off'], { env, encoding: 'utf8', timeout: 180_000 })
      const output = demo.stdout.replace(/\x1b\[[0-9;]*m/g, '')
      assert.equal(demo.status, 0, output + demo.stderr)
      assert.match(output, /no co-signer needed; leaf E release [0-9a-f]{64}/)
      assert.match(output, /PB-IOU returned over RGB [0-9a-f]{64}/)
      assert.match(output, /platform-off verified locally: 55% LTV; assurance bitcoin_hashlock/)
      const { verifyPassbook } = await import('../../src/registry/passbook-doc.js')
      const doc = JSON.parse(readFileSync(join(dir, 'wallets', 'borrower', 'passbook.json'), 'utf8'))
      const book = await verifyPassbook(doc, new Regtest().chain)
      assert.equal(book.unverified, 0)
      assert.equal(book.pages[0].outcome, 'on_time')
      assert.equal(book.assurance[0], 'bitcoin_hashlock')
      assert.equal(book.ladder.allowed_ltv_bps, 5500)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
