// Local checkpoint boundaries only. Native wallet files below are labelled
// dummy markers; RgbWallet.open is mocked. No service, mining or RGB wallet runs.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, mock } from 'node:test'
import { LenderAgent, L2_POLICY, type LenderCheckpoint } from '../src/agents/lender.js'
import type { Relay } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { keyPairFromLabel, signObject, type KeyPair } from '../src/core/crypto.js'
import { debtOf, termsHash, type LoanTerms } from '../src/core/terms.js'
import { signOwnership } from '../src/market/iou.js'
import { Oracle } from '../src/oracle/oracle.js'
import { rgbRepaymentReceipt } from '../src/registry/passbook-doc.js'
import { RgbWallet } from '../src/rgb/wallet.js'
import { repaymentMnemonic, watchKeys } from '../src/rgb/watch.js'
import type { Party } from '../src/wallet/party.js'

const lender = keyPairFromLabel('checkpoint-lender'), borrower = keyPairFromLabel('checkpoint-borrower'), platform = keyPairFromLabel('checkpoint-platform')
function terms(nonce = 'ab'.repeat(32)): LoanTerms {
  return { v: 1, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:checkpoint-unit', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000, oracle_quote: new Oracle(platform, 10_000_000).quote(100), open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce }
}
function snapshot(t = terms(), key = lender): LenderCheckpoint {
  return { v: 1, asset_id: t.asset_id, pubkey: key.pubkey, loans: [[termsHash(t), { terms: t, borrower_pk: t.borrower_pk, disbursement_attempted: true, has_repayment_account: false }]] }
}
function fixture(key: KeyPair = lender) {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-lender-checkpoint-'))
  let receives = 0, sends = 0
  const party = { role: 'lender1', key, rgb: { dataDir: join(dir, 'rgb'), send: async () => { sends++; throw new Error('unit must never send') } } } as unknown as Party
  const relay = { receive: async () => { receives++; throw new Error('unit must never receive') }, close() {} } as unknown as Relay
  const agent = new LenderAgent({ party, relay, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: 'rgb:checkpoint-unit', mine: async () => { throw new Error('unit must never mine') } })
  return { agent, dir, receives: () => receives, sends: () => sends, dispose() { agent.close(); rmSync(dir, { recursive: true, force: true }) } }
}
async function nativeMarkers(dir: string, id: string, key = lender): Promise<string> {
  const account = join(dir, 'loans', id, 'rgb')
  const keys = await watchKeys(repaymentMnemonic(key.secretKey, id))
  for (const file of ['rgb_lib_db', 'bdk_db_watch_only', 'rgb/state.dat', 'rgb/stash.dat', 'rgb/index.dat']) {
    const path = join(account, keys.master_fingerprint, file)
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'synthetic unit marker, not native wallet data', { mode: 0o600 })
  }
  return account
}
function account(dataDir: string) {
  let closes = 0
  return { wallet: { dataDir, secret: 'NEVER_EXPORT_NATIVE_SECRET', close() { closes++ } } as unknown as RgbWallet, closes: () => closes }
}

describe('lender local demo checkpoints', () => {
  it('round trips detached JSON data and preserves the attempted-send guard', async () => {
    const f = fixture()
    try {
      const saved = snapshot(), id = saved.loans[0][0]
      await f.agent.restoreCheckpoint(saved)
      saved.loans[0][1].terms.principal = 1
      const exported = f.agent.exportCheckpoint()
      assert.equal(exported.loans[0][1].terms.principal, 600_000_000)
      exported.loans[0][1].terms.fee = 0
      assert.equal(f.agent.exportCheckpoint().loans[0][1].terms.fee, 6_000_000)
      await assert.rejects(f.agent.fund(id), /disbursement already attempted/)
      assert.equal(f.receives(), 0); assert.equal(f.sends(), 0)
      const older = f.agent.exportCheckpoint(); older.loans[0][1].disbursement_attempted = false
      await assert.rejects(f.agent.restoreCheckpoint(older), /cannot clear an attempted/)
      assert.equal(f.agent.exportCheckpoint().loans[0][1].disbursement_attempted, true)
      assert.deepEqual(JSON.parse(JSON.stringify(f.agent.exportCheckpoint())), f.agent.exportCheckpoint())
    } finally { f.dispose() }
  })

  it('rejects owner, asset, ID, borrower, lender, version and duplicate mismatches atomically', async () => {
    const f = fixture()
    try {
      await f.agent.restoreCheckpoint(snapshot())
      const original = f.agent.exportCheckpoint()
      const attacks: ((s: LenderCheckpoint) => void)[] = [
        (s) => { s.pubkey = borrower.pubkey }, (s) => { s.asset_id = 'rgb:other' },
        (s) => { s.v = 2 as 1 }, (s) => { s.loans[0][0] = 'ff'.repeat(32) },
        (s) => { s.loans[0][1].borrower_pk = lender.pubkey },
        (s) => { s.loans[0][1].terms.asset_id = 'rgb:other'; s.loans[0][0] = termsHash(s.loans[0][1].terms) },
        (s) => { s.loans[0][1].terms.lender_pk = borrower.pubkey; s.loans[0][0] = termsHash(s.loans[0][1].terms) },
        (s) => { s.loans.push(structuredClone(s.loans[0])) },
      ]
      for (const attack of attacks) {
        const s = structuredClone(original); attack(s)
        await assert.rejects(f.agent.restoreCheckpoint(s))
        assert.deepEqual(f.agent.exportCheckpoint(), original)
      }
    } finally { f.dispose() }
  })

  it('rejects malformed primitives, native objects and repayment receipt bindings', async () => {
    const f = fixture()
    try {
      const good = snapshot(), id = good.loans[0][0]
      good.loans[0][1].lock = { txid: '11'.repeat(32), vout: 0 }
      good.loans[0][1].repayment_txid = '22'.repeat(32)
      good.loans[0][1].repayment_receipt = rgbRepaymentReceipt(lender, good.loans[0][1].terms, '22'.repeat(32), debtOf(good.loans[0][1].terms))
      await f.agent.restoreCheckpoint(good)
      const attacks: ((l: Record<string, unknown>) => void)[] = [
        (l) => { l.disbursement_attempted = 'false' }, (l) => { l.has_repayment_account = 1 },
        (l) => { l.has_repayment_account = true; l.disbursement_attempted = false },
        (l) => { l.repayment_txid = 'not-a-txid' }, (l) => { l.repayment_recipient_id = {} },
        (l) => { l.lock = { txid: '11'.repeat(32), vout: -1 } },
        (l) => { l.repayment_account = { secret: 'no native objects' } },
        (l) => { l.repayment_receipt = { ...good.loans[0][1].repayment_receipt, loan_id: '00'.repeat(32) } },
        (l) => { l.repayment_receipt = { ...good.loans[0][1].repayment_receipt, amount: NaN } },
      ]
      for (const attack of attacks) {
        const s = structuredClone(good); attack(s.loans[0][1] as unknown as Record<string, unknown>)
        await assert.rejects(f.agent.restoreCheckpoint(s))
        assert.deepEqual(f.agent.exportCheckpoint(), good)
      }
      await assert.rejects(f.agent.fund(id), /already attempted/)
    } finally { f.dispose() }
  })

  it('requires the existing native fingerprint files before calling the wallet opener', async () => {
    const f = fixture(), open = mock.method(RgbWallet, 'open', async () => { throw new Error('opener must not run') })
    try {
      const s = snapshot(); s.loans[0][1].has_repayment_account = true
      await assert.rejects(f.agent.restoreCheckpoint(s), /ENOENT|existing/i)
      const path = await nativeMarkers(f.dir, s.loans[0][0])
      const keys = await watchKeys(repaymentMnemonic(lender.secretKey, s.loans[0][0]))
      rmSync(join(path, keys.master_fingerprint, 'rgb/stash.dat'))
      await assert.rejects(f.agent.restoreCheckpoint(s), /ENOENT|existing/i)
      assert.equal(open.mock.callCount(), 0)
      assert.equal(f.agent.exportCheckpoint().loans.length, 0)
    } finally { open.mock.restore(); f.dispose() }
  })

  it('reopens an existing account without exporting it, reuses it, and closes it once', async () => {
    const f = fixture(), s = snapshot(), path = await nativeMarkers(f.dir, s.loans[0][0]), a = account(path)
    s.loans[0][1].has_repayment_account = true
    const open = mock.method(RgbWallet, 'open', async (mnemonic: string, dir: string) => { assert.equal(mnemonic, repaymentMnemonic(lender.secretKey, s.loans[0][0])); assert.equal(dir, path); return a.wallet })
    try {
      await f.agent.restoreCheckpoint(s)
      const exported = f.agent.exportCheckpoint()
      assert.equal(JSON.stringify(exported).includes('NEVER_EXPORT_NATIVE_SECRET'), false)
      assert.equal('repayment_account' in exported.loans[0][1], false)
      assert.equal(exported.loans[0][1].has_repayment_account, true)
      await f.agent.restoreCheckpoint(exported)
      assert.equal(open.mock.callCount(), 1); assert.equal(a.closes(), 0)
      await f.agent.restoreCheckpoint({ ...snapshot(), loans: [] })
      assert.equal(a.closes(), 1)
      f.agent.close(); f.agent.close(); assert.equal(a.closes(), 1)
    } finally { open.mock.restore(); f.dispose() }
  })

  it('validates every loan before opening any and rolls back a failed second account open', async () => {
    const f = fixture(), s = snapshot(), second = snapshot(terms('cd'.repeat(32)))
    s.loans.push(second.loans[0])
    for (const [id, loan] of s.loans) { loan.has_repayment_account = true; await nativeMarkers(f.dir, id) }
    const original = snapshot(terms('ef'.repeat(32)))
    original.loans[0][1].has_repayment_account = true
    const oldPath = await nativeMarkers(f.dir, original.loans[0][0]), old = account(oldPath)
    const first = account(join(f.dir, 'loans', s.loans[0][0], 'rgb'))
    let calls = 0
    const open = mock.method(RgbWallet, 'open', async (_mnemonic: string, dir: string) => { if (dir === oldPath) return old.wallet; if (++calls === 2) throw new Error('SECOND_OPEN_FAILED'); return first.wallet })
    try {
      await f.agent.restoreCheckpoint(original)
      const before = f.agent.exportCheckpoint(), malformed = structuredClone(s)
      malformed.loans[1][1].has_repayment_account = 'true' as unknown as boolean
      await assert.rejects(f.agent.restoreCheckpoint(malformed), /guard flag/)
      assert.equal(calls, 0)
      await assert.rejects(f.agent.restoreCheckpoint(s), /SECOND_OPEN_FAILED/)
      assert.deepEqual(f.agent.exportCheckpoint(), before)
      assert.equal(first.closes(), 1)
      assert.equal(old.closes(), 0)
      f.agent.close(); assert.equal(first.closes(), 1); assert.equal(old.closes(), 1)
    } finally { open.mock.restore(); f.dispose() }
  })

  it('closes a newly opened account when shutdown races an asynchronous restore', async () => {
    const f = fixture(), s = snapshot(), path = await nativeMarkers(f.dir, s.loans[0][0]), a = account(path)
    s.loans[0][1].has_repayment_account = true
    let release!: (wallet: RgbWallet) => void, entered!: () => void
    const opening = new Promise<RgbWallet>((resolve) => { release = resolve }), started = new Promise<void>((resolve) => { entered = resolve })
    const open = mock.method(RgbWallet, 'open', async () => { entered(); return opening })
    try {
      const restore = f.agent.restoreCheckpoint(s)
      await started
      f.agent.close(); release(a.wallet)
      await assert.rejects(restore, /closed during/)
      assert.equal(a.closes(), 1)
      assert.deepEqual(f.agent.exportCheckpoint().loans, [])
      await assert.rejects(f.agent.restoreCheckpoint(s), /closed/)
    } finally { open.mock.restore(); f.dispose() }
  })

  it('preserves atomic invoice fields without making a Lightning call', async () => {
    const f = fixture(), t = terms()
    t.v = 2
    t.atomic_repayment = { invoice: 'lnbcrt-checkpoint-unit-only', btc_amount_msat: 3_000_000, payment_hash: '55'.repeat(32), expires_at: 2_000_000_000, payee_pubkey: `02${lender.pubkey}` }
    const s = snapshot(t)
    try {
      await f.agent.restoreCheckpoint(s)
      assert.deepEqual(f.agent.exportCheckpoint(), s)
      assert.equal(f.receives(), 0); assert.equal(f.sends(), 0)
    } finally { f.dispose() }
  })

  it('preserves an authenticated local IOU ownership snapshot and rejects forged ownership', async () => {
    const f = fixture(), s = snapshot(), t = s.loans[0][1].terms, id = s.loans[0][0]
    const certificate = signObject({ domain: 'passbook-iou-v1' as const, loan_id: id, asset_id: 'rgb:iou-unit', amount: debtOf(t), issuer_pk: borrower.pubkey, initial_holder_pk: lender.pubkey, issuance_transfer_txid: '33'.repeat(32), lock_txid: '44'.repeat(32), lock_vout: 0 }, borrower.secretKey)
    s.loans[0][1].assigned_owner = signOwnership(lender, certificate, [])
    try {
      await f.agent.restoreCheckpoint(s)
      assert.deepEqual(f.agent.exportCheckpoint(), s)
      const bad = structuredClone(s); bad.loans[0][1].assigned_owner!.holder_pk = borrower.pubkey
      await assert.rejects(f.agent.restoreCheckpoint(bad), /holder/)
      assert.deepEqual(f.agent.exportCheckpoint(), s)
    } finally { f.dispose() }
  })
})
