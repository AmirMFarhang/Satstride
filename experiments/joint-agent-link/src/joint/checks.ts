// Each party's own check, before it authorizes a signature, that the natively
// decoded transaction is exactly the agreed loan step: the layout #56 fixes,
// the exact RGB amount and asset to the right party, the full collateral, the
// fee within its cap and whole-transaction sighashes only. Native verification
// (the adapter) proves the PSBT, chain and RGB facts behind the summary; this
// proves the summary is the deal this party signed. Code decides, never a model.

import { hashObject, type Hex } from '../core/crypto.js'
import type { OnchainDecodedSummary, OnchainEnforcementPreparation, OnchainJointProposal, OnchainOutpoint, OnchainPrevout, OnchainSignedEnforcement } from './contract-stub.js'
import { JointRefused, type BorrowerFunding, type JointAgreement } from './ports.js'

type Output = OnchainDecodedSummary['outputs'][number]

const key = (o: OnchainOutpoint) => `${o.txid}:${o.vout}`
const refuse = (code: string, detail?: string): never => { throw new JointRefused(code, detail) }
const same = (a: unknown, b: unknown) => hashObject(a) === hashObject(b)

/** The proposal is for this loan, these terms and this action; nothing else is negotiable at this point. */
export function checkProposalBinding(agreement: JointAgreement, proposal: OnchainJointProposal, action: 'origination' | 'repayment'): void {
  if (proposal.domain !== 'passbook-rgb-joint-proposal/v1') refuse('JOINT_PROPOSAL_DOMAIN')
  if (!same(proposal.terms, agreement.terms)) refuse('JOINT_TERMS_CHANGED', 'the proposal does not carry the agreed terms')
  if (proposal.intent.loan_id !== agreement.loan_id) refuse('JOINT_WRONG_LOAN')
  if (proposal.intent.action !== action) refuse('JOINT_WRONG_ACTION', `${proposal.intent.action} instead of ${action}`)
  const expected = action === 'origination' ? agreement.terms.principal : agreement.terms.settlement.debt
  if (proposal.intent.amount !== expected) refuse('JOINT_WRONG_AMOUNT', `intent moves ${proposal.intent.amount}, agreed ${expected}`)
  if (!same(proposal.intent.asset, agreement.terms.settlement.asset)) refuse('JOINT_WRONG_ASSET')
}

function outputs(summary: OnchainDecodedSummary): Output[] {
  const outs = [...summary.outputs].sort((a, b) => a.vout - b.vout)
  outs.forEach((o, i) => { if (o.vout !== i) refuse('JOINT_LAYOUT', 'output indices are not 0..n-1') })
  return outs
}

function plain(o: Output | undefined, script: Hex, value: string | null, what: string): void {
  if (!o) return refuse('JOINT_LAYOUT', `missing ${what}`)
  if (o.script_pubkey !== script) refuse('JOINT_WRONG_DESTINATION', what)
  if (value !== null && BigInt(o.value_sats) !== BigInt(value)) refuse('JOINT_WRONG_VALUE', `${what}: ${o.value_sats} sats, agreed ${value}`)
  if (o.allocations.length) refuse('JOINT_HIDDEN_RGB', `${what} carries RGB state`)
}

function colored(o: Output | undefined, script: Hex, value: string, agreement: JointAgreement, amount: string, what: string): void {
  if (!o) return refuse('JOINT_LAYOUT', `missing ${what}`)
  if (o.script_pubkey !== script) refuse('JOINT_WRONG_DESTINATION', what)
  if (BigInt(o.value_sats) !== BigInt(value)) refuse('JOINT_WRONG_VALUE', `${what} witness output`)
  if (o.allocations.length !== 1) refuse('JOINT_HIDDEN_RGB', `${what}: exactly one allocation required`)
  const [a] = o.allocations
  if (!same(a.asset, agreement.terms.settlement.asset)) refuse('JOINT_WRONG_ASSET', what)
  if (BigInt(a.amount) !== BigInt(amount)) refuse('JOINT_WRONG_AMOUNT', `${what}: ${a.amount}, agreed ${amount}`)
}

function opReturn(o: Output | undefined): void {
  if (!o || !o.script_pubkey.startsWith('6a') || BigInt(o.value_sats) !== 0n || o.allocations.length) refuse('JOINT_LAYOUT', 'output 0 must be the zero-value RGB commitment')
}

function change(o: Output | undefined, agreement: JointAgreement): void {
  if (!o) return
  plain(o, agreement.terms.settlement.destinations.borrower_change_script_pubkey, null, 'borrower change')
  if (BigInt(o.value_sats) < BigInt(agreement.terms.settlement.bitcoin_policy.min_output_sats)) refuse('JOINT_DUST', 'borrower change')
}

function common(agreement: JointAgreement, summary: OnchainDecodedSummary, action: 'origination' | 'repayment', inputs: OnchainPrevout[], feeCap: string): void {
  if (summary.kind !== 'rgb-onchain-joint' || summary.action !== action) refuse('JOINT_WRONG_ACTION')
  if (summary.obligation_id !== agreement.loan_id) refuse('JOINT_WRONG_LOAN')
  if (!same(summary.network, agreement.terms.settlement.network)) refuse('JOINT_WRONG_NETWORK')
  const want = new Map(inputs.map(i => [key(i), i]))
  if (summary.inputs.length !== want.size) refuse('JOINT_WRONG_INPUTS', `${summary.inputs.length} inputs, agreed ${want.size}`)
  for (const i of summary.inputs) {
    const w = want.get(key(i.outpoint))
    if (!w) return refuse('JOINT_WRONG_INPUTS', `unexpected input ${key(i.outpoint)}`)
    if (BigInt(i.value_sats) !== BigInt(w.value_sats) || i.script_pubkey !== w.script_pubkey) refuse('JOINT_WRONG_INPUTS', `prevout ${key(i.outpoint)} differs`)
    if (i.sighash !== 'ALL' && i.sighash !== 'DEFAULT') refuse('JOINT_SIGHASH', 'only whole-transaction signatures')
  }
  const fee = BigInt(summary.fee_sats)
  if (fee <= 0n || fee > BigInt(feeCap)) refuse('JOINT_FEE_CAP', `fee ${summary.fee_sats} sats, cap ${feeCap}`)
  const inSum = summary.inputs.reduce((n, i) => n + BigInt(i.value_sats), 0n)
  const outSum = summary.outputs.reduce((n, o) => n + BigInt(o.value_sats), 0n)
  if (inSum !== outSum + fee) refuse('JOINT_NOT_CONSERVED')
}

/**
 * Origination: [RGB commitment, collateral C, borrower principal, lender BTC return, optional borrower change].
 * `funding` is what the borrower offered (checked by both sides: the borrower against its own offer).
 */
export function checkOriginationSummary(agreement: JointAgreement, proposal: OnchainJointProposal, summary: OnchainDecodedSummary, collateralScript: Hex, funding: BorrowerFunding): void {
  const { terms } = agreement, intent = proposal.intent
  if (intent.action !== 'origination') return refuse('JOINT_WRONG_ACTION')
  const offered = new Set(funding.borrower_btc_inputs.map(key))
  if (intent.borrower_btc_inputs.length !== offered.size || intent.borrower_btc_inputs.some(i => !offered.has(key(i)))) refuse('JOINT_WRONG_INPUTS', 'borrower inputs differ from the borrower offer')
  common(agreement, summary, 'origination', [intent.rgb_input, ...funding.borrower_btc_inputs], terms.settlement.bitcoin_policy.origination_fee_cap_sats)
  if (BigInt(summary.fee_sats) !== BigInt(funding.fee_sats)) refuse('JOINT_FEE_CAP', `fee ${summary.fee_sats} sats, borrower offered ${funding.fee_sats}`)
  const d = terms.settlement.destinations, outs = outputs(summary)
  if (outs.length < 4 || outs.length > 5) refuse('JOINT_LAYOUT', `${outs.length} outputs`)
  opReturn(outs[0])
  plain(outs[1], collateralScript, terms.collateral_sats, 'collateral')
  colored(outs[2], d.borrower_rgb_script_pubkey, terms.settlement.bitcoin_policy.rgb_output_sats, agreement, terms.principal, 'borrower principal')
  plain(outs[3], d.lender_btc_script_pubkey, intent.rgb_input.value_sats, 'lender BTC return')
  change(outs[4], agreement)
}

/** Repayment: [RGB commitment, lender debt, full borrower collateral return, optional borrower change]; spends exactly the funded C. */
export function checkRepaymentSummary(agreement: JointAgreement, proposal: OnchainJointProposal, summary: OnchainDecodedSummary, collateral: OnchainPrevout): void {
  const { terms } = agreement, intent = proposal.intent
  if (intent.action !== 'repayment') return refuse('JOINT_WRONG_ACTION')
  if (key(intent.collateral) !== key(collateral) || intent.collateral.value_sats !== terms.collateral_sats) refuse('JOINT_WRONG_COLLATERAL', 'repayment must spend this loan\'s funded collateral')
  common(agreement, summary, 'repayment', [intent.rgb_input, ...intent.borrower_btc_inputs, collateral], terms.settlement.bitcoin_policy.repayment_fee_cap_sats)
  const d = terms.settlement.destinations, outs = outputs(summary)
  if (outs.length < 3 || outs.length > 4) refuse('JOINT_LAYOUT', `${outs.length} outputs`)
  opReturn(outs[0])
  colored(outs[1], d.lender_rgb_script_pubkey, terms.settlement.bitcoin_policy.rgb_output_sats, agreement, terms.settlement.debt, 'lender debt')
  plain(outs[2], d.borrower_btc_script_pubkey, terms.collateral_sats, 'full collateral return')
  change(outs[3], agreement)
}

/**
 * What the borrower pre-signs over the future collateral: one input (that exact C),
 * the fixed payout to lender then borrower, the fixed fee and the agreed lock height.
 */
export function checkEnforcementSummary(agreement: JointAgreement, prep: OnchainEnforcementPreparation, fundingTxid: Hex, collateralScript: Hex): void {
  const { terms } = agreement, s = prep.decoded_summary
  const template = prep.kind === 'default' ? null : terms.settlement.liquidation.templates.find(t => t.id === prep.template_id)
  if (prep.kind === 'liquidation' && !template) return refuse('JOINT_ENFORCEMENT_SET', `unknown template ${prep.template_id}`)
  const payout = template ?? terms.settlement.default_payout
  const lock = template ? template.lock_height : terms.maturity_height + terms.grace_blocks
  if (s.kind !== 'rgb-onchain-joint' || s.action !== prep.kind || s.obligation_id !== agreement.loan_id) refuse('JOINT_WRONG_ACTION', prep.kind)
  if (s.inputs.length !== 1) refuse('JOINT_WRONG_INPUTS', `${prep.kind} must spend only the collateral`)
  const [c] = s.inputs
  if (c.outpoint.txid !== fundingTxid || c.outpoint.vout !== 1 || BigInt(c.value_sats) !== BigInt(terms.collateral_sats) || c.script_pubkey !== collateralScript) refuse('JOINT_WRONG_COLLATERAL', prep.kind)
  if (c.sighash !== 'ALL' && c.sighash !== 'DEFAULT') refuse('JOINT_SIGHASH', prep.kind)
  if (s.locktime !== lock) refuse('JOINT_WRONG_LOCKTIME', `${prep.kind}: ${s.locktime}, agreed ${lock}`)
  if (BigInt(s.fee_sats) !== BigInt(payout.fee_sats)) refuse('JOINT_FEE_CAP', `${prep.kind} fee`)
  const outs = outputs(s), d = terms.settlement.destinations
  const borrowerPaid = BigInt(payout.borrower_sats) !== 0n
  if (outs.length !== (borrowerPaid ? 2 : 1)) refuse('JOINT_LAYOUT', `${prep.kind}: ${outs.length} outputs`)
  plain(outs[0], d.lender_btc_script_pubkey, payout.lender_sats, `${prep.kind} lender payout`)
  if (borrowerPaid) plain(outs[1], d.borrower_btc_script_pubkey, payout.borrower_sats, `${prep.kind} borrower payout`)
}

/** Exactly one default spend and one spend per agreed liquidation template, nothing else. */
export function checkEnforcementSet(agreement: JointAgreement, set: (OnchainSignedEnforcement | OnchainEnforcementPreparation)[]): void {
  const want = ['default:', ...agreement.terms.settlement.liquidation.templates.map(t => `liquidation:${t.id}`)].sort()
  const got = set.map(s => {
    if (s.kind === 'default' && s.template_id !== null) refuse('JOINT_ENFORCEMENT_SET', 'default has no template')
    if (s.kind === 'liquidation' && typeof s.template_id !== 'string') refuse('JOINT_ENFORCEMENT_SET', 'liquidation needs its template id')
    return `${s.kind}:${s.template_id ?? ''}`
  }).sort()
  if (got.join('|') !== want.join('|')) refuse('JOINT_ENFORCEMENT_SET', `have [${got.join(', ')}], need [${want.join(', ')}]`)
}
