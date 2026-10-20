// A phone borrower receives a local scorer check from the real provider over Nostr.
// The desktop lender accepts an operator-signed bill due at loan close; no up-front payment node.
// PASSBOOK_SERVICE_PROVIDER_LIVE=1 enables this against an independently started provider stack.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { Relay } from '../../src/agents/relay.js'
import { PlatformClient } from '../../src/agents/platform-client.js'
import { receiveBorrowerCheckPart, runLenderCheck } from '../../src/agents/lender-check.js'
import { hashObject, randomHex } from '../../src/core/crypto.js'
import { termInterest } from '../../src/core/economics.js'
import { MICRO_PER_USDT } from '../../src/core/money.js'
import { listOffers } from '../../src/checknode/client.js'
import { BILL_RAIL_LABEL } from '../../src/checknode/bill.js'
import { noTeeVerifier } from '../../src/checknode/tee.js'
import { loadScoringContract } from '../../src/scorer/contract.js'
import { devReleaseSigner, loadReleaseManifest } from '../../src/scorer/releases.js'
import { loadSeed, partyKey } from '../../src/wallet/party.js'

const LIVE = process.env.PASSBOOK_SERVICE_PROVIDER_LIVE === '1'

describe('service provider: a phone borrower gets a lender-paid local scorer check over Nostr', { skip: !LIVE && 'PASSBOOK_SERVICE_PROVIDER_LIVE not set' }, () => {
  it('the borrower process holds only its key; the lender receives a signed bill due at close; both verify the v2-bound local scorer result', { timeout: 1_500_000 }, async () => {
    const state = resolve(process.env.PASSBOOK_SP_STATE!)
    const provider = JSON.parse(readFileSync(join(state, 'provider.json'), 'utf8'))
    const node = provider.check_nodes[0]
    assert.ok(node.payer_modes.includes('lender'), 'the provider-mode offer names payer mode lender')
    assert.match(node.scorer_label, /^in-process scorer/, 'local scorer or nothing: no fallback scorer in provider mode')
    const wallets = join(state, 'wallets')
    const lender = partyKey(loadSeed('lender1', { dir: wallets }))
    const lenderBus = new Relay(lender)
    const out = process.env.PASSBOOK_SP_PROOF_OUT ?? join(state, 'proof')
    mkdirSync(out, { recursive: true })
    // A negotiation id that starts with a digit: local scorer assesses it under its prefixed purpose.
    const NEG = '5' + randomHex(32).slice(1)
    const principalUsdt = 600
    const offer = (await new PlatformClient().orderbook()).offers.find((o) => o.lender_pk === lender.pubkey)
    assert.ok(offer, 'the lender peer\'s offer is in the order book')
    const apr = offer.payload.apr_bps
    const principal = principalUsdt * MICRO_PER_USDT
    // The loan both sides agreed: what the outputs (v2) must name.
    const loan = { loan_request: { principal, fee: termInterest({ principal, apr_bps: apr, term_blocks: offer.payload.term_blocks }), term_blocks: offer.payload.term_blocks, grace_blocks: offer.payload.grace_blocks }, asset_id: provider.asset.asset_id, lender_requirements_hash: hashObject(offer.payload.requirements) }
    // Fatima when seeded with --personas: her history was observed from zero by the platform's trusted observer, whose
    // signed proof she carries (produced before and apart from her process). Otherwise the default seeded borrower.
    const seeded = JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')) as { platform_pk: string; parties: { borrower: { pubkey: string } }; personas?: { fatima: { party: { pubkey: string } } } }
    const persona = process.env.PASSBOOK_SP_PERSONA ?? (seeded.personas ? 'fatima' : 'borrower')
    const borrowerPk = persona === 'fatima' ? seeded.personas!.fatima.party.pubkey : seeded.parties.borrower.pubkey
    const proofFile = join(out, 'history-proof.json')
    if (persona === 'fatima') {
      const made = spawnSync('npx', ['tsx', 'infra/service-provider-history-proof.ts', '--persona', 'fatima', '--out', proofFile], { encoding: 'utf8', timeout: 180_000 })
      assert.equal(made.status, 0, made.stdout + made.stderr)
    }
    // The borrower's process sees one wallet directory with only the borrower's wallet in it.
    const only = mkdtempSync(join(tmpdir(), 'passbook-phone-borrower-'))
    symlinkSync(join(wallets, persona), join(only, persona))
    const keysFile = join(out, 'scorer-keys.json')
    writeFileSync(keysFile,'[]')
    const viewFile = join(out, 'borrower-view.json')
    const borrowerLog: string[] = []
    const child = spawn('npx', ['tsx', 'infra/service-provider-borrower.ts', '--persona', persona, ...(persona === 'fatima' ? ['--history-proof', proofFile] : []), '--negotiation', NEG, '--lender-pk', lender.pubkey, '--operator-pk', node.operator_pk, '--principal', String(principalUsdt), '--apr-bps', String(apr), '--evidence-keys', keysFile, '--out', viewFile], { env: { ...process.env, PASSBOOK_WALLETS: only }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => borrowerLog.push(String(d)))
    child.stderr.on('data', (d) => borrowerLog.push(String(d)))
    const exited = new Promise<number>((r) => child.on('exit', (code) => r(code ?? 1)))
    try {
      const part = await receiveBorrowerCheckPart(lenderBus, borrowerPk, NEG, 180_000)
      const checkOffer = (await listOffers(lenderBus, Math.floor(Date.now() / 1000))).valid.find((o) => o.operator_pk === node.operator_pk)!
      const contract = loadScoringContract()
      const started = Date.now()
      const lenderLog: string[] = []
      const result = await runLenderCheck({
        bus: lenderBus, part, offer: checkOffer,
        rules: { accepted_check_operators: [node.operator_pk], min_execution: 'software', max_price: { asset_id: provider.asset.asset_id, amount: MICRO_PER_USDT } },
        trust: { minTrust: 'dev-inprocess', releases: loadReleaseManifest('infra/scorer-releases.json'), releaseSignerPk: devReleaseSigner().pubkey, contract },
        tee: noTeeVerifier(Math.floor(Date.now() / 1000)), requiredChecks: ['reconcile'],
        loan, timeoutMs: 900_000, approvalTimeoutMs: 300_000, log: (l) => { lenderLog.push(l); console.log(`[lender] ${l}`) },
      })
      const code = await exited
      const view = JSON.parse(readFileSync(viewFile, 'utf8'))
      const c = (result.key.body as { chain: { type: string; body: { status?: string; commitment?: { commitment: string; key_hash: string; release_hash: string } } }[] }).chain
      const commitment = c.find((m) => m.type === 'FEEDBACK' && m.body.status === 'billed')?.body.commitment
      assert.ok(commitment, 'the signed billed feedback includes the result commitment')
      const record = {
        v: 1, kind: 'passbook-service-provider-check-regtest', at: new Date().toISOString(), network: 'regtest', test_coins_only: true,
        project: provider.project, negotiation_id: NEG, persona, history_proof: persona === 'fatima' ? 'signed by the platform\'s trusted observer (watch-only backup taken by a separate provider-side step: regtest shortcut, as in demo.ts)' : 'none', seconds: Math.round((Date.now() - started) / 1000),
        check_node: { operator_pk: node.operator_pk, release_hash: node.release_hash, image_digest: checkOffer.release.image_digest, payer_modes: checkOffer.payer_modes, scorer_label: node.scorer_label },
        consent: view.consent, loan,
        chain: c.map((m) => m.type).concat('KEY'),
        billed_fee: result.fee, commitment: commitment.commitment, key_hash: commitment.key_hash, key_source: view.view.key_source,
        external_execution_id: view.view.execution_id,
        lender: { ok: result.verification.ok, trust: result.verification.scorer?.trust ?? null, failing: result.verification.ticks.filter((t) => !t.ok).map((t) => t.id), ticks: result.verification.ticks.map((t) => `${t.ok ? 'ok' : 'FAIL'} ${t.id}`) },
        borrower: { exit: code, ok: view.view.ok, recommendation: view.view.outputs?.recommendation ?? null, outputs_v: view.view.outputs?.v ?? null, failing: view.view.ticks.filter((t: { ok: boolean }) => !t.ok).map((t: { id: string }) => t.id), ticks: view.view.ticks.map((t: { ok: boolean; id: string }) => `${t.ok ? 'ok' : 'FAIL'} ${t.id}`) },
        lender_log: lenderLog,
      }
      writeFileSync(join(out, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
      writeFileSync(join(out, 'borrower.log'), borrowerLog.join(''))
      assert.equal(result.fee.rail_label, BILL_RAIL_LABEL)
      assert.ok(result.verification.ok, `lender: ${JSON.stringify(result.verification.ticks.filter((t) => !t.ok))}`)
      assert.equal(code, 0, borrowerLog.join(''))
      assert.ok(view.view.ok)
      assert.equal(view.view.outputs.v, 2)
      assert.equal(view.consent.payer, 'lender')
      assert.equal(view.consent.operator_pk, node.operator_pk)
      assert.equal(view.consent.release_hash, node.release_hash)
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM')
      lenderBus.close()
      rmSync(only, { recursive: true, force: true })
    }
  })
})
