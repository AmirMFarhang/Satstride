// What both roles of a joint loan share: activation guard, native contexts with
// stable idempotency keys, the durable state, message replay, the gated
// sign-and-export step and settlement. The role files decide the order.
//
// Invariants kept here for both roles:
// - nothing runs unless the caller opts into isolated regtest acceptance (v3 is not live);
// - no fallback: a refusal is recorded and thrown, never retried on another rail;
// - every exported signature has a fresh authorization from the party's own gate,
//   bound to exactly that operation, and is journaled by the adapter before it leaves;
// - state is saved before any outgoing message is returned, and a message that was
//   already handled returns the same reply instead of acting twice.

import { hashObject, sha256Hex, type Hex, type KeyPair } from '../core/crypto.js'
import {
  ONCHAIN_CONTRACT, ONCHAIN_NATIVE_REVISION,
  type OnchainJointProposal, type OnchainNativeAdapter, type OnchainNativeContext, type OnchainOperationStatus,
  type OnchainPreparedOperation, type OnchainPrevout, type OnchainRepaymentEvidence, type OnchainVerificationResult,
} from './contract-stub.js'
import { jointMessageId, openJointMessage, sealJointMessage, type ArtifactBytes, type JointBody, type JointMessage } from './messages.js'
import {
  JointRefused, type BorrowerFunding, type JointAction, type JointAgreement, type JointArtifactSource, type JointLocal,
  type JointOptions, type JointPartySigner, type JointSigningGate, type JointSigningKind, type JointStore, type JointTxBuilder,
} from './ports.js'

export type JointPhase =
  | 'agreed'
  | 'origination:inputs-offered' // B
  | 'origination:proposed' // L prepared, B not yet answered
  | 'origination:enforcement-signed' // B verified the proposal and exported its default/liquidation signatures
  | 'origination:enforcement-recorded' // L holds B's complete enforcement set; only now may L sign funding
  | 'origination:signed' // L exported its funding signature
  | 'origination:broadcast' // B signed second and broadcast
  | 'origination:settled'
  | 'repayment:proposed' // B
  | 'repayment:verified' // L, before its signature
  | 'repayment:signed' // L exported its repayment signature
  | 'repayment:broadcast' // B
  | 'repayment:settled'
  | 'closed'

export interface JointState {
  v: 1
  role: JointLocal['role']
  loan_id: Hex
  phase: JointPhase
  funding?: BorrowerFunding
  origination?: OnchainPreparedOperation
  origination_txid?: Hex
  repayment?: OnchainPreparedOperation
  repayment_txid?: Hex
  /** operation id → last status the adapter returned */
  statuses: Record<string, OnchainOperationStatus>
  /** incoming message id → the replies already sent for it */
  handled: Record<Hex, JointMessage[]>
  /** locally initiated steps → the message already sent */
  sent: Record<string, JointMessage>
  /** hash of the borrower's enforcement set the lender recorded (a retry must carry the same set) */
  enforcement_hash?: Hex
  counterparty_broadcast?: Partial<Record<JointAction, Hex>>
  evidence?: OnchainRepaymentEvidence
  verification?: OnchainVerificationResult
  refusals: { code: string; phase: JointPhase; at: number }[]
}

export interface JointPartyDeps {
  key: KeyPair
  agreement: JointAgreement
  local: JointLocal
  adapter: OnchainNativeAdapter
  gate: JointSigningGate
  signer: JointPartySigner
  artifacts: JointArtifactSource
  builder: JointTxBuilder
  store: JointStore
  options: JointOptions
}

/** Origination output 1 is the collateral C (#56 fixed layout). */
export const COLLATERAL_VOUT = 1

export abstract class JointParty {
  protected state: JointState
  readonly #storeKey: string
  #ready = false

  constructor(protected readonly deps: JointPartyDeps) {
    const { agreement, local, key, options } = deps
    if (options?.activation !== 'isolated-regtest-acceptance') throw new JointRefused('JOINT_V3_NOT_LIVE', 'v3 joint settlement is not activated; only an isolated regtest acceptance may run it')
    const s = agreement.terms.settlement
    if (s.kind !== 'rgb-onchain-joint' || s.protocol !== ONCHAIN_CONTRACT || s.native_revision !== ONCHAIN_NATIVE_REVISION) throw new JointRefused('JOINT_WRONG_SETTLEMENT', 'pinned KaleidoSwap joint protocol required')
    if (s.network.chain !== 'regtest') throw new JointRefused('JOINT_WRONG_NETWORK', 'regtest only')
    const own = local.role === 'borrower' ? agreement.terms.borrower_pk : agreement.terms.lender_pk
    if (key.pubkey !== own) throw new JointRefused('JOINT_WRONG_PARTY', `this key is not the ${local.role} of these terms`)
    this.#storeKey = `${local.role}-${agreement.loan_id}`
    const saved = deps.store.load(this.#storeKey) as JointState | undefined
    if (saved && (saved.loan_id !== agreement.loan_id || saved.role !== local.role)) throw new JointRefused('JOINT_STORE_MISMATCH')
    this.state = saved ?? { v: 1, role: local.role, loan_id: agreement.loan_id, phase: 'agreed', statuses: {}, handled: {}, sent: {}, refusals: [] }
  }

  /** Refuses a native engine that is not the pinned fork on regtest. Call once before any step. */
  async open(): Promise<this> {
    const cap = await this.deps.adapter.capabilities()
    if (cap.protocol !== ONCHAIN_CONTRACT || cap.native_revision !== ONCHAIN_NATIVE_REVISION || cap.chain !== 'regtest') throw new JointRefused('JOINT_NATIVE_MISMATCH', 'native engine is not the pinned KaleidoSwap fork on regtest')
    this.#ready = true
    return this
  }

  get phase(): JointPhase { return this.state.phase }
  get snapshot(): JointState { return structuredClone(this.state) }

  protected get counterpartyPk(): Hex {
    const t = this.deps.agreement.terms
    return this.deps.local.role === 'borrower' ? t.lender_pk : t.borrower_pk
  }

  protected now(): number { return this.deps.options.now?.() ?? Math.floor(Date.now() / 1000) }

  /** Stable per loan, role and step: a retry after a crash reaches the same native operation. */
  protected context(step: string): OnchainNativeContext {
    const { agreement, local } = this.deps
    const idempotency_key = hashObject({ domain: 'passbook-joint-step/v1', loan_id: agreement.loan_id, role: local.role, step })
    return { request_id: idempotency_key, idempotency_key, wallet_id: local.wallet_id, network: agreement.terms.settlement.network, obligation_id: agreement.loan_id }
  }

  protected save(): void { this.deps.store.save(this.#storeKey, this.state) }

  protected expectPhase(...phases: JointPhase[]): void {
    if (!this.#ready) throw new JointRefused('JOINT_NOT_OPEN', 'call open() first')
    if (!phases.includes(this.state.phase)) throw new JointRefused('JOINT_OUT_OF_ORDER', `${this.state.phase}, expected ${phases.join(' or ')}`)
  }

  protected seal(body: JointBody): JointMessage {
    return sealJointMessage(this.deps.key, this.deps.agreement.loan_id, this.counterpartyPk, body)
  }

  /** A locally initiated step: the same message again if it already ran. */
  protected async initiate(step: string, run: () => Promise<JointMessage>): Promise<JointMessage> {
    const done = this.state.sent[step]
    if (done) return done
    const message = await this.guard(run)
    this.state.sent[step] = message
    this.save()
    return message
  }

  /** Handles one message from the counterparty; returns the replies to send. */
  async receive(raw: unknown): Promise<JointMessage[]> {
    const { agreement, key } = this.deps
    const message = openJointMessage(raw, { loan_id: agreement.loan_id, from: this.counterpartyPk, to: key.pubkey })
    const id = jointMessageId(message)
    const done = this.state.handled[id]
    if (done) return done
    const replies = await this.guard(() => this.handle(message))
    this.state.handled[id] = replies
    this.save()
    return replies
  }

  protected abstract handle(message: JointMessage): Promise<JointMessage[]>

  /** Records a refusal (no fallback, no retry on another rail) and rethrows it. */
  protected async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (e) {
      const code = e instanceof JointRefused ? e.code : 'JOINT_NATIVE_ERROR'
      this.state.refusals.push({ code, phase: this.state.phase, at: this.now() })
      this.save()
      throw e
    }
  }

  protected noteBroadcast(action: JointAction, txid: Hex, op: OnchainPreparedOperation | undefined): JointMessage[] {
    if (!op || txid !== op.unsigned_txid) throw new JointRefused('JOINT_WRONG_TXID', `counterparty broadcast ${txid}`)
    this.state.counterparty_broadcast = { ...this.state.counterparty_broadcast, [action]: txid }
    return []
  }

  /** The receiver holds every byte the proposal references, checked against its digest, before it verifies or signs. */
  protected async importArtifacts(step: string, proposal: OnchainJointProposal, supplied: ArtifactBytes[]): Promise<void> {
    const needed = [...proposal.input_history, proposal.transfer_consignment]
    const byDigest = new Map(supplied.map(a => [a.artifact.sha256, a]))
    if (byDigest.size !== supplied.length || needed.length !== new Set(needed.map(a => a.sha256)).size) throw new JointRefused('JOINT_ARTIFACTS', 'duplicate artifact')
    if (supplied.length !== needed.length) throw new JointRefused('JOINT_ARTIFACTS', `${supplied.length} supplied, ${needed.length} referenced`)
    const context = this.context(`${step}:artifacts`)
    for (const a of needed) {
      const got = byDigest.get(a.sha256)
      if (!got) throw new JointRefused('JOINT_ARTIFACTS', `missing ${a.sha256}`)
      const bytes = Buffer.from(got.bytes_base64, 'base64')
      if (bytes.length !== a.byte_length || got.artifact.byte_length !== a.byte_length || sha256Hex(bytes) !== a.sha256) throw new JointRefused('JOINT_ARTIFACT_BYTES', a.sha256)
      await this.deps.adapter.importArtifact(context, a, got.bytes_base64)
    }
  }

  /** The bytes the counterparty needs before it can verify and sign this proposal. */
  protected async exportArtifacts(step: string, proposal: OnchainJointProposal): Promise<ArtifactBytes[]> {
    const context = this.context(`${step}:artifacts`)
    const out: ArtifactBytes[] = []
    for (const artifact of [...proposal.input_history, proposal.transfer_consignment]) out.push({ artifact, bytes_base64: await this.deps.artifacts.read(context, artifact) })
    return out
  }

  /** Gate authorization for exactly this operation, the party's own signatures, then the adapter journals the export. */
  protected async signAndExport(step: string, kind: JointSigningKind, op: { operation_id: string; intent_hash: Hex; decoded_summary: OnchainPreparedOperation['decoded_summary']; decoded_summary_hash: Hex }, proposalHash: Hex, psbt: string): Promise<{ signed: string; status: OnchainOperationStatus }> {
    const { agreement, local, gate, signer, adapter } = this.deps
    const auth = await gate.authorize({ role: local.role, kind, loan_id: agreement.loan_id, terms: agreement.terms, operation_id: op.operation_id, intent_hash: op.intent_hash, proposal_hash: proposalHash, decoded_summary: op.decoded_summary, decoded_summary_hash: op.decoded_summary_hash })
    const now = this.now()
    if (auth.domain !== 'passbook-onchain-signing-authorization/v1' || auth.operation_id !== op.operation_id || auth.intent_hash !== op.intent_hash || auth.proposal_hash !== proposalHash || auth.decoded_summary_hash !== op.decoded_summary_hash) throw new JointRefused('JOINT_AUTHORIZATION_MISMATCH', `${kind}: authorization is for another operation`)
    if (!(auth.issued_at <= now && now < auth.expires_at)) throw new JointRefused('JOINT_AUTHORIZATION_EXPIRED', kind)
    const context = this.context(step)
    const signed = await signer.sign(context, { operation_id: op.operation_id, psbt_base64: psbt, authorization: auth })
    const status = await adapter.recordSignedExport(context, op.operation_id, signed, auth)
    if (status.operation_id !== op.operation_id || !status.signatures_exported) throw new JointRefused('JOINT_EXPORT_NOT_JOURNALED', kind)
    this.state.statuses[op.operation_id] = status
    return { signed, status }
  }

  /**
   * Reconciles one side of a broadcast step. Returns the status while confirmations
   * are short; applies once confirmed; the RGB receiver then takes the consignment
   * and must end settled. A conflict stops here (recovery is a separate step).
   */
  protected async settle(action: JointAction, receiver: boolean): Promise<OnchainOperationStatus> {
    const { adapter, agreement, local } = this.deps
    const op = action === 'origination' ? this.state.origination : this.state.repayment
    if (!op) throw new JointRefused('JOINT_OUT_OF_ORDER', `no ${action} operation`)
    const context = this.context(`${action}:settle`)
    let status = await adapter.reconcile(context, op.operation_id)
    this.state.statuses[op.operation_id] = status
    if (status.phase === 'conflicted') { this.save(); throw new JointRefused('JOINT_CONFLICTED', `${action} ${op.unsigned_txid} lost to ${status.replacement_txids.join(', ') || 'another spend'}`) }
    if (status.txid !== op.unsigned_txid) throw new JointRefused('JOINT_WRONG_TXID', `${action} reconciled ${status.txid}`)
    const need = action === 'origination' ? agreement.terms.settlement.confirmations.funding : agreement.terms.settlement.confirmations.repayment
    if (status.confirmations < need) { this.save(); return status }
    status = await adapter.apply(context, op.operation_id)
    if (receiver) status = await adapter.handoverReceive(context, op.operation_id, local.receive_id, op.proposal.transfer_consignment)
    const done = receiver ? ['settled'] : ['rgb-applied', 'settled']
    if (!done.includes(status.phase)) throw new JointRefused('JOINT_NOT_SETTLED', `${action}: ${status.phase}`)
    this.state.statuses[op.operation_id] = status
    if (action === 'origination') this.state.origination_txid = op.unsigned_txid
    else this.state.repayment_txid = op.unsigned_txid
    this.state.phase = `${action}:settled`
    this.save()
    return status
  }

  /** The funded collateral C, as both parties recorded it from the verified origination. */
  protected collateral(script: Hex): OnchainPrevout {
    if (!this.state.origination_txid) throw new JointRefused('JOINT_OUT_OF_ORDER', 'origination not settled')
    return { txid: this.state.origination_txid, vout: COLLATERAL_VOUT, value_sats: this.deps.agreement.terms.collateral_sats, script_pubkey: script }
  }

  /**
   * After both legs settle: the portable evidence (two transaction records), verified
   * natively against the chain and RGB histories. Nothing short of `ok` closes the loan.
   */
  async evidence(): Promise<{ evidence: OnchainRepaymentEvidence; verification: OnchainVerificationResult }> {
    if (this.state.phase === 'closed' && this.state.evidence && this.state.verification) return { evidence: this.state.evidence, verification: this.state.verification }
    this.expectPhase('repayment:settled')
    return this.guard(async () => {
      const o = this.state.origination!, r = this.state.repayment!
      if (o.proposal.intent.action !== 'origination' || r.proposal.intent.action !== 'repayment') throw new JointRefused('JOINT_WRONG_ACTION')
      const evidence: OnchainRepaymentEvidence = {
        domain: 'passbook-rgb-joint-evidence/v1',
        funding: { intent: o.proposal.intent, txid: this.state.origination_txid!, input_history: o.proposal.input_history, transfer_consignment: o.proposal.transfer_consignment },
        repayment: { intent: r.proposal.intent, txid: this.state.repayment_txid!, input_history: r.proposal.input_history, transfer_consignment: r.proposal.transfer_consignment },
      }
      const verification = await this.deps.adapter.verifyRepayment(this.context('verify-repayment'), this.deps.agreement.terms, evidence)
      if (!verification.ok) throw new JointRefused('JOINT_EVIDENCE_REFUSED', verification.code)
      this.state.evidence = evidence
      this.state.verification = verification
      this.state.phase = 'closed'
      this.save()
      return { evidence, verification }
    })
  }
}
