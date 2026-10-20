// The lender node. It publishes an offer, underwrites an application from a
// borrower it has never met (sandbox signature, attestation, each disclosed
// inflow re-verified on its own, a borrower-carried passbook checked directly against Bitcoin), prices it, funds in USDT over RGB once it holds
// the borrower's split signature, has the platform issue the repayment invoice
// on a per-loan repayment account (so the platform can validate the repayment
// too), confirms the repayment in that account, and co-signs the release. If the
// price falls and a margin call runs out its cure window, it liquidates through
// leaf B with the platform. Policy computes every financial number; the local
// model searches for evidence and drafts explanatory text.

import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { SimplePool } from 'nostr-tools'
import { bytesToHex, canonicalJson, hashObject, isHex, randomHex, verifyHash, verifyObject, type Hex } from '../core/crypto.js'
import { RuleReasoner } from '../ai/rule-reasoner.js'
import { publishedRunMaterials } from '../sandbox/published-materials.js'
import { verifyRunRecord } from '../sandbox/run-record.js'
import { INVESTIGATION_BUDGETS, INVESTIGATION_SYSTEM_PROMPT, INVESTIGATION_TOOL_DEFINITIONS } from '../sandbox/investigate.js'
import { investigationAccepted } from '../sandbox/investigation-policy.js'
import { btc, collateralFor, ltvBps, MICRO_PER_USDT, pct, usdt, type Bps, type Micro, type Sats } from '../core/money.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm, termInterest, type Economics } from '../core/economics.js'
import { debtOf, termsHash, validateTerms, type LoanTerms } from '../core/terms.js'
import {
  addLeafSignature,
  buildEscrowSpend,
  escrowFor,
  describe as describePsbt,
  extractHex,
  finalizeEscrowSpend,
  leafSignature,
  liquidationOutputs,
  partiesOf,
  psbtFromBase64,
  releaseOutputs,
  splitLocktime,
  splitOutputs,
  unsignedTxid,
  verifyLeafSignature,
  keyPathOutput,
} from '../escrow/escrow.js'
import { KIND } from '../market/kinds.js'
import type { AtomicRepaidPayload, AcceptancePayload, ApplicationPayload, FundedPayload, OfferPayload, RepaidPayload, SignaturePayload, SignRequestPayload } from '../market/messages.js'
import { verifyQuote } from '../oracle/oracle.js'
import { liquidationDue, type LiquidationDue } from '../registry/ladder.js'
import { atomicWitnessPreimage } from '../registry/passbook-doc.js'
import { verifyOwnership, type IouOwnership, type NoteSale } from '../market/iou.js'
import { verifyObject as verifyReceipt } from '../core/crypto.js'
import { verifyPassbook, rgbRepaymentReceipt, type RgbRepaymentReceipt } from '../registry/passbook-doc.js'
import type { Attestation } from '../sandbox/broker.js'
import type { LenderSandboxResult } from '../sandbox/types.js'
import { fundingNotice, repaymentAck, repaymentWatchRequest, type Check } from '../server/platform.js'
import type { FeeRecord } from '../server/fees.js'
import { lenderReturnLine } from '../market/termsheet.js'
import { openRepaymentAccount, repaymentMnemonic, watchKeys } from '../rgb/watch.js'
import { awaitSettled, RgbWallet } from '../rgb/wallet.js'
import { createAtomicRepayment, verifyPreimage, RgbLightningNode, type RgbLightningClient } from '../rgb/lightning.js'
import { Agent, type AgentDeps } from './agent.js'
import { approvalStatus, approve as approveSheet, type Approval } from '../market/approvals.js'
import { verifyTranscript, type EngineParams, type NegotiationMessage, type Position } from '../market/negotiate.js'
import { awaitNegotiation, keyPairSigner, negotiationTerms, poolTransport, type NegotiationResult } from '../market/negotiate-nostr.js'
import type { Event } from '../market/messages.js'
import type { LogEntry } from '../governance/log.js'
import type { GovernancePolicy } from '../governance/policy.js'
// Lane P2's lender half of a lender-paid check (src/agents/lender-check.ts).
import { receiveBorrowerCheckPart, runLenderCheck, type LenderCheckResult, type RunLenderCheckOptions } from './lender-check.js'
import { policyValid, type LenderPolicy as MarketLenderPolicy } from '../market/policy.js'
import { buildTermSheet, renderTermSheet, signTermSheet, termSheetHash, termSheetProblems, type TermSheet, type TermSheetEvidence, type TermSheetScorer } from '../market/termsheet.js'
import { evidenceDigest, runRecordDigest, sheetDigestProblems } from '../scorer/evidence-digest.js'
import { consentHash } from '../scorer/consent.js'
import { bundleTermsProblems, scoredSheetProblems } from '../scorer/bundle-terms.js'
import { sandboxProvider, sandboxScorerId } from '../sandbox/provenance.js'
import { contractHash, loadScoringContract } from '../scorer/contract.js'
import { recommend } from '../scorer/providers.js'
import { measureSource } from '../scorer/releases.js'
import { strongerTrust, trustAtLeast, type TrustLevel } from '../scorer/trust.js'
import type { PassbookCheckOutputs, ScoredLoan, ScorerOutcome } from '../scorer/types.js'
import { scorerResultHash, verifyOutcomeForLender, type LenderExpectations, type TrustPolicy } from '../scorer/verify.js'
import { fundingInputs } from '../governance/inputs.js'
import { verifyForwardedCheck, type ForwardedCheckVerification } from '../checknode/client.js'
import { chunkedBus } from '../checknode/bus.js'
import { checkMessageHash, type CheckMessage } from '../checknode/messages.js'
import { EXECUTION_TIER_LABEL, type TeeVerifierConfig } from '../checknode/tee.js'

/**
 * How this lender verifies a credit check bought on the check market (docs/CHECK-MARKET.md):
 * the release manifest, its pinned signer and the scoring contract, and the TEE verifier. Which
 * check nodes it accepts is its signed policy's check_nodes, not this config.
 */
export interface LenderCheckMarket {
  trust: TrustPolicy
  tee: (now: number) => TeeVerifierConfig
}

/**
 * How this lender verifies a scorer's own evidence (scorer.provider external): the pinned release
 * manifest, release key and scoring contract, the deployment's trust minimum, and its own
 * offline external verifier with the external provider evidence keys it obtained independently.
 */
export interface LenderScoring {
  policy: TrustPolicy
  externalVerifier?: LenderExpectations['externalVerifier']
  /** Passbook chain observers this lender trusts to sign what a scored bundle asked for (bundle-terms.ts). */
  chainSigners?: Hex[]
}

export interface LenderPolicy {
  /** the offer's d tag */
  d: string
  min: Micro
  max: Micro
  apr_bps: Bps
  term_blocks: number
  grace_blocks: number
  ltv_ladder_bps: Bps[]
  requirements: OfferPayload['requirements']
  /** the credit memo's adjustment is clamped into this band, in bps of APR */
  band: [number, number]
  expires_in_blocks: number
}

/** L1 asks for income evidence: three months of verified inflows worth twice the repayment. */
export const L1_POLICY: LenderPolicy = {
  d: 'usdt-30',
  min: 100 * MICRO_PER_USDT,
  max: 5_000 * MICRO_PER_USDT,
  apr_bps: 1200,
  term_blocks: 30,
  grace_blocks: 5,
  ltv_ladder_bps: [5000, 5500, 6000, 6500],
  requirements: { affordability: true, inflow_months: 3, inflow_multiple_bps: 20_000, investigation: 'required', reconciliation: 'required', income_evidence: 'reconciled_tiers' },
  band: [-100, 200],
  expires_in_blocks: 1000,
}

/** Explicit fallback for the three pre-event scenarios; it does not claim AI investigation. */
export const LEGACY_L1_POLICY: LenderPolicy = { ...L1_POLICY, d: 'usdt-30-legacy', requirements: { ...L1_POLICY.requirements, investigation: 'optional', reconciliation: 'optional', income_evidence: 'payer_signatures' } }

/** L2 lends on the chain record: no income evidence, the earned ladder step decides the LTV. */
export const L2_POLICY: LenderPolicy = {
  d: 'usdt-30-record',
  min: 100 * MICRO_PER_USDT,
  max: 5_000 * MICRO_PER_USDT,
  apr_bps: 1100,
  term_blocks: 30,
  grace_blocks: 5,
  ltv_ladder_bps: [5000, 5500, 6000, 6500],
  requirements: { affordability: true, inflow_months: 0, inflow_multiple_bps: 0, investigation: 'optional' },
  band: [-100, 200],
  expires_in_blocks: 1000,
}

export interface UnderwriteOptions {
  timeoutMs?: number
  /** Negotiated origination: the lender's signed market policy, the round limit and the maker-checker threshold. */
  negotiation?: { policy: MarketLenderPolicy; maxRounds: number; makerCheckerAboveMicro: Micro }
  /** The lender's human approval screen: returns approvals of exactly this sheet (a second key above the threshold). */
  approve?: (sheet: TermSheet, render: ReturnType<typeof renderTermSheet>) => Promise<Approval[]>
  /** Check market: how this lender verifies a check the borrower bought from a check node. */
  checkMarket?: LenderCheckMarket
  /** Lender-paid check (payForCheck): this lender's own verification; the application's check_key names the KEY it forwarded. */
  lenderCheck?: LenderCheckResult
}

/**
 * Negotiated origination, between its two halves: the verified, lender-signed term sheet
 * waiting for the lender's human approval. Nothing is registered or sent yet. The demo
 * journals each half and the approvals between them, so a restart resumes at the approval.
 */
export interface TermSheetProposal {
  loan_id: Hex
  borrower_pk: Hex
  sheet: TermSheet
  /** the borrower-carried passbook from the application, registered with the terms */
  passbook: NonNullable<ApplicationPayload['passbook']>
  negotiation: NonNullable<UnderwriteOptions['negotiation']>
  checks: Check[]
  memo: Underwriting['memo']
  /** Scored by external provider: the evidence this lender verified, so its approval can refuse a sheet that names other evidence. */
  scored?: ScorerOutcome
  /** Bought on the check market: this lender's verification of the forwarded check. */
  check?: ForwardedCheckVerification
}

export interface Underwriting {
  loan_id: Hex
  borrower_pk: Hex
  terms: LoanTerms
  checks: Check[]
  memo: { adjustment_bps: number; applied_bps: number; clamped: boolean; flags: string[]; text: string }
  apr_bps: Bps
}

export interface Liquidation {
  txid: Hex
  price_cents: number
  ltv_bps: Bps
  lender_sats: Sats
  borrower_sats: Sats
  /** the platform's checks on the PSBT before it signed leaf B */
  checks: Check[]
}

interface LenderLoan {
  terms: LoanTerms
  borrower_pk: Hex
  /** Negotiated origination: the term sheet, the lender's approvals and the policy that sets maker-checker. */
  termsheet?: TermSheet
  lender_approvals?: Approval[]
  negotiation_policy?: MarketLenderPolicy
  maker_checker_above?: Micro
  repayment_txid?: Hex
  lock?: { txid: Hex; vout: number }
  assigned_owner?: IouOwnership
  repayment_receipt?: RgbRepaymentReceipt
  repayment_recipient_id?: string
  /** An attempted external send must be reconciled, never blindly repeated. */
  disbursement_attempted?: boolean
  /** the per-loan repayment account: our key, the platform's watch-only copy issued its invoice */
  repayment_account?: RgbWallet
}

/** Private local demo state, not a fresh underwriting or chain proof. */
export interface LenderCheckpoint {
  v: 1
  asset_id: string
  pubkey: Hex
  loans: [Hex, Omit<LenderLoan, 'repayment_account'> & { has_repayment_account: boolean }][]
}

function checkpointObject(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((k) => !allowed.includes(k)) || required.some((k) => !Object.hasOwn(value, k))) throw new Error('Invalid lender checkpoint fields')
  return value as Record<string, unknown>
}
function checkpointInt(value: unknown, min = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error('Invalid lender checkpoint integer')
}
function checkpointText(value: unknown): void {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new Error('Invalid lender checkpoint string')
}
function checkpointHex(value: unknown, bytes = 32): void {
  if (!isHex(value, bytes)) throw new Error('Invalid lender checkpoint hex')
}
function checkpointTerms(value: unknown): asserts value is LoanTerms {
  checkpointObject(value, ['v', 'borrower_pk', 'lender_pk', 'platform_pk', 'asset_id', 'principal', 'fee', 'collateral_sats', 'oracle_quote', 'open_height', 'maturity_height', 'grace_blocks', 'recovery_height', 'ladder_step', 'ltv_bps', 'prev_passbook_txid', 'nonce', 'atomic_repayment'], [])
  // Structure only: these terms were priced and registered under the deployment's economics when the loan was made.
  validateTerms(value, null)
  const q = checkpointObject(value.oracle_quote, ['price_cents', 'height', 'oracle_pk', 'source', 'observed_at', 'sources', 'sig'], ['price_cents', 'height', 'oracle_pk', 'sig'])
  if (q.source !== undefined && !['live_median', 'demo_override', 'configured'].includes(q.source as string)) throw new Error('Invalid lender checkpoint quote source')
  if (q.observed_at !== undefined) checkpointInt(q.observed_at)
  if (q.sources !== undefined) {
    if (!Array.isArray(q.sources)) throw new Error('Invalid lender checkpoint quote sources')
    for (const s of q.sources) { const row = checkpointObject(s, ['name', 'price_cents', 'observed_at']); checkpointText(row.name); checkpointInt(row.price_cents, 1); checkpointInt(row.observed_at) }
  }
  if (value.atomic_repayment !== undefined) checkpointObject(value.atomic_repayment, ['invoice', 'btc_amount_msat', 'payment_hash', 'expires_at', 'payee_pubkey'])
}
function checkpointOwnership(owner: IouOwnership, terms: LoanTerms, id: Hex): void {
  checkpointObject(owner, ['certificate', 'assignments', 'holder_pk', 'sig'])
  const c = owner.certificate
  checkpointObject(c, ['domain', 'loan_id', 'asset_id', 'amount', 'issuer_pk', 'initial_holder_pk', 'issuance_transfer_txid', 'lock_txid', 'lock_vout', 'sig'])
  checkpointText(c.asset_id); checkpointInt(c.amount, 1); checkpointInt(c.lock_vout)
  for (const h of [c.loan_id, c.issuer_pk, c.initial_holder_pk, c.issuance_transfer_txid, c.lock_txid, owner.holder_pk]) checkpointHex(h)
  checkpointHex(c.sig, 64); checkpointHex(owner.sig, 64)
  if (c.domain !== 'passbook-iou-v1' || c.loan_id !== id || c.amount !== debtOf(terms) || c.issuer_pk !== terms.borrower_pk || c.initial_holder_pk !== terms.lender_pk || !verifyObject(c, c.issuer_pk) || !Array.isArray(owner.assignments) || owner.assignments.length > 32) throw new Error('Invalid lender checkpoint ownership')
  let holder = c.initial_holder_pk, previous = hashObject(c)
  for (const a of owner.assignments) {
    checkpointObject(a, ['domain', 'loan_id', 'asset_id', 'from_pk', 'to_pk', 'previous', 'note_txid', 'payment_txid', 'repayment_invoice', 'sig'])
    for (const h of [a.loan_id, a.from_pk, a.to_pk, a.previous, a.note_txid, a.payment_txid]) checkpointHex(h)
    checkpointText(a.asset_id); checkpointText(a.repayment_invoice); checkpointHex(a.sig, 64)
    if (terms.v !== 1 || a.domain !== 'passbook-iou-assignment-v1' || a.loan_id !== id || a.asset_id !== c.asset_id || a.from_pk !== holder || a.previous !== previous || !verifyObject(a, holder)) throw new Error('Invalid lender checkpoint assignment')
    holder = a.to_pk; previous = hashObject(a)
  }
  if (holder !== owner.holder_pk || !verifyObject(owner, holder)) throw new Error('Invalid lender checkpoint holder')
}
/**
 * A negotiated loan carries its term sheet, the lender approvals, the signed policy that set
 * maker-checker and the threshold, all four or none: fund() refuses to disburse without them.
 */
function checkpointNegotiated(l: LenderCheckpoint['loans'][number][1], id: Hex, pubkey: Hex, economics: Economics): void {
  const present = [l.termsheet, l.lender_approvals, l.negotiation_policy, l.maker_checker_above].filter((v) => v !== undefined).length
  if (present === 0) return
  if (present !== 4) throw new Error('Lender checkpoint negotiated loan is missing its term sheet, approvals, policy or threshold')
  const sheet = l.termsheet!, policy = l.negotiation_policy!, approvals = l.lender_approvals!
  checkpointInt(l.maker_checker_above)
  // The schema refuses unknown fields; signatures present must verify; the sheet must hash to exactly these terms.
  const problems = termSheetProblems(sheet, { economics })
  if (problems.length || !sheet.signatures.lender || termSheetHash(sheet) !== id || canonicalJson(sheet.terms) !== canonicalJson(l.terms)) throw new Error('Invalid lender checkpoint term sheet')
  checkpointObject(policy, ['v', 'kind', 'owner_pk', 'asset_id', 'max_per_loan', 'max_outstanding', 'min_apr_bps', 'max_ltv_bps', 'term_blocks', 'required_checks', 'min_scorer_trust', 'accepted_settlements', 'approval_rules', 'opening', 'issued_at', 'sig'], ['v', 'kind', 'owner_pk', 'asset_id', 'max_per_loan', 'max_outstanding', 'min_apr_bps', 'max_ltv_bps', 'term_blocks', 'required_checks', 'min_scorer_trust', 'accepted_settlements', 'approval_rules', 'issued_at', 'sig'])
  if (!policyValid(policy) || policy.owner_pk !== pubkey || policy.asset_id !== l.terms.asset_id) throw new Error('Invalid lender checkpoint negotiation policy')
  if (!Array.isArray(approvals) || approvals.length === 0 || approvals.length > 8) throw new Error('Invalid lender checkpoint approvals')
  for (const a of approvals) {
    checkpointObject(a, ['v', 'domain', 'termsheet_hash', 'approver_pk', 'role', 'approved_at', 'sig'])
    checkpointInt(a.approved_at)
    if (a.role !== 'lender') throw new Error('Invalid lender checkpoint approval role')
  }
  const status = approvalStatus(sheet, approvals, policy, l.maker_checker_above!)
  if (status.problems.length || status.lender_approvers.length < status.required_lender_approvals) throw new Error('Lender checkpoint approvals do not approve this term sheet')
}

function validateLenderCheckpoint(snapshot: LenderCheckpoint, asset: string, pubkey: Hex, economics: Economics): LenderCheckpoint {
  checkpointObject(snapshot, ['v', 'asset_id', 'pubkey', 'loans'])
  if (snapshot.v !== 1 || snapshot.asset_id !== asset || snapshot.pubkey !== pubkey || !Array.isArray(snapshot.loans)) throw new Error('Lender checkpoint belongs to another wallet, asset or version')
  const ids = new Set<string>()
  for (const entry of snapshot.loans) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid lender checkpoint loan entry')
    const [id, l] = entry
    checkpointHex(id)
    if (ids.has(id)) throw new Error('Duplicate lender checkpoint loan')
    ids.add(id)
    checkpointObject(l, ['terms', 'borrower_pk', 'termsheet', 'lender_approvals', 'negotiation_policy', 'maker_checker_above', 'repayment_txid', 'lock', 'assigned_owner', 'repayment_receipt', 'repayment_recipient_id', 'disbursement_attempted', 'has_repayment_account'], ['terms', 'borrower_pk', 'has_repayment_account'])
    checkpointTerms(l.terms)
    if (termsHash(l.terms) !== id || l.terms.asset_id !== asset || l.borrower_pk !== l.terms.borrower_pk) throw new Error('Lender checkpoint loan binding mismatch')
    checkpointNegotiated(l, id, pubkey, economics)
    if (typeof l.has_repayment_account !== 'boolean' || (l.disbursement_attempted !== undefined && typeof l.disbursement_attempted !== 'boolean')) throw new Error('Invalid lender checkpoint guard flag')
    if (l.has_repayment_account && l.disbursement_attempted !== true) throw new Error('Lender checkpoint repayment account requires the attempted-send guard')
    if (l.assigned_owner !== undefined) checkpointOwnership(l.assigned_owner, l.terms, id)
    if (l.terms.lender_pk !== pubkey && l.assigned_owner?.holder_pk !== pubkey) throw new Error('Lender checkpoint loan has another lender')
    if (l.repayment_txid !== undefined) checkpointHex(l.repayment_txid)
    if (l.repayment_recipient_id !== undefined) checkpointText(l.repayment_recipient_id)
    if (l.lock !== undefined) { checkpointObject(l.lock, ['txid', 'vout']); checkpointHex(l.lock.txid); checkpointInt(l.lock.vout) }
    if (l.repayment_receipt !== undefined) {
      const r = l.repayment_receipt
      checkpointObject(r, ['domain', 'loan_id', 'repayment_txid', 'asset_id', 'amount', 'validator_pk', 'validation', 'sig'])
      checkpointInt(r.amount, 1); checkpointHex(r.repayment_txid); checkpointHex(r.validator_pk); checkpointHex(r.sig, 64)
      if (r.domain !== 'passbook-rgb-repayment-v1' || r.validation !== 'rgb-lib-settled' || r.loan_id !== id || r.asset_id !== asset || r.repayment_txid !== l.repayment_txid || r.validator_pk !== (l.assigned_owner?.holder_pk ?? pubkey) || r.amount < debtOf(l.terms) || !verifyObject(r, r.validator_pk)) throw new Error('Invalid lender checkpoint repayment receipt')
    }
  }
  return structuredClone(snapshot)
}

/**
 * Whether a borrower passed this node's offline sanctions screen (its decision-log entry). Fail closed: only an exact
 * `clear` passes. A hit always refuses. A missing or `not-screened` entry passes only under a governance policy with
 * screening `off`, and says so.
 */
export function sanctionsScreenVerdict(entry: LogEntry | undefined, policySanctions: GovernancePolicy['sanctions'] | undefined): { ok: boolean; detail: string } {
  const at = entry ? `; decision-log entry ${entry.seq} ${entry.hash.slice(0, 12)}…` : ''
  const list = entry ? String((entry.detail as { list_version?: string } | null)?.list_version ?? 'none') : 'none'
  if (entry?.result === 'hit') return { ok: false, detail: `HIT on ${list}${at}` }
  if (entry?.result === 'clear') return { ok: true, detail: `clear on ${list}${at}` }
  if (policySanctions === 'off') return { ok: true, detail: `NOT SCREENED (${entry ? entry.result : 'no screen logged'}); screening is off in this node's governance policy${at}` }
  return { ok: false, detail: entry ? `NOT SCREENED (${entry.result}): no sanctions list was loaded${at}` : 'no sanctions screen of this borrower for this negotiation in this node\'s decision log' }
}

export class LenderAgent extends Agent {
  readonly policy: LenderPolicy
  readonly lightning?: RgbLightningClient
  readonly assetId: string
  readonly blocksPerMonth: number
  /** The platform's published economics: interest day count, APR cap, LTV limit per term. */
  readonly economics: Economics
  /** Set when the deployment's scorer is external provider; without it a scorer-evidence application is declined. */
  readonly scoring?: LenderScoring
  private readonly loans = new Map<Hex, LenderLoan>()
  private checkpointRestoring = false
  private checkpointClosed = false
  private readonly closedRepaymentAccounts = new WeakSet<RgbWallet>()
  /** Negotiated origination over Nostr: the signed market policy and engine parameters its offer advertises. */
  private nostrNegotiation?: { policy: MarketLenderPolicy; params: EngineParams }
  /** This node's decision-log entries per negotiation id (its sanctions screen), sent with the acceptance. */
  private readonly decisions = new Map<Hex, LogEntry[]>()

  constructor(deps: AgentDeps & { policy: LenderPolicy; assetId: string; lightning?: RgbLightningClient | null; blocksPerMonth?: number; economics?: Economics; scoring?: LenderScoring }) {
    super(deps)
    this.policy = deps.policy
    this.scoring = deps.scoring
    this.assetId = deps.assetId
    this.lightning = deps.lightning === null ? undefined : deps.lightning ?? RgbLightningNode.fromEnv('LENDER')
    this.blocksPerMonth = deps.blocksPerMonth ?? Number(process.env.BLOCKS_PER_MONTH ?? 30)
    this.economics = deps.economics ?? DEFAULT_ECONOMICS
  }

  exportCheckpoint(): LenderCheckpoint {
    const loans: LenderCheckpoint['loans'] = [...this.loans].map(([id, { repayment_account, ...loan }]) => [id, { ...loan, has_repayment_account: !!repayment_account }])
    return validateLenderCheckpoint({ v: 1, asset_id: this.assetId, pubkey: this.pubkey, loans }, this.assetId, this.pubkey, this.economics)
  }

  /** Restore only at a quiescent local demo checkpoint. Never retries a send. */
  async restoreCheckpoint(snapshot: LenderCheckpoint): Promise<void> {
    if (this.checkpointRestoring || this.checkpointClosed) throw new Error('Lender checkpoint restore unavailable while restoring or closed')
    this.checkpointRestoring = true
    try {
      const saved = validateLenderCheckpoint(snapshot, this.assetId, this.pubkey, this.economics)
      for (const [id, loan] of saved.loans) if (this.loans.get(id)?.disbursement_attempted && loan.disbursement_attempted !== true) throw new Error('Lender checkpoint cannot clear an attempted disbursement')
      const paths = new Map<Hex, { mnemonic: string; dir: string }>()
      // Check every account before opening any. An empty directory (or the
      // wrong fingerprint) must never silently create a new repayment wallet.
      for (const [id, l] of saved.loans) if (l.has_repayment_account) {
        if (l.terms.lender_pk !== this.pubkey) throw new Error('Assigned loan cannot restore an original lender repayment account')
        const mnemonic = repaymentMnemonic(this.party.key.secretKey, id)
        const { master_fingerprint } = await watchKeys(mnemonic)
        const root = join(dirname(this.party.rgb.dataDir), 'loans'), dir = join(root, id, 'rgb'), native = join(dir, master_fingerprint)
        for (const d of [root, join(root, id), dir, native, join(native, 'rgb')]) {
          const stat = lstatSync(d)
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Existing lender repayment wallet directory required')
        }
        for (const f of ['rgb_lib_db', 'bdk_db_watch_only', 'rgb/state.dat', 'rgb/stash.dat', 'rgb/index.dat']) {
          const stat = lstatSync(join(native, f))
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Existing lender repayment wallet files required')
        }
        paths.set(id, { mnemonic, dir })
      }
      const next = new Map<Hex, LenderLoan>(), opened: RgbWallet[] = []
      try {
        for (const [id, { has_repayment_account, ...fields }] of saved.loans) {
          const loan: LenderLoan = fields
          if (this.checkpointClosed) throw new Error('Lender closed during checkpoint restore')
          if (has_repayment_account) {
            const path = paths.get(id)!, current = this.loans.get(id)?.repayment_account
            if (current && resolve(current.dataDir) !== resolve(path.dir)) throw new Error('Existing lender repayment account path mismatch')
            loan.repayment_account = current ?? await RgbWallet.open(path.mnemonic, path.dir)
            if (!current) opened.push(loan.repayment_account)
          }
          next.set(id, loan)
        }
        if (this.checkpointClosed) throw new Error('Lender closed during checkpoint restore')
      } catch (error) { this.closeRepaymentAccounts(opened); throw error }
      const retained = new Set([...next.values()].map((l) => l.repayment_account))
      const old = [...this.loans.values()].flatMap((l) => l.repayment_account && !retained.has(l.repayment_account) ? [l.repayment_account] : [])
      this.loans.clear()
      for (const [id, loan] of next) this.loans.set(id, loan)
      this.closeRepaymentAccounts(old)
    } finally { this.checkpointRestoring = false }
  }

  private closeRepaymentAccounts(accounts: Iterable<RgbWallet>): void {
    let failure: unknown
    for (const account of new Set(accounts)) if (!this.closedRepaymentAccounts.has(account)) {
      this.closedRepaymentAccounts.add(account)
      try { account.close() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }

  get offerId(): string {
    return `${this.pubkey}:${this.policy.d}`
  }

  async publishOffer(): Promise<OfferPayload> {
    const height = await this.chain.getHeight()
    const p = this.policy
    // the platform's order book refuses offers from a lender with an overdue fee; say so, and how to pay, before publishing
    const owed = await this.platform.fees(this.pubkey).catch(() => null)
    if (owed?.blocked) {
      const due = owed.fees.filter((f) => f.status === 'fee_due')
      await this.say('Offer not published: platform fee overdue', { fees: due.map((f) => ({ loan_id: f.loan_id.slice(0, 12), amount: usdt(f.amount), grace_until: f.grace_until_height })) })
      throw new Error(`${owed.blocked} ${due.length} fee(s) due, ${usdt(due.reduce((s, f) => s + f.amount, 0))} in all. Pay them with LenderAgent.payPlatformFees(), or from the peer CLI: npm run peer -- --role lender --wallet ${this.role} --asset-id ${this.assetId} --pay-fees`)
    }
    const offer: OfferPayload = {
      asset_id: this.assetId,
      min: p.min,
      max: p.max,
      apr_bps: p.apr_bps,
      term_blocks: p.term_blocks,
      grace_blocks: p.grace_blocks,
      ltv_ladder_bps: p.ltv_ladder_bps,
      requirements: p.requirements,
      expires_height: height + p.expires_in_blocks,
      ...(this.nostrNegotiation ? { negotiation: negotiationTerms(this.nostrNegotiation.policy, { max_rounds: this.nostrNegotiation.params.max_rounds, min_principal: p.min, outstanding: this.outstanding() }) } : {}),
    }
    await this.relay.publishPublic(KIND.OFFER, offer, [['d', p.d]])
    await this.say('Offer published to the relay', { offer_id: this.offerId, apr: `${p.apr_bps / 100}%`, range: `${usdt(p.min)} to ${usdt(p.max)}`, ladder: p.ltv_ladder_bps, requirements: p.requirements })
    return offer
  }

  /** Principal of this lender's loans not yet repaid. */
  private outstanding(): Micro {
    return [...this.loans.values()].filter((l) => l.terms.lender_pk === this.pubkey && !l.repayment_txid).reduce((sum, l) => sum + l.terms.principal, 0)
  }

  /** Advertise negotiation in the offer (its NegotiationTerms) and answer ASKs with this signed market policy. */
  negotiateWith(policy: MarketLenderPolicy, params: EngineParams): void {
    if (policy.owner_pk !== this.pubkey || !policyValid(policy)) throw new Error('the market policy is not this lender\'s signed policy')
    if (policy.asset_id !== this.assetId || policy.term_blocks.min !== this.policy.term_blocks || policy.term_blocks.max !== this.policy.term_blocks) throw new Error('the market policy must name this offer\'s asset and term')
    this.nostrNegotiation = { policy, params }
  }

  /**
   * Negotiated origination over Nostr (negotiate-nostr.ts): answer borrowers' ASKs to this lender from its signed
   * market policy, with this node's governance in front. The kill switch stops it: each message is signed by the
   * gate's session key for that negotiation and every event leaves through the guarded relay. The borrower's
   * key-path address passes the node's offline sanctions screen, logged in its decision log, before anything is
   * signed for it. Resolves with the first agreement; a no-deal is narrated and it keeps listening.
   */
  async negotiateOverNostr(o: { waitMs?: number; timeoutMs?: number; onMessage?: (m: NegotiationMessage, direction: 'sent' | 'received') => void } = {}): Promise<NegotiationResult> {
    const n = this.nostrNegotiation
    if (!n) throw new Error('negotiation is not enabled on this lender: call negotiateWith(policy, params) first')
    const pool = new SimplePool()
    const transport = poolTransport(pool, this.relay.relays, (e) => this.relay.publish(e as Event))
    try {
      const r = await awaitNegotiation({
        transport, policy: n.policy, params: n.params, min_principal: this.policy.min, outstanding: () => this.outstanding(), timeoutMs: o.timeoutMs, waitMs: o.waitMs,
        signer: (ask) => keyPairSigner(this.party.key, this.negotiationSigner(ask.borrower_pk, ask.nonce)),
        admit: (ask) => this.admitBorrower(ask.borrower_pk, ask.negotiation_id),
        onMessage: (m, direction) => {
          o.onMessage?.(m, direction)
          const pos = m.body.position as Position | undefined
          void this.say(`Negotiation ${direction === 'sent' ? 'sent' : 'received'}: ${m.type}`, { negotiation_id: m.negotiation_id.slice(0, 12), seq: m.seq, ...(pos ? { apr: `${pos.apr_bps / 100}%`, ltv: `${pos.ltv_bps / 100}%` } : { reason: m.body.reason ?? null }) })
        },
        onResult: (res) => { if (!('agreed' in res.outcome)) void this.say('Negotiation ended without a deal', { negotiation_id: res.negotiation_id.slice(0, 12), reason: res.outcome.no_deal, problems: res.problems.slice(0, 3) }) },
      })
      await this.say('Negotiation agreed over Nostr', { negotiation_id: r.negotiation_id.slice(0, 12), messages: r.messages.length, transcript: r.verified.ok ? 'verified' : 'NOT VERIFIED' })
      return r
    } finally { pool.close(this.relay.relays) }
  }

  /** The node's offline sanctions screen of a borrower's key-path address, logged; a hit (or a stopped agent) refuses. */
  private async admitBorrower(borrowerPk: Hex, negotiationId: Hex): Promise<true | string> {
    const gate = this.governance.gate
    if (gate.agentStopped(this.role)) return 'STOPPED'
    const subject = { subject_pk: borrowerPk, proven_addresses: [keyPathOutput(borrowerPk).address] }
    const r = gate.sanctions ? await gate.sanctions.screen(subject) : null
    const result = !r || !r.lists.length ? 'not-screened' : r.status
    const entry = gate.log.append({
      kind: 'sanctions-result', action_id: null, policy_version: gate.activePolicy()?.policy.version ?? null, input_hashes: { subject: hashObject(subject), lists: hashObject(r?.lists ?? []) }, decided_by: { kind: 'gate', pk: gate.pubkey }, result,
      detail: { purpose: 'negotiation', negotiation_id: negotiationId, screen: r?.screen ?? 'no sanctions screen on this node', list_version: r?.list_version ?? 'none', screened: r?.screened ?? null, hits: r?.hits ?? [] },
    })
    this.decisions.set(negotiationId, [entry])
    const verdict = sanctionsScreenVerdict(entry, gate.activePolicy()?.policy.sanctions)
    await this.say('Borrower screened before negotiating', { negotiation_id: negotiationId.slice(0, 12), result, list_version: r?.list_version ?? 'none', log_entry: entry.seq, admitted: verdict.ok })
    return verdict.ok ? true : result === 'hit' ? 'SANCTIONS' : 'NOT_SCREENED'
  }

  /** This node's sanctions screen for a negotiation: this run's entry or, after a restart, the latest one in the durable decision log. */
  private screeningFor(negotiationId: Hex): LogEntry | undefined {
    return this.decisions.get(negotiationId)?.find((e) => e.kind === 'sanctions-result')
      ?? [...this.governance.gate.log.entries()].reverse().find((e) => e.kind === 'sanctions-result' && (e.detail as { negotiation_id?: string } | null)?.negotiation_id === negotiationId)
  }

  /** Whether a negotiation's borrower passed this node's sanctions screen (sanctionsScreenVerdict over its logged entry). */
  screeningCheck(negotiationId: Hex): { ok: boolean; detail: string } {
    return sanctionsScreenVerdict(this.screeningFor(negotiationId), this.governance.gate.activePolicy()?.policy.sanctions)
  }

  /**
   * The lender-paid credit check of an agreed negotiation, in one place (lane P2's runLenderCheck): the borrower's
   * PART (kind 7533), then REQUEST, pay over the lender's own rail, open and verify the result against exactly the
   * agreed loan, forward K. Underwrite with the result (UnderwriteOptions.lenderCheck) only when its verification is ok.
   */
  async payForCheck(agreement: NegotiationResult, o: Omit<RunLenderCheckOptions, 'part' | 'loan' | 'bus' | 'rules' | 'requiredChecks'> & { bus?: RunLenderCheckOptions['bus']; partTimeoutMs?: number }): Promise<LenderCheckResult> {
    const n = this.nostrNegotiation
    if (!n) throw new Error('a lender-paid check follows a negotiation over Nostr: call negotiateWith first')
    if (!('agreed' in agreement.outcome) || !agreement.verified.ok) throw new Error('a lender-paid check is for an agreed, verified negotiation')
    const agreed = agreement.outcome.agreed, p = this.policy
    // the same loan, rules and required checks the application review holds the check to
    const loan: ScoredLoan = { loan_request: { principal: agreed.principal, fee: this.interest(agreed.principal, agreed.apr_bps), term_blocks: p.term_blocks, grace_blocks: p.grace_blocks }, asset_id: this.assetId, lender_requirements_hash: hashObject(p.requirements) }
    const bus = o.bus ?? this.relay
    const part = await receiveBorrowerCheckPart(bus, agreement.counterparty_pk, agreement.negotiation_id, o.partTimeoutMs ?? 120_000)
    const r = await runLenderCheck({ ...o, bus, part, loan, rules: n.policy.check_nodes ?? {}, requiredChecks: this.requiredScorerChecks(n.policy) })
    await this.say('Credit check billed to the lender at close, not paid up front', { negotiation_id: agreement.negotiation_id.slice(0, 12), verified: r.verification.ok, billed: `${r.fee.amount} of ${r.fee.asset_id.slice(0, 16)}…`, rail: r.fee.rail_label })
    return r
  }

  /** This lender's requirements as scorer check ids: its signed market policy's plus what its offer requires. */
  private requiredScorerChecks(policy: MarketLenderPolicy): string[] {
    const p = this.policy
    return [...new Set([...policy.required_checks, ...(p.requirements.investigation === 'required' ? ['investigation'] : []), ...(p.requirements.reconciliation === 'required' ? ['reconcile'] : []), ...(p.requirements.affordability ? ['affordability'] : []), ...(p.requirements.inflow_months > 0 ? ['inflows'] : [])])]
  }

  /** The term interest at an APR for this offer's term: termInterest, ACT/365, half-up to 0.01 USDT. */
  private interest(principal: Micro, aprBps: Bps): Micro {
    return termInterest({ principal, apr_bps: aprBps, term_blocks: this.policy.term_blocks }, this.economics)
  }

  /** Wait for an application to this offer, check everything, price it, register the terms and accept. */
  async underwrite(opts: UnderwriteOptions = {}): Promise<Underwriting> {
    const reviewed = await this.review(opts)
    if (!('sheet' in reviewed)) return reviewed
    // Human approval of exactly this sheet; a terminal run approves with the lender key (labelled).
    const approvals = opts.approve ? await opts.approve(reviewed.sheet, renderTermSheet(reviewed.sheet, { audience: 'lender', economics: this.economics })) : [approveSheet(this.party.key, reviewed.sheet, 'lender')]
    return this.sendTermSheet(reviewed, approvals)
  }

  /** Negotiated origination, first half: verify the application and build and sign the term sheet. Nothing is registered or sent. */
  async proposeTermSheet(opts: Omit<UnderwriteOptions, 'approve'> & { negotiation: NonNullable<UnderwriteOptions['negotiation']> }): Promise<TermSheetProposal> {
    const reviewed = await this.review(opts)
    if (!('sheet' in reviewed)) throw new Error('negotiated underwriting produced no term sheet')
    return reviewed
  }

  private async review(opts: Omit<UnderwriteOptions, 'approve'>): Promise<Underwriting | TermSheetProposal> {
    const { payload: app, event } = await this.relay.receive<ApplicationPayload>(KIND.APPLICATION, null, { timeoutMs: opts.timeoutMs, match: (a) => a.offer_id === this.offerId })
    const borrowerPk = event.pubkey
    await this.say('Application received over Nostr', { from: borrowerPk.slice(0, 12), principal: usdt(app.principal), disclosed: app.disclosed_inflows.length })

    const checks: Check[] = []
    const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail })
    const p = this.policy
    // Negotiated origination: the agreed position, from a transcript both parties signed, replaces offer pricing.
    let agreed: Position | undefined
    let acceptHash: Hex | undefined
    if (opts.negotiation) {
      const n = opts.negotiation
      const t = app.negotiation ? verifyTranscript(app.negotiation, { borrower_pk: borrowerPk, lender_pk: this.pubkey, max_rounds: n.maxRounds, economics: this.economics }) : { ok: false, problems: ['no negotiation transcript in the application'] }
      agreed = 'agreed' in t ? t.agreed : undefined
      acceptHash = 'accept_hash' in t ? t.accept_hash : undefined
      check('negotiation', t.ok && !!agreed, t.ok ? `${app.negotiation!.length} signed, hash-chained messages ending in ACCEPT` : t.problems.slice(0, 2).join('; '))
      check('negotiated-terms', !!agreed && agreed.principal === app.principal && agreed.term_blocks === p.term_blocks && agreed.apr_bps >= n.policy.min_apr_bps && agreed.apr_bps <= this.economics.max_apr_bps && agreed.ltv_bps <= n.policy.max_ltv_bps && n.policy.owner_pk === this.pubkey && agreed.settlement === (this.lightning ? 'ln-rln' : 'cosign-rgb'), agreed ? `${usdt(agreed.principal)} for ${agreed.term_blocks} blocks at ${agreed.apr_bps / 100}% APR, ${agreed.ltv_bps / 100}% LTV, ${agreed.settlement}` : 'no agreement')
      const c = app.consent
      // Its purpose is the negotiation: the id itself, or for external provider evidence the id in external provider's purpose format.
      const purposeOk = !!c && !!app.negotiation && c.purpose_id === app.negotiation[0].negotiation_id
      check('consent', !!c && !!app.negotiation && verifyObject(c, borrowerPk) && c.borrower_pk === borrowerPk && c.lender_pk === this.pubkey && purposeOk && c.retention === 'none', 'borrower-signed consent receipt for this negotiation and lender')
    }
    // A check bought on the check market: taken only from the KEY message the borrower forwarded, verified here.
    // Negotiating over Nostr, every application needs this node's sanctions screen of the borrower, logged and clear.
    if (this.nostrNegotiation) {
      const screened = app.negotiation?.length ? this.screeningCheck(app.negotiation[0].negotiation_id) : { ok: false, detail: 'no negotiation, so no sanctions screen to match' }
      check('sanctions', screened.ok, screened.detail)
    }
    if (app.check_key !== undefined) return this.reviewChecked({ app, borrowerPk, checks, check, negotiation: opts.negotiation, agreed, acceptHash, market: opts.checkMarket, timeoutMs: opts.timeoutMs, lenderPaid: opts.lenderCheck })
    // The scorer's own evidence (external provider) instead of the platform sandbox's result: verified here, with this lender's verifier.
    if (app.scorer_outcome !== undefined) return this.reviewScored({ app, borrowerPk, checks, check, negotiation: opts.negotiation, agreed, acceptHash })
    // The platform sandbox reaches dev-inprocess only: a lender whose signed policy needs more refuses its result.
    if (opts.negotiation && !trustAtLeast('dev-inprocess', opts.negotiation.policy.min_scorer_trust)) check('scorer-trust', false, `the platform sandbox reaches dev-inprocess; this lender's signed policy needs ${opts.negotiation.policy.min_scorer_trust}`)
    const pricingApr = agreed?.apr_bps ?? p.apr_bps
    const { sandbox_pk, attestation: current } = await this.platform.sandboxPubkey()
    const state = await this.platform.state()
    const result = app.sandbox_result as LenderSandboxResult
    const attestation = app.attestation as Attestation

    check('amount', app.principal >= p.min && app.principal <= p.max && app.term_blocks === p.term_blocks, `${usdt(app.principal)} for ${app.term_blocks} blocks`)
    check('sandbox-sig', verifyObject(result, sandbox_pk) && result.borrower_pk === borrowerPk && result.offer_id === this.offerId, `signed by sandbox ${sandbox_pk.slice(0, 12)} for this borrower and offer`)
    const request = result.loan_request
    check('sandbox-request', !!request && request.principal === app.principal &&
      request.term_blocks === app.term_blocks && request.term_blocks === p.term_blocks &&
      request.grace_blocks === p.grace_blocks && request.fee === this.interest(app.principal, pricingApr),
      `signed sandbox principal, term and grace match this application/offer; fee estimate matches the ${agreed ? 'negotiated' : 'advertised'} APR`)
    check('attestation', verifyObject(attestation, state.platform_pk) && attestation.sandbox_pk === sandbox_pk && attestation.image_digest === current.image_digest, `platform attests ${attestation.image_digest}`)
    if (opts.negotiation) {
      // Consent must have covered the processing itself: the sandbox signed the receipt's hash into this result, and the receipt names this sandbox.
      const c = app.consent
      check('consent-bound', !!c && result.consent_hash === consentHash(c) && c.scorer_pk === sandbox_pk && c.scorer_id === sandboxScorerId(sandbox_pk, current.image_digest), result.consent_hash ? `the sandbox checked the receipt before processing and signed ${result.consent_hash.slice(0, 12)}…` : 'the signed result commits to no consent receipt')
    }
    check('no-raw-rows', !('history' in result) && !('candidate_inflows' in result) && !canonicalJson(result).includes('"memo"'), 'the result carries checks and summaries only')
    const runRecord = result.run_record
    const expectedMaterials = await publishedRunMaterials(result.investigation?.model ?? '', { systemPrompt: INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: INVESTIGATION_TOOL_DEFINITIONS })
    const runCheck = runRecord ? verifyRunRecord(runRecord, expectedMaterials, sandbox_pk, INVESTIGATION_BUDGETS, result.investigation) : { ok: false, errors: ['RUN_RECORD_MISSING'] }
    check('sandbox-run-record', runCheck.ok && runRecord?.image_digest === current.image_digest && runRecord?.bundle_hash === result.bundle_hash && runRecord?.status === result.investigation?.status && runRecord?.policy_sha256 === hashObject(result.investigation?.policy ?? null), runCheck.errors.join(',') || 'signed software run record; published materials and budgets verified')
    check('required-local-model', p.requirements.investigation !== 'required' || runRecord?.materials.model_material_kind === 'file', 'a deterministic playbook is a baseline and cannot satisfy the local-model lender policy')
    check('investigation-policy', investigationAccepted(p.requirements.investigation, result.investigation), `policy ${p.requirements.investigation ?? 'optional'}; investigation ${result.investigation?.status ?? 'missing'}`)
    check('reconciliation-policy', p.requirements.reconciliation !== 'required' || (result.reconciliation?.status === 'verified' && result.asset_id === this.assetId && result.height === state.height), 'required history reconciles against independently observed RGB allocations for this asset')
    const required = ['injection', 'headroom', 'sybil', ...(p.requirements.reconciliation === 'required' ? ['reconcile'] : []), ...(p.requirements.affordability ? ['affordability'] : []), ...(p.requirements.inflow_months > 0 ? ['inflows', 'disclosure'] : [])]
    for (const id of required) {
      const r = result.checks.find((c) => c.id === id)
      check(`sandbox:${id}`, !!r?.ok, r?.detail ?? 'missing')
    }

    // re-verify every disclosed inflow without the sandbox: payer signature and Bitcoin confirmation
    const committed = new Set(result.disclosure_commitments ?? [])
    const proposal = new Map((app.disclosure_items ?? []).filter((d) => committed.has(hashObject(d))).map((d) => [d.txid, d]))
    check('unique-disclosures', new Set(app.disclosed_inflows).size === app.disclosed_inflows.length, 'each payment can count only once')
    let verifiedSum = 0
    const months = new Set<number>()
    const height = state.height
    for (const txid of app.disclosed_inflows) {
      const proof = app.inflow_proofs?.find((x) => x.txid === txid)
      const item = proposal.get(txid)
      const sigOk = !!proof && verifyHash(proof.payer_sig, hashObject({ txid, amount: proof.amount, borrower_pk: borrowerPk }), proof.payer_pk)
      const tx = await this.chain.getTx(txid)
      const ok = !!item && sigOk && !!tx?.height && proof!.amount === item.amount && proof!.payer_pk === item.payer_pk
      check(`inflow:${txid.slice(0, 8)}`, ok, ok ? `${usdt(proof!.amount)} signed by ${proof!.payer_pk.slice(0, 8)}, confirmed at ${tx!.height}` : 'not verifiable')
      if (ok) {
        verifiedSum += proof!.amount
        months.add(Math.floor((height - tx!.height!) / this.blocksPerMonth))
      }
    }
    if (p.requirements.inflow_months > 0) {
      const sumRequired = Math.ceil(((app.principal + this.interest(app.principal, pricingApr)) * p.requirements.inflow_multiple_bps) / 10_000)
      const coveredMonths = [...months].filter((m) => m < p.requirements.inflow_months).length
      if (p.requirements.income_evidence === 'reconciled_tiers') {
        check('native-tier-coverage', runCheck.ok && result.reconciliation?.status === 'verified' && result.income_evidence?.basis === 'reconciled_tiers' && result.income_evidence.qualified && result.income_evidence.enough_months && result.income_evidence.enough_counted_income && app.disclosed_inflows.length === 0, 'signed code checks confirm native income after fixed haircuts; exact history stays private')
      } else check('disclosed-coverage', coveredMonths >= p.requirements.inflow_months && verifiedSum >= sumRequired, `we verified ${usdt(verifiedSum)} over ${coveredMonths} of ${p.requirements.inflow_months} month(s), need ${usdt(sumRequired)}`)
    }
    const passbook = await this.borrowerRecordChecks(app, borrowerPk, agreed, check)
    const failed = checks.filter((c) => !c.ok)
    if (failed.length) {
      await this.say('Application declined', { failed })
      throw new Error(`declined: ${failed.map((c) => `${c.id} (${c.detail})`).join('; ')}`)
    }

    // Pricing is deterministic; the local model only drafts its explanation.
    const memoInput = {
      lender: this.role,
      tenor_blocks: p.term_blocks,
      principal: app.principal,
      passbook: { on_time: passbook.ladder.on_time, late: passbook.ladder.late, defaults: passbook.ladder.defaults, open: passbook.ladder.open, step: passbook.ladder.step, unverified: passbook.unverified },
      verified_inflows: { count: app.disclosed_inflows.length, sum: verifiedSum, months_covered: months.size },
      checks: result.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })),
      base_apr_bps: p.apr_bps,
      band: p.band,
    }
    const codedMemo = await new RuleReasoner().creditMemo(memoInput)
    const memo = await this.ai.creditMemo({ ...memoInput, policy_adjustment_bps: codedMemo.adjustment_bps })
    const applied = codedMemo.adjustment_bps
    const clamped = applied !== memo.adjustment_bps
    check('clamp', true, `deterministic policy selected ${applied} bps; model numeric output is ignored`)
    // never above the platform's APR cap, never above the LTV limit for this term
    const apr = agreed ? agreed.apr_bps : Math.min(p.apr_bps + applied, this.economics.max_apr_bps)
    const fee = this.interest(app.principal, apr)
    const debt = app.principal + fee
    const step = passbook.ladder.step
    const ltvTarget = Math.min(passbook.ladder.allowed_ltv_bps, p.ltv_ladder_bps[Math.min(step, p.ltv_ladder_bps.length - 1)], maxLtvForTerm(p.term_blocks, this.economics))
    const quote = await this.platform.quote()
    if (!verifyQuote(quote, state.oracle_pk)) throw new Error('oracle quote does not verify')
    const collateral = collateralFor(debt, ltvTarget, quote.price_cents)
    const lastClose = [...passbook.pages].reverse().find((pg) => pg.verified.close && pg.close_txid)?.close_txid ?? null
    if (agreed && acceptHash && opts.negotiation) {
      if (!result.run_record) throw new Error('sandbox result has no run record to bind into the term sheet')
      const digest = attestation.image_digest
      const scorer = {
        // The attested image: a container's sha256 digest, else the in-process sandbox measured by its source tree.
        provider: sandboxProvider(digest), scorer_id: sandboxScorerId(result.sandbox_pk, digest),
        code_measurement: sandboxProvider(digest) === 'container' ? digest : measureSource(),
        contract_hash: contractHash(loadScoringContract()), trust: 'dev-inprocess' as const, result_hash: hashObject(result), fallback: false,
        recommendation: recommend(result), evidence: runRecordDigest(result.run_record) as Extract<TermSheetEvidence, { kind: 'passbook-run-record' }>,
      }
      return this.originateNegotiated({ app, borrowerPk, agreed, acceptHash, negotiation: opts.negotiation, quote, platformPk: state.platform_pk, step, lastClose, scorer, checks, memo: { adjustment_bps: memo.adjustment_bps, applied_bps: 0, clamped: false, flags: memo.flags, text: memo.memo } })
    }
    const terms: LoanTerms = {
      v: 1,
      borrower_pk: borrowerPk,
      lender_pk: this.pubkey,
      platform_pk: state.platform_pk,
      asset_id: this.assetId,
      principal: app.principal,
      fee,
      collateral_sats: collateral,
      oracle_quote: quote,
      open_height: quote.height,
      maturity_height: quote.height + p.term_blocks,
      grace_blocks: p.grace_blocks,
      recovery_height: quote.height + p.term_blocks + p.grace_blocks + 20,
      ladder_step: step,
      ltv_bps: ltvBps(debt, collateral, quote.price_cents),
      prev_passbook_txid: lastClose,
      nonce: randomHex(32),
    }
    if (this.lightning) {
      terms.atomic_repayment = await createAtomicRepayment(this.lightning, terms)
      terms.v = 2
    }
    const { loan } = await this.platform.registerLoan(terms, app.passbook)
    this.loans.set(loan.id, { terms, borrower_pk: borrowerPk })
    const acceptance: AcceptancePayload = { offer_id: this.offerId, terms, terms_hash: termsHash(terms) }
    await this.relay.send(KIND.ACCEPTANCE, acceptance, borrowerPk)
    await this.say('Accepted and registered', {
      loan_id: loan.id.slice(0, 12),
      apr: `${apr / 100}%`,
      fee: usdt(fee),
      // gross interest, the platform's share after close, net: from termInterest and the published share
      interest: lenderReturnLine(terms, this.economics),
      ltv: `${terms.ltv_bps / 100}% (step ${step})`,
      collateral_sats: collateral,
      memo: memo.memo,
      flags: memo.flags,
      pricing_policy: `${applied >= 0 ? '+' : ''}${applied} bps from verified policy facts`,
    })
    return { loan_id: loan.id, borrower_pk: borrowerPk, terms, checks, memo: { adjustment_bps: memo.adjustment_bps, applied_bps: applied, clamped, flags: memo.flags, text: memo.memo }, apr_bps: apr }
  }

  /** The borrower's own record, the same whichever scorer ran: its signed outstanding debt, its passbook on Bitcoin, the agreed LTV within its earned limit. */
  private async borrowerRecordChecks(app: ApplicationPayload, borrowerPk: Hex, agreed: Position | undefined, check: (id: string, ok: boolean, detail: string) => void): Promise<Awaited<ReturnType<typeof verifyPassbook>>> {
    const p = this.policy
    const outstandingOk = verifyHash(app.outstanding_statement.sig, hashObject({ outstanding_micro: app.outstanding_statement.outstanding_micro }), borrowerPk)
    check('outstanding', outstandingOk && app.outstanding_statement.outstanding_micro === 0, `${usdt(app.outstanding_statement.outstanding_micro)} outstanding, signed by the borrower`)

    if (!app.passbook || app.passbook.borrower_pk !== borrowerPk) throw new Error('borrower-carried signed passbook required')
    const passbook = await verifyPassbook(app.passbook, this.chain)
    check('passbook', passbook.unverified === 0 && passbook.ladder.open === 0, `${passbook.pages.length} page(s), step ${passbook.ladder.step}, ${passbook.ladder.on_time} on time, all confirmed on Bitcoin`)

    if (agreed) {
      const cap = Math.min(passbook.ladder.allowed_ltv_bps, p.ltv_ladder_bps[Math.min(passbook.ladder.step, p.ltv_ladder_bps.length - 1)], maxLtvForTerm(p.term_blocks, this.economics))
      check('negotiated-ltv', agreed.ltv_bps <= cap, `agreed ${agreed.ltv_bps / 100}% within the earned limit ${cap / 100}%`)
    }
    return passbook
  }

  /**
   * Negotiated origination scored by the deployment's scorer (external provider) instead of the platform
   * sandbox. This lender verifies the released evidence itself with verifyOutcomeForLender: the
   * descriptor against the pinned release manifest, the DSSE envelope with its own external verifier
   * and the evidence keys it holds, the artifact opening, exactly the contract's fields, the binding
   * to this lender, borrower and negotiation, its required checks and its trust minimum. Then the
   * borrower-record checks every application gets. Only QUALIFY is funded: a haircut cannot apply
   * to a principal both agents already agreed. The term sheet binds the evidence digest.
   */
  private async reviewScored(x: { app: ApplicationPayload; borrowerPk: Hex; checks: Check[]; check: (id: string, ok: boolean, detail: string) => void; negotiation?: UnderwriteOptions['negotiation']; agreed?: Position; acceptHash?: Hex }): Promise<TermSheetProposal> {
    const { app, borrowerPk, checks, check, negotiation: n, agreed, acceptHash } = x
    const p = this.policy
    const outcome = app.scorer_outcome!
    check('amount', app.principal >= p.min && app.principal <= p.max && app.term_blocks === p.term_blocks, `${usdt(app.principal)} for ${app.term_blocks} blocks`)
    const consent = app.consent
    let outputs: PassbookCheckOutputs | null = null
    let trust: TrustLevel | null = null
    if (!n || !agreed || !acceptHash || !consent || !app.negotiation?.length) check('scorer-negotiated', false, 'scorer evidence is bound to a negotiation; this application has no verified agreement')
    else if (!this.scoring) check('scorer-verifier', false, 'this lender has no scorer verification configured (deployment scorer.provider external)')
    else {
      // This lender's own requirements as scorer check ids; verify.ts maps reconcile to external provider's history_reconciliation.
      const required = [...new Set([...n.policy.required_checks, ...(p.requirements.investigation === 'required' ? ['investigation'] : []), ...(p.requirements.reconciliation === 'required' ? ['reconcile'] : []), ...(p.requirements.affordability ? ['affordability'] : []), ...(p.requirements.inflow_months > 0 ? ['inflows'] : [])])]
      const minTrust = strongerTrust(this.scoring.policy.minTrust, n.policy.min_scorer_trust)
      // The consent check above allowed only this negotiation's purpose forms; the evidence must be bound to the one the borrower consented to.
      // The loan this lender agreed to and was asked for: the scorer's released outputs (v2) must name exactly it.
      const loan = { loan_request: { principal: app.principal, fee: this.interest(app.principal, agreed.apr_bps), term_blocks: p.term_blocks, grace_blocks: p.grace_blocks }, asset_id: this.assetId, lender_requirements_hash: hashObject(p.requirements) }
      const v = await verifyOutcomeForLender(outcome, { ...this.scoring.policy, minTrust }, { lenderPk: this.pubkey, borrowerPk, purposeId: consent.purpose_id, consentHash: consentHash(consent), requiredChecks: required, loan, ...(this.scoring.externalVerifier ? { externalVerifier: this.scoring.externalVerifier } : {}) })
      for (const t of v.ticks) check(`scorer:${t.id}`, t.ok, t.detail)
      check('scorer-verified', v.ok, v.ok ? `${outcome.descriptor.provider}${v.fallback ? ' (FALLBACK)' : ''} evidence verified by this lender at ${v.trust}; minimum ${minTrust}` : 'the scorer evidence did not verify')
      // For external provider the borrower's approval of the contract version is the consent; the receipt this lender keeps must name that scorer and contract and cover the chain checks.
      check('consent-bound', consent.scorer_id === outcome.descriptor.scorer_id && consent.contract_hash === outcome.descriptor.contract_hash && consent.scorer_pk === outcome.descriptor.enclave_pubkey, `the receipt names ${outcome.descriptor.scorer_id} and its scoring contract`)
      outputs = v.outputs
      trust = v.trust
      // The evidence is bound to a bundle hash only: the observer's signed terms must say that bundle asked for exactly this loan.
      const terms = outputs ? bundleTermsProblems(app.scorer_bundle_terms, {
        bundle_hash: outputs.bundle_hash, borrower_pk: borrowerPk, lender_pk: this.pubkey, purpose_id: consent.purpose_id, offer_id: this.offerId, asset_id: this.assetId,
        loan_request: { principal: app.principal, fee: this.interest(app.principal, agreed.apr_bps), term_blocks: p.term_blocks, grace_blocks: p.grace_blocks },
        lender_requirements: p.requirements, trustedSigners: this.scoring.chainSigners ?? [],
      }) : ['no released outputs']
      check('observer-bundle-terms', terms.length === 0, terms.length ? terms.join('; ') : `the scored bundle asked for ${usdt(app.principal)} over ${p.term_blocks} blocks at the agreed ${agreed.apr_bps / 100}% APR, under this offer's requirements; signed by chain observer ${app.scorer_bundle_terms!.signer_pk.slice(0, 12)}…`)
      check('recommendation', v.ok && outputs?.recommendation === 'QUALIFY', outputs ? `${outputs.recommendation}, income ${outputs.income_band}` : 'no released outputs')
    }
    check('no-disclosures', app.disclosed_inflows.length === 0 && !app.disclosure_items?.length && !app.inflow_proofs?.length, "income evidence is the scorer's band; no inflow is disclosed")
    const passbook = await this.borrowerRecordChecks(app, borrowerPk, agreed, check)
    const failed = checks.filter((c) => !c.ok)
    if (failed.length || !outputs || !trust || !n || !agreed || !acceptHash) {
      await this.say('Application declined', { failed })
      throw new Error(`declined: ${failed.map((c) => `${c.id} (${c.detail})`).join('; ')}`)
    }

    // The agreed APR is the price; the local model only drafts the explanation.
    const memoInput = {
      lender: this.role,
      tenor_blocks: p.term_blocks,
      principal: app.principal,
      passbook: { on_time: passbook.ladder.on_time, late: passbook.ladder.late, defaults: passbook.ladder.defaults, open: passbook.ladder.open, step: passbook.ladder.step, unverified: passbook.unverified },
      verified_inflows: { count: 0, sum: 0, months_covered: 0 },
      checks: outputs.checks.map((c) => ({ id: c.id, ok: c.ok, detail: `${outcome.descriptor.provider} check` })),
      checks_by: outcome.descriptor.provider,
      base_apr_bps: p.apr_bps,
      band: p.band,
    }
    const codedMemo = await new RuleReasoner().creditMemo(memoInput)
    const memo = await this.ai.creditMemo({ ...memoInput, policy_adjustment_bps: codedMemo.adjustment_bps })
    check('clamp', true, `the negotiated ${agreed.apr_bps / 100}% APR stands; model numeric output is ignored`)
    const state = await this.platform.state()
    const quote = await this.platform.quote()
    if (!verifyQuote(quote, state.oracle_pk)) throw new Error('oracle quote does not verify')
    const lastClose = [...passbook.pages].reverse().find((pg) => pg.verified.close && pg.close_txid)?.close_txid ?? null
    const scorer = {
      provider: outcome.descriptor.provider, scorer_id: outcome.descriptor.scorer_id, code_measurement: outcome.descriptor.code_measurement, contract_hash: outcome.descriptor.contract_hash,
      trust, result_hash: scorerResultHash(outcome), fallback: outcome.fallback, recommendation: outputs.recommendation, evidence: evidenceDigest(outcome),
    }
    const proposal = await this.originateNegotiated({ app, borrowerPk, agreed, acceptHash, negotiation: n, quote, platformPk: state.platform_pk, step: passbook.ladder.step, lastClose, scorer, checks, memo: { adjustment_bps: memo.adjustment_bps, applied_bps: 0, clamped: false, flags: memo.flags, text: memo.memo }, scored: outcome })
    // Nothing goes to an approver unless the sheet's own terms are the loan the scorer assessed.
    const sheetLoan = scoredSheetProblems(proposal.sheet, outcome)
    if (sheetLoan.length) throw new Error(`not approving: ${sheetLoan.join('; ')}`)
    return proposal
  }

  /**
   * Negotiated origination with a credit check the borrower bought on the check market
   * (docs/CHECK-MARKET.md). This lender takes the check only from the KEY message the borrower
   * forwarded over Nostr, through verifyForwardedCheck: the signed, hash-chained messages, the
   * offer against this lender's own check_nodes rules (from its signed policy), the operator's
   * commitment, K against it, the derived execution tier, then the scorer evidence with the same
   * verifier as any scorer (pinned releases, required checks, the agreed loan). Then the
   * borrower-record checks every application gets; only QUALIFY is funded, as for reviewScored.
   * The term sheet binds the evidence digest and names the receipt's contract id next to it.
   */
  private async reviewChecked(x: { app: ApplicationPayload; borrowerPk: Hex; checks: Check[]; check: (id: string, ok: boolean, detail: string) => void; negotiation?: UnderwriteOptions['negotiation']; agreed?: Position; acceptHash?: Hex; market?: LenderCheckMarket; timeoutMs?: number; lenderPaid?: LenderCheckResult }): Promise<TermSheetProposal> {
    const { app, borrowerPk, checks, check, negotiation: n, agreed, acceptHash, market } = x
    const p = this.policy
    check('amount', app.principal >= p.min && app.principal <= p.max && app.term_blocks === p.term_blocks, `${usdt(app.principal)} for ${app.term_blocks} blocks`)
    const consent = app.consent
    let v: ForwardedCheckVerification | null = null
    let outputs: PassbookCheckOutputs | null = null
    let trust: TrustLevel | null = null
    if (!n || !agreed || !acceptHash || !consent || !app.negotiation?.length) check('check-negotiated', false, 'a check bought on the market is bound to a negotiation; this application has no verified agreement')
    else if (!market && !x.lenderPaid) check('check-verifier', false, 'this lender has no check-market verification configured')
    else {
      const negotiationId = app.negotiation[0].negotiation_id
      // Lender-paid: this lender's own result, and the application must name the KEY it forwarded; otherwise the borrower forwards the KEY.
      const lp = x.lenderPaid
      const key = lp
        ? (lp.key.negotiation_id === negotiationId && checkMessageHash(lp.key) === app.check_key ? { payload: lp.key } : null)
        : await chunkedBus(this.relay).receive<CheckMessage>(KIND.CHECK_KEY, borrowerPk, { timeoutMs: x.timeoutMs ?? 60_000, match: (m) => m?.negotiation_id === negotiationId && checkMessageHash(m) === app.check_key }).catch(() => null)
      if (!key) check('check-key', false, `no KEY message ${String(app.check_key).slice(0, 12)}… from this borrower for this negotiation`)
      else {
        // This lender's own requirements as scorer check ids, and the loan it agreed to: as for reviewScored.
        const required = this.requiredScorerChecks(n.policy)
        const minTrust = strongerTrust(market?.trust.minTrust ?? n.policy.min_scorer_trust, n.policy.min_scorer_trust)
        const loan = { loan_request: { principal: app.principal, fee: this.interest(app.principal, agreed.apr_bps), term_blocks: p.term_blocks, grace_blocks: p.grace_blocks }, asset_id: this.assetId, lender_requirements_hash: hashObject(p.requirements) }
        const now = Math.floor(Date.now() / 1000)
        v = lp ? lp.verification : await verifyForwardedCheck(key.payload, { negotiation_id: negotiationId, borrower_pk: borrowerPk, lender_pk: this.pubkey, payer_pk: borrowerPk, rules: n.policy.check_nodes ?? {}, trust: { ...market!.trust, minTrust }, tee: market!.tee(now), requiredChecks: required, loan, now })
        for (const t of v.ticks) check(`check:${t.id}`, t.ok, t.detail)
        const o = v.outcome
        check('check-verified', v.ok && !!o, v.ok && o ? `${o.descriptor.provider}${o.fallback ? ' (FALLBACK)' : ''} evidence from check node ${v.operator_pk!.slice(0, 12)}… verified by this lender at ${v.scorer!.trust}, minimum ${minTrust}; ${v.rail_label}; ${EXECUTION_TIER_LABEL[v.execution!.tier]}` : 'the forwarded check did not verify')
        check('consent-bound', !!v.commitment && !!o && v.commitment.consent_hash === consentHash(consent) && consent.operator_pk === v.operator_pk && consent.scorer_id === o.descriptor.scorer_id && consent.contract_hash === o.descriptor.contract_hash, 'the consent receipt in the application is the one the operator signed into its commitment, naming that operator and scorer')
        outputs = v.scorer?.outputs ?? null
        trust = v.scorer?.trust ?? null
        check('recommendation', v.ok && outputs?.recommendation === 'QUALIFY', outputs ? `${outputs.recommendation}, income ${outputs.income_band}` : 'no released outputs')
      }
    }
    if (app.check_receipt !== undefined) check('check-receipt', /^rgb:[A-Za-z0-9~_.-]{10,120}$/.test(String(app.check_receipt?.contract_id)), `the borrower holds receipt ${String(app.check_receipt?.contract_id).slice(0, 24)}…; the sheet names it next to the commitment this lender verified (reading that token on RGB is the borrower's node's check, not this lender's)`)
    check('no-disclosures', app.disclosed_inflows.length === 0 && !app.disclosure_items?.length && !app.inflow_proofs?.length, "income evidence is the scorer's band; no inflow is disclosed")
    const passbook = await this.borrowerRecordChecks(app, borrowerPk, agreed, check)
    const failed = checks.filter((c) => !c.ok)
    if (failed.length || !v?.outcome || !v.commitment || !v.operator_pk || !outputs || !trust || !n || !agreed || !acceptHash) {
      await this.say('Application declined', { failed })
      throw new Error(`declined: ${failed.map((c) => `${c.id} (${c.detail})`).join('; ')}`)
    }
    const outcome = v.outcome

    // The agreed APR is the price; the local model only drafts the explanation.
    const memoInput = {
      lender: this.role,
      tenor_blocks: p.term_blocks,
      principal: app.principal,
      passbook: { on_time: passbook.ladder.on_time, late: passbook.ladder.late, defaults: passbook.ladder.defaults, open: passbook.ladder.open, step: passbook.ladder.step, unverified: passbook.unverified },
      verified_inflows: { count: 0, sum: 0, months_covered: 0 },
      checks: outputs.checks.map((c) => ({ id: c.id, ok: c.ok, detail: `${outcome.descriptor.provider} check on a check node` })),
      checks_by: outcome.descriptor.provider,
      base_apr_bps: p.apr_bps,
      band: p.band,
    }
    const codedMemo = await new RuleReasoner().creditMemo(memoInput)
    const memo = await this.ai.creditMemo({ ...memoInput, policy_adjustment_bps: codedMemo.adjustment_bps })
    check('clamp', true, `the negotiated ${agreed.apr_bps / 100}% APR stands; model numeric output is ignored`)
    const state = await this.platform.state()
    const quote = await this.platform.quote()
    if (!verifyQuote(quote, state.oracle_pk)) throw new Error('oracle quote does not verify')
    const lastClose = [...passbook.pages].reverse().find((pg) => pg.verified.close && pg.close_txid)?.close_txid ?? null
    const scorer = {
      provider: outcome.descriptor.provider, scorer_id: outcome.descriptor.scorer_id, code_measurement: outcome.descriptor.code_measurement, contract_hash: outcome.descriptor.contract_hash,
      trust, result_hash: scorerResultHash(outcome), fallback: outcome.fallback, recommendation: outputs.recommendation, evidence: evidenceDigest(outcome),
      // The commitment and operator are what this lender verified; only the contract id comes from the borrower.
      ...(app.check_receipt ? { check_receipt: { contract_id: app.check_receipt.contract_id, commitment: v.commitment.commitment, operator_pk: v.operator_pk } } : {}),
    }
    const proposal = await this.originateNegotiated({ app, borrowerPk, agreed, acceptHash, negotiation: n, quote, platformPk: state.platform_pk, step: passbook.ladder.step, lastClose, scorer, checks, memo: { adjustment_bps: memo.adjustment_bps, applied_bps: 0, clamped: false, flags: memo.flags, text: memo.memo }, scored: outcome })
    const sheetLoan = scoredSheetProblems(proposal.sheet, outcome)
    if (sheetLoan.length) throw new Error(`not approving: ${sheetLoan.join('; ')}`)
    return { ...proposal, check: v }
  }

  /**
   * Negotiated origination: the term sheet follows the agreed position exactly, its
   * hash is the terms hash the lock will commit, and it carries the scorer's evidence
   * digest (the sandbox run record or the external provider envelope) and the borrower's consent hash. The lender's human approval (two keys
   * above the maker-checker threshold) comes before the sheet is sent (sendTermSheet).
   */
  private async originateNegotiated(x: {
    app: ApplicationPayload; borrowerPk: Hex; agreed: Position; acceptHash: Hex; negotiation: NonNullable<UnderwriteOptions['negotiation']>
    quote: LoanTerms['oracle_quote']; platformPk: Hex; step: number; lastClose: Hex | null; scorer: TermSheetScorer & { evidence: TermSheetEvidence }; checks: Check[]; memo: Underwriting['memo']; scored?: ScorerOutcome
  }): Promise<TermSheetProposal> {
    const p = this.policy
    const fee = this.interest(x.agreed.principal, x.agreed.apr_bps)
    const draft = { borrower_pk: x.borrowerPk, lender_pk: this.pubkey, platform_pk: x.platformPk, asset_id: this.assetId, principal: x.agreed.principal, fee, collateral_sats: 1, oracle_quote: x.quote, open_height: x.quote.height, maturity_height: x.quote.height + p.term_blocks, grace_blocks: p.grace_blocks, recovery_height: x.quote.height + p.term_blocks + p.grace_blocks + 20, ladder_step: x.step, ltv_bps: x.agreed.ltv_bps, prev_passbook_txid: x.lastClose, nonce: '00'.repeat(32) }
    // The invoice covers principal plus termInterest, which do not depend on collateral or nonce.
    const settlement = this.lightning ? { kind: 'ln-rln' as const, atomic: await createAtomicRepayment(this.lightning, { ...draft, v: 1 }) } : { kind: 'cosign-rgb' as const }
    const sheet = signTermSheet(buildTermSheet({
      agreed: x.agreed, negotiation: { id: x.app.negotiation![0].negotiation_id, accept_hash: x.acceptHash },
      borrower_pk: x.borrowerPk, lender_pk: this.pubkey, platform_pk: x.platformPk, asset_id: this.assetId, oracle_quote: x.quote, grace_blocks: p.grace_blocks, ladder_step: x.step, prev_passbook_txid: x.lastClose,
      economics: this.economics, settlement, scorer: x.scorer,
      consent_hash: consentHash(x.app.consent!), salt: randomHex(32),
    }), 'lender', this.party.key.secretKey)
    const problems = termSheetProblems(sheet, { economics: this.economics, agreed: x.agreed, accept_hash: x.acceptHash })
    if (problems.length) throw new Error(`term sheet does not follow the agreement: ${problems.join('; ')}`)
    // Nothing is put in front of an approver unless the sheet names exactly the evidence this lender verified.
    const evidenceProblems = sheetDigestProblems(sheet, x.scorer.evidence, x.scorer.result_hash)
    if (evidenceProblems.length) throw new Error(`not approving: ${evidenceProblems.join('; ')}`)
    return { loan_id: termSheetHash(sheet), borrower_pk: x.borrowerPk, sheet, passbook: x.app.passbook!, negotiation: x.negotiation, checks: x.checks, memo: x.memo, ...(x.scored ? { scored: x.scored } : {}) }
  }

  /**
   * Negotiated origination, second half: with the lender's approvals of exactly the proposed
   * sheet (two keys above the maker-checker threshold), register it and send it to the borrower.
   * The proposal may come back from the demo's private journal, so its binding is checked again.
   */
  async sendTermSheet(proposal: TermSheetProposal, approvals: Approval[]): Promise<Underwriting> {
    const { sheet, negotiation } = proposal
    const problems = termSheetProblems(sheet, { economics: this.economics })
    if (problems.length || !sheet.signatures.lender || sheet.terms.lender_pk !== this.pubkey || sheet.terms.asset_id !== this.assetId || sheet.terms.borrower_pk !== proposal.borrower_pk || termSheetHash(sheet) !== proposal.loan_id || negotiation.policy.owner_pk !== this.pubkey || !policyValid(negotiation.policy)) {
      throw new Error(`term sheet proposal does not bind this lender's signed sheet${problems.length ? `: ${problems.join('; ')}` : ''}`)
    }
    const loanId = proposal.loan_id
    const status = approvalStatus(sheet, approvals, negotiation.policy, negotiation.makerCheckerAboveMicro)
    if (status.lender_approvers.length < status.required_lender_approvals || status.problems.length) {
      await this.say('Term sheet not approved by the lender', { approvers: status.lender_approvers.length, required: status.required_lender_approvals, problems: status.problems })
      throw new Error(`lender approval incomplete: ${status.lender_approvers.length}/${status.required_lender_approvals}${status.problems.length ? ` (${status.problems.join(', ')})` : ''}`)
    }
    const { loan } = await this.platform.registerLoan(sheet.terms, proposal.passbook)
    if (loan.id !== loanId) throw new Error('platform registered a different loan id than the term-sheet hash')
    this.loans.set(loan.id, { terms: sheet.terms, borrower_pk: proposal.borrower_pk, termsheet: sheet, lender_approvals: approvals, negotiation_policy: negotiation.policy, maker_checker_above: negotiation.makerCheckerAboveMicro })
    // Negotiated over Nostr: the node logs its approval next to its sanctions screen and names both entries to the borrower.
    const screened = this.nostrNegotiation ? this.screeningFor(sheet.negotiation.id) : undefined
    const decisions = screened ? [screened, this.governance.gate.log.append({
      kind: 'approval', action_id: null, loan_id: loanId, policy_version: this.governance.gate.activePolicy()?.policy.version ?? null, input_hashes: { termsheet: loanId, approvals: hashObject(approvals) }, decided_by: { kind: 'human', pk: approvals[0].approver_pk }, result: 'approved',
      detail: { purpose: 'term-sheet', negotiation_id: sheet.negotiation.id, approvers: approvals.map((a) => a.approver_pk), required: status.required_lender_approvals },
    })] : undefined
    const acceptance: AcceptancePayload = { offer_id: this.offerId, terms: sheet.terms, terms_hash: loanId, termsheet: sheet, lender_approvals: approvals, lender_policy: negotiation.policy, ...(decisions ? { lender_decisions: decisions } : {}) }
    await this.relay.send(KIND.ACCEPTANCE, acceptance, proposal.borrower_pk)
    const evidence = sheet.scorer.evidence
    await this.say('Term sheet approved and sent', {
      loan_id: loanId.slice(0, 12), apr: `${sheet.apr_bps / 100}% (negotiated)`, fee: usdt(sheet.terms.fee), interest: lenderReturnLine(sheet.terms, this.economics),
      ltv: `${sheet.terms.ltv_bps / 100}% (step ${sheet.ladder_step})`, collateral_sats: sheet.terms.collateral_sats, approvers: approvals.length, evidence: evidence?.kind === 'passbook-run-record' ? `${evidence.run_record_sha256.slice(0, 12)}…` : evidence?.kind === 'external-evidence' ? `external evidence ${evidence.evidence_sha256.slice(0, 12)}…` : 'none',
    })
    return { loan_id: loanId, borrower_pk: proposal.borrower_pk, terms: sheet.terms, checks: proposal.checks, memo: proposal.memo, apr_bps: sheet.apr_bps }
  }

  private loan(loanId: Hex): LenderLoan {
    const l = this.loans.get(loanId)
    if (!l) throw new Error(`no loan ${loanId.slice(0, 12)} on this lender`)
    return l
  }

  /** Take the borrower's split signature, check it, keep it, then disburse the principal over RGB. */
  async fund(loanId: Hex): Promise<{ disbursement_txid: Hex; repayment_invoice: string }> {
    const l = this.loan(loanId)
    if (l.disbursement_attempted) throw new Error('disbursement already attempted for this loan; reconcile the wallet before retrying')
    const { payload: req } = await this.relay.receive<SignRequestPayload>(KIND.SIGN_REQUEST, l.borrower_pk, { match: (r) => r.loan_id === loanId && r.purpose === 'split' })
    if (l.termsheet) {
      // Nothing moves before both humans approved this exact sheet: the borrower's approval rides on the split request.
      const sheet = req.termsheet
      const sameSheet = !!sheet && termSheetHash(sheet) === loanId && termSheetProblems(sheet, { economics: this.economics, requireSignatures: true }).length === 0 && hashObject({ ...sheet, signatures: {} }) === hashObject({ ...l.termsheet, signatures: {} })
      const status = sameSheet && req.borrower_approval ? approvalStatus(sheet!, [...(l.lender_approvals ?? []), req.borrower_approval], l.negotiation_policy!, l.maker_checker_above!) : null
      if (!status?.complete) throw new Error(`refusing to fund: term sheet ${sameSheet ? 'approvals incomplete' : 'missing, altered or not countersigned'}${status?.problems.length ? ` (${status.problems.join(', ')})` : ''}`)
      l.termsheet = sheet
      await this.say('Both approvals of the term sheet verified', { loan_id: loanId.slice(0, 12), borrower: 'approved', lender_approvers: status.lender_approvers.length })
    }
    const parties = partiesOf(l.terms)
    const requested = psbtFromBase64(req.psbt_base64)
    const d = describePsbt(requested)
    const input = d.inputs[0]
    const lock = input ? await this.chain.getTx(input.txid) : null
    const lockOk = !!lock?.height && lock.outputs[input.vout]?.script === escrowFor(parties).script && lock.outputs[input.vout]?.value === l.terms.collateral_sats && lock.outputs.some((o) => o.script === `6a20${loanId}`) && (l.terms.prev_passbook_txid === null || lock.inputs.some((i) => i.txid === l.terms.prev_passbook_txid))
    if (!lockOk || req.terms_hash !== loanId || d.inputs.length !== 1 || !req.disbursement_invoice) throw new Error('split request does not match the terms')
    const actual = lock!.outputs[input.vout]
    const escrow = escrowFor(parties)
    const leaf = escrow.leaves.A
    const metadata = requested.data.inputs[0]
    const suppliedLeaf = metadata.tapLeafScript?.[0]
    const borrowerSignature = leafSignature(requested, parties, 'A', 'borrower')
    const metadataOk =
      metadata.witnessUtxo?.value === BigInt(actual.value) &&
      bytesToHex(metadata.witnessUtxo.script) === actual.script &&
      metadata.tapLeafScript?.length === 1 && !!suppliedLeaf &&
      suppliedLeaf.leafVersion === 0xc0 &&
      bytesToHex(suppliedLeaf.script) === bytesToHex(leaf.script) &&
      bytesToHex(suppliedLeaf.controlBlock) === bytesToHex(leaf.controlBlock) &&
      (metadata.sighashType === undefined || metadata.sighashType === 0) &&
      metadata.tapScriptSig?.length === 1 && borrowerSignature?.length === 128 &&
      metadata.nonWitnessUtxo === undefined && metadata.tapKeySig === undefined &&
      metadata.finalScriptWitness === undefined && metadata.finalScriptSig === undefined &&
      metadata.redeemScript === undefined && metadata.witnessScript === undefined
    if (!metadataOk) throw new Error('split PSBT metadata does not match the confirmed collateral and leaf A')
    // Hash only our canonical template against the actual prevout. Never trust
    // a valid signature whose message was derived from borrower-supplied UTXO data.
    const psbt = buildEscrowSpend({ escrow: { txid: input.txid, vout: input.vout, value: actual.value }, parties, leaf: 'A', outputs: splitOutputs(l.terms), locktime: splitLocktime(l.terms) })
    if (unsignedTxid(requested) !== unsignedTxid(psbt)) throw new Error('split transaction does not match the canonical default template')
    try { addLeafSignature(psbt, parties, 'A', 'borrower', borrowerSignature!) }
    catch { throw new Error('split borrower signature does not verify against the confirmed collateral') }
    l.lock = { txid: input.txid, vout: input.vout }
    // the default path: if the borrower never repays, this plus our own signature settles after maturity + grace
    const dir = join(dirname(this.party.rgb.dataDir), 'loans')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${loanId}.split.psbt`), psbt.toBase64())
    await this.say('Holding the borrower-signed default split', { txid: d.txid.slice(0, 12), locktime: d.locktime, lender_sats: d.outputs[0].value })

    if (l.disbursement_attempted) throw new Error('disbursement already attempted for this loan; reconcile the wallet before retrying')
    l.disbursement_attempted = true
    const { txid } = await this.sendRgb({ invoice: req.disbursement_invoice, assetId: this.assetId, amount: l.terms.principal }, { action: 'fund', terms: l.terms, counterparty: l.borrower_pk, recipientOwner: l.borrower_pk, ...fundingInputs(l.terms, l.termsheet) })
    await awaitSettled(this.party.rgb, { assetId: this.assetId, txid, kind: 'Send', mine: () => this.mine(1) })
    await this.index('funded', () => this.platform.recordFunded(loanId, txid, fundingNotice(this.party.key, loanId, txid)))
    // the repayment goes to a per-loan account from our seed; the platform watches it with xpubs only
    const mnemonic = repaymentMnemonic(this.party.key.secretKey, loanId)
    const keys = await watchKeys(mnemonic)
    const issued = await this.platform.repaymentWatch(loanId, keys, repaymentWatchRequest(this.party.key, loanId, keys))
    l.repayment_recipient_id = issued.recipient_id
    l.repayment_account = await openRepaymentAccount(mnemonic, join(dir, loanId, 'rgb'), issued)
    const invoice = l.terms.v === 2 ? l.terms.atomic_repayment!.invoice : issued.invoice
    const funded: FundedPayload = { loan_id: loanId, disbursement_txid: txid, repayment_invoice: invoice, iou_invoice: this.party.rgb.invoice(debtOf(l.terms)).invoice, ...(l.terms.v === 2 ? { fallback_repayment_invoice: issued.invoice } : {}) }
    await this.relay.send(KIND.FUNDED, funded, l.borrower_pk)
    await this.say('Disbursed over RGB', { txid: txid.slice(0, 12), amount: usdt(l.terms.principal), repayment_invoice: `${issued.recipient_id.slice(0, 24)}… issued by the platform on our repayment account ${keys.master_fingerprint}` })
    return { disbursement_txid: txid, repayment_invoice: invoice }
  }

  /** Observe the actual inbound Lightning payment. No release signature or
   * platform acknowledgement is needed on leaf E. */
  async confirmAtomicRepayment(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    const a = l.terms.atomic_repayment
    if (l.terms.v !== 2 || !a || !this.lightning) throw new Error('not an atomic Lightning loan')
    const p = await this.lightning.getPayment(a.payment_hash)
    if (!p.inbound || p.status !== 'Succeeded' || p.payment_hash !== a.payment_hash || p.asset_id !== l.terms.asset_id || p.asset_amount !== debtOf(l.terms) || !verifyPreimage(p.preimage, a.payment_hash)) throw new Error('lender Lightning node has not received this full repayment')
    if (this.iou.notes.has(loanId)) {
      const { payload } = await this.relay.receive<AtomicRepaidPayload>(KIND.ATOMIC_REPAID, l.borrower_pk, { match: (r) => r.loan_id === loanId && r.payment_hash === a.payment_hash })
      const certificate = this.iou.notes.get(loanId)!.certificate
      const close = await this.chain.getTx(payload.release_txid)
      const input = close?.inputs.find((i) => i.txid === certificate.lock_txid && i.vout === certificate.lock_vout)
      if (!close?.height || !input || atomicWitnessPreimage(input, l.terms) !== p.preimage) throw new Error('IOU return request lacks this loan’s confirmed leaf E proof')
      if (payload.note_return_invoice) await this.iou.returnNote(loanId, payload.note_return_invoice)
    }
    await this.say('RGB Lightning repayment received; no release signature needed', { payment_hash: a.payment_hash, amount: usdt(p.asset_amount), preimage: p.preimage })
    return a.payment_hash
  }

  async sellIou(loanId: Hex, sale: NoteSale): Promise<IouOwnership> {
    const l = this.loan(loanId)
    const owner = await this.iou.sell(sale)
    l.assigned_owner = owner
    return owner
  }

  async acceptIou(terms: LoanTerms, owner: IouOwnership): Promise<void> {
    if (owner.holder_pk !== this.pubkey || !await verifyOwnership(owner, terms, this.chain) || !this.iou.notes.has(termsHash(terms))) throw new Error('IOU not received by this lender')
    this.loans.set(termsHash(terms), { terms, borrower_pk: terms.borrower_pk, assigned_owner: owner, repayment_recipient_id: this.party.rgb.invoiceRecipient(owner.assignments.at(-1)!.repayment_invoice) })
  }

  async awaitIou(loanId: Hex): Promise<void> { await this.iou.receiveIssued(this.loan(loanId).terms) }

  /**
   * The borrower says it repaid: see it settle in our repayment account, then acknowledge to the platform.
   * `acknowledge: false` is the scenario where the lender keeps the USDT and stays silent.
   */
  async confirmRepayment(loanId: Hex, opts: { acknowledge?: boolean } = {}): Promise<Hex> {
    const l = this.loan(loanId)
    const { payload } = await this.relay.receive<RepaidPayload>(KIND.REPAID, l.borrower_pk, { match: (r) => r.loan_id === loanId })
    if (l.assigned_owner && l.assigned_owner.holder_pk !== this.pubkey) throw new Error('repayment belongs to the assigned IOU holder')
    const account = l.repayment_account ?? this.party.rgb
    const t = await awaitSettled(account, { assetId: this.assetId, txid: payload.repayment_txid, kind: 'ReceiveWitness', mine: () => this.mine(1) })
    if (l.repayment_recipient_id && t.recipientId !== l.repayment_recipient_id) throw new Error('repayment does not settle this loan holder invoice')
    if (t.amount < debtOf(l.terms)) throw new Error(`repayment ${usdt(t.amount)} is short of ${usdt(debtOf(l.terms))}`)
    l.repayment_txid = payload.repayment_txid
    if (opts.acknowledge === false) {
      await this.say('Repayment settled in our repayment account; not acknowledging it (scenario)', { txid: payload.repayment_txid.slice(0, 12), amount: usdt(t.amount) })
      return payload.repayment_txid
    }
    l.repayment_receipt = rgbRepaymentReceipt(this.party.key, l.terms, payload.repayment_txid, t.amount)
    await this.relay.send(KIND.REPAYMENT_RECEIPT, l.repayment_receipt, l.borrower_pk)
    if (l.terms.lender_pk !== this.pubkey) await this.relay.send(KIND.REPAYMENT_RECEIPT, l.repayment_receipt, l.terms.lender_pk)
    await this.index('repaid', () => this.platform.recordRepaid(loanId, payload.repayment_txid, repaymentAck(this.party.key, loanId, payload.repayment_txid)))
    if (payload.note_return_invoice && this.iou.notes.has(loanId)) await this.iou.returnNote(loanId, payload.note_return_invoice)
    await this.say('Repayment settled in our repayment account; acknowledged', { txid: payload.repayment_txid.slice(0, 12), amount: usdt(t.amount) })
    return payload.repayment_txid
  }

  /**
   * Co-sign the release (leaf A) once our own wallet saw the repayment, and only if it pays the borrower everything back.
   * `refuse` is the scenario where the lender took the USDT and will not sign: the borrower then goes to the platform (leaf C).
   */
  async signRelease(loanId: Hex, opts: { refuse?: string } = {}): Promise<Hex | null> {
    const l = this.loan(loanId)
    const { payload: req } = await this.relay.receive<SignRequestPayload>(KIND.SIGN_REQUEST, l.borrower_pk, { match: (r) => r.loan_id === loanId && r.purpose === 'release' })
    const record = { lock_txid: l.lock?.txid, lock_vout: l.lock?.vout }
    const parties = partiesOf(l.terms)
    const psbt = psbtFromBase64(req.psbt_base64)
    const d = describePsbt(psbt)
    const refuse = async (why: string) => {
      const sig: SignaturePayload = { loan_id: loanId, txid: d.txid, refused: why }
      await this.relay.send(KIND.SIGNATURE, sig, l.borrower_pk)
      throw new Error(`release refused: ${why}`)
    }
    if (opts.refuse) {
      await this.relay.send(KIND.SIGNATURE, { loan_id: loanId, txid: d.txid, refused: opts.refuse } satisfies SignaturePayload, l.borrower_pk)
      await this.say('Release refused although the repayment settled (scenario)', { txid: d.txid.slice(0, 12), reason: opts.refuse })
      return null
    }
    if (l.assigned_owner && l.assigned_owner.holder_pk !== this.pubkey) {
      const { payload: receipt } = await this.relay.receive<RgbRepaymentReceipt>(KIND.REPAYMENT_RECEIPT, l.assigned_owner.holder_pk, { match: (r) => r.loan_id === loanId })
      if (!verifyReceipt(receipt, l.assigned_owner.holder_pk) || receipt.domain !== 'passbook-rgb-repayment-v1' || receipt.validation !== 'rgb-lib-settled' || receipt.asset_id !== this.assetId || receipt.validator_pk !== l.assigned_owner.holder_pk || !Number.isSafeInteger(receipt.amount) || receipt.amount < debtOf(l.terms) || !(await this.chain.getTx(receipt.repayment_txid))?.height) return refuse('assigned holder receipt is invalid')
      l.repayment_txid = receipt.repayment_txid
      l.repayment_receipt = receipt
      await this.index('assigned repayment', () => this.platform.recordRepaid(loanId, receipt.repayment_txid, repaymentAck(this.party.key, loanId, receipt.repayment_txid)))
    }
    if (!l.repayment_txid) return refuse('no repayment acknowledged for this loan')
    if (d.inputs.length !== 1 || d.inputs[0].txid !== record.lock_txid || d.inputs[0].vout !== record.lock_vout) return refuse('does not spend the collateral output')
    if (canonicalJson(d.outputs) !== canonicalJson(releaseOutputs(l.terms))) return refuse('does not pay the collateral back to the borrower')
    if (!verifyLeafSignature(psbt, parties, 'A', 'borrower')) return refuse('borrower signature missing or invalid')
    await this.signLeaf(psbt, parties, 'A', { action: 'release', terms: l.terms, counterparty: l.borrower_pk })
    const sig: SignaturePayload = { loan_id: loanId, txid: unsignedTxid(psbt), signature: leafSignature(psbt, parties, 'A', 'lender')!, repayment_receipt: l.repayment_receipt ?? rgbRepaymentReceipt(this.party.key, l.terms, l.repayment_txid!, debtOf(l.terms)) }
    await this.relay.send(KIND.SIGNATURE, sig, l.borrower_pk)
    await this.say('Release co-signed (leaf A)', { txid: sig.txid.slice(0, 12) })
    return sig.txid
  }

  /**
   * Where a loan stands against the liquidation rule, from a verified oracle
   * quote and the platform's recorded margin call. Code only.
   */
  async assess(loanId: Hex): Promise<LiquidationDue & { price_cents: number; height: number }> {
    const l = this.loan(loanId)
    const record = await this.platform.loan(loanId)
    const state = await this.platform.state()
    const quote = await this.platform.quote()
    if (!verifyQuote(quote, state.oracle_pk)) throw new Error('oracle quote does not verify')
    const due = liquidationDue(debtOf(l.terms), l.terms.collateral_sats, quote.price_cents, record.margin_call_height, quote.height)
    await this.say(due.ok ? 'Liquidation due: cure window over at or above 80% LTV' : 'Watching the margin call', {
      ltv: pct(due.headroom.ltv_bps),
      price: `$${(quote.price_cents / 100).toLocaleString('en-US')}`,
      margin_call: record.margin_call_height ?? null,
      cure_until: due.cure_until_height ?? null,
      height: quote.height,
    })
    return { ...due, price_cents: quote.price_cents, height: quote.height }
  }

  /**
   * Liquidate through leaf B (lender + platform). The lender checks the rule
   * itself, builds the spend paying exactly `liquidationOutputs` at the quoted
   * price (exactly the debt to us, no penalty, the rest back to the borrower), asks
   * the platform to check and co-sign it, adds its own signature, broadcasts and
   * records the settlement. No model is consulted.
   */
  async liquidate(loanId: Hex): Promise<Liquidation> {
    const l = this.loan(loanId)
    const record = await this.platform.loan(loanId)
    if (record.status !== 'open' || !record.lock_txid || record.lock_vout === undefined) throw new Error(`loan is ${record.status}, nothing to liquidate`)
    const due = await this.assess(loanId)
    if (!due.ok) throw new Error(`not liquidatable: ${pct(due.headroom.ltv_bps)} LTV, ${due.cure_until_height === undefined ? 'no margin call' : `cure until ${due.cure_until_height}`} at height ${due.height}`)
    const parties = partiesOf(l.terms)
    const outputs = liquidationOutputs(l.terms, due.price_cents)
    const psbt = buildEscrowSpend({ escrow: { txid: record.lock_txid, vout: record.lock_vout, value: l.terms.collateral_sats }, parties, leaf: 'B', outputs })
    const decision = await this.platform.cosign({ loan_id: loanId, purpose: 'liquidate', psbt: psbt.toBase64() })
    if (!decision.ok || !decision.psbt) throw new Error(`platform refused to co-sign: ${decision.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
    const signed = psbtFromBase64(decision.psbt)
    // what comes back must be the transaction we built, with a valid platform signature for leaf B
    if (unsignedTxid(signed) !== unsignedTxid(psbt) || !verifyLeafSignature(signed, parties, 'B', 'platform')) throw new Error('platform returned a different or unsigned transaction')
    await this.signLeaf(signed, parties, 'B', { action: 'liquidate', terms: l.terms, counterparty: l.borrower_pk })
    finalizeEscrowSpend(signed, parties, 'B')
    const txid = await this.broadcast(extractHex(signed))
    await this.mine(1)
    await this.platform.settle(loanId, txid, 'liquidated')
    const lender_sats = outputs[0].value
    const borrower_sats = outputs[1]?.value ?? 0
    await this.say('Liquidated through leaf B with the platform', { txid: txid.slice(0, 12), price: `$${(due.price_cents / 100).toLocaleString('en-US')}`, ltv: pct(due.headroom.ltv_bps), to_us: btc(lender_sats), to_borrower: btc(borrower_sats) })
    return { txid, price_cents: due.price_cents, ltv_bps: due.headroom.ltv_bps, lender_sats, borrower_sats, checks: decision.checks }
  }

  /**
   * Pay the platform's share of interest on every closed loan it invoiced us for, from our
   * own USDT, then have the platform validate the receive. `approve` is the human's
   * approval of each payment (the dashboard's Pay, which can't be undone); without it the
   * agent pays. Returns the fees it paid.
   */
  async payPlatformFees(opts: { approve?: (fee: FeeRecord) => Promise<boolean>; loanId?: Hex } = {}): Promise<FeeRecord[]> {
    const { fees } = await this.platform.fees(this.pubkey)
    // every due fee, payable or not yet: one whose invoice never issued or is expiring gets a fresh one first
    const due = fees.filter((f) => f.status === 'fee_due' && (opts.loanId === undefined || f.loan_id === opts.loanId))
    const paid: FeeRecord[] = []
    for (const owed of due) {
      let f: FeeRecord
      try { f = await this.platform.feeInvoice(owed.loan_id) } catch (err) {
        await this.say('Platform fee not payable yet', { loan_id: owed.loan_id.slice(0, 12), amount: usdt(owed.amount), reason: (err as Error).message })
        continue
      }
      if (f.status !== 'fee_due' || !f.invoice) continue
      if (opts.approve && !(await opts.approve(f))) continue
      const send = () => this.sendRgb({ invoice: f.invoice!, assetId: f.asset_id, amount: f.amount }, { action: 'fee-payment' })
      let sent: { txid: string }
      try { sent = await send() } catch (err) {
        // every RGB send needs a free colorable UTXO; top them up from our vanilla BTC once, then retry
        if (!/alloc|utxo|slot/i.test((err as Error).message)) throw err
        await this.party.rgb.createUtxos()
        await this.mine(1)
        sent = await send()
      }
      const txid = sent.txid
      await awaitSettled(this.party.rgb, { assetId: f.asset_id, txid, kind: 'Send', mine: () => this.mine(1) })
      let v = await this.platform.verifyFee(f.loan_id, txid)
      // the platform's wallet may need one more block to settle its side of the receive
      for (let i = 0; !v.ok && i < 3; i++) {
        await this.mine(1)
        v = await this.platform.verifyFee(f.loan_id, txid)
      }
      if (!v.ok || !v.fee) throw new Error(`platform did not validate the fee payment: ${v.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
      paid.push(v.fee)
      await this.say('Platform fee paid over RGB', { loan_id: f.loan_id.slice(0, 12), amount: usdt(f.amount), share: `${f.share_bps / 100}% of ${usdt(f.interest)} interest`, outcome: f.outcome, txid: txid.slice(0, 12) })
    }
    return paid
  }

  /** USDT held: the main wallet plus each loan's repayment account. */
  usdtHeld(): number {
    let sum = this.party.rgb.balance(this.assetId).settled
    for (const l of this.loans.values()) {
      if (!l.repayment_account) continue
      l.repayment_account.refresh()
      sum += l.repayment_account.balance(this.assetId).settled
    }
    return sum
  }

  override close(): void {
    this.checkpointClosed = true
    try { this.closeRepaymentAccounts([...this.loans.values()].flatMap((l) => l.repayment_account ? [l.repayment_account] : [])) }
    finally { super.close() }
  }
}
