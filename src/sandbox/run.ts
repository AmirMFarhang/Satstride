import { join } from 'node:path'
// One sandbox run: take a bundle, run the checks in order, sign the result.
// Private redacted replay files stay owner-readable inside the sandbox; only signed checks and commitments leave.

import { GuardedReasoner } from '../ai/guarded.js'
import { RuleReasoner } from '../ai/rule-reasoner.js'
import type { AiTrace, Reasoner } from '../ai/types.js'
import type { ChainClient } from '../chain/types.js'
import { hashObject, randomHex, signObject, type Hex, type KeyPair } from '../core/crypto.js'
import { affordabilityCheck, categoriseCheck, coverage, disclosureCheck, headroomCheck, inflowsCheck, injectionCheck, sybilCheck, type CheckDeps } from './checks.js'
import { templatedLenderNote } from './confirm.js'
import { observedRunMaterials, publishedRunMaterials } from './published-materials.js'
import { RecordingChain, RunRecorder, writeRunArtifact, type RunEnvironment, type RunMaterials } from './run-record.js'
import { INVESTIGATION_BUDGETS, INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from './investigate.js'
import { historyProofMaxAge, nodeUnspent } from '../chain/history-checks.js'
import { reconcileHistory } from './reconcile.js'
import { tierIncomeEvidence } from './income-tiers.js'
import { computeHistoryMetrics, metricMedian, metricSum } from './metrics.js'
import { scoreTypologies } from './typologies.js'
import { replayInvestigation, rowsInEvidence } from './grounding.js'
import { investigationTools } from './investigation-tools.js'
import { investigationAccepted } from './investigation-policy.js'
import type { ConfirmedInvestigation, InvestigationContext, InvestigationEvidence, InvestigationPolicy, InvestigationRun, InvestigationStep, PublicInvestigation } from './investigation-types.js'
import { FINDING_TYPES } from './investigation-types.js'
import { validateBundle, type Bundle, type CheckResult, type SandboxResult } from './types.js'
import { consentHash, consentProblems, uncoveredCategories } from '../scorer/consent.js'
import { contractHash, loadScoringContract } from '../scorer/contract.js'
import { sandboxScorerId } from './provenance.js'

// Exceptions are private text, even when they happen to look like a code.
const PUBLIC_INVESTIGATION_FAILURES = new Set([
  'DEADLINE_EXCEEDED', 'INVALID_DECISION_SCHEMA', 'NO_EVIDENCE_READ',
  'SECOND_DECISION_REJECTED', 'INVALID_TOOL_ACTION', 'INVALID_TOOL_ARGUMENTS',
  'TOOL_RETURNED_ERROR', 'TOOL_CONTEXT_BUDGET_EXCEEDED', 'MODEL_CALL_BUDGET_EXHAUSTED',
  'MODEL_MATERIAL_MISMATCH', 'POLICY_FAILED', 'UNKNOWN_EVIDENCE_ID',
  'FRAUD_VERDICT_WITHOUT_GROUNDED_RISK', 'INVALID_TIER_EVIDENCE',
  'INCOME_TIER_NOT_CONFIRMED', 'REDACTION_NOT_ACKNOWLEDGED', 'NO_CLEAN_WITHOUT_PAYER_COVERAGE',
  ...FINDING_TYPES.flatMap((type) => ['WRONG_TOOL_OR_ERROR_EVIDENCE:', 'BENIGN_NOT_TRUE_FOR_ALL_CITED_RECORDS:', 'RISK_NOT_SHOWN_BY_CITED_RECORD:'].map((prefix) => prefix + type.toUpperCase())),
])

export interface SandboxConfig {
  key: KeyPair
  chain: ChainClient
  /** the unguarded primary reasoner; the runner wraps it with the guard so every call is traced */
  reasoner: Reasoner
  blocksPerMonth: number
  oraclePk?: Hex
  investigationContext?: InvestigationContext
  onInvestigationStep?: (step: InvestigationStep) => void
  investigationTimeoutMs?: number
  runEnvironment?: RunEnvironment
  runArtifactDir?: string | null
  runMaterials?: RunMaterials
}

/**
 * A consent receipt inside the encrypted bundle is checked before anything is
 * processed: signed by this bundle's borrower, naming this sandbox, the scoring
 * contract and every data category sent, and in date. Its hash is then signed
 * into the result, so the lender can see consent covered exactly this run.
 */
function acceptedConsent(bundle: Bundle, sandboxPk: Hex, imageDigest: string): Hex | undefined {
  if (!bundle.consent) return undefined
  const contract = loadScoringContract()
  const problems = [
    ...consentProblems(bundle.consent, { scorer_id: sandboxScorerId(sandboxPk, imageDigest), scorer_pk: sandboxPk, contract, contract_hash: contractHash(contract), now: Math.floor(Date.now() / 1000), borrower_pk: bundle.borrower_pk }),
    ...uncoveredCategories(bundle.consent, bundle).map((c) => `CONSENT_UNCOVERED:${c}`),
  ]
  if (problems.length) throw new Error(`consent receipt refused, nothing processed: ${problems.join(', ')}`)
  return consentHash(bundle.consent)
}

export async function runSandbox(bundle: Bundle, cfg: SandboxConfig): Promise<SandboxResult> {
  validateBundle(bundle)
  const imageDigest = cfg.runEnvironment?.image_digest ?? process.env.SANDBOX_IMAGE_DIGEST ?? 'in-process'
  const consent_hash = acceptedConsent(bundle, cfg.key.pubkey, imageDigest)
  const trace: AiTrace[] = []
  const reasoner = new GuardedReasoner(cfg.reasoner, (t) => trace.push(t))
  const recordedChain = new RecordingChain(cfg.chain)
  const currentHeight = await recordedChain.getHeight()
  const deps: CheckDeps = { chain: recordedChain, reasoner, blocksPerMonth: cfg.blocksPerMonth, currentHeight, oraclePk: cfg.oraclePk }
  const bundleHash = hashObject(bundle)

  const checks: CheckResult[] = []
  const inj = injectionCheck(bundle)
  checks.push(inj.check)
  const b = inj.redacted

  // All financial classification is deterministic. The model searches for context;
  // only code-confirmed evidence can change the eligible ledger below.
  const nativeUnspents: { txid: Hex; vout: number; value: number; script: Hex }[] = []
  const readUnspent = nodeUnspent(cfg.chain)
  const reconciliation = await reconcileHistory(b, recordedChain, { trustedSigners: cfg.oraclePk ? [cfg.oraclePk] : [], assetId: b.asset_id ?? '', currentHeight,
    maxAgeBlocks: historyProofMaxAge(undefined, cfg.chain.kind),
    ...(readUnspent ? { getUnspent: async (txid: Hex, vout: number) => {
      const value = await readUnspent(txid, vout)
      if (value) nativeUnspents.push({txid,vout,...value})
      return value
    } } : {}),
  })
  checks.push({ id: 'reconcile', ok: b.lender_requirements.reconciliation !== 'required' ? reconciliation.status !== 'failed' : reconciliation.status === 'verified', detail: `History ${reconciliation.status}; ${reconciliation.assurance}; ${reconciliation.reasons.join(',') || 'native allocations and observed first transfer verified'}` })
  const definitions = { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS }
  const materials = cfg.runMaterials ?? await observedRunMaterials(cfg.reasoner.engine, definitions)
  const expectedMaterials = await publishedRunMaterials(cfg.reasoner.engine, definitions)
  const modelMaterialMismatch = cfg.reasoner.engine.startsWith('qvac-sdk:') && hashObject(materials) !== hashObject(expectedMaterials)
  const recorder = new RunRecorder(cfg.key, { bundleHash, materials, budgets: INVESTIGATION_BUDGETS, image_digest: imageDigest, network_mode: cfg.runEnvironment?.network_mode ?? (process.env.SANDBOX_PORT ? 'bridge' : 'in-process-host') })
  const rules = new RuleReasoner()
  const fixedDeps = { ...deps, reasoner: rules }
  let cat = await categoriseCheck(b, fixedDeps)
  const head = headroomCheck(b, deps)
  const inflows = await inflowsCheck(b, deps)
  const sybil = sybilCheck(b, inflows.verified, deps)
  let run: InvestigationRun
  let confirmed: ConfirmedInvestigation = { findings: [], hallucinations: 0, rejected: 0, excludedPayers: new Set() }
  let reviewedHallucinations = 0, reviewedRejections = 0
  let policy: InvestigationPolicy | undefined
  let evidence: InvestigationEvidence | undefined
  const investigationStarted = performance.now()
  const investigationBudget = Math.min(90_000, Math.max(1, cfg.investigationTimeoutMs ?? 90_000))
  let preparationTimer: NodeJS.Timeout | undefined
  try {
    const redacted = new Set(b.history.filter((r, i) => r.memo !== bundle.history[i].memo).map((r) => r.txid))
    const prepared = await Promise.race([investigationTools(b, recordedChain, cfg.blocksPerMonth, redacted, { ...cfg.investigationContext, verifiedHistory: reconciliation.status === 'verified', verifiedCounterparties: new Set(reconciliation.verifiedCounterpartyPks ?? []) }), new Promise<never>((_, reject) => { preparationTimer = setTimeout(() => reject(new Error('investigation preparation deadline exceeded')), Math.min(10_000, investigationBudget)) })])
    clearTimeout(preparationTimer)
    evidence = prepared.evidence
    recorder.attachReplayContext({ bundle: b, chain: recordedChain.snapshot(), blocks_per_month: cfg.blocksPerMonth, redacted_txids: [...redacted], profiles: [...prepared.evidence.profiles].map(([pk, profile]) => ({ pk, profile })), ...(reconciliation.status === 'verified' && cfg.oraclePk ? { native_history: { trusted_observer_pk: cfg.oraclePk, asset_id: b.asset_id!, unspents: nativeUnspents } } : {}) })
    if (modelMaterialMismatch) throw new Error('MODEL_MATERIAL_MISMATCH')
    run = await reasoner.investigate({ borrower: b.borrower_pk, history_rows: b.history.length, required_months: b.lender_requirements.inflow_months, tools: prepared.tools, record: recorder, onStep: cfg.onInvestigationStep, budgetMs: Math.max(1, investigationBudget - 250 - (performance.now() - investigationStarted)), reviewReport: (report, ledger) => {
      const review = replayInvestigation(report, ledger, prepared.evidence)
      if (review.errors.length) {
        reviewedHallucinations += review.confirmed.hallucinations
        reviewedRejections += review.confirmed.rejected
      }
      return review.errors
    } })
    if (run.status === 'done') {
      const reviewed = replayInvestigation(run.report, run.evidence, prepared.evidence)
      confirmed = reviewed.confirmed
      policy = reviewed.policy
      if (reviewed.errors.length || policy.verdict === 'failed') run = { status: 'failed', model: run.model, reason: reviewed.errors[0] ?? policy.reason_codes[0] ?? 'POLICY_FAILED', turns: run.turns, tokens_per_second: run.tokens_per_second }
    }
  } catch (error) {
    run = { status: 'failed', model: cfg.reasoner.engine, reason: (error as Error).message, turns: 0, tokens_per_second: null }
  } finally {
    clearTimeout(preparationTimer)
  }
  confirmed.hallucinations += reviewedHallucinations
  confirmed.rejected += reviewedRejections
  const blocked = confirmed.excludedPayers
  const eligible = sybil.clean.filter((r) => !blocked.has(r.payer_pk))
  if (blocked.size) {
    const financial = { ...b, history: b.history.filter((r) => r.direction !== 'in' || !blocked.has(r.counterparty_pk)) }
    cat = await categoriseCheck(financial, fixedDeps)
    if (confirmed.findings.some((f) => ['prefunded_inflow', 'circular_flow', 'fan_in_burst', 'pass_through'].includes(f.type))) sybil.check = { id: 'sybil', ok: false, detail: 'Code-confirmed suspicious flow pattern; affected payments excluded from income' }
  }
  if (confirmed.irregularIncomeMedian !== undefined) {
    cat.data.incomeMonthlyMedian = confirmed.irregularIncomeMedian
    const required = b.lender_requirements
    const verified = coverage(eligible, required.inflow_months, Math.ceil((b.loan_request.principal + b.loan_request.fee) * required.inflow_multiple_bps / 10000))
    inflows.check = { id: 'inflows', ok: verified.ok, detail: `${eligible.length} signed inflows from independent payers; every required month covered; irregular context confirmed in code` }
  }
  const knownLenders = new Set([...(evidence?.profiles ?? [])].filter(([, profile]) => profile.known_lender).map(([pk]) => pk))
  const tiers = tierIncomeEvidence(b, { currentHeight, blocksPerMonth: cfg.blocksPerMonth, months: Math.max(3, b.lender_requirements.inflow_months), reconciliationVerified: reconciliation.status === 'verified', verifiedCounterpartyPks: new Set(reconciliation.verifiedCounterpartyPks ?? []), excludedPayers: blocked, knownLenders, irregularPayers: new Set(confirmed.findings.filter((f) => f.type === 'irregular_genuine').flatMap((f) => f.payers)) })
  if (reconciliation.status === 'verified') {
    const allowed = new Map<Hex, number>()
    if (run.status === 'done' && evidence) for (const proposed of run.report.payer_tiers ?? []) {
      const ids = run.evidence.filter((entry) => proposed.evidence.includes(entry.id)).flatMap((entry) => rowsInEvidence(entry, evidence!))
      for (const row of b.history.filter((r) => r.direction === 'in' && ids.includes(r.txid))) allowed.set(row.counterparty_pk, proposed.tier === 'out' ? 0 : Number(proposed.tier.slice(-1)))
    }
    // Signed T1 income is direct evidence; unsigned tiers additionally need a
    // grounded model/playbook proposal. An omitted proposal cannot uplift it.
    for (const payer of tiers.payers) if ((payer.tier === 2 || payer.tier === 3) && allowed.get(payer.payer_pk) !== payer.tier) { payer.tier = 'out'; payer.haircut_bps = 0; payer.counted_micro = 0; payer.reason = 'UNSIGNED_TIER_NOT_PROPOSED' }
    tiers.monthly_counted_micro.fill(0)
    for (const row of b.history.filter((r) => r.direction === 'in')) {
      const age = Math.floor((currentHeight - row.height) / cfg.blocksPerMonth), payer = tiers.payers.find((p) => p.payer_pk === row.counterparty_pk)
      if (age >= 0 && age < tiers.monthly_counted_micro.length && payer) tiers.monthly_counted_micro[age] = metricSum([tiers.monthly_counted_micro[age], Number(BigInt(row.amount) * BigInt(payer.haircut_bps) / 10000n)])
    }
    tiers.median_monthly_micro = metricMedian(tiers.monthly_counted_micro) ?? 0
    cat.data.incomeMonthlyMedian = tiers.median_monthly_micro
    const unsigned = tiers.payers.some((p) => p.tier === 2 || p.tier === 3)
    const window = b.lender_requirements.inflow_months
    const monthly = tiers.monthly_counted_micro.slice(0, window)
    const required = Math.ceil((b.loan_request.principal + b.loan_request.fee) * b.lender_requirements.inflow_multiple_bps / 10000)
    const enough = monthly.filter((n) => n > 0).length >= window && monthly.reduce((a, v) => a + v, 0) >= required
    const contextualGate = inflows.check.ok || unsigned || confirmed.irregularIncomeMedian !== undefined
    inflows.check = { id: 'inflows', ok: enough && contextualGate, detail: 'Reconciled native income after code-enforced signed/recurring/business haircuts and exclusions; salary shape or grounded context required' }
  }
  const metrics = computeHistoryMetrics(b, { currentHeight, blocksPerMonth: cfg.blocksPerMonth, knownLenders, ...(reconciliation.status === 'verified' ? { openingBalance: reconciliation.verifiedOpeningBalanceMicro, provenCurrentBalance: reconciliation.provenCurrentBalanceMicro, provenHistoryStart: b.history_proof?.transfers[0]?.height, balanceBasis: 'reconciled' as const } : {}) })
  const scores = scoreTypologies(confirmed.findings)
  if (scores.disposition === 'block') sybil.check = { id: 'sybil', ok: false, detail: 'Confirmed typology score reaches the deterministic block threshold' }
  const loanPayers = new Set(confirmed.findings.filter((finding) => finding.type === 'income_is_loan').flatMap((finding) => finding.payers))
  // Until a repayment is independently established, confirmed loan-like
  // receipts are conservatively reserved as debt rather than spendable income.
  const knownDebt = b.history.filter((row) => row.direction === 'in' && loanPayers.has(row.counterparty_pk) && (evidence?.validInflows.has(row.txid) || evidence?.trustedInflows.has(row.txid))).reduce((sum, row) => { const next = BigInt(sum) + BigInt(row.amount); if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DEBT_ARITHMETIC_OVERFLOW'); return Number(next) }, 0)
  const aff = affordabilityCheck({ ...b, balance: Math.max(0, b.balance - knownDebt) }, cat.data, fixedDeps)
  const fraud = confirmed.findings.some((f) => f.type === 'prefunded_inflow' || f.type === 'circular_flow')
  const verdict = policy?.verdict === 'failed' ? undefined : policy?.verdict ?? (fraud ? 'fraud' : confirmed.findings.some((f) => f.type !== 'irregular_genuine') ? 'concerns' : 'clean')
  const failureCode = run.status === 'done' ? undefined : run.status === 'not_run' ? 'INVESTIGATION_NOT_RUN' : PUBLIC_INVESTIGATION_FAILURES.has(run.reason) ? run.reason : 'FAILSAFE_ESCALATE'
  if (run.status !== 'done') policy = replayInvestigation(null, [], evidence!, failureCode).policy
  const investigation: PublicInvestigation = {
    status: run.status, ...(run.status === 'done' ? { verdict } : { reason: failureCode }),
    findings: confirmed.findings.map((f) => ({ type: f.type, count: f.txids.length })),
    lender_note: run.status === 'done' ? templatedLenderNote(confirmed.findings) : 'The local AI investigation did not complete. This is not a clean report.',
    model: run.model, turns: run.turns, tokens_per_second: run.tokens_per_second,
    hallucinations: confirmed.hallucinations, rejected: confirmed.rejected, ...(policy ? { policy } : {}),
  }
  checks.push(cat.check, aff.check, head.check, inflows.check)
  checks.push(sybil.check)
  checks.push({ id: 'investigation', ok: investigationAccepted(b.lender_requirements.investigation, investigation), detail: `Local AI investigation ${investigation.status}${investigation.verdict ? `: ${investigation.verdict}` : ''}; policy ${b.lender_requirements.investigation ?? 'optional'}` })
  const disc = b.lender_requirements.income_evidence === 'reconciled_tiers' ? { check: { id: 'disclosure' as const, ok: reconciliation.status === 'verified' && inflows.check.ok, detail: 'Signed native-tier checks only; income transactions and exact amounts remain private' }, proposal: [] } : await disclosureCheck(b, eligible, fixedDeps)
  checks.push(disc.check)

  const unsigned = {
    v: 1 as const,
    sandbox_pk: cfg.key.pubkey,
    bundle_hash: bundleHash,
    offer_id: b.offer_id,
    borrower_pk: b.borrower_pk,
    loan_request: { principal: b.loan_request.principal, fee: b.loan_request.fee, term_blocks: b.loan_request.term_blocks, grace_blocks: b.loan_request.grace_blocks },
    height: currentHeight,
    checks,
    investigation,
    ...(b.asset_id ? { asset_id: b.asset_id } : {}),
    ...(b.lender_requirements.income_evidence === 'reconciled_tiers' ? { income_evidence: { basis: 'reconciled_tiers' as const, qualified: reconciliation.status === 'verified' && inflows.check.ok, enough_months: tiers.monthly_counted_micro.slice(0, b.lender_requirements.inflow_months).filter((n) => n > 0).length >= b.lender_requirements.inflow_months, enough_counted_income: tiers.monthly_counted_micro.slice(0, b.lender_requirements.inflow_months).reduce((a, v) => a + v, 0) >= Math.ceil((b.loan_request.principal + b.loan_request.fee) * b.lender_requirements.inflow_multiple_bps / 10000), income_band: `${Math.floor(tiers.median_monthly_micro / 1e9) * 1000}–${(Math.floor(tiers.median_monthly_micro / 1e9) + 1) * 1000} USDT/month`, tier_counts: { signed: tiers.payers.filter((p) => p.tier === 1).length, recurring: tiers.payers.filter((p) => p.tier === 2).length, business: tiers.payers.filter((p) => p.tier === 3).length, excluded: tiers.payers.filter((p) => p.tier === 'out').length } } } : {}),
    reconciliation: { status: reconciliation.status, reasons: reconciliation.reasons, assurance: reconciliation.assurance },
    typology_scores: scores,
    ...(consent_hash ? { consent_hash } : {}),
    summary: {
      history_metrics: metrics,
      income_tiers: tiers,
      history_months: cat.data.historyMonths,
      income_monthly_median: cat.data.incomeMonthlyMedian,
      fixed_outflows_monthly: cat.data.fixedOutflowsMonthly,
      categories: cat.data.counts,
      projected_balance_at_maturity: aff.projected,
      ltv_bps: head.ltv,
      ...(knownDebt ? { investigation_debt_micro: knownDebt } : {}),
    },
    disclosure_proposal: disc.proposal,
    // outputs stay inside: the categorise output lists every history row's txid
    model_trace: trace.map((t) => ({ task: t.task, engine: t.engine, ms: t.ms, fallback: t.fallbackReason ? 'MODEL_TASK_FAILED' : null })),
  }
  if (evidence) recorder.attachReplayContext({ bundle: b, chain: recordedChain.snapshot(), blocks_per_month: cfg.blocksPerMonth, redacted_txids: [...evidence.redactedTxids], profiles: [...evidence.profiles].map(([pk, profile]) => ({ pk, profile })), ...(reconciliation.status === 'verified' && cfg.oraclePk ? { native_history: { trusted_observer_pk: cfg.oraclePk, asset_id: b.asset_id!, unspents: nativeUnspents } } : {}) })
  const sealed = recorder.finish({ status: run.status, publicInvestigation: investigation, policyResult: policy!, ...(failureCode ? { failureCode } : {}) })
  if (cfg.runArtifactDir !== null) await writeRunArtifact(join(cfg.runArtifactDir ?? process.env.PASSBOOK_RUN_DIR ?? 'data/sandbox-runs', randomHex(12)), sealed.artifact)
  const recorded = { ...unsigned, run_record: sealed.record }
  const { summary: _privateSummary, disclosure_proposal: proposal, ...publicFields } = recorded
  const lender_result = signObject({ ...publicFields, disclosure_commitments: proposal.map((item) => hashObject(item)) }, cfg.key.secretKey)
  return signObject({ ...recorded, lender_result, ...(run.status === 'done' ? { investigation_borrower_note: investigation.lender_note } : {}) }, cfg.key.secretKey)
}

/** Only the result; a caller holding the bundle can recompute the hash and tie them together. */
export function resultHash(r: SandboxResult): Hex {
  const { sig: _sig, ...rest } = r
  return hashObject(rest)
}
