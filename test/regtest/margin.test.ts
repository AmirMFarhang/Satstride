// The margin-call scenario on regtest, both branches, on the same seeded wallets:
// `npm run demo -- --scenario margin` (the cure window runs out at 82% LTV and
// lender + platform liquidate through leaf B), then `--scenario cure` (the price
// recovers inside the window, the call clears, the loan is repaid and released).
// The second run reuses the borrower's wallet, so its sandbox also has to label
// the first run's loan disbursement. Throwaway wallet and state locations, as in
// e2e.test.ts. Needs `infra/regtest.sh start`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BitcoindChain } from '../../src/chain/bitcoind.js'
import { keyPathOutput } from '../../src/escrow/escrow.js'
import type { SeedState } from '../../src/wallet/state.js'
import { assertFeePaid } from './fee-assert.js'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('margin call on regtest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-margin-'))
  const { PLATFORM_SECRET: _own, ...inherited } = process.env
  const env = { ...inherited, PASSBOOK_WALLETS: join(dir, 'wallets'), PASSBOOK_STATE: join(dir, 'state.json'), PORT: '0' }
  const chain = BitcoindChain.fromEnv()
  const demo = (scenario: string) => {
    const r = spawnSync('npx', ['tsx', 'src/cli/demo.ts', '--scenario', scenario], { env, encoding: 'utf8', timeout: 400_000 })
    const out = strip(r.stdout)
    assert.equal(r.status, 0, out + r.stderr)
    for (let n = 1; n <= 11; n++) assert.match(out, new RegExp(`^${n}\\. `, 'm'), `step ${n} ran`)
    return out
  }

  before(() => {
    const seed = spawnSync('npx', ['tsx', 'infra/seed.ts'], { env, encoding: 'utf8', timeout: 300_000 })
    assert.equal(seed.status, 0, seed.stdout + seed.stderr)
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('liquidates through leaf B after the cure window, paying the lender exactly the debt and the borrower the rest', async () => {
    const out = demo('margin')
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as SeedState
    assert.match(out, /platform margin call at height \d+; cure until \d+; LTV 82\.\d+% \(liquidatable\)/)
    assert.match(out, /note for the borrower: .*The lender may now liquidate\./)
    assert.match(out, /liquidation due/)
    const lock = out.match(/^ {2}lock ([0-9a-f]{64})$/m)?.[1]
    const liq = out.match(/^ {2}liquidation ([0-9a-f]{64})$/m)?.[1]
    assert.ok(lock && liq, 'lock and liquidation txids printed')

    // read the liquidation back from bitcoind: confirmed, spends the escrow, pays lender1 then the borrower
    const tx = await chain.getTx(liq!)
    assert.ok(tx?.height, 'liquidation confirmed')
    assert.deepEqual(tx!.inputs.map(({ txid, vout }) => ({ txid, vout })), [{ txid: lock!, vout: 0 }])
    assert.equal(tx!.outputs[0].script, keyPathOutput(state.parties.lender1.pubkey).script)
    assert.equal(tx!.outputs[1].script, keyPathOutput(state.parties.borrower.pubkey).script)
    assert.ok(tx!.outputs[1].value > 0)
    assert.match(out, /passbook page 1: liquidated, verified \{"lock":true,"terms_commitment":true,"collateral_amount":true,"collateral_script":true,"close":true,"chain_link":true\}; ladder step 0/)
    assert.match(out, /^done: margin call, cure window expired, leaf B liquidation/m)
    assert.match(out, /to lender1 \(exactly the debt, no penalty\)/)
    assertFeePaid(out, 'liquidated')
  })

  it('clears the margin call when the price recovers inside the window, then repays and releases on a reused wallet', () => {
    const out = demo('cure')
    // the first run's disbursement is in this wallet's history now; the sandbox must label it, not leave it unknown
    assert.match(out, /^ {2}categories: .*loan_disbursement 1\b/m)
    assert.match(out, /^ {2}ok {3}categorise /m)
    assert.match(out, /margin call cleared; liquidation not due/)
    assert.match(out, /passbook page 2: on_time/)
    assert.match(out, /^done: margin call cleared inside the cure window; repaid and released on time/m)
    assertFeePaid(out, 'repaid on time')
  })
})
