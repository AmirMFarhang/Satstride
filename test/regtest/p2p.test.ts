// Real Nostr, RGB issue/sale/return, signed portable history, and API-off repayment.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Agent } from '../../src/agents/agent.js'
import { Regtest } from '../../src/chain/regtest.js'
import { BitcoindChain } from '../../src/chain/bitcoind.js'
import { debtOf } from '../../src/core/terms.js'
import { verifyPassbook, type PassbookDocument } from '../../src/registry/passbook-doc.js'
import { openParty } from '../../src/wallet/party.js'

describe('P2P note and platform-off repayment on regtest', () => {
  it('sells a real IOU, pays its new holder, returns it, and verifies the passbook while the API is off', async () => {
    const started = performance.now()
    const dir = mkdtempSync(join(tmpdir(), 'passbook-p2p-'))
    const { PLATFORM_SECRET: _own, ...inherited } = process.env
    const env = { ...inherited, PASSBOOK_WALLETS: join(dir, 'wallets'), PASSBOOK_STATE: join(dir, 'state.json'), PASSBOOK_DB: ':memory:', PORT: '0' }
    try {
      const seed = spawnSync('npx', ['tsx', 'infra/seed.ts'], { env, encoding: 'utf8', timeout: 300_000 })
      assert.equal(seed.status, 0, seed.stdout + seed.stderr)
      const demo = spawnSync('npx', ['tsx', 'src/cli/demo.ts', '--platform-off', '--iou-sale'], { env, encoding: 'utf8', timeout: 400_000 })
      const out = demo.stdout.replace(/\x1b\[[0-9;]*m/g, '')
      assert.equal(demo.status, 0, out + demo.stderr)
      assert.match(out, /PB-IOU sold over Nostr\/RGB; repayment invoice now belongs/)
      assert.match(out, /platform API OFF/)
      assert.match(out, /Index warning: repaid.*503/)
      assert.match(out, /Index warning: release.*503/)
      assert.match(out, /platform-off verified locally: 55% LTV; assurance signed_rgb_receipt/)
      assert.match(out, /PB-IOU returned over RGB [0-9a-f]{64}/)
      const doc = JSON.parse(readFileSync(join(dir, 'wallets/borrower/passbook.json'), 'utf8')) as PassbookDocument
      const pb = await verifyPassbook(doc, BitcoindChain.fromEnv())
      assert.equal(pb.unverified, 0)
      assert.equal(pb.ladder.step, 1)
      assert.equal(pb.pages[0].outcome, 'on_time')
      assert.equal(pb.pages[1].outcome, 'open')
      const proof = doc.pages[0].repayment
      assert.equal(proof?.kind, 'rgb_receipt')
      if (proof?.kind !== 'rgb_receipt' || !proof.ownership) throw new Error('sale ownership missing from portable page')
      const owner = proof.ownership
      const writeReport = () => { if (process.env.PASSBOOK_P2P_REPORT) writeFileSync(process.env.PASSBOOK_P2P_REPORT, JSON.stringify({ chain: 'regtest', measured_at: new Date().toISOString(), total_ms: Math.round(performance.now() - started), assurance: pb.assurance[0], loan_id: owner.certificate.loan_id, note_asset_id: owner.certificate.asset_id, note_supply: owner.certificate.amount, precision: 6, ticker: 'PBIOU', lock_txid: owner.certificate.lock_txid, issuance_transfer_txid: owner.certificate.issuance_transfer_txid, assignments: owner.assignments, repayment_txid: proof.receipt.repayment_txid, release_txid: doc.pages[0].outcome_txid, note_return_txid: out.match(/PB-IOU returned over RGB ([0-9a-f]{64})/)?.[1], next_ltv_bps: pb.ladder.allowed_ltv_bps, platform_offline: true }, null, 2) + '\n') }
      assert.equal(owner.assignments.length, 1)
      assert.equal(proof.receipt.validator_pk, owner.holder_pk)
      assert.notEqual(owner.holder_pk, doc.pages[0].terms.lender_pk)
      const borrower = await openParty('borrower', { dir: join(dir, 'wallets') })
      const seller = await openParty('lender1', { dir: join(dir, 'wallets') })
      const buyer = await openParty('lender2', { dir: join(dir, 'wallets') })
      try {
        for (const p of [borrower, seller, buyer]) p.rgb.refresh()
        const amount = debtOf(doc.pages[0].terms)
        assert.equal(borrower.rgb.balance(owner.certificate.asset_id).settled, amount, 'full NIA note returned to borrower')
        assert.equal(seller.rgb.balance(owner.certificate.asset_id).settled, 0)
        assert.equal(buyer.rgb.balance(owner.certificate.asset_id).settled, 0)
        const agent = new Agent({ party: buyer, mine: () => new Regtest().mine(1) })
        try { assert.ok(!(await agent.iou.sales()).some((s) => s.ownership.certificate.loan_id === owner.certificate.loan_id), 'closed notes cannot be resold from stale relay listings') } finally { agent.close() }
      } finally { borrower.close(); seller.close(); buyer.close() }
      writeReport()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
