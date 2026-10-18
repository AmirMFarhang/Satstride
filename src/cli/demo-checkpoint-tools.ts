import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToHex, keyPairFromSecret, randomKeyPair, type KeyPair } from '../core/crypto.js'
import type { DemoCheckpoints } from './demo-checkpoints.js'

/** Bind resumable control flow to runtime bytes, independent of docs commits. */
export function demoRuntimeHash(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const files: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) files.push(path)
    }
  }
  walk(join(root, 'src'))
  files.push(join(root, 'package-lock.json'))
  const hash = createHash('sha256')
  for (const file of files) hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0')
  return hash.digest('hex')
}

export function demoSandboxKey(path: string): KeyPair {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Unsafe demo sandbox key file')
    return keyPairFromSecret(readFileSync(path, 'utf8').trim())
  }
  const key = randomKeyPair()
  writeFileSync(path, bytesToHex(key.secretKey) + '\n', { flag: 'wx', mode: 0o600 })
  return key
}

function argumentHash(args: unknown[]): string {
  const encode = (value: unknown): unknown => {
    if (value === undefined) return ['undefined']
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return ['value', value]
    if (Array.isArray(value)) return ['array', value.map(encode)]
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return ['object', Object.keys(value).sort().map((key) => [key, encode((value as Record<string, unknown>)[key])])]
    throw new Error('Recorded demo arguments must be structured JSON')
  }
  return createHash('sha256').update(JSON.stringify(encode(args))).digest('hex')
}

/** Nested agent calls stay inside their one durable operation. */
export class RecordedDemo {
  private readonly inside = new AsyncLocalStorage<boolean>()
  private readonly counts = new Map<string, number>()
  constructor(readonly journal?: DemoCheckpoints) {}
  call<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.journal || this.inside.getStore()) return fn()
    const n = this.counts.get(key) ?? 0
    this.counts.set(key, n + 1)
    return this.journal.call(`${key}:${n}`, () => this.inside.run(true, async () => {
      const result = await fn()
      return result === undefined ? result : JSON.parse(JSON.stringify(result)) as T
    }))
  }
  wrap<T extends object>(target: T, label: string, names: (keyof T)[]): void {
    for (const name of names) {
      const original = target[name]
      if (typeof original !== 'function') throw new Error(`Cannot record ${label}.${String(name)}`)
      Object.defineProperty(target, name, { configurable: true, value: (...args: unknown[]) => this.call(`${label}.${String(name)}${this.journal && !this.inside.getStore() ? '@' + argumentHash(args) : ''}`, () => original.apply(target, args)) })
    }
  }
}
