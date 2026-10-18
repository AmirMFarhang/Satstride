// From what negotiation agrees today (LoanTerms fields, Micro and Sats as
// numbers) to #56's v3 joint terms (decimal u64 strings, the pinned protocol,
// the parties' own receive and payout scripts, fee caps, enforcement payouts).
// It only maps and refuses what cannot be mapped exactly; #56's
// validateOnchainTermsV3 remains the structural check (run by native, and here
// once #56 merges), and onchainLoanId(terms) the loan id.

import type { Hex } from '../core/crypto.js'
import { MICRO_PER_USDT } from '../core/money.js'
import type { LoanTerms } from '../core/terms.js'
import {
  ONCHAIN_CONTRACT, ONCHAIN_NATIVE_REVISION, ONCHAIN_NUMS_KEY, ONCHAIN_REGTEST_GENESIS,
  type OnchainAsset, type OnchainLiquidationTemplate, type OnchainLoanTermsV3, type OnchainPayout, type OnchainSettlementParams,
} from './contract-stub.js'
import { JointRefused } from './ports.js'

/** Sent by the borrower with its application: its receive for the principal and its Bitcoin scripts. */
export interface BorrowerJointTargets {
  recipient_id: string
  borrower_rgb_script_pubkey: Hex
  borrower_btc_script_pubkey: Hex
  borrower_change_script_pubkey: Hex
}

/** The lender's side: its receive for the debt and its Bitcoin return script. */
export interface LenderJointTargets {
  recipient_id: string
  lender_rgb_script_pubkey: Hex
  lender_btc_script_pubkey: Hex
}

/** Negotiated economics in today's units; the v1/v2-only fields (`v`, `atomic_repayment`, `asset_id`) do not carry over. */
export type JointEconomics = Omit<LoanTerms, 'v' | 'atomic_repayment' | 'asset_id'>

export interface JointPolicy {
  bitcoin_policy: OnchainSettlementParams['bitcoin_policy']
  confirmations: OnchainSettlementParams['confirmations']
  default_payout: OnchainPayout
  liquidation: { quote_max_age_blocks: number; templates: OnchainLiquidationTemplate[] }
}

const P2TR = /^5120[0-9a-f]{64}$/

function decimal(name: string, v: number): string {
  if (!Number.isSafeInteger(v) || v < 0) throw new JointRefused('JOINT_TERMS_UNITS', `${name}: a non-negative whole number is required, got ${v}`)
  return String(v)
}

/**
 * Today's amounts are micro-units of the dollar asset, so its RGB precision must be 6:
 * any other precision would silently scale the loan by a power of ten.
 */
export function jointTermsV3(economics: JointEconomics, asset: OnchainAsset, borrower: BorrowerJointTargets, lender: LenderJointTargets, policy: JointPolicy): { terms: OnchainLoanTermsV3; borrower_recipient_id: string; lender_recipient_id: string } {
  if (asset.kind !== 'NIA' || asset.precision !== Math.log10(MICRO_PER_USDT)) throw new JointRefused('JOINT_TERMS_UNITS', `asset precision ${asset.precision}; negotiated amounts are micro-units (precision 6)`)
  const destinations = {
    borrower_rgb_script_pubkey: borrower.borrower_rgb_script_pubkey,
    lender_rgb_script_pubkey: lender.lender_rgb_script_pubkey,
    borrower_btc_script_pubkey: borrower.borrower_btc_script_pubkey,
    lender_btc_script_pubkey: lender.lender_btc_script_pubkey,
    borrower_change_script_pubkey: borrower.borrower_change_script_pubkey,
  }
  for (const [k, v] of Object.entries(destinations)) if (!P2TR.test(v)) throw new JointRefused('JOINT_TERMS_DESTINATION', `${k}: P2TR script required`)
  if (destinations.borrower_rgb_script_pubkey === destinations.lender_rgb_script_pubkey) throw new JointRefused('JOINT_TERMS_DESTINATION', 'borrower and lender receive scripts must differ')
  if (!borrower.recipient_id || !lender.recipient_id || borrower.recipient_id === lender.recipient_id) throw new JointRefused('JOINT_TERMS_DESTINATION', 'distinct receive ids required')
  const principal = decimal('principal', economics.principal), fee = decimal('fee', economics.fee)
  if (economics.principal === 0 || economics.collateral_sats <= 0) throw new JointRefused('JOINT_TERMS_UNITS', 'principal and collateral must be positive')
  const terms: OnchainLoanTermsV3 = {
    v: 3,
    borrower_pk: economics.borrower_pk, lender_pk: economics.lender_pk, platform_pk: economics.platform_pk,
    principal, fee, collateral_sats: decimal('collateral_sats', economics.collateral_sats),
    oracle_quote: economics.oracle_quote,
    open_height: economics.open_height, maturity_height: economics.maturity_height, grace_blocks: economics.grace_blocks, recovery_height: economics.recovery_height,
    ladder_step: economics.ladder_step, ltv_bps: economics.ltv_bps, prev_passbook_txid: economics.prev_passbook_txid, nonce: economics.nonce,
    settlement: {
      kind: 'rgb-onchain-joint', protocol: ONCHAIN_CONTRACT, native_revision: ONCHAIN_NATIVE_REVISION,
      network: { chain: 'regtest', genesis_hash: ONCHAIN_REGTEST_GENESIS },
      collateral_template: 'joint-afd-terms/v1', internal_key: ONCHAIN_NUMS_KEY, input_policy: 'single-nia-exact-amount/v1',
      asset, debt: (BigInt(principal) + BigInt(fee)).toString(), destinations,
      bitcoin_policy: policy.bitcoin_policy, confirmations: policy.confirmations, default_payout: policy.default_payout,
      liquidation: { policy: 'passbook-margin-70-80-85-cure10/v1', quote_max_age_blocks: policy.liquidation.quote_max_age_blocks, templates: policy.liquidation.templates },
    },
  }
  return { terms, borrower_recipient_id: borrower.recipient_id, lender_recipient_id: lender.recipient_id }
}
