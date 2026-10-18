// Signed, versioned governance policies. A policy is a list of rules; each rule
// grants one kind of initiator a set of actions under conditions (asset,
// amount, destination, network, time window, cumulative limits, approvals).
// An action is allowed when at least one rule that applies to it passes every
// one of its conditions. No rule, no action.
//
// A new version needs the quorum of the policy in force: distinct listed keys,
// each signing the new policy's hash. A change that only narrows what is
// allowed applies at once; anything else (a new rule, a higher limit, a new
// key) is loosening and waits `loosen_delay_seconds`. Each loan records the
// version that allowed it.

import { hashObject, isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { GOVERNED_ACTIONS, type GovernedAction } from '../wallet/signer.js'

export type Network = 'regtest' | 'signet' | 'testnet' | 'mainnet'
export type InitiatorKind = 'human' | 'agent' | 'service'

export interface GateRule {
  id: string
  /** One line for `passbook why`. */
  description: string
  initiators: { kinds: InitiatorKind[]; /** human or service keys, or agent ids; absent = any of those kinds */ ids?: string[] }
  actions: GovernedAction[]
  /** 'BTC' or RGB asset ids; absent = any asset. */
  assets?: string[]
  /** Largest amount one action may move, in the asset's base unit (sats, micro-units). */
  max_amount?: number
  /** Where value may go: a fixed allowlist (scripts, addresses, RGB recipient ids) or only to this term sheet's counterparty (and its escrow). */
  destinations?: { kind: 'allowlist'; ids: string[] } | { kind: 'counterparty-only' }
  networks?: Network[]
  /** UTC weekdays (0 = Sunday) and hours [from, to). */
  window?: { days_utc?: number[]; hours_utc?: [number, number] }
  /** Cumulative per UTC day, in the asset's base unit: everything this node moved today for the actions this rule covers (whichever rule allowed it). */
  limits?: { per_day?: number; per_counterparty_per_day?: number }
  /** Approvals of the decoded transactions: at least `count` distinct listed approvers, covering every role in `roles`. */
  approvals?: { count: number; roles?: string[] }
}

export interface GovernancePolicy {
  v: 1
  domain: 'passbook-governance-policy-v1'
  /** The gate (node) key this policy governs. */
  node_pk: Hex
  version: number
  prev_hash: Hex | null
  rules: GateRule[]
  /** Who may approve transactions, and in which role. */
  approvers: { pk: Hex; role: string }[]
  /** Who may change this policy: `threshold` distinct keys of `keys`. */
  quorum: { threshold: number; keys: Hex[] }
  loosen_delay_seconds: number
  /** Sanctions screening of the counterparty's addresses: required for every action that names a counterparty, used when the request carries addresses, or off. */
  sanctions: 'required' | 'when-provided' | 'off'
  created_at: number
}

export interface PolicyApproval {
  v: 1
  domain: 'passbook-policy-approval-v1'
  policy_hash: Hex
  approver_pk: Hex
  approved_at: number
  sig: Hex
}

export interface PolicyRecord {
  policy: GovernancePolicy
  policy_hash: Hex
  approvals: PolicyApproval[]
  change: 'genesis' | 'tighten' | 'loosen'
  /** Why the change was classified so. */
  reasons: string[]
  proposed_at: number
  effective_at: number
  action_id: string
}

export const policyHash = (p: GovernancePolicy): Hex => hashObject(p)

export function approvePolicy(key: KeyPair, policy: GovernancePolicy, at = Math.floor(Date.now() / 1000)): PolicyApproval {
  return signObject({ v: 1 as const, domain: 'passbook-policy-approval-v1' as const, policy_hash: policyHash(policy), approver_pk: key.pubkey, approved_at: at }, key.secretKey)
}

export function policyProblems(p: GovernancePolicy): string[] {
  const out: string[] = []
  if (p.v !== 1 || p.domain !== 'passbook-governance-policy-v1') out.push('not a v1 governance policy')
  if (!isHex(p.node_pk, 32)) out.push('node_pk must be a 32-byte key')
  if (!Number.isSafeInteger(p.version) || p.version < 1) out.push('version must be a positive integer')
  if (!Array.isArray(p.rules)) out.push('rules must be a list')
  const ids = new Set<string>()
  for (const r of p.rules ?? []) {
    if (!r.id || ids.has(r.id)) out.push(`rule ${r.id || '(no id)'}: ids must be present and unique`)
    ids.add(r.id)
    if (!r.actions?.length || r.actions.some((a) => !GOVERNED_ACTIONS.includes(a))) out.push(`rule ${r.id}: unknown or missing actions`)
    if (!r.initiators?.kinds?.length) out.push(`rule ${r.id}: name at least one initiator kind`)
    if (r.approvals && (!Number.isSafeInteger(r.approvals.count) || r.approvals.count < 0)) out.push(`rule ${r.id}: approvals.count must be a non-negative integer`)
    if (r.window?.hours_utc && !(r.window.hours_utc[0] >= 0 && r.window.hours_utc[1] <= 24 && r.window.hours_utc[0] < r.window.hours_utc[1])) out.push(`rule ${r.id}: hours_utc must be [from, to) within 0..24`)
  }
  const q = p.quorum
  if (!q || !Number.isSafeInteger(q.threshold) || q.threshold < 1 || !Array.isArray(q.keys) || new Set(q.keys).size !== q.keys.length || q.threshold > q.keys.length || q.keys.some((k) => !isHex(k, 32))) out.push('quorum: threshold must be 1..keys and keys distinct 32-byte keys')
  if (!Number.isSafeInteger(p.loosen_delay_seconds) || p.loosen_delay_seconds < 0) out.push('loosen_delay_seconds must be a non-negative integer')
  if (!['required', 'when-provided', 'off'].includes(p.sanctions)) out.push('sanctions must be required, when-provided or off')
  return out
}

/** Distinct quorum keys of `governing` that signed exactly `next`. */
export function quorumApprovers(governing: GovernancePolicy, next: GovernancePolicy, approvals: PolicyApproval[]): { approvers: Hex[]; problems: string[] } {
  const hash = policyHash(next)
  const approvers = new Set<Hex>()
  const problems: string[] = []
  for (const a of approvals) {
    if (!a || a.v !== 1 || a.domain !== 'passbook-policy-approval-v1' || !isHex(a.approver_pk, 32) || !verifyObject(a, a.approver_pk)) { problems.push('POLICY_APPROVAL_SIGNATURE'); continue }
    if (a.policy_hash !== hash) { problems.push('POLICY_APPROVAL_FOR_ANOTHER_VERSION'); continue }
    if (!governing.quorum.keys.includes(a.approver_pk)) { problems.push('POLICY_APPROVAL_FROM_NON_QUORUM_KEY'); continue }
    approvers.add(a.approver_pk)
  }
  return { approvers: [...approvers], problems }
}

// ---- tightening or loosening ----

const subset = <T>(a: T[] | undefined, b: T[] | undefined): boolean => b === undefined || (a !== undefined && a.every((x) => b.includes(x)))
const atMost = (a: number | undefined, b: number | undefined): boolean => b === undefined || (a !== undefined && a <= b)

function ruleNarrower(n: GateRule, o: GateRule): string[] {
  const wider: string[] = []
  if (!subset(n.initiators.kinds, o.initiators.kinds) || !subset(n.initiators.ids, o.initiators.ids)) wider.push('initiators')
  if (!subset(n.actions, o.actions)) wider.push('actions')
  if (!subset(n.assets, o.assets)) wider.push('assets')
  if (!atMost(n.max_amount, o.max_amount)) wider.push('max_amount')
  if (o.destinations) {
    if (!n.destinations || n.destinations.kind !== o.destinations.kind || (n.destinations.kind === 'allowlist' && o.destinations.kind === 'allowlist' && !subset(n.destinations.ids, o.destinations.ids))) wider.push('destinations')
  }
  if (!subset(n.networks, o.networks)) wider.push('networks')
  if (o.window?.days_utc && !subset(n.window?.days_utc, o.window.days_utc)) wider.push('window.days_utc')
  if (o.window?.hours_utc && !(n.window?.hours_utc && n.window.hours_utc[0] >= o.window.hours_utc[0] && n.window.hours_utc[1] <= o.window.hours_utc[1])) wider.push('window.hours_utc')
  if (!atMost(n.limits?.per_day, o.limits?.per_day)) wider.push('limits.per_day')
  if (!atMost(n.limits?.per_counterparty_per_day, o.limits?.per_counterparty_per_day)) wider.push('limits.per_counterparty_per_day')
  if ((n.approvals?.count ?? 0) < (o.approvals?.count ?? 0)) wider.push('approvals.count')
  if (!(o.approvals?.roles ?? []).every((r) => (n.approvals?.roles ?? []).includes(r))) wider.push('approvals.roles')
  return wider
}

const SANCTIONS_STRENGTH = { off: 0, 'when-provided': 1, required: 2 } as const

/**
 * Whether `next` only narrows what `current` allows. Rules are grants, so a
 * removed rule tightens and an added rule loosens unless an existing rule already
 * covers it; a changed rule tightens only if every field is the same or narrower.
 * Anything not provably tighter is loosening.
 */
export function classifyChange(current: GovernancePolicy, next: GovernancePolicy): { change: 'tighten' | 'loosen'; reasons: string[] } {
  const loosen: string[] = []
  const tighten: string[] = []
  const before = new Map(current.rules.map((r) => [r.id, r]))
  for (const r of next.rules) {
    const o = before.get(r.id)
    if (!o) {
      // a new rule grants nothing new if an existing rule already allows everything it does
      const cover = current.rules.find((c) => ruleNarrower(r, c).length === 0)
      if (cover) tighten.push(`rule ${r.id} added inside rule ${cover.id}`)
      else loosen.push(`rule ${r.id} added`)
      continue
    }
    const wider = ruleNarrower(r, o)
    if (wider.length) loosen.push(`rule ${r.id} widened: ${wider.join(', ')}`)
    else if (hashObject(r) !== hashObject(o)) tighten.push(`rule ${r.id} narrowed`)
  }
  for (const o of current.rules) if (!next.rules.some((r) => r.id === o.id)) tighten.push(`rule ${o.id} removed`)
  const newApprovers = next.approvers.filter((a) => !current.approvers.some((b) => b.pk === a.pk && b.role === a.role))
  if (newApprovers.length) loosen.push(`approvers added: ${newApprovers.map((a) => `${a.role}:${a.pk.slice(0, 8)}`).join(', ')}`)
  if (next.approvers.length < current.approvers.length && !newApprovers.length) tighten.push('approvers removed')
  const newQuorumKeys = next.quorum.keys.filter((k) => !current.quorum.keys.includes(k))
  if (newQuorumKeys.length) loosen.push('quorum keys added (key change)')
  if (next.quorum.threshold < current.quorum.threshold) loosen.push('quorum threshold lowered')
  if (next.quorum.threshold > current.quorum.threshold) tighten.push('quorum threshold raised')
  if (next.loosen_delay_seconds < current.loosen_delay_seconds) loosen.push('loosening delay shortened')
  if (next.loosen_delay_seconds > current.loosen_delay_seconds) tighten.push('loosening delay lengthened')
  if (SANCTIONS_STRENGTH[next.sanctions] < SANCTIONS_STRENGTH[current.sanctions]) loosen.push('sanctions screening weakened')
  if (SANCTIONS_STRENGTH[next.sanctions] > SANCTIONS_STRENGTH[current.sanctions]) tighten.push('sanctions screening strengthened')
  return loosen.length ? { change: 'loosen', reasons: loosen } : { change: 'tighten', reasons: tighten.length ? tighten : ['no change in what is allowed'] }
}

/** The version in force at `now`: the highest version whose effective time has come. */
export function activeRecord(records: PolicyRecord[], now: number): PolicyRecord | null {
  let best: PolicyRecord | null = null
  for (const r of records) if (r.effective_at <= now && (!best || r.policy.version > best.policy.version)) best = r
  return best
}

/**
 * Built-in policy for a demo node: what today's agents do, with no limits and
 * no extra approvals, so the demo runs as before while every signature still
 * passes the gate and the log. Loan money goes to the term sheet's counterparty
 * only. Real deployments install their own policy (docs/AGENT-GOVERNANCE.md).
 */
export function demoDefaultPolicy(nodePk: Hex, ownerPk: Hex, now = Math.floor(Date.now() / 1000)): GovernancePolicy {
  return {
    v: 1, domain: 'passbook-governance-policy-v1', node_pk: nodePk, version: 1, prev_hash: null,
    rules: [
      { id: 'agent-loan-money', description: "the node's agent may move loan money to the term sheet's counterparty only", initiators: { kinds: ['agent'] }, actions: ['lock', 'fund', 'repay', 'release', 'liquidate'], destinations: { kind: 'counterparty-only' }, networks: ['regtest'] },
      { id: 'agent-fees-and-notes', description: "the node's agent may pay platform fees and move loan IOUs", initiators: { kinds: ['agent'] }, actions: ['fee-payment', 'iou-transfer'], networks: ['regtest'] },
      { id: 'owner-any', description: 'the owner may move money with their own approval of the decoded transaction', initiators: { kinds: ['human'], ids: [ownerPk] }, actions: ['lock', 'fund', 'repay', 'release', 'liquidate', 'fee-payment', 'iou-transfer'], networks: ['regtest'], approvals: { count: 1, roles: ['owner'] } },
      { id: 'service-cosign', description: 'the platform service may co-sign a release or liquidation its own checks passed', initiators: { kinds: ['service'] }, actions: ['release', 'liquidate'], networks: ['regtest'] },
    ],
    approvers: [{ pk: ownerPk, role: 'owner' }],
    quorum: { threshold: 1, keys: [ownerPk] },
    loosen_delay_seconds: 86_400,
    sanctions: 'when-provided',
    created_at: now,
  }
}

/**
 * Re-check a stored policy record before using it: its hash, the quorum that
 * signed it (the policy in force when it was proposed; version 1 its own), the
 * version chain, and that a loosening waited its delay. A hand-edited store
 * fails here and the gate allows nothing.
 */
export function recordProblems(records: PolicyRecord[], record: PolicyRecord, gatePk: Hex): string[] {
  const p = record.policy
  const out: string[] = []
  if (policyHash(p) !== record.policy_hash) out.push('policy hash does not match the stored policy')
  if (p.node_pk !== gatePk) out.push('policy governs another node key')
  if (p.version === 1) {
    if (p.prev_hash !== null) out.push('version 1 names a previous version')
    if (quorumApprovers(p, p, record.approvals).approvers.length < p.quorum.threshold) out.push('version 1 lacks its own quorum')
    return out
  }
  const prev = records.find((r) => r.policy.version === p.version - 1)
  if (!prev || prev.policy_hash !== p.prev_hash) out.push(`version ${p.version} does not follow version ${p.version - 1}`)
  const governing = activeRecord(records.filter((r) => r.policy.version < p.version), record.proposed_at)
  if (!governing) return [...out, 'no policy was in force when this version was proposed']
  if (quorumApprovers(governing.policy, p, record.approvals).approvers.length < governing.policy.quorum.threshold) out.push(`version ${p.version} lacks the quorum of version ${governing.policy.version}`)
  const cls = classifyChange(governing.policy, p).change
  if (cls === 'loosen' && record.effective_at < record.proposed_at + governing.policy.loosen_delay_seconds) out.push(`version ${p.version} loosens but took effect before its ${governing.policy.loosen_delay_seconds} s delay`)
  return out
}
