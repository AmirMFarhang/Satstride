// The platform's single key and where wallets live. Kept apart from party.ts so
// the server can load its key without importing the RGB native binding.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { keyPairFromSecret, randomHex, type KeyPair } from '../core/crypto.js'

export function walletsDir(): string {
  return resolve(process.env.PASSBOOK_WALLETS ?? 'infra/wallets')
}

/** PLATFORM_SECRET, else <wallets>/platform/secret (created by the seed script when `create` is set). */
export function loadPlatformKey(opts: { dir?: string; create?: boolean } = {}): KeyPair | null {
  if (process.env.PLATFORM_SECRET) return keyPairFromSecret(process.env.PLATFORM_SECRET)
  const dir = join(opts.dir ?? walletsDir(), 'platform')
  const file = join(dir, 'secret')
  if (existsSync(file)) return keyPairFromSecret(readFileSync(file, 'utf8').trim())
  if (!opts.create) return null
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const secret = randomHex(32)
  writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  return keyPairFromSecret(secret)
}
