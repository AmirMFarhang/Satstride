// This private journal records structured operation results, never agent/model
// transcripts. The caller supplies JSON snapshots that omit raw model text.
// An unresolved call is ambiguous: it must be inspected, never retried here.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Box = { type: 'undefined' } | { type: 'json'; value: Json }
type Entry = { kind: 'call'; key: string; result: Box } | { kind: 'wait'; key: string; info: Box; result: Box }
interface RecordV1 {
  v: 1
  identity: { [key: string]: Json }
  entries: Entry[]
  snapshot: Box
  completed: boolean
  pending?: { key: string; startedAt: string }
  waiting?: { key: string; info: Box }
}
export type DemoCheckpointErrorCode = 'corrupt' | 'unsafe' | 'identity_mismatch' | 'pending' | 'order' | 'busy' | 'json' | 'write' | 'complete'
export class DemoCheckpointError extends Error {
  constructor(readonly code: DemoCheckpointErrorCode, message: string) { super(message); this.name = 'DemoCheckpointError' }
}
function error(code: DemoCheckpointErrorCode, message: string): never { throw new DemoCheckpointError(code, message) }
const hasCode = (e: unknown, code: string) => (e as NodeJS.ErrnoException)?.code === code
const object = (value: unknown): value is { [key: string]: unknown } => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: object, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key))
const validKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0 && key.length <= 500 && !/[\x00-\x1f]/.test(key)
function stat(path: string) { try { return lstatSync(path) } catch (e) { if (hasCode(e, 'ENOENT')) return null; throw e } }
function directory(path: string): void {
  if (!stat(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const s = lstatSync(path)
  if (s.isSymbolicLink() || !s.isDirectory()) error('unsafe', 'Unsafe checkpoint directory')
}
function regularFile(path: string): void {
  const s = stat(path)
  if (s && (s.isSymbolicLink() || !s.isFile())) error('unsafe', 'Unsafe checkpoint file')
}
function atomicWrite(file: string, value: unknown): void {
  directory(dirname(file)); regularFile(file)
  const temp = join(dirname(file), `.checkpoint-${randomBytes(16).toString('hex')}.tmp`)
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, file)
    const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
  } finally { if (stat(temp)) unlinkSync(temp) }
}
// Sort keys for stable identity/approval binding; reject values JSON would
// silently discard or coerce, including holes, NaN, BigInt and class instances.
function json(value: unknown, seen = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || !value || seen.has(value)) return error('json', 'Checkpoint values must be finite, acyclic structured JSON')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) error('json', 'Checkpoint arrays must be dense JSON arrays')
      return Array.from(value, (item) => json(item, seen))
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) error('json', 'Checkpoint values must be plain JSON objects')
    if (Object.getOwnPropertySymbols(value).length) error('json', 'Checkpoint values cannot have symbol keys')
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, json((value as Record<string, unknown>)[key], seen)]))
  } finally { seen.delete(value) }
}
const box = (value: unknown): Box => value === undefined ? { type: 'undefined' } : { type: 'json', value: json(value) }
const unbox = (value: Box): unknown => value.type === 'undefined' ? undefined : structuredClone(value.value)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(json(a)) === JSON.stringify(json(b))
function validBox(value: unknown): value is Box {
  if (!object(value)) return false
  if (value.type === 'undefined') return keys(value, ['type'])
  if (value.type !== 'json' || !keys(value, ['type', 'value']) || !Object.hasOwn(value, 'value')) return false
  try { json(value.value); return true } catch { return false }
}
function validate(value: unknown): RecordV1 {
  if (!object(value) || !keys(value, ['v', 'identity', 'entries', 'snapshot', 'completed', 'pending', 'waiting']) || value.v !== 1 || !object(value.identity) || !Array.isArray(value.entries) || !validBox(value.snapshot) || typeof value.completed !== 'boolean') error('corrupt', 'Corrupt or unsupported demo checkpoint')
  try { json(value.identity) } catch { error('corrupt', 'Corrupt checkpoint identity') }
  for (const entry of value.entries) {
    if (!object(entry) || !validKey(entry.key) || !validBox(entry.result) || (entry.kind === 'call' ? !keys(entry, ['kind', 'key', 'result']) : entry.kind !== 'wait' || !keys(entry, ['kind', 'key', 'info', 'result']) || !validBox(entry.info))) error('corrupt', 'Corrupt checkpoint entry')
  }
  if (value.pending !== undefined && (!object(value.pending) || !keys(value.pending, ['key', 'startedAt']) || !validKey(value.pending.key) || typeof value.pending.startedAt !== 'string' || !Number.isFinite(Date.parse(value.pending.startedAt)))) error('corrupt', 'Corrupt pending checkpoint operation')
  if (value.waiting !== undefined && (!object(value.waiting) || !keys(value.waiting, ['key', 'info']) || !validKey(value.waiting.key) || !validBox(value.waiting.info))) error('corrupt', 'Corrupt waiting checkpoint')
  if (value.waiting && value.pending) error('corrupt', 'Checkpoint cannot wait and execute an operation together')
  if (value.completed && (value.waiting || value.pending)) error('corrupt', 'Completed checkpoint cannot have unfinished work')
  return value as unknown as RecordV1
}

/** Sequential journal, protected by the supervisor's process lock. Wrap a
 * complete money action once; nested/parallel operations belong inside that
 * one call. wait() must contain only the human gate, with no money action. */
export class DemoCheckpoints {
  readonly file: string
  private record: RecordV1
  private readonly initialEntries: number
  private cursor = 0
  private active = false
  private waitingForAnswer = false
  private checkpointWork: Promise<void> | null = null
  private writeFailed = false
  constructor(file: string, identity: Record<string, unknown>, private readonly snapshot: () => unknown | Promise<unknown>) {
    this.file = resolve(file)
    if (!object(identity)) error('json', 'Checkpoint identity must be a JSON object')
    const normalizedIdentity = json(identity) as RecordV1['identity']
    directory(dirname(this.file)); regularFile(this.file)
    if (stat(this.file)) {
      let stored: unknown
      try { stored = JSON.parse(readFileSync(this.file, 'utf8')) } catch { error('corrupt', 'Unreadable or corrupt demo checkpoint') }
      this.record = validate(stored)
      if (!same(this.record.identity, normalizedIdentity)) error('identity_mismatch', 'Checkpoint identity does not match this demo')
      if (this.record.pending) error('pending', `Unresolved demo operation ${this.record.pending.key}; inspection required`)
    } else {
      this.record = { v: 1, identity: normalizedIdentity, entries: [], snapshot: box(undefined), completed: false }
      this.persist(this.record)
    }
    this.initialEntries = this.record.entries.length
  }
  get savedState(): unknown { return unbox(this.record.snapshot) }
  get replaying(): boolean { return this.cursor < this.initialEntries }
  get pending(): boolean { return !!this.record.pending || this.writeFailed }
  get completed(): boolean { return this.record.completed }
  get waiting(): { key: string; info: unknown } | null { return this.record.waiting ? { key: this.record.waiting.key, info: unbox(this.record.waiting.info) } : null }
  private persist(next: RecordV1): void {
    try { atomicWrite(this.file, next) }
    catch (e) { this.writeFailed = true; throw new DemoCheckpointError('write', `Cannot persist demo checkpoint: ${e instanceof Error ? e.message : 'write failed'}`) }
    this.record = next
  }
  private begin(key: string): void {
    if (this.active || this.checkpointWork) error('busy', 'Checkpoint operations must be sequential')
    if (this.pending) error('pending', 'Unresolved demo operation; inspection required')
    if (this.completed && !this.replaying) error('complete', 'Demo checkpoint is complete')
    if (!validKey(key)) error('order', 'Invalid checkpoint operation key')
    this.active = true
  }
  private cached(kind: Entry['kind'], key: string, info?: Box): Entry | null {
    if (!this.replaying) return null
    const entry = this.record.entries[this.cursor]!
    if (entry.kind !== kind || entry.key !== key || (entry.kind === 'wait' && !same(entry.info, info))) error('order', 'Demo checkpoint replay order or approval details changed')
    this.cursor++
    return entry
  }
  async call<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    this.begin(key)
    try {
      const cached = this.cached('call', key)
      if (cached) return unbox(cached.result) as T
      if (this.record.waiting) error('order', 'A saved human gate must be answered before the next operation')
      this.persist({ ...this.record, pending: { key, startedAt: new Date().toISOString() } })
      const result = box(await fn())
      const snapshot = box(await this.snapshot())
      const { pending: _pending, ...saved } = this.record
      this.persist({ ...saved, entries: [...saved.entries, { kind: 'call', key, result }], snapshot })
      this.cursor++
      return unbox(result) as T
    } finally { this.active = false }
  }
  async wait<T>(key: string, info: unknown, fn: () => T | Promise<T>): Promise<T> {
    this.begin(key)
    try {
      const details = box(info), cached = this.cached('wait', key, details)
      if (cached) return unbox(cached.result) as T
      if (this.record.waiting && (this.record.waiting.key !== key || !same(this.record.waiting.info, details))) error('order', 'Saved human gate details changed')
      this.persist({ ...this.record, snapshot: box(await this.snapshot()), waiting: { key, info: details } })
      // Cancellation leaves a resumable waiting checkpoint, without marking a
      // money operation pending. An answer becomes durable before returning.
      this.waitingForAnswer = true
      const result = box(await fn())
      this.waitingForAnswer = false
      await this.checkpointWork
      const snapshot = box(await this.snapshot())
      const { waiting: _waiting, ...saved } = this.record
      this.persist({ ...saved, entries: [...saved.entries, { kind: 'wait', key, info: details, result }], snapshot })
      this.cursor++
      return unbox(result) as T
    } finally { this.waitingForAnswer = false; this.active = false }
  }
  /** Call after freezing the human Gate, before cancelling it for shutdown. */
  async checkpoint(): Promise<void> {
    if (this.pending) error('pending', 'Cannot checkpoint an unresolved operation')
    if (!this.record.waiting) return
    if (this.checkpointWork || (this.active && !this.waitingForAnswer)) error('busy', 'Checkpoint snapshot already in progress')
    const work = (async () => { this.persist({ ...this.record, snapshot: box(await this.snapshot()) }) })()
    this.checkpointWork = work
    try { await work } finally { if (this.checkpointWork === work) this.checkpointWork = null }
  }
  async markComplete(): Promise<void> {
    if (this.completed) return
    this.begin('complete')
    try {
      if (this.replaying || this.record.waiting) error('order', 'Cannot complete a demo with unfinished replay or a waiting gate')
      this.persist({ ...this.record, snapshot: box(await this.snapshot()), completed: true })
    } finally { this.active = false }
  }
}
