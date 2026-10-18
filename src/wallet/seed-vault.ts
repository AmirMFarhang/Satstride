// The wallet panel's seed, encrypted at rest. One vault per wallet directory:
// <dir>/seed.vault.json holds the BIP-39 words sealed with AES-256-GCM under a
// key scrypt derives from the user's passphrase; nothing else in the file is
// secret. The words are shown once when a wallet is created; the user then
// proves the backup by re-entering three of them, chosen at random, before the
// first loan. Restoring from words counts as a proven backup.
//
// This is the user's own node: the passphrase reaches it over the signed API on
// their machine and is never stored. Wrong passphrases fail the GCM tag.

import { createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import WDK from '@tetherto/wdk'

export const VAULT_FILE = 'seed.vault.json'
/** scrypt cost: 2^15 x 8 x 1 takes ~100 ms and 32 MiB, a fair price once per unlock. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const MIN_PASSPHRASE = 8
export const BACKUP_WORDS = 3

interface VaultFile {
  v: 1
  kdf: 'scrypt'
  n: number
  r: number
  p: number
  salt: string
  iv: string
  tag: string
  ct: string
  network: string
  created_at: string
  /** 'created' needs the three-word check; 'restored' typed every word already. */
  origin: 'created' | 'restored'
  backup_verified_at: string | null
}

export class VaultError extends Error {
  constructor(readonly code: 'exists' | 'missing' | 'passphrase' | 'weak' | 'words' | 'backup', message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

export function normaliseWords(words: string): string {
  return words.trim().toLowerCase().split(/\s+/).join(' ')
}

export class SeedVault {
  private challenge: number[] | null = null

  constructor(readonly dir: string, readonly network: string) {}

  get path(): string { return join(this.dir, VAULT_FILE) }
  exists(): boolean { return existsSync(this.path) }

  private read(): VaultFile {
    if (!this.exists()) throw new VaultError('missing', 'no wallet yet: create one or restore from your words')
    const f = JSON.parse(readFileSync(this.path, 'utf8')) as VaultFile
    if (f.v !== 1 || f.kdf !== 'scrypt') throw new VaultError('missing', `unsupported vault format in ${this.path}`)
    if (f.network !== this.network) throw new VaultError('missing', `this wallet was made for ${f.network}; this node runs ${this.network}`)
    return f
  }

  private write(f: VaultFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  private seal(words: string, passphrase: string, origin: VaultFile['origin']): void {
    if (this.exists()) throw new VaultError('exists', 'a wallet already exists here; it is never overwritten')
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new VaultError('weak', `the passphrase needs at least ${MIN_PASSPHRASE} characters`)
    const salt = randomBytes(16), iv = randomBytes(12)
    const key = scryptSync(passphrase, salt, 32, SCRYPT)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`passbook-seed-v1:${this.network}`))
    const ct = Buffer.concat([cipher.update(words, 'utf8'), cipher.final()])
    this.write({ v: 1, kdf: 'scrypt', n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex'), network: this.network, created_at: new Date().toISOString(), origin, backup_verified_at: origin === 'restored' ? new Date().toISOString() : null })
  }

  /** New 12-word seed (WDK). Returns the words once: the caller shows them and forgets them. */
  create(passphrase: string): string {
    const words = WDK.getRandomSeedPhrase(12)
    this.seal(words, passphrase, 'created')
    return words
  }

  /** Restore from the user's words. Typing all of them proves the backup. */
  restore(words: string, passphrase: string): void {
    const phrase = normaliseWords(words)
    if (!validateMnemonic(phrase, wordlist)) throw new VaultError('words', 'those words are not a valid BIP-39 seed phrase (check spelling and order)')
    this.seal(phrase, passphrase, 'restored')
  }

  /** The words, for opening the wallets. Throws VaultError('passphrase') on a wrong passphrase. */
  unlock(passphrase: string): string {
    const f = this.read()
    const key = scryptSync(String(passphrase ?? ''), Buffer.from(f.salt, 'hex'), 32, { N: f.n, r: f.r, p: f.p, maxmem: SCRYPT.maxmem })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'hex'))
    decipher.setAAD(Buffer.from(`passbook-seed-v1:${f.network}`))
    decipher.setAuthTag(Buffer.from(f.tag, 'hex'))
    try {
      return Buffer.concat([decipher.update(Buffer.from(f.ct, 'hex')), decipher.final()]).toString('utf8')
    } catch {
      throw new VaultError('passphrase', 'wrong passphrase')
    }
  }

  info(): { exists: boolean; origin?: VaultFile['origin']; created_at?: string; backup_verified: boolean; backup_verified_at: string | null } {
    if (!this.exists()) return { exists: false, backup_verified: false, backup_verified_at: null }
    const f = this.read()
    return { exists: true, origin: f.origin, created_at: f.created_at, backup_verified: !!f.backup_verified_at, backup_verified_at: f.backup_verified_at }
  }

  /** Three distinct word positions (1-based) the user must re-enter. A new call replaces the previous challenge. */
  backupChallenge(): number[] {
    this.read()
    const picks = new Set<number>()
    while (picks.size < BACKUP_WORDS) picks.add(randomInt(1, 13))
    this.challenge = [...picks].sort((a, b) => a - b)
    return this.challenge
  }

  /** Checks the re-entered words against the sealed seed; records the proven backup on success. */
  verifyBackup(passphrase: string, answers: Record<string, string>): boolean {
    const positions = this.challenge
    if (!positions) throw new VaultError('backup', 'ask for a backup check first')
    const words = this.unlock(passphrase).split(' ')
    this.challenge = null // one attempt per challenge
    const ok = positions.every((pos) => {
      const want = Buffer.from(words[pos - 1] ?? '')
      const got = Buffer.from(normaliseWords(String(answers[String(pos)] ?? '')))
      return want.length === got.length && timingSafeEqual(want, got)
    })
    if (ok) {
      const f = this.read()
      this.write({ ...f, backup_verified_at: new Date().toISOString() })
    }
    return ok
  }

  /** Throws unless the backup is proven: the gate before the first loan. */
  assertBackupVerified(): void {
    if (!this.info().backup_verified) throw new VaultError('backup', 'prove your backup first: re-enter 3 of your words')
  }
}
