import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PlaybookReasoner } from '../src/ai/playbook-reasoner.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { keyPairFromLabel, signObject, type Hex, type KeyPair } from '../src/core/crypto.js'
import { INVESTIGATION_BUDGETS } from '../src/sandbox/investigate.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { FINDING_TYPES, TOOL_NAMES } from '../src/sandbox/investigation-types.js'
import { PUBLISHED_QVAC_MODELS } from '../src/sandbox/published-materials.js'
import { bundleCategories, consentHash, signConsent, type ConsentReceipt } from '../src/scorer/consent.js'
import { contractHash, loadScoringContract, outputErrors } from '../src/scorer/contract.js'
import { ContainerScorer, declareScorer, encryptCheckRequest, incomeBand, InProcessScorer, recommend, SandboxScorerEngine } from '../src/scorer/providers.js'
import { measureSource, signReleaseManifest, type ApprovedBuild } from '../src/scorer/releases.js'
import type { PassbookCheckOutputs, ScorerDescriptor, ScorerOutcome, ScorerProvider } from '../src/scorer/types.js'
import { checkWithVerifiedScorer, ScorerRejected, verifyDescriptor, verifyOutcomeForLender, type TrustPolicy } from '../src/scorer/verify.js'

const contract = loadScoringContract()
const CONTRACT = contractHash(contract)
const NOW = 1_790_000_000
const release = keyPairFromLabel('test-release-signer')
const operator = keyPairFromLabel('test-operator')
const lender = keyPairFromLabel('test-lender')
const SOURCE = 'source:' + 'ab'.repeat(32)

function manifest(builds: Partial<ApprovedBuild>[] = [], extra: { operators?: Hex[]; external_evidence_keyids?: string[] } = {}, signer: KeyPair = release) {
  return signReleaseManifest(signer, {
    builds: [
      { label: 'in-process', provider: 'in-process', code_measurement: SOURCE, contract_hash: CONTRACT, max_trust: 'dev-inprocess' },
      { label: 'container', provider: 'container', code_measurement: SOURCE, contract_hash: CONTRACT, max_trust: 'dev-inprocess' },
      ...(builds as ApprovedBuild[]),
    ],
    operators: extra.operators ?? [operator.pubkey],
    issued_at: NOW,
  })
}

function policy(over: Partial<TrustPolicy> = {}): TrustPolicy {
  return { minTrust: 'dev-inprocess', releases: manifest(), releaseSignerPk: release.pubkey, contract, ...over }
}

function engine(persona: 'fatima' | 'walter', opts: { provider?: 'in-process' | 'container'; reasoner?: 'playbook' | 'rules'; measurement?: string } = {}) {
  const f = investigationFixture(persona)
  const e = new SandboxScorerEngine({ provider: opts.provider ?? 'in-process', key: f.key, chain: f.chain, reasoner: opts.reasoner === 'rules' ? new RuleReasoner() : new PlaybookReasoner(), blocksPerMonth: 30, oraclePk: f.oracle.pubkey, measurement: opts.measurement ?? SOURCE, now: () => NOW })
  return { f, e, borrower: keyPairFromLabel(persona) }
}

function consent(borrower: KeyPair, d: ScorerDescriptor, over: Partial<ConsentReceipt> = {}): ConsentReceipt {
  return signConsent(borrower, { purpose: 'credit assessment for negotiation n1', purpose_id: 'n1', scorer_id: d.scorer_id, ...(d.enclave_pubkey ? { scorer_pk: d.enclave_pubkey } : {}), contract_hash: d.contract_hash, lender_pk: lender.pubkey, data_categories: [...contract.inputs.data_categories], issued_at: NOW, expires_at: NOW + 3600, ...over })
}

async function lenderView(outcome: ScorerOutcome, receipt: ConsentReceipt, borrowerPk: Hex, over: Partial<TrustPolicy> = {}, _unused?: undefined, requiredChecks: string[] = []) {
  return verifyOutcomeForLender(outcome, policy(over), { lenderPk: lender.pubkey, borrowerPk, purposeId: 'n1', consentHash: consentHash(receipt), requiredChecks })
}

const failed = (v: { ticks: { id: string; ok: boolean }[] }) => v.ticks.filter((t) => !t.ok).map((t) => t.id)

describe('scoring contract', () => {
  it('matches the code it describes, so budgets, models and vocabularies cannot drift', () => {
    assert.deepEqual(contract.budgets, { ...INVESTIGATION_BUDGETS })
    assert.deepEqual(contract.models.filter((m) => m.material === 'file').map((m) => [m.model_id, m.sha256]), Object.entries(PUBLISHED_QVAC_MODELS).map(([id, m]) => [id, m.sha256]))
    const s = JSON.stringify(contract)
    for (const t of [...FINDING_TYPES, ...TOOL_NAMES]) assert.ok(s.includes(`"${t}"`), t)
    assert.equal(contract.egress, 'none')
    assert.equal(contract.retention, 'none')
  })

  it('is closed: an extra output field is a leak', () => {
    const outputs: PassbookCheckOutputs = { v: 2, kind: 'passbook-check-outputs', recommendation: 'QUALIFY', income_band: '2,000–3,000 USDT/month', checks: [{ id: 'inflows', ok: true }], findings: [], lender_note: 'ok', borrower_pk: 'aa'.repeat(32), lender_pk: 'bb'.repeat(32), purpose_id: 'n1', bundle_hash: 'cc'.repeat(32), loan_request: { principal: 600_000_000, fee: 5_600_000, term_blocks: 30, grace_blocks: 5 }, asset_id: 'rgb:unit', lender_requirements_hash: 'dd'.repeat(32) }
    assert.deepEqual(outputErrors(contract, outputs), [])
    // Contract 1.3.0: the outputs name the scored loan; v1 outputs without it are refused.
    const { loan_request: _loan, asset_id: _asset, lender_requirements_hash: _hash, ...v1 } = outputs
    assert.ok(outputErrors(contract, { ...v1, v: 1 }).length > 0)
    assert.ok(outputErrors(contract, { ...outputs, loan_request: { ...outputs.loan_request!, rate_bps: 1 } }).some((e) => e.includes('rate_bps')))
    assert.ok(outputErrors(contract, { ...outputs, balance: 1 }).some((e) => e.includes('balance: field not allowed')))
    assert.ok(outputErrors(contract, { ...outputs, income_band: '2345 USDT' }).length > 0)
    assert.ok(outputErrors(contract, { ...outputs, income_band: '2000–3000 USDT/month' }).length > 0, 'the shared format has thousands separators')
  })

  it('formats bounded income bands', () => {
    assert.equal(incomeBand(2_450_000_000), '2,000–3,000 USDT/month')
    assert.equal(incomeBand(12_300_000_000), '12,000–13,000 USDT/month')
    assert.equal(incomeBand(0), '0–1,000 USDT/month')
  })
})

describe('in-process and container scorers', () => {
  it('Fatima qualifies end to end: borrower checks the scorer, lender verifies the signed result', async () => {
    const { f, e, borrower } = engine('fatima')
    const outcome = await checkWithVerifiedScorer([new InProcessScorer(e)], f.bundle, (d) => consent(borrower, d), borrower, policy())
    const v = await lenderView(outcome, outcome.consent, borrower.pubkey)
    assert.deepEqual(failed(v), [])
    assert.equal(v.ok, true)
    assert.equal(v.trust, 'dev-inprocess')
    assert.equal(v.outputs?.recommendation, 'QUALIFY')
    assert.deepEqual(v.outputs?.findings, [{ type: 'irregular_genuine' }])
    const released = JSON.stringify(v.outputs)
    for (const row of f.bundle.history) assert.ok(!released.includes(row.txid) && !released.includes(row.counterparty_pk), 'no txids or counterparties in the outputs')
  })

  it('Walter is declined on code-confirmed evidence', async () => {
    const { f, e, borrower } = engine('walter')
    const outcome = await checkWithVerifiedScorer([new InProcessScorer(e)], f.bundle, (d) => consent(borrower, d), borrower, policy())
    const v = await lenderView(outcome, outcome.consent, borrower.pubkey)
    assert.equal(v.ok, true)
    assert.equal(v.outputs?.recommendation, 'DECLINE')
    assert.deepEqual(v.outputs?.findings, [{ type: 'prefunded_inflow' }])
  })

  it('without local AI the fixed checks decline Fatima and the investigation is not_run', async () => {
    const { f, e, borrower } = engine('fatima', { reasoner: 'rules' })
    f.bundle.lender_requirements.investigation = 'required'
    const receipt = consent(borrower, e.descriptor())
    const outcome = await new InProcessScorer(e).check(f.bundle, receipt, borrower, e.descriptor())
    const v = await lenderView(outcome, receipt, borrower.pubkey)
    assert.equal(v.outputs?.recommendation, 'DECLINE')
    assert.ok(failed(await lenderView(outcome, receipt, borrower.pubkey, {}, undefined, ['investigation'])).includes('required-checks'), 'not_run never satisfies a required investigation')
    assert.ok(v.outputs?.checks.some((c) => c.id === 'investigation' && !c.ok))
    assert.ok(outcome.kind === 'passbook-signed' && outcome.result.evidence.investigation.status === 'not_run')
  })

  it('recommends in code: fraud declines, a failed required investigation alone escalates, haircut tiers qualify with haircut', () => {
    const ok = (id: string) => ({ id: id as 'inflows', ok: true, detail: '' })
    const base = { checks: [ok('inflows'), ok('sybil'), ok('investigation')], investigation: undefined, income_evidence: undefined }
    assert.equal(recommend(base), 'QUALIFY')
    assert.equal(recommend({ ...base, checks: [ok('inflows'), { id: 'investigation', ok: false, detail: '' }] }), 'ESCALATE')
    assert.equal(recommend({ ...base, checks: [{ id: 'sybil', ok: false, detail: '' }, { id: 'investigation', ok: false, detail: '' }] }), 'DECLINE')
    assert.equal(recommend({ ...base, investigation: { status: 'done', verdict: 'fraud', findings: [], lender_note: 'x', model: 'm', turns: 1, tokens_per_second: null, hallucinations: 0, rejected: 0 } }), 'DECLINE')
    assert.equal(recommend({ ...base, income_evidence: { basis: 'reconciled_tiers', qualified: true, enough_months: true, enough_counted_income: true, income_band: '1000–2000 USDT/month', tier_counts: { signed: 1, recurring: 1, business: 0, excluded: 0 } } }), 'QUALIFY_WITH_HAIRCUT')
  })

  it('refuses to run without a valid consent receipt', async () => {
    const { f, e, borrower } = engine('fatima')
    const d = e.descriptor()
    const scorer = new InProcessScorer(e)
    await assert.rejects(scorer.check(f.bundle, consent(borrower, d, { expires_at: NOW - 1, issued_at: NOW - 100 }), borrower, d), /CONSENT_REFUSED:CONSENT_EXPIRED/)
    await assert.rejects(scorer.check(f.bundle, consent(borrower, d, { scorer_pk: lender.pubkey }), borrower, d), /CONSENT_WRONG_SCORER/)
    await assert.rejects(scorer.check(f.bundle, consent(lender, d), borrower, d), /CONSENT_WRONG_BORROWER|REQUEST_NOT_FOR_THIS_SCORER/)
    await assert.rejects(scorer.check(f.bundle, consent(borrower, d, { data_categories: ['biometrics'] }), borrower, d), /CONSENT_CATEGORIES/)
  })

  it('the borrower sends nothing to a scorer whose build is not approved or whose trust is too low', async () => {
    const { f, e, borrower } = engine('fatima', { measurement: 'source:' + '99'.repeat(32) })
    let consented = 0
    await assert.rejects(checkWithVerifiedScorer([new InProcessScorer(e)], f.bundle, (d) => { consented++; return consent(borrower, d) }, borrower, policy()), (err: Error) => err instanceof ScorerRejected && /approved-build/.test(err.message))
    assert.equal(consented, 0, 'no consent is signed for a rejected scorer')
    const ok = engine('fatima')
    await assert.rejects(checkWithVerifiedScorer([new InProcessScorer(ok.e)], ok.f.bundle, (d) => consent(ok.borrower, d), ok.borrower, policy({ minTrust: 'software-evidence' })), /trust-policy/)
  })

  it('the lender rejects a wrong measurement, wrong contract, unpinned manifest, extra field, wrong signer and low trust', async () => {
    const { f, e, borrower } = engine('fatima')
    const receipt = consent(borrower, e.descriptor())
    const outcome = await new InProcessScorer(e).check(f.bundle, receipt, borrower, e.descriptor())
    if (outcome.kind !== 'passbook-signed') throw new Error('expected a signed result')
    const tamper = async (patch: (o: Extract<ScorerOutcome, { kind: 'passbook-signed' }>) => ScorerOutcome, over: Partial<TrustPolicy> = {}) => failed(await lenderView(patch(structuredClone(outcome)), receipt, borrower.pubkey, over))
    assert.ok((await tamper((o) => ({ ...o, descriptor: { ...o.descriptor, code_measurement: 'source:' + '11'.repeat(32) } }))).includes('approved-build'))
    assert.ok((await tamper((o) => ({ ...o, descriptor: { ...o.descriptor, contract_hash: '22'.repeat(32) } }))).includes('scoring-contract'))
    assert.ok((await tamper((o) => o, { releases: manifest([], {}, keyPairFromLabel('someone-else')) })).includes('release-manifest'))
    const sandboxKey = f.key
    assert.ok((await tamper((o) => ({ ...o, result: signObject({ ...o.result, outputs: { ...o.result.outputs, balance: 5 } as PassbookCheckOutputs }, sandboxKey.secretKey) }))).includes('output-schema'))
    assert.ok((await tamper((o) => ({ ...o, result: signObject(o.result, keyPairFromLabel('impostor').secretKey) }))).includes('result-signature'))
    assert.ok((await tamper((o) => o, { minTrust: 'software-evidence' })).includes('trust-policy'))
    const wrongConsent = await verifyOutcomeForLender(outcome, policy(), { lenderPk: lender.pubkey, borrowerPk: borrower.pubkey, purposeId: 'n1', consentHash: '33'.repeat(32), requiredChecks: [] })
    assert.ok(failed(wrongConsent).includes('consent'))
    const otherLender = await verifyOutcomeForLender(outcome, policy(), { lenderPk: keyPairFromLabel('lender-2').pubkey, borrowerPk: borrower.pubkey, purposeId: 'n1', consentHash: consentHash(receipt), requiredChecks: [] })
    assert.ok(failed(otherLender).includes('addressed-to-lender'))
  })

  it('a container scorer needs an allowlisted operator declaration', async () => {
    const { f, e, borrower } = engine('fatima', { provider: 'container' })
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const body = path === '/descriptor' ? e.descriptor() : await e.handle(...(Object.values(JSON.parse(String(init?.body))) as [never, never]))
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const scorer = new ContainerScorer('http://scorer.test', { operator, fetch: fakeFetch })
    const outcome = await checkWithVerifiedScorer([scorer], f.bundle, (d) => consent(borrower, d), borrower, policy())
    const v = await lenderView(outcome, outcome.consent, borrower.pubkey)
    assert.deepEqual(failed(v), [])
    assert.ok(failed(verifyDescriptor(await scorer.describe(), policy({ releases: manifest([], { operators: [] }) }))).includes('operator-declaration'))
    assert.ok(failed(verifyDescriptor(declareScorer(keyPairFromLabel('rogue'), e.descriptor()), policy())).includes('operator-declaration'))
  })

  it('falls back visibly: a failed primary yields a labelled fallback outcome', async () => {
    const { f, e, borrower } = engine('fatima')
    const broken: ScorerProvider = { kind: 'external', describe: async () => { throw new Error('external scorer unavailable') }, check: async () => { throw new Error('unreachable') } }
    const reasons: string[] = []
    const outcome = await checkWithVerifiedScorer([broken, new InProcessScorer(e)], f.bundle, (d) => consent(borrower, d), borrower, policy(), (err) => reasons.push(err.message))
    const receipt = outcome.consent
    assert.equal(outcome.fallback, true)
    assert.deepEqual(reasons, ['external scorer unavailable'])
    const v = await lenderView(outcome, receipt, borrower.pubkey)
    assert.equal(v.fallback, true)
    assert.ok(v.ticks.some((t) => t.id === 'fallback' && /FALLBACK/.test(t.detail)))
    assert.equal((await lenderView(outcome, receipt, borrower.pubkey, { minTrust: 'software-evidence' })).ok, false, 'a fallback never inherits the primary’s trust')
  })

  it('encrypts only to the verified descriptor, even if the server rotates its key', async () => {
    const first = engine('fatima', { provider: 'container' })
    const rotated = new SandboxScorerEngine({ provider: 'container', key: keyPairFromLabel('rotated-key'), chain: first.f.chain, reasoner: new PlaybookReasoner(), blocksPerMonth: 30, measurement: SOURCE, now: () => NOW })
    let served = first.e, sentTo: Hex | undefined
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === '/descriptor') return new Response(JSON.stringify(served.descriptor()), { status: 200 })
      const { request, consent: c } = JSON.parse(String(init?.body))
      sentTo = request.enclave_pubkey
      try { return new Response(JSON.stringify(await served.handle(request, c)), { status: 200 }) } catch (err) { return new Response(JSON.stringify({ error: (err as Error).message }), { status: 400 }) }
    }) as typeof fetch
    const scorer = new ContainerScorer('http://scorer.test', { operator, fetch: fakeFetch })
    const verified = await scorer.describe()
    served = rotated
    await assert.rejects(scorer.check(first.f.bundle, consent(first.borrower, verified), first.borrower, verified))
    assert.equal(sentTo, verified.enclave_pubkey, 'the bundle went to the verified key, which the rotated server cannot read')
  })

  it('requires the consent to name every data category actually sent', async () => {
    const { f, e, borrower } = engine('fatima')
    const d = e.descriptor()
    const narrow = consent(borrower, d, { data_categories: ['transaction_history'] })
    await assert.rejects(new InProcessScorer(e).check(f.bundle, narrow, borrower, d), /CONSENT_CATEGORIES_INCOMPLETE:.*loan_request/)
    // A client that skips the check is refused inside the scorer too.
    const req = encryptCheckRequest(borrower, d, f.bundle, consent(borrower, d))
    await assert.rejects(e.handle({ ...req, consent_hash: consentHash(narrow) }, narrow), /CONSENT_CATEGORIES_INCOMPLETE/)
    assert.ok(bundleCategories(f.bundle).includes('payer_signatures'))
  })

  it('a fallback gets its own consent receipt naming it', async () => {
    const { f, e, borrower } = engine('fatima')
    const failing = engine('fatima', { provider: 'container' })
    const down = new ContainerScorer('http://scorer.test', { operator, fetch: (async (url: string) => new URL(url).pathname === '/descriptor' ? new Response(JSON.stringify(failing.e.descriptor()), { status: 200 }) : new Response(JSON.stringify({ error: 'down' }), { status: 503 })) as typeof fetch })
    const named: string[] = []
    const outcome = await checkWithVerifiedScorer([down, new InProcessScorer(e)], f.bundle, (d) => { named.push(d.scorer_id); return consent(borrower, d) }, borrower, policy())
    assert.equal(outcome.fallback, true)
    assert.deepEqual(named, [failing.e.descriptor().scorer_id, e.descriptor().scorer_id])
    assert.equal(outcome.consent.scorer_id, e.descriptor().scorer_id)
    assert.deepEqual(failed(await lenderView(outcome, outcome.consent, borrower.pubkey)), [])
  })

  it('measures the source tree reproducibly', () => {
    assert.match(measureSource(), /^source:[0-9a-f]{64}$/)
    assert.equal(measureSource(), measureSource())
  })
})
