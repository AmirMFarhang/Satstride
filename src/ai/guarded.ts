// Every model call goes through here: time it, validate the output against the
// task's validator, fall back to the rules engine on any failure, and record a
// trace so the wire can show which engine produced what, and how long it took.

import { primaryReasonerFromEnv } from './engine.js'
import { RuleReasoner } from './rule-reasoner.js'
import { isInvestigationReport } from '../sandbox/investigate.js'
import type { InvestigationRequest, InvestigationRun } from '../sandbox/investigation-types.js'
import {
  categoryFitsDirection,
  isCategoriseOutput,
  isCreditMemo,
  isDiscloseOutput,
  isText,
  type AiTask,
  type AiTrace,
  type CategoriseOutput,
  type CategoriseRow,
  type CreditMemo,
  type CreditMemoInput,
  type DiscloseInput,
  type DiscloseOutput,
  type ExplainSplitInput,
  type MarginNoteInput,
  type Reasoner,
} from './types.js'

export type TraceSink = (trace: AiTrace) => void

export class GuardedReasoner implements Reasoner {
  readonly engine: string

  constructor(
    private readonly primary: Reasoner,
    private readonly sink: TraceSink,
    private readonly fallback: Reasoner = new RuleReasoner(),
  ) {
    this.engine = primary.engine
  }

  /**
   * Row by row: a model row is kept when it names an input txid with a known
   * category that fits the direction of the money; every other row takes the
   * rules' label, and the trace says which rows and why.
   */
  async categorise(rows: CategoriseRow[]): Promise<CategoriseOutput> {
    if (this.primary === this.fallback) return this.run('categorise', (r) => r.categorise(rows), isCategoriseOutput)
    const started = performance.now()
    let got: CategoriseOutput['rows'] = []
    let error: string | undefined
    try {
      const out = (await this.primary.categorise(rows)) as { rows?: unknown }
      got = Array.isArray(out?.rows) ? out.rows.filter((r): r is CategoriseOutput['rows'][number] => isCategoriseOutput({ rows: [r] })) : []
      if (!Array.isArray(out?.rows)) error = 'output failed schema validation'
    } catch (err) {
      error = (err as Error).message
    }
    const rules = await this.fallback.categorise(rows)
    const byTxid = new Map(got.map((r) => [r.txid, r]))
    const replaced: string[] = []
    const merged = rows.map((row, i) => {
      const m = byTxid.get(row.txid)
      if (m && categoryFitsDirection(m.category, row.direction)) return m
      replaced.push(`${row.txid.slice(0, 8)} ${m ? `${m.category} on money ${row.direction}` : 'missing'}`)
      return rules.rows[i]
    })
    const allRules = replaced.length === rows.length
    const fallbackReason = error ?? (replaced.length ? `${replaced.length} of ${rows.length} row(s) from the rules: ${replaced.slice(0, 3).join('; ')}${replaced.length > 3 ? '; …' : ''}` : undefined)
    const output = { rows: merged }
    this.sink({ engine: allRules ? this.fallback.engine : this.primary.engine, task: 'categorise', ms: Math.round(performance.now() - started), output, fallbackReason })
    return output
  }

  disclose(input: DiscloseInput): Promise<DiscloseOutput> {
    const known = new Set(input.candidates.map((c) => c.txid))
    return this.run('disclose', (r) => r.disclose(input), (v): v is DiscloseOutput => isDiscloseOutput(v) && v.selected_txids.every((t) => known.has(t)))
  }

  creditMemo(input: CreditMemoInput): Promise<CreditMemo> {
    return this.run('creditMemo', (r) => r.creditMemo(input), isCreditMemo)
  }

  explainSplit(input: ExplainSplitInput): Promise<string> {
    return this.run('explainSplit', (r) => r.explainSplit(input), isText)
  }

  marginNote(input: MarginNoteInput): Promise<string> {
    return this.run('marginNote', (r) => r.marginNote(input), isText)
  }

  /** An unavailable investigator never becomes a successful rules investigation. */
  async investigate(input: InvestigationRequest): Promise<InvestigationRun> {
    const started = performance.now()
    let result: InvestigationRun
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = Math.min(90_000, Math.max(1, input.budgetMs ?? 90_000))
      result = await Promise.race([this.primary.investigate(input), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('investigation deadline exceeded')), timeout) })])
      if (!result || !['done', 'failed', 'not_run'].includes(result.status) || (result.status === 'done' && !isInvestigationReport(result.report))) throw new Error('investigation failed schema validation')
    } catch (error) {
      result = { status: 'failed', model: this.primary.engine, reason: (error as Error).message, turns: 0, tokens_per_second: null }
    } finally {
      clearTimeout(timer)
    }
    this.sink({ engine: result.model, task: 'investigate', ms: Math.round(performance.now() - started), output: { status: result.status, turns: result.turns }, fallbackReason: result.status === 'failed' ? result.reason : undefined })
    return result
  }

  private async run<T>(task: AiTask, call: (r: Reasoner) => Promise<T>, valid: (v: unknown) => v is T): Promise<T> {
    const started = performance.now()
    let fallbackReason: string | undefined
    if (this.primary !== this.fallback) {
      try {
        const out = await call(this.primary)
        if (valid(out)) {
          this.sink({ engine: this.primary.engine, task, ms: Math.round(performance.now() - started), output: out })
          return out
        }
        fallbackReason = 'output failed schema validation'
      } catch (err) {
        fallbackReason = (err as Error).message
      }
    }
    const out = await call(this.fallback)
    this.sink({ engine: this.fallback.engine, task, ms: Math.round(performance.now() - started), output: out, fallbackReason })
    return out
  }
}

/** PASSBOOK_AI picks the primary (ai/engine.ts); the rules engine is always the fallback. */
export function reasonerFromEnv(sink: TraceSink): Reasoner {
  const rules = new RuleReasoner()
  const primary = process.env.PASSBOOK_AI && process.env.PASSBOOK_AI !== 'rules' ? primaryReasonerFromEnv() : rules
  return new GuardedReasoner(primary, sink, rules)
}
