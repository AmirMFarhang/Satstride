// The decision log: append-only and hash-chained. One entry per gate decision,
// approval, signature, policy change, kill-switch use, scorer result and
// sanctions result. Each entry names the policy version, the hashes of its
// inputs and who decided, links to the previous entry's hash and is signed by
// the node key. Changing, dropping or reordering any entry breaks the chain at
// that entry. Anchoring the head on Bitcoin mainnet is designed, not built.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashObject, signHash, verifyHash, type Hex, type KeyPair } from '../core/crypto.js'
import { withFileLock } from './store.js'

export type LogKind = 'gate-decision' | 'approval' | 'signature' | 'policy-change' | 'kill-switch' | 'scorer-result' | 'sanctions-result' | 'session'

export interface Decider { kind: 'gate' | 'human' | 'agent' | 'service' | 'quorum' | 'operator' | 'node'; id?: string; pk?: Hex }

export interface LogEntry {
  v: 1
  domain: 'passbook-decision-log-v1'
  seq: number
  prev_hash: Hex | null
  at: number
  kind: LogKind
  action_id: string | null
  loan_id: Hex | null
  policy_version: number | null
  /** Hashes of what the decision looked at (the request, decoded transactions, approvals, lists). */
  input_hashes: Record<string, Hex>
  decided_by: Decider
  result: string
  detail: unknown
  node_pk: Hex
  hash: Hex
  sig: Hex
}

export type NewEntry = Pick<LogEntry, 'kind' | 'action_id' | 'policy_version' | 'input_hashes' | 'decided_by' | 'result' | 'detail'> & { loan_id?: Hex | null; at?: number }

const body = (e: LogEntry) => { const { hash: _h, sig: _s, ...rest } = e; return rest }

export function entryHash(e: Omit<LogEntry, 'hash' | 'sig'>): Hex {
  return hashObject(e)
}

export interface DecisionLog {
  readonly file: string | null
  append(entry: NewEntry): LogEntry
  entries(): LogEntry[]
}

abstract class BaseLog implements DecisionLog {
  abstract readonly file: string | null
  constructor(protected readonly key: KeyPair) {}
  protected abstract appendRaw(build: (prev: LogEntry | undefined) => LogEntry): LogEntry
  abstract entries(): LogEntry[]
  append(e: NewEntry): LogEntry {
    return this.appendRaw((prev) => {
      const unsigned: Omit<LogEntry, 'hash' | 'sig'> = {
        v: 1, domain: 'passbook-decision-log-v1', seq: prev ? prev.seq + 1 : 0, prev_hash: prev?.hash ?? null, at: e.at ?? Math.floor(Date.now() / 1000),
        kind: e.kind, action_id: e.action_id, loan_id: e.loan_id ?? null, policy_version: e.policy_version, input_hashes: e.input_hashes, decided_by: e.decided_by, result: e.result,
        detail: JSON.parse(JSON.stringify(e.detail ?? null)), node_pk: this.key.pubkey,
      }
      const hash = entryHash(unsigned)
      return { ...unsigned, hash, sig: signHash(hash, this.key.secretKey) }
    })
  }
}

export class MemoryDecisionLog extends BaseLog {
  readonly file = null
  private readonly list: LogEntry[] = []
  protected appendRaw(build: (prev: LogEntry | undefined) => LogEntry): LogEntry {
    const entry = build(this.list.at(-1))
    this.list.push(entry)
    return entry
  }
  entries(): LogEntry[] { return structuredClone(this.list) }
}

export class FileDecisionLog extends BaseLog {
  readonly file: string
  constructor(dir: string, key: KeyPair) {
    super(key)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'decision-log.jsonl')
  }
  protected appendRaw(build: (prev: LogEntry | undefined) => LogEntry): LogEntry {
    return withFileLock(this.file, () => {
      const entry = build(readLog(this.file).at(-1))
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      return entry
    })
  }
  entries(): LogEntry[] { return readLog(this.file) }
}

export function readLog(file: string): LogEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LogEntry)
}

/**
 * Every link, hash and node signature; empty when the chain is intact. Pass the
 * node's gate key whenever it is known: without it, the entries' own keys are
 * only checked for being one and the same key, which a rewrite under a new key
 * passes.
 */
export function verifyLog(entries: LogEntry[], nodePk?: Hex): string[] {
  const problems: string[] = []
  const expected = nodePk ?? entries[0]?.node_pk
  entries.forEach((e, i) => {
    if (e.v !== 1 || e.domain !== 'passbook-decision-log-v1') problems.push(`entry ${i}: not a v1 decision-log entry`)
    if (e.seq !== i) problems.push(`entry ${i}: sequence ${e.seq}, expected ${i}`)
    if (e.prev_hash !== (i === 0 ? null : entries[i - 1].hash)) problems.push(`entry ${i}: broken link to entry ${i - 1}`)
    if (entryHash(body(e)) !== e.hash) problems.push(`entry ${i}: content does not match its hash (altered)`)
    if (e.node_pk !== expected) problems.push(`entry ${i}: written by another node key${nodePk ? '' : ' than entry 0'}`)
    if (!verifyHash(e.sig, e.hash, e.node_pk)) problems.push(`entry ${i}: node signature does not verify`)
  })
  return problems
}

export const logHead = (entries: LogEntry[]): Hex | null => entries.at(-1)?.hash ?? null
