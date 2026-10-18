// Local inference through Tether QVAC's OpenAI-compatible server (PASSBOOK_AI=qvac-http):
//   npx --package @qvac/cli qvac serve --openai     (127.0.0.1:11434/v1)
// The default QVAC backend is the in-process SDK (qvac-sdk-reasoner.ts); this one
// is for running the model in a separate process, e.g. beside the sandbox
// container. Same prompts and schemas (prompts.ts). Nothing leaves the machine.

import { categoriseInBatches, categorisePrompt, creditMemoPrompt, disclosePrompt, explainSplitPrompt, marginNotePrompt, parseJsonObject, type Prompt } from './prompts.js'
import type { CategoriseOutput, CategoriseRow, CreditMemo, CreditMemoInput, DiscloseInput, DiscloseOutput, ExplainSplitInput, MarginNoteInput, Reasoner } from './types.js'
import { investigate } from '../sandbox/investigate.js'
import type { InvestigationRequest, InvestigationRun } from '../sandbox/investigation-types.js'

export interface QvacConfig {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
}

export class QvacReasoner implements Reasoner {
  readonly engine: string

  constructor(private readonly cfg: QvacConfig) {
    this.engine = `qvac-http:${cfg.model}`
  }

  static fromEnv(): QvacReasoner {
    return new QvacReasoner({
      baseUrl: process.env.QVAC_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      model: process.env.QVAC_MODEL ?? 'qwen3-4b',
      apiKey: process.env.QVAC_API_KEY,
      timeoutMs: Number(process.env.QVAC_TIMEOUT_MS ?? 20_000),
    })
  }

  private async complete(prompt: Prompt, timeoutMs = this.cfg.timeoutMs): Promise<unknown> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: prompt.messages,
        temperature: 0,
        max_tokens: prompt.maxTokens,
        response_format: { type: 'json_schema', json_schema: { ...prompt.schema, strict: true } },
      }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, this.cfg.timeoutMs)),
    })
    if (!res.ok) throw new Error(`QVAC HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content
    if (!content) throw new Error('QVAC returned no content')
    return parseJsonObject(content)
  }

  investigate(input: InvestigationRequest): Promise<InvestigationRun> {
    return investigate(input, async (prompt, timeoutMs) => ({ value: await this.complete(prompt, timeoutMs) }), this.engine, { totalMs: input.budgetMs })
  }

  async categorise(rows: CategoriseRow[]): Promise<CategoriseOutput> {
    return (await categoriseInBatches(rows, (batch) => this.complete(categorisePrompt(batch)))) as CategoriseOutput
  }

  async disclose(input: DiscloseInput): Promise<DiscloseOutput> {
    return (await this.complete(disclosePrompt(input))) as DiscloseOutput
  }

  async creditMemo(input: CreditMemoInput): Promise<CreditMemo> {
    return (await this.complete(creditMemoPrompt(input))) as CreditMemo
  }

  async explainSplit(i: ExplainSplitInput): Promise<string> {
    return ((await this.complete(explainSplitPrompt(i))) as { text: string }).text
  }

  async marginNote(i: MarginNoteInput): Promise<string> {
    return ((await this.complete(marginNotePrompt(i))) as { text: string }).text
  }
}
