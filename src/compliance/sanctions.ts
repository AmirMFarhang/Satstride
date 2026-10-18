// Sanctions screening of Bitcoin addresses, offline. The lists are pinned
// snapshot files under infra/sanctions/ (manifest.json names each file, its
// SHA-256, its source and its date): the OFAC SDN digital-currency addresses
// for XBT and the Bitcoin wallets of an OpenSanctions dataset. Nothing is
// fetched at run time; refreshing a list is a reviewed commit.
//
// What is screened: the addresses the borrower proved it controls (hop 0) and
// their direct counterparties, the addresses that paid them or that they paid
// (hop 1). A hit on either blocks the loan; the result always names the list
// version it was checked against, so the decision log can say which list said
// what. A clear result is "not on these lists at this date", nothing more.
//
// This interface is consumed by the layers work (src/networks/**): keep it stable.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hex } from '../core/crypto.js'

/** Who is being screened, by address. */
export interface ScreeningSubject {
  /** Whose addresses these are (the borrower's party key), for the log. */
  subject_pk?: Hex
  /** Addresses the subject proved it controls (BIP-322, a Lightning node proof, its Passbook key-path address). */
  proven_addresses: readonly string[]
  /** Direct counterparties of those addresses, one hop away: who paid them, or whom they paid. */
  counterparties?: readonly { address: string; /** the proven address it transacted with */ of: string; txid?: string }[]
}

export interface SanctionsListInfo {
  list_id: string
  title: string
  as_of: string
  retrieved_at: string
  source_url: string
  sha256: Hex
  entries: number
}

export interface SanctionsHit {
  address: string
  /** 0: a proven address; 1: a direct counterparty of one. */
  hop: 0 | 1
  /** For hop 1, the proven address it transacted with. */
  via?: string
  txid?: string
  list_id: string
  /** What the list says about the address (OpenSanctions carries names; the OFAC address file does not). */
  entry: { name?: string; entity_id?: string; currency?: string; topics?: string }
}

export interface AddressScreeningResult {
  status: 'clear' | 'hit'
  screen: string
  /** e.g. ofac-sdn-xbt@2026-10-01+opensanctions-il_mod_crypto-btc@2026-10-17 */
  list_version: string
  lists: SanctionsListInfo[]
  screened: { proven: number; counterparties: number }
  hits: SanctionsHit[]
  screened_at: number
}

export interface SanctionsScreen {
  readonly name: string
  /** The exact lists and dates this screen checks against. */
  readonly listVersion: string
  screen(subject: ScreeningSubject): Promise<AddressScreeningResult>
}

interface ListEntry { list_id: string; entry: SanctionsHit['entry'] }
interface ManifestList { list_id: string; title: string; file: string; format: string; sha256: string; entries: number; source_url: string; as_of: string; retrieved_at: string }

/** Bech32 addresses are case-insensitive; base58 addresses are not. */
export function normalizeAddress(address: string): string {
  const a = address.trim()
  return /^(bc|tb|bcrt)1/i.test(a) ? a.toLowerCase() : a
}

export const DEFAULT_SANCTIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../infra/sanctions')

/** A list held in memory (tests, or a deployment's own extra list). Label it honestly. */
export interface InMemoryList { info: SanctionsListInfo; entries: { address: string; entry?: SanctionsHit['entry'] }[] }

export class OfflineSanctionsScreen implements SanctionsScreen {
  readonly name = 'offline-snapshot'
  readonly listVersion: string
  readonly lists: SanctionsListInfo[]
  private readonly index = new Map<string, ListEntry[]>()

  constructor(lists: InMemoryList[]) {
    if (!lists.length) throw new Error('a sanctions screen needs at least one list')
    this.lists = lists.map((l) => l.info)
    this.listVersion = lists.map((l) => `${l.info.list_id}@${l.info.as_of}`).join('+')
    for (const l of lists) for (const e of l.entries) {
      const key = normalizeAddress(e.address)
      const at = this.index.get(key) ?? []
      at.push({ list_id: l.info.list_id, entry: e.entry ?? {} })
      this.index.set(key, at)
    }
  }

  /** The pinned snapshots under `dir` (infra/sanctions by default). Refuses a file whose hash differs from the manifest. */
  static fromSnapshot(dir = DEFAULT_SANCTIONS_DIR, extra: InMemoryList[] = []): OfflineSanctionsScreen {
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error(`no sanctions manifest at ${manifestPath}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { lists: ManifestList[] }
    const lists: InMemoryList[] = manifest.lists.map((m) => {
      const bytes = readFileSync(join(dir, m.file))
      const sha = createHash('sha256').update(bytes).digest('hex')
      if (sha !== m.sha256) throw new Error(`sanctions snapshot ${m.file} does not match its pinned hash (${sha.slice(0, 12)}… != ${m.sha256.slice(0, 12)}…)`)
      const lines = bytes.toString('utf8').split('\n').filter((l) => l.trim())
      const entries = m.format.startsWith('tsv')
        ? lines.map((l) => { const [address, entity_id, name, currency, topics] = l.split('\t'); return { address, entry: { entity_id, ...(name ? { name } : {}), ...(currency ? { currency } : {}), ...(topics ? { topics } : {}) } } })
        : lines.map((address) => ({ address }))
      if (entries.length !== m.entries) throw new Error(`sanctions snapshot ${m.file}: ${entries.length} entries, manifest says ${m.entries}`)
      return { info: { list_id: m.list_id, title: m.title, as_of: m.as_of, retrieved_at: m.retrieved_at, source_url: m.source_url, sha256: m.sha256, entries: m.entries }, entries }
    })
    return new OfflineSanctionsScreen([...lists, ...extra])
  }

  lookup(address: string): ListEntry[] {
    return this.index.get(normalizeAddress(address)) ?? []
  }

  async screen(subject: ScreeningSubject): Promise<AddressScreeningResult> {
    const hits: SanctionsHit[] = []
    const proven = [...new Set(subject.proven_addresses.map(normalizeAddress))]
    for (const address of proven) for (const m of this.lookup(address)) hits.push({ address, hop: 0, list_id: m.list_id, entry: m.entry })
    const seen = new Set<string>()
    for (const c of subject.counterparties ?? []) {
      const address = normalizeAddress(c.address)
      const key = `${address}|${c.of}`
      if (seen.has(key)) continue
      seen.add(key)
      for (const m of this.lookup(address)) hits.push({ address, hop: 1, via: c.of, ...(c.txid ? { txid: c.txid } : {}), list_id: m.list_id, entry: m.entry })
    }
    return { status: hits.length ? 'hit' : 'clear', screen: this.name, list_version: this.listVersion, lists: this.lists, screened: { proven: proven.length, counterparties: new Set((subject.counterparties ?? []).map((c) => normalizeAddress(c.address))).size }, hits, screened_at: Math.floor(Date.now() / 1000) }
  }
}

let bundled: OfflineSanctionsScreen | undefined

/** The bundled snapshot, loaded once per process. */
export function bundledSanctionsScreen(): OfflineSanctionsScreen {
  bundled ??= OfflineSanctionsScreen.fromSnapshot()
  return bundled
}

/** No list loaded: every result has no lists, which the gate and the credit agent report as NOT SCREENED, never clear. */
export class NoListSanctionsScreen implements SanctionsScreen {
  readonly name: string
  readonly listVersion = 'none'
  constructor(reason = 'no sanctions snapshot loaded') { this.name = `not screened: ${reason}` }
  async screen(subject: ScreeningSubject): Promise<AddressScreeningResult> {
    return { status: 'clear', screen: this.name, list_version: this.listVersion, lists: [], screened: { proven: subject.proven_addresses.length, counterparties: subject.counterparties?.length ?? 0 }, hits: [], screened_at: Math.floor(Date.now() / 1000) }
  }
}

/** The bundled snapshot when it loads and verifies; otherwise a screen that says plainly it screened nothing. */
export function availableSanctionsScreen(): SanctionsScreen {
  try { return bundledSanctionsScreen() } catch (err) { return new NoListSanctionsScreen((err as Error).message) }
}
