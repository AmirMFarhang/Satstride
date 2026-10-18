// In-memory stand-ins for the joint-loan ports, for orchestration tests only.
// The fake adapter is NOT a native proof: its "PSBT" is JSON carrying the
// summary it decodes to, and its chain is a map. It exists to drive both roles
// through #56's OnchainNativeAdapter shape, enforce the adapter-side rules the
// contract states (artifacts held before verification, complete enforcement
// before a lender's funding export, journaled exports, one operation per
// obligation and action) and let tests inject a dishonest counterparty.

import { canonicalJson, hashObject, keyPairFromLabel, sha256Hex, signHash, verifyHash, type Hex, type KeyPair } from '../src/core/crypto.js'
import {
  ONCHAIN_CONTRACT, ONCHAIN_NATIVE_REVISION, ONCHAIN_REGTEST_GENESIS,
  type OnchainArtifact, type OnchainDecodedSummary, type OnchainEnforcementPreparation, type OnchainJointIntent, type OnchainJointProposal,
  type OnchainLoanTermsV3, type OnchainNativeAdapter, type OnchainNativeContext, type OnchainNativePreparation, type OnchainOperationStatus,
  type OnchainPreparedOperation, type OnchainPrevout, type OnchainRepaymentEvidence, type OnchainSignedEnforcement, type OnchainSigningAuthorization, type OnchainVerificationResult,
} from '../src/joint/contract-stub.js'
import type { BorrowerFunding, JointAgreement, JointArtifactSource, JointPartySigner, JointRole, JointSigningGate, JointSigningRequest, JointTxBuilder } from '../src/joint/ports.js'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf8')
const p2tr = (label: string) => `5120${sha256Hex(label)}`
const fakeTxid = (v: unknown) => sha256Hex(`tx:${canonicalJson(v)}`)

interface FakePsbt { summary: OnchainDecodedSummary; sigs: JointRole[] }
export const encodePsbt = (p: FakePsbt) => b64(canonicalJson(p))
export const decodePsbt = (s: string) => JSON.parse(fromB64(s)) as FakePsbt

export const borrowerKey = keyPairFromLabel('joint-test-borrower')
export const lenderKey = keyPairFromLabel('joint-test-lender')
export const platformKey = keyPairFromLabel('joint-test-platform')
export const strangerKey = keyPairFromLabel('joint-test-stranger')

export const ASSET = { kind: 'NIA' as const, contract_id: 'rgb:test-usdt-fixture', schema_id: 'NIA-schema-fixture', precision: 6 }

export function jointTerms(): OnchainLoanTermsV3 {
  return {
    v: 3, borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, platform_pk: platformKey.pubkey,
    principal: '100000000', fee: '1000000', collateral_sats: '250000',
    oracle_quote: { price_cents: 6_000_000, height: 100, oracle_pk: platformKey.pubkey, sig: '00'.repeat(64) },
    open_height: 100, maturity_height: 130, grace_blocks: 10, recovery_height: 160,
    ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: sha256Hex('joint-test-nonce'),
    settlement: {
      kind: 'rgb-onchain-joint', protocol: ONCHAIN_CONTRACT, native_revision: ONCHAIN_NATIVE_REVISION,
      network: { chain: 'regtest', genesis_hash: ONCHAIN_REGTEST_GENESIS },
      collateral_template: 'joint-afd-terms/v1', internal_key: '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
      input_policy: 'single-nia-exact-amount/v1', asset: ASSET, debt: '101000000',
      destinations: { borrower_rgb_script_pubkey: p2tr('b-rgb'), lender_rgb_script_pubkey: p2tr('l-rgb'), borrower_btc_script_pubkey: p2tr('b-btc'), lender_btc_script_pubkey: p2tr('l-btc'), borrower_change_script_pubkey: p2tr('b-change') },
      bitcoin_policy: { fee_payer: 'borrower', collateral_return: 'full', rgb_output_sats: '1000', min_output_sats: '330', origination_fee_cap_sats: '3000', repayment_fee_cap_sats: '3000', enforcement_fee_cap_sats: '2000', recovery_fee_cap_sats: '2000' },
      confirmations: { funding: 1, repayment: 1 },
      default_payout: { lender_sats: '200000', borrower_sats: '49000', fee_sats: '1000' },
      liquidation: {
        policy: 'passbook-margin-70-80-85-cure10/v1', quote_max_age_blocks: 6,
        templates: [
          { id: 'liq-80', price_ceiling_cents: '4500000', lock_height: 110, lender_sats: '180000', borrower_sats: '69000', fee_sats: '1000' },
          { id: 'liq-85', price_ceiling_cents: '4200000', lock_height: 110, lender_sats: '249000', borrower_sats: '0', fee_sats: '1000' },
        ],
      },
    },
  }
}

export function agreementFor(terms = jointTerms()): JointAgreement {
  return { terms, loan_id: hashObject(terms), borrower_recipient_id: 'utxob:borrower-principal', lender_recipient_id: 'utxob:lender-debt' }
}

/** One shared chain: transactions spend outpoints; a block confirms the mempool. */
export class FakeChain {
  height = 100
  readonly txs = new Map<Hex, { inputs: string[]; height: number | null }>()
  readonly spentBy = new Map<string, Hex>()
  publish(txid: Hex, inputs: string[]): void {
    if (this.txs.has(txid)) return
    for (const i of inputs) { const other = this.spentBy.get(i); if (other && other !== txid) throw new Error(`FAKE_CHAIN_CONFLICT ${i}`) }
    this.txs.set(txid, { inputs, height: null })
    for (const i of inputs) this.spentBy.set(i, txid)
  }
  /** A competing spend of one input (e.g. a borrower double-spend) that wins. */
  conflict(outpoint: string): Hex {
    const loser = this.spentBy.get(outpoint)
    const txid = sha256Hex(`conflict:${outpoint}`)
    if (loser) for (const i of this.txs.get(loser)!.inputs) this.spentBy.delete(i)
    if (loser) this.txs.delete(loser)
    this.publish(txid, [outpoint])
    this.mine()
    return txid
  }
  mine(n = 1): void { for (let k = 0; k < n; k++) { this.height++; for (const t of this.txs.values()) if (t.height === null) t.height = this.height } }
}

interface FakeOp { op: OnchainPreparedOperation; obligationAction: string; key: string; intent: string; exported?: string; enforcement?: boolean; enforcementSet?: OnchainSignedEnforcement[]; phase: OnchainOperationStatus['phase']; role: 'sender' | 'receiver' }

export class FakeAdapter implements OnchainNativeAdapter {
  readonly calls: string[] = []
  readonly store = new Map<Hex, string>()
  readonly ops = new Map<string, FakeOp>()
  readonly enforcementOps = new Map<string, OnchainEnforcementPreparation>()
  readonly byKey = new Map<string, string>()
  readonly byObligation = new Map<string, string>()
  /** test hooks */
  revision: string = ONCHAIN_NATIVE_REVISION
  enforcementTamper?: (p: OnchainEnforcementPreparation) => OnchainEnforcementPreparation
  verifyResult?: OnchainVerificationResult
  /** turns off the adapter's own enforcement-before-export rule, to prove the orchestration enforces it too */
  permissive = false

  constructor(readonly role: JointRole, readonly walletId: string, readonly chain: FakeChain, readonly gatePk: Hex, readonly receiveId: string) {}

  #status(f: FakeOp): OnchainOperationStatus {
    const tx = this.chain.txs.get(f.op.unsigned_txid)
    return { operation_id: f.op.operation_id, intent_hash: f.op.intent_hash, txid: f.op.unsigned_txid, phase: f.phase, signatures_exported: !!f.exported, confirmations: tx?.height ? this.chain.height - tx.height + 1 : 0, replacement_txids: [] }
  }
  #op(id: string): FakeOp { const f = this.ops.get(id); if (!f) throw new Error('FAKE_UNKNOWN_OPERATION'); return f }
  #reserve(context: OnchainNativeContext, action: string, intent: unknown): string | null {
    const ih = hashObject(intent)
    const prior = this.byKey.get(context.idempotency_key)
    if (prior) { if (this.ops.get(prior)!.intent !== ih) throw new Error('IDEMPOTENCY_CONFLICT'); return prior }
    const live = this.byObligation.get(`${context.obligation_id}:${action}`)
    if (live) throw new Error('IDEMPOTENCY_CONFLICT: one live operation per obligation and action')
    return null
  }
  #register(context: OnchainNativeContext, action: string, intent: unknown, op: OnchainPreparedOperation, role: FakeOp['role']): OnchainPreparedOperation {
    this.ops.set(op.operation_id, { op, obligationAction: `${context.obligation_id}:${action}`, key: context.idempotency_key, intent: hashObject(intent), phase: 'prepared', role })
    this.byKey.set(context.idempotency_key, op.operation_id)
    this.byObligation.set(`${context.obligation_id}:${action}`, op.operation_id)
    return op
  }

  async capabilities() { this.calls.push('capabilities'); return { protocol: ONCHAIN_CONTRACT, native_revision: this.revision as typeof ONCHAIN_NATIVE_REVISION, chain: 'regtest' as const, live_v3: false as const } }
  async importArtifact(_c: OnchainNativeContext, a: OnchainArtifact, bytes: string) {
    this.calls.push('importArtifact')
    const raw = Buffer.from(bytes, 'base64')
    if (raw.length !== a.byte_length || sha256Hex(raw) !== a.sha256) throw new Error('FAKE_ARTIFACT_DIGEST')
    this.store.set(a.sha256, bytes)
  }
  async createReceive(): Promise<never> { throw new Error('not used') }
  async inspectCollateral(terms: OnchainLoanTermsV3) {
    this.calls.push('inspectCollateral')
    const leaf = { script: '51', control_block: 'c0' + '00'.repeat(32) }
    return { script_pubkey: collateralScript(terms), leaves: { A: leaf, F: leaf, D: leaf } }
  }
  async prepare(request: OnchainNativePreparation): Promise<OnchainPreparedOperation> {
    this.calls.push('prepare')
    const { context, terms, intent } = request
    const prior = this.#reserve(context, intent.action, request)
    if (prior) return this.ops.get(prior)!.op
    for (const h of request.input_history) if (!this.store.has(h.sha256)) throw new Error('FAKE_MISSING_INPUT_HISTORY')
    const unsigned = decodePsbt(request.unsigned_psbt_base64).summary
    const consignment = b64(`consignment:${unsigned.unsigned_txid}`)
    const transfer: OnchainArtifact = { sha256: sha256Hex(Buffer.from(consignment, 'base64')), byte_length: Buffer.from(consignment, 'base64').length }
    this.store.set(transfer.sha256, consignment)
    const proposal: OnchainJointProposal = { domain: 'passbook-rgb-joint-proposal/v1', terms, intent, colored_psbt_base64: encodePsbt({ summary: unsigned, sigs: [] }), input_history: request.input_history, transfer_consignment: transfer }
    return this.#register(context, intent.action, request, prepared(this.walletId, proposal, unsigned), 'sender')
  }
  async verifyProposal(context: OnchainNativeContext, proposal: OnchainJointProposal): Promise<OnchainPreparedOperation> {
    this.calls.push('verifyProposal')
    const prior = this.#reserve(context, proposal.intent.action, proposal)
    if (prior) return this.ops.get(prior)!.op
    for (const a of [...proposal.input_history, proposal.transfer_consignment]) if (!this.store.has(a.sha256)) throw new Error('FAKE_PROOF_NOT_HELD')
    return this.#register(context, proposal.intent.action, proposal, prepared(this.walletId, proposal, decodePsbt(proposal.colored_psbt_base64).summary), 'receiver')
  }
  async prepareEnforcement(_c: OnchainNativeContext, originationId: string): Promise<OnchainEnforcementPreparation[]> {
    this.calls.push('prepareEnforcement')
    const parent = this.#op(originationId).op
    const terms = parent.proposal.terms
    const kinds = [{ kind: 'default' as const, template_id: null, payout: terms.settlement.default_payout, lock: terms.maturity_height + terms.grace_blocks }, ...terms.settlement.liquidation.templates.map(t => ({ kind: 'liquidation' as const, template_id: t.id, payout: t, lock: t.lock_height }))]
    return kinds.map(k => {
      const d = terms.settlement.destinations
      const outputs = [{ vout: 0, value_sats: k.payout.lender_sats, script_pubkey: d.lender_btc_script_pubkey, allocations: [] }]
      if (BigInt(k.payout.borrower_sats)) outputs.push({ vout: 1, value_sats: k.payout.borrower_sats, script_pubkey: d.borrower_btc_script_pubkey, allocations: [] })
      const summary: OnchainDecodedSummary = { kind: 'rgb-onchain-joint', action: k.kind, wallet_id: this.walletId, network: terms.settlement.network, obligation_id: parent.decoded_summary.obligation_id, inputs: [{ outpoint: { txid: parent.unsigned_txid, vout: 1 }, value_sats: terms.collateral_sats, script_pubkey: collateralScript(terms), sequence: 0xfffffffe, sighash: 'DEFAULT' }], outputs, transaction_version: 2, locktime: k.lock, fee_sats: k.payout.fee_sats, unsigned_txid: '' }
      summary.unsigned_txid = fakeTxid(summary)
      let prep: OnchainEnforcementPreparation = { parent_proposal_hash: parent.proposal_hash, kind: k.kind, template_id: k.template_id, unsigned_psbt_base64: encodePsbt({ summary, sigs: [] }), operation_id: `enf-${summary.unsigned_txid.slice(0, 16)}`, intent_hash: hashObject({ e: summary }), decoded_summary: summary, decoded_summary_hash: hashObject({ domain: 'passbook-wysiwys-v1', summary }) }
      if (this.enforcementTamper) prep = this.enforcementTamper(prep)
      this.enforcementOps.set(prep.operation_id, prep)
      return prep
    })
  }
  async recordEnforcement(_c: OnchainNativeContext, originationId: string, spends: OnchainSignedEnforcement[]) {
    this.calls.push('recordEnforcement')
    const f = this.#op(originationId)
    for (const s of spends) if (!decodePsbt(s.signed_psbt_base64).sigs.includes('borrower')) throw new Error('FAKE_ENFORCEMENT_UNSIGNED')
    f.enforcement = true; f.enforcementSet = spends
  }
  async recordSignedExport(_c: OnchainNativeContext, operationId: string, signed: string, auth: OnchainSigningAuthorization) {
    this.calls.push(`recordSignedExport:${operationId.startsWith('enf-') ? 'enforcement' : this.#op(operationId).op.proposal.intent.action}`)
    const { signature, ...unsigned } = auth
    if (!verifyHash(signature, hashObject(unsigned), this.gatePk) || auth.operation_id !== operationId) throw new Error('FAKE_GATE_REFUSED')
    if (operationId.startsWith('enf-')) return { operation_id: operationId, intent_hash: auth.intent_hash, txid: this.enforcementOps.get(operationId)!.decoded_summary.unsigned_txid, phase: 'signed-exported' as const, signatures_exported: true, confirmations: 0, replacement_txids: [] }
    const f = this.#op(operationId)
    if (!this.permissive && this.role === 'lender' && f.op.proposal.intent.action === 'origination' && !f.enforcement) throw new Error('FAKE_ENFORCEMENT_REQUIRED')
    f.exported = signed; f.phase = 'signed-exported'
    return this.#status(f)
  }
  async broadcast(_c: OnchainNativeContext, operationId: string) {
    this.calls.push('broadcast')
    const f = this.#op(operationId)
    const p = decodePsbt(f.exported!)
    if (!p.sigs.includes('borrower') || !p.sigs.includes('lender')) throw new Error('FAKE_INCOMPLETE_SIGNATURES')
    this.chain.publish(f.op.unsigned_txid, p.summary.inputs.map(i => `${i.outpoint.txid}:${i.outpoint.vout}`))
    f.phase = 'broadcast-attempted'
    return this.#status(f)
  }
  async reconcile(_c: OnchainNativeContext, operationId: string) {
    this.calls.push('reconcile')
    const f = this.#op(operationId)
    const tx = this.chain.txs.get(f.op.unsigned_txid)
    if (!tx) {
      const lost = f.op.decoded_summary.inputs.map(i => this.chain.spentBy.get(`${i.outpoint.txid}:${i.outpoint.vout}`)).filter((t): t is Hex => !!t)
      if (lost.length) { f.phase = 'conflicted'; return { ...this.#status(f), replacement_txids: lost } }
      return this.#status(f)
    }
    if (tx.height !== null && f.phase !== 'rgb-applied' && f.phase !== 'settled') f.phase = 'confirmed'
    return this.#status(f)
  }
  async apply(_c: OnchainNativeContext, operationId: string) {
    this.calls.push('apply')
    const f = this.#op(operationId)
    if (f.phase !== 'confirmed' && f.phase !== 'rgb-applied' && f.phase !== 'settled') throw new Error('FAKE_NOT_CONFIRMED')
    if (f.phase === 'confirmed') f.phase = 'rgb-applied'
    return this.#status(f)
  }
  async handoverReceive(_c: OnchainNativeContext, operationId: string, receiveId: string, artifact: OnchainArtifact) {
    this.calls.push('handoverReceive')
    const f = this.#op(operationId)
    if (receiveId !== this.receiveId || !this.store.has(artifact.sha256) || f.role !== 'receiver') throw new Error('FAKE_RECEIVE_REFUSED')
    f.phase = 'settled'
    return this.#status(f)
  }
  async abortBeforeExport(): Promise<never> { throw new Error('not used') }
  async verifyRepayment(_c: OnchainNativeContext, _terms: OnchainLoanTermsV3, evidence: OnchainRepaymentEvidence): Promise<OnchainVerificationResult> {
    this.calls.push('verifyRepayment')
    if (this.verifyResult) return this.verifyResult
    const f = this.chain.txs.get(evidence.funding.txid), r = this.chain.txs.get(evidence.repayment.txid)
    if (!f?.height || !r?.height) return { ok: false, code: 'NOT_CONFIRMED' }
    if (!r.inputs.includes(`${evidence.funding.txid}:1`)) return { ok: false, code: 'REPAYMENT_DOES_NOT_SPEND_C' }
    return { ok: true, assurance: 'native-rgb-joint', funding_height: f.height, repayment_height: r.height, evidence_hash: hashObject(evidence) }
  }
  async close() {}
}

function prepared(walletId: string, proposal: OnchainJointProposal, summary: OnchainDecodedSummary): OnchainPreparedOperation {
  const s = { ...summary, wallet_id: walletId }
  const proposal_hash = hashObject(proposal)
  return { operation_id: `op-${walletId}-${proposal_hash.slice(0, 16)}`, intent_hash: hashObject({ walletId, proposal_hash }), proposal_hash, proposal, unsigned_txid: summary.unsigned_txid, decoded_summary: s, decoded_summary_hash: hashObject({ domain: 'passbook-wysiwys-v1', summary: s }) }
}

export const collateralScript = (terms: OnchainLoanTermsV3) => `5120${hashObject({ fake_collateral: terms })}`

/** The party's gate: signs #56's authorization for exactly the operation asked, unless stopped. */
export class FakeGate implements JointSigningGate {
  readonly key: KeyPair
  stopped = false
  readonly requests: JointSigningRequest[] = []
  tamper?: (a: Omit<OnchainSigningAuthorization, 'signature'>) => Omit<OnchainSigningAuthorization, 'signature'>
  constructor(label: string, private readonly now: () => number) { this.key = keyPairFromLabel(`joint-gate-${label}`) }
  async authorize(r: JointSigningRequest): Promise<OnchainSigningAuthorization> {
    this.requests.push(r)
    if (this.stopped) throw new Error('GATE_KILL_SWITCH: agent stopped')
    let a: Omit<OnchainSigningAuthorization, 'signature'> = { domain: 'passbook-onchain-signing-authorization/v1', decision_id: `d-${r.operation_id}`, policy_version: 1, intent_hash: r.intent_hash, proposal_hash: r.proposal_hash, decoded_summary_hash: r.decoded_summary_hash, operation_id: r.operation_id, issued_at: this.now(), expires_at: this.now() + 300 }
    if (this.tamper) a = this.tamper(a)
    return { ...a, signature: signHash(hashObject(a), this.key.secretKey) }
  }
}

export class FakeSigner implements JointPartySigner {
  readonly signed: string[] = []
  constructor(readonly role: JointRole) {}
  async sign(_c: OnchainNativeContext, r: { operation_id: string; psbt_base64: string; authorization: OnchainSigningAuthorization }) {
    if (r.authorization.operation_id !== r.operation_id) throw new Error('FAKE_SIGNER_WRONG_AUTHORIZATION')
    const p = decodePsbt(r.psbt_base64)
    this.signed.push(r.operation_id)
    return encodePsbt({ ...p, sigs: [...new Set([...p.sigs, this.role])] })
  }
}

export class FakeArtifacts implements JointArtifactSource {
  constructor(private readonly adapter: FakeAdapter) {}
  async read(_c: OnchainNativeContext, a: OnchainArtifact) {
    const v = this.adapter.store.get(a.sha256)
    if (!v) throw new Error('FAKE_ARTIFACT_MISSING')
    return v
  }
}

export interface BuilderTamper { origination?: (s: OnchainDecodedSummary, i: OnchainJointIntent) => void; repayment?: (s: OnchainDecodedSummary, i: OnchainJointIntent) => void; recipient?: string }

/** Builds #56's exact layouts from the agreement; tests may tamper with the result. */
export class FakeBuilder implements JointTxBuilder {
  tamper: BuilderTamper = {}
  /** extra history bytes, to push a proposal past one relay event */
  padding = 0
  constructor(private readonly adapter: FakeAdapter, private readonly role: JointRole) {}
  #history(label: string, amount: string): OnchainArtifact {
    const bytes = b64(`history:${label}:${amount}:${'x'.repeat(this.padding)}`)
    const a = { sha256: sha256Hex(Buffer.from(bytes, 'base64')), byte_length: Buffer.from(bytes, 'base64').length }
    this.adapter.store.set(a.sha256, bytes)
    return a
  }
  async origination(agreement: JointAgreement, funding: BorrowerFunding) {
    if (this.role !== 'lender') throw new Error('lender builds origination')
    const { terms } = agreement, d = terms.settlement.destinations, bp = terms.settlement.bitcoin_policy
    const rgb_input: OnchainPrevout = { txid: sha256Hex('lender-principal-utxo'), vout: 0, value_sats: '1000', script_pubkey: p2tr('lender-rgb-utxo') }
    const btcIn = funding.borrower_btc_inputs.reduce((n, i) => n + BigInt(i.value_sats), 0n)
    const changeSats = btcIn - BigInt(terms.collateral_sats) - BigInt(bp.rgb_output_sats) - BigInt(funding.fee_sats)
    const intent: OnchainJointIntent = { domain: 'passbook-rgb-joint-intent/v1', action: 'origination', loan_id: agreement.loan_id, network: terms.settlement.network, asset: terms.settlement.asset, amount: terms.principal, rgb_input, borrower_btc_inputs: funding.borrower_btc_inputs, rgb_output_vout: 2, collateral_output_vout: 1, lender_btc_return_vout: 3, borrower_change_vout: 4 }
    const summary: OnchainDecodedSummary = {
      kind: 'rgb-onchain-joint', action: 'origination', wallet_id: 'unsigned', network: terms.settlement.network, obligation_id: agreement.loan_id,
      inputs: [rgb_input, ...funding.borrower_btc_inputs].map(i => ({ outpoint: { txid: i.txid, vout: i.vout }, value_sats: i.value_sats, script_pubkey: i.script_pubkey, sequence: 0xfffffffd, sighash: 'DEFAULT' as const })),
      outputs: [
        { vout: 0, value_sats: '0', script_pubkey: '6a20' + '11'.repeat(32), allocations: [] },
        { vout: 1, value_sats: terms.collateral_sats, script_pubkey: collateralScript(terms), allocations: [] },
        { vout: 2, value_sats: bp.rgb_output_sats, script_pubkey: d.borrower_rgb_script_pubkey, allocations: [{ asset: terms.settlement.asset, amount: terms.principal }] },
        { vout: 3, value_sats: rgb_input.value_sats, script_pubkey: d.lender_btc_script_pubkey, allocations: [] },
        { vout: 4, value_sats: changeSats.toString(), script_pubkey: d.borrower_change_script_pubkey, allocations: [] },
      ],
      transaction_version: 2, locktime: 0, fee_sats: funding.fee_sats, unsigned_txid: '',
    }
    this.tamper.origination?.(summary, intent)
    summary.unsigned_txid = fakeTxid({ inputs: summary.inputs, outputs: summary.outputs })
    return { terms, intent, intent_hash: hashObject(intent), unsigned_psbt_base64: encodePsbt({ summary, sigs: [] }), input_history: [this.#history('lender-principal', terms.principal)], recipient_id: this.tamper.recipient ?? agreement.borrower_recipient_id }
  }
  async repayment(agreement: JointAgreement, collateral: OnchainPrevout) {
    if (this.role !== 'borrower') throw new Error('borrower builds repayment')
    const { terms } = agreement, d = terms.settlement.destinations, bp = terms.settlement.bitcoin_policy
    const rgb_input: OnchainPrevout = { txid: sha256Hex('borrower-debt-utxo'), vout: 0, value_sats: '1000', script_pubkey: p2tr('borrower-rgb-utxo') }
    const fee: OnchainPrevout = { txid: sha256Hex('borrower-fee-utxo'), vout: 1, value_sats: '5000', script_pubkey: p2tr('borrower-fee') }
    const intent: OnchainJointIntent = { domain: 'passbook-rgb-joint-intent/v1', action: 'repayment', loan_id: agreement.loan_id, network: terms.settlement.network, asset: terms.settlement.asset, amount: terms.settlement.debt, rgb_input, borrower_btc_inputs: [fee], collateral, rgb_output_vout: 1, collateral_return_vout: 2, borrower_change_vout: 3 }
    const feeSats = 1500n
    const summary: OnchainDecodedSummary = {
      kind: 'rgb-onchain-joint', action: 'repayment', wallet_id: 'unsigned', network: terms.settlement.network, obligation_id: agreement.loan_id,
      inputs: [rgb_input, fee, collateral].map(i => ({ outpoint: { txid: i.txid, vout: i.vout }, value_sats: i.value_sats, script_pubkey: i.script_pubkey, sequence: 0xfffffffd, sighash: 'DEFAULT' as const })),
      outputs: [
        { vout: 0, value_sats: '0', script_pubkey: '6a20' + '22'.repeat(32), allocations: [] },
        { vout: 1, value_sats: bp.rgb_output_sats, script_pubkey: d.lender_rgb_script_pubkey, allocations: [{ asset: terms.settlement.asset, amount: terms.settlement.debt }] },
        { vout: 2, value_sats: terms.collateral_sats, script_pubkey: d.borrower_btc_script_pubkey, allocations: [] },
        { vout: 3, value_sats: (1000n + 5000n - BigInt(bp.rgb_output_sats) - feeSats).toString(), script_pubkey: d.borrower_change_script_pubkey, allocations: [] },
      ],
      transaction_version: 2, locktime: 0, fee_sats: feeSats.toString(), unsigned_txid: '',
    }
    this.tamper.repayment?.(summary, intent)
    summary.unsigned_txid = fakeTxid({ inputs: summary.inputs, outputs: summary.outputs })
    // The borrower's input history for the principal it received at origination.
    return { terms, intent, intent_hash: hashObject(intent), unsigned_psbt_base64: encodePsbt({ summary, sigs: [] }), input_history: [this.#history('borrower-debt', terms.settlement.debt)], recipient_id: this.tamper.recipient ?? agreement.lender_recipient_id }
  }
}

export const borrowerFunding = (): BorrowerFunding => ({ borrower_btc_inputs: [{ txid: sha256Hex('borrower-btc-utxo'), vout: 0, value_sats: '300000', script_pubkey: p2tr('borrower-btc-utxo') }], fee_sats: '2000' })
