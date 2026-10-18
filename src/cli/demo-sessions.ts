// Session selection never resumes an agent. Old wallets, DBs and evidence stay
// where they were created; a new story always receives a new namespace.
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface SessionPaths { wallets: string; state: string; db: string; runDir: string }
export type DemoSessionStatus = 'new' | 'seeding' | 'starting' | 'running' | 'complete' | 'interrupted' | 'failed' | 'inspection'
export interface DemoSession { v: 1; id: string; createdAt: string; status: DemoSessionStatus; paths: SessionPaths; origin: 'managed' | 'legacy'; error?: string }
interface LockOwner { v: 1; pid: number; token: string; createdAt: string; startTime: string | null }
interface LockHandle { file: string; owner: LockOwner }
const statuses: readonly string[] = ['new', 'seeding', 'starting', 'running', 'complete', 'interrupted', 'failed', 'inspection']
const pathKeys = ['wallets', 'state', 'db', 'runDir'] as const
const idPattern = /^(?:legacy|run-[0-9]{13}-[a-f0-9]{16})$/
const hasCode = (e: unknown, code: string) => (e as NodeJS.ErrnoException)?.code === code
const keys = (value: object, allowed: readonly string[]) => Object.keys(value).every((k) => allowed.includes(k))
// Unlike existsSync(), lstat sees dangling symlinks, which must be rejected
// instead of being treated as an unused pointer, manifest or wallet path.
function exists(path: string): boolean { try { lstatSync(path); return true } catch (e) { if (hasCode(e, 'ENOENT')) return false; throw e } }

function directory(path: string): void {
  if (!exists(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const s = lstatSync(path)
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`Unsafe session directory: ${path}`)
}
function regularFile(path: string): void {
  if (!exists(path)) return
  const s = lstatSync(path)
  if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Unsafe session file: ${path}`)
}
function json(path: string): unknown {
  regularFile(path)
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw new Error(`Corrupt session metadata: ${path}`) }
}
function atomicJson(path: string, value: unknown): void {
  directory(dirname(path)); regularFile(path)
  const temp = join(dirname(path), `.session-${randomBytes(12).toString('hex')}.tmp`)
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
  } finally { if (exists(temp)) unlinkSync(temp) }
}
function normalizedPaths(paths: SessionPaths): SessionPaths {
  const result = {} as SessionPaths
  for (const key of pathKeys) {
    if (typeof paths[key] !== 'string' || !paths[key] || paths[key].includes('\0')) throw new Error('Unsafe session paths')
    result[key] = resolve(paths[key])
    if (result[key] === '/') throw new Error('Unsafe session paths')
  }
  if (new Set(Object.values(result)).size !== pathKeys.length) throw new Error('Session paths must be distinct')
  return result
}
function processStart(pid: number): string | null {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] ?? null }
  catch { return null }
}
function alive(owner: LockOwner): boolean {
  try { process.kill(owner.pid, 0) }
  catch (e) { return !hasCode(e, 'ESRCH') }
  const start = processStart(owner.pid)
  return !(owner.startTime && start && owner.startTime !== start)
}

export class DemoSessions {
  readonly rootDir: string
  readonly legacyPaths: SessionPaths
  private heldLock?: LockHandle
  constructor(rootDir: string, legacyPaths?: SessionPaths) {
    this.rootDir = resolve(rootDir)
    if (this.rootDir === '/') throw new Error('Unsafe session root')
    this.legacyPaths = normalizedPaths(legacyPaths ?? { wallets: join(this.rootDir, 'wallets'), state: join(this.rootDir, 'state.json'), db: join(this.rootDir, 'passbook.sqlite'), runDir: join(this.rootDir, 'sandbox-runs') })
    directory(this.rootDir); directory(this.sessionsDir)
  }
  private get sessionsDir(): string { return join(this.rootDir, 'sessions') }
  private get pointer(): string { return join(this.rootDir, 'active.json') }
  private requireId(id: string): void { if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Unsafe session ID') }
  private sessionDir(id: string): string { this.requireId(id); return join(this.sessionsDir, id) }
  private pathsFor(id: string): SessionPaths { const base = this.sessionDir(id); return { wallets: join(base, 'wallets'), state: join(base, 'state.json'), db: join(base, 'passbook.sqlite'), runDir: join(base, 'sandbox-runs') } }
  private validate(value: unknown, expectedId: string): DemoSession {
    const s = value as DemoSession
    if (!s || typeof s !== 'object' || !keys(s, ['v', 'id', 'createdAt', 'status', 'paths', 'origin', 'error']) || s.v !== 1 || s.id !== expectedId || !statuses.includes(s.status) || !['managed', 'legacy'].includes(s.origin) || typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt)) || (s.error !== undefined && (typeof s.error !== 'string' || s.error.length > 4000))) throw new Error('Corrupt session manifest')
    this.requireId(s.id)
    if (!s.paths || typeof s.paths !== 'object' || !keys(s.paths, pathKeys) || pathKeys.some((k) => typeof s.paths[k] !== 'string' || !isAbsolute(s.paths[k]) || resolve(s.paths[k]) !== s.paths[k])) throw new Error('Unsafe session paths')
    const expected = s.origin === 'legacy' ? this.legacyPaths : this.pathsFor(s.id)
    if ((s.origin === 'legacy') !== (s.id === 'legacy') || pathKeys.some((k) => expected[k] !== s.paths[k])) throw new Error('Session paths do not match their registered namespace')
    for (const key of pathKeys) {
      if (!exists(s.paths[key])) continue
      const stat = lstatSync(s.paths[key])
      if (stat.isSymbolicLink() || (key === 'wallets' || key === 'runDir' ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe session path target')
    }
    return structuredClone(s)
  }
  get(id: string): DemoSession {
    const dir = this.sessionDir(id)
    if (!exists(dir)) throw new Error(`Unknown session: ${id}`)
    directory(dir)
    return this.validate(json(join(dir, 'session.json')), id)
  }
  current(): DemoSession | null {
    if (exists(this.pointer)) {
      const p = json(this.pointer) as { v: number; id: string }
      if (!p || typeof p !== 'object' || !keys(p, ['v', 'id']) || p.v !== 1) throw new Error('Corrupt active session pointer')
      return this.get(p.id)
    }
    // Adoption never moves or copies existing private files. A partial old
    // seed is also retained for inspection rather than overwritten.
    if (![this.legacyPaths.state, this.legacyPaths.wallets, this.legacyPaths.db].some(exists)) return null
    if (!exists(this.sessionDir('legacy'))) {
      directory(this.sessionDir('legacy'))
      const session: DemoSession = { v: 1, id: 'legacy', createdAt: new Date().toISOString(), status: 'inspection', paths: this.legacyPaths, origin: 'legacy' }
      this.validate(session, session.id)
      atomicJson(join(this.sessionDir(session.id), 'session.json'), session)
    }
    return this.activate('legacy')
  }
  create(): DemoSession {
    // A malformed existing pointer must never silently select a new run.
    this.current()
    const id = `run-${Date.now()}-${randomBytes(8).toString('hex')}`
    const dir = this.sessionDir(id)
    mkdirSync(dir, { mode: 0o700 })
    const session: DemoSession = { v: 1, id, createdAt: new Date().toISOString(), status: 'new', paths: this.pathsFor(id), origin: 'managed' }
    atomicJson(join(dir, 'session.json'), session)
    atomicJson(this.pointer, { v: 1, id })
    return structuredClone(session)
  }
  activate(id: string): DemoSession { const s = this.get(id); atomicJson(this.pointer, { v: 1, id }); return s }
  update(id: string, patch: { status: DemoSessionStatus; error?: string }): DemoSession {
    if (!patch || !keys(patch, ['status', 'error']) || !statuses.includes(patch.status) || (patch.error !== undefined && (typeof patch.error !== 'string' || patch.error.length > 4000))) throw new Error('Invalid session update')
    const { error: _old, ...old } = this.get(id)
    const next = this.validate({ ...old, status: patch.status, ...(patch.error === undefined ? {} : { error: patch.error }) }, id)
    atomicJson(join(this.sessionDir(id), 'session.json'), next)
    return next
  }
  list(): DemoSession[] {
    return readdirSync(this.sessionsDir).map((id) => this.get(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  /** Hold for the supervisor lifetime. Registry selection alone does not
   * authorize a second process to open the same native wallets. */
  acquireLock(): string {
    if (this.heldLock) return this.heldLock.owner.token
    this.heldLock = this.claim(join(this.rootDir, 'supervisor.lock'), 0)
    return this.heldLock.owner.token
  }
  releaseLock(): void { if (this.heldLock) { this.release(this.heldLock); this.heldLock = undefined } }
  private owner(file: string): LockOwner {
    const o = json(file) as LockOwner
    if (!o || o.v !== 1 || !Number.isSafeInteger(o.pid) || o.pid < 1 || !/^[a-f0-9]{64}$/.test(o.token) || typeof o.createdAt !== 'string' || !Number.isFinite(Date.parse(o.createdAt)) || !(o.startTime === null || (typeof o.startTime === 'string' && /^[0-9]+$/.test(o.startTime)))) throw new Error('Corrupt supervisor lock; refusing automatic removal')
    return o
  }
  private publish(file: string): LockHandle {
    const owner: LockOwner = { v: 1, pid: process.pid, token: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), startTime: processStart(process.pid) }
    directory(dirname(file))
    // Atomic hardlink publication means contenders never see a half-written
    // owner record, unlike open('wx') followed by write to the visible lock.
    const candidate = join(this.rootDir, `.lock-${owner.token}.tmp`)
    try {
      const fd = openSync(candidate, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd) } finally { closeSync(fd) }
      linkSync(candidate, file)
    } finally { if (exists(candidate)) unlinkSync(candidate) }
    return { file, owner }
  }
  private claim(file: string, depth: number): LockHandle {
    if (depth > 16) throw new Error('Supervisor lock recovery depth exceeded')
    try { return this.publish(file) }
    catch (e) { if (!hasCode(e, 'EEXIST')) throw e }
    const prior = this.owner(file)
    if (alive(prior)) throw new Error(`Showcase supervisor already running (PID ${prior.pid})`)
    // Serialize reclamation of this exact dead token. Recovery guards use the
    // same protocol, so a process dying mid-reclamation is also recoverable.
    const guardName = createHash('sha256').update(`${file}\0${prior.token}`).digest('hex')
    const guard = this.claim(join(this.rootDir, 'lock-reclaims', `${guardName}.lock`), depth + 1)
    try {
      if (exists(file)) {
        const current = this.owner(file)
        if (current.token !== prior.token || alive(current)) throw new Error('Supervisor ownership changed during lock recovery')
        unlinkSync(file)
      }
      return this.publish(file)
    } finally { this.release(guard) }
  }
  private release(handle: LockHandle): void {
    if (!exists(handle.file)) throw new Error('Supervisor lock disappeared before release')
    const current = this.owner(handle.file)
    if (current.token !== handle.owner.token || current.pid !== process.pid) throw new Error('Supervisor lock ownership changed; refusing removal')
    unlinkSync(handle.file)
  }
}
