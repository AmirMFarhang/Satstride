// Independent Protocol candidate. No live check-node imports this module.
// Structural/signature checks do not replace native RGB or Bitcoin validation.
import * as ecc from 'tiny-secp256k1'
import { hashObject, hexToBytes, sha256Hex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { HEX32_PATTERN, HEX64_PATTERN, schemaErrors, type JsonSchema } from '../core/schema.js'

export const CHECK_NATIVE_REVISION = '5f655a9cd02d23996d4d79e6d5f4e6add0301197' as const
export const CHECK_NATIVE_REPOSITORY = 'https://github.com/kaleidoswap/rgb-lib' as const
export const CHECK_PAYMENT_CONTRACT = 'passbook-check-payment/v2' as const
export const CHECK_PAYMENT_RAIL = 'rgb-onchain-htlc-bounded/v1' as const
export const CHECK_PAYMENT_ASSURANCE = 'operator-disclosure-reorg-risk/v1' as const
export const CHECK_NUMS_KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'
export const CHECK_REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
export const ONCHAIN_CHECK_LIVE_ENABLED = false as const
const U64_MAX = (1n << 64n) - 1n

/** Even approved bounded exposure is not permission to activate an unfinished rail. */
export function assertOnchainCheckActivationAllowed(): never {
  throw new Error('ONCHAIN_CHECK_DISABLED: merged foundations, native adapter, exact HTLC proofs and G4 recovery acceptance required')
}

export interface CheckPurchaseScope {
  wallet_id: Hex
  borrower_pk: Hex
  lender_pk: Hex
  negotiation_id: Hex
  /** Stable scope from the payer-approved check plan; not a new nonce per retry. */
  assessment_scope: Hex
  /** Authorised plan positions only (e.g. distinct approved providers for 2-of-N). */
  check_index: number
}

/** Deliberately excludes operator, transport ID, nonce and purchase ID. */
export function checkPurchaseSlot(scope: CheckPurchaseScope): Hex {
  const errors = schemaErrors(scope, SCOPE_SCHEMA)
  if (errors.length) throw new TypeError(errors.join('; '))
  return hashObject({ domain: 'passbook-check-purchase-slot/v2', scope })
}

/** A native backend must index this identity across *all* callers, atomically. */
export interface CheckPaymentQuote {
  v: 2
  contract: typeof CHECK_PAYMENT_CONTRACT
  rail: typeof CHECK_PAYMENT_RAIL
  assurance: typeof CHECK_PAYMENT_ASSURANCE
  native_repository: typeof CHECK_NATIVE_REPOSITORY
  native_revision: typeof CHECK_NATIVE_REVISION
  network: 'regtest'
  genesis: typeof CHECK_REGTEST_GENESIS
  scope: CheckPurchaseScope
  slot_id: Hex
  purchase_id: Hex
  /** Same approved plan on all retries. Changing its index is another approval. */
  check_plan_hash: Hex
  payer_pk: Hex
  operator_pk: Hex
  request_hash: Hex
  request_nonce: Hex
  consent_hash: Hex
  offer_hash: Hex
  release_hash: Hex
  plaintext_hash: Hex
  ciphertext_hash: Hex
  key_hash: Hex
  asset: { contract_id: string; schema_id: string; precision: number; amount: string; kind: 'payment' | 'voucher' }
  input_policy: 'one-exact-nia-allocation/v1'
  /** Per-purchase counterparty acceptance. No quote can claim atomic fairness. */
  risk: { operator_accepts_disclosure_refund_reorg_loss: true; payer_accepts_conditional_finality: true; atomic_required: false }
  timing: {
    quoted_tip: number
    funding_confirmations: number
    claim_confirmations: number
    claim_before_height: number
    refund_height: number
  }
  bitcoin: {
    lock_value_sat: string
    claim_value_sat: string
    refund_value_sat: string
    funding_fee_cap_sat: string
    claim_fee_cap_sat: string
    refund_fee_cap_sat: string
    /** Taproot destinations; extra fee inputs must be native-proven RGB-free. */
    claim_script_pubkey: Hex
    refund_script_pubkey: Hex
    fee_payer: 'payer'
    claim_fee_payer: 'operator'
    refund_fee_payer: 'payer'
  }
  retention: {
    raw_bundle_seconds: 0
    /** Both encrypted response and K are recoverable result material. */
    recovery: 'encrypted-until-ack-or-expiry/v1'
    recovery_expires_at: number
    /** K in an exported claim/witness can survive local recovery-vault purge. */
    exported_claims: 'key-disclosure-cannot-be-erased/v1'
    /** Nonsecret dedupe records survive result purge; deletion is not retry permission. */
    tombstone: 'retain-no-secret-payment-references/v1'
  }
  receipt: 'signed-record-only' | 'optional-rgb-uda'
  issued_at: number
  expires_at: number
}

const hex32: JsonSchema = { type: 'string', pattern: HEX32_PATTERN }
const uint = (min: number, max: number): JsonSchema => ({ type: 'integer', minimum: min, maximum: max })
const literal = (value: string): JsonSchema => ({ type: 'string', const: value })
const text = (max = 200): JsonSchema => ({ type: 'string', minLength: 1, maxLength: max })
const u64: JsonSchema = { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$' }
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const height = uint(1, 499_999_999)
const timestamp = uint(1, Number.MAX_SAFE_INTEGER)
const taproot: JsonSchema = { type: 'string', pattern: '^5120[0-9a-f]{64}$' }
const SCOPE_SCHEMA = object({ wallet_id: hex32, borrower_pk: hex32, lender_pk: hex32, negotiation_id: hex32, assessment_scope: hex32, check_index: uint(0, 7) })

export const CHECK_PAYMENT_QUOTE_SCHEMA = object({
  v: { type: 'integer', const: 2 }, contract: literal(CHECK_PAYMENT_CONTRACT), rail: literal(CHECK_PAYMENT_RAIL),
  assurance: literal(CHECK_PAYMENT_ASSURANCE), native_repository: literal(CHECK_NATIVE_REPOSITORY), native_revision: literal(CHECK_NATIVE_REVISION),
  network: literal('regtest'), genesis: literal(CHECK_REGTEST_GENESIS),
  scope: SCOPE_SCHEMA, slot_id: hex32, purchase_id: hex32, check_plan_hash: hex32,
  payer_pk: hex32, operator_pk: hex32, request_hash: hex32, request_nonce: hex32,
  consent_hash: hex32, offer_hash: hex32, release_hash: hex32, plaintext_hash: hex32,
  ciphertext_hash: hex32, key_hash: hex32,
  asset: object({ contract_id: text(), schema_id: text(), precision: uint(0, 18), amount: u64, kind: { type: 'string', enum: ['payment', 'voucher'] } }),
  input_policy: literal('one-exact-nia-allocation/v1'),
  risk: object({ operator_accepts_disclosure_refund_reorg_loss: { type: 'boolean', const: true }, payer_accepts_conditional_finality: { type: 'boolean', const: true }, atomic_required: { type: 'boolean', const: false } }),
  timing: object({ quoted_tip: height, funding_confirmations: uint(1, 144), claim_confirmations: uint(1, 144), claim_before_height: height, refund_height: height }),
  bitcoin: object({
    lock_value_sat: u64, claim_value_sat: u64, refund_value_sat: u64,
    funding_fee_cap_sat: u64, claim_fee_cap_sat: u64, refund_fee_cap_sat: u64,
    claim_script_pubkey: taproot, refund_script_pubkey: taproot,
    fee_payer: literal('payer'), claim_fee_payer: literal('operator'), refund_fee_payer: literal('payer'),
  }),
  retention: object({ raw_bundle_seconds: { type: 'integer', const: 0 }, recovery: literal('encrypted-until-ack-or-expiry/v1'), recovery_expires_at: timestamp, exported_claims: literal('key-disclosure-cannot-be-erased/v1'), tombstone: literal('retain-no-secret-payment-references/v1') }),
  receipt: { type: 'string', enum: ['signed-record-only', 'optional-rgb-uda'] }, issued_at: timestamp, expires_at: timestamp,
})

/** Only syntax, explicit acceptance and arithmetic. No asset proof or chain claim. */
export function checkQuoteProblems(value: unknown): string[] {
  const errors = schemaErrors(value, CHECK_PAYMENT_QUOTE_SCHEMA)
  if (errors.length) return errors.map((e) => `CHECK_QUOTE_SCHEMA ${e}`)
  const q = value as CheckPaymentQuote
  const problems: string[] = []
  if (checkPurchaseSlot(q.scope) !== q.slot_id) problems.push('CHECK_SLOT_MISMATCH')
  for (const pk of [q.payer_pk, q.operator_pk, q.scope.borrower_pk, q.scope.lender_pk]) {
    if (!ecc.isXOnlyPoint(hexToBytes(pk))) problems.push('CHECK_PARTY_NOT_A_POINT')
  }
  if (q.scope.borrower_pk === q.scope.lender_pk) problems.push('CHECK_BORROWER_IS_LENDER')
  if (![q.scope.borrower_pk, q.scope.lender_pk].includes(q.payer_pk)) problems.push('CHECK_PAYER_NOT_A_PARTY')
  if ([q.scope.borrower_pk, q.scope.lender_pk].includes(q.operator_pk)) problems.push('CHECK_OPERATOR_IS_LOAN_PARTY')
  const amounts = [q.asset.amount, ...Object.entries(q.bitcoin).filter(([k]) => k.endsWith('_sat')).map(([, v]) => v)]
  for (const amount of amounts) {
    if (BigInt(amount) <= 0n || BigInt(amount) > U64_MAX) problems.push('CHECK_AMOUNT_OUT_OF_U64_RANGE')
  }
  if (q.asset.kind === 'voucher' && q.asset.amount !== '1') problems.push('CHECK_VOUCHER_NOT_ONE_UNIT')
  for (const script of [q.bitcoin.claim_script_pubkey, q.bitcoin.refund_script_pubkey]) {
    if (!ecc.isXOnlyPoint(hexToBytes(script.slice(4)))) problems.push('CHECK_DESTINATION_NOT_A_POINT')
  }
  if (q.bitcoin.claim_script_pubkey === q.bitcoin.refund_script_pubkey) problems.push('CHECK_CLAIM_EQUALS_REFUND_DESTINATION')
  // The Q sats fund the receiving output; separate RGB-free fee inputs pay fees.
  if (q.bitcoin.lock_value_sat !== q.bitcoin.claim_value_sat || q.bitcoin.lock_value_sat !== q.bitcoin.refund_value_sat) problems.push('CHECK_Q_VALUE_NOT_PRESERVED')
  if (BigInt(q.bitcoin.lock_value_sat) < 330n) problems.push('CHECK_Q_VALUE_BELOW_P2TR_DUST_FLOOR')
  const t = q.timing
  if (t.claim_before_height <= t.quoted_tip + t.funding_confirmations) problems.push('CHECK_NO_FUNDING_CLAIM_WINDOW')
  if (t.refund_height < t.claim_before_height + t.claim_confirmations) problems.push('CHECK_NO_CLAIM_CONFIRMATION_MARGIN')
  if (t.refund_height - t.quoted_tip > 2016) problems.push('CHECK_REFUND_WINDOW_TOO_LONG')
  if (q.expires_at <= q.issued_at || q.expires_at - q.issued_at > 3600) problems.push('CHECK_QUOTE_EXPIRY')
  if (q.retention.recovery_expires_at <= q.expires_at || q.retention.recovery_expires_at - q.issued_at > 604800) problems.push('CHECK_RECOVERY_EXPIRY')
  return problems
}

export function checkQuoteHash(q: CheckPaymentQuote): Hex {
  const problems = checkQuoteProblems(q)
  if (problems.length) throw new TypeError(problems.join('; '))
  return hashObject({ domain: 'passbook-check-payment-quote/v2', quote: q })
}

export type CheckApprovalRole = 'payer-spend' | 'operator-risk' | 'borrower-processing'
export interface CheckQuoteApproval {
  v: 1
  domain: 'passbook-check-payment-approval/v2'
  quote_hash: Hex
  role: CheckApprovalRole
  actor_pk: Hex
  sig: Hex
}
const APPROVAL_SCHEMA = object({ v: { type: 'integer', const: 1 }, domain: literal('passbook-check-payment-approval/v2'), quote_hash: hex32, role: { type: 'string', enum: ['payer-spend', 'operator-risk', 'borrower-processing'] }, actor_pk: hex32, sig: { type: 'string', pattern: HEX64_PATTERN } })

const roleKey = (q: CheckPaymentQuote, role: CheckApprovalRole) => role === 'payer-spend' ? q.payer_pk : role === 'operator-risk' ? q.operator_pk : q.scope.borrower_pk
export function signCheckQuoteApproval(q: CheckPaymentQuote, role: CheckApprovalRole, actor: KeyPair): CheckQuoteApproval {
  if (actor.pubkey !== roleKey(q, role)) throw new Error('CHECK_APPROVAL_WRONG_ACTOR')
  return signObject({ v: 1 as const, domain: 'passbook-check-payment-approval/v2' as const, quote_hash: checkQuoteHash(q), role, actor_pk: actor.pubkey }, actor.secretKey)
}

/** The processing signature additionally accepts the exact recovery expiry. */
export function checkQuoteSignatureProblems(q: CheckPaymentQuote, approvals: unknown): string[] {
  const problems = checkQuoteProblems(q)
  if (problems.length) return problems
  if (!Array.isArray(approvals) || approvals.length !== 3) return [...problems, 'CHECK_APPROVAL_SET_REQUIRED']
  const seen = new Set<string>()
  for (const a of approvals) {
    if (schemaErrors(a, APPROVAL_SCHEMA).length) { problems.push('CHECK_APPROVAL_SCHEMA'); continue }
    const approval = a as CheckQuoteApproval
    if (seen.has(approval.role)) problems.push('CHECK_APPROVAL_DUPLICATE_ROLE')
    seen.add(approval.role)
    if (approval.quote_hash !== checkQuoteHash(q) || approval.actor_pk !== roleKey(q, approval.role) || !verifyObject(approval, approval.actor_pk)) problems.push('CHECK_APPROVAL_INVALID')
  }
  if (seen.size !== 3) problems.push('CHECK_APPROVAL_SET_REQUIRED')
  return problems
}

/** First reservation/funding only. Expiry never invalidates stored recovery authority. */
export function checkQuoteAdmissionProblems(q: CheckPaymentQuote, approvals: unknown, now: number): string[] {
  const problems = checkQuoteSignatureProblems(q, approvals)
  if (!Number.isSafeInteger(now) || now < q.issued_at || now >= q.expires_at) problems.push('CHECK_QUOTE_NOT_CURRENT')
  return problems
}

export function assertCheckWholeTransactionSighash(sighash: number): void {
  if (sighash !== 0 && sighash !== 1) throw new Error('CHECK_WHOLE_TRANSACTION_SIGHASH_REQUIRED')
}

/** Content-addressed bytes must resolve locally; a reference is not verification. */
export interface CheckArtifact { sha256: Hex; bytes_base64: string }
export type CheckOperationStage = 'fund' | 'claim' | 'refund'
export interface CheckPreparedOperation {
  v: 1
  domain: 'passbook-check-prepared/v2'
  slot_id: Hex
  quote_hash: Hex
  stage: CheckOperationStage
  native_operation_id: string
  unsigned_psbt: CheckArtifact
  /** Complete actual input histories and Q/payout consignments for this stage. */
  proof_artifacts: CheckArtifact[]
  decoded_summary: CheckArtifact
}

/** Checks byte commitments, not PSBT/RGB semantics or signer policy. */
export function checkPreparedOperationHash(q: CheckPaymentQuote, prepared: CheckPreparedOperation): Hex {
  const artifact = object({ sha256: hex32, bytes_base64: { type: 'string', minLength: 4, maxLength: 22369624 } })
  const errors = schemaErrors(prepared, object({
    v: { type: 'integer', const: 1 }, domain: literal('passbook-check-prepared/v2'),
    slot_id: hex32, quote_hash: hex32, stage: { type: 'string', enum: ['fund', 'claim', 'refund'] },
    native_operation_id: text(), unsigned_psbt: artifact,
    proof_artifacts: { type: 'array', minItems: 1, maxItems: 64, items: artifact }, decoded_summary: artifact,
  }))
  if (errors.length) throw new TypeError(errors.join('; '))
  if (prepared.slot_id !== q.slot_id || prepared.quote_hash !== checkQuoteHash(q)) throw new Error('CHECK_PREPARED_OTHER_QUOTE')
  let totalBytes = 0
  for (const a of [prepared.unsigned_psbt, ...prepared.proof_artifacts, prepared.decoded_summary]) {
    const bytes = Buffer.from(a.bytes_base64, 'base64')
    totalBytes += bytes.length
    if (totalBytes > 16 * 1024 * 1024) throw new Error('CHECK_PREPARED_ARTIFACT_BUDGET')
    if (bytes.length === 0 || bytes.toString('base64') !== a.bytes_base64 || sha256Hex(bytes) !== a.sha256) throw new Error('CHECK_ARTIFACT_BYTES_NOT_COMMITTED')
  }
  return hashObject(prepared)
}

export interface CheckOperationApproval {
  v: 1
  domain: 'passbook-check-operation-approval/v2'
  quote_hash: Hex
  prepared_hash: Hex
  stage: CheckOperationStage
  actor_pk: Hex
  sig: Hex
}

export interface CheckDeliveryAcknowledgment {
  v: 1
  domain: 'passbook-check-delivery-ack/v2'
  quote_hash: Hex
  plaintext_hash: Hex
  payer_pk: Hex
  sig: Hex
}

/** Export still requires the native wallet's own decoded-policy gate. */
export function signCheckOperationApproval(q: CheckPaymentQuote, prepared: CheckPreparedOperation, actor: KeyPair): CheckOperationApproval {
  const expected = prepared.stage === 'claim' ? q.operator_pk : q.payer_pk
  if (actor.pubkey !== expected) throw new Error('CHECK_OPERATION_WRONG_ACTOR')
  return signObject({ v: 1 as const, domain: 'passbook-check-operation-approval/v2' as const, quote_hash: checkQuoteHash(q), prepared_hash: checkPreparedOperationHash(q, prepared), stage: prepared.stage, actor_pk: actor.pubkey }, actor.secretKey)
}

export function checkOperationApprovalProblems(q: CheckPaymentQuote, prepared: CheckPreparedOperation, value: unknown): string[] {
  const errors = schemaErrors(value, object({ v: { type: 'integer', const: 1 }, domain: literal('passbook-check-operation-approval/v2'), quote_hash: hex32, prepared_hash: hex32, stage: { type: 'string', enum: ['fund', 'claim', 'refund'] }, actor_pk: hex32, sig: { type: 'string', pattern: HEX64_PATTERN } }))
  if (errors.length) return ['CHECK_OPERATION_APPROVAL_SCHEMA']
  const a = value as CheckOperationApproval
  const expected = prepared.stage === 'claim' ? q.operator_pk : q.payer_pk
  try {
    if (a.quote_hash !== checkQuoteHash(q) || a.prepared_hash !== checkPreparedOperationHash(q, prepared) || a.stage !== prepared.stage || a.actor_pk !== expected || !verifyObject(a, expected)) return ['CHECK_OPERATION_APPROVAL_INVALID']
  } catch { return ['CHECK_OPERATION_APPROVAL_INVALID'] }
  return []
}

export interface CheckOutpoint { txid: Hex; vout: number }
export interface CheckFundingEvidence {
  quote_hash: Hex
  txid: Hex
  q: CheckOutpoint
  block_hash: Hex
  height: number
  confirmations: number
  funding_psbt: CheckArtifact
  input_history: CheckArtifact[]
  q_consignment: CheckArtifact
}
export interface CheckSpendEvidence {
  quote_hash: Hex
  funding_txid: Hex
  spent_q: CheckOutpoint
  outcome: 'claim' | 'refund'
  txid: Hex
  block_hash: Hex
  height: number
  confirmations: number
  finalized_psbt: CheckArtifact
  payout_consignment: CheckArtifact
  /** Disclosure evidence only; verifying this does not establish RGB payment. */
  witness_key: Hex | null
}

/** Payment facts can roll back; observed K and exported signatures cannot. */
export interface CheckPurchaseSnapshot {
  slot_id: Hex
  quote_hash: Hex
  operation_id: string
  /** Public status returns hashes only: a signed claim contains K. */
  exported_payload_hashes: Hex[]
  key_observed: boolean
  report_verified: boolean
  chain: 'pending' | 'claim-confirmed' | 'refund-confirmed' | 'reorged'
  native_receive: 'not-validated' | 'validated' | 'settled-spendable'
  receipt: 'not-requested' | 'pending' | 'received' | 'failed'
}

/**
 * Port for a future main-based G4 adapter, not an implementation or loan-port copy.
 * All effects require wallet-local governance checks against decoded tx+RGB bytes.
 */
export interface OnchainCheckNativePort {
  readonly revision: typeof CHECK_NATIVE_REVISION
  /** Atomically acquire scope's slot across callers; changed quote conflicts.
   * Supplied request/chain bytes are ephemeral: after validation, persist only
   * authenticated admission metadata/hashes, never raw-bundle ciphertext that
   * the operator's retained keys could decrypt. The report has a separate TTL. */
  reservePurchase(quote: CheckPaymentQuote, approvals: CheckQuoteApproval[], artifacts: {
    signed_check_plan: CheckArtifact; signed_consent: CheckArtifact; signed_request: CheckArtifact
    signed_offer: CheckArtifact; signed_release: CheckArtifact; signed_message_chain: CheckArtifact
    sealed_result: CheckArtifact
  }): Promise<CheckPurchaseSnapshot>
  /** Operator-local authenticated path only; verify key hash, ciphertext+plaintext
   * binding and fsync encrypted recovery material before first claim export.
   * Never return K in the public snapshot, error messages or evidence artifact. */
  retainOperatorResult(slot: Hex, private_material: { key_hex: Hex; sealed_result: CheckArtifact }): Promise<void>
  /** Verify payer's signature, quote and exact report hash before early recovery
   * purge. A transport ACK or third party cannot authorize this operation. */
  acknowledgeDelivery(slot: Hex, ack: CheckDeliveryAcknowledgment): Promise<void>
  /** Create exactly Q plus RGB-free change, with final RGB commitment before signing. */
  prepareFunding(slot: Hex): Promise<CheckPreparedOperation>
  /** Operator imports and durably retains actual Q proof before any disclosure. */
  verifyFunding(slot: Hex, funding: CheckFundingEvidence): Promise<void>
  /** Final claim and refund RGB proofs are locally validated before signatures. */
  prepareSpend(slot: Hex, outcome: 'claim' | 'refund'): Promise<CheckPreparedOperation>
  /** Recheck quote admission immediately before FIRST funding export; a prior
   * reservation cannot extend expiry. Already exported funding uses retained
   * authority for reconciliation/refund. A new claim export separately checks
   * current funding, cutoff, recovery material, fee caps and native proof. */
  exportAndBroadcast(slot: Hex, prepared: CheckPreparedOperation, local_approval: CheckOperationApproval): Promise<{ txid: Hex }>
  reconcile(slot: Hex): Promise<CheckPurchaseSnapshot>
  /** Sender apply alone does not count: OOB handover, refresh, usable balance. */
  receive(slot: Hex, evidence: CheckSpendEvidence): Promise<CheckPurchaseSnapshot>
  /** Only before durable proof of zero executable authorization export. */
  abortBeforeExport(slot: Hex): Promise<void>
}
