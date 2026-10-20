import { PROVIDER_TRUST } from '../scorer/trust.js'
// The service provider's operator console (apps/console, docs in apps/console/API.md).
//
// Read-only, operator-only routes over what this node already holds: the loan
// registry and the platform fee ledger (platform.db), the order book, the
// governance stores and decision logs of every governed node under
// <wallets>/<role>/governance, the check node's public /status,
// close-time check bills, and the Nostr relays this
// platform follows. Nothing here invents a number: an unreachable source is
// shown as unreachable.
//
// Two operator actions only:
//   POST /console/api/kill-switch   the existing `passbook agent stop` path
//                                   (src/governance/cli.ts), behind a typed confirmation
//   POST /console/api/redteam/:id   known-bad requests at this node; each must be refused
//
// The console's static files are served at /console/ (a fixed list, like the
// dashboard's) and by apps/console/server.mjs on their own port.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { SimplePool, type Event, type Filter } from 'nostr-tools'
import type { ChainClient } from '../chain/types.js'
import { hashObject, keyPairFromSecret, randomKeyPair, sha256Hex, type Hex, type KeyPair } from '../core/crypto.js'
import type { Economics } from '../core/economics.js'
import type { NetworkProfile } from '../core/network.js'
import type { LoanTerms } from '../core/terms.js'
import { releaseHash, type CheckRelease } from '../checknode/offer.js'
import { runGovernanceCli } from '../governance/cli.js'
import { readLog, verifyLog, type LogEntry } from '../governance/log.js'
import { gateKeyFor, type NodeGovernance } from '../governance/node.js'
import { activeRecord, recordProblems, type PolicyRecord } from '../governance/policy.js'
import { FileGateStore, type StoreState } from '../governance/store.js'
import { KIND } from '../market/kinds.js'
import { appendMessage, negotiationId, verifyTranscript, type NegotiationMessage } from '../market/negotiate-engine.js'
import { askOperatorCopilot, type OperatorContext } from '../assistant/copilot.js'
import { assistantModelFromEnv } from '../assistant/model.js'
import type { OrderBook } from '../market/orderbook.js'
import type { Oracle } from '../oracle/oracle.js'
import type { Store, WireEvent } from '../registry/store.js'
import { scoredLoanProblems } from '../scorer/bundle-terms.js'
import { authorizeSignature, keySignerId, LocalKeySigner, partyKeyFromSeed, signerGate, SigningRefused } from '../wallet/signer.js'
import { walletsDir } from '../wallet/platform-key.js'
import { HttpError, type Api } from './api.js'
import { signRequest, type ApiAuth } from './auth.js'
import type { Platform } from './platform.js'

export interface ConsoleDeps {
  store: Store
  chain: ChainClient
  relays: string[]
  auth?: ApiAuth
  platform: Platform
  orderbook: OrderBook
  oracle: Oracle
  governance: NodeGovernance
  network: NetworkProfile
  economics: Economics
  /** Defaults: PASSBOOK_SP_STATE and PASSBOOK_WALLETS from the environment. */
  env?: NodeJS.ProcessEnv
  now?: () => number
}

const MICRO = 1_000_000
const short = (h: unknown) => (typeof h === 'string' ? `${h.slice(0, 12)}…` : '—')
const readJson = <T>(file: string): T | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null } }

const KIND_LABEL: Record<number, string> = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]))
const NEGOTIATION_KINDS = [KIND.NEG_ASK, KIND.NEG_OFFER, KIND.NEG_COUNTER, KIND.NEG_ACCEPT, KIND.NEG_NO_DEAL, KIND.NEG_TERMSHEET, KIND.NEG_APPROVED] as number[]
const CHECK_KINDS = [KIND.CHECK_REQUEST, KIND.CHECK_FEEDBACK, KIND.CHECK_RESULT, KIND.CHECK_KEY] as number[]

/** What the service provider wrote for the phone (infra/service-provider-info.ts): public data only. */
interface ProviderJson {
  project?: string
  asset?: { asset_id: string; ticker: string; note: string } | null
  lenders?: { name: string; pubkey: string | null; status: string }[]
  check_nodes?: { name: string; operator_pk: string; status_url: string; release?: CheckRelease; release_hash: string; payer_modes: string[]; scorer_label: string; price?: { asset: string; amount: number }; status: string }[]
}

interface CheckNodeStatus {
  name: string; operator_pk: string; scorer_label: string; scorer_fallback?: unknown; release: CheckRelease; release_hash: string
  execution?: { label: string }; price: { asset: string; amount: number }; payer_modes: string[]
  log: { negotiation_id: Hex; status: string; reason?: string; bill_hash?: Hex; rail?: string; paid_with?: string; at: number }[]
}

/** Additive serialized fee-ledger fields written by the bill-at-close provider (#71). */
interface BilledFeeFields {
  share_amount?: number
  check_fees?: { bill_hash: Hex; negotiation_id: Hex; operator_pk: Hex; asset_id: string; amount: number }[]
}


/** A governed node: <wallets>/<role>/governance with a gate store (the same rule as src/governance/cli.ts). */
interface GovNode { role: string; dir: string }

function governedNodes(wallets: string): GovNode[] {
  if (!existsSync(wallets)) return []
  return readdirSync(wallets, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(wallets, d.name, 'governance', 'gate-store.json')))
    .map((d) => ({ role: d.name, dir: join(wallets, d.name, 'governance') }))
    .sort((a, b) => (a.role === 'platform' ? -1 : b.role === 'platform' ? 1 : a.role.localeCompare(b.role)))
}

/** The key the node's log must be signed by: derived from the node's own key when readable here, else the quorum-verified policy's gate key. */
function expectedGateKey(wallets: string, n: GovNode, state: StoreState, now: number): { pk: Hex; anchor: string } | null {
  try {
    const owner = n.role === 'platform'
      ? keyPairFromSecret(process.env.PLATFORM_SECRET ?? readFileSync(join(wallets, 'platform', 'secret'), 'utf8').trim())
      : partyKeyFromSeed(readFileSync(join(wallets, n.role, 'seed'), 'utf8').trim())
    return { pk: gateKeyFor(owner).pubkey, anchor: 'gate key derived from the node key' }
  } catch { /* no key here */ }
  const active = activeRecord(state.policies, now)
  if (active && recordProblems(state.policies, active, active.policy.node_pk).length === 0) return { pk: active.policy.node_pk, anchor: `gate key of the quorum-signed policy v${active.policy.version}` }
  return null
}

/** Small time-boxed cache, so a poll every few seconds does not hammer the check node or the fee ledger. */
function cached<T>(ms: number, load: () => Promise<T>): () => Promise<T> {
  let at = 0
  let value: Promise<T> | null = null
  return () => {
    if (!value || Date.now() - at > ms) { at = Date.now(); value = load().catch((err) => { at = 0; throw err }) }
    return value
  }
}

async function getJson<T>(url: string, ms = 2500): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as T
}

export interface FeedItem { id: string; at: number; source: 'nostr' | 'decision-log' | 'platform'; kind: string; label: string; from: string | null; to: string | null; detail: string }

/** The Nostr side: one subscription to every relay this platform follows; ids, kinds and tags only (contents of encrypted kinds are never read). */
class RelayWatch {
  readonly events: Event[] = []
  private readonly ids = new Set<string>()
  private readonly pool: SimplePool | null
  readonly startedAt = Date.now()
  constructor(readonly relays: string[]) {
    this.pool = relays.length ? new SimplePool() : null
    if (!this.pool) return
    const kinds = Object.values(KIND) as number[]
    const filter: Filter = { kinds, since: Math.floor(Date.now() / 1000) - 7 * 86_400, limit: 1000 }
    this.pool.subscribeMany(relays, filter, { onevent: (e) => this.add(e) })
  }
  private add(e: Event): void {
    if (this.ids.has(e.id)) return
    this.ids.add(e.id)
    this.events.push(e)
    this.events.sort((a, b) => a.created_at - b.created_at)
    if (this.events.length > 2000) for (const old of this.events.splice(0, this.events.length - 2000)) this.ids.delete(old.id)
  }
  status(): { url: string; kind: 'local' | 'public'; connected: boolean; events_seen: number }[] {
    const live = this.pool?.listConnectionStatus() ?? new Map<string, boolean>()
    const norm = (u: string) => u.replace(/\/+$/, '')
    return this.relays.map((url) => ({
      url,
      kind: /^wss?:\/\/(127\.|localhost|\[::1\]|10\.|192\.168\.)/.test(url) ? 'local' as const : 'public' as const,
      connected: [...live].some(([u, ok]) => ok && norm(u) === norm(url)),
      events_seen: this.events.length,
    }))
  }
  close(): void { try { this.pool?.close(this.relays) } catch { /* closing */ } }
}

const tag = (e: Event, name: string): string | null => e.tags.find((t) => t[0] === name)?.[1] ?? null

export function negotiationState(kinds: number[]): 'asked' | 'negotiating' | 'agreed' | 'no-deal' | 'term-sheet' {
  if (kinds.includes(KIND.NEG_TERMSHEET) || kinds.includes(KIND.NEG_APPROVED)) return 'term-sheet'
  if (kinds.includes(KIND.NEG_NO_DEAL)) return 'no-deal'
  if (kinds.includes(KIND.NEG_ACCEPT)) return 'agreed'
  if (kinds.includes(KIND.NEG_OFFER) || kinds.includes(KIND.NEG_COUNTER)) return 'negotiating'
  return 'asked'
}

/** One CSV field: quoted when it holds a separator, a quote or a newline; a leading formula character is neutralised. */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const usdtString = (micro: number): string => (micro / MICRO).toFixed(6).replace(/\.?0+$/, '')


export function mountConsoleRoutes(api: Api, d: ConsoleDeps): void {
  const env = d.env ?? process.env
  const now = d.now ?? Date.now
  const stateDir = env.PASSBOOK_SP_STATE
  const wallets = () => (env.PASSBOOK_WALLETS ? env.PASSBOOK_WALLETS : walletsDir())
  const provider = () => (stateDir ? readJson<ProviderJson>(join(stateDir, 'provider.json')) : null)
  /** Every key infra/seed.ts created on this laptop (parties and test personas): public keys from the seed state, never a secret. */
  const seededKeys = (): Map<string, { name: string; persona: boolean }> => {
    const st = stateDir ? readJson<{ parties?: Record<string, { pubkey: string }>; personas?: Record<string, { party?: { pubkey: string } }> }>(join(stateDir, 'state.json')) : null
    const out = new Map<string, { name: string; persona: boolean }>()
    for (const [name, x] of Object.entries(st?.parties ?? {})) if (x?.pubkey) out.set(x.pubkey, { name, persona: false })
    for (const [name, x] of Object.entries(st?.personas ?? {})) if (x?.party?.pubkey) out.set(x.party.pubkey, { name, persona: true })
    return out
  }
  const nodeKind = (role: string): string => {
    if (role === 'platform') return 'platform'
    if ((provider()?.lenders ?? []).some((l) => l.name === role)) return "provider's lender"
    const st = stateDir ? readJson<{ personas?: Record<string, unknown> }>(join(stateDir, 'state.json')) : null
    return st?.personas && role in st.personas ? 'seeded regtest test persona (a borrower process on this laptop, labelled test data)' : 'governed node'
  }
  const relays = new RelayWatch(d.relays)
  // The operator copilot's model (src/assistant, lane D2): only when PASSBOOK_ASSIST_AI names one explicitly, e.g. qvac-http to the
  // configured local QVAC server. PASSBOOK_AI alone (the platform's own reasoner) never loads a model into the platform for the console.
  let copilotModel: ReturnType<typeof assistantModelFromEnv> = null
  let copilotModelError: string | null = null
  try { copilotModel = env.PASSBOOK_ASSIST_AI ? assistantModelFromEnv({ ...env, PASSBOOK_AI: undefined }) : null } catch (err) { copilotModelError = (err as Error).message }
  api.server.on('close', () => relays.close())
  const startedAt = now()

  // ---- the console's own files: a fixed list, nothing else from disk ----
  const FILES: Record<string, [string, string]> = {
    '/console/': ['index.html', 'text/html; charset=utf-8'], '/console/console.js': ['console.js', 'text/javascript; charset=utf-8'], '/console/console.css': ['console.css', 'text/css; charset=utf-8'],
    '/console/session-auth.js': ['session-auth.js', 'text/javascript; charset=utf-8'], '/console/brand.svg': ['brand.svg', 'image/svg+xml'],
    '/console/fonts/sans-regular.ttf': ['fonts/sans-regular.ttf', 'font/ttf'],
    '/console/fonts/sans-medium.ttf': ['fonts/sans-medium.ttf', 'font/ttf'],
    '/console/fonts/sans-semibold.ttf': ['fonts/sans-semibold.ttf', 'font/ttf'],
    '/console/fonts/mono-regular.ttf': ['fonts/mono-regular.ttf', 'font/ttf'],
  }
  const serve = async (res: import('node:http').ServerResponse, file: string, type: string) => {
    let body: Buffer
    try { body = await readFile(new URL(`../../apps/console/${file}`, import.meta.url)) } catch { throw new HttpError(404, 'not found') }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(body)
  }
  api.on('GET', '/console', ({ res }) => { res.writeHead(302, { location: '/console/' }); res.end() })
  for (const [route, [file, type]] of Object.entries(FILES)) api.on('GET', route, ({ res }) => serve(res, file, type))
  api.on('GET', '/console/js/:file', ({ res, params }) => {
    if (!/^[a-z0-9-]+\.js$/.test(params.file)) throw new HttpError(404, 'not found')
    return serve(res, `js/${params.file}`, 'text/javascript; charset=utf-8')
  })

  // ---- sources ----
  const checkNodeStatus = cached(3000, async (): Promise<CheckNodeStatus | null> => {
    const node = provider()?.check_nodes?.[0] ?? (stateDir ? readJson<{ status_url: string }>(join(stateDir, 'check-node.json')) : null)
    if (!node?.status_url) return null
    return getJson<CheckNodeStatus>(node.status_url.replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1'))
  })
  const qvacProbe = cached(10_000, async (): Promise<{ url: string | null; status: 'ready' | 'loading' | 'down' | 'not-configured'; models: { id: string; state: string }[] }> => {
    if (!env.QVAC_BASE_URL) return { url: null, status: 'not-configured', models: [] }
    const url = env.QVAC_BASE_URL.replace(/\/$/, '')
    try {
      const j = await getJson<{ data?: { id: string; state?: string }[] }>(`${url}/models`, 2000)
      const models = (j.data ?? []).map((m) => ({ id: m.id, state: m.state ?? 'unknown' }))
      return { url, status: models.some((m) => m.state === 'ready') ? 'ready' : 'loading', models }
    } catch { return { url, status: 'down', models: [] } }
  })
  const settle = async <T>(p: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    try { return { ok: true, value: await p() } } catch (err) { return { ok: false, error: (err as Error).message } }
  }

  /** Every governed node's policy, kill switch and verified decision log. Log verification is cached by file size and time. */
  const logCache = new Map<string, { key: string; entries: LogEntry[]; problems: string[]; anchor: string }>()
  /** One node's view from its gate state and decision log, verified against the expected gate key. */
  const nodeView = (role: string, kind: string, state: StoreState, log: { entries: LogEntry[]; problems: string[]; anchor: string }, at: number) => {
    const active = activeRecord(state.policies, at)
    const byKind: Record<string, number> = {}
    for (const e of log.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    const policyView = (r: PolicyRecord | null) => r && {
      version: r.policy.version, hash: r.policy_hash, change: r.change, effective_at: r.effective_at * 1000,
      quorum: { threshold: r.policy.quorum.threshold, keys: r.policy.quorum.keys.length }, loosen_delay_seconds: r.policy.loosen_delay_seconds, sanctions: r.policy.sanctions,
      rules: r.policy.rules.map((x) => ({ id: x.id, description: x.description })),
      pending: state.policies.filter((p) => p.effective_at > at).map((p) => ({ version: p.policy.version, change: p.change, effective_at: p.effective_at * 1000, reasons: p.reasons })),
      problems: recordProblems(state.policies, r, r.policy.node_pk),
    }
    return {
      role,
      kind,
      gate_pk: active?.policy.node_pk ?? null,
      policy: policyView(active),
      kill_switch: { stopped: Object.keys(state.frozen).length > 0, agents: Object.entries(state.frozen).map(([agent, f]) => ({ agent, at: f.at * 1000, by: f.by, reason: f.reason, action_id: f.action_id })) },
      log: { entries: log.entries.length, head: log.entries.at(-1)?.hash ?? null, verified: log.problems.length === 0 && log.entries.length > 0, problems: log.problems.slice(0, 5), anchor: log.anchor, by_kind: byKind, refused: log.entries.filter((e) => /refus|denied|blocked/i.test(e.result)).length, last_at: (log.entries.at(-1)?.at ?? 0) * 1000 },
      _entries: log.entries,
    }
  }
  /** True when a disk node under <wallets> is the live platform's own gate store (the same files the running platform uses). */
  const liveOnDisk = () => {
    const dir = d.governance.gate.store.dir
    return !!dir && governedNodes(wallets()).some((n) => resolve(n.dir) === resolve(dir))
  }
  const nodesView = () => {
    const at = Math.floor(now() / 1000)
    const views = governedNodes(wallets()).map((n) => {
      const state = new FileGateStore(n.dir).read()
      const file = join(n.dir, 'decision-log.jsonl')
      const stamp = existsSync(file) ? `${statSync(file).size}:${statSync(file).mtimeMs}` : 'none'
      let log = logCache.get(n.dir)
      if (!log || log.key !== stamp) {
        const entries = readLog(file)
        const key = expectedGateKey(wallets(), n, state, at)
        log = { key: stamp, entries, problems: key ? verifyLog(entries, key.pk) : ['no node key or quorum-verified policy to verify against'], anchor: key?.anchor ?? 'none' }
        logCache.set(n.dir, log)
      }
      return nodeView(n.role, nodeKind(n.role), state, log, at)
    })
    // The running platform's own gate, when no disk node is its store (in-memory governance, or a store outside <wallets>):
    // its policy, kill switch and log are read from the live gate, and verified against the live gate key.
    if (!liveOnDisk()) {
      const gate = d.governance.gate
      const entries = gate.log.entries()
      views.unshift(nodeView('platform', gate.store.dir ? 'platform (live gate, store outside the wallets directory)' : 'platform (live gate, in-memory governance)', gate.store.read(), { entries, problems: verifyLog(entries, gate.pubkey), anchor: 'the live platform gate key' }, at))
    }
    return views
  }

  // ---- views ----
  const revenue = async () => {
    const p = provider()
    const lenderPks = new Set((p?.lenders ?? []).map((l) => l.pubkey).filter(Boolean) as string[])
    const fees = d.platform.fees.list().map((f) => f as typeof f & BilledFeeFields)
    const status = await settle(checkNodeStatus)
    const log = status.ok && status.value ? status.value.log : []
    const assetId = p?.asset?.asset_id ?? null
    // Close-time fees are the durable source. A bill or released K alone is not earned revenue.
    const checkRows = fees.flatMap((f) => (f.check_fees ?? []).map((c) => ({
      negotiation_id: c.negotiation_id, bill_hash: c.bill_hash, operator_pk: c.operator_pk,
      amount: c.amount, asset_id: c.asset_id, status: f.status === 'fee_paid' ? 'settled' : 'billed',
      rail: 'bill-at-close', receipt: null as string | null, paid_txid: f.paid_txid ?? null,
      at: f.updated_at, loan_id: f.loan_id,
    }))).filter((c) => !assetId || c.asset_id === assetId)
    for (const e of log) if (!checkRows.some((c) => c.negotiation_id === e.negotiation_id)) checkRows.push({
      negotiation_id: e.negotiation_id, bill_hash: e.bill_hash ?? '', operator_pk: status.ok && status.value ? status.value.operator_pk : '',
      amount: 0, asset_id: assetId ?? '', status: e.status, rail: e.rail ?? 'bill-at-close', receipt: null,
      paid_txid: null, at: e.at, loan_id: '',
    })
    const interestRows = d.store.allLoans()
      .filter((l) => (lenderPks.size ? lenderPks.has(l.terms.lender_pk) : false) && ['repaid', 'defaulted', 'liquidated'].includes(l.status))
      .map((l) => ({ loan_id: l.id, lender_pk: l.terms.lender_pk, principal: l.terms.principal, interest: l.terms.fee - fees.filter((f) => f.loan_id === l.id && f.status === 'fee_paid').reduce((sum, f) => sum + f.amount, 0), status: l.status, at: l.updated_at }))
    const feeRows = fees.map((f) => ({ loan_id: f.loan_id, lender_pk: f.lender_pk, outcome: f.outcome, interest: f.interest, share_bps: f.share_bps, amount: f.share_amount ?? f.amount, status: f.status, paid_txid: f.paid_txid ?? null, closed_height: f.closed_height, paid_height: f.paid_height ?? null, at: f.updated_at }))
    const settled = checkRows.filter((x) => x.status === 'settled')
    const totals = {
      platform_fees: { earned: feeRows.filter((f) => f.status === 'fee_paid').reduce((s, f) => s + f.amount, 0), due: feeRows.filter((f) => f.status === 'fee_due').reduce((s, f) => s + f.amount, 0), paid_count: feeRows.filter((f) => f.status === 'fee_paid').length, due_count: feeRows.filter((f) => f.status === 'fee_due').length },
      check_fees: { earned: settled.reduce((s, x) => s + x.amount, 0), settled_count: settled.length, pending: checkRows.filter((x) => x.status === 'billed').length },
      lender_interest: { earned: interestRows.reduce((s, x) => s + x.interest, 0), count: interestRows.length },
      all_earned: 0,
    }
    totals.all_earned = totals.platform_fees.earned + totals.check_fees.earned + totals.lender_interest.earned
    const buckets = new Map<number, { t: number; platform_fees: number; check_fees: number; lender_interest: number }>()
    const add = (at: number | null, k: 'platform_fees' | 'check_fees' | 'lender_interest', amount: number) => {
      if (!at || !amount) return
      const t = Math.floor(at / 3_600_000) * 3_600_000
      const b = buckets.get(t) ?? { t, platform_fees: 0, check_fees: 0, lender_interest: 0 }
      b[k] += amount
      buckets.set(t, b)
    }
    for (const f of feeRows) if (f.status === 'fee_paid') add(f.at, 'platform_fees', f.amount)
    for (const x of settled) add(x.at, 'check_fees', x.amount)
    for (const x of interestRows) add(x.at, 'lender_interest', x.interest)
    return {
      v: 1, network: networkView(), asset: p?.asset ?? null, unit: 'micro', totals,
      platform_fees: feeRows, check_fees: checkRows, lender_interest: interestRows,
      series: [...buckets.values()].sort((a, b) => a.t - b.t),
      sources: [
        'platform fee share: the platform fee ledger (src/server/fees.ts, platform.db); earned = fee_paid after the platform validated the RGB receive on chain',
        'check fees: close-time fee ledger check_fees; earned only when the containing fee is fee_paid',
        lenderPks.size ? "lender interest: terms.fee of repaid/defaulted/liquidated provider loans, net of paid provider fees" : 'lender interest: no provider.json, so no lender of this provider is known',
      ],
    }
  }

  const networkView = () => ({ name: d.network.name, label: d.network.label, public: d.network.public, test_coins_only: true, asset_label: d.network.assetLabel, coin_label: d.network.coinLabel })

  const market = async () => {
    const height = await d.chain.getHeight()
    const at = Math.floor(now() / 1000)
    const offers = d.orderbook.list(height).map((o) => ({ id: o.id, lender_pk: o.lender_pk, asset_id: o.payload.asset_id, min: o.payload.min, max: o.payload.max, apr_bps: o.payload.apr_bps, term_blocks: o.payload.term_blocks, ltv_ladder_bps: o.payload.ltv_ladder_bps, expires_height: o.payload.expires_height, negotiable: !!o.payload.negotiation, max_rounds: o.payload.negotiation?.max_rounds ?? null }))
    const checkOffers = new Map<string, { operator_pk: string; price: unknown; payer_modes: unknown; release_hash: string | null; at: number }>()
    const negs = new Map<string, { id: string; messages: number; kinds: Record<string, number>; participants: Set<string>; first_at: number; last_at: number }>()
    const checkRelay: Record<string, number> = {}
    const checkNegs = { requested: new Set<string>(), released: new Set<string>() }
    for (const e of relays.events) {
      if (e.kind === KIND.CHECK_OFFER) {
        let o: { release?: CheckRelease; price?: unknown; payer_modes?: unknown } = {}
        try { o = JSON.parse(e.content) } catch { /* not JSON */ }
        let rh: string | null = null
        try { rh = o.release ? releaseHash(o.release) : null } catch { /* malformed */ }
        checkOffers.set(e.pubkey, { operator_pk: e.pubkey, price: o.price ?? null, payer_modes: o.payer_modes ?? null, release_hash: rh, at: e.created_at * 1000 })
      }
      const n = tag(e, 'n')
      if (NEGOTIATION_KINDS.includes(e.kind) && n) {
        const g = negs.get(n) ?? { id: n, messages: 0, kinds: {}, participants: new Set<string>(), first_at: e.created_at * 1000, last_at: 0 }
        g.messages++; g.kinds[e.kind] = (g.kinds[e.kind] ?? 0) + 1; g.participants.add(e.pubkey)
        const p = tag(e, 'p'); if (p) g.participants.add(p)
        g.last_at = Math.max(g.last_at, e.created_at * 1000)
        negs.set(n, g)
      }
      if (CHECK_KINDS.includes(e.kind)) {
        checkRelay[e.kind] = (checkRelay[e.kind] ?? 0) + 1
        if (n && e.kind === KIND.CHECK_REQUEST) checkNegs.requested.add(n)
        if (n && e.kind === KIND.CHECK_RESULT) checkNegs.released.add(n)
      }
    }
    const status = await settle(checkNodeStatus)
    const log = status.ok && status.value ? status.value.log : []
    const count = (s: string) => log.filter((e) => e.status === s).length
    // Count durable paid check entries even after the node's volatile log is lost.
    const settledChecks = (await revenue()).totals.check_fees.settled_count
    const loans = d.store.allLoans()
    const byState: Record<string, number> = { pending: 0, locked: 0, open: 0, repaid: 0, defaulted: 0, liquidated: 0, refunded: 0 }
    for (const l of loans) byState[l.status] = (byState[l.status] ?? 0) + 1
    const apr = (t: LoanTerms) => { const blocks = t.maturity_height - t.open_height; return blocks > 0 && t.principal > 0 ? Math.round((t.fee / t.principal) * (365 * 144 / blocks) * 10_000) : null }
    // ---- agenda: what waits on the operator ----
    const agenda: { kind: string; severity: 'info' | 'warn' | 'alert'; title: string; detail: string; due_height?: number; due_at?: number }[] = []
    for (const f of d.platform.fees.list()) if (f.status === 'fee_due') agenda.push({ kind: 'fee-due', severity: height > f.grace_until_height ? 'alert' : 'warn', title: `Platform fee due from lender ${short(f.lender_pk)}: ${usdtString(f.amount)} test USDT`, detail: height > f.grace_until_height ? `past grace since height ${f.grace_until_height}: the lender's offers are blocked` : `grace until height ${f.grace_until_height} (${f.grace_until_height - height} blocks)`, due_height: f.grace_until_height })
    for (const l of loans) if (l.status === 'open' || l.status === 'locked') agenda.push({ kind: 'maturity', severity: height >= l.terms.maturity_height ? 'alert' : l.terms.maturity_height - height <= 10 ? 'warn' : 'info', title: `Loan ${short(l.id)} ${height >= l.terms.maturity_height ? 'past maturity' : 'matures'} at height ${l.terms.maturity_height}`, detail: `${usdtString(l.terms.principal + l.terms.fee)} test USDT due; ${l.status}`, due_height: l.terms.maturity_height })
    for (const e of log) if (e.status === 'awaiting-payment') agenda.push({ kind: 'check-pending', severity: 'info', title: `Credit check ${short(e.negotiation_id)} awaiting the lender's payment`, detail: e.rail ?? 'bill-at-close', due_at: e.at })
    for (const n of nodesView()) {
      for (const p of n.policy?.pending ?? []) agenda.push({ kind: p.change === 'loosen' ? 'loosening-ends' : 'policy-pending', severity: p.change === 'loosen' ? 'warn' : 'info', title: `${n.role}: policy v${p.version} (${p.change}) takes effect ${new Date(p.effective_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`, detail: p.reasons.join('; '), due_at: p.effective_at })
      for (const a of n.kill_switch.agents) agenda.push({ kind: 'agent-stopped', severity: 'alert', title: `${n.role}: agent ${a.agent === '*' ? 'ALL' : a.agent} stopped by the kill switch`, detail: `by ${a.by}: ${a.reason}`, due_at: a.at })
    }
    const sev = { alert: 0, warn: 1, info: 2 }
    agenda.sort((a, b) => sev[a.severity] - sev[b.severity] || (a.due_height ?? Infinity) - (b.due_height ?? Infinity))
    void at
    return {
      v: 1, height, network: networkView(),
      offers,
      check_offers: [...checkOffers.values()],
      // a lender answers an ASK only within 120 s (negotiate-nostr.ts maxAskAgeSec): an older unanswered ASK has expired
      negotiations: [...negs.values()].map((g) => { const st = negotiationState(Object.keys(g.kinds).map(Number)); return { ...g, participants: [...g.participants], state: st === 'asked' && now() - g.last_at > 120_000 ? 'expired' : st } }).sort((a, b) => b.last_at - a.last_at),
      checks: { requested: Math.max(checkNegs.requested.size, log.length, settledChecks), paid: settledChecks, released: Math.max(checkNegs.released.size, settledChecks), refused: count('refused'), unpaid: count('unpaid'), awaiting_payment: count('awaiting-payment'), relay: checkRelay, items: log.map((e) => ({ negotiation_id: e.negotiation_id, status: e.status, at: e.at, bill_hash: e.bill_hash ?? null, reason: e.reason ?? null })), source: `${status.ok ? (status.value ? 'check node /status (its last 20, in memory)' : 'no check node configured') : `check node unreachable (${status.error})`}, the durable close-time check-fee ledger, and the relay` },
      loans: { by_state: byState, items: loans.map((l) => ({ id: l.id, status: l.status, borrower_pk: l.terms.borrower_pk, lender_pk: l.terms.lender_pk, principal: l.terms.principal, fee: l.terms.fee, apr_bps: apr(l.terms), ltv_bps: l.terms.ltv_bps, collateral_sats: l.terms.collateral_sats, open_height: l.terms.open_height, maturity_height: l.terms.maturity_height, lock_txid: l.lock_txid ?? null, disbursement_txid: l.disbursement_txid ?? null, repayment_txid: l.repayment_txid ?? null, release_txid: l.release_txid ?? null, updated_at: l.updated_at })).sort((a, b) => b.updated_at - a.updated_at) },
      agenda,
    }
  }

  const security = async () => {
    const p = provider()
    const nodes = nodesView()
    const status = await settle(checkNodeStatus)
    const node = status.ok && status.value ? status.value : null
    const release = node?.release ?? p?.check_nodes?.[0]?.release ?? null
    const runs = d.store.listEvents(0, 100_000).filter((e) => e.type === 'agent' && e.title === 'Credit check paid by the lender').slice(-10).reverse()
      .map((e) => { const x = (e.detail ?? {}) as { negotiation_id?: string; verified?: boolean; paid?: string; rail?: string }; return { at: e.at, negotiation_id: x.negotiation_id ?? null, verified: x.verified === true, paid: x.paid ?? null, rail: x.rail ?? null, lender_pk: e.actor_pk ?? null } })
    const seededPks = seededKeys()
    const borrowers = [...new Set(d.store.allLoans().map((l) => l.terms.borrower_pk))]
    const screen = d.governance.gate as unknown as { sanctions?: { name: string; listVersion: string; lists?: { list_id: string; title: string; as_of: string; entries: number; sha256: string; retrieved_at?: string }[] } }
    const sanctions = screen.sanctions ?? null
    const platformGated = signerGate(keySignerId(d.platform.pubkey)) === d.governance.gate.pubkey
    const mode = d.auth?.cfg.mode ?? 'off'
    return {
      v: 1, network: networkView(),
      api_auth: { mode, enforced: mode === 'enforce', operators: d.auth?.cfg.operators.length ?? 0, sessions: d.auth?.cfg.sessions?.length ?? 0, local_console: !!d.auth?.cfg.localConsole, devices: d.auth?.devices.activeKeys(now()).length ?? 0, source: 'src/server/auth.ts' },
      signing_gate: { enforced: platformGated, gate_pk: d.governance.gate.pubkey, detail: platformGated ? "the platform key is enrolled with its policy gate: it signs only with a gate token bound to the decoded transaction (src/wallet/signer.ts authorizeSignature); each lender node's key is enrolled with its own gate in its own process" : 'the platform key is NOT enrolled with a gate in this process', source: 'src/governance/node.ts, src/wallet/signer.ts' },
      nodes: nodes.map(({ _entries: _e, ...n }) => n),
      sanctions: sanctions ? { screen: sanctions.name, list_version: sanctions.listVersion, lists: (sanctions.lists ?? []).map((l) => ({ list_id: l.list_id, title: l.title, as_of: l.as_of, entries: l.entries, sha256: l.sha256, retrieved_at: l.retrieved_at ?? null })) } : { screen: 'none', list_version: 'none', lists: [] },
      scorer: {
        provider: release?.provider ?? null,
        trust_ceiling: release ? PROVIDER_TRUST[release.provider] : null,
        release_hash: node?.release_hash ?? p?.check_nodes?.[0]?.release_hash ?? null,
        release, scorer_label: node?.scorer_label ?? p?.check_nodes?.[0]?.scorer_label ?? null,
        execution: node?.execution?.label ?? null,
        verification: 'Scorer signature, normalized output schema, consent and negotiated loan binding. In-process scoring trusts its local host.',
        qvac_server: await qvacProbe(), recent_runs: runs,
        source: node ? 'check node /status and signed lender observations' : 'configured provider metadata and signed lender observations',
      },
      custody: {
        statement: "Borrower keys never leave the borrower's device. The phone signs its own consent, approval, lock and repayment; this node holds only public keys, signed messages and its own lender, platform and check-node keys.",
        borrowers: borrowers.map((pk) => { const seeded = seededPks.get(pk); return { borrower_pk: pk, keys_on_this_node: !!seeded, seeded: !!seeded, label: seeded ? `seeded regtest ${seeded.persona ? 'test persona' : 'test party'} "${seeded.name}": its test wallet was created on this laptop by infra/seed.ts (labelled test data; a phone borrower's keys are never here)` : "keys on the borrower's own device only" } }),
      },
    }
  }

  const overview = async () => {
    const p = provider()
    const [height, status, qvac, rev] = await Promise.all([d.chain.getHeight(), settle(checkNodeStatus), qvacProbe(), revenue()])
    const node = status.ok ? status.value : null
    const nodes = nodesView()
    const loans = d.store.allLoans()
    const mk = await market()
    return {
      v: 1, generated_at: now(), network: networkView(), project: p?.project ?? null, uptime_s: Math.floor((now() - startedAt) / 1000),
      // when `infra/service-provider.sh up` last finished: it writes provider.json as its last step
      stack_up_since: stateDir && existsSync(join(stateDir, 'provider.json')) ? Math.floor(statSync(join(stateDir, 'provider.json')).mtimeMs) : null,
      platform: { pubkey: d.platform.pubkey, oracle_pk: d.oracle.pubkey, gate_pk: d.governance.gate.pubkey, height, chain: d.chain.kind, api_auth: d.auth?.cfg.mode ?? 'off', price_cents: d.oracle.currentPrice() },
      asset: p?.asset ?? null,
      lenders: (p?.lenders ?? []).map((l) => ({ name: l.name, pubkey: l.pubkey, status: l.status })),
      check_nodes: (p?.check_nodes ?? []).map((c) => ({ name: c.name, operator_pk: c.operator_pk, status: node ? 'running' : status.ok ? c.status : 'unreachable', scorer_label: node?.scorer_label ?? c.scorer_label, release_hash: c.release_hash, price: node?.price ?? c.price ?? null, payer_modes: node?.payer_modes ?? c.payer_modes, execution: node?.execution?.label ?? null })),
      assistant: assistantView(),
      relays: relays.status(),
      scorer: { status: node ? 'answering' : status.ok ? 'not-configured' : 'unreachable', provider: node?.release.provider ?? p?.check_nodes?.[0]?.release?.provider ?? null, scorer_label: node?.scorer_label ?? p?.check_nodes?.[0]?.scorer_label ?? null, qvac },
      counters: { loans_total: loans.length, loans_open: loans.filter((l) => l.status === 'open' || l.status === 'locked').length, offers: mk.offers.length, negotiations: mk.negotiations.length, checks_paid: mk.checks.paid, decisions_logged: nodes.reduce((s, n) => s + n.log.entries, 0), platform_fees_earned: rev.totals.platform_fees.earned, check_fees_earned: rev.totals.check_fees.earned, lender_interest_earned: rev.totals.lender_interest.earned, all_earned: rev.totals.all_earned },
    }
  }

  /** The agent on call (src/assistant, passbook-assist/v1): its public INFO (38540, NIP-40 expiration) and how many questions it answered on the relay. */
  const assistantView = () => {
    const info = [...relays.events].reverse().find((e) => e.kind === KIND.ASSIST_INFO)
    const asks = relays.events.filter((e) => e.kind === KIND.ASSIST_ASK).length
    const replies = relays.events.filter((e) => e.kind === KIND.ASSIST_REPLY).length
    if (!info) return { status: 'not-running', pubkey: null, label: null, asks, replies, note: 'no assistant INFO (kind 38540) on the relays this platform follows: the provider help agent is not running' }
    let c: { label?: string; corpus_hash?: string; network?: string } = {}
    try { c = JSON.parse(info.content) } catch { /* not JSON */ }
    const exp = Number(tag(info, 'expiration'))
    const live = Number.isFinite(exp) ? exp * 1000 > now() : now() - info.created_at * 1000 < 30 * 60_000
    return { status: live ? 'running' : 'expired', pubkey: info.pubkey, label: typeof c.label === 'string' ? c.label : null, corpus_hash: c.corpus_hash ?? null, last_seen: info.created_at * 1000, expires_at: Number.isFinite(exp) ? exp * 1000 : null, asks, replies, note: live ? 'announced on the relay (INFO, NIP-40 expiration)' : 'its last INFO expired: treat it as stopped' }
  }

  // ---- feed: Nostr events, decision-log entries and platform wire events, oldest first ----
  const wire: WireEvent[] = []
  let wireSeq = 0
  const pullWire = () => {
    for (let batch = d.store.listEvents(wireSeq, 1000); batch.length; batch = d.store.listEvents(wireSeq, 1000)) {
      for (const e of batch) { wireSeq = e.seq ?? wireSeq; if (e.type !== 'oracle' && e.type !== 'ai_step') wire.push(e) }
      if (wire.length > 500) wire.splice(0, wire.length - 500)
    }
  }
  const feed = (after: number): { cursor: number; items: FeedItem[] } => {
    pullWire()
    const items: FeedItem[] = []
    for (const e of relays.events) {
      const at = e.created_at * 1000
      if (at < after) continue
      items.push({ id: e.id, at, source: 'nostr', kind: String(e.kind), label: KIND_LABEL[e.kind] ?? `kind ${e.kind}`, from: e.pubkey, to: tag(e, 'p'), detail: [tag(e, 'n') && `negotiation ${short(tag(e, 'n'))}`, tag(e, 'd') && `d=${tag(e, 'd')!.slice(0, 24)}`].filter(Boolean).join(' · ') || (e.kind === KIND.NEG_ASK || e.kind === KIND.OFFER || e.kind === KIND.CHECK_OFFER ? 'public' : 'NIP-44 encrypted') })
    }
    for (const n of nodesView()) for (const e of n._entries) {
      if (e.at * 1000 < after) continue
      items.push({ id: e.hash, at: e.at * 1000, source: 'decision-log', kind: e.kind, label: `${n.role} · ${e.kind}`, from: e.decided_by.pk ?? e.decided_by.id ?? e.decided_by.kind, to: e.loan_id, detail: `#${e.seq} ${e.result}${e.policy_version ? ` · policy v${e.policy_version}` : ''}${e.action_id ? ` · ${e.action_id}` : ''}` })
    }
    for (const e of wire) {
      if (e.at < after) continue
      const title = typeof e.title === 'string' ? e.title : e.type
      items.push({ id: `wire-${e.seq}`, at: e.at, source: 'platform', kind: e.type, label: title, from: typeof e.actor_pk === 'string' ? e.actor_pk : typeof e.lender_pk === 'string' ? e.lender_pk : null, to: null, detail: typeof e.detail === 'string' ? e.detail.slice(0, 200) : typeof e.role === 'string' ? e.role : typeof e.ok === 'boolean' ? (e.ok ? 'ok' : 'refused') : typeof e.action === 'string' ? e.action : '' })
    }
    items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    const out = items.slice(-200)
    return { cursor: out.at(-1)?.at ?? after, items: out }
  }

  // Agent notes have their own projection, so relay/chunk traffic cannot push
  // the last reported workflow out of the mixed feed's newest-200 window.
  // Deliberately omit note.detail: it can contain private approvals or evidence.
  const workflows = () => {
    pullWire()
    const notes = wire.filter(e => e.type === 'agent' && typeof e.actor_pk === 'string' && typeof e.title === 'string')
      .slice(-200).map(e => ({ id: `wire-${e.seq}`, at: e.at, source: 'platform', kind: 'agent',
        label: e.title as string, from: e.actor_pk as string, to: null,
        detail: ['borrower', 'lender', 'platform'].includes(String(e.role)) ? e.role as string : 'agent' }))
    return { v: 1, generated_at: now(), source: 'platform-stored agent notes; private note details omitted', notes }
  }

  // ---- red-team self-test: known-bad requests at this node; `pass` only when it refused ----
  const selfUrl = () => `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const fire = async (method: string, path: string, body: unknown, key?: KeyPair, nonce?: string) => {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-passbook-probe': 'console-red-team', ...(key ? signRequest(key, method, path, raw, Date.now(), nonce) : {}) }
    const t0 = Date.now()
    const res = await fetch(selfUrl() + path, { method, headers, body: method === 'GET' ? undefined : raw, signal: AbortSignal.timeout(10_000) })
    const text = await res.text()
    let j: Record<string, unknown> = {}
    try { j = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json: j, ms: Date.now() - t0 }
  }
  const FAKE_LOAN = sha256Hex('passbook-console-red-team-no-such-loan')
  type ProbeResult = { status: number | string; reason: string; refused_by: { file: string; fn: string }; pass: boolean; ms: number; layer: 'http' | 'in-process'; control?: { ok: boolean; detail: string }; skipped?: boolean }
  const PROBES: { id: string; title: string; attack: string; expect: string; run: () => Promise<ProbeResult> }[] = [
    {
      id: 'unsigned-write', title: 'Unsigned write', expect: '401',
      attack: 'POST /loans/:id/lock with no signature headers',
      run: async () => { const r = await fire('POST', `/loans/${FAKE_LOAN}/lock`, { lock_txid: '00'.repeat(32) }); return { status: r.status, reason: String(r.json.error ?? ''), refused_by: { file: 'src/server/auth.ts', fn: 'ApiAuth.decide' }, pass: r.status === 401, ms: r.ms, layer: 'http' } },
    },
    {
      id: 'wrong-party', title: 'Wrong party', expect: '403',
      attack: "POST /loans/:id/lock validly signed by a fresh key that is not the loan's borrower or lender",
      run: async () => { const r = await fire('POST', `/loans/${FAKE_LOAN}/lock`, { lock_txid: '00'.repeat(32) }, randomKeyPair()); return { status: r.status, reason: String(r.json.error ?? ''), refused_by: { file: 'src/server/auth.ts', fn: 'ApiAuth.decide (party binding)' }, pass: r.status === 403, ms: r.ms, layer: 'http' } },
    },
    {
      id: 'replayed-request', title: 'Replayed signed request', expect: '401',
      attack: 'the same signed GET /state sent twice with the same nonce',
      run: async () => {
        const key = randomKeyPair(), nonce = sha256Hex(`probe:${Date.now()}:${Math.random()}`).slice(0, 32)
        const first = await fire('GET', '/state', undefined, key, nonce)
        const r = await fire('GET', '/state', undefined, key, nonce)
        return { status: r.status, reason: String(r.json.error ?? ''), refused_by: { file: 'src/server/auth.ts', fn: 'NonceCache.claim' }, pass: r.status === 401, ms: first.ms + r.ms, layer: 'http', control: { ok: first.status === 200, detail: `the first send answered ${first.status}` } }
      },
    },
    {
      id: 'tampered-termsheet', title: 'Tampered term sheet', expect: '422',
      attack: "a registered loan's terms with the collateral cut by 10% after the LTV was stated, registered under a fresh lender key",
      run: async () => {
        const loan = d.store.allLoans().at(-1)
        if (!loan) return { status: 'skipped', reason: 'no registered loan on this node to tamper with yet', refused_by: { file: 'src/server/platform.ts', fn: 'Platform.registerLoan' }, pass: false, ms: 0, layer: 'http', skipped: true }
        const key = randomKeyPair()
        const terms: LoanTerms = { ...loan.terms, lender_pk: key.pubkey, collateral_sats: Math.floor(loan.terms.collateral_sats * 0.9), oracle_quote: d.oracle.quote(await d.chain.getHeight()), nonce: sha256Hex(`probe:${Math.random()}`) }
        const r = await fire('POST', '/loans', { terms }, key)
        const failed = ((r.json.verdict as { checks?: { id: string; ok: boolean; detail: string }[] } | undefined)?.checks ?? []).filter((c) => !c.ok)
        const why = failed.find((c) => c.id === 'ltv-stated') ?? failed[0]
        return { status: r.status, reason: `${String(r.json.error ?? '')}${why ? `: ${why.id} (${why.detail})` : ''}`, refused_by: r.json.verdict ? { file: 'src/server/platform.ts', fn: 'Platform.registerLoan' } : { file: 'src/core/terms.ts', fn: 'validateTerms' }, pass: r.status >= 400 && r.status < 500 && !!r.json.error, ms: r.ms, layer: 'http' }
      },
    },
    {
      id: 'replayed-negotiation', title: 'Replayed negotiation message', expect: 'refused',
      attack: "a lender's signed OFFER replayed after itself in the transcript",
      run: async () => {
        const t0 = Date.now()
        const b = randomKeyPair(), l = randomKeyPair(), nonce = sha256Hex(`probe:${Math.random()}`)
        const position = { principal: 100 * MICRO, apr_bps: 1200, ltv_bps: 4000, term_blocks: 30, settlement: 'cosign-rgb' }
        const chain: NegotiationMessage[] = []
        await appendMessage(chain, new LocalKeySigner(b), 'ASK', { position, asset_id: 'probe', accepted_settlements: ['cosign-rgb'], min_scorer_trust: 'software-evidence', policy_hash: hashObject({ probe: 'borrower' }), nonce }, negotiationId(b.pubkey, nonce))
        await appendMessage(chain, new LocalKeySigner(l), 'OFFER', { position, policy_hash: hashObject({ probe: 'lender' }), required_checks: [], min_scorer_trust: 'software-evidence' })
        const expect = { borrower_pk: b.pubkey, lender_pk: l.pubkey, max_rounds: 3, economics: d.economics }
        const control = verifyTranscript(chain, expect)
        const attack = verifyTranscript([...chain, chain[1]], expect)
        return { status: attack.ok ? 'accepted' : 'refused', reason: attack.problems.join('; '), refused_by: { file: 'src/market/negotiate-engine.ts', fn: 'verifyTranscript' }, pass: !attack.ok, ms: Date.now() - t0, layer: 'in-process', control: { ok: control.ok, detail: control.ok ? 'the original two messages verify' : control.problems.join('; ') } }
      },
    },
    {
      id: 'mismatched-binding', title: 'Check result with a mismatched binding', expect: 'refused',
      attack: 'Scorer outputs (v2) that name another principal than the agreed loan',
      run: async () => {
        const t0 = Date.now()
        const loan = d.store.allLoans().at(-1)?.terms
        const expected = { loan_request: { principal: loan?.principal ?? 600 * MICRO, fee: loan?.fee ?? 8_400_000, term_blocks: loan ? loan.maturity_height - loan.open_height : 30, grace_blocks: loan?.grace_blocks ?? 6 }, asset_id: loan?.asset_id ?? 'rgb:probe', lender_requirements_hash: hashObject({ probe: 'requirements' }) }
        const outputs = { v: 2, ...expected }
        const control = scoredLoanProblems(outputs as never, expected)
        const forged = { ...outputs, loan_request: { ...expected.loan_request, principal: expected.loan_request.principal * 10 } }
        const problems = scoredLoanProblems(forged as never, expected)
        return { status: problems.length ? 'refused' : 'accepted', reason: problems.join('; '), refused_by: { file: 'src/scorer/bundle-terms.ts', fn: 'scoredLoanProblems (run by the lender and the phone)' }, pass: problems.length > 0, ms: Date.now() - t0, layer: 'in-process', control: { ok: control.length === 0, detail: control.length ? control.join('; ') : `outputs naming the agreed loan${loan ? ` (${short(d.store.allLoans().at(-1)!.id)})` : ''} pass` } }
      },
    },
    {
      id: 'ungated-signature', title: 'Signature without a gate token', expect: 'refused',
      attack: "ask the platform key's signer to sign a transaction with no policy-gate token",
      run: async () => {
        const t0 = Date.now()
        try {
          authorizeSignature(keySignerId(d.platform.pubkey), { probe: 'console-red-team', at: Date.now() }, undefined)
          return { status: 'accepted', reason: 'the platform key is not enrolled with a gate in this process', refused_by: { file: 'src/wallet/signer.ts', fn: 'authorizeSignature' }, pass: false, ms: Date.now() - t0, layer: 'in-process' }
        } catch (err) {
          return { status: 'refused', reason: err instanceof SigningRefused ? `${err.code}: ${err.message}` : (err as Error).message, refused_by: { file: 'src/wallet/signer.ts', fn: 'authorizeSignature' }, pass: err instanceof SigningRefused, ms: Date.now() - t0, layer: 'in-process' }
        }
      },
    },
  ]

  // ---- routes: operator only ----
  api.on('GET', '/console/api/overview', () => overview(), 'operator')
  api.on('GET', '/console/api/revenue', () => revenue(), 'operator')
  api.on('GET', '/console/api/revenue.csv', async ({ res }) => {
    const r = await revenue()
    const net = r.network.label
    const rows: unknown[][] = [['stream', 'id', 'counterparty', 'status', 'amount_micro', 'amount_test_usdt', 'asset_id', 'reference', 'at_iso', 'network']]
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : '')
    for (const f of r.platform_fees) rows.push(['platform_fee_share', f.loan_id, f.lender_pk, f.status, f.amount, usdtString(f.amount), r.asset?.asset_id ?? '', f.paid_txid ?? `closed at height ${f.closed_height}`, iso(f.at), net])
    for (const c of r.check_fees) rows.push(['check_fee', c.negotiation_id ?? '', '', c.status, c.status === 'settled' ? c.amount : 0, usdtString(c.status === 'settled' ? c.amount : 0), c.asset_id ?? '', c.paid_txid ?? c.bill_hash, iso(c.at), net])
    for (const x of r.lender_interest) rows.push(['lender_interest', x.loan_id, x.lender_pk, x.status, x.interest, usdtString(x.interest), r.asset?.asset_id ?? '', `principal ${x.principal}`, iso(x.at), net])
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="passbook-revenue-${net}.csv"`, 'cache-control': 'no-store' })
    res.end(`${rows.map((row) => row.map(csvField).join(',')).join('\n')}\n`)
  }, 'operator')
  api.on('GET', '/console/api/market', () => market(), 'operator')
  api.on('GET', '/console/api/security', () => security(), 'operator')
  api.on('GET', '/console/api/feed', ({ url }) => feed(Number(url.searchParams.get('after') ?? 0) || 0), 'operator')
  api.on('GET', '/console/api/workflows', () => workflows(), 'operator')
  api.on('GET', '/console/api/redteam', () => ({ probes: PROBES.map(({ id, title, attack, expect }) => ({ id, title, attack, expect })) }), 'operator')
  api.on('POST', '/console/api/redteam/:id', async ({ params }) => {
    const p = PROBES.find((x) => x.id === params.id)
    if (!p) throw new HttpError(404, 'unknown probe')
    const out = await p.run()
    api.emit({ type: 'console', title: `Red-team probe: ${p.title}`, ok: out.pass, detail: out.skipped ? `skipped: ${out.reason}` : `${out.pass ? 'refused as expected' : 'NOT REFUSED'}: ${out.status} by ${out.refused_by.file}` })
    return { id: p.id, title: p.title, attack: p.attack, expect: p.expect, ...out }
  }, 'operator')
  api.on('POST', '/console/api/kill-switch', async ({ body }) => {
    const b = await body()
    if (b.confirm !== 'STOP') throw new HttpError(400, 'type STOP to confirm the kill switch')
    const node = typeof b.node === 'string' && b.node ? b.node : 'all'
    // `all` is this provider's own nodes (the platform and its lenders), never a test persona's borrower process
    const own = governedNodes(wallets()).map((n) => n.role).filter((role) => role === 'platform' || nodeKind(role) === "provider's lender")
    if (node !== 'all' && node !== 'platform' && !own.includes(node)) throw new HttpError(404, `no governed node ${node} of this provider`)
    const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 200) : 'kill switch (operator console)'
    const lines: string[] = []
    let code = 0
    for (const role of node === 'all' ? own : own.includes(node) ? [node] : []) code ||= await runGovernanceCli(['agent', 'stop', '--all', '--wallets', wallets(), '--node', role, '--by', 'operator-console', '--reason', reason], (line) => lines.push(line))
    // The live platform is always stopped at its own gate, whether or not its store is a disk node the CLI reached
    // (in-memory governance for a fixed or unseeded platform key never is).
    if (node === 'all' || node === 'platform') {
      const live = `platform (live gate${d.governance.gate.store.dir ? '' : ', in-memory governance'})`
      if (!d.governance.gate.agentStopped('*')) {
        const r = d.governance.gate.stopAgent('*', 'operator-console', reason)
        lines.push(`${live}: stopped ${r.agents.join(', ')}; revoked ${r.revoked.length} session key(s); ${r.action_id}.`)
      } else if (!lines.some((l) => l.startsWith('node platform:'))) lines.push(`${live}: already stopped.`)
    }
    logCache.clear()
    const liveStopped = node !== 'all' && node !== 'platform' ? true : d.governance.gate.agentStopped('*')
    api.emit({ type: 'console', title: `Kill switch: ${node}`, ok: code === 0 && liveStopped, detail: lines.join(' ') })
    if (code !== 0 || !liveStopped) throw new HttpError(500, `${lines.join(' ')}${liveStopped ? '' : ' The live platform gate is NOT stopped.'}`.trim() || 'agent stop failed')
    if (!lines.length) throw new HttpError(500, 'the kill switch reached no node')
    return { ok: true, lines }
  }, 'operator')
  /** Questions the copilot answers from this node's own records, the first naming the provider lender's latest gate decision. */
  api.on('GET', '/console/api/copilot', () => {
    const lender = nodesView().find((n) => n.kind === "provider's lender" && n._entries.length)
    const entries = lender ? [...lender._entries].reverse() : []
    const last = entries.find((e) => e.kind === 'gate-decision' && e.action_id) ?? entries.find((e) => e.action_id)
    const verb = !last ? '' : last.kind === 'gate-decision' ? (/allow/i.test(last.result) ? 'allowed' : 'refused') : last.result.toLowerCase()
    return {
      model: copilotModel ? 'configured (PASSBOOK_ASSIST_AI)' : null, model_config_error: copilotModelError,
      suggestions: [...(last ? [`Why was ${last.action_id} ${verb}?`] : []), 'What did we earn?', 'Any alerts?', 'Any refusals?', 'Is the decision log intact?'],
    }
  }, 'operator')
  api.on('POST', '/console/api/copilot', async ({ body }) => {
    const b = await body()
    const q = b.question
    if (typeof q !== 'string' || !q.trim()) throw new HttpError(400, 'question required')
    const [rev, mk] = await Promise.all([revenue(), market()])
    // the node whose decisions the operator asks about: the first lender node with a log, else the platform's
    const nodes = nodesView()
    const node = nodes.find((n) => n.kind === "provider's lender" && n._entries.length) ?? nodes.find((n) => n.role === 'platform') ?? nodes[0]
    const ctx: OperatorContext = {
      decisions: node?._entries ?? [], node_pk: node?.gate_pk ?? undefined,
      // the service revenue: the platform's fee share and the check node's fees (OperatorRevenue has no field for the lender's own interest)
      revenue: { network: rev.network.label, asset_label: 'test USDT', total_micro: rev.totals.platform_fees.earned + rev.totals.check_fees.earned, platform_fee_micro: rev.totals.platform_fees.earned, check_fee_micro: rev.totals.check_fees.earned, loans_closed: mk.loans.items.filter((l) => !['pending', 'locked', 'open'].includes(l.status)).length },
      alerts: mk.agenda.map((a, i) => ({ id: `${a.kind}-${i}`, level: a.severity === 'alert' ? 'critical' as const : a.severity, text: a.title, at: Math.floor((a.due_at ?? now()) / 1000) })),
      screen: typeof b.screen === 'string' ? b.screen.slice(0, 40) : undefined,
    }
    const answer = await askOperatorCopilot(q.slice(0, 500), ctx, { model: copilotModel })
    return copilotModelError ? { ...answer, model_config_error: copilotModelError } : answer
  }, 'operator')
}
