// External-provider host boundaries: plugin formats live outside this repository.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { hashObject, keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { contractHash, loadScoringContract } from '../src/scorer/contract.js'
import { loadExternalProvider, type ExternalOutcome, type ExternalOutcomeVerifier } from '../src/scorer/external.js'
import { signReleaseManifest } from '../src/scorer/releases.js'
import { verifyOutcomeForLender, type LenderExpectations, type TrustPolicy } from '../src/scorer/verify.js'

const contract = loadScoringContract()
const signer = keyPairFromLabel('external-host-release')
const borrower = keyPairFromLabel('external-host-borrower').pubkey
const lender = keyPairFromLabel('external-host-lender').pubkey
const loan = { loan_request: { principal: 600_000_000, fee: 6_000_000, term_blocks: 30, grace_blocks: 5 }, asset_id: 'rgb:test', lender_requirements_hash: 'ef'.repeat(32) }
const outcome = (): ExternalOutcome => ({
  kind: 'external-evidence', descriptor: { v: 1, provider: 'external', scorer_id: 'explicitly-installed-fixture', trust: 'software-evidence', code_measurement: 'sha256:' + 'ab'.repeat(32), contract_hash: contractHash(contract) },
  evidence: { synthetic_fixture: true }, outputs: { v: 2, kind: 'passbook-check-outputs', recommendation: 'QUALIFY', income_band: '2,000–3,000 USDT/month', checks: [{ id: 'inflows', ok: true }], findings: [], lender_note: 'Synthetic host-boundary vector', borrower_pk: borrower, lender_pk: lender, purpose_id: 'neg-1', bundle_hash: 'cd'.repeat(32), ...loan }, fallback: false,
})
const policy: TrustPolicy = { minTrust: 'software-evidence', releaseSignerPk: signer.pubkey, contract, releases: signReleaseManifest(signer, { builds: [{ label: 'explicit fixture plugin', provider: 'external', code_measurement: outcome().descriptor.code_measurement, contract_hash: contractHash(contract), max_trust: 'software-evidence' }] }) }
const approved: ExternalOutcomeVerifier = async () => ({ ticks: [{ id: 'fixture-proof', ok: true, detail: 'explicit test verifier accepted its synthetic vector' }], trust: 'software-evidence' })
const expect: LenderExpectations = { lenderPk: lender, borrowerPk: borrower, purposeId: 'neg-1', consentHash: '12'.repeat(32), requiredChecks: ['inflows'], loan, externalVerifier: approved }

describe('optional external scorer plugin', () => {
  it('loads only an explicitly installed package and passes private options to its factory', async () => {
    const name = `passbook-test-provider-${randomHex(8)}`
    const dir = join(process.cwd(), 'node_modules', name)
    mkdirSync(dir)
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }))
      writeFileSync(join(dir, 'index.js'), `export function createPassbookProvider(options) { return {apiVersion:options.version??1,provider:{kind:'external',describe:async()=>options,check:async()=>({})},verifyOutcome:async()=>({ticks:[],trust:null})} }`)
      const options = { setting: 'private fixture only' }
      const plugin = await loadExternalProvider(name, options)
      assert.deepEqual(await plugin.provider.describe(), options)
      await assert.rejects(loadExternalProvider(name, { version: 2 }), /unsupported external provider plugin/)
    } finally { rmSync(dir, { recursive: true }) }
  })

  it('refuses paths, URLs, built-in modules and a missing package', async () => {
    for (const name of ['../module.js', '/tmp/module.js', 'https://example.test/module.js', 'node:fs']) await assert.rejects(loadExternalProvider(name, {}), /installed package name/)
    await assert.rejects(loadExternalProvider('passbook-deliberately-missing-plugin', {}), /Cannot find package/)
  })

  it('refuses opaque evidence without its host-configured verifier', async () => {
    const v = await verifyOutcomeForLender(outcome(), policy, { ...expect, externalVerifier: undefined })
    assert.equal(v.ok, false)
    assert.ok(v.ticks.some(t => t.id === 'external-verifier' && !t.ok))
  })

  it('accepts an approved external vector while still enforcing the host contract and loan', async () => {
    const v = await verifyOutcomeForLender(outcome(), policy, expect)
    assert.equal(v.ok, true, JSON.stringify(v.ticks.filter(t => !t.ok)))
    assert.equal(v.trust, 'software-evidence')
  })

  it('refuses a failed or empty plugin verdict', async () => {
    for (const externalVerifier of [async () => ({ ticks: [{ id: 'proof', ok: false, detail: 'tampered evidence' }], trust: 'software-evidence' as const }), async () => ({ ticks: [], trust: 'software-evidence' as const })]) {
      assert.equal((await verifyOutcomeForLender(outcome(), policy, { ...expect, externalVerifier })).ok, false)
    }
  })

  it('the host refuses leaks, wrong parties, missing checks and a changed scored loan even when the plugin passes', async () => {
    for (const change of [(o: ExternalOutcome) => { (o.outputs as unknown as { balance: number }).balance = 1 }, (o: ExternalOutcome) => { o.outputs.lender_pk = borrower }, (o: ExternalOutcome) => { o.outputs.checks = [] }, (o: ExternalOutcome) => { o.outputs.loan_request!.principal++ }]) {
      const o = structuredClone(outcome()); change(o)
      assert.equal((await verifyOutcomeForLender(o, policy, expect)).ok, false)
    }
  })

  it('the host caps plugin trust, refuses unapproved measurements and requires the external descriptor kind', async () => {
    assert.equal((await verifyOutcomeForLender(outcome(), { ...policy, minTrust: 'hardware-attested' }, { ...expect, externalVerifier: async () => ({ ticks: [{ id: 'proof', ok: true, detail: 'fixture' }], trust: 'hardware-attested' }) })).ok, false)
    const changed = outcome(); changed.descriptor.code_measurement = 'sha256:' + hashObject('different build')
    assert.equal((await verifyOutcomeForLender(changed, policy, expect)).ok, false)
    const wrong = outcome(); wrong.descriptor.provider = 'in-process'
    assert.equal((await verifyOutcomeForLender(wrong, policy, expect)).ok, false)
  })
})
