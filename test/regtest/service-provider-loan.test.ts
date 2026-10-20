// The funded loan on a lender-paid local scorer credit check, against the laptop service provider
// (docs/SERVICE-PROVIDER.md), on regtest with every piece real:
//   `infra/service-provider.sh up` with PASSBOOK_SP_PEER_ARGS="--provider --lender-pays-check --auto-approve ..."
// starts the lender peer (src/cli/peer.ts, lane P1): it negotiates over Nostr, pays the check node
// billed at close (runLenderCheck through payForCheck), underwrites only a verified
// QUALIFY, approves (labelled rehearsal auto-approve), funds and releases. The borrower is a separate
// process holding only Fatima's wallet and key (infra/service-provider-loan-borrower.ts): it
// negotiates, runs the browser-safe borrower half of the check, applies naming the forwarded KEY,
// checks the term sheet against the result it opened, locks, is funded, repays and releases.
//
//   PASSBOOK_SP_LENDERS=lender1 PASSBOOK_SP_PEER_ARGS="--provider --lender-pays-check --auto-approve --timeout-ms 3600000" infra/service-provider.sh up
//   PASSBOOK_SERVICE_PROVIDER_LIVE=1 PASSBOOK_SP_STATE=<state> npx tsx --test test/regtest/service-provider-loan.test.ts
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { BitcoindChain } from '../../src/chain/bitcoind.js'

const LIVE = process.env.PASSBOOK_SERVICE_PROVIDER_LIVE === '1'

describe('service provider: a phone borrower borrows on a lender-paid local scorer check', { skip: !LIVE && 'PASSBOOK_SERVICE_PROVIDER_LIVE not set' }, () => {
  it('negotiates over Nostr, the lender is billed for the check, only a verified QUALIFY is funded, then repaid and released', { timeout: 2_400_000 }, async () => {
    const state = resolve(process.env.PASSBOOK_SP_STATE!)
    const provider = JSON.parse(readFileSync(join(state, 'provider.json'), 'utf8'))
    const node = provider.check_nodes[0]
    const lenderPk: string = provider.lenders[0].pubkey
    const out = process.env.PASSBOOK_SP_PROOF_OUT ?? join(state, 'loan-proof')
    mkdirSync(out, { recursive: true })
    const wallets = join(state, 'wallets')
    // Fatima's history was observed from zero by the platform's trusted observer; she carries its signed proof as data.
    const proofFile = join(out, 'history-proof.json')
    const made = spawnSync('npx', ['tsx', 'infra/service-provider-history-proof.ts', '--persona', 'fatima', '--out', proofFile], { encoding: 'utf8', timeout: 180_000 })
    assert.equal(made.status, 0, made.stdout + made.stderr)
    const only = mkdtempSync(join(tmpdir(), 'passbook-phone-borrower-'))
    symlinkSync(join(wallets, 'fatima'), join(only, 'fatima'))
    writeFileSync(join(out,'scorer-keys.json'),'[]')
    const recordFile = join(out, 'borrower.json')
    const lines: string[] = []
    const peerLog = join(state, 'logs', 'peer-lender1.log')
    const peerBefore = (() => { try { return readFileSync(peerLog, 'utf8').length } catch { return 0 } })()
    const started = Date.now()
    const child = spawn('npx', ['tsx', 'infra/service-provider-loan-borrower.ts', '--persona', 'fatima', '--history-proof', proofFile, '--lender-pk', lenderPk, '--operator-pk', node.operator_pk, '--principal', '600', '--max-apr-bps', '1200', '--evidence-keys', join(out, 'scorer-keys.json'), '--out', recordFile], { env: { ...process.env, PASSBOOK_WALLETS: only }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => lines.push(String(d)))
    child.stderr.on('data', (d) => lines.push(String(d)))
    try {
      const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 1)))
      writeFileSync(join(out, 'borrower.log'), lines.join(''))
      const b = JSON.parse(readFileSync(recordFile, 'utf8'))
      // The peer finishes after the borrower: it confirms the release and pays the platform fee, then reports.
      const peerReport = () => readFileSync(peerLog, 'utf8').slice(peerBefore).split('\n').filter((l) => l.includes('"event":"peer_complete"')).map((l) => JSON.parse(l.slice(l.indexOf('{')))).at(-1)
      let complete = peerReport()
      for (let i = 0; !complete && code === 0 && i < 180; i++) { await new Promise((r) => setTimeout(r, 1000)); complete = peerReport() }
      const peer = readFileSync(peerLog, 'utf8').slice(peerBefore)
      writeFileSync(join(out, 'peer-lender1.log'), peer)
      const chain = BitcoindChain.fromEnv()
      const lock = b.lock_txid ? await chain.getTx(b.lock_txid) : null
      const funded = b.disbursement_txid ? await chain.getTx(b.disbursement_txid) : null
      const record = {
        v: 1, kind: 'passbook-service-provider-loan-regtest', at: new Date().toISOString(), network: 'regtest', test_coins_only: true, seconds: Math.round((Date.now() - started) / 1000),
        check_node: { operator_pk: node.operator_pk, release_hash: node.release_hash, image_digest: node.release.image_digest },
        borrower: b, lender: complete ?? null,
        chain: { lock: lock ? { txid: b.lock_txid, height: lock.height, terms_hash_in_op_return: lock.outputs.some((o) => o.script === `6a20${b.loan_id}`) } : null, disbursement: funded ? { txid: b.disbursement_txid, height: funded.height } : null },
      }
      writeFileSync(join(out, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
      assert.equal(code, 0, lines.join('').slice(-3000))
      assert.ok(b.check.ok, `borrower: ${b.check.failing}`)
      assert.equal(b.check.recommendation, 'QUALIFY')
      assert.equal(b.check.consent.payer, 'lender')
      assert.ok(complete?.check?.verified, 'the lender peer verified the check billed at close')
      assert.equal(complete.loan_id, b.loan_id)
      assert.ok(lock?.height && record.chain.lock?.terms_hash_in_op_return, 'lock confirmed with the terms hash')
      assert.ok(funded?.height, 'USDT disbursement confirmed')
      assert.ok(b.release_txid, 'released')
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM')
      rmSync(only, { recursive: true, force: true })
    }
  })
})
