// Building check nodes and running one paid check, shared by the CLI
// (`passbook check-node`), the regtest test and the dashboard record.
// Everything money-related comes from the nodes; this file only wires them.

import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname } from 'node:path'
import { primaryReasonerFromEnv } from '../ai/engine.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import type { ChainClient } from '../chain/types.js'
import { randomKeyPair, type Hex, type KeyPair } from '../core/crypto.js'
import { RgbLightningNode } from '../rgb/lightning.js'
import { SandboxScorerEngine } from '../scorer/providers.js'
import { measureSource } from '../scorer/releases.js'
import type { TrustPolicy } from '../scorer/verify.js'
import type { CheckBus } from './bus.js'
import type { ForwardedCheckVerification, PaidCheckResult } from './client.js'
import { SandboxCheckEngine, type CheckEngine } from './engine.js'
import { CheckNode, type CheckNodeOptions } from './node.js'
import { releaseHash, type CheckAsset, type DeliveryRail } from './offer.js'
import { RAIL_LABEL, RlnOperatorRail, type LightningCheckRail } from './rail.js'
import type { CheckNodePick } from './select.js'
import { deriveExecution, EXECUTION_TIER_LABEL, noTeeVerifier } from './tee.js'

/** In-process is the default; fallback is always explicit. */
export async function engineFromConfig(opts: { chainCheckSigner: KeyPair; chain?: ChainClient; log?: (l:string)=>void }): Promise<CheckEngine> {
 return sandboxEngineFromEnv({chain:opts.chain})
}

/** The container scorer's code in the node's process, labelled as the fallback with its reason. */
export function sandboxEngineFromEnv(opts: { chain?: ChainClient; fallbackReason?: string }): CheckEngine {
  const digest = process.env.SANDBOX_IMAGE_DIGEST ?? ''
  const measurement = /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : measureSource()
  const engine = new SandboxScorerEngine({
    provider: 'in-process', key: randomKeyPair(), chain: opts.chain ?? BitcoindChain.fromEnv(), reasoner: primaryReasonerFromEnv(), blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30), measurement,
    oraclePk: (process.env.ORACLE_PK ?? process.env.PASSBOOK_HISTORY_OBSERVER_PK) as Hex | undefined,
    runEnvironment: { image_digest: measurement.startsWith('sha256:') ? measurement : 'in-process', network_mode: measurement.startsWith('sha256:') ? 'bridge' : 'in-process-host' },
  })
  const label = opts.fallbackReason ? `in-process scorer (FALLBACK: ${opts.fallbackReason})` : 'in-process scorer (development trust; host trusted)'
  return new SandboxCheckEngine(engine, { label, fallback: !!opts.fallbackReason, modelHash: null })
}

export interface NodeSpec {
  name: string
  operator: KeyPair
  /** True when the operator key is the publicly derivable demo key. */
  demoKey: boolean
  priceMicro: number
  p50Seconds: number
  lnUrl: string
  rails: LightningCheckRail[]
  paymentAssetId: string
  voucher?: { asset_id: string; ticker: string }
}

export async function buildNode(spec: NodeSpec, bus: CheckBus, engine: CheckEngine, extra: Partial<CheckNodeOptions> = {}): Promise<CheckNode> {
  // A billed node must never construct or probe a payment node, including with a stale URL.
  const ln = spec.rails.length ? new RgbLightningNode(spec.lnUrl) : null
  const info = ln ? await ln.request<{ pubkey: string }>('/nodeinfo').catch(() => null) : null
  const rails = Object.fromEntries(spec.rails.map((r) => [r, new RlnOperatorRail(ln!, r)]))
  const assets: CheckAsset[] = [{ asset_id: spec.paymentAssetId, ticker: 'USDT', amount: spec.priceMicro, kind: 'payment' }]
  if (spec.voucher) assets.push({ asset_id: spec.voucher.asset_id, ticker: spec.voucher.ticker, amount: 1, kind: 'voucher' })
  return new CheckNode({ operator: spec.operator, engine, bus, rails, assets, p50Seconds: spec.p50Seconds, ...(info?.pubkey ? { lnNodePubkey: info.pubkey } : {}), log: (l) => console.log(`[check-node ${spec.name}] ${l}`), ...extra })
}

/** GET /status for the dashboard: the offer, the derived tier, the log (hashes only). */
export function serveStatus(node: CheckNode, spec: Pick<NodeSpec, 'name' | 'demoKey'>, port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/status') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(nodeView(node, spec)))
  })
  server.listen(port, host)
  return server
}

export function nodeView(node: CheckNode, spec: Pick<NodeSpec, 'name' | 'demoKey'>) {
  const s = node.status()
  const execution = deriveExecution(s.offer.execution, s.offer.release, noTeeVerifier(Math.floor(Date.now() / 1000)))
  return {
    name: spec.name, operator_pk: s.offer.operator_pk, operator_key: spec.demoKey ? 'demo key (publicly derivable, regtest only)' : 'operator key',
    release: s.offer.release, release_hash: s.release_hash, scorer_label: s.scorer_label, scorer_fallback: s.scorer_fallback,
    execution: { declared: s.offer.execution.tee, tier: execution.tier, label: EXECUTION_TIER_LABEL[execution.tier] },
    price: s.offer.price, accepted_assets: s.offer.accepted_assets, rails: s.rails, payer_modes: s.offer.payer_modes,
    bond: 'designed, not live', p50_seconds: s.offer.p50_seconds, retention: s.offer.retention, expires: s.offer.expires,
    offer_hash: s.offer_hash, log: s.log,
  }
}

/** What the dashboard's Check nodes panel shows after a paid check: no outputs, no personal data. */
export interface CheckMarketRecord {
  v: 1
  kind: 'passbook-check-market-run'
  at: string
  network: 'regtest'
  nodes: ReturnType<typeof nodeView>[]
  pick: { operator_pk: Hex | null; why: string[]; ranked: { operator_pk: Hex; cost: number; p50_seconds: number }[]; rejected: { operator_pk: Hex; problems: string[] }[] }
  paid: { operator_pk: Hex; rail: DeliveryRail; rail_label: string; asset_id: string; amount: number; payment_hash: Hex; key_source: string; commitment: Hex; release_hash: Hex } | null
  lender: { ok: boolean; execution: string; scorer_trust: string | null; ticks: { id: string; ok: boolean; detail: string }[] } | null
  receipt?: { contract_id: string | null; status: string }
  platform_cut: 0
}

export function marketRecord(nodes: ReturnType<typeof nodeView>[], pick: CheckNodePick | null, paid: PaidCheckResult | null, lender: ForwardedCheckVerification | null, receipt?: CheckMarketRecord['receipt']): CheckMarketRecord {
  const rail = paid ? paid.commitment.payment.rail : null
  return {
    v: 1, kind: 'passbook-check-market-run', at: new Date().toISOString(), network: 'regtest', nodes,
    pick: { operator_pk: pick?.picked?.operator_pk ?? null, why: pick?.why ?? [], ranked: (pick?.ranked ?? []).map((c) => ({ operator_pk: c.operator_pk, cost: c.cost, p50_seconds: c.offer.p50_seconds })), rejected: (pick?.rejected ?? []).map((c) => ({ operator_pk: c.operator_pk, problems: c.problems })) },
    paid: paid && rail ? { operator_pk: paid.offer.operator_pk, rail, rail_label: RAIL_LABEL[rail], asset_id: paid.commitment.payment.asset_id, amount: paid.commitment.payment.amount, payment_hash: paid.commitment.payment.payment_hash, key_source: paid.key_source, commitment: paid.commitment.commitment, release_hash: releaseHash(paid.offer.release) } : null,
    lender: lender ? { ok: lender.ok, execution: lender.execution ? EXECUTION_TIER_LABEL[lender.execution.tier] : 'unknown', scorer_trust: lender.scorer?.trust ?? null, ticks: lender.ticks.filter((t) => !t.id.startsWith('scorer:') || !t.ok || ['scorer:fallback', 'scorer:trust-minimum', 'scorer:addressed-to-lender'].includes(t.id)) } : null,
    ...(receipt ? { receipt } : {}),
    platform_cut: 0,
  }
}

export function writeRecord(path: string, record: CheckMarketRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
}

export type { TrustPolicy }
