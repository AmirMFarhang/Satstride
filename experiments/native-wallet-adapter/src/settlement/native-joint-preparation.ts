// Local preparation/verification over the pinned native owner. No activation or
// fallback: orchestration and governed signing must finish before live registration.
import { canonicalJson, hashObject, sha256Hex, type Hex } from '../core/crypto.js'
import { NativeOperationJournal, nativeLoanSlot } from '../rgb/native-journal.js'
import type { NativeWalletPort } from '../rgb/native-port.js'
import { decodeJointTransaction } from './onchain-transaction-policy.js'
import { onchainDecodedSummaryHash, onchainLoanId, onchainProposalHash, validateOnchainIntent, validateOnchainProposal, type OnchainArtifact, type OnchainJointIntent, type OnchainJointProposal, type OnchainLoanTermsV3, type OnchainPreparedOperation, type OnchainPrevout } from './onchain-v3-contract.js'

export interface NativeJointChain {
  /** Independent actual Bitcoin records, not caller-supplied witness_utxo values. */
  prevouts(inputs: { txid: Hex; vout: number }[]): Promise<OnchainPrevout[]>
  assertUnspent(inputs: { txid: Hex; vout: number }[]): Promise<void>
}
export class NativeJointPreparation {
  readonly journal: NativeOperationJournal
  constructor(readonly walletId: Hex, private readonly owner: NativeWalletPort, private readonly chain: NativeJointChain) {
    this.journal = new NativeOperationJournal(owner)
  }
  async #identity(): Promise<void> {
    const identity=await this.owner.call<{ wallet_id: Hex }>('wallet_identity', {})
    if (identity.wallet_id !== this.walletId) throw new Error('JOINT_WRONG_LOCAL_WALLET')
  }
  async #importHistory(proposal: OnchainJointProposal): Promise<void> {
    // This first supported input policy has one complete source-history envelope.
    if (proposal.input_history.length !== 1) throw new Error('JOINT_ONE_COMPLETE_INPUT_HISTORY_REQUIRED')
    await this.owner.call('import_history_artifact', { sha256: proposal.input_history[0].sha256, asset: proposal.intent.asset, source: proposal.intent.rgb_input, amount: proposal.intent.amount })
  }
  async #artifacts(artifacts: OnchainArtifact[]): Promise<void> {
    for (const a of artifacts) {
      const bytes = await this.journal.read(a.sha256)
      if (bytes.length !== a.byte_length || sha256Hex(bytes) !== a.sha256) throw new Error('JOINT_ARTIFACT_BYTES_MISMATCH')
    }
  }
  async #persist(value: unknown): Promise<Hex> {
    const a = await this.journal.retain(new TextEncoder().encode(canonicalJson(value)))
    if (a.sha256 !== hashObject(value)) throw new Error('JOINT_CANONICAL_HASH_MISMATCH')
    return a.sha256
  }
  async #verify(proposal: OnchainJointProposal, requireUnspent: boolean): Promise<OnchainPreparedOperation> {
    validateOnchainProposal(proposal)
    await this.#identity()
    await this.#artifacts([...proposal.input_history, proposal.transfer_consignment])
    await this.#importHistory(proposal)
    const { terms, intent, colored_psbt_base64 } = proposal
    const inputs = [intent.rgb_input, ...intent.borrower_btc_inputs, ...(intent.action === 'repayment' ? [intent.collateral] : [])]
    const actual = await this.chain.prevouts(inputs)
    if (requireUnspent) await this.chain.assertUnspent(inputs)
    const summary = decodeJointTransaction(terms, intent, colored_psbt_base64, actual, this.walletId)
    await this.owner.call('verify_transfer', { psbt: colored_psbt_base64, asset_id: intent.asset.contract_id, schema_id: intent.asset.schema_id, precision: intent.asset.precision, source: intent.rgb_input, amount: intent.amount, vout: intent.rgb_output_vout })
    await this.owner.call('verify_consignment', { psbt: colored_psbt_base64, asset_id: intent.asset.contract_id, sha256: proposal.transfer_consignment.sha256 })
    // The receiver's own immutable artifacts are fsynced by native before this
    // method returns an operation eligible for its local signing gate.
    const proposalHash = await this.#persist(proposal)
    if (proposalHash !== onchainProposalHash(proposal)) throw new Error('JOINT_PROPOSAL_HASH_MISMATCH')
    const summaryHash = await this.#persist({ domain: 'passbook-wysiwys-v1', summary })
    if (summaryHash !== onchainDecodedSummaryHash(summary)) throw new Error('JOINT_SUMMARY_HASH_MISMATCH')
    const intentHash = hashObject({ domain: 'passbook-native-verified-intent/v1', wallet_id: this.walletId, proposal_hash: proposalHash })
    const operationId = hashObject({ domain: 'passbook-native-verified-operation/v1', wallet_id: this.walletId, intent_hash: intentHash })
    return { operation_id: operationId, intent_hash: intentHash, proposal_hash: proposalHash, proposal, unsigned_txid: summary.unsigned_txid, decoded_summary: summary, decoded_summary_hash: summaryHash }
  }
  /** Bitcoin/RGB semantics only. Confirmation/finality and the actual signed
   * close are separately checked by portable proof verification. Never a signing operation. */
  async verifyHistoricalProposal(proposal: OnchainJointProposal) {
    const verified=await this.#verify(proposal,false)
    return { historical: true as const, proposal_hash: verified.proposal_hash, unsigned_txid: verified.unsigned_txid, decoded_summary: verified.decoded_summary }
  }
  async verifyProposal(proposal: OnchainJointProposal): Promise<OnchainPreparedOperation> {
    validateOnchainProposal(proposal)
    const slot = nativeLoanSlot(this.walletId, onchainLoanId(proposal.terms), proposal.intent.action)
    // Same obligation/action cannot be rebound by a new RPC id or a different proposal.
    await this.journal.reserve(slot, { domain: 'passbook-joint-receiver/v1', proposal })
    return this.#verify(proposal, true)
  }
  async prepare(request: { terms: OnchainLoanTermsV3; intent: OnchainJointIntent; unsigned_psbt_base64: string; input_history: OnchainArtifact[]; recipient_id: string }): Promise<OnchainPreparedOperation & { native_operation_id: string; output_history: OnchainArtifact }> {
    const { terms, intent, unsigned_psbt_base64, input_history } = request
    validateOnchainIntent(intent, terms)
    await this.#identity()
    await this.#artifacts(input_history)
    const slot = nativeLoanSlot(this.walletId, onchainLoanId(terms), intent.action)
    await this.journal.reserve(slot, { domain: 'passbook-joint-sender/v1', ...request })
    const inputs = [intent.rgb_input, ...intent.borrower_btc_inputs, ...(intent.action === 'repayment' ? [intent.collateral] : [])]
    const actual = await this.chain.prevouts(inputs)
    decodeJointTransaction(terms, intent, unsigned_psbt_base64, actual, this.walletId, 'uncolored')
    await this.chain.assertUnspent(inputs)
    const colored = await this.journal.effect<{ operation_id: string; psbt: string; txid: Hex; consignment: OnchainArtifact; output_history: OnchainArtifact }>(slot, 'joint-color', request, () => this.owner.call('prepare_color', {
      psbt: unsigned_psbt_base64, recipient_id: request.recipient_id, asset_id: intent.asset.contract_id, schema_id: intent.asset.schema_id, precision: intent.asset.precision, source: intent.rgb_input, amount: intent.amount, vout: intent.rgb_output_vout,
      confirmations: intent.action === 'origination' ? terms.settlement.confirmations.funding : terms.settlement.confirmations.repayment,
    }))
    const proposal: OnchainJointProposal = { domain: 'passbook-rgb-joint-proposal/v1', terms, intent, colored_psbt_base64: colored.psbt, input_history, transfer_consignment: colored.consignment }
    const verified = await this.#verify(proposal, true)
    if (verified.unsigned_txid !== colored.txid) throw new Error('JOINT_NATIVE_TXID_MISMATCH')
    return { ...verified, native_operation_id: colored.operation_id, output_history: colored.output_history }
  }
}
