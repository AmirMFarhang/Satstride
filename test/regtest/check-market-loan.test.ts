// The loan demo with --check-market on regtest (docs/CHECK-MARKET.md): seed,
// then the demo whose negotiated loan's credit check is bought from a check
// node over RGB Lightning (HODL invoice) instead of the platform sandbox. The
// lender takes the check only from the forwarded K (verifyForwardedCheck), the
// term sheet binds the run record digest and names the receipt's contract id,
// and the loan funds, repays and releases. Throwaway wallets and state.
//
// Opt-in: the demo chain must also run the three HODL RGB Lightning nodes of
// infra/compose.checks.yaml, i.e. the check-market stack:
//   infra/check-market.sh start && eval "$(infra/check-market.sh env)"
//   PASSBOOK_CHECK_MARKET_LIVE=1 npx tsx --test test/regtest/check-market-loan.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BitcoindChain } from '../../src/chain/bitcoind.js'
import type { CheckMarketRecord } from '../../src/checknode/market.js'
import type { TermSheet } from '../../src/market/termsheet.js'

describe('loan demo with the credit check bought on the check market', { skip: !process.env.PASSBOOK_CHECK_MARKET_LIVE && 'PASSBOOK_CHECK_MARKET_LIVE not set' }, () => {
  it('picks B in the structure step, pays it over RGB Lightning, the lender verifies the forwarded K, the sheet names the receipt, the loan funds and repays', { timeout: 1_200_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-check-loan-'))
    const { PLATFORM_SECRET: _own, PASSBOOK_DB: _db, PASSBOOK_DEMO_CHECKPOINT: _cp, ...inherited } = process.env
    const env = { ...inherited, PASSBOOK_WALLETS: join(dir, 'wallets'), PASSBOOK_STATE: join(dir, 'state.json'), PORT: '0', PASSBOOK_CHECK_MARKET_RECORD: join(dir, 'check-record.json') }
    try {
      const seed = spawnSync('npx', ['tsx', 'infra/seed.ts'], { env, encoding: 'utf8', timeout: 300_000 })
      assert.equal(seed.status, 0, seed.stdout + seed.stderr)
      const demo = spawnSync('npx', ['tsx', 'src/cli/demo.ts', '--check-market', '--scorer-out', join(dir, 'scored')], { env, encoding: 'utf8', timeout: 1_000_000 })
      const out = demo.stdout.replace(/\x1b\[[0-9;]*m/g, '')
      // Kept for the record before the assertions, so a failed run still leaves its evidence.
      if (process.env.PASSBOOK_CHECK_LOAN_OUT) {
        const { writeFileSync, mkdirSync } = await import('node:fs')
        mkdirSync(process.env.PASSBOOK_CHECK_LOAN_OUT, { recursive: true })
        writeFileSync(join(process.env.PASSBOOK_CHECK_LOAN_OUT, 'demo.log'), out + demo.stderr)
        for (const f of ['termsheet.json', 'check.json', 'funding.json', 'repayment.json', 'approvals.json']) if (existsSync(join(dir, 'scored', f))) copyFileSync(join(dir, 'scored', f), join(process.env.PASSBOOK_CHECK_LOAN_OUT, f))
      }
      assert.equal(demo.status, 0, out + demo.stderr)
      for (let n = 1; n <= 10; n++) assert.match(out, new RegExp(`^${n}\\. `, 'm'), `step ${n} ran`)
      const negotiate = out.slice(out.search(/^4\. /m), out.search(/^5\. /m))
      const check = out.slice(out.search(/^5\. /m), out.search(/^6\. /m))
      assert.match(out, /check node A: operator [0-9a-f]{12}… \(demo key \(publicly derivable, regtest only\)\), 0\.8 USDT, no TEE: software evidence, bond designed, not live/)
      assert.match(out, /check node B: operator [0-9a-f]{12}… .*, 0\.5 USDT/)
      // The signed negotiation's structure step picks the node from both policies and the offers on the relay.
      assert.match(negotiate, /\[borrower\] Check-node offers read from the relay for the structure step/)
      assert.match(negotiate, /check node pick: .*Cheapest: 0\.50 USDT/, 'the structure step picked the cheaper node within the borrower\'s 0.60 cap')
      assert.match(negotiate, /check node pick: Not [0-9a-f]{8}: PRICE_ABOVE_MAX \(800000 > 600000\)/, 'A at 0.80 is over the borrower\'s cap')
      assert.match(check, /\[borrower\] Commitment and invoice checked before paying .*"locked_to_key":true/)
      assert.match(check, /paid 0\.50 USDT to check node [0-9a-f]{12}… from the borrower's own RGB Lightning node: RGB Lightning, HODL invoice: paying reveals K \(atomic\)/)
      assert.match(check, /K is the preimage of that paid HODL invoice/)
      assert.match(check, /\[borrower\] K forwarded to the lender \(KEY, NIP-44\)/)
      assert.doesNotMatch(check, /\[borrower\] Bundle encrypted to the sandbox key/, 'the platform sandbox does not score the negotiated loan')
      // The lender's own verification of the forwarded check.
      assert.match(out, /ok check:message-chain +\d+ messages, hash-chained and signed/)
      assert.match(out, /ok check:lender-rules +operator, release, trust and execution meet the lender's check-node rules/)
      assert.match(out, /ok check:key-binding +K is the preimage of the paid HODL invoice/)
      assert.match(out, /ok check:scorer:scored-loan /)
      assert.match(out, /ok check-verified +container \(FALLBACK\) evidence from check node [0-9a-f]{12}… verified by this lender at dev-inprocess/)
      assert.match(out, /ok consent-bound /)
      const digest = out.match(/term sheet [0-9a-f]{12} binds the check node's run record ([0-9a-f]{64})/)?.[1]
      assert.ok(digest, 'the term sheet names the run record digest')
      assert.match(out, /Both approvals of the term sheet verified/)
      assert.match(out, /^done: /m)

      const sheet = JSON.parse(readFileSync(join(dir, 'scored', 'termsheet.json'), 'utf8')) as TermSheet
      const record = JSON.parse(readFileSync(join(dir, 'scored', 'check.json'), 'utf8')) as CheckMarketRecord & { loan_id: string }
      const funding = JSON.parse(readFileSync(join(dir, 'scored', 'funding.json'), 'utf8')) as { loan_id: string; lock_txid: string; disbursement_txid: string }
      assert.ok(sheet.v === 2 && sheet.scorer.evidence?.kind === 'passbook-run-record' && sheet.scorer.evidence.run_record_sha256 === digest)
      assert.equal(sheet.scorer.provider, 'container')
      assert.equal(sheet.scorer.fallback, true, 'the node\'s container scorer is labelled as the fallback')
      assert.match(sheet.scorer.check_receipt?.contract_id ?? '', /^rgb:/, 'the sheet names the receipt next to the evidence digest')
      assert.equal(sheet.scorer.check_receipt?.commitment, record.paid?.commitment)
      assert.equal(sheet.scorer.check_receipt?.operator_pk, record.paid?.operator_pk)
      assert.equal(record.receipt?.contract_id, sheet.scorer.check_receipt?.contract_id)
      assert.equal(record.paid?.rail, 'rgb-ln-hodl')
      assert.equal(record.paid?.key_source, 'lightning-preimage')
      assert.equal(record.paid?.amount, 500_000)
      assert.ok(record.lender?.ok, JSON.stringify(record.lender?.ticks.filter((t) => !t.ok)))
      assert.equal(record.platform_cut, 0)
      assert.equal(record.loan_id, funding.loan_id)
      const chain = BitcoindChain.fromEnv()
      const lock = await chain.getTx(funding.lock_txid)
      assert.ok(lock?.height && lock.outputs.some((o) => o.script === `6a20${funding.loan_id}`), 'lock confirmed with the terms hash')
      assert.ok((await chain.getTx(funding.disbursement_txid))?.height, 'USDT disbursement confirmed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
