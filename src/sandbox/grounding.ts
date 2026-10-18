// Investigation design ported from Compex Fraud Desk (Apache-2.0).
// Decisions are codes + tool-result IDs. Grounding and policy run in code.
import { tierIncomeEvidence } from './income-tiers.js'
import { confirmRows } from './confirm.js'
import { type ConfirmedInvestigation, type EvidenceEntry, type FindingType, type InvestigationEvidence, type InvestigationPolicy, type InvestigationReport } from './investigation-types.js'

const ALLOWED: Record<FindingType, readonly string[]> = {
  prefunded_inflow: ['month_table', 'flows_with', 'outflows_before'],
  circular_flow: ['month_table', 'flows_with'],
  income_is_loan: ['month_table', 'payer_profile'],
  new_payer: ['payer_profile'],
  irregular_genuine: ['month_table', 'flows_with'],
  injection_attempt: ['month_table', 'read_memos'],
  fan_in_burst: ['month_table'], pass_through: ['month_table', 'flows_with'],
}
const refsIn = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(refsIn)
  if (!value || typeof value !== 'object') return []
  const obj = value as Record<string, unknown>
  return [...(typeof obj.ref === 'string' ? [obj.ref] : []), ...Object.entries(obj).flatMap(([key, val]) => key === 'redacted_memo_refs' || key === 'signed_incoming_refs' ? Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string') : [] : refsIn(val))]
}
export function rowsInEvidence(entry: EvidenceEntry, evidence: InvestigationEvidence): string[] {
  if (entry.error || entry.result == null) return []
  if (entry.tool === 'payer_profile') {
    const value = entry.result as { pk?: string }
    const pk = evidence.resolvePk(value.pk ?? '')
    return evidence.bundle.history.filter((r) => r.counterparty_pk === pk).map((r) => r.txid)
  }
  const refs = [...refsIn(entry.result), ...(entry.tool === 'outflows_before' && typeof entry.args.txid === 'string' ? [entry.args.txid] : [])]
  return [...new Set(refs.map(evidence.resolveTxid).filter((id): id is string => !!id))]
}
function supportedIds(type: FindingType, ids: string[], evidence: InvestigationEvidence): string[] {
  if (type === 'injection_attempt') return ids.filter((id) => evidence.redactedTxids.has(id))
  if (type === 'income_is_loan') return ids.filter((id) => { const r = evidence.bundle.history.find((r) => r.txid === id); return !!r && (evidence.profiles.get(r.counterparty_pk)?.known_lender || evidence.profiles.get(r.counterparty_pk)?.disbursement_txids?.includes(id)) })
  return ids
}
const scoped = (e: InvestigationEvidence, ids: string[]): InvestigationEvidence => ({ ...e, bundle: { ...e.bundle, history: e.bundle.history.filter((r) => ids.includes(r.txid)), candidate_inflows: e.bundle.candidate_inflows.filter((r) => ids.includes(r.txid)) } })
const merge = (target: ConfirmedInvestigation, source: ConfirmedInvestigation, includeRejections = true) => {
  if (includeRejections) { target.hallucinations += source.hallucinations; target.rejected += source.rejected }
  for (const f of source.findings) if (!target.findings.some((other) => other.type === f.type && other.payers.join() === f.payers.join())) target.findings.push(f)
  for (const pk of source.excludedPayers) target.excludedPayers.add(pk)
  if (source.irregularIncomeMedian !== undefined) target.irregularIncomeMedian = source.irregularIncomeMedian
}
/** A cited record must actually contain the risk. A benign claim must hold over
 * every cited relevant record; a convenient subset cannot override a bad one. */
export function groundReport(report: InvestigationReport, ledger: EvidenceEntry[], evidence: InvestigationEvidence): { confirmed: ConfirmedInvestigation; errors: string[] } {
  const confirmed: ConfirmedInvestigation = { findings: [], hallucinations: 0, rejected: 0, excludedPayers: new Set() }
  const errors: string[] = []
  const entries = new Map(ledger.map((e) => [e.id, e]))
  for (const finding of report.findings) {
    const cited = finding.evidence.map((id) => entries.get(id))
    if (!cited.length || cited.some((e) => !e || !/^E[1-9][0-9]*$/.test(e.id))) {
      confirmed.hallucinations += cited.filter((e) => !e).length
      errors.push('UNKNOWN_EVIDENCE_ID'); continue
    }
    const records = cited as EvidenceEntry[]
    if (records.some((e) => e.error || !ALLOWED[finding.type].includes(e.tool))) { confirmed.rejected++; errors.push('WRONG_TOOL_OR_ERROR_EVIDENCE:' + finding.type.toUpperCase()); continue }
    const ids = supportedIds(finding.type, [...new Set(records.flatMap((e) => rowsInEvidence(e, evidence)))], evidence)
    const combined = confirmRows({ findings: [{ type: finding.type, txids: ids }] }, scoped(evidence, ids))
    // Check every cited record for a benign claim, including any cited payer
    // with bad signatures, own-key status, lender status or a visible loop.
    if (finding.type === 'irregular_genuine') {
      const good = new Set(combined.findings.flatMap((f) => f.payers))
      const bad = records.some((e) => {
        const rows = rowsInEvidence(e, evidence).map((id) => evidence.bundle.history.find((r) => r.txid === id)!).filter((r) => r?.direction === 'in')
        return !rows.length || rows.some((r) => (!evidence.validInflows.has(r.txid) && !evidence.trustedInflows.has(r.txid)) || !good.has(r.counterparty_pk))
      })
      if (bad || !combined.findings.length) { confirmed.rejected++; errors.push('BENIGN_NOT_TRUE_FOR_ALL_CITED_RECORDS:' + finding.type.toUpperCase()); continue }
    } else {
      // A multi-month risk must be visible in at least one cited tool record,
      // not assembled from uncited private rows which the model never read.
      const supported = records.some((e) => confirmRows({ findings: [{ type: finding.type, txids: supportedIds(finding.type, rowsInEvidence(e, evidence), evidence) }] }, scoped(evidence, supportedIds(finding.type, rowsInEvidence(e, evidence), evidence))).findings.length > 0)
      if (!supported || !combined.findings.length) { confirmed.rejected++; errors.push('RISK_NOT_SHOWN_BY_CITED_RECORD:' + finding.type.toUpperCase()); continue }
    }
    merge(confirmed, combined)
  }
  if (report.verdict === 'fraud' && !confirmed.findings.some((finding) => ['prefunded_inflow', 'circular_flow'].includes(finding.type))) errors.push('FRAUD_VERDICT_WITHOUT_GROUNDED_RISK')
  for (const proposal of report.payer_tiers ?? []) {
    const cited = proposal.evidence.map((id) => entries.get(id))
    if (!cited.length || cited.some((e) => !e || e.error || !['month_table', 'flows_with'].includes(e.tool))) { errors.push('INVALID_TIER_EVIDENCE'); continue }
    const ids = (cited as EvidenceEntry[]).flatMap((entry) => rowsInEvidence(entry, evidence))
    const payers = new Set(evidence.bundle.history.filter((r) => r.direction === 'in' && ids.includes(r.txid)).map((r) => r.counterparty_pk))
    const allowed = tierIncomeEvidence(evidence.bundle, { currentHeight: evidence.currentHeight, blocksPerMonth: evidence.blocksPerMonth, months: Math.max(3, evidence.bundle.lender_requirements.inflow_months), reconciliationVerified: evidence.verifiedHistory, verifiedCounterpartyPks: evidence.verifiedCounterparties, excludedPayers: confirmed.excludedPayers, knownLenders: new Set([...evidence.profiles].filter(([, p]) => p.known_lender).map(([pk]) => pk)), irregularPayers: new Set(confirmed.findings.filter((f) => f.type === 'irregular_genuine').flatMap((f) => f.payers)) })
    const expected = proposal.tier === 'out' ? 'out' : Number(proposal.tier.slice(-1))
    if (!payers.size || allowed.payers.some((payer) => payers.has(payer.payer_pk) && payer.tier !== expected)) errors.push('INCOME_TIER_NOT_CONFIRMED')
  }
  return { confirmed, errors: [...new Set(errors)] }
}
/** Guardrails read all evidence and only tighten the proposed outcome. */
export function replayInvestigation(report: InvestigationReport | null, ledger: EvidenceEntry[], evidence: InvestigationEvidence, failureCode?: string): { confirmed: ConfirmedInvestigation; policy: InvestigationPolicy; errors: string[] } {
  if (!report) return { confirmed: { findings: [], hallucinations: 0, rejected: 0, excludedPayers: new Set() }, policy: { verdict: 'failed', reason_codes: [failureCode ?? 'FAILSAFE_ESCALATE'], hard_stops: [], coverage_gaps: [] }, errors: [] }
  const grounded = groundReport(report, ledger, evidence)
  const hard: ConfirmedInvestigation = { findings: [], hallucinations: 0, rejected: 0, excludedPayers: new Set() }
  // Evaluate each payer separately; several suspicious payers cannot cancel
  // one another by making a one-payer rule's input ambiguous.
  for (const payer of new Set(evidence.bundle.history.filter((r) => r.direction === 'in' && (evidence.validInflows.has(r.txid) || evidence.trustedInflows.has(r.txid))).map((r) => r.counterparty_pk))) {
    const ids = evidence.bundle.history.filter((r) => r.counterparty_pk === payer).map((r) => r.txid)
    for (const type of ['prefunded_inflow', 'circular_flow', 'income_is_loan'] as const) merge(hard, confirmRows({ findings: [{ type, txids: ids }] }, evidence), false)
  }
  for (const type of ['fan_in_burst', 'pass_through'] as const) merge(hard, confirmRows({ findings: [{ type, txids: evidence.bundle.history.map((r) => r.txid) }] }, evidence), false)
  const stops = [...new Set(hard.findings.map((f) => f.type.toUpperCase()))]
  const gaps: string[] = []
  const readIds = new Set(ledger.flatMap((entry) => rowsInEvidence(entry, evidence)))
  for (const payer of new Set(evidence.bundle.history.filter((r) => r.direction === 'in').map((r) => r.counterparty_pk))) {
    if (!evidence.bundle.history.some((r) => r.counterparty_pk === payer && readIds.has(r.txid))) gaps.push('PAYER_NOT_REVIEWED')
  }
  if (!ledger.some((e) => e.tool === 'month_table' && !e.error)) gaps.push('MONTH_BASELINE_NOT_READ')
  const reason_codes: string[] = []
  if (hard.findings.length) {
    merge(grounded.confirmed, hard, false)
    if (grounded.confirmed.irregularIncomeMedian !== undefined) {
      grounded.confirmed.irregularIncomeMedian = undefined
      grounded.confirmed.findings = grounded.confirmed.findings.filter((f) => f.type !== 'irregular_genuine')
      reason_codes.push('NO_UPLIFT_ON_HARD_STOP')
    }
    if (report.verdict === 'clean') reason_codes.push('NO_CLEAN_ON_HARD_STOP')
  }
  const fraud = grounded.confirmed.findings.some((f) => ['prefunded_inflow', 'circular_flow'].includes(f.type))
  let verdict: InvestigationPolicy['verdict'] = fraud ? 'fraud' : grounded.confirmed.findings.some((f) => f.type !== 'irregular_genuine') ? 'concerns' : 'clean'
  // A model may be more cautious than code. The policy never turns that into
  // a cleaner outcome, even if its reasons did not add a financial effect.
  if (report.verdict === 'fraud' || (report.verdict === 'concerns' && verdict === 'clean')) verdict = report.verdict
  if (gaps.length && verdict === 'clean') { verdict = 'failed'; reason_codes.push('NO_CLEAN_WITHOUT_PAYER_COVERAGE') }
  if (evidence.redactedTxids.size && !grounded.confirmed.findings.some((f) => f.type === 'injection_attempt')) grounded.errors.push('REDACTION_NOT_ACKNOWLEDGED')
  if (grounded.errors.length) verdict = 'failed'
  return { ...grounded, policy: { verdict, reason_codes, hard_stops: stops, coverage_gaps: [...new Set(gaps)] } }
}
