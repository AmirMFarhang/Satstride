import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PlaybookReasoner } from '../src/ai/playbook-reasoner.js'
import { auditBundleProblems, buildAuditBundle, type AuditInputs } from '../src/audit/export.js'
import { parseConfig } from '../src/core/config.js'
import { keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { termsHash } from '../src/core/terms.js'
import { approve } from '../src/market/approvals.js'
import { runNegotiation, verifyTranscript, type EngineParams } from '../src/market/negotiate.js'
import { signBorrowerPolicy, signLenderPolicy } from '../src/market/policy.js'
import { buildTermSheet, signTermSheet } from '../src/market/termsheet.js'
import { Oracle } from '../src/oracle/oracle.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { bundleCategories, consentHash, signConsent } from '../src/scorer/consent.js'
import { loadScoringContract, contractHash } from '../src/scorer/contract.js'
import { InProcessScorer, SandboxScorerEngine } from '../src/scorer/providers.js'
import { signReleaseManifest } from '../src/scorer/releases.js'
import { approveWithEvidence, evidenceDigest } from '../src/scorer/evidence-digest.js'
import { checkWithVerifiedScorer, scorerResultHash, verifyOutcomeForLender, type TrustPolicy } from '../src/scorer/verify.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const U = MICRO_PER_USDT
const NOW = 1_790_000_000
const CLI = fileURLToPath(new URL('../src/cli/passbook.ts', import.meta.url))

/** Policies -> negotiation -> verified scorer -> bound term sheet -> signatures -> approvals -> audit export. */
async function flow() {
  const f = investigationFixture('fatima')
  const borrowerKey = keyPairFromLabel('fatima'), lenderKey = keyPairFromLabel('flow-lender'), checkerKey = keyPairFromLabel('flow-checker'), platform = keyPairFromLabel('flow-platform'), release = keyPairFromLabel('flow-release')
  const borrower = new LocalKeySigner(borrowerKey), lender = new LocalKeySigner(lenderKey)
  const params: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb', 'ln-rln'] }
  const bp = await signBorrowerPolicy(borrower, { asset_id: 'rgb:usdt', principal: { min: 300 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb', 'ln-rln'], issued_at: 1 })
  const lp = await signLenderPolicy(lender, { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: ['investigation', 'inflows'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [checkerKey.pubkey], maker_checker_above: 5_000 * U }, issued_at: 1 })
  const neg = await runNegotiation(bp, lp, params, { borrower, lender, nonce: randomHex() })
  const t = verifyTranscript(neg.messages, { borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, max_rounds: 3 })
  assert.ok(t.agreed, t.problems.join('; '))
  const negotiationId = neg.messages[0].negotiation_id

  const contract = loadScoringContract()
  const engine = new SandboxScorerEngine({ provider: 'in-process', key: f.key, chain: f.chain, reasoner: new PlaybookReasoner(), blocksPerMonth: 30, oraclePk: f.oracle.pubkey, measurement: 'source:' + 'ab'.repeat(32), now: () => NOW })
  const policy: TrustPolicy = { minTrust: 'dev-inprocess', releaseSignerPk: release.pubkey, contract, releases: signReleaseManifest(release, { builds: [{ label: 'test', provider: 'in-process', code_measurement: 'source:' + 'ab'.repeat(32), contract_hash: contractHash(contract), max_trust: 'dev-inprocess' }], issued_at: NOW }) }
  const d = engine.descriptor()
  const consent = signConsent(borrowerKey, { purpose: `credit assessment for negotiation ${negotiationId.slice(0, 12)}`, purpose_id: negotiationId, scorer_id: d.scorer_id, scorer_pk: d.enclave_pubkey, contract_hash: d.contract_hash, lender_pk: lenderKey.pubkey, data_categories: bundleCategories(f.bundle), issued_at: NOW, expires_at: NOW + 3600 })
  const outcome = await checkWithVerifiedScorer([new InProcessScorer(engine)], f.bundle, () => consent, borrowerKey, policy)
  const verified = await verifyOutcomeForLender(outcome, policy, { lenderPk: lenderKey.pubkey, borrowerPk: borrowerKey.pubkey, purposeId: negotiationId, consentHash: consentHash(consent), requiredChecks: lp.required_checks })
  assert.ok(verified.ok && verified.trust && verified.outputs, verified.ticks.filter((x) => !x.ok).map((x) => x.id).join(','))

  let sheet = buildTermSheet({
    agreed: t.agreed, negotiation: { id: negotiationId, accept_hash: t.accept_hash! }, borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:usdt',
    oracle_quote: f.bundle.collateral.oracle_quote, grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
    scorer: { provider: outcome.descriptor.provider, scorer_id: outcome.descriptor.scorer_id, code_measurement: outcome.descriptor.code_measurement, contract_hash: outcome.descriptor.contract_hash, trust: verified.trust, result_hash: scorerResultHash(outcome), fallback: outcome.fallback, recommendation: verified.outputs.recommendation, evidence: evidenceDigest(outcome) },
    consent_hash: consentHash(consent), salt: randomHex(),
  })
  sheet = signTermSheet(signTermSheet(sheet, 'lender', lenderKey.secretKey), 'borrower', borrowerKey.secretKey)
  const approvals = [approve(borrowerKey, sheet, 'borrower', NOW), approveWithEvidence(lenderKey, sheet, 'lender', outcome, NOW)]
  const inputs: AuditInputs = { negotiation: neg.messages, termsheet: sheet, approvals, scorer: outcome, lender_policy: lp }
  return { inputs, sheet, verified }
}

describe('three tracks end to end', () => {
  it('Fatima: negotiated, verified, bound, signed and approved; the audit export checks out', async () => {
    const { inputs, sheet, verified } = await flow()
    assert.equal(verified.outputs?.recommendation, 'QUALIFY')
    const bundle = buildAuditBundle(inputs, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 5_000 * U, now: NOW })
    assert.deepEqual(bundle.checks.filter((c) => !c.ok), [])
    assert.deepEqual(bundle.checks.map((c) => c.id), ['negotiation', 'termsheet', 'scorer-reference', 'lender-policy', 'approvals'])
    assert.equal(bundle.loan_id, termsHash(sheet.terms), 'the audit is keyed by the on-chain terms hash')
    assert.deepEqual(auditBundleProblems(bundle), [])
    const tampered = structuredClone(bundle)
    ;(tampered.contents[tampered.entries[3].content_hash] as { type: string }).type = 'ACCEPT'
    assert.ok(auditBundleProblems(tampered).some((p) => p.includes('content missing or altered')))
    const dropped = { ...bundle, entries: bundle.entries.filter((_, i) => i !== 2) }
    assert.ok(auditBundleProblems(dropped).some((p) => p.includes('broken chain')))
  })

  it('refuses an edited lender policy instead of trusting its approvers or threshold', async () => {
    const { inputs } = await flow()
    const edited = { ...inputs.lender_policy!, approval_rules: { ...inputs.lender_policy!.approval_rules, maker_checker_above: 1_000_000 * U } }
    const bundle = buildAuditBundle({ ...inputs, lender_policy: edited }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 5_000 * U })
    assert.deepEqual(bundle.checks.filter((c) => !c.ok).map((c) => c.id), ['lender-policy', 'approvals'])
  })

  it('flags a missing lender approval and evidence the term sheet does not name', async () => {
    const { inputs } = await flow()
    const other = await flow()
    const bundle = buildAuditBundle({ ...inputs, approvals: inputs.approvals!.slice(0, 1), scorer: other.inputs.scorer }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 5_000 * U })
    assert.deepEqual(bundle.checks.filter((c) => !c.ok).map((c) => c.id), ['scorer-reference', 'approvals'])
  })

  it('passbook audit export runs from the CLI and exits non-zero on a failed check', async () => {
    const { inputs } = await flow()
    const dir = mkdtempSync(join(tmpdir(), 'passbook-audit-'))
    try {
      for (const [name, value] of Object.entries({ 'negotiation.json': inputs.negotiation, 'termsheet.json': inputs.termsheet, 'approvals.json': inputs.approvals, 'scorer.json': inputs.scorer, 'lender-policy.json': inputs.lender_policy })) writeFileSync(join(dir, name), JSON.stringify(value))
      const out = join(dir, 'audit.json')
      execFileSync(process.execPath, ['--import', 'tsx', CLI, 'audit', 'export', dir, '--out', out], { stdio: 'pipe' })
      writeFileSync(join(dir, 'approvals.json'), JSON.stringify(inputs.approvals!.slice(1)))
      assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', CLI, 'audit', 'export', dir, '--out', out], { stdio: 'pipe' }), (err: { status: number; stderr: Buffer }) => err.status === 1 && /FAIL approvals/.test(err.stderr.toString()))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('audit export verifies under the deployment economics (--config), not the built-in defaults', () => {
    // Two blocks a day: the same APR and term give a different fee, so the sheet only checks out under its own deployment.
    const yaml = readFileSync('passbook.config.yaml', 'utf8').replace('blocks_per_day: 1', 'blocks_per_day: 2')
    const economics = parseConfig(yaml, { checkFiles: false }).economics
    const b = keyPairFromLabel('econ-borrower'), l = keyPairFromLabel('econ-lender')
    let sheet = buildTermSheet({
      agreed: { principal: 600 * U, apr_bps: 1200, ltv_bps: 5000, term_blocks: 60, settlement: 'cosign-rgb' }, negotiation: { id: 'aa'.repeat(32), accept_hash: 'bb'.repeat(32) },
      borrower_pk: b.pubkey, lender_pk: l.pubkey, platform_pk: keyPairFromLabel('econ-platform').pubkey, asset_id: 'rgb:usdt', oracle_quote: new Oracle(keyPairFromLabel('econ-oracle'), 10_000_000).quote(500),
      grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, economics, settlement: { kind: 'cosign-rgb' },
      scorer: { provider: 'in-process', scorer_id: 'econ', code_measurement: 'source:' + 'ab'.repeat(32), contract_hash: 'cd'.repeat(32), trust: 'dev-inprocess', result_hash: 'ef'.repeat(32), fallback: false, recommendation: 'QUALIFY', evidence: { kind: 'passbook-run-record', run_record_sha256: '01'.repeat(32) } },
      consent_hash: '12'.repeat(32), salt: randomHex(),
    })
    sheet = signTermSheet(signTermSheet(sheet, 'lender', l.secretKey), 'borrower', b.secretKey)
    const dir = mkdtempSync(join(tmpdir(), 'passbook-audit-econ-'))
    try {
      writeFileSync(join(dir, 'termsheet.json'), JSON.stringify(sheet))
      writeFileSync(join(dir, 'deployment.yaml'), yaml)
      const run = (...extra: string[]) => execFileSync(process.execPath, ['--import', 'tsx', CLI, 'audit', 'export', dir, '--out', join(dir, 'audit.json'), ...extra], { stdio: 'pipe', env: { ...process.env, PASSBOOK_CONFIG: '' } })
      assert.throws(() => run(), (err: { status: number; stderr: Buffer }) => err.status === 1 && /FAIL termsheet: fee does not follow from APR and term/.test(err.stderr.toString()), 'the repository defaults reject it')
      const ok = run('--config', join(dir, 'deployment.yaml'))
      assert.equal(ok.length, 0, 'the bundle went to --out')
      assert.equal((JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8')) as { checks: { id: string; ok: boolean }[] }).checks.find((c) => c.id === 'termsheet')?.ok, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
