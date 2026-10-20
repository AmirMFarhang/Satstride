// One deployment config (passbook.config.yaml), loaded once and validated at
// startup. Every variable part of Passbook is chosen here: how the credit check
// is trusted, how repayment settles, negotiation limits and compliance hooks.
// A wrong or unsupported value refuses to start and names every problem.
//
// The parser reads a strict YAML subset (nested maps, scalars, inline [a, b]
// lists and inline { k: v } maps, # comments) so no YAML dependency is needed.
// Anything outside the subset is an error, never a guess.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { isHex, type Hex } from './crypto.js'
import { DEFAULT_ECONOMICS, economicsProblems, type Economics } from './economics.js'
import { MICRO_PER_USDT, type Micro } from './money.js'
import { PROVIDER_TRUST, SCORER_PROVIDERS, TRUST_LEVELS, UNAVAILABLE_PROVIDERS, trustAtLeast, type ScorerProviderKind, type TrustLevel } from '../scorer/trust.js'
import { FALLBACK_SETTLEMENT, SETTLEMENT_KINDS, SETTLEMENT_STATUS, type SettlementKind } from '../settlement/kinds.js'
import { networkProblems, networkProfile, type Endpoints, type NetworkProfile } from './network.js'

export type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue }

export interface PassbookConfig {
  /** Absolute path of the file this was loaded from, or '<inline>'. */
  source: string
  scorer: {
    provider: ScorerProviderKind
    /** Used only when the primary is unavailable; its results carry its own, lower trust. */
    fallback: 'none' | 'container' | 'in-process'
    min_trust_for_lenders: TrustLevel
    /** Absolute path of the signed release manifest. */
    approved_builds: string
    /** Key that signs the release manifest; required outside development. */
    release_signer_pk?: Hex
    /** Base URL of the container scorer. */
    url?: string
    /** Optional installed package; its private configuration lives in a local JSON file. */
    external?: { package: string; options_file: string }
  }
  settlement: { default: SettlementKind; enabled: SettlementKind[] }
  negotiation: { enabled: boolean; max_rounds: number; concession_bps: number }
  compliance: {
    identity: 'none' | `provider:${string}`
    sanctions: 'none' | 'opensanctions'
    consent_receipts: 'required' | 'optional'
    approvals: { maker_checker_above_micro: Micro }
    /** The box keeps nothing; the scoring contract fixes retention: none. */
    data_retention_days: 0
  }
  /**
   * The loan asset is a deployment choice, by jurisdiction: the protocol carries only an RGB asset id
   * and never names a token. `label` is what people see (the demo: "test USDT").
   */
  asset: { id_from: string; ticker: string; label: string; precision: number; jurisdiction: string }
  /** Pricing bounds and the platform's share (src/core/economics.ts); DEFAULT_ECONOMICS when the section is absent. */
  economics: Economics
  /** The credit agent's read-only history chains and sources (src/networks); DEFAULT_CREDIT when the section is absent. */
  credit: CreditConfig
  /** Network profile and endpoints (src/core/network.ts); regtest from the environment when absent. */
  network: NetworkProfile
}

/**
 * Where the credit agent reads layer history. History chains are read-only and
 * separate from the loan chain: reading Bitcoin mainnet never lets anything
 * spend there (src/networks/guard.ts). `sources` is the borrower device's
 * source per chain; `lender_sources` is the lender's own, a different indexer.
 */
export interface CreditConfig {
  history_chains: ('bitcoin' | 'signet' | 'regtest')[]
  sources: Partial<Record<'bitcoin' | 'signet' | 'regtest', string>>
  lender_sources: Partial<Record<'bitcoin' | 'signet' | 'regtest', string>>
  /** Recorded snapshot used when the live source is offline; '' for none. Absolute path. */
  snapshot: string
  window_days: number
}

export const DEFAULT_CREDIT: Readonly<CreditConfig> = Object.freeze({
  history_chains: ['bitcoin'],
  sources: { bitcoin: 'https://mempool.space/api' },
  lender_sources: { bitcoin: 'https://blockstream.info/api' },
  snapshot: '',
  window_days: 365,
}) as CreditConfig

export class ConfigError extends Error {
  constructor(readonly source: string, readonly problems: string[]) {
    super(`invalid Passbook config ${source}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

// ---- YAML subset ----

function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function splitTopLevel(body: string, lineNo: number): string[] {
  const parts: string[] = []
  let depth = 0, quote: string | null = null, start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1 }
  }
  if (quote || depth !== 0) throw new Error(`line ${lineNo}: unbalanced brackets or quotes`)
  const last = body.slice(start)
  if (last.trim() || parts.length) parts.push(last)
  return parts.map((p) => p.trim())
}

function scalar(raw: string, lineNo: number): YamlValue {
  const text = raw.trim()
  if (!text) throw new Error(`line ${lineNo}: empty value`)
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`line ${lineNo}: unterminated inline list`)
    const items = splitTopLevel(text.slice(1, -1), lineNo)
    if (items.some((item) => !item)) throw new Error(`line ${lineNo}: empty list item`)
    return items.map((item) => scalar(item, lineNo))
  }
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw new Error(`line ${lineNo}: unterminated inline map`)
    const out: Record<string, YamlValue> = {}
    for (const pair of splitTopLevel(text.slice(1, -1), lineNo)) {
      // whole-number keys are allowed in inline maps only, e.g. { 30: 6500 } (economics.max_ltv_bps_by_term)
      const m = /^([A-Za-z_][A-Za-z0-9_-]*|[1-9][0-9]*):\s+(.+)$/.exec(pair)
      if (!m) throw new Error(`line ${lineNo}: inline map entries must be "key: value"`)
      if (m[1] in out) throw new Error(`line ${lineNo}: duplicate key ${m[1]}`)
      out[m[1]] = scalar(m[2], lineNo)
    }
    return out
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith(text[0])) throw new Error(`line ${lineNo}: unterminated string`)
    const inner = text.slice(1, -1)
    if (inner.includes(text[0]) || inner.includes('\\')) throw new Error(`line ${lineNo}: escapes are not supported in strings`)
    return inner
  }
  if (/^(true|false)$/.test(text)) return text === 'true'
  if (/^-?(0|[1-9][0-9]*)$/.test(text)) {
    const n = Number(text)
    if (!Number.isSafeInteger(n)) throw new Error(`line ${lineNo}: integer out of range`)
    return n
  }
  if (/^(null|~|yes|no|on|off)$/i.test(text) || /^[-+]?[0-9.]+(e[-+]?[0-9]+)?$/i.test(text)) throw new Error(`line ${lineNo}: ambiguous value ${text}; quote it`)
  if (/[:#]\s|[[\]{},&*!|>%@`]/.test(text) || text.startsWith('- ')) throw new Error(`line ${lineNo}: unsupported plain value ${text}; quote it`)
  return text
}

export function parseYamlSubset(text: string): Record<string, YamlValue> {
  const root: Record<string, YamlValue> = {}
  const stack: { indent: number; map: Record<string, YamlValue> }[] = [{ indent: -1, map: root }]
  let pending: { indent: number; map: Record<string, YamlValue>; key: string; lineNo: number } | null = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    if (/^\s*\t/.test(lines[i])) throw new Error(`line ${lineNo}: tabs are not allowed for indentation`)
    const line = stripComment(lines[i]).replace(/\s+$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (indent % 2) throw new Error(`line ${lineNo}: indent with multiples of two spaces`)
    const body = line.trim()
    if (body.startsWith('- ') || body === '-') throw new Error(`line ${lineNo}: block lists are not supported; use [a, b]`)
    if (/^(---|\.\.\.)$/.test(body)) throw new Error(`line ${lineNo}: multiple documents are not supported`)
    if (pending) {
      if (indent <= pending.indent) throw new Error(`line ${pending.lineNo}: ${pending.key} has no value`)
      const child: Record<string, YamlValue> = {}
      pending.map[pending.key] = child
      stack.push({ indent, map: child })
      pending = null
    }
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop()
    const top = stack[stack.length - 1]
    if (indent !== (stack.length === 1 ? 0 : top.indent)) throw new Error(`line ${lineNo}: inconsistent indentation`)
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(body)
    if (!m) throw new Error(`line ${lineNo}: expected "key: value"`)
    const [, key, value] = m
    if (key in top.map) throw new Error(`line ${lineNo}: duplicate key ${key}`)
    if (value === undefined || value === '') pending = { indent, map: top.map, key, lineNo }
    else top.map[key] = scalar(value, lineNo)
  }
  if (pending) throw new Error(`line ${pending.lineNo}: ${pending.key} has no value`)
  return root
}

// ---- validation ----

type Raw = Record<string, YamlValue>

class Reader {
  readonly problems: string[] = []

  section(raw: Raw, name: string, allowed: string[]): Raw {
    const value = raw[name]
    if (value === undefined) { this.problems.push(`${name}: section is required`); return {} }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.problems.push(`${name}: must be a map`); return {} }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.problems.push(`${name}.${key}: unknown setting (allowed: ${allowed.join(', ')})`)
    return value as Raw
  }

  oneOf<T extends string>(raw: Raw, path: string, key: string, options: readonly T[], fallback?: T): T {
    const value = raw[key] ?? fallback
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T
    this.problems.push(`${path}.${key}: must be one of ${options.join(' | ')}${value === undefined ? ' (missing)' : `, got ${JSON.stringify(value)}`}`)
    return options[0]
  }

  int(raw: Raw, path: string, key: string, min: number, max: number, fallback?: number): number {
    const value = raw[key] ?? fallback
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) return value
    this.problems.push(`${path}.${key}: must be an integer from ${min} to ${max}${value === undefined ? ' (missing)' : `, got ${JSON.stringify(value)}`}`)
    return min
  }

  bool(raw: Raw, path: string, key: string): boolean {
    if (typeof raw[key] === 'boolean') return raw[key] as boolean
    this.problems.push(`${path}.${key}: must be true or false`)
    return false
  }

  path(raw: Raw, at: string, key: string, baseDir: string, optional = false): string {
    const value = raw[key]
    if (value === undefined && optional) return ''
    if (typeof value !== 'string' || !value) { this.problems.push(`${at}.${key}: must be a file path`); return '' }
    return isAbsolute(value) ? value : resolve(baseDir, value)
  }
}

export interface ParseOptions {
  /** Directory relative paths resolve against; the config file's directory when loading a file. */
  baseDir?: string
  source?: string
  /** Check that referenced release files exist (default true). */
  checkFiles?: boolean
}

export function validateConfig(raw: Raw, opts: ParseOptions = {}): PassbookConfig {
  const source = opts.source ?? '<inline>'
  const baseDir = opts.baseDir ?? process.cwd()
  const r = new Reader()
  for (const key of Object.keys(raw)) if (!['scorer', 'settlement', 'negotiation', 'compliance', 'asset', 'economics', 'network', 'endpoints', 'credit'].includes(key)) r.problems.push(`${key}: unknown section`)

  const s = r.section(raw, 'scorer', ['provider', 'fallback', 'min_trust_for_lenders', 'approved_builds', 'release_signer_pk', 'url', 'external'])
  const provider = r.oneOf(s, 'scorer', 'provider', SCORER_PROVIDERS)
  const fallback = r.oneOf(s, 'scorer', 'fallback', ['none', 'container', 'in-process'] as const, 'none')
  const minTrust = r.oneOf(s, 'scorer', 'min_trust_for_lenders', TRUST_LEVELS)
  const approvedBuilds = r.path(s, 'scorer', 'approved_builds', baseDir)
  const files = opts.checkFiles !== false
  if (UNAVAILABLE_PROVIDERS.has(provider)) r.problems.push(`scorer.provider: ${provider} is not available in this release (${UNAVAILABLE_PROVIDERS.get(provider)})`)
  else if (!trustAtLeast(PROVIDER_TRUST[provider], minTrust)) r.problems.push(`scorer.provider: ${provider} can reach at most ${PROVIDER_TRUST[provider]}, below scorer.min_trust_for_lenders ${minTrust}; lenders would refuse every result`)
  if (fallback !== 'none' && fallback === provider) r.problems.push('scorer.fallback: must differ from scorer.provider')
  if (approvedBuilds && files && !existsSync(approvedBuilds)) r.problems.push(`scorer.approved_builds: ${approvedBuilds} does not exist`)
  const signer = s.release_signer_pk
  if (signer !== undefined && !isHex(signer, 32)) r.problems.push('scorer.release_signer_pk: must be a 32-byte x-only hex key')
  const url = s.url
  if (url !== undefined && (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url))) r.problems.push('scorer.url: must be an http(s) URL')
  let external: PassbookConfig['scorer']['external']
  if(s.external !== undefined || provider === 'external') {
    const x=s.external
    if(!x || typeof x !== 'object' || Array.isArray(x)) r.problems.push('scorer.external: package and options_file required')
    else {
      for(const k of Object.keys(x)) if(!['package','options_file'].includes(k)) r.problems.push(`scorer.external.${k}: unknown setting`)
      if(typeof x.package !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(x.package)) r.problems.push('scorer.external.package: installed package name required')
      const options_file=r.path(x as Raw,'scorer.external','options_file',baseDir)
      if(files && options_file && !existsSync(options_file))r.problems.push('scorer.external.options_file: file does not exist')
      external={package:x.package as string, options_file}
    }
  }

  const st = r.section(raw, 'settlement', ['default', 'enabled'])
  const def = r.oneOf(st, 'settlement', 'default', SETTLEMENT_KINDS)
  let enabled: SettlementKind[] = []
  if (!Array.isArray(st.enabled) || st.enabled.length === 0) r.problems.push('settlement.enabled: must be a non-empty list, e.g. [cosign-rgb, ln-rln]')
  else {
    for (const kind of st.enabled) {
      if (typeof kind !== 'string' || !(SETTLEMENT_KINDS as readonly string[]).includes(kind)) r.problems.push(`settlement.enabled: unknown kind ${JSON.stringify(kind)} (allowed: ${SETTLEMENT_KINDS.join(', ')})`)
      else if (!SETTLEMENT_STATUS[kind as SettlementKind].built) r.problems.push(`settlement.enabled: ${kind} is not built in this release (${SETTLEMENT_STATUS[kind as SettlementKind].note})`)
      else if (enabled.includes(kind as SettlementKind)) r.problems.push(`settlement.enabled: ${kind} listed twice`)
      else enabled.push(kind as SettlementKind)
    }
    if (!st.enabled.includes(FALLBACK_SETTLEMENT)) r.problems.push(`settlement.enabled: must include ${FALLBACK_SETTLEMENT}, the always-on fallback`)
  }
  if (st.default !== undefined && Array.isArray(st.enabled) && !st.enabled.includes(def)) r.problems.push(`settlement.default: ${def} is not in settlement.enabled`)
  enabled = [...new Set(enabled)]

  const n = r.section(raw, 'negotiation', ['enabled', 'max_rounds', 'concession_bps'])
  const negotiation = { enabled: r.bool(n, 'negotiation', 'enabled'), max_rounds: r.int(n, 'negotiation', 'max_rounds', 1, 10), concession_bps: r.int(n, 'negotiation', 'concession_bps', 100, 10_000, 2_500) }

  const c = r.section(raw, 'compliance', ['identity', 'sanctions', 'consent_receipts', 'approvals', 'data_retention_days'])
  const identity = c.identity
  if (typeof identity !== 'string' || !(identity === 'none' || /^provider:[a-z0-9][a-z0-9-]{0,40}$/.test(identity))) r.problems.push('compliance.identity: must be none or provider:<name>')
  const sanctions = r.oneOf(c, 'compliance', 'sanctions', ['none', 'opensanctions'] as const)
  if (sanctions === 'opensanctions') r.problems.push('compliance.sanctions: opensanctions is a documented hook, not integrated in this release; use none')
  if (typeof identity === 'string' && identity.startsWith('provider:')) r.problems.push(`compliance.identity: ${identity} has no implementation in this release; use none`)
  const consent = r.oneOf(c, 'compliance', 'consent_receipts', ['required', 'optional'] as const)
  const approvals = c.approvals
  let threshold = 0
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) r.problems.push('compliance.approvals: must be a map like { maker_checker_above_usdt: 5000 }')
  else {
    for (const key of Object.keys(approvals)) if (key !== 'maker_checker_above_usdt') r.problems.push(`compliance.approvals.${key}: unknown setting`)
    threshold = r.int(approvals as Raw, 'compliance.approvals', 'maker_checker_above_usdt', 0, 1_000_000_000)
  }
  if (c.data_retention_days !== 0) r.problems.push(`compliance.data_retention_days: must be 0; the scoring contract fixes retention: none (got ${JSON.stringify(c.data_retention_days)})`)

  const a = r.section(raw, 'asset', ['id_from', 'ticker', 'label', 'precision', 'jurisdiction'])
  const assetFrom = r.path(a, 'asset', 'id_from', baseDir)
  const asset: PassbookConfig['asset'] = { ...DEFAULT_ASSET, id_from: assetFrom }
  for (const key of ['ticker', 'label', 'jurisdiction'] as const) {
    if (a[key] === undefined) continue
    const value = a[key]
    const ok = typeof value === 'string' && (key === 'ticker' ? /^[A-Z][A-Z0-9]{1,9}$/.test(value) : key === 'jurisdiction' ? /^[a-z][a-z0-9-]{1,40}$/.test(value) : value.length >= 1 && value.length <= 40)
    if (!ok) r.problems.push(`asset.${key}: ${key === 'ticker' ? 'two to ten capitals or digits' : key === 'jurisdiction' ? 'a lowercase id such as eu, ch or regtest-demo' : 'one to forty characters'}, got ${JSON.stringify(value)}`)
    else asset[key] = value as string
  }
  if (a.precision !== undefined) asset.precision = r.int(a, 'asset', 'precision', 0, 18)

  const economics = readEconomics(r, raw)
  const credit = readCredit(r, raw, baseDir, files)
  const network = readNetwork(r, raw)

  if (r.problems.length) throw new ConfigError(source, r.problems)
  return {
    source,
    scorer: { provider, fallback, min_trust_for_lenders: minTrust, approved_builds: approvedBuilds, ...(signer !== undefined ? { release_signer_pk: signer as Hex } : {}), ...(url !== undefined ? { url: url as string } : {}), ...(external ? { external } : {}) },
    settlement: { default: def, enabled },
    negotiation,
    compliance: { identity: identity as PassbookConfig['compliance']['identity'], sanctions, consent_receipts: consent, approvals: { maker_checker_above_micro: threshold * MICRO_PER_USDT }, data_retention_days: 0 },
    asset,
    economics,
    credit,
    network: network!,
  }
}

/** The demo's asset: test USDT issued on regtest. A deployment names its own (docs/COMPLIANCE.md, asset by jurisdiction). */
export const DEFAULT_ASSET = Object.freeze({ ticker: 'USDT', label: 'test USDT', precision: 6, jurisdiction: 'regtest-demo' })

const HISTORY_CHAINS = ['bitcoin', 'signet', 'regtest'] as const

/** The credit section: absent means DEFAULT_CREDIT. Sources are Esplora http(s) URLs or, for regtest/signet stacks, tcp:// Electrum. */
function readCredit(r: Reader, raw: Raw, baseDir: string, files: boolean): CreditConfig {
  if (raw.credit === undefined) return { ...DEFAULT_CREDIT, history_chains: [...DEFAULT_CREDIT.history_chains], sources: { ...DEFAULT_CREDIT.sources }, lender_sources: { ...DEFAULT_CREDIT.lender_sources } }
  const c = r.section(raw, 'credit', ['history_chains', 'sources', 'lender_sources', 'snapshot', 'window_days'])
  const chains: CreditConfig['history_chains'] = []
  if (!Array.isArray(c.history_chains) || !c.history_chains.length) r.problems.push('credit.history_chains: must be a non-empty list, e.g. [bitcoin]')
  else for (const ch of c.history_chains) {
    if (typeof ch !== 'string' || !(HISTORY_CHAINS as readonly string[]).includes(ch)) r.problems.push(`credit.history_chains: unknown chain ${JSON.stringify(ch)} (allowed: ${HISTORY_CHAINS.join(', ')})`)
    else if (!chains.includes(ch as never)) chains.push(ch as CreditConfig['history_chains'][number])
  }
  const urls = (key: 'sources' | 'lender_sources'): CreditConfig['sources'] => {
    const v = c[key] ?? (key === 'sources' ? DEFAULT_CREDIT.sources : DEFAULT_CREDIT.lender_sources)
    if (!v || typeof v !== 'object' || Array.isArray(v)) { r.problems.push(`credit.${key}: must be a map like { bitcoin: 'https://mempool.space/api' }`); return {} }
    const out: CreditConfig['sources'] = {}
    for (const [chain, url] of Object.entries(v)) {
      if (!(HISTORY_CHAINS as readonly string[]).includes(chain)) r.problems.push(`credit.${key}.${chain}: unknown chain`)
      else if (typeof url !== 'string' || !/^(https?|tcp):\/\/[^\s]+$/.test(url)) r.problems.push(`credit.${key}.${chain}: must be an http(s) Esplora URL or a tcp:// Electrum endpoint`)
      else out[chain as keyof CreditConfig['sources']] = url
    }
    for (const ch of chains) if (!out[ch]) r.problems.push(`credit.${key}: no source for history chain ${ch}`)
    return out
  }
  const sources = urls('sources'), lender_sources = urls('lender_sources')
  for (const ch of chains) if (sources[ch] && sources[ch] === lender_sources[ch]) r.problems.push(`credit.lender_sources.${ch}: must differ from credit.sources.${ch}; the lender recomputes from its own source`)
  const snapshot = r.path(c, 'credit', 'snapshot', baseDir, true)
  if (snapshot && files && !existsSync(snapshot)) r.problems.push(`credit.snapshot: ${snapshot} does not exist`)
  const window_days = r.int(c, 'credit', 'window_days', 1, 3650, 365)
  return { history_chains: chains, sources, lender_sources, snapshot, window_days }
}

/**
 * `network: regtest | mutinynet | testnet4` and its `endpoints` map. Absent
 * means regtest. A mainnet name, a public network without its endpoints, or
 * an endpoint known to serve another network is a problem: refuse to start.
 */
function readNetwork(r: Reader, raw: Raw): NetworkProfile | undefined {
  const name = raw.network ?? 'regtest'
  const e = raw.endpoints
  if (e !== undefined && (!e || typeof e !== 'object' || Array.isArray(e))) { r.problems.push('endpoints: must be a map'); return undefined }
  const endpoints = (e ?? {}) as Partial<Endpoints>
  const problems = networkProblems(name, endpoints)
  if (problems.length) { r.problems.push(...problems); return undefined }
  return networkProfile(name as NetworkProfile['name'], endpoints)
}

const ECONOMICS_KEYS = ['platform_share_bps', 'max_apr_bps', 'max_ltv_bps_by_term', 'day_count', 'blocks_per_day', 'fee_grace_blocks']

/** The economics section: absent means DEFAULT_ECONOMICS; present means every key, validated. */
function readEconomics(r: Reader, raw: Raw): Economics {
  if (raw.economics === undefined) return DEFAULT_ECONOMICS
  const e = r.section(raw, 'economics', ECONOMICS_KEYS)
  const before = r.problems.length
  const byTerm = e.max_ltv_bps_by_term
  if (!byTerm || typeof byTerm !== 'object' || Array.isArray(byTerm)) r.problems.push('economics.max_ltv_bps_by_term: must be a map of days to bps, e.g. { 30: 6500, 60: 6000, 90: 5500 }')
  const out: Economics = {
    platform_share_bps: r.int(e, 'economics', 'platform_share_bps', 0, 10_000),
    max_apr_bps: r.int(e, 'economics', 'max_apr_bps', 1, 1_000_000),
    max_ltv_bps_by_term: byTerm && typeof byTerm === 'object' && !Array.isArray(byTerm) ? (byTerm as Record<string, number>) : {},
    day_count: r.oneOf(e, 'economics', 'day_count', ['ACT/365'] as const),
    blocks_per_day: r.int(e, 'economics', 'blocks_per_day', 1, 1_000),
    fee_grace_blocks: r.int(e, 'economics', 'fee_grace_blocks', 0, 1_000_000),
  }
  if (r.problems.length === before) for (const p of economicsProblems(out)) r.problems.push(`economics.${p}`)
  return out
}

export function parseConfig(text: string, opts: ParseOptions = {}): PassbookConfig {
  let raw: Raw
  try {
    raw = parseYamlSubset(text)
  } catch (err) {
    throw new ConfigError(opts.source ?? '<inline>', [(err as Error).message])
  }
  return validateConfig(raw, opts)
}

export const DEFAULT_CONFIG_PATH = 'passbook.config.yaml'

/** PASSBOOK_CONFIG, else ./passbook.config.yaml. Throws ConfigError with every problem. */
export function loadConfig(path = process.env.PASSBOOK_CONFIG ?? DEFAULT_CONFIG_PATH, opts: Omit<ParseOptions, 'baseDir' | 'source'> = {}): PassbookConfig {
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new ConfigError(absolute, ['file not found; copy passbook.config.yaml from the repository root'])
  return parseConfig(readFileSync(absolute, 'utf8'), { ...opts, baseDir: dirname(absolute), source: absolute })
}

/**
 * The deployment config for a process entry point. PASSBOOK_CONFIG, when set,
 * must load. Otherwise ./passbook.config.yaml is validated if it exists, and
 * its absence means built-in demo defaults (returned as null). Any invalid
 * file throws ConfigError, so the process refuses to start.
 */
export function deploymentConfigFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): PassbookConfig | null {
  if (env.PASSBOOK_CONFIG) return loadConfig(env.PASSBOOK_CONFIG)
  const local = resolve(cwd, DEFAULT_CONFIG_PATH)
  return existsSync(local) ? loadConfig(local) : null
}

/** For logs and the dashboard: what this deployment runs, in one line. */
export function describeConfig(cfg: PassbookConfig): string {
  return `network ${cfg.network.label}; scorer ${cfg.scorer.provider}${cfg.scorer.fallback === 'none' ? '' : ` (fallback ${cfg.scorer.fallback}, labelled)`}; lenders need ${cfg.scorer.min_trust_for_lenders}; settlement ${cfg.settlement.default} of [${cfg.settlement.enabled.join(', ')}]; negotiation ${cfg.negotiation.enabled ? `${cfg.negotiation.max_rounds} rounds` : 'off'}; identity ${cfg.compliance.identity}; sanctions ${cfg.compliance.sanctions}; platform ${cfg.economics.platform_share_bps / 100}% of interest, APR cap ${cfg.economics.max_apr_bps / 100}%; asset ${cfg.asset.label} (${cfg.asset.jurisdiction})`
}
