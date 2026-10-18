// The borrower's side of a v3 joint loan (#56, rgb-onchain-joint).
//
// Origination: offer Bitcoin inputs → verify the lender's colored proposal and
// hold its proof bytes → pre-sign default and every liquidation spend of the
// future collateral → after the lender's funding signature, sign second and
// broadcast → take the principal consignment and end settled.
// Repayment: prepare the repayment (exact debt to the lender, full collateral
// back) → after the lender's signature, sign second and broadcast → settle →
// natively verified evidence for the passbook.

import type { JointMessage } from './messages.js'
import { checkEnforcementSet, checkEnforcementSummary, checkOriginationSummary, checkProposalBinding, checkRepaymentSummary } from './checks.js'
import { JointRefused, type BorrowerFunding } from './ports.js'
import { JointParty, type JointPartyDeps } from './session.js'
import type { OnchainOperationStatus, OnchainSignedEnforcement } from './contract-stub.js'

export class JointBorrower extends JointParty {
  constructor(deps: JointPartyDeps) {
    if (deps.local.role !== 'borrower') throw new JointRefused('JOINT_WRONG_PARTY', 'borrower role required')
    super(deps)
  }

  /** Step 1: the Bitcoin inputs that will fund the collateral, the principal's witness output and the fee. */
  async offerFunding(funding: BorrowerFunding): Promise<JointMessage> {
    return this.initiate('origination:offer', async () => {
      this.expectPhase('agreed')
      const cap = BigInt(this.deps.agreement.terms.settlement.bitcoin_policy.origination_fee_cap_sats)
      if (BigInt(funding.fee_sats) <= 0n || BigInt(funding.fee_sats) > cap) throw new JointRefused('JOINT_FEE_CAP', `offered fee ${funding.fee_sats} sats, cap ${cap}`)
      if (!funding.borrower_btc_inputs.length) throw new JointRefused('JOINT_WRONG_INPUTS', 'at least one Bitcoin input')
      this.state.funding = structuredClone(funding)
      this.state.phase = 'origination:inputs-offered'
      return this.seal({ type: 'funding-inputs', borrower_btc_inputs: funding.borrower_btc_inputs, fee_sats: funding.fee_sats })
    })
  }

  protected async handle(m: JointMessage): Promise<JointMessage[]> {
    const b = m.body
    if (b.type === 'proposal') return [await this.#onOriginationProposal(b.proposal, b.artifacts)]
    if (b.type === 'signature' && b.action === 'origination') return [await this.#signSecondAndBroadcast('origination', b.proposal_hash, b.unsigned_txid, b.signed_psbt_base64)]
    if (b.type === 'signature' && b.action === 'repayment') return [await this.#signSecondAndBroadcast('repayment', b.proposal_hash, b.unsigned_txid, b.signed_psbt_base64)]
    if (b.type === 'broadcast') return this.noteBroadcast(b.action, b.txid, b.action === 'origination' ? this.state.origination : this.state.repayment)
    throw new JointRefused('JOINT_UNEXPECTED_MESSAGE', `${b.type} is not for the borrower`)
  }

  async #onOriginationProposal(proposal: Parameters<typeof checkProposalBinding>[1], artifacts: Parameters<JointParty['importArtifacts']>[2]): Promise<JointMessage> {
    this.expectPhase('origination:inputs-offered')
    const { agreement, adapter } = this.deps
    checkProposalBinding(agreement, proposal, 'origination')
    // Full principal proof bytes are in this wallet's own store before anything is verified or signed.
    await this.importArtifacts('origination', proposal, artifacts)
    const op = await adapter.verifyProposal(this.context('origination:verify'), proposal)
    if (op.unsigned_txid !== op.decoded_summary.unsigned_txid) throw new JointRefused('JOINT_WRONG_TXID', 'summary and operation disagree')
    const collateral = await adapter.inspectCollateral(agreement.terms)
    checkProposalBinding(agreement, op.proposal, 'origination')
    checkOriginationSummary(agreement, op.proposal, op.decoded_summary, collateral.script_pubkey, this.state.funding!)
    this.state.origination = op
    this.save()

    // Default and every liquidation template are fixed by the final unsigned txid; the
    // lender gets all of them before it may release any funding signature.
    const context = this.context('origination:enforcement')
    const preps = await adapter.prepareEnforcement(context, op.operation_id)
    checkEnforcementSet(agreement, preps)
    // Every spend is checked before the first one is signed.
    for (const prep of preps) {
      if (prep.parent_proposal_hash !== op.proposal_hash) throw new JointRefused('JOINT_ENFORCEMENT_SET', 'enforcement for another proposal')
      checkEnforcementSummary(agreement, prep, op.unsigned_txid, collateral.script_pubkey)
    }
    const spends: OnchainSignedEnforcement[] = []
    for (const prep of preps) {
      const { signed } = await this.signAndExport(`origination:enforcement:${prep.kind}:${prep.template_id ?? ''}`, prep.kind, prep, op.proposal_hash, prep.unsigned_psbt_base64)
      spends.push({ kind: prep.kind, template_id: prep.template_id, signed_psbt_base64: signed })
    }
    this.state.phase = 'origination:enforcement-signed'
    return this.seal({ type: 'enforcement', parent_proposal_hash: op.proposal_hash, spends })
  }

  /** The lender signed first; the borrower adds its signatures to that exact transaction and broadcasts it. */
  async #signSecondAndBroadcast(action: 'origination' | 'repayment', proposalHash: string, unsignedTxid: string, psbt: string): Promise<JointMessage> {
    this.expectPhase(action === 'origination' ? 'origination:enforcement-signed' : 'repayment:proposed')
    const op = action === 'origination' ? this.state.origination! : this.state.repayment!
    if (proposalHash !== op.proposal_hash || unsignedTxid !== op.unsigned_txid) throw new JointRefused('JOINT_WRONG_TXID', `${action}: signature for another transaction`)
    // Same idempotency keys on a retry: the adapter returns the journaled export and
    // broadcast instead of a second operation. The phase moves only after broadcast.
    await this.signAndExport(`${action}:sign`, action, op, op.proposal_hash, psbt)
    this.save()
    const status = await this.deps.adapter.broadcast(this.context(`${action}:broadcast`), op.operation_id)
    this.state.statuses[op.operation_id] = status
    this.state.phase = action === 'origination' ? 'origination:broadcast' : 'repayment:broadcast'
    return this.seal({ type: 'broadcast', action, txid: op.unsigned_txid })
  }

  /** Reconcile, and once confirmed take the principal: the borrower is the origination's RGB receiver. */
  async settleOrigination(): Promise<OnchainOperationStatus> {
    if (this.state.phase === 'origination:settled') return this.state.statuses[this.state.origination!.operation_id]
    this.expectPhase('origination:broadcast')
    return this.guard(() => this.settle('origination', true))
  }

  /** Step 2: one transaction returning the exact debt to the lender and the full collateral to the borrower. */
  async startRepayment(): Promise<JointMessage> {
    return this.initiate('repayment:propose', async () => {
      this.expectPhase('origination:settled')
      const { agreement, adapter, builder } = this.deps
      const collateralScript = (await adapter.inspectCollateral(agreement.terms)).script_pubkey
      const collateral = this.collateral(collateralScript)
      const prep = await builder.repayment(agreement, collateral, agreement.terms.settlement.bitcoin_policy.repayment_fee_cap_sats)
      if (prep.recipient_id !== agreement.lender_recipient_id) throw new JointRefused('JOINT_WRONG_DESTINATION', 'repayment must go to the lender\'s agreed receive')
      const op = await adapter.prepare({ context: this.context('repayment:prepare'), ...prep })
      checkProposalBinding(agreement, op.proposal, 'repayment')
      checkRepaymentSummary(agreement, op.proposal, op.decoded_summary, collateral)
      this.state.repayment = op
      this.state.phase = 'repayment:proposed'
      this.save()
      return this.seal({ type: 'proposal', proposal: op.proposal, artifacts: await this.exportArtifacts('repayment', op.proposal) })
    })
  }

  async settleRepayment(): Promise<OnchainOperationStatus> {
    if (this.state.phase === 'repayment:settled' || this.state.phase === 'closed') return this.state.statuses[this.state.repayment!.operation_id]
    this.expectPhase('repayment:broadcast')
    return this.guard(() => this.settle('repayment', false))
  }
}
