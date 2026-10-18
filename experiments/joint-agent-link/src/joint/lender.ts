// The lender's side of a v3 joint loan (#56, rgb-onchain-joint).
//
// Origination: build and color the joint transaction from the borrower's inputs
// and the lender's exact-principal RGB input → send it with every proof byte →
// record the borrower's complete, natively verified enforcement set → only then
// sign first → settle. Repayment: hold the debt proof bytes and verify the
// borrower's proposal (exact debt to the lender, this loan's collateral back in
// full) → sign first → settle, taking the debt consignment as the RGB receiver.

import { hashObject } from '../core/crypto.js'
import type { JointMessage } from './messages.js'
import type { OnchainJointProposal, OnchainOperationStatus, OnchainSignedEnforcement } from './contract-stub.js'
import { checkEnforcementSet, checkOriginationSummary, checkProposalBinding, checkRepaymentSummary } from './checks.js'
import { JointRefused, type BorrowerFunding } from './ports.js'
import { JointParty, type JointPartyDeps } from './session.js'
import type { ArtifactBytes } from './messages.js'

export class JointLender extends JointParty {
  constructor(deps: JointPartyDeps) {
    if (deps.local.role !== 'lender') throw new JointRefused('JOINT_WRONG_PARTY', 'lender role required')
    super(deps)
  }

  protected async handle(m: JointMessage): Promise<JointMessage[]> {
    const b = m.body
    if (b.type === 'funding-inputs') return [await this.#onFundingInputs({ borrower_btc_inputs: b.borrower_btc_inputs, fee_sats: b.fee_sats })]
    if (b.type === 'enforcement') return [await this.#onEnforcement(b.parent_proposal_hash, b.spends)]
    if (b.type === 'proposal') return [await this.#onRepaymentProposal(b.proposal, b.artifacts)]
    if (b.type === 'broadcast') return this.noteBroadcast(b.action, b.txid, b.action === 'origination' ? this.state.origination : this.state.repayment)
    throw new JointRefused('JOINT_UNEXPECTED_MESSAGE', `${b.type} is not for the lender`)
  }

  async #onFundingInputs(funding: BorrowerFunding): Promise<JointMessage> {
    this.expectPhase('agreed')
    const { agreement, adapter, builder } = this.deps
    const cap = BigInt(agreement.terms.settlement.bitcoin_policy.origination_fee_cap_sats)
    if (BigInt(funding.fee_sats) <= 0n || BigInt(funding.fee_sats) > cap) throw new JointRefused('JOINT_FEE_CAP', `borrower fee ${funding.fee_sats} sats, cap ${cap}`)
    this.state.funding = structuredClone(funding)
    const prep = await builder.origination(agreement, funding)
    if (prep.recipient_id !== agreement.borrower_recipient_id) throw new JointRefused('JOINT_WRONG_DESTINATION', 'principal must go to the borrower\'s agreed receive')
    const op = await adapter.prepare({ context: this.context('origination:prepare'), ...prep })
    // The lender's own check of the transaction it is about to propose and later sign.
    const collateral = await adapter.inspectCollateral(agreement.terms)
    checkProposalBinding(agreement, op.proposal, 'origination')
    checkOriginationSummary(agreement, op.proposal, op.decoded_summary, collateral.script_pubkey, funding)
    this.state.origination = op
    this.state.phase = 'origination:proposed'
    this.save()
    return this.seal({ type: 'proposal', proposal: op.proposal, artifacts: await this.exportArtifacts('origination', op.proposal) })
  }

  /**
   * The borrower's signed default and liquidation spends of the future collateral are
   * checked by native and journaled BEFORE the lender's first funding signature exists.
   * Without them an unfunded lender could not seize collateral, but a funded one could
   * not enforce: the lender never signs funding without the full set.
   */
  async #onEnforcement(parentProposalHash: string, spends: OnchainSignedEnforcement[]): Promise<JointMessage> {
    // A retry after a refused signature (gate stopped, signer down) resumes, but only with the very same set.
    this.expectPhase('origination:proposed', 'origination:enforcement-recorded')
    const { agreement, adapter } = this.deps
    const op = this.state.origination!
    if (parentProposalHash !== op.proposal_hash) throw new JointRefused('JOINT_ENFORCEMENT_SET', 'enforcement for another proposal')
    checkEnforcementSet(agreement, spends)
    if (this.state.phase === 'origination:enforcement-recorded') {
      if (hashObject(spends) !== this.state.enforcement_hash) throw new JointRefused('JOINT_ENFORCEMENT_SET', 'a different enforcement set was already recorded')
      return this.#signFirst('origination')
    }
    await adapter.recordEnforcement(this.context('origination:enforcement'), op.operation_id, spends)
    this.state.enforcement_hash = hashObject(spends)
    this.state.phase = 'origination:enforcement-recorded'
    this.save()
    return this.#signFirst('origination')
  }

  async #onRepaymentProposal(proposal: OnchainJointProposal, artifacts: ArtifactBytes[]): Promise<JointMessage> {
    this.expectPhase('origination:settled', 'repayment:verified')
    const { agreement, adapter } = this.deps
    if (this.state.phase === 'repayment:verified') {
      // Resume after a refused signature, only for the proposal already verified.
      if (hashObject(proposal) !== hashObject(this.state.repayment!.proposal)) throw new JointRefused('JOINT_OUT_OF_ORDER', 'a different repayment was already verified')
      return this.#signFirst('repayment')
    }
    checkProposalBinding(agreement, proposal, 'repayment')
    await this.importArtifacts('repayment', proposal, artifacts)
    const op = await adapter.verifyProposal(this.context('repayment:verify'), proposal)
    if (op.unsigned_txid !== op.decoded_summary.unsigned_txid) throw new JointRefused('JOINT_WRONG_TXID', 'summary and operation disagree')
    const collateralScript = (await adapter.inspectCollateral(agreement.terms)).script_pubkey
    checkProposalBinding(agreement, op.proposal, 'repayment')
    checkRepaymentSummary(agreement, op.proposal, op.decoded_summary, this.collateral(collateralScript))
    this.state.repayment = op
    this.state.phase = 'repayment:verified'
    this.save()
    return this.#signFirst('repayment')
  }

  async #signFirst(action: 'origination' | 'repayment'): Promise<JointMessage> {
    // Re-checked here, not only by phase order, so no later path can sign funding early.
    if (action === 'origination' && this.state.phase !== 'origination:enforcement-recorded') throw new JointRefused('JOINT_ENFORCEMENT_FIRST', 'no funding signature before the borrower\'s complete enforcement set is recorded')
    if (action === 'repayment' && this.state.phase !== 'repayment:verified') throw new JointRefused('JOINT_OUT_OF_ORDER', 'repayment not verified')
    const op = action === 'origination' ? this.state.origination! : this.state.repayment!
    const { signed } = await this.signAndExport(`${action}:sign`, action, op, op.proposal_hash, op.proposal.colored_psbt_base64)
    this.state.phase = action === 'origination' ? 'origination:signed' : 'repayment:signed'
    return this.seal({ type: 'signature', action, proposal_hash: op.proposal_hash, unsigned_txid: op.unsigned_txid, signed_psbt_base64: signed })
  }

  /** The lender is origination's RGB sender: apply once confirmed; no receive to take. */
  async settleOrigination(): Promise<OnchainOperationStatus> {
    if (this.state.phase === 'origination:settled' || this.state.phase.startsWith('repayment:') || this.state.phase === 'closed') return this.state.statuses[this.state.origination!.operation_id]
    this.expectPhase('origination:signed')
    return this.guard(() => this.settle('origination', false))
  }

  /** The lender receives the debt: once confirmed it takes the consignment and must end settled. */
  async settleRepayment(): Promise<OnchainOperationStatus> {
    if (this.state.phase === 'repayment:settled' || this.state.phase === 'closed') return this.state.statuses[this.state.repayment!.operation_id]
    this.expectPhase('repayment:signed')
    return this.guard(() => this.settle('repayment', true))
  }
}
