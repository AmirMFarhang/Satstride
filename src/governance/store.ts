// The gate's durable state: policy history, cumulative reservations, frozen
// agents, agent sessions and which policy version allowed each loan. One JSON
// file per node, changed only inside an exclusive lock: a lock file shared by
// every process on the node, around a synchronous read-modify-write, so two
// requests (in one process or two) can never both spend the same daily budget.
// A reservation is written before the gate issues a token, so it exists before
// anything is signed.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Hex } from '../core/crypto.js'
import type { GovernedAction } from '../wallet/signer.js'
import type { PolicyRecord } from './policy.js'
import type { SessionGrant } from './sessions.js'

export interface Reservation {
  action_id: string
  /** The action id: every authorized action is its own reservation. */
  key: string
  /** signer:decoded-hash of each transaction, sorted; an identical transaction awaiting its signature is refused a second token. */
  decoded?: string[]
  rule_id: string
  action: GovernedAction
  asset: string
  counterparty: Hex | null
  amount: number
  /** UTC day, YYYY-MM-DD */
  day: string
  status: 'reserved' | 'committed' | 'released'
  at: number
  txids?: string[]
}

export interface SessionRecord { grant: SessionGrant; revoked_at?: number; revoked_by?: string }

export interface StoreState {
  v: 1
  policies: PolicyRecord[]
  reservations: Reservation[]
  frozen: Record<string, { at: number; by: string; reason: string; action_id: string }>
  sessions: SessionRecord[]
  loans: Record<Hex, { policy_version: number; actions: { action_id: string; action: GovernedAction; at: number }[] }>
  /** Hashes of requests already decided (not dry runs), so a captured signed request cannot be replayed for a new token. */
  requests?: { hash: Hex; at: number }[]
  /** Gate tokens already used to sign (action:decoded hash:signer), kept past their expiry, so a restart cannot reuse one. */
  spent_tokens?: { use: string; at: number }[]
}

export const emptyState = (): StoreState => ({ v: 1, policies: [], reservations: [], frozen: {}, sessions: [], loans: {} })

export interface GateStore {
  /** Where the store lives, or null in memory. */
  readonly dir: string | null
  read(): StoreState
  /** Run `fn` on the current state under the exclusive lock and persist what it changed. */
  transact<T>(fn: (state: StoreState) => T): T
}

export class MemoryGateStore implements GateStore {
  readonly dir = null
  private state = emptyState()
  read(): StoreState { return structuredClone(this.state) }
  transact<T>(fn: (state: StoreState) => T): T {
    const draft = structuredClone(this.state)
    const out = fn(draft)
    this.state = draft
    return out
  }
}

export class FileGateStore implements GateStore {
  readonly file: string
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'gate-store.json')
  }
  read(): StoreState {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as StoreState) : emptyState()
  }
  transact<T>(fn: (state: StoreState) => T): T {
    return withFileLock(this.file, () => {
      const state = this.read()
      const out = fn(state)
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 })
      renameSync(tmp, this.file)
      return out
    })
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))

/** An exclusive lock shared by every process: `<file>.lock`, created with O_EXCL. A lock older than 30 s is stale. */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  let fd: number | undefined
  for (let attempt = 0; fd === undefined; attempt++) {
    try {
      fd = openSync(lock, 'wx', 0o600)
      writeSync(fd, String(process.pid))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock) } catch { /* released meanwhile */ }
      if (attempt > 6_000) throw new Error(`gate store is locked: ${lock}`)
      Atomics.wait(sleeper, 0, 0, 5)
    }
  }
  try {
    return fn()
  } finally {
    closeSync(fd)
    try { unlinkSync(lock) } catch { /* already gone */ }
  }
}

export const utcDay = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10)
