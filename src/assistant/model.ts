// The model behind the agent on call: src/ai's QVAC backends, imported lazily so
// nothing loads until the first question that needs the model. The assistant has
// its own prompt and schema (answer.ts), so it calls the backends' completion
// directly (bracket access to their private `completeDetailed` / `complete`,
// which TypeScript still type-checks): same model, same /no_think, same queue
// and cancel-on-timeout as every other QVAC call in the process.
//
//   PASSBOOK_ASSIST_AI (else PASSBOOK_AI)
//     qvac        QVAC SDK in this process (QVAC_MODEL, default qwen3-1.7b)
//     qvac-http   a QVAC OpenAI-compatible server (QVAC_BASE_URL, QVAC_MODEL), e.g. the external provider stack's
//     rules|unset no model: every answer is a template, labelled with fallback_reason NO_MODEL
// No cloud API is ever an option.

import type { Prompt } from '../ai/prompts.js'
import type { AssistantModel } from './answer.js'

/** "qvac-sdk:qwen3-1.7b" -> "qwen3-1.7b": the name in the label. */
export const displayName = (model: string): string => model.replace(/^qvac-(sdk|http):/, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown'

export function assistantModelFromEnv(env: Record<string, string | undefined> = process.env): AssistantModel | null {
  const kind = env.PASSBOOK_ASSIST_AI ?? env.PASSBOOK_AI ?? 'rules'
  switch (kind) {
    case 'rules':
    case 'none':
      return null
    case 'qvac': {
      const model = env.QVAC_MODEL ?? 'qwen3-1.7b'
      let reasoner: Promise<import('../ai/qvac-sdk-reasoner.js').QvacSdkReasoner> | undefined
      return {
        name: displayName(model),
        async complete(prompt: Prompt, timeoutMs: number) {
          reasoner ??= import('../ai/qvac-sdk-reasoner.js').then(({ QvacSdkReasoner }) => QvacSdkReasoner.fromEnv())
          const r = await reasoner
          return (await r['completeDetailed'](prompt, timeoutMs)).value
        },
      }
    }
    case 'qvac-http': {
      const model = env.QVAC_MODEL ?? 'qwen3-4b'
      let reasoner: Promise<import('../ai/qvac-reasoner.js').QvacReasoner> | undefined
      return {
        name: displayName(model),
        async complete(prompt: Prompt, timeoutMs: number) {
          reasoner ??= import('../ai/qvac-reasoner.js').then(({ QvacReasoner }) => new QvacReasoner({
            baseUrl: env.QVAC_BASE_URL ?? 'http://127.0.0.1:11434/v1', model, apiKey: env.QVAC_API_KEY, timeoutMs: Number(env.QVAC_TIMEOUT_MS ?? 60_000),
          }))
          const r = await reasoner
          return r['complete'](prompt, timeoutMs)
        },
      }
    }
    default:
      throw new Error(`PASSBOOK_ASSIST_AI must be qvac, qvac-http or rules, not ${kind}`)
  }
}
