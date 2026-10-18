// STUB of draft #56 (work/onchain-g0-contract @ 2d9ef80), src/settlement/onchain-v3-contract.ts.
// Lane rule 2.4: the exact frozen v3 declarations, types and constants only, so the
// orchestration can be written and tested from main before #56 merges. No validator,
// hash function or other logic is copied: those stay #56's and are reached through
// the native adapter. DELETE this file when #56 merges and import
// '../settlement/onchain-v3-contract.js' instead (the declarations are identical).
import type { Hex } from '../core/crypto.js'
import type { OracleQuote } from '../core/terms.js'
export const ONCHAIN_CONTRACT = 'passbook-rgb-joint/v1' as const
export const ONCHAIN_NATIVE_REVISION = '5f655a9cd02d23996d4d79e6d5f4e6add0301197' as const
export const ONCHAIN_G0_STATUS = 'joint-design-approved-implementation-pending' as const
export const ONCHAIN_V3_LIVE_ENABLED = false as const
export const ONCHAIN_NUMS_KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'
export const ONCHAIN_REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
export const MAX_NATIVE_AMOUNT = (1n << 64n) - 1n
export type DecimalAmount = string
export interface OnchainNetwork { chain: 'regtest'; genesis_hash: Hex }
export interface OnchainOutpoint { txid: Hex; vout: number }
export interface OnchainPrevout extends OnchainOutpoint { value_sats: DecimalAmount; script_pubkey: Hex }
export interface OnchainAsset { kind: 'NIA'; contract_id: string; schema_id: string; precision: number }
export interface OnchainArtifact { sha256: Hex; byte_length: number }
export interface OnchainPayout { lender_sats: DecimalAmount; borrower_sats: DecimalAmount; fee_sats: DecimalAmount }
export interface OnchainLiquidationTemplate extends OnchainPayout { id: string; price_ceiling_cents: DecimalAmount; lock_height: number }
export interface OnchainSettlementParams {
  kind: 'rgb-onchain-joint'; protocol: typeof ONCHAIN_CONTRACT; native_revision: typeof ONCHAIN_NATIVE_REVISION
  network: OnchainNetwork; collateral_template: 'joint-afd-terms/v1'; internal_key: typeof ONCHAIN_NUMS_KEY
  input_policy: 'single-nia-exact-amount/v1'; asset: OnchainAsset; debt: DecimalAmount
  destinations: { borrower_rgb_script_pubkey: Hex; lender_rgb_script_pubkey: Hex; borrower_btc_script_pubkey: Hex; lender_btc_script_pubkey: Hex; borrower_change_script_pubkey: Hex }
  bitcoin_policy: {
    fee_payer: 'borrower'; collateral_return: 'full'; rgb_output_sats: DecimalAmount; min_output_sats: DecimalAmount
    origination_fee_cap_sats: DecimalAmount; repayment_fee_cap_sats: DecimalAmount
    enforcement_fee_cap_sats: DecimalAmount; recovery_fee_cap_sats: DecimalAmount
  }
  confirmations: { funding: number; repayment: number }
  default_payout: OnchainPayout
  liquidation: { policy: 'passbook-margin-70-80-85-cure10/v1'; quote_max_age_blocks: number; templates: OnchainLiquidationTemplate[] }
}
/** Transfer amounts are decimal u64 strings; retain the existing signed price quote. */
export interface OnchainLoanTermsV3 {
  v: 3; borrower_pk: Hex; lender_pk: Hex; platform_pk: Hex
  principal: DecimalAmount; fee: DecimalAmount; collateral_sats: DecimalAmount; oracle_quote: OracleQuote
  open_height: number; maturity_height: number; grace_blocks: number; recovery_height: number
  ladder_step: number; ltv_bps: number; prev_passbook_txid: Hex | null; nonce: Hex; settlement: OnchainSettlementParams
}
interface JointIntentBase {
  domain: 'passbook-rgb-joint-intent/v1'; loan_id: Hex; network: OnchainNetwork; asset: OnchainAsset; amount: DecimalAmount
  rgb_input: OnchainPrevout // one NIA allocation, exact principal or debt
  borrower_btc_inputs: OnchainPrevout[] // RGB-free P2TR fee/collateral inputs
  rgb_output_vout: number; borrower_change_vout: number | null
}
export interface OnchainOriginationIntent extends JointIntentBase { action: 'origination'; collateral_output_vout: number; lender_btc_return_vout: number }
export interface OnchainRepaymentIntent extends JointIntentBase { action: 'repayment'; collateral: OnchainPrevout; collateral_return_vout: number }
export type OnchainJointIntent = OnchainOriginationIntent | OnchainRepaymentIntent
export interface OnchainJointProposal {
  domain: 'passbook-rgb-joint-proposal/v1'; terms: OnchainLoanTermsV3; intent: OnchainJointIntent
  colored_psbt_base64: string; input_history: OnchainArtifact[]; transfer_consignment: OnchainArtifact
}
export interface OnchainTransactionEvidence<I extends OnchainJointIntent> { intent: I; txid: Hex; input_history: OnchainArtifact[]; transfer_consignment: OnchainArtifact }
export interface OnchainRepaymentEvidence {
  domain: 'passbook-rgb-joint-evidence/v1'
  funding: OnchainTransactionEvidence<OnchainOriginationIntent>; repayment: OnchainTransactionEvidence<OnchainRepaymentIntent>
}
export type OnchainVerificationResult = { ok: false; code: string } | { ok: true; assurance: 'native-rgb-joint'; funding_height: number; repayment_height: number; evidence_hash: Hex }
export interface OnchainNativeContext { request_id: string; idempotency_key: string; wallet_id: string; network: OnchainNetwork; obligation_id: Hex }
export interface OnchainReceiveTarget { receive_id: string; transport: 'out-of-band'; recipient_id: string; script_pubkey: Hex }
export interface OnchainNativePreparation {
  context: OnchainNativeContext; terms: OnchainLoanTermsV3; intent: OnchainJointIntent; intent_hash: Hex
  unsigned_psbt_base64: string; input_history: OnchainArtifact[]; recipient_id: string
}
export interface OnchainDecodedSummary {
  kind: 'rgb-onchain-joint'; action: 'origination' | 'repayment' | 'default' | 'liquidation' | 'recovery'
  wallet_id: string; network: OnchainNetwork; obligation_id: Hex
  inputs: { outpoint: OnchainOutpoint; value_sats: DecimalAmount; script_pubkey: Hex; sequence: number; sighash: 'ALL' | 'DEFAULT' }[]
  outputs: { vout: number; value_sats: DecimalAmount; script_pubkey: Hex; allocations: { asset: OnchainAsset; amount: DecimalAmount }[] }[]
  transaction_version: number; locktime: number; fee_sats: DecimalAmount; unsigned_txid: Hex
}
export interface OnchainPreparedOperation {
  operation_id: string; intent_hash: Hex; proposal_hash: Hex; proposal: OnchainJointProposal
  unsigned_txid: Hex; decoded_summary: OnchainDecodedSummary; decoded_summary_hash: Hex
}
export interface OnchainSigningAuthorization {
  domain: 'passbook-onchain-signing-authorization/v1'; decision_id: string; policy_version: number
  intent_hash: Hex; proposal_hash: Hex; decoded_summary_hash: Hex; operation_id: string; issued_at: number; expires_at: number; signature: Hex
}
export interface OnchainEnforcementIntent {
  parent_proposal_hash: Hex; kind: 'default' | 'liquidation'; template_id: string | null; unsigned_psbt_base64: string
}
export interface OnchainEnforcementPreparation extends OnchainEnforcementIntent {
  operation_id: string; intent_hash: Hex; decoded_summary: OnchainDecodedSummary; decoded_summary_hash: Hex
}
// Remote acceptance is based on B's exact Bitcoin signature, not B's local gate.
export interface OnchainSignedEnforcement { kind: 'default' | 'liquidation'; template_id: string | null; signed_psbt_base64: string }
export interface OnchainOperationStatus {
  operation_id: string; intent_hash: Hex; txid: Hex
  phase: 'prepared' | 'signed-exported' | 'broadcast-attempted' | 'observed' | 'confirmed' | 'rgb-applied' | 'settled' | 'conflicted' | 'aborted-before-export'
  signatures_exported: boolean // partial signatures count; monotone after reorg
  confirmations: number; replacement_txids: Hex[]
}
/** Loan-scoped port. No implementation or authorization is supplied by these types. */
export interface OnchainNativeAdapter {
  capabilities(): Promise<{ protocol: typeof ONCHAIN_CONTRACT; native_revision: typeof ONCHAIN_NATIVE_REVISION; chain: 'regtest'; live_v3: false }>
  importArtifact(context: OnchainNativeContext, artifact: OnchainArtifact, bytes_base64: string): Promise<void>
  createReceive(request: { request_id: string; idempotency_key: string; wallet_id: string; network: OnchainNetwork; asset: OnchainAsset; amount: DecimalAmount }): Promise<OnchainReceiveTarget>
  inspectCollateral(terms: OnchainLoanTermsV3): Promise<{ script_pubkey: Hex; leaves: Record<'A' | 'F' | 'D', { script: Hex; control_block: Hex }> }>
  prepare(request: OnchainNativePreparation): Promise<OnchainPreparedOperation>
  verifyProposal(context: OnchainNativeContext, proposal: OnchainJointProposal): Promise<OnchainPreparedOperation>
  prepareEnforcement(context: OnchainNativeContext, origination_operation_id: string): Promise<OnchainEnforcementPreparation[]>
  recordEnforcement(context: OnchainNativeContext, origination_operation_id: string, spends: OnchainSignedEnforcement[]): Promise<void>
  recordSignedExport(context: OnchainNativeContext, operation_id: string, signed_psbt_base64: string, authorization: OnchainSigningAuthorization): Promise<OnchainOperationStatus>
  broadcast(context: OnchainNativeContext, operation_id: string): Promise<OnchainOperationStatus>
  reconcile(context: OnchainNativeContext, operation_id: string): Promise<OnchainOperationStatus>
  apply(context: OnchainNativeContext, operation_id: string): Promise<OnchainOperationStatus>
  handoverReceive(context: OnchainNativeContext, operation_id: string, receive_id: string, artifact: OnchainArtifact): Promise<OnchainOperationStatus>
  abortBeforeExport(context: OnchainNativeContext, operation_id: string): Promise<OnchainOperationStatus>
  verifyRepayment(context: OnchainNativeContext, terms: OnchainLoanTermsV3, evidence: OnchainRepaymentEvidence): Promise<OnchainVerificationResult>
  close(wallet_id: string): Promise<void>
}
