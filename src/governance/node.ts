// A node's governance: its policy gate, decision log and session keys, and the
// three ways it signs money: an escrow leaf, a key-path spend and an RGB send.
// Agents and the platform sign only through here. Each call decodes the
// transaction, asks the gate (a dry run first, then the decision), signs with
// the gate's token bound to the decoded hash, and settles the reservation.
//
// The gate key is derived from the node's party key, so a restarted node keeps
// its gate, log and enrolment. The store and log live in <wallets>/<role>/governance,
// or in memory for a node without a wallet directory (unit tests).

import { bytesToHex, hexToBytes, keyPairFromSecret, sha256Hex, signObject, type Hex, type KeyPair } from '../core/crypto.js'
import { termsHash, type LoanTerms } from '../core/terms.js'
import type * as bitcoin from 'bitcoinjs-lib'
import { psbtSummary, signKeyPath, signLeaf, type EscrowParties, type Leaf } from '../escrow/escrow.js'
import type { RgbWallet } from '../rgb/wallet.js'
import type { SanctionsScreen, ScreeningSubject } from '../compliance/sanctions.js'
import { enrollSigner, keySignerId, type GateToken, type GovernedAction } from '../wallet/signer.js'
import { GateRefused, PolicyGate, type GateDecision, type GateRequest, type GateTx, type SigningApproval } from './gate.js'
import { FileDecisionLog, MemoryDecisionLog } from './log.js'
import { approvePolicy, demoDefaultPolicy, type GovernancePolicy, type Network } from './policy.js'
import { AgentStopped, signRequest, type AgentSession } from './sessions.js'
import { FileGateStore, MemoryGateStore } from './store.js'

export type SignInitiator = { agent: string } | { human: KeyPair } | { service: string }

export interface SignContext {
  action: GovernedAction
  initiator: SignInitiator
  terms?: LoanTerms | null
  /** The other party: the term sheet's counterparty, an IOU holder, the platform. */
  counterparty?: Hex | null
  /** For an RGB send: who owns the invoice, per the signed message that carried it. */
  recipientOwner?: Hex | null
  screening?: ScreeningSubject | null
  scorer?: GateRequest['scorer']
  /** Approvals of exactly these decoded transactions, when the policy asks for them. */
  approvals?: SigningApproval[] | ((txs: GateTx[]) => Promise<SigningApproval[]>)
  reason?: string
}

export interface NodeGovernanceOptions {
  /** The party key whose money this node governs. */
  ownerKey: KeyPair
  /** Durable store and log directory; null keeps both in memory. */
  dir: string | null
  sanctions?: SanctionsScreen | null
  /** Version 1 for a node with no policy yet; the demo default otherwise. */
  policy?: (gatePk: Hex, ownerPk: Hex) => GovernancePolicy
  network?: Network
  sessionTtlSeconds?: number
  now?: () => number
}

/** The node's gate key: domain-separated from its party key, stable across restarts. */
export function gateKeyFor(owner: KeyPair): KeyPair {
  return keyPairFromSecret(sha256Hex(new Uint8Array([...owner.secretKey, ...new TextEncoder().encode('passbook-gate-key-v1')])))
}

export class NodeGovernance {
  readonly gate: PolicyGate
  readonly ownerKey: KeyPair
  readonly network: Network
  private readonly sessionTtl: number
  private readonly sessions = new Map<string, AgentSession>()

  constructor(o: NodeGovernanceOptions) {
    this.ownerKey = o.ownerKey
    this.network = o.network ?? 'regtest'
    this.sessionTtl = o.sessionTtlSeconds ?? 3600
    const key = gateKeyFor(o.ownerKey)
    this.gate = new PolicyGate({ key, ownerPk: o.ownerKey.pubkey, store: o.dir ? new FileGateStore(o.dir) : new MemoryGateStore(), log: o.dir ? new FileDecisionLog(o.dir, key) : new MemoryDecisionLog(key), sanctions: o.sanctions ?? undefined, now: o.now })
    if (!this.gate.policies().length) {
      const policy = (o.policy ?? demoDefaultPolicy)(key.pubkey, o.ownerKey.pubkey)
      try { this.gate.install(policy, [approvePolicy(o.ownerKey, policy)]) } catch (err) { if (!this.gate.policies().length) throw err }
    }
    // From here on this key signs transactions only with this gate's tokens.
    enrollSigner(keySignerId(o.ownerKey.pubkey), key.pubkey)
  }

  /** Put an RGB wallet under this gate (WDK policy included). */
  enrollWallet(wallet: Pick<RgbWallet, 'enroll'>): Promise<void> {
    return wallet.enroll(this.gate.pubkey)
  }

  /** A short-lived session for an agent, scoped to one loan or negotiation. Throws AgentStopped after the kill switch. */
  session(agentId: string, scopeId: Hex | null): AgentSession {
    const key = `${agentId}:${scopeId ?? '-'}`
    const cached = this.sessions.get(key)
    if (cached && cached.grant.expires_at - 60 > Math.floor(Date.now() / 1000) && !this.gate.agentStopped(agentId)) return cached
    const fresh = this.gate.openSession(agentId, { negotiation_id: scopeId, actions: ['lock', 'fund', 'repay', 'release', 'liquidate', 'fee-payment', 'iou-transfer'] }, this.sessionTtl)
    this.sessions.set(key, fresh)
    return fresh
  }

  /** Build and sign a gate request for these decoded transactions. */
  async request(txs: GateTx[], ctx: SignContext): Promise<GateRequest> {
    const loan = ctx.terms ? { id: termsHash(ctx.terms), terms: ctx.terms } : null
    const base = {
      v: 1 as const, domain: 'passbook-gate-request-v1' as const, action: ctx.action, network: this.network, txs, loan, counterparty: ctx.counterparty ?? null, screening: ctx.screening ?? null,
      approvals: typeof ctx.approvals === 'function' ? await ctx.approvals(txs) : (ctx.approvals ?? []), scorer: ctx.scorer ?? null, reason: ctx.reason, requested_at: Math.floor(Date.now() / 1000),
    }
    const i = ctx.initiator
    if ('agent' in i) {
      const session = this.session(i.agent, loan?.id ?? null)
      return signRequest(session, { ...base, initiator: { kind: 'agent' as const, agent_id: i.agent, session: session.grant } }) as GateRequest
    }
    if ('human' in i) return signWithKey(i.human, { ...base, initiator: { kind: 'human' as const, pk: i.human.pubkey } })
    return signWithKey(this.ownerKey, { ...base, initiator: { kind: 'service' as const, pk: this.ownerKey.pubkey, id: i.service } })
  }

  /** Dry run first, then the decision. Throws GateRefused (with the action id for `passbook why`) when refused. */
  async decide(txs: GateTx[], ctx: SignContext): Promise<GateDecision> {
    const req = await this.request(txs, ctx)
    const dry = await this.gate.dryRun(req)
    if (!dry.allowed) throw new GateRefused(dry)
    const decision = await this.gate.authorize(req)
    if (!decision.allowed) throw new GateRefused(decision)
    return decision
  }

  private async run<T>(txs: GateTx[], ctx: SignContext, sign: (tokens: GateToken[]) => T | Promise<T>, txids: (out: T) => string[]): Promise<T> {
    const decision = await this.decide(txs, ctx)
    try {
      const out = await sign(decision.tokens)
      this.gate.settle(decision.action_id, 'done', txids(out))
      return out
    } catch (err) {
      // a reservation is given back only if nothing was signed; a signature keeps it
      this.gate.settle(decision.action_id, 'not-signed')
      throw err
    }
  }

  /** Sign one escrow leaf through the gate. */
  signLeaf(psbt: bitcoin.Psbt, parties: EscrowParties, leaf: Leaf, secretKey: Uint8Array, ctx: SignContext): Promise<bitcoin.Psbt> {
    const signer = keySignerId(bytesToHex(publicOf(secretKey, this.ownerKey)))
    const tx: GateTx = { signer, kind: 'bitcoin-psbt', summary: psbtSummary(psbt, { parties, leaf }) }
    return this.run([tx], ctx, (tokens) => signLeaf(psbt, parties, leaf, secretKey, tokens[0]), () => [tx.summary.txid])
  }

  /** Sign the node's own key-path inputs through the gate. */
  signKeyPath(psbt: bitcoin.Psbt, secretKey: Uint8Array, ctx: SignContext): Promise<bitcoin.Psbt> {
    const signer = keySignerId(bytesToHex(publicOf(secretKey, this.ownerKey)))
    const tx: GateTx = { signer, kind: 'bitcoin-psbt', summary: psbtSummary(psbt) }
    return this.run([tx], ctx, (tokens) => signKeyPath(psbt, secretKey, tokens[0]), () => [tx.summary.txid])
  }

  /** Send over RGB through the gate. */
  sendRgb(wallet: Pick<RgbWallet, 'send' | 'transferSummary' | 'signerId'>, opts: { invoice: string; assetId: string; amount: number; feeRate?: number }, ctx: SignContext): Promise<{ txid: string; batchTransferIdx: number }> {
    const tx: GateTx = { signer: wallet.signerId, kind: 'rgb-transfer', summary: wallet.transferSummary(opts), ...(ctx.recipientOwner ? { recipient_owner: ctx.recipientOwner } : {}) }
    return this.run([tx], ctx, (tokens) => wallet.send({ ...opts, token: tokens[0] }), (out) => [out.txid])
  }

  /** Refuse if this agent was stopped (the kill switch): its next message never leaves. */
  assertActive(agentId: string): void {
    if (this.gate.agentStopped(agentId)) throw new AgentStopped(agentId, 'the kill switch froze it at this node\'s gate; message refused')
  }
}

function publicOf(secretKey: Uint8Array, owner: KeyPair): Uint8Array {
  // The node signs with its own party key; any other key is named by its own public key.
  if (bytesToHex(secretKey) === bytesToHex(owner.secretKey)) return hexToBytes(owner.pubkey)
  return hexToBytes(keyPairFromSecret(bytesToHex(secretKey)).pubkey)
}

function signWithKey<T extends object>(key: KeyPair, value: T): GateRequest {
  return signObject(value, key.secretKey) as unknown as GateRequest
}
