// The scoring contract (contracts/scoring.contract.json): allowed models,
// inputs, the exact output schema, egress and retention, budgets and the
// fallback rule. Versioned and hashed; the hash travels in the descriptor, the
// signed result and the term sheet, so all three name the same rules.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hashObject, type Hex } from '../core/crypto.js'
import { schemaErrors, type JsonSchema } from '../core/schema.js'
import type { RunBudgets } from '../sandbox/run-record.js'

export interface ScoringContract {
  v: 1
  id: 'passbook-scoring-contract'
  version: string
  description: string
  models: { model_id: string; material: 'file' | 'deterministic-code'; sha256?: Hex; filename?: string; use: string }[]
  inputs: { bundle_schema: string; data_categories: string[] }
  /** The passbook-check-outputs shape every provider releases. */
  outputs: { numbers: string; schema: JsonSchema }
  /** The in-process and container scorers' sandbox-signed wrapper around it. */
  container_result: { schema: JsonSchema }
  egress: 'none'
  retention: 'none'
  budgets: RunBudgets
  fallback: Record<string, string>
}

// Repo-relative, resolved only when read (repoFile): importing this module makes no Node call, so code the phone
// bundles through Metro may import it.
export const SCORING_CONTRACT_PATH = 'contracts/scoring.contract.json'
/**
 * Scoring contract 1.2.0 (outputs v1, no scored loan), kept for evidence issued under it: S1 and the first funded regtest
 * loan (17 October), and Compex's samples. A lender on the current contract refuses that evidence.
 */
export const SCORING_CONTRACT_1_2_0_PATH = 'contracts/history/scoring.contract.1.2.0.json'

/** A repository-relative path to a file path; an absolute path passes through. */
export function repoFile(path: string): string {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : fileURLToPath(new URL(`../../${path}`, import.meta.url))
}

export function loadScoringContract(path = SCORING_CONTRACT_PATH): ScoringContract {
  const contract = JSON.parse(readFileSync(repoFile(path), 'utf8')) as ScoringContract
  if (contract.v !== 1 || contract.id !== 'passbook-scoring-contract' || contract.egress !== 'none' || contract.retention !== 'none') throw new Error(`${path}: not a v1 scoring contract with egress none and retention none`)
  // Throws on an unsupported keyword, so a weakened schema cannot load.
  schemaErrors({}, contract.outputs.schema)
  schemaErrors({}, contract.container_result.schema)
  return contract
}

export function contractHash(contract: ScoringContract): Hex {
  return hashObject(contract)
}

/** The leak check: any field the contract does not name is an error. */
export function outputErrors(contract: ScoringContract, outputs: unknown): string[] {
  return schemaErrors(outputs, contract.outputs.schema)
}

export function containerResultErrors(contract: ScoringContract, result: unknown): string[] {
  return schemaErrors(result, contract.container_result.schema)
}

export function contractAllowsModel(contract: ScoringContract, modelId: string): boolean {
  return contract.models.some((m) => m.model_id === modelId)
}
