// infra/state.json: what `npm run seed` created on regtest, read by the demo and
// the agents. Public data only (pubkeys, addresses, txids, the asset id): seeds
// and the platform secret stay in the git-ignored wallets directory.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Hex } from '../core/crypto.js'
import type { Micro } from '../core/money.js'
import type { publishedEconomics } from '../core/economics.js'
import type { CandidateInflow, HistoryRow } from '../sandbox/types.js'
import type { Role } from './party.js'

export interface PartyState {
  pubkey: Hex
  btc_address: string
  rgb_address: string
}

export interface SeededInflow extends CandidateInflow {
  /** how the borrower's own wallet labels it; stays inside the sandbox bundle */
  memo: string
}

export interface SeedState {
  v: 1
  created_at: string
  network: 'regtest'
  asset: { id: string; ticker: string; name: string; precision: number; supply: Micro; issuer: Role }
  platform_pk: Hex
  /** The platform's published economics, next to its key: share of interest, APR cap, LTV per term, day count. */
  economics?: ReturnType<typeof publishedEconomics>
  parties: Record<Role, PartyState>
  funding_txids: Hex[]
  lender_funding: { role: Role; txid: Hex; amount: Micro }[]
  borrower_inflows: SeededInflow[]
  seeded_height: number
  personas?: Record<'fatima' | 'walter', { party: PartyState; inflows: SeededInflow[]; seeded_height: number }> & { off_history: HistoryRow[] }
}

export function statePath(): string {
  return resolve(process.env.PASSBOOK_STATE ?? 'infra/state.json')
}

export function readState(): SeedState {
  const p = statePath()
  if (!existsSync(p)) throw new Error(`${p} not found; run infra/regtest.sh start && npm run seed`)
  return JSON.parse(readFileSync(p, 'utf8')) as SeedState
}

export function writeState(state: SeedState): void {
  const p = statePath()
  writeFileSync(`${p}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${p}.tmp`, p)
}
