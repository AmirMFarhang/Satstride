// Local inference in this process through the Tether QVAC SDK (@qvac/sdk):
// the SDK starts its own Bare worker, loads a GGUF model with llama.cpp and
// constrains every answer to the task's JSON schema (converted to a grammar by
// llama.cpp, so the output cannot leave the schema's shape). Nothing leaves the
// machine. The SDK is imported lazily so the rules engine never loads it.
//
//   PASSBOOK_AI=qvac                     this backend
//   QVAC_MODEL=qwen3-4b | qwen3-1.7b     which model (default qwen3-1.7b, Q4)
//   QVAC_TIMEOUT_MS                      per call, default 60000

import { categoriseInBatches, categorisePrompt, creditMemoPrompt, disclosePrompt, explainSplitPrompt, marginNotePrompt, parseJsonObject, type Prompt } from './prompts.js'
import type { CategoriseOutput, CategoriseRow, CreditMemo, CreditMemoInput, DiscloseInput, DiscloseOutput, ExplainSplitInput, MarginNoteInput, Reasoner } from './types.js'
import { investigate } from '../sandbox/investigate.js'
import type { InvestigationRequest, InvestigationRun } from '../sandbox/investigation-types.js'

type Sdk = typeof import('@qvac/sdk')

/** Model names accepted in QVAC_MODEL, mapped to the SDK's registry constants. */
export const QVAC_MODELS = {
  'qwen3-4b': 'QWEN3_4B_INST_Q4_K_M',
  'qwen3-1.7b': 'QWEN3_1_7B_INST_Q4',
  'qwen3-0.6b': 'QWEN3_600M_INST_Q4',
} as const
export type QvacModelName = keyof typeof QVAC_MODELS

export interface QvacSdkConfig {
  model: QvacModelName
  timeoutMs: number
  ctxSize: number
  /** download progress while the model is fetched the first time */
  onProgress?: (percentage: number, downloadedMb: number, totalMb: number) => void
}

interface Loaded {
  sdk: Sdk
  modelId: string
}

// one model per process, shared by every agent and the sandbox in it
const loading = new Map<QvacModelName, Promise<Loaded>>()
let queue: Promise<unknown> = Promise.resolve()

export class QvacSdkReasoner implements Reasoner {
  readonly engine: string

  constructor(private readonly cfg: QvacSdkConfig) {
    this.engine = `qvac-sdk:${cfg.model}`
  }

  static configFromEnv(): QvacSdkConfig {
    const model = (process.env.QVAC_MODEL ?? 'qwen3-1.7b') as QvacModelName
    if (!(model in QVAC_MODELS)) throw new Error(`QVAC_MODEL must be one of ${Object.keys(QVAC_MODELS).join(', ')}, not ${model}`)
    return { model, timeoutMs: Number(process.env.QVAC_TIMEOUT_MS ?? 60_000), ctxSize: Number(process.env.QVAC_CTX_SIZE ?? 4096) }
  }

  static fromEnv(): QvacSdkReasoner {
    return new QvacSdkReasoner(QvacSdkReasoner.configFromEnv())
  }

  /** Download (first time only) and load the model. Calls do this on demand; the demo calls it up front. */
  load(): Promise<Loaded> {
    let p = loading.get(this.cfg.model)
    if (!p) {
      p = (async () => {
        const sdk = await import('@qvac/sdk')
        const modelSrc = (sdk as unknown as Record<string, unknown>)[QVAC_MODELS[this.cfg.model]]
        if (!modelSrc) throw new Error(`@qvac/sdk has no ${QVAC_MODELS[this.cfg.model]}`)
        const modelId = await sdk.loadModel({
          modelSrc,
          modelType: 'llm',
          modelConfig: { ctx_size: this.cfg.ctxSize },
          onProgress: (pr: { percentage: number; downloaded: number; total: number }) => this.cfg.onProgress?.(pr.percentage, pr.downloaded / 1e6, pr.total / 1e6),
        } as never)
        return { sdk, modelId: modelId as string }
      })()
      p.catch(() => loading.delete(this.cfg.model))
      loading.set(this.cfg.model, p)
    }
    return p
  }

  private completeDetailed(prompt: Prompt, timeoutMs = this.cfg.timeoutMs): Promise<{ value: unknown; tokensPerSecond?: number; request?: unknown; response?: unknown }> {
    const deadline = Date.now() + timeoutMs
    const run = async () => {
      const { sdk, modelId } = await this.load()
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('QVAC request expired while waiting for the model')
      // Qwen3 thinks before answering unless told not to; the schema grammar already bounds the answer
      const messages = prompt.messages.map((m) => (m.role === 'system' && !m.content.includes('/no_think') ? { ...m, content: `${m.content} /no_think` } : m))
      const completionRequest = {
        modelId,
        history: messages,
        stream: true,
        generationParams: { temp: 0, seed: 7, predict: prompt.maxTokens, reasoning_budget: 0 },
        responseFormat: { type: 'json_schema', json_schema: { ...prompt.schema, strict: true } },
      }
      const call = sdk.completion(completionRequest as never) as unknown as { requestId?: string; final: Promise<{ contentText: string; stats?: { tokensPerSecond?: number } }> }
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (call.requestId) void sdk.cancel({ requestId: call.requestId } as never).catch(() => {})
          reject(new Error(`QVAC ${prompt.schema.name} timed out after ${timeoutMs} ms`))
        }, remaining)
      })
      try {
        const final = await Promise.race([call.final, timeout])
        return { value: parseJsonObject(final.contentText), tokensPerSecond: final.stats?.tokensPerSecond, request: completionRequest, response: final }
      } finally {
        clearTimeout(timer)
      }
    }
    // llama.cpp serves one completion at a time per model: queue calls in arrival order
    const next = queue.then(run, run)
    queue = next.catch(() => {})
    return next
  }

  private async complete(prompt: Prompt): Promise<unknown> {
    return (await this.completeDetailed(prompt)).value
  }

  investigate(input: InvestigationRequest): Promise<InvestigationRun> {
    return investigate(input, (prompt, timeoutMs) => this.completeDetailed(prompt, Math.min(timeoutMs, this.cfg.timeoutMs)), this.engine, { totalMs: input.budgetMs })
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

  /** Unload every model this process loaded and stop the SDK's worker. */
  static async shutdown(): Promise<void> {
    for (const [name, p] of loading) {
      loading.delete(name)
      try {
        const { sdk, modelId } = await p
        await sdk.unloadModel({ modelId } as never)
        await (sdk as unknown as { close?: () => Promise<void> }).close?.()
      } catch {
        // the model never loaded, or the worker is already gone
      }
    }
  }
}
