// Real local QVAC inference over labelled synthetic signed wallet fixtures.
// This measures the investigator, not RGB or Bitcoin integration.
import { writeFileSync } from 'node:fs'
import { QvacSdkReasoner } from '../ai/qvac-sdk-reasoner.js'
import { RuleReasoner } from '../ai/rule-reasoner.js'
import { investigationFixture } from '../sandbox/investigation-fixtures.js'
import { runSandbox } from '../sandbox/run.js'
import type { InvestigationStep } from '../sandbox/investigation-types.js'

const sdk = QvacSdkReasoner.fromEnv()
const modelInvestigation = sdk.investigate.bind(sdk)
sdk.investigate = async (request) => {
  const originalReview = request.reviewReport
  const run = await modelInvestigation({ ...request, reviewReport: (report, ledger) => { const reasons = originalReview?.(report, ledger) ?? []; console.log(JSON.stringify({ fixture_only_decision: report, grounding_reason_codes: reasons })); return reasons } })
  if (run.status === 'done') console.log(JSON.stringify({ fixture_only_proposal: run.report }))
  return run
}
const rounds = Number(process.env.BENCH_ROUNDS ?? 5)
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('BENCH_ROUNDS must be 1..20')
const records: unknown[] = []
const rates = { fatima: 0, walter: 0 }
const started = performance.now()
await sdk.load()
console.log(JSON.stringify({ model: sdk.engine, ready_seconds: (performance.now() - started) / 1000 }))
try {
  for (const persona of ['fatima', 'walter'] as const) {
    const f = investigationFixture(persona, { liveExtras: true })
    const fixed = await runSandbox(f.bundle, { ...f, blocksPerMonth: 30, reasoner: new RuleReasoner() })
    console.log(JSON.stringify({ persona, fixed: fixed.checks.map(({ id, ok }) => ({ id, ok })), investigation: fixed.investigation }))
    for (let round = 1; round <= rounds; round++) {
      const steps: InvestigationStep[] = []
      const t0 = performance.now()
      const result = await runSandbox(f.bundle, { ...f, blocksPerMonth: 30, reasoner: sdk, onInvestigationStep: (step) => { steps.push(step); console.log(JSON.stringify({ persona, round, step })) } })
      const requiredFinding = persona === 'fatima' ? 'irregular_genuine' : 'prefunded_inflow'
      const correct = result.investigation?.status === 'done' && result.investigation.findings.some((finding) => finding.type === requiredFinding) && (persona === 'fatima' ? result.checks.every((check) => check.ok) : !result.checks.find((check) => check.id === 'sybil')?.ok)
      if (correct) rates[persona]++
      const record = { persona, round, correct, seconds: (performance.now() - t0) / 1000, investigation: result.investigation, checks: result.checks, steps }
      records.push(record)
      console.log(JSON.stringify(record))
    }
  }
  const output = { timestamp: new Date().toISOString(), evidence: 'Real local QVAC SDK inference; synthetic signed fixtures and FakeChain, including channel provision / independent opening funds. Live RGB persona evidence is separate.', model: sdk.engine, rounds, rates, records }
  if (process.env.BENCH_OUTPUT) writeFileSync(process.env.BENCH_OUTPUT, JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify({ rates, rounds }))
  process.exitCode = Object.values(rates).every((n) => n / rounds >= 0.8) ? 0 : 1
} finally {
  await QvacSdkReasoner.shutdown()
}
