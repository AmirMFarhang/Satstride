// The acceptance run: `npm run seed` then `npm run demo` against the live
// regtest stack, in throwaway wallet and state locations so the developer's own
// infra/wallets and infra/state.json are untouched. Needs `infra/regtest.sh start`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { assertFeePaid } from './fee-assert.js'

describe('seed and demo on regtest', () => {
  it('runs the ten steps end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-e2e-'))
    const { PLATFORM_SECRET: _own, ...inherited } = process.env
    const env = { ...inherited, PASSBOOK_WALLETS: join(dir, 'wallets'), PASSBOOK_STATE: join(dir, 'state.json'), PORT: '0' }
    try {
      const seed = spawnSync('npx', ['tsx', 'infra/seed.ts'], { env, encoding: 'utf8', timeout: 300_000 })
      assert.equal(seed.status, 0, seed.stdout + seed.stderr)
      const demo = spawnSync('npx', ['tsx', 'src/cli/demo.ts'], { env, encoding: 'utf8', timeout: 400_000 })
      const out = demo.stdout.replace(/\x1b\[[0-9;]*m/g, '')
      assert.equal(demo.status, 0, out + demo.stderr)
      for (let n = 1; n <= 10; n++) assert.match(out, new RegExp(`^${n}\\. `, 'm'), `step ${n} ran`)
      // W1: the first loan is negotiated, bound to a term sheet and approved by both sides before anything moves.
      assert.match(out, /negotiation +\d+ signed, hash-chained messages ending in ACCEPT/, 'the lender verified the negotiation')
      assert.match(out, /term sheet approved by the terminal run \(no dashboard\): lender/, 'lender approval, labelled')
      assert.match(out, /term sheet approved by the terminal run \(no dashboard\): borrower countersigned/, 'borrower approval, labelled')
      assert.match(out, /Both approvals of the term sheet verified/, 'the lender checked both approvals before funding')
      // PASSBOOK_MAKER_CHECKER_USDT below the 600 USDT loan: a second lender key approves, and the borrower checked both before locking.
      const makerChecker = Number(process.env.PASSBOOK_MAKER_CHECKER_USDT ?? 0)
      if (makerChecker > 0 && makerChecker < 600) assert.match(out, /term sheet approved by the terminal run \(no dashboard\): lender and second approver/, 'maker-checker: two lender approvals')
      assert.match(out, /passbook page 1: on_time/)
      assert.match(out, /allowed LTV now 55%/)
      const release = out.match(/release {6}([0-9a-f]{64})/)?.[1]
      assert.ok(release, 'release txid printed')
      assert.match(out, new RegExp(`lock spends ${release!.slice(0, 12)}:0`), 'second lock spends the first release')
      assert.match(out, /^done: /m)
      assertFeePaid(out, 'repaid on time')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
