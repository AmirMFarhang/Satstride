// These hashes were measured over the actual GGUF files downloaded by the
// pinned @qvac/sdk, not over a model name or a URL. Lenders need no model file.
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashObject, sha256Hex, type Hex } from '../core/crypto.js'
import { runMaterials, type RunMaterials } from './run-record.js'

export const PUBLISHED_QVAC_MODELS = Object.freeze({
  'qvac-sdk:qwen3-1.7b': Object.freeze({
    filename: 'Qwen3-1.7B-Q4_0.gguf', registry_id: 'QWEN3_1_7B_INST_Q4',
    sha256: 'c876f159707a4e4f70e045106c69db15bfc935a4981706fd4f65c6e7ea1e81c5',
  }),
  'qvac-sdk:qwen3-4b': Object.freeze({
    filename: 'Qwen3-4B-Q4_K_M.gguf', registry_id: 'QWEN3_4B_INST_Q4_K_M',
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  }),
})
export type PublishedQvacModel = keyof typeof PUBLISHED_QVAC_MODELS
export interface MaterialDefinitions { systemPrompt: string; toolDefinitions: unknown }
export interface TrustedModelMaterial { sha256: Hex; kind: RunMaterials['model_material_kind'] }

async function deterministicMaterial(modelId: string): Promise<string | undefined> {
  const filename = modelId === 'rules' ? '../ai/rule-reasoner.ts' : modelId === 'playbook:passbook-v1' ? '../ai/playbook-reasoner.ts' : undefined
  return filename ? readFile(fileURLToPath(new URL(filename, import.meta.url)), 'utf8') : undefined
}

/** Resolve expected hashes from this trusted release, never an incoming record.
 * Unpublished HTTP/custom model hashes need separate trusted configuration. */
export async function publishedRunMaterials(modelId: string, definitions: MaterialDefinitions, trustedModels: Readonly<Record<string, TrustedModelMaterial>> = {}): Promise<RunMaterials> {
  const common = { system_prompt_sha256: sha256Hex(definitions.systemPrompt), tool_definitions_sha256: hashObject(definitions.toolDefinitions), model_id: modelId }
  const published = PUBLISHED_QVAC_MODELS[modelId as PublishedQvacModel]
  if (published) return { ...common, model_file_sha256: published.sha256, model_material_kind: 'file' }
  const deterministic = await deterministicMaterial(modelId)
  if (deterministic !== undefined) return { ...common, model_file_sha256: hashObject(deterministic), model_material_kind: 'deterministic-code' }
  const trusted = trustedModels[modelId]
  return { ...common, model_file_sha256: trusted?.sha256 ?? null, model_material_kind: trusted?.kind ?? 'unavailable' }
}

/** Locate the actual SDK cache file, preserving Snap's cache root. Multiple
 * matching files are ambiguous and require an explicit path. */
export async function qvacModelFile(modelId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const explicit = env.PASSBOOK_RUN_MODEL_FILE ?? env.QVAC_MODEL_FILE
  if (explicit) return explicit
  const published = PUBLISHED_QVAC_MODELS[modelId as PublishedQvacModel]
  if (!published) return undefined
  const directory = env.PASSBOOK_QVAC_MODEL_DIR ?? join(env.SNAP_USER_COMMON ?? homedir(), '.qvac', 'models')
  let files: string[]
  try { files = await readdir(directory) } catch { return undefined }
  const matching = files.filter((filename) => filename === published.filename || filename.endsWith(`_${published.filename}`))
  return matching.length === 1 ? join(directory, matching[0]) : undefined
}

/** The sandbox measures its bytes independently of the lender's published pin. */
export async function observedRunMaterials(modelId: string, definitions: MaterialDefinitions, options: { modelFile?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunMaterials> {
  const deterministic = await deterministicMaterial(modelId)
  return runMaterials({ ...definitions, modelId, ...(deterministic !== undefined ? { deterministicMaterial: deterministic } : { modelFile: options.modelFile ?? await qvacModelFile(modelId, options.env) }) })
}
