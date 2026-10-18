// Every wallet-panel send goes through a gate before anything is signed.
//
// The default is GovernedSendGate: the panel's own checks (InterimSendGate:
// confirmed on the preview, a test network, the per-send cap, a preview hash),
// then the node's policy gate (src/governance/gate.ts) with the confirmed
// preview as the decoded summary: daily limits across processes, the
// hash-chained decision log and `passbook why`. The policy gate decides here,
// before signing; the panel's own wallets are not enrolled at the signing
// layer (agent and platform wallets are). PASSBOOK_WALLET_GATE=interim keeps
// the interim checks only; =off refuses every send (no gate).
//
// The model never decides money here: the gate is code, and it sees the hash
// of exactly the preview the person approved (what you see is what you sign).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hashObject, keyPairFromSecret, randomHex, type Hex, type KeyPair } from '../core/crypto.js'
import type { NetworkName, NetworkProfile } from '../core/network.js'
import { availableSanctionsScreen } from '../compliance/sanctions.js'
import { GateRefused, type GateDecision as PolicyDecision, type GateTx } from '../governance/gate.js'
import { NodeGovernance } from '../governance/node.js'
import { demoDefaultPolicy, type GovernancePolicy, type Network } from '../governance/policy.js'

export type SendAction = 'wallet.send.btc' | 'wallet.send.rgb' | 'wallet.prepare.rgb'

export interface SendIntent {
  action: SendAction
  network: NetworkName
  preview_id: string
  /** hashObject of the decoded preview the person saw ("Can't be undone" included). */
  preview_hash: Hex
  /** sats for BTC, the asset's smallest unit (micro test USDT) for RGB */
  amount: number
  unit: 'sats' | 'micro'
  asset_id?: string
  to: string
  fee_sats: number
  /** the person pressed the confirm button on that preview */
  confirmed: boolean
}

export interface GateCheck { id: string; ok: boolean; detail: string }

export interface GateDecision {
  allow: boolean
  /** which gate decided, shown on the confirmation screen */
  gate: string
  /** true while the interim adapter stands in for src/governance/gate.ts */
  adapter: boolean
  reason: string
  checks: GateCheck[]
  /** hash binding this decision to the intent; the service refuses a decision for another intent */
  intent_hash: Hex
  /** the policy gate's action id, for `passbook why` (absent for the interim gate) */
  action_id?: string
}

export interface SendGate {
  readonly name: string
  readonly adapter: boolean
  decide(intent: SendIntent): Promise<GateDecision>
}

export interface SendLimits { maxSats: number; maxMicro: number }

export const DEFAULT_LIMITS: Record<NetworkName, SendLimits> = {
  regtest: { maxSats: 100_000_000, maxMicro: 100_000 * 1_000_000 },
  mutinynet: { maxSats: 1_000_000, maxMicro: 1_000 * 1_000_000 },
  testnet4: { maxSats: 1_000_000, maxMicro: 1_000 * 1_000_000 },
}

export const intentHash = (intent: SendIntent): Hex => hashObject({ kind: 'passbook-send-intent-v1', ...intent })

/** ADAPTER until src/governance/gate.ts merges. Per-send caps, test networks only, explicit confirmation of the exact preview. */
export class InterimSendGate implements SendGate {
  readonly name = 'interim wallet gate'
  readonly adapter = true
  constructor(private readonly limits: Partial<Record<NetworkName, SendLimits>> = {}) {}

  async decide(intent: SendIntent): Promise<GateDecision> {
    const limits = { ...DEFAULT_LIMITS[intent.network], ...this.limits[intent.network] }
    const cap = intent.unit === 'sats' ? limits.maxSats : limits.maxMicro
    const checks: GateCheck[] = [
      { id: 'confirmed', ok: intent.confirmed === true, detail: intent.confirmed ? 'confirmed on the preview screen' : 'not confirmed' },
      { id: 'network', ok: ['regtest', 'mutinynet', 'testnet4'].includes(intent.network), detail: `${intent.network} (test network)` },
      { id: 'amount', ok: Number.isSafeInteger(intent.amount) && intent.amount > 0 && intent.amount <= cap, detail: `${intent.amount} ${intent.unit}, cap ${cap}` },
      { id: 'preview', ok: /^[0-9a-f]{64}$/.test(intent.preview_hash), detail: intent.preview_hash.slice(0, 12) },
    ]
    const allow = checks.every((c) => c.ok)
    return { allow, gate: this.name, adapter: true, reason: allow ? 'within the interim wallet limits' : checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; '), checks, intent_hash: intentHash(intent) }
  }
}

/** The policy gate's network names: Mutinynet is a signet, testnet4 a testnet. */
export const PANEL_NETWORK: Record<NetworkName, Network> = { regtest: 'regtest', mutinynet: 'signet', testnet4: 'testnet' }

/** The panel node's version 1 policy: the panel may send what the person confirmed, BTC and RGB assets, ten per-send caps a day each. */
export function panelPolicy(network: NetworkName, limits: SendLimits = DEFAULT_LIMITS[network]) {
  return (gatePk: Hex, ownerPk: Hex): GovernancePolicy => ({
    ...demoDefaultPolicy(gatePk, ownerPk),
    rules: [
      { id: 'panel-btc', description: `the wallet panel may send BTC the person confirmed, at most ${10 * limits.maxSats} sats a day`, initiators: { kinds: ['service'], ids: [ownerPk] }, actions: ['wallet-send'], assets: ['BTC'], networks: ['regtest', 'signet', 'testnet'], limits: { per_day: 10 * limits.maxSats } },
      { id: 'panel-rgb', description: `the wallet panel may send RGB assets the person confirmed, at most ${10 * limits.maxMicro} units a day`, initiators: { kinds: ['service'], ids: [ownerPk] }, actions: ['wallet-send'], assets: ['rgb:*'], networks: ['regtest', 'signet', 'testnet'], limits: { per_day: 10 * limits.maxMicro } },
    ],
  })
}

/** A node key for the panel's gate, kept beside the panel's data (mode 600). */
function panelNodeKey(dir: string): KeyPair {
  const file = join(dir, 'gate-node.key')
  if (existsSync(file)) return keyPairFromSecret(readFileSync(file, 'utf8').trim())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const secret = randomHex(32)
  writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
  return keyPairFromSecret(secret)
}

/** The real gate for the wallet panel: the interim checks first, then the node's policy gate. Opens its store only at the first send. */
export class GovernedSendGate implements SendGate {
  readonly name = 'passbook policy gate'
  readonly adapter = false
  private node?: NodeGovernance
  constructor(private readonly dir: string, private readonly network: NetworkName, private readonly interim: SendGate = new InterimSendGate(), private readonly open?: () => NodeGovernance) {}

  governance(): NodeGovernance {
    this.node ??= this.open?.() ?? new NodeGovernance({ ownerKey: panelNodeKey(this.dir), dir: join(this.dir, 'governance'), network: PANEL_NETWORK[this.network], policy: panelPolicy(this.network), sanctions: availableSanctionsScreen() })
    return this.node
  }

  async decide(intent: SendIntent): Promise<GateDecision> {
    const pre = await this.interim.decide(intent)
    // nothing reaches the policy gate (or its counters) unless the person confirmed this exact preview within the caps
    if (!pre.allow) return { ...pre, gate: this.name, adapter: false }
    const gov = this.governance()
    const tx: GateTx = { signer: `wallet-panel:${gov.ownerKey.pubkey.slice(0, 16)}`, kind: 'wallet-preview', summary: { kind: 'wallet-preview', network: PANEL_NETWORK[intent.network], action: intent.action, preview_hash: intent.preview_hash, to: intent.to, amount: intent.amount, unit: intent.unit, asset_id: intent.asset_id ?? null, fee_sats: intent.fee_sats } }
    let d: PolicyDecision
    try { d = await gov.decide([tx], { action: 'wallet-send', initiator: { service: 'wallet-panel' }, reason: `${intent.action} confirmed on preview ${intent.preview_id}` }) } catch (err) {
      if (!(err instanceof GateRefused)) throw err
      d = err.decision
    }
    const checks: GateCheck[] = [...pre.checks, ...d.gate_checks.map((c) => ({ id: c.check, ok: c.ok, detail: c.detail })), ...d.rules.filter((r) => r.applies).flatMap((r) => r.checks.map((c) => ({ id: `${r.rule_id}:${c.check}`, ok: c.ok, detail: c.detail })))]
    return { allow: d.allowed, gate: this.name, adapter: false, reason: `${d.reason} (passbook why ${d.action_id})`, checks, intent_hash: intentHash(intent), action_id: d.action_id }
  }
}

/**
 * The gate the server uses: PASSBOOK_WALLET_GATE=off refuses every send (no gate), =interim the interim checks only,
 * anything else the policy gate (store and log in <panel dir>/governance).
 */
export function sendGateFromEnv(env: NodeJS.ProcessEnv = process.env, profile?: Pick<NetworkProfile, 'name'>): SendGate | undefined {
  if (env.PASSBOOK_WALLET_GATE === 'off') return undefined
  const maxSats = env.PASSBOOK_WALLET_MAX_SEND_SATS ? Number(env.PASSBOOK_WALLET_MAX_SEND_SATS) : undefined
  const interim = new InterimSendGate(maxSats ? { regtest: { maxSats, maxMicro: DEFAULT_LIMITS.regtest.maxMicro }, mutinynet: { maxSats, maxMicro: DEFAULT_LIMITS.mutinynet.maxMicro }, testnet4: { maxSats, maxMicro: DEFAULT_LIMITS.testnet4.maxMicro } } : {})
  if (env.PASSBOOK_WALLET_GATE === 'interim' || !profile) return interim
  return new GovernedSendGate(resolve(env.PASSBOOK_WALLET_DIR ?? join('data', 'wallet', profile.name)), profile.name, interim)
}
