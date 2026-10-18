// One policy gate for every money-moving or rule-changing action: lock, fund,
// repay, release, liquidate, fee payment, IOU transfer, policy change and key
// change. Code decides, never a model.
//
// A request names who initiates it (a human key, an agent's session key or the
// node's own service key), the action and the decoded transactions it wants
// signed. The gate derives the asset, amount and destinations from the decoded
// transactions itself, evaluates the policy in force, screens the
// counterparty's addresses when asked, and only then reserves the amount
// against the cumulative limits and signs one token per transaction, bound to
// that transaction's decoded hash. All of this happens inside one exclusive
// lock, so concurrent requests can never overspend a limit, and the
// reservation exists before anything is signed. The signer (wallet/signer.ts)
// refuses a transaction whose decoded hash differs from its token.
//
// Every decision, signature, policy change and kill-switch use is appended to
// the hash-chained decision log, which `passbook why <action-id>` reads.

import { hashObject, isHex, randomHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { termsHash, type LoanTerms } from '../core/terms.js'
import { escrowFor, keyPathOutput, partiesOf, type PsbtSummary } from '../escrow/escrow.js'
import type { RgbTransferSummary } from '../rgb/wallet.js'
import type { AddressScreeningResult, SanctionsScreen, ScreeningSubject } from '../compliance/sanctions.js'
import { onGovernedSignature, summaryHash, type GateToken, type GovernedAction } from '../wallet/signer.js'
import type { DecisionLog, LogEntry } from './log.js'
import { activeRecord, classifyChange, policyHash, policyProblems, quorumApprovers, recordProblems, type GateRule, type GovernancePolicy, type InitiatorKind, type Network, type PolicyApproval, type PolicyRecord } from './policy.js'
import { AgentStopped, issueSession, sessionProblem, SessionSigner, type AgentSession, type SessionGrant } from './sessions.js'
import { utcDay, type GateStore, type StoreState } from './store.js'

export type Initiator =
  | { kind: 'human'; pk: Hex }
  | { kind: 'agent'; agent_id: string; session: SessionGrant }
  | { kind: 'service'; pk: Hex; id: string }

export type GateTx =
  | { signer: string; kind: 'bitcoin-psbt'; summary: PsbtSummary }
  /** `recipient_owner`: who owns the invoice, per the signed message that carried it. */
  | { signer: string; kind: 'rgb-transfer'; summary: RgbTransferSummary; recipient_owner?: Hex }
  /** A wallet-panel send: the decoded preview the person confirmed (src/wallet/send-gate.ts). */
  | { signer: string; kind: 'wallet-preview'; summary: WalletPreviewSummary }

export interface WalletPreviewSummary {
  kind: 'wallet-preview'
  network: Network
  action: 'wallet.send.btc' | 'wallet.send.rgb' | 'wallet.prepare.rgb'
  /** hashObject of the preview the person saw and confirmed */
  preview_hash: Hex
  to: string
  amount: number
  unit: 'sats' | 'micro'
  asset_id: string | null
  fee_sats: number
}

/** A person's approval of exactly these decoded transactions. */
export interface SigningApproval {
  v: 1
  domain: 'passbook-signing-approval-v1'
  /** approvalDigest(txs): the decoded hash of every transaction, with its signer. */
  digest: Hex
  approver_pk: Hex
  approved_at: number
  sig: Hex
}

export interface GateRequest {
  v: 1
  domain: 'passbook-gate-request-v1'
  action: GovernedAction
  initiator: Initiator
  network: Network
  txs: GateTx[]
  /** The term sheet this serves: its hash (the on-chain terms hash) and terms. */
  loan?: { id: Hex; terms: LoanTerms } | null
  /** The other party (the term sheet's counterparty, an IOU holder, the platform). */
  counterparty?: Hex | null
  /** The counterparty's proven addresses and their direct (1-hop) counterparties. */
  screening?: ScreeningSubject | null
  approvals?: SigningApproval[]
  /** The scorer result the term sheet names, logged as its own entry. */
  scorer?: { provider: string; recommendation: string; trust: string; result_hash: Hex; fallback: boolean } | null
  /** Hashes of other inputs, for the log. */
  inputs?: Record<string, Hex>
  reason?: string
  requested_at: number
  sig: Hex
}

export interface CheckResult { check: string; ok: boolean; detail: string }
export interface RuleResult { rule_id: string; description: string; applies: boolean; ok: boolean; checks: CheckResult[] }

export interface GateDecision {
  action_id: string
  allowed: boolean
  dry_run: boolean
  action: GovernedAction
  policy_version: number | null
  asset: string | null
  amount: number
  gate_checks: CheckResult[]
  rules: RuleResult[]
  allowed_by: string | null
  sanctions: AddressScreeningResult | null
  tokens: GateToken[]
  /** One line: why. */
  reason: string
  log_entry: Hex | null
}

export class GateRefused extends Error {
  constructor(readonly decision: GateDecision) {
    super(`policy gate refused ${decision.action} (${decision.action_id}): ${decision.reason}. Run: passbook why ${decision.action_id}`)
    this.name = 'GateRefused'
  }
}

export interface Destination { id: string; address: string | null; value: number; owner: 'counterparty' | 'escrow' | 'unknown' }

export function approvalDigest(txs: Pick<GateTx, 'signer' | 'summary'>[]): Hex {
  return hashObject({ domain: 'passbook-signing-approval-digest-v1', txs: txs.map((t) => ({ signer: t.signer, decoded_hash: summaryHash(t.summary) })) })
}

export function approveSigning(key: KeyPair, txs: Pick<GateTx, 'signer' | 'summary'>[], at = Math.floor(Date.now() / 1000)): SigningApproval {
  return signObject({ v: 1 as const, domain: 'passbook-signing-approval-v1' as const, digest: approvalDigest(txs), approver_pk: key.pubkey, approved_at: at }, key.secretKey)
}

export interface GateOptions {
  /** The gate's key: signs tokens, session grants and log entries (the node key). */
  key: KeyPair
  /** The party key whose money this gate governs: outputs to it are the node's own. */
  ownerPk: Hex
  store: GateStore
  log: DecisionLog
  sanctions?: SanctionsScreen
  tokenTtlSeconds?: number
  now?: () => number
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

export class PolicyGate {
  readonly key: KeyPair
  readonly ownerPk: Hex
  readonly store: GateStore
  readonly log: DecisionLog
  readonly sanctions?: SanctionsScreen
  private readonly ttl: number
  private readonly now: () => number

  constructor(o: GateOptions) {
    this.key = o.key
    this.ownerPk = o.ownerPk
    this.store = o.store
    this.log = o.log
    this.sanctions = o.sanctions
    this.ttl = o.tokenTtlSeconds ?? 600
    this.now = o.now ?? nowSeconds
    onGovernedSignature(this.key.pubkey, { spend: (token) => this.spend(token), settle: (token, outcome) => this.settleSignature(token, outcome) })
  }

  get pubkey(): Hex {
    return this.key.pubkey
  }

  // ---- policies ----

  policies(): PolicyRecord[] {
    return this.store.read().policies
  }

  activePolicy(): PolicyRecord | null {
    return activeRecord(this.policies(), this.now())
  }

  /** Install version 1, approved by its own quorum. Refused once a policy exists. */
  install(policy: GovernancePolicy, approvals: PolicyApproval[]): PolicyRecord {
    const problems = [...policyProblems(policy)]
    if (policy.node_pk !== this.pubkey) problems.push('policy governs another node key')
    if (policy.version !== 1 || policy.prev_hash !== null) problems.push('the first policy is version 1 with no previous hash')
    const quorum = quorumApprovers(policy, policy, approvals)
    if (quorum.approvers.length < policy.quorum.threshold) problems.push(`quorum ${quorum.approvers.length}/${policy.quorum.threshold}`)
    const actionId = newActionId()
    return this.store.transact((s) => {
      if (s.policies.length) problems.push('a policy is already installed; change it with a new version')
      const at = this.now()
      if (problems.length) {
        this.log.append({ kind: 'policy-change', action_id: actionId, policy_version: policy.version, input_hashes: { policy: policyHash(policy) }, decided_by: { kind: 'quorum' }, result: 'refused', detail: { problems } })
        throw new Error(`policy refused: ${problems.join('; ')}`)
      }
      const record: PolicyRecord = { policy, policy_hash: policyHash(policy), approvals, change: 'genesis', reasons: ['first policy of this node'], proposed_at: at, effective_at: at, action_id: actionId }
      s.policies.push(record)
      this.log.append({ kind: 'policy-change', action_id: actionId, policy_version: 1, input_hashes: { policy: record.policy_hash, approvals: hashObject(approvals) }, decided_by: { kind: 'quorum', id: quorum.approvers.map((k) => k.slice(0, 16)).join(',') }, result: 'applied', detail: { change: 'genesis', approvers: quorum.approvers, rules: policy.rules.map((r) => r.id) } })
      return record
    })
  }

  /**
   * Propose the next version with its approvals. The quorum of the policy in
   * force must approve it; tightening applies now, loosening after the delay.
   */
  changePolicy(next: GovernancePolicy, approvals: PolicyApproval[]): { record: PolicyRecord | null; action_id: string; problems: string[] } {
    const actionId = newActionId()
    return this.store.transact((s) => {
      const at = this.now()
      const current = activeRecord(s.policies, at)
      const latest = s.policies.reduce<PolicyRecord | null>((m, r) => (!m || r.policy.version > m.policy.version ? r : m), null)
      const checks: CheckResult[] = []
      const problems = policyProblems(next)
      checks.push({ check: 'well-formed', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'valid v1 policy' })
      checks.push({ check: 'node', ok: next.node_pk === this.pubkey, detail: next.node_pk === this.pubkey ? 'governs this gate' : 'governs another node key' })
      checks.push({ check: 'version-chain', ok: !!latest && next.version === latest.policy.version + 1 && next.prev_hash === latest.policy_hash, detail: latest ? `expects version ${latest.policy.version + 1} after ${latest.policy_hash.slice(0, 12)}…` : 'no policy installed' })
      let quorumOk = false
      let approvers: Hex[] = []
      if (current) {
        const q = quorumApprovers(current.policy, next, approvals)
        approvers = q.approvers
        quorumOk = approvers.length >= current.policy.quorum.threshold
        checks.push({ check: 'quorum', ok: quorumOk, detail: `${approvers.length} of ${current.policy.quorum.threshold} required quorum keys of version ${current.policy.version} signed this version${q.problems.length ? `; ignored: ${[...new Set(q.problems)].join(', ')}` : ''}` })
      } else checks.push({ check: 'quorum', ok: false, detail: 'no policy in force' })
      const cls = current ? classifyChange(current.policy, next) : { change: 'loosen' as const, reasons: ['no policy in force'] }
      const keyChange = current ? next.quorum.keys.join() !== current.policy.quorum.keys.join() || hashObject(next.approvers) !== hashObject(current.policy.approvers) : false
      const delay = cls.change === 'tighten' ? 0 : (current?.policy.loosen_delay_seconds ?? 0)
      checks.push({ check: 'classification', ok: true, detail: `${cls.change}${delay ? `: waits ${delay} s` : ': applies at once'} (${cls.reasons.join('; ')})` })
      const ok = checks.every((c) => c.ok)
      const action: GovernedAction = keyChange ? 'key-change' : 'policy-change'
      if (!ok) {
        this.log.append({ kind: 'policy-change', action_id: actionId, policy_version: current?.policy.version ?? null, input_hashes: { policy: policyHash(next), approvals: hashObject(approvals) }, decided_by: { kind: 'quorum', id: approvers.map((k) => k.slice(0, 16)).join(',') }, result: 'refused', detail: { action, proposed_version: next.version, checks } })
        return { record: null, action_id: actionId, problems: checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`) }
      }
      const record: PolicyRecord = { policy: next, policy_hash: policyHash(next), approvals, change: cls.change, reasons: cls.reasons, proposed_at: at, effective_at: at + delay, action_id: actionId }
      s.policies.push(record)
      this.log.append({ kind: 'policy-change', action_id: actionId, policy_version: next.version, input_hashes: { policy: record.policy_hash, previous: next.prev_hash ?? '', approvals: hashObject(approvals) }, decided_by: { kind: 'quorum', id: approvers.map((k) => k.slice(0, 16)).join(',') }, result: delay ? 'scheduled' : 'applied', detail: { action, change: cls.change, effective_at: record.effective_at, checks } })
      return { record, action_id: actionId, problems: [] }
    })
  }

  // ---- sessions and the kill switch ----

  /** A short-lived session key for one agent and one negotiation. Refused for a stopped agent. */
  openSession(agentId: string, scope: SessionGrant['scope'], ttlSeconds = 3600): AgentSession {
    const session = issueSession(this.store, this.key, agentId, scope, ttlSeconds, this.now())
    this.log.append({ kind: 'session', action_id: null, loan_id: scope.negotiation_id, policy_version: this.activePolicy()?.policy.version ?? null, input_hashes: { grant: hashObject(session.grant) }, decided_by: { kind: 'node', pk: this.pubkey }, result: 'granted', detail: { agent_id: agentId, session_pk: session.grant.session_pk, scope, expires_at: session.grant.expires_at } })
    return session
  }

  /** The Signer an agent signs its negotiation messages with: refuses once the session ends. */
  sessionSigner(party: KeyPair, session: AgentSession): SessionSigner {
    return new SessionSigner(party, session, this.store, this.pubkey)
  }

  /**
   * The kill switch: freeze one agent (or every agent, '*') at this gate and
   * revoke its session keys. Nothing on chain changes: open loans keep their
   * exit paths, and people can still act through the gate with their own keys.
   */
  stopAgent(agentId: string | '*', by: string, reason = 'kill switch'): { action_id: string; revoked: string[]; agents: string[] } {
    const actionId = newActionId()
    return this.store.transact((s) => {
      const at = this.now()
      const agents = agentId === '*' ? [...new Set([...s.sessions.map((r) => r.grant.agent_id), '*'])] : [agentId]
      for (const a of agents) s.frozen[a] = { at, by, reason, action_id: actionId }
      const revoked: string[] = []
      for (const r of s.sessions) if ((agentId === '*' || r.grant.agent_id === agentId) && r.revoked_at === undefined) { r.revoked_at = at; r.revoked_by = by; revoked.push(r.grant.session_pk) }
      this.log.append({ kind: 'kill-switch', action_id: actionId, policy_version: activeRecord(s.policies, at)?.policy.version ?? null, input_hashes: {}, decided_by: { kind: 'operator', id: by }, result: 'stopped', detail: { agents, revoked_sessions: revoked, reason, funds: 'unchanged: open loans keep their on-chain exits (leaves A, C, D, and E on atomic loans); no signature is revoked or broadcast' } })
      return { action_id: actionId, revoked, agents }
    })
  }

  agentStopped(agentId: string): boolean {
    const f = this.store.read().frozen
    return !!(f[agentId] ?? f['*'])
  }

  // ---- decisions ----

  /** Evaluate without reserving or issuing tokens. Logged as a dry run. */
  dryRun(req: GateRequest): Promise<GateDecision> {
    return this.decide(req, true)
  }

  authorize(req: GateRequest): Promise<GateDecision> {
    return this.decide(req, false)
  }

  private async decide(req: GateRequest, dryRun: boolean): Promise<GateDecision> {
    const actionId = newActionId()
    // Screening reads only the offline snapshot; it runs before the lock and its result is an input to the decision.
    const policyNow = this.activePolicy()?.policy
    const wantScreen = !!policyNow && policyNow.sanctions !== 'off' && !!req.screening?.proven_addresses?.length
    const screening = wantScreen && this.sanctions ? await this.sanctions.screen(req.screening!) : null
    return this.store.transact((s) => {
      const at = this.now()
      const record = activeRecord(s.policies, at)
      const policy = record?.policy ?? null
      const gate: CheckResult[] = []
      const recordIssues = record ? recordProblems(s.policies, record, this.pubkey) : []
      // the store is a file: the version in force must also be the one the node-signed log says was applied
      if (record && !this.log.entries().some((e) => e.kind === 'policy-change' && e.input_hashes.policy === record.policy_hash && (e.result === 'applied' || e.result === 'scheduled'))) recordIssues.push('no node-signed log entry applied this policy version')
      gate.push({ check: 'policy', ok: !!policy && recordIssues.length === 0, detail: !policy ? 'no policy installed: nothing is allowed' : recordIssues.length ? `version ${policy.version} does not verify: ${recordIssues.join('; ')}` : `version ${policy.version} in force since ${new Date(record!.effective_at * 1000).toISOString()}, quorum-signed` })
      gate.push(...this.initiatorChecks(req, s, at))
      const requestHash = hashObject(req)
      const fresh = Number.isSafeInteger(req.requested_at) && Math.abs(at - req.requested_at) <= REQUEST_WINDOW_SECONDS
      const replayed = (s.requests ?? []).some((r) => r.hash === requestHash)
      // the same decoded transaction already authorized and not yet signed: a second token would allow a second payment
      const decoded = decodedSet(req)
      const inFlight = s.reservations.find((r) => r.status === 'reserved' && at - r.at <= this.ttl && r.decoded !== undefined && r.decoded.join() === decoded.join())
      gate.push({ check: 'in-flight', ok: !inFlight, detail: inFlight ? `the same transaction is already authorized (${inFlight.action_id}) and not yet signed` : 'no identical transaction awaiting its signature' })
      gate.push({ check: 'request', ok: fresh && !replayed, detail: replayed ? 'this signed request was already decided (replay)' : fresh ? 'fresh and not seen before' : `requested ${req.requested_at}, outside ${REQUEST_WINDOW_SECONDS} s of now` })
      const facts = analyze(req, this.ownerPk)
      gate.push(...facts.checks)
      gate.push(...bindingChecks(req, this.ownerPk))
      if (policy) gate.push(sanctionsCheck(policy, req, screening, !!this.sanctions))
      const rules = policy ? policy.rules.map((r) => evaluateRule(r, req, facts, policy, s, at)) : []
      const passing = rules.find((r) => r.applies && r.ok) ?? null
      if (policy && !rules.some((r) => r.applies)) gate.push({ check: 'rule', ok: false, detail: `no rule grants ${req.action} to ${initiatorLabel(req.initiator)}` })
      const allowed = gate.every((c) => c.ok) && !!passing
      const reason = allowed ? `allowed by rule ${passing!.rule_id}` : firstFailure(gate, rules)
      const tokens: GateToken[] = []
      if (!dryRun) s.requests = [...(s.requests ?? []).filter((r) => r.at > at - 2 * REQUEST_WINDOW_SECONDS), { hash: requestHash, at }]
      if (allowed && !dryRun) {
        this.reserve(s, req, facts, passing!.rule_id, actionId, at)
        for (const tx of req.txs) tokens.push(signObject({ v: 1 as const, domain: 'passbook-gate-token-v1' as const, action_id: actionId, action: req.action, signer: tx.signer, decoded_hash: summaryHash(tx.summary), policy_version: policy!.version, issued_at: at, expires_at: at + this.ttl, gate_pk: this.pubkey }, this.key.secretKey))
        if (req.loan) {
          const loan = (s.loans[req.loan.id] ??= { policy_version: policy!.version, actions: [] })
          loan.actions.push({ action_id: actionId, action: req.action, at })
        }
      }
      const loanId = req.loan?.id ?? null
      const extra: LogEntry[] = []
      // a dry run's screening and inputs are logged with the real decision that follows it; a hit is logged at once
      if (screening && (!dryRun || screening.status === 'hit')) extra.push(this.log.append({ kind: 'sanctions-result', action_id: actionId, loan_id: loanId, policy_version: policy?.version ?? null, input_hashes: { subject: hashObject(req.screening), lists: hashObject(screening.lists) }, decided_by: { kind: 'gate', pk: this.pubkey }, result: screening.status, detail: { list_version: screening.list_version, lists: screening.lists, screened: screening.screened, hits: screening.hits } }))
      if (req.scorer && !dryRun) extra.push(this.log.append({ kind: 'scorer-result', action_id: actionId, loan_id: loanId, policy_version: policy?.version ?? null, input_hashes: { scorer_result: req.scorer.result_hash }, decided_by: { kind: 'service', id: req.scorer.provider }, result: req.scorer.recommendation, detail: req.scorer }))
      if (!dryRun) for (const a of req.approvals ?? []) extra.push(this.log.append({ kind: 'approval', action_id: actionId, loan_id: loanId, policy_version: policy?.version ?? null, input_hashes: { approval: hashObject(a), digest: a.digest }, decided_by: { kind: 'human', pk: a.approver_pk }, result: a.digest === approvalDigest(req.txs) && verifyObject(a, a.approver_pk) ? 'approved' : 'invalid', detail: { role: policy?.approvers.find((x) => x.pk === a.approver_pk)?.role ?? null, approved_at: a.approved_at } }))
      const entry = this.log.append({
        kind: 'gate-decision', action_id: actionId, loan_id: loanId, policy_version: policy?.version ?? null,
        input_hashes: { request: hashObject(req), ...Object.fromEntries(req.txs.map((t, i) => [`tx${i}:${t.kind}`, summaryHash(t.summary)])), ...(req.inputs ?? {}) },
        decided_by: { kind: 'gate', pk: this.pubkey },
        result: dryRun ? (allowed ? 'would-allow' : 'would-deny') : allowed ? 'allow' : 'deny',
        detail: { dry_run: dryRun, action: req.action, initiator: initiatorLabel(req.initiator), asset: facts.asset, amount: facts.amount, destinations: facts.destinations, counterparty: req.counterparty ?? null, reason: req.reason ?? null, gate_checks: gate, rules, allowed_by: passing?.rule_id ?? null, tokens: tokens.map((t) => ({ signer: t.signer, decoded_hash: t.decoded_hash, expires_at: t.expires_at })), linked: extra.map((e) => e.hash) },
      })
      return { action_id: actionId, allowed, dry_run: dryRun, action: req.action, policy_version: policy?.version ?? null, asset: facts.asset, amount: facts.amount, gate_checks: gate, rules, allowed_by: passing?.rule_id ?? null, sanctions: screening, tokens, reason, log_entry: entry.hash }
    })
  }

  /** After signing: keep the reservation (`done`), or give it back when nothing was signed. */
  settle(actionId: string, outcome: 'done' | 'not-signed', txids: string[] = []): void {
    this.store.transact((s) => {
      for (const r of s.reservations) {
        if (r.action_id !== actionId) continue
        if (outcome === 'done') { r.status = 'committed'; r.txids = [...new Set([...(r.txids ?? []), ...txids])] }
        else if (r.status === 'reserved') r.status = 'released'
      }
    })
  }

  private reserve(s: StoreState, req: GateRequest, facts: Facts, ruleId: string, actionId: string, at: number): void {
    // every authorized action is its own reservation: two actions on one loan both count in full
    s.reservations.push({ action_id: actionId, key: actionId, decoded: decodedSet(req), rule_id: ruleId, action: req.action, asset: facts.asset ?? '', counterparty: req.counterparty ?? null, amount: facts.amount, day: utcDay(at), status: 'reserved', at })
    // keep two weeks of counters
    s.reservations = s.reservations.filter((r) => r.at > at - 14 * 86_400)
  }

  /** Before signing: mark the token used, durably. It stays used whatever happens next, so it can never be replayed. */
  private spend(token: GateToken): boolean {
    const use = `${token.action_id}:${token.decoded_hash}:${token.signer}`
    return this.store.transact((s) => {
      if ((s.spent_tokens ?? []).some((t) => t.use === use)) return false
      const at = this.now()
      s.spent_tokens = [...(s.spent_tokens ?? []).filter((t) => t.at > at - 2 * this.ttl), { use, at }]
      return true
    })
  }

  /** After the attempt: a signature commits the reservation and is logged; a failure gives it back and is logged as failed. */
  private settleSignature(token: GateToken, outcome: { signed: true } | { signed: false; error: string }): void {
    this.store.transact((s) => {
      for (const r of s.reservations) {
        if (r.action_id !== token.action_id) continue
        if (outcome.signed && r.status === 'reserved') r.status = 'committed'
        if (!outcome.signed && r.status === 'reserved') r.status = 'released'
      }
    })
    this.log.append({ kind: 'signature', action_id: token.action_id, policy_version: token.policy_version, input_hashes: { decoded: token.decoded_hash, token: hashObject(token) }, decided_by: { kind: 'node', pk: this.pubkey }, result: outcome.signed ? 'signed' : 'failed', detail: { signer: token.signer, action: token.action, ...(outcome.signed ? {} : { error: outcome.error, reservation: 'released' }) } })
  }


  private initiatorChecks(req: GateRequest, s: StoreState, at: number): CheckResult[] {
    const i = req.initiator
    const out: CheckResult[] = []
    if (i.kind === 'agent') {
      const signedOk = !!i.session && isHex(i.session.session_pk, 32) && verifyObject(req, i.session.session_pk)
      out.push({ check: 'initiator', ok: signedOk, detail: signedOk ? `agent ${i.agent_id}, request signed by its session key ${i.session.session_pk.slice(0, 12)}…` : 'request not signed by the agent session key' })
      const frozen = s.frozen[i.agent_id] ?? s.frozen['*']
      out.push({ check: 'agent-active', ok: !frozen, detail: frozen ? `stopped by ${frozen.by} at ${new Date(frozen.at * 1000).toISOString()} (${frozen.action_id})` : 'not stopped' })
      const problem = sessionProblemIn(s, i.session, this.pubkey, at)
      const scopeOk = !!i.session && i.session.agent_id === i.agent_id && i.session.scope.actions.includes(req.action) && (i.session.scope.negotiation_id === null || i.session.scope.negotiation_id === (req.loan?.id ?? null))
      out.push({ check: 'session', ok: !problem && scopeOk, detail: problem ?? (scopeOk ? `granted until ${new Date(i.session.expires_at * 1000).toISOString()}` : 'SESSION_OUT_OF_SCOPE') })
    } else {
      const signedOk = isHex(i.pk, 32) && verifyObject(req, i.pk)
      out.push({ check: 'initiator', ok: signedOk && (i.kind === 'human' || i.pk === this.ownerPk), detail: !signedOk ? `request not signed by ${i.kind} key` : i.kind === 'service' && i.pk !== this.ownerPk ? 'service key is not this node' : `${i.kind} ${i.pk.slice(0, 12)}…` })
    }
    return out
  }
}

function sessionProblemIn(s: StoreState, grant: SessionGrant, nodePk: Hex, now: number): string | null {
  const view: GateStore = { dir: null, read: () => s, transact: () => { throw new Error('read only') } }
  return grant ? sessionProblem(view, grant, nodePk, now) : 'NO_SESSION'
}

const newActionId = (): string => `act_${randomHex(8)}`

/** The decoded transactions of a request, as a sorted list of hashes: what makes two requests the same transaction. */
const decodedSet = (req: GateRequest): Hex[] => req.txs.map((t) => `${t.signer}:${summaryHash(t.summary)}`).sort()

/** A signed request is good for this long, and only once. */
export const REQUEST_WINDOW_SECONDS = 300

export function initiatorLabel(i: Initiator): string {
  return i.kind === 'agent' ? `agent ${i.agent_id}` : i.kind === 'service' ? `service ${i.id}` : `human ${i.pk.slice(0, 12)}…`
}

const initiatorId = (i: Initiator): string => (i.kind === 'agent' ? i.agent_id : i.pk)

interface Facts { asset: string | null; amount: number; destinations: Destination[]; checks: CheckResult[] }

/** Asset, amount and destinations, from the decoded transactions alone. Outputs to the node's own key and OP_RETURN data move nothing. */
export function analyze(req: GateRequest, ownerPk: Hex): Facts {
  const own = keyPathOutput(ownerPk).script
  const counterpartyScript = req.counterparty && isHex(req.counterparty, 32) ? keyPathOutput(req.counterparty).script : null
  let escrow: string | null = null
  try { if (req.loan) escrow = escrowFor(partiesOf(req.loan.terms)).script } catch { escrow = null }
  const assets = new Set<string>()
  const destinations: Destination[] = []
  let amount = 0
  for (const tx of req.txs) {
    if (tx.kind === 'bitcoin-psbt') {
      assets.add('BTC')
      for (const o of tx.summary.outputs) {
        if (o.op_return !== null || o.script === own) continue
        destinations.push({ id: o.script, address: o.address, value: o.value, owner: o.script === counterpartyScript ? 'counterparty' : o.script === escrow ? 'escrow' : 'unknown' })
        amount += o.value
      }
    } else if (tx.kind === 'wallet-preview') {
      const asset = tx.summary.unit === 'sats' ? 'BTC' : (tx.summary.asset_id ?? '?')
      assets.add(asset)
      // preparing RGB outputs spends the wallet's own BTC to itself
      if (tx.summary.action === 'wallet.prepare.rgb') continue
      destinations.push({ id: tx.summary.to, address: tx.summary.unit === 'sats' ? tx.summary.to : null, value: tx.summary.amount, owner: 'unknown' })
      amount += tx.summary.amount
    } else {
      assets.add(tx.summary.asset_id)
      if (tx.recipient_owner === ownerPk) continue
      destinations.push({ id: tx.summary.recipient_id, address: null, value: tx.summary.amount, owner: tx.recipient_owner && tx.recipient_owner === req.counterparty ? 'counterparty' : 'unknown' })
      amount += tx.summary.amount
    }
  }
  const checks: CheckResult[] = []
  const networks = new Set<string>(req.txs.map((t) => t.summary.network))
  checks.push({ check: 'transactions', ok: req.txs.length > 0 && assets.size === 1 && networks.size === 1 && networks.has(req.network), detail: req.txs.length === 0 ? 'nothing to sign' : assets.size !== 1 ? `mixes assets ${[...assets].join(', ')}` : !networks.has(req.network) || networks.size !== 1 ? `decoded network ${[...networks].join(', ')} is not the requested ${req.network}` : `${req.txs.length} decoded transaction(s), ${[...assets][0]} on ${req.network}` })
  return { asset: assets.size === 1 ? [...assets][0] : null, amount, destinations, checks }
}

/** That the transactions serve the named term sheet, before any rule looks at them. */
function bindingChecks(req: GateRequest, ownerPk: Hex): CheckResult[] {
  const out: CheckResult[] = []
  if (req.counterparty === ownerPk) out.push({ check: 'counterparty', ok: false, detail: 'the counterparty is this node itself' })
  if (!req.loan) return out
  const problems: string[] = []
  let escrow: string | null = null
  try {
    if (termsHash(req.loan.terms) !== req.loan.id) problems.push('loan id is not the hash of its terms')
    escrow = escrowFor(partiesOf(req.loan.terms)).script
  } catch (err) { problems.push(`terms: ${(err as Error).message}`) }
  for (const tx of req.txs) {
    if (tx.kind !== 'bitcoin-psbt') continue
    const sg = tx.summary.signing
    if (sg.mode === 'escrow-leaf' && sg.escrow_script !== escrow) problems.push(`leaf ${sg.leaf} spends an escrow that is not this loan's`)
    if (sg.mode === 'key-path' && req.action === 'lock') {
      const lock = tx.summary.outputs
      if (!lock.some((o) => o.op_return === req.loan!.id)) problems.push('lock does not commit the loan id in OP_RETURN')
      if (!lock.some((o) => o.script === escrow && o.value === req.loan!.terms.collateral_sats)) problems.push('lock does not pay the agreed collateral to this loan\'s escrow')
    }
  }
  out.push({ check: 'binding', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `serves term sheet ${req.loan.id.slice(0, 12)}…` })
  return out
}

function sanctionsCheck(policy: GovernancePolicy, req: GateRequest, screening: AddressScreeningResult | null, haveScreen: boolean): CheckResult {
  if (policy.sanctions === 'off') return { check: 'sanctions', ok: true, detail: 'screening off in this policy' }
  if (screening && screening.lists.length === 0) {
    const blocks = policy.sanctions === 'required' && !!req.counterparty
    return { check: 'sanctions', ok: !blocks, detail: `NOT SCREENED: ${screening.screen}${blocks ? '; the policy requires screening' : ''}` }
  }
  if (screening) {
    if (screening.status === 'hit') return { check: 'sanctions', ok: false, detail: `HIT on ${screening.list_version}: ${screening.hits.map((h) => `${h.address} (${h.hop === 0 ? 'proven address' : `1 hop via ${h.via}`}, ${h.list_id})`).join('; ')}` }
    return { check: 'sanctions', ok: true, detail: `clear on ${screening.list_version}: ${screening.screened.proven} proven address(es), ${screening.screened.counterparties} direct counterparties` }
  }
  const needs = policy.sanctions === 'required' && !!req.counterparty
  if (req.screening?.proven_addresses?.length && !haveScreen) return { check: 'sanctions', ok: !needs, detail: `NOT SCREENED: addresses supplied but this node has no sanctions list loaded${needs ? '; the policy requires screening' : ''}` }
  if (!needs) return { check: 'sanctions', ok: true, detail: 'no addresses supplied; policy screens when provided' }
  return { check: 'sanctions', ok: false, detail: haveScreen ? 'policy requires screening and the request carries no addresses' : 'policy requires screening and no sanctions list is loaded' }
}

function evaluateRule(r: GateRule, req: GateRequest, facts: Facts, policy: GovernancePolicy, s: StoreState, at: number): RuleResult {
  const kind: InitiatorKind = req.initiator.kind
  const applies = r.actions.includes(req.action) && r.initiators.kinds.includes(kind) && (!r.initiators.ids || r.initiators.ids.includes(initiatorId(req.initiator)))
  if (!applies) return { rule_id: r.id, description: r.description, applies: false, ok: false, checks: [{ check: 'applies', ok: false, detail: `covers ${r.actions.join('/')} by ${r.initiators.kinds.join('/')}${r.initiators.ids ? ' (listed ids)' : ''}` }] }
  const checks: CheckResult[] = []
  const asset = facts.asset ?? '?'
  // an asset entry ending in * is a prefix (rgb:* = any RGB asset)
  const assetOk = !r.assets || r.assets.some((a) => (a.endsWith('*') ? asset.startsWith(a.slice(0, -1)) : a === asset))
  if (r.assets) checks.push({ check: 'asset', ok: assetOk, detail: `${asset.slice(0, 16)} ${assetOk ? 'is' : 'is not'} allowed` })
  if (r.max_amount !== undefined) checks.push({ check: 'max-amount', ok: facts.amount <= r.max_amount, detail: `${facts.amount} of at most ${r.max_amount}` })
  if (r.destinations) {
    const d = r.destinations
    const bad = facts.destinations.filter((x) => d.kind === 'allowlist' ? !(d.ids.includes(x.id) || (x.address !== null && d.ids.includes(x.address))) : !(x.owner === 'counterparty' || (x.owner === 'escrow' && !!req.loan)))
    checks.push({ check: 'destination', ok: bad.length === 0, detail: bad.length ? `${bad.length} destination(s) outside ${d.kind}: ${bad.map((x) => `${(x.address ?? x.id).slice(0, 20)}… (${x.owner})`).join(', ')}` : d.kind === 'allowlist' ? 'every destination is allowlisted' : `only this term sheet's counterparty${req.loan ? ' and its escrow' : ''}` })
  }
  if (r.networks) checks.push({ check: 'network', ok: r.networks.includes(req.network), detail: `${req.network}${r.networks.includes(req.network) ? '' : ` not in ${r.networks.join(', ')}`}` })
  if (r.window) {
    const d = new Date(at * 1000)
    const dayOk = !r.window.days_utc || r.window.days_utc.includes(d.getUTCDay())
    const hourOk = !r.window.hours_utc || (d.getUTCHours() >= r.window.hours_utc[0] && d.getUTCHours() < r.window.hours_utc[1])
    checks.push({ check: 'time-window', ok: dayOk && hourOk, detail: `${d.toISOString().slice(0, 16)}Z ${dayOk && hourOk ? 'inside' : 'outside'} the window` })
  }
  if (r.limits) {
    const day = utcDay(at)
    // a limit caps what moved today for the actions it covers, whichever rule (or policy version) allowed it; every authorized action counts
    const counted = s.reservations.filter((x) => r.actions.includes(x.action) && x.day === day && x.status !== 'released' && x.asset === asset)
    const amount = facts.amount
    if (r.limits.per_day !== undefined) {
      const used = counted.reduce((n, x) => n + x.amount, 0)
      checks.push({ check: 'daily-limit', ok: used + amount <= r.limits.per_day, detail: `${used} used today + ${amount} = ${used + amount} of ${r.limits.per_day}` })
    }
    if (r.limits.per_counterparty_per_day !== undefined) {
      const used = counted.filter((x) => x.counterparty === (req.counterparty ?? null)).reduce((n, x) => n + x.amount, 0)
      checks.push({ check: 'counterparty-limit', ok: used + amount <= r.limits.per_counterparty_per_day, detail: `${used} to ${req.counterparty?.slice(0, 12) ?? 'no counterparty'}… today + ${amount} of ${r.limits.per_counterparty_per_day}` })
    }
  }
  if (r.approvals && (r.approvals.count > 0 || r.approvals.roles?.length)) {
    const digest = approvalDigest(req.txs)
    const valid = new Map<Hex, string>()
    for (const a of req.approvals ?? []) {
      const listed = policy.approvers.find((x) => x.pk === a.approver_pk)
      if (listed && a.domain === 'passbook-signing-approval-v1' && a.digest === digest && verifyObject(a, a.approver_pk)) valid.set(a.approver_pk, listed.role)
    }
    const roles = [...new Set(valid.values())]
    const missingRoles = (r.approvals.roles ?? []).filter((x) => !roles.includes(x))
    checks.push({ check: 'approvals', ok: valid.size >= r.approvals.count && missingRoles.length === 0, detail: `${valid.size} distinct listed approver(s) of these decoded transactions, ${r.approvals.count} required${r.approvals.roles?.length ? `; roles ${roles.join(', ') || 'none'}${missingRoles.length ? `, missing ${missingRoles.join(', ')}` : ''}` : ''}` })
  }
  if (!checks.length) checks.push({ check: 'conditions', ok: true, detail: 'no further conditions' })
  return { rule_id: r.id, description: r.description, applies: true, ok: checks.every((c) => c.ok), checks }
}

function firstFailure(gate: CheckResult[], rules: RuleResult[]): string {
  const g = gate.find((c) => !c.ok)
  if (g) return `${g.check}: ${g.detail}`
  const applicable = rules.filter((r) => r.applies)
  const fails = applicable.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `rule ${r.rule_id} ${c.check}: ${c.detail}`))
  return fails.join('; ') || 'no rule allows it'
}

export { AgentStopped }
