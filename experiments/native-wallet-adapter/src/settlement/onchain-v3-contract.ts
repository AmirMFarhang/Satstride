// G0 contract only: no live registration, agent wiring or signing.
import { hashObject, type Hex } from '../core/crypto.js'
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
export function assertOnchainV3OriginationAllowed(): never { throw new Error('ONCHAIN_G0_BLOCKED: approved joint design still requires implementation and isolated acceptance') }
/** Shared digest: no wallet-local IDs, identical transaction/proof for both actors. */
export function onchainProposalHash(proposal: OnchainJointProposal): Hex { return hashObject(proposal) }
export function onchainPreparationHash(r: OnchainNativePreparation): Hex {
  return hashObject({ domain: 'passbook-rgb-joint-preparation/v1', wallet_id: r.context.wallet_id, network: r.context.network, obligation_id: r.context.obligation_id, terms: r.terms, intent: r.intent, unsigned_psbt_base64: r.unsigned_psbt_base64, input_history: r.input_history, recipient_id: r.recipient_id })
}
export function onchainEnforcementHash(context: OnchainNativeContext, spend: OnchainEnforcementIntent): Hex {
  return hashObject({ domain: 'passbook-rgb-joint-enforcement/v1', wallet_id: context.wallet_id, network: context.network, obligation_id: context.obligation_id, parent_proposal_hash: spend.parent_proposal_hash, kind: spend.kind, template_id: spend.template_id, unsigned_psbt_base64: spend.unsigned_psbt_base64 })
}
export function onchainDecodedSummaryHash(summary: OnchainDecodedSummary): Hex { return hashObject({ domain: 'passbook-wysiwys-v1', summary }) }
export function onchainSigningAuthorizationHash(auth: OnchainSigningAuthorization): Hex { const { signature: _signature, ...unsigned } = auth; return hashObject(unsigned) }
export function assertOnchainWholeTransactionSighash(value: unknown): asserts value is 0 | 1 {
  if (value !== 0 && value !== 1) throw new TypeError('SIGHASH_DEFAULT or SIGHASH_ALL required; no ANYONECANPAY, NONE or SINGLE')
}

export function nativeAmount(value: unknown, field = 'amount'): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) throw new TypeError(`${field}: canonical decimal u64 string required`)
  const result = BigInt(value)
  if (result > MAX_NATIVE_AMOUNT) throw new TypeError(`${field}: u64 overflow`)
  return result
}
function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field}: object required`)
  const x = value as Record<string, unknown>
  if (Object.keys(x).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(x, k))) throw new TypeError(`${field}: missing or unknown field`)
  return x
}
function hex(value: unknown, bytes: number, field: string): void {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) throw new TypeError(`${field}: lowercase ${bytes}-byte hex required`)
}
function script(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value) || value.length > 20_000) throw new TypeError(`${field}: script hex required`)
}
function integer(value: unknown, min: number, max: number, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TypeError(`${field}: bounded integer required`)
}
function text(value: unknown, field: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 256) throw new TypeError(`${field}: bounded nonempty string required`)
}
function network(value: unknown): void {
  const x = object(value, ['chain', 'genesis_hash'], 'network')
  if (x.chain !== 'regtest') throw new TypeError('network.chain: only regtest is in the G0 contract')
  hex(x.genesis_hash, 32, 'network.genesis_hash')
  if (x.genesis_hash !== ONCHAIN_REGTEST_GENESIS) throw new TypeError('network.genesis_hash: wrong regtest genesis')
}
function asset(value: unknown): void {
  const x = object(value, ['kind', 'contract_id', 'schema_id', 'precision'], 'asset')
  if (x.kind !== 'NIA') throw new TypeError('asset.kind: only one fungible NIA is supported')
  text(x.contract_id, 'asset.contract_id'); text(x.schema_id, 'asset.schema_id')
  integer(x.precision, 0, 18, 'asset.precision')
}
function outpoint(value: unknown): void {
  const x = object(value, ['txid', 'vout'], 'outpoint')
  hex(x.txid, 32, 'outpoint.txid'); integer(x.vout, 0, 0xffffffff, 'outpoint.vout')
}
function artifact(value: unknown): void {
  const x = object(value, ['sha256', 'byte_length'], 'artifact')
  hex(x.sha256, 32, 'artifact.sha256'); integer(x.byte_length, 1, 32 * 1024 * 1024, 'artifact.byte_length')
}

function p2tr(value: unknown, field: string): void {
  script(value, field)
  if (typeof value !== 'string' || !/^5120[0-9a-f]{64}$/.test(value)) throw new TypeError(`${field}: P2TR required`)
}
function prevout(value: unknown): void {
  const x = object(value, ['txid', 'vout', 'value_sats', 'script_pubkey'], 'prevout')
  outpoint({ txid: x.txid, vout: x.vout }); p2tr(x.script_pubkey, 'prevout.script_pubkey')
  if (!nativeAmount(x.value_sats, 'prevout.value_sats')) throw new TypeError('prevout: positive value required')
}
function artifacts(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new TypeError('input_history: 1..64 artifacts required')
  for (const a of value) artifact(a)
}
function payout(value: Record<string, unknown>, collateral: bigint, minimum: bigint, cap: bigint): void {
  const l = nativeAmount(value.lender_sats), b = nativeAmount(value.borrower_sats), f = nativeAmount(value.fee_sats)
  if (l < minimum || (b !== 0n && b < minimum) || f === 0n || f > cap || l + b + f !== collateral) throw new TypeError('payout: fixed amounts must conserve collateral, respect dust and fee cap')
}
/** Structure/arithmetic only; does not establish signatures, chain, RGB or policy. */
export function validateOnchainTermsV3(value: unknown): asserts value is OnchainLoanTermsV3 {
  const x = object(value, ['v', 'borrower_pk', 'lender_pk', 'platform_pk', 'principal', 'fee', 'collateral_sats', 'oracle_quote', 'open_height', 'maturity_height', 'grace_blocks', 'recovery_height', 'ladder_step', 'ltv_bps', 'prev_passbook_txid', 'nonce', 'settlement'], 'terms')
  if (x.v !== 3) throw new TypeError('terms.v: must be 3')
  for (const k of ['borrower_pk', 'lender_pk', 'platform_pk', 'nonce']) hex(x[k], 32, k)
  if (new Set([x.borrower_pk, x.lender_pk, x.platform_pk]).size !== 3) throw new TypeError('terms: distinct party keys required')
  if (x.prev_passbook_txid !== null) hex(x.prev_passbook_txid, 32, 'prev_passbook_txid')
  const principal = nativeAmount(x.principal), interest = nativeAmount(x.fee), collateral = nativeAmount(x.collateral_sats)
  if (!principal || !collateral || principal + interest > MAX_NATIVE_AMOUNT) throw new TypeError('terms: invalid or overflowing amounts')
  integer(x.open_height, 0, 499_999_999, 'open_height')
  integer(x.maturity_height, x.open_height + 1, 499_999_999, 'maturity_height')
  integer(x.grace_blocks, 1, 499_999_999 - x.maturity_height, 'grace_blocks')
  integer(x.recovery_height, x.maturity_height + x.grace_blocks + 1, 499_999_999, 'recovery_height')
  integer(x.ladder_step, 0, 0xffffffff, 'ladder_step'); integer(x.ltv_bps, 1, 10_000, 'ltv_bps')
  const q = x.oracle_quote
  if (!q || typeof q !== 'object' || Array.isArray(q)) throw new TypeError('oracle_quote: object required')
  const quote = q as Record<string, unknown>
  const allowedQuote = ['price_cents', 'height', 'oracle_pk', 'sig', 'source', 'observed_at', 'sources', 'method', 'usdt_usd', 'dropped', 'averages']
  if (Object.keys(quote).some((k) => !allowedQuote.includes(k))) throw new TypeError('oracle_quote: unknown field')
  integer(quote.price_cents, 1, Number.MAX_SAFE_INTEGER, 'oracle_quote.price_cents')
  integer(quote.height, 0, 499_999_999, 'oracle_quote.height')
  hex(quote.oracle_pk, 32, 'oracle_quote.oracle_pk'); hex(quote.sig, 64, 'oracle_quote.sig')
  if (quote.source !== undefined && !['live_median', 'demo_override', 'configured'].includes(quote.source as string)) throw new TypeError('oracle_quote.source: unsupported')
  if (quote.observed_at !== undefined) integer(quote.observed_at, 0, Number.MAX_SAFE_INTEGER, 'oracle_quote.observed_at')
  if (quote.sources !== undefined) {
    if (!Array.isArray(quote.sources) || quote.sources.length > 16) throw new TypeError('oracle_quote.sources: bounded array required')
    for (const source of quote.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('oracle_quote.sources: object required')
      const s = source as Record<string, unknown>
      if (Object.keys(s).some(k => !['name','price_cents','observed_at','pair','bid_cents','ask_cents'].includes(k))) throw new TypeError('oracle_quote.sources: unknown field')
      text(s.name, 'source.name'); integer(s.price_cents, 1, Number.MAX_SAFE_INTEGER, 'source.price_cents'); integer(s.observed_at, 0, Number.MAX_SAFE_INTEGER, 'source.observed_at')
      if (s.pair !== undefined && !['BTC/USD','BTC/USDT'].includes(s.pair as string)) throw new TypeError('source.pair')
      for (const k of ['bid_cents','ask_cents']) if (s[k] !== undefined) integer(s[k], 1, Number.MAX_SAFE_INTEGER, `source.${k}`)
      if (quote.method !== undefined && (s.pair === undefined || s.bid_cents === undefined || s.ask_cents === undefined)) throw new TypeError('source: complete index book required')
      if (s.bid_cents !== undefined && s.ask_cents !== undefined && (s.bid_cents as number) > (s.ask_cents as number)) throw new TypeError('source: crossed book')
    }
  }
  if (quote.method !== undefined && quote.method !== 'btc-usdt-mid-index-v1') throw new TypeError('oracle_quote.method')
  if (quote.usdt_usd !== undefined) {
    const peg = object(quote.usdt_usd, ['ppm','implied_ppm','sources'], 'oracle_quote.usdt_usd')
    for (const k of ['ppm','implied_ppm']) integer(peg[k],1,Number.MAX_SAFE_INTEGER,`usdt_usd.${k}`)
    if (!Array.isArray(peg.sources) || peg.sources.length < 2 || peg.sources.length > 16) throw new TypeError('usdt_usd.sources')
    for (const value of peg.sources) {
      const src=object(value,['name','bid_ppm','ask_ppm','ppm','observed_at'],'usdt_usd.sources[]')
      text(src.name,'usdt.name')
      for (const k of ['bid_ppm','ask_ppm','ppm']) integer(src[k],1,Number.MAX_SAFE_INTEGER,`usdt.${k}`)
      integer(src.observed_at,0,Number.MAX_SAFE_INTEGER,'usdt.observed_at')
      if ((src.bid_ppm as number)>(src.ask_ppm as number)) throw new TypeError('usdt: crossed book')
    }
  }
  if (quote.method !== undefined && (!quote.usdt_usd || !quote.sources)) throw new TypeError('oracle_quote: full index evidence required')
  if (quote.dropped !== undefined) {
    if (!Array.isArray(quote.dropped) || quote.dropped.length > 32) throw new TypeError('oracle_quote.dropped')
    for (const value of quote.dropped) {
      const d=object(value,['name','pair','reason'],'oracle_quote.dropped[]'); text(d.name,'dropped.name'); text(d.reason,'dropped.reason')
      if (!['BTC/USD','BTC/USDT','USDT/USD'].includes(d.pair as string)) throw new TypeError('dropped.pair')
    }
  }
  if (quote.averages !== undefined) {
    const averages=object(quote.averages,['at','slow','fast'],'oracle_quote.averages')
    integer(averages.at,0,Number.MAX_SAFE_INTEGER,'averages.at')
    for (const k of ['slow','fast']) if (averages[k] !== null) {
      const avg=object(averages[k],['window_ms','price_cents','from','to','samples'],`averages.${k}`)
      for (const name of ['window_ms','price_cents','samples']) integer(avg[name],1,Number.MAX_SAFE_INTEGER,`average.${name}`)
      integer(avg.from,0,Number.MAX_SAFE_INTEGER,'average.from'); integer(avg.to,avg.from as number,Number.MAX_SAFE_INTEGER,'average.to')
      if (avg.to !== averages.at || (avg.to as number)-(avg.from as number) !== avg.window_ms) throw new TypeError('average: inconsistent time window')
    }
  }
  const s = object(x.settlement, ['kind', 'protocol', 'native_revision', 'network', 'collateral_template', 'internal_key', 'input_policy', 'asset', 'debt', 'destinations', 'bitcoin_policy', 'confirmations', 'default_payout', 'liquidation'], 'settlement')
  if (s.kind !== 'rgb-onchain-joint' || s.protocol !== ONCHAIN_CONTRACT || s.native_revision !== ONCHAIN_NATIVE_REVISION) throw new TypeError('settlement: pinned KaleidoSwap joint protocol required')
  if (s.collateral_template !== 'joint-afd-terms/v1' || s.internal_key !== ONCHAIN_NUMS_KEY || s.input_policy !== 'single-nia-exact-amount/v1') throw new TypeError('settlement: unsupported collateral/input template')
  network(s.network); asset(s.asset)
  if (nativeAmount(s.debt, 'debt') !== principal + interest) throw new TypeError('settlement.debt: principal plus interest required')
  const d = object(s.destinations, ['borrower_rgb_script_pubkey', 'lender_rgb_script_pubkey', 'borrower_btc_script_pubkey', 'lender_btc_script_pubkey', 'borrower_change_script_pubkey'], 'destinations')
  for (const [key, val] of Object.entries(d)) p2tr(val, key)
  const bp = object(s.bitcoin_policy, ['fee_payer', 'collateral_return', 'rgb_output_sats', 'min_output_sats', 'origination_fee_cap_sats', 'repayment_fee_cap_sats', 'enforcement_fee_cap_sats', 'recovery_fee_cap_sats'], 'bitcoin_policy')
  if (bp.fee_payer !== 'borrower' || bp.collateral_return !== 'full') throw new TypeError('bitcoin_policy: borrower fees and full collateral return required')
  const minimum = nativeAmount(bp.min_output_sats)
  if (minimum < 330n || minimum > 10_000n || nativeAmount(bp.rgb_output_sats) < minimum || collateral < minimum) throw new TypeError('bitcoin_policy: dust/output bounds')
  for (const key of ['origination_fee_cap_sats', 'repayment_fee_cap_sats', 'enforcement_fee_cap_sats', 'recovery_fee_cap_sats']) if (!nativeAmount(bp[key], key)) throw new TypeError('bitcoin_policy: positive fee cap required')
  const c = object(s.confirmations, ['funding', 'repayment'], 'confirmations')
  integer(c.funding, 1, 1000, 'confirmations.funding'); integer(c.repayment, 1, 1000, 'confirmations.repayment')
  payout(object(s.default_payout, ['lender_sats', 'borrower_sats', 'fee_sats'], 'default_payout'), collateral, minimum, nativeAmount(bp.enforcement_fee_cap_sats))
  const liq = object(s.liquidation, ['policy', 'quote_max_age_blocks', 'templates'], 'liquidation')
  if (liq.policy !== 'passbook-margin-70-80-85-cure10/v1') throw new TypeError('liquidation: unsupported margin/cure policy')
  integer(liq.quote_max_age_blocks, 0, 1000, 'liquidation.quote_max_age_blocks')
  if (!Array.isArray(liq.templates) || liq.templates.length < 1 || liq.templates.length > 32) throw new TypeError('liquidation: 1..32 fixed templates required')
  let previous = ''
  for (const value of liq.templates) {
    const t = object(value, ['id', 'price_ceiling_cents', 'lock_height', 'lender_sats', 'borrower_sats', 'fee_sats'], 'liquidation.template')
    text(t.id, 'template.id')
    if ((t.id as string) <= previous) throw new TypeError('liquidation: unique lexicographically sorted template IDs required')
    previous = t.id as string
    if (!nativeAmount(t.price_ceiling_cents)) throw new TypeError('liquidation: positive price required')
    integer(t.lock_height, x.open_height, x.recovery_height - 1, 'liquidation.lock_height')
    payout(t, collateral, minimum, nativeAmount(bp.enforcement_fee_cap_sats))
  }
}
export function onchainLoanId(terms: OnchainLoanTermsV3): Hex { validateOnchainTermsV3(terms); return hashObject(terms) }
export function validateOnchainIntent(value: unknown, terms: OnchainLoanTermsV3): asserts value is OnchainJointIntent {
  validateOnchainTermsV3(terms)
  if (!value || typeof value !== 'object') throw new TypeError('intent: object required')
  const action = (value as Record<string, unknown>).action
  if (action !== 'origination' && action !== 'repayment') throw new TypeError('intent: unsupported action')
  const common = ['domain', 'action', 'loan_id', 'network', 'asset', 'amount', 'rgb_input', 'borrower_btc_inputs', 'rgb_output_vout', 'borrower_change_vout']
  const x = object(value, [...common, ...(action === 'origination' ? ['collateral_output_vout', 'lender_btc_return_vout'] : ['collateral', 'collateral_return_vout'])], 'intent')
  if (x.domain !== 'passbook-rgb-joint-intent/v1' || x.loan_id !== onchainLoanId(terms)) throw new TypeError('intent: wrong domain or loan')
  network(x.network); asset(x.asset); prevout(x.rgb_input)
  if (hashObject(x.network) !== hashObject(terms.settlement.network) || hashObject(x.asset) !== hashObject(terms.settlement.asset) || x.amount !== (action === 'origination' ? terms.principal : terms.settlement.debt)) throw new TypeError('intent: network/asset/amount mismatch')
  if (!Array.isArray(x.borrower_btc_inputs) || x.borrower_btc_inputs.length > 64 || (action === 'origination' && x.borrower_btc_inputs.length === 0)) throw new TypeError('intent: bounded borrower inputs required')
  const inputs = [x.rgb_input, ...x.borrower_btc_inputs]
  for (const input of x.borrower_btc_inputs) prevout(input)
  if (action === 'repayment') {
    prevout(x.collateral); inputs.push(x.collateral)
    if ((x.collateral as OnchainPrevout).value_sats !== terms.collateral_sats) throw new TypeError('intent: wrong collateral value')
  }
  const ids = inputs.map((i) => { const v = i as OnchainPrevout; return `${v.txid}:${v.vout}` })
  if (new Set(ids).size !== ids.length) throw new TypeError('intent: duplicate input')
  const indices = [x.rgb_output_vout, ...(action === 'origination' ? [x.collateral_output_vout, x.lender_btc_return_vout] : [x.collateral_return_vout])]
  if (x.borrower_change_vout !== null) indices.push(x.borrower_change_vout)
  for (const index of indices) integer(index, 1, 0xffffffff, 'intent.output_vout')
  if (new Set(indices).size !== indices.length) throw new TypeError('intent: duplicate output index')
  if (action === 'origination' ? x.collateral_output_vout !== 1 || x.rgb_output_vout !== 2 || x.lender_btc_return_vout !== 3 || (x.borrower_change_vout !== null && x.borrower_change_vout !== 4) : x.rgb_output_vout !== 1 || x.collateral_return_vout !== 2 || (x.borrower_change_vout !== null && x.borrower_change_vout !== 3)) throw new TypeError('intent: noncanonical joint output layout')
}
export function validateOnchainProposal(value: unknown): asserts value is OnchainJointProposal {
  const p = object(value, ['domain', 'terms', 'intent', 'colored_psbt_base64', 'input_history', 'transfer_consignment'], 'proposal')
  if (p.domain !== 'passbook-rgb-joint-proposal/v1') throw new TypeError('proposal: wrong domain')
  validateOnchainTermsV3(p.terms); validateOnchainIntent(p.intent, p.terms)
  if (typeof p.colored_psbt_base64 !== 'string' || !p.colored_psbt_base64.length || p.colored_psbt_base64.length > 16 * 1024 * 1024) throw new TypeError('proposal: bounded PSBT required')
  artifacts(p.input_history); artifact(p.transfer_consignment)
}
export function validateOnchainEvidence(value: unknown, terms: OnchainLoanTermsV3): asserts value is OnchainRepaymentEvidence {
  const e = object(value, ['domain', 'funding', 'repayment'], 'evidence')
  if (e.domain !== 'passbook-rgb-joint-evidence/v1') throw new TypeError('evidence: wrong domain')
  for (const action of ['funding', 'repayment'] as const) {
    const t = object(e[action], ['intent', 'txid', 'input_history', 'transfer_consignment'], action)
    hex(t.txid, 32, 'txid'); artifacts(t.input_history); artifact(t.transfer_consignment); validateOnchainIntent(t.intent, terms)
    if (t.intent.action !== (action === 'funding' ? 'origination' : 'repayment')) throw new TypeError('evidence: wrong transaction action')
  }
  const funding = e.funding as unknown as OnchainTransactionEvidence<OnchainOriginationIntent>
  const repayment = e.repayment as unknown as OnchainTransactionEvidence<OnchainRepaymentIntent>
  if (repayment.intent.collateral.txid !== funding.txid || repayment.intent.collateral.vout !== funding.intent.collateral_output_vout || repayment.txid === funding.txid) throw new TypeError('evidence: repayment must spend this funding collateral')
}
/** Storage must additionally enforce one live operation across ALL caller keys. */
export function checkIdempotentReplay(previous: Hex | undefined, proposed: Hex): 'new' | 'existing' {
  hex(proposed, 32, 'intent_hash')
  if (previous === undefined) return 'new'
  if (previous !== proposed) throw new Error('IDEMPOTENCY_CONFLICT: key already belongs to another intent')
  return 'existing'
}
