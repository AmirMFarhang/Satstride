import type { Hex, KeyPair } from '../core/crypto.js'
import type { SignedRunRecord } from '../sandbox/run-record.js'
import type { Bundle } from '../sandbox/types.js'
import type { FindingType, PublicInvestigation } from '../sandbox/investigation-types.js'
import type { ConsentReceipt } from './consent.js'
import type { ScorerProviderKind, TrustLevel } from './trust.js'

export const RECOMMENDATIONS = ['QUALIFY', 'QUALIFY_WITH_HAIRCUT', 'DECLINE', 'ESCALATE'] as const
export type Recommendation = (typeof RECOMMENDATIONS)[number]

/**
 * The loan a bundle asked for, as outputs v2 name it (scoring contract 1.3.0): the loan request, the asset and a hash of
 * the lender requirements. A lender never sees the bundle; this is how it knows which loan was scored.
 */
export interface ScoredLoan {
  loan_request: { principal: number; fee: number; term_blocks: number; grace_blocks: number }
  asset_id: string
  lender_requirements_hash: Hex
}

/**
 * The one result shape every provider releases. Numbers only as a 1,000 USDT income band, besides the loan request.
 * v2 (contract 1.3.0) names the scored loan; v1 is historical evidence issued under contract 1.2.0.
 */
export interface PassbookCheckOutputs extends Partial<ScoredLoan> {
  v: 1 | 2
  kind: 'passbook-check-outputs'
  recommendation: Recommendation
  income_band: string
  
  checks: { id: string; ok: boolean }[]
  
  findings: { type: FindingType }[]
  lender_note: string
  borrower_pk: Hex
  lender_pk: Hex
  purpose_id: string
  bundle_hash: Hex
}

export interface ScorerDescriptor {
  v: 1
  provider: ScorerProviderKind
  scorer_id: string
  /** Claimed level; the verifier grants it only with matching evidence. */
  trust: TrustLevel
  
  code_measurement: string
  
  contract_hash: Hex
  /** In-process and container: the key bundles are encrypted to and results are signed with. */
  enclave_pubkey?: Hex
  /** Container: the operator that runs the image declares its enclave key. */
  operator_declaration?: { operator_pk: Hex; sig: Hex }
  /** In-process and container: the enclave key over every field except `operator_declaration` and `sig`. */
  sig?: Hex
}

export interface EncryptedCheckRequest {
  v: 1
  kind: 'passbook-check-request'
  sender_pk: Hex
  enclave_pubkey: Hex
  contract_hash: Hex
  consent_hash: Hex
  /** NIP-44 v2 from the sender to the enclave key */
  ciphertext: string
}

/** In-process and container evidence: the sandbox's own signed run record. */
export interface SignedCheckResult {
  v: 1
  kind: 'passbook-check-result'
  scorer: Required<Pick<ScorerDescriptor, 'provider' | 'scorer_id' | 'trust' | 'code_measurement' | 'contract_hash' | 'enclave_pubkey'>>
  request_hash: Hex
  consent_hash: Hex
  height: number
  outputs: PassbookCheckOutputs
  evidence: { investigation: PublicInvestigation; run_record: SignedRunRecord }
  sig: Hex
}

export type ScorerOutcome =
  | { kind: 'passbook-signed'; descriptor: ScorerDescriptor; result: SignedCheckResult; fallback: boolean }
  | { kind: 'external-evidence'; descriptor: ScorerDescriptor; evidence: unknown; outputs: PassbookCheckOutputs; reference?: string; fallback: boolean }

export interface ScorerProvider {
  readonly kind: ScorerProviderKind
  describe(): Promise<ScorerDescriptor>
  /** Runs on the borrower's side, sending data only to `verified`: the descriptor that passed the borrower's checks. */
  check(bundle: Bundle, consent: ConsentReceipt, borrower: KeyPair, verified: ScorerDescriptor): Promise<ScorerOutcome>
}
