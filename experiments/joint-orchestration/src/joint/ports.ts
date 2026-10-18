// What the joint-loan orchestration needs besides the native adapter (#56's
// OnchainNativeAdapter). Each port is implemented by the party's own wallet side:
// the desktop native owner, or the phone's local adapter (keys and signing stay
// on the phone). Nothing here moves money by itself; the orchestration decides
// the order and refuses anything the agreed terms do not allow.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Hex } from '../core/crypto.js'
import type {
  DecimalAmount, OnchainArtifact, OnchainDecodedSummary, OnchainLoanTermsV3, OnchainNativeContext,
  OnchainNativePreparation, OnchainPrevout, OnchainSigningAuthorization,
} from './contract-stub.js'

export type JointRole = 'borrower' | 'lender'
export type JointAction = 'origination' | 'repayment'
/** Exported signatures: the two funding/repayment signatures and the borrower's enforcement pre-signatures. */
export type JointSigningKind = JointAction | 'default' | 'liquidation'

/**
 * What negotiation hands to both parties: the countersigned v3 terms, their id
 * and the opaque out-of-band receive ids each side created before the terms
 * (their scripts are already in `terms.settlement.destinations`).
 */
export interface JointAgreement {
  terms: OnchainLoanTermsV3
  /** #56 `onchainLoanId(terms)`, computed by negotiation with the merged contract */
  loan_id: Hex
  borrower_recipient_id: string
  lender_recipient_id: string
}

/** This party's local identities. `receive_id` is its own receive handle (the principal for B, the debt for L). */
export interface JointLocal {
  role: JointRole
  wallet_id: string
  receive_id: string
}

export interface JointSigningRequest {
  role: JointRole
  kind: JointSigningKind
  loan_id: Hex
  terms: OnchainLoanTermsV3
  operation_id: string
  intent_hash: Hex
  /** for an enforcement child, the parent origination proposal hash */
  proposal_hash: Hex
  decoded_summary: OnchainDecodedSummary
  decoded_summary_hash: Hex
}

/**
 * The party's locally pinned policy gate (limits, kill switch, approvals). It
 * returns #56's signing authorization or throws; it never signs a PSBT.
 */
export interface JointSigningGate {
  authorize(request: JointSigningRequest): Promise<OnchainSigningAuthorization>
}

/** Adds this party's own signatures (wallet inputs and its collateral leaf) to the PSBT. */
export interface JointPartySigner {
  sign(context: OnchainNativeContext, request: { operation_id: string; psbt_base64: string; authorization: OnchainSigningAuthorization }): Promise<string>
}

/** The borrower's funding contribution to origination, sent to the lender. */
export interface BorrowerFunding {
  borrower_btc_inputs: OnchainPrevout[]
  /** what the borrower agrees to pay in Bitcoin fees; never above the origination cap */
  fee_sats: DecimalAmount
}

/**
 * Builds the canonical unsigned transaction for the RGB sender (lender at
 * origination, borrower at repayment), in the exact layout #56 fixes.
 */
export interface JointTxBuilder {
  origination(agreement: JointAgreement, funding: BorrowerFunding): Promise<Omit<OnchainNativePreparation, 'context'>>
  repayment(agreement: JointAgreement, collateral: OnchainPrevout, fee_cap_sats: DecimalAmount): Promise<Omit<OnchainNativePreparation, 'context'>>
}

/**
 * Reads the actual bytes of a locally held artifact so they can be handed to the
 * counterparty before it signs. #56's adapter imports artifacts but has no read;
 * the native owner already has one (artifact_get).
 */
export interface JointArtifactSource {
  read(context: OnchainNativeContext, artifact: OnchainArtifact): Promise<string>
}

export class JointRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'JointRefused'
  }
}

/** Durable state per (role, loan). Written before any message leaves. */
export interface JointStore {
  load(key: string): unknown | undefined
  save(key: string, value: unknown): void
}

export class MemoryJointStore implements JointStore {
  readonly #records = new Map<string, string>()
  load(key: string): unknown | undefined {
    const v = this.#records.get(key)
    return v === undefined ? undefined : JSON.parse(v)
  }
  save(key: string, value: unknown): void { this.#records.set(key, JSON.stringify(value)) }
}

/** One JSON file per loan and role, replaced atomically (write, then rename). */
export class FileJointStore implements JointStore {
  constructor(private readonly dir: string) {}
  #path(key: string): string {
    if (!/^[a-z]+-[0-9a-f]{64}$/.test(key)) throw new JointRefused('JOINT_STORE_KEY', key)
    return `${this.dir}/${key}.json`
  }
  load(key: string): unknown | undefined {
    const path = this.#path(key)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
  }
  save(key: string, value: unknown): void {
    const path = this.#path(key)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
}

/**
 * The v3 contract is not live (#56 `ONCHAIN_V3_LIVE_ENABLED = false`). The only
 * way to run this orchestration is an explicit isolated regtest acceptance.
 */
export interface JointOptions {
  activation: 'isolated-regtest-acceptance'
  /** seconds; defaults to the wall clock */
  now?: () => number
}
