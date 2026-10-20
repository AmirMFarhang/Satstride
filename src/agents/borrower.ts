// The borrower's wallet agent. It reads its own passbook and the order book,
// builds the sandbox bundle from its own RGB wallet and keeps it to itself
// (only the encrypted bundle goes to the sandbox), lets the person approve
// each disclosed item, checks the lender's terms, locks the collateral with the
// terms hash, signs the default split, receives USDT, repays over RGB and gets
// the release co-signed: by the lender through leaf A, or, if the lender takes the
// USDT and refuses, by the platform through leaf C once it has validated the RGB
// repayment itself. The model explains the split; it decides nothing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson, hashObject, isHex, signHash, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { btc, collateralFor, ltvBps, pct, usdt, type Bps, type Micro, type Sats } from '../core/money.js'
import { debtOf, termsHash, validateTerms, type LoanTerms } from '../core/terms.js'
import { feeWithinApr, impliedAprBps, termInterest } from '../core/economics.js'
import {
  addLeafSignature,
  buildEscrowSpend,
  buildLock,
  extractHex,
  escrowFor,
  finalizeEscrowSpend,
  partiesOf,
  psbtFromBase64,
  releaseOutputs,
  splitLocktime,
  splitOutputs,
  TX_FEE_SATS,
  unsignedTxid,
  type KeyPathUtxo,
} from '../escrow/escrow.js'
import { KIND } from '../market/kinds.js'
import { encryptTo, type AtomicRepaidPayload, type AcceptancePayload, type ApplicationPayload, type FundedPayload, type RepaidPayload, type SignaturePayload, type SignRequestPayload } from '../market/messages.js'
import type { Offer } from '../market/orderbook.js'
import { verifyQuote } from '../oracle/oracle.js'
import { CURE_BLOCKS, headroom, type Headroom } from '../registry/ladder.js'
import { signPassbook, verifyPassbook, type PassbookDocument, type PortablePage, type RgbRepaymentReceipt } from '../registry/passbook-doc.js'
import { verifyOwnership, type IouCertificate, type IouOwnership } from '../market/iou.js'
import type { Passbook } from '../registry/passbook.js'
import type { Attestation } from '../sandbox/broker.js'
import type { Bundle, DisclosureItem, HistoryRow, SandboxResult } from '../sandbox/types.js'
import { awaitSettled } from '../rgb/wallet.js'
import type { SeededInflow } from '../wallet/state.js'
import { atomicCoverageSeconds, payAtomicInvoice, verifyAtomicInvoice, verifyPreimage, RgbLightningNode, type RgbLightningClient } from '../rgb/lightning.js'
import { Agent, type AgentDeps } from './agent.js'
import { approvalStatus, approve as approveSheet, type Approval } from '../market/approvals.js'
import type { NegotiationMessage, Position } from '../market/negotiate.js'
import { policyHash, policyValid } from '../market/policy.js'
import { signTermSheet, termSheetHash, termSheetProblems, type TermSheet } from '../market/termsheet.js'
import { runRecordDigest, sheetDigestProblems, termSheetEvidenceProblems } from '../scorer/evidence-digest.js'
import { bundleCategories, consentHash, signConsent, type ConsentReceipt } from '../scorer/consent.js'
import { sandboxScorerId } from '../sandbox/provenance.js'
import { contractHash, loadScoringContract } from '../scorer/contract.js'
import { rgbHistoryRows } from '../networks/rgb.js'
import { bundleLoan, scoredLoanProblems, scoredSheetProblems, signBundleTerms, type BundleTerms } from '../scorer/bundle-terms.js'
import type { PassbookCheckOutputs, ScorerOutcome, ScorerProvider } from '../scorer/types.js'
import { checkWithVerifiedScorer, type TrustPolicy } from '../scorer/verify.js'
import { forwardKey, listOffers, runPaidCheck, type PaidCheckResult } from '../checknode/client.js'
import { checkMessageHash } from '../checknode/messages.js'
import { releaseHash } from '../checknode/offer.js'
import { RAIL_LABEL, RlnPayerRail, type LightningCheckRail } from '../checknode/rail.js'
import { heldUdas, readReceipt, receiptEvidenceDigest, receiptProblemsFor, RECEIPT_TICKER } from '../checknode/receipt.js'
import { channelsToClose, closeChannels, openAssetChannel, type RlnChannel } from '../checknode/regtest-ln.js'
import type { CheckNodePick } from '../checknode/select.js'
import { EXECUTION_TIER_LABEL, type TeeVerifierConfig } from '../checknode/tee.js'
import type { CheckMarketInput, CheckNodeChoice } from '../market/negotiate.js'
import type { LenderPolicy as SignedLenderPolicy } from '../market/policy.js'

/**
 * The check market (docs/CHECK-MARKET.md): this wallet buys its credit check from a check node,
 * paying USDT over its own RGB Lightning node, instead of sending the bundle to the platform sandbox.
 */
export interface BorrowerCheckMarket {
  /** The borrower's own RGB Lightning node (HODL build): pays the check and receives the receipt. */
  ln: RgbLightningNode
  /** host:port of check nodes' Lightning peers by node key: an offer names the node key, not where to reach it. */
  peers: Record<string, string>
  /** The release manifest, its pinned signer and the scoring contract this wallet accepts, as for any scorer. */
  trust: TrustPolicy
  tee: (now: number) => TeeVerifierConfig
  /** USDT this wallet moves onto its own Lightning node for checks: the RGB channel's asset amount. */
  channelAmount: Micro
  /** Rails this wallet pays on, in its order of preference; anything but the HODL rail is a labelled fallback. */
  rails: LightningCheckRail[]
  timeoutMs?: number
}

/** A check bought on the market, opened with K, forwarded to the lender as a KEY message. */
export interface BoughtCheck {
  paid: PaidCheckResult
  outputs: PassbookCheckOutputs
  bundle_hash: Hex
  pick: CheckNodePick
  /** The hash of the KEY message forwarded to the lender: the application names it. */
  key_hash: Hex
  rail_label: string
  /** The receipt UDA as this wallet's node holds it; null when it did not settle (labelled). */
  receipt: { contract_id: string; status: string } | null
  receipt_status: string
}

/** The deployment's external provider scorer (scorer.provider external), as the borrower's wallet uses it. */
export interface ProviderScoring {
  providers: ScorerProvider[]
  /**
   * The Passbook chain observer that signs the chain checks (the external provider deployment lists it in
   * PASSBOOK_CHAIN_CHECK_SIGNERS) and the scored bundle's terms for the lender.
   */
  chainSigner: KeyPair
  /** Pinned release manifest and key, the scoring contract, and the trust lenders need: checked before any data is sent. */
  policy: TrustPolicy
  /** Labelled fallbacks after external provider, from the deployment config; their outcome is marked and keeps its own trust. */
  fallbacks?: ScorerProvider[]
  pollMs?: number
  timeoutMs?: number
}

/** A credit check on the deployment's scorer, as released, with the consent and the chain checks sent with it. */
export interface ScoredCheck {
  outcome: ScorerOutcome & { consent: ConsentReceipt }
  outputs: PassbookCheckOutputs
  /** Null when a fallback answered: only the external provider run takes chain checks. */
  /** The observer's signed loan request, asset, offer and lender requirements of the scored bundle; null with the chain checks. */
  bundle_terms: BundleTerms | null
  bundle_hash: Hex
}

export interface BorrowerLoan {
  terms: LoanTerms
  lender_pk: Hex
  /** Negotiated origination: the lender-signed sheet, the lender's approvals, then the borrower's countersignature and approval. */
  termsheet?: TermSheet
  lender_approvals?: Approval[]
  borrower_approval?: Approval
  lock?: { txid: Hex; vout: number }
  disbursement_txid?: Hex
  disbursement_invoice?: string
  disbursement_recipient_id?: string
  repayment_invoice?: string
  fallback_repayment_invoice?: string
  repayment_txid?: Hex
  repayment_receipt?: RgbRepaymentReceipt
  iou?: IouCertificate
  ownership?: IouOwnership
  release_txid?: Hex
  repayment_preimage?: Hex
  repayment_payment_hash?: Hex
  /** A timed-out submission may still settle; inspect it before switching rails. */
  repayment_atomic_attempted?: boolean
  /** a liquidation (or default split) that closed the escrow instead of a release */
  settlement_txid?: Hex
  split_explanation?: string
}

const BORROWER_LOAN_FIELDS = ['terms', 'lender_pk', 'termsheet', 'lender_approvals', 'borrower_approval', 'lock', 'disbursement_txid', 'disbursement_invoice', 'disbursement_recipient_id', 'repayment_invoice', 'fallback_repayment_invoice', 'repayment_txid', 'repayment_receipt', 'iou', 'ownership', 'release_txid', 'repayment_preimage', 'repayment_payment_hash', 'repayment_atomic_attempted', 'settlement_txid', 'split_explanation']
const APPROVAL_FIELDS = ['v', 'domain', 'termsheet_hash', 'approver_pk', 'role', 'approved_at', 'sig']
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const approvalFor = (a: unknown, id: Hex, role: Approval['role']): a is Approval => plainObject(a) && Object.keys(a).length === APPROVAL_FIELDS.length && APPROVAL_FIELDS.every((k) => Object.hasOwn(a, k)) &&
  a.v === 1 && a.domain === 'passbook-approval-v1' && a.role === role && a.termsheet_hash === id && isHex(a.approver_pk, 32) && Number.isSafeInteger(a.approved_at) && (a.approved_at as number) >= 0 && verifyObject(a as unknown as Approval, a.approver_pk as Hex)

/**
 * Problems with a borrower loan restored from a private demo checkpoint: no unknown fields, and a
 * negotiated loan carries the lender-signed sheet of exactly these terms with the lender's approval;
 * after the phone's accept also the borrower's countersignature and approval. lockAndSplit needs them.
 */
export function borrowerCheckpointProblems(id: Hex, loan: BorrowerLoan, borrowerPk: Hex): string[] {
  if (!plainObject(loan) || Object.keys(loan).some((k) => !BORROWER_LOAN_FIELDS.includes(k))) return ['unknown borrower loan fields']
  const { termsheet: sheet, lender_approvals: approvals, borrower_approval: own } = loan
  if (sheet === undefined) return approvals === undefined && own === undefined ? [] : ['approvals without a term sheet']
  if (!plainObject(sheet)) return ['term sheet is not an object']
  const problems = termSheetProblems(sheet, {})
  if (problems.length) return problems.map((p) => `term sheet: ${p}`)
  if (!sheet.signatures.lender || termSheetHash(sheet) !== id || canonicalJson(sheet.terms) !== canonicalJson(loan.terms) || loan.lender_pk !== sheet.terms.lender_pk || sheet.terms.borrower_pk !== borrowerPk) return ['term sheet does not bind these terms and parties']
  if (!Array.isArray(approvals) || approvals.length === 0 || approvals.length > 8 || !approvals.every((a) => approvalFor(a, id, 'lender')) || !approvals.some((a) => a.approver_pk === sheet.terms.lender_pk)) return ['lender approvals of this term sheet missing or invalid']
  if ((own === undefined) !== (sheet.signatures.borrower === undefined)) return ['borrower countersignature and approval must come together']
  if (own !== undefined && (!approvalFor(own, id, 'borrower') || own.approver_pk !== borrowerPk)) return ['borrower approval of this term sheet invalid']
  return []
}

export interface MarginView {
  loan_id: Hex
  price_cents: number
  /** height of the platform's margin call, if one stands */
  margin_call_height?: number
  cure_until_height?: number
  headroom: Headroom
  note: string
}

/** The wallet's own label on one of its transfers: who it was with and what it was for. */
interface Label {
  counterparty_pk: Hex
  memo: string
}

export interface Ask {
  passbook: Passbook
  allowed_ltv_bps: Bps
  price_cents: number
  fee_estimate: Micro
  collateral_sats: Sats
  btc_available: Sats
}

/** Fixed monthly costs the borrower declares to the sandbox. */
const DECLARED_OUTFLOWS = [{ label: 'rent', every_blocks: 30, amount: 900_000_000 }]

export class BorrowerAgent extends Agent {
  readonly lightning?: RgbLightningClient
  readonly assetId: string
  readonly historyProof?: () => Promise<import('../sandbox/reconcile.js').HistoryProof>
  /** the borrower's own records of who paid it and why, with the payers' signatures */
  readonly inflows: SeededInflow[]
  readonly loans = new Map<Hex, BorrowerLoan>()
  /** Set when the deployment's scorer is external provider: runProviderCheck sends the negotiated loan's bundle there instead of the platform sandbox. */
  readonly scoring?: ProviderScoring

  constructor(deps: AgentDeps & { assetId: string; inflows: SeededInflow[]; lightning?: RgbLightningClient; historyProof?: () => Promise<import('../sandbox/reconcile.js').HistoryProof>; scoring?: ProviderScoring }) {
    super(deps)
    this.assetId = deps.assetId
    this.scoring = deps.scoring
    this.lightning = deps.lightning ?? RgbLightningNode.fromEnv('BORROWER')
    this.inflows = deps.inflows
    this.historyProof = deps.historyProof
  }

  passbookDocument(): PassbookDocument {
    const file = join(dirname(this.party.rgb.dataDir), 'passbook.json')
    if (!existsSync(file)) return signPassbook(this.party.key, [])
    const doc = JSON.parse(readFileSync(file, 'utf8')) as PassbookDocument
    if (doc.borrower_pk !== this.pubkey || !verifyObject(doc, this.pubkey)) throw new Error('saved passbook signature is invalid')
    return doc
  }

  /** Persist our signed document after chain confirmation, independently of the platform. */
  savePassbookPage(loanId: Hex, proof?: PortablePage['repayment'], outcome?: PortablePage['outcome']): void {
    const l = this.loan(loanId)
    if (!l.lock) throw new Error('no lock for passbook page')
    const pages = this.passbookDocument().pages.filter((p) => termsHash(p.terms) !== loanId)
    pages.push({ terms: l.terms, lock_txid: l.lock.txid, lock_vout: l.lock.vout, outcome_txid: l.release_txid ?? l.settlement_txid, outcome, repayment: proof })
    pages.sort((a, b) => a.terms.open_height - b.terms.open_height)
    writeFileSync(join(dirname(this.party.rgb.dataDir), 'passbook.json'), JSON.stringify(signPassbook(this.party.key, pages), null, 2), { mode: 0o600 })
  }

  async awaitIouOwner(loanId: Hex, holderPk: Hex): Promise<IouOwnership> {
    const l = this.loan(loanId)
    const { payload } = await this.relay.receive<IouOwnership>(KIND.NOTE_OWNER, holderPk, { match: (p) => p.certificate.loan_id === loanId })
    if (!l.iou || hashObject(payload.certificate) !== hashObject(l.iou) || !await verifyOwnership(payload, l.terms, this.chain)) throw new Error('unauthenticated IOU assignment')
    const prior = l.ownership?.assignments ?? []
    if (payload.assignments.length <= prior.length || prior.some((a, i) => hashObject(a) !== hashObject(payload.assignments[i]))) throw new Error('IOU ownership cannot roll back or fork our accepted assignment chain')
    const last = payload.assignments.at(-1)
    if (!last) throw new Error('assignment missing')
    l.ownership = payload
    l.repayment_invoice = last.repayment_invoice
    await this.say('Repayment assigned to the new IOU holder', { holder_pk: holderPk, note_asset_id: l.iou.asset_id })
    return payload
  }

  /** What the wallet shows before asking: the earned LTV and the BTC that has to be locked. */
  async ask(principal: Micro, aprBps = 1200, termBlocks = 30): Promise<Ask> {
    const passbook = await verifyPassbook(this.passbookDocument(), this.chain)
    const quote = await this.platform.quote()
    const fee = termInterest({ principal, apr_bps: aprBps, term_blocks: termBlocks })
    const collateral = collateralFor(principal + fee, passbook.ladder.allowed_ltv_bps, quote.price_cents)
    const available = (await this.btcUtxos()).reduce((s, u) => s + u.value, 0)
    await this.say('Asking for a loan', { principal: usdt(principal), term_blocks: termBlocks, allowed_ltv: `${passbook.ladder.allowed_ltv_bps / 100}% (step ${passbook.ladder.step})`, btc_needed: btc(collateral), btc_available: btc(available) })
    return { passbook, allowed_ltv_bps: passbook.ladder.allowed_ltv_bps, price_cents: quote.price_cents, fee_estimate: fee, collateral_sats: collateral, btc_available: available }
  }

  /** Poll the platform's order book (fed from the relay) for an offer, optionally from one lender. */
  async findOffer(opts: { lenderPk?: Hex; principal: Micro; timeoutMs?: number }): Promise<Offer> {
    const deadline = Date.now() + (opts.timeoutMs ?? 20_000)
    while (Date.now() < deadline) {
      const { offers } = await this.platform.orderbook()
      const fit = offers.find((o) => (!opts.lenderPk || o.lender_pk === opts.lenderPk) && o.payload.asset_id === this.assetId && o.payload.min <= opts.principal && o.payload.max >= opts.principal)
      if (fit) {
        await this.say('Offer found in the order book', { offer_id: fit.id.slice(0, 20), apr: `${fit.payload.apr_bps / 100}%`, requirements: fit.payload.requirements })
        return fit
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('no matching offer appeared in the order book')
  }

  /**
   * The wallet's labels for its own loan transfers, kept on disk next to its RGB
   * data: a wallet reused across runs still knows which earlier transfers were
   * Passbook disbursements and repayments, so the sandbox does not see them as unknown.
   */
  private get labelsFile(): string {
    return join(dirname(this.party.rgb.dataDir), 'labels.json')
  }

  private labels(): Record<Hex, Label> {
    return existsSync(this.labelsFile) ? (JSON.parse(readFileSync(this.labelsFile, 'utf8')) as Record<Hex, Label>) : {}
  }

  private label(txid: Hex, label: Label): void {
    writeFileSync(this.labelsFile, `${JSON.stringify({ ...this.labels(), [txid]: label }, null, 2)}\n`)
  }

  /** Raw wallet history, built from this wallet's own RGB transfers and its own labels (the rgb layer adapter, src/networks/rgb.ts). Never leaves except encrypted to the sandbox. */
  private async history(): Promise<HistoryRow[]> {
    return rgbHistoryRows({ wallet: this.party.rgb, assetId: this.assetId, chain: this.chain, inflows: this.inflows, labels: this.labels() })
  }

  /** Local wallet evidence; callers must keep it inside the borrower/sandbox boundary. */
  async buildSandboxBundle(offer: Offer, principal: Micro, aprBps = offer.payload.apr_bps): Promise<Bundle> {
    const passbook = await verifyPassbook(this.passbookDocument(), this.chain)
    const quote = await this.platform.quote()
    const height = quote.height
    const historyProof = await this.historyProof?.()
    const fee = termInterest({ principal, apr_bps: aprBps, term_blocks: offer.payload.term_blocks })
    return {
      v: 1,
      borrower_pk: this.pubkey,
      own_pks: [],
      offer_id: offer.id,
      loan_request: { principal, fee, term_blocks: offer.payload.term_blocks, grace_blocks: offer.payload.grace_blocks },
      lender_requirements: offer.payload.requirements,
      balance: this.party.rgb.balance(this.assetId).settled,
      history: await this.history(),
      asset_id: this.assetId,
      ...(historyProof ? { history_proof: historyProof } : {}),
      candidate_inflows: this.inflows.map(({ memo: _memo, ...c }) => c),
      scheduled_outflows: DECLARED_OUTFLOWS.map((o) => ({ ...o, next_height: height + 10 })),
      collateral: { sats: collateralFor(principal + fee, passbook.ladder.allowed_ltv_bps, quote.price_cents), oracle_quote: quote, allowed_ltv_bps: passbook.ladder.allowed_ltv_bps },
    }
  }

  /** Build the bundle from the wallet, encrypt it to the sandbox key, submit. Only the signed result comes back. */
  /**
   * `negotiated` prices the fee estimate at the agreed APR and signs a consent receipt
   * naming this sandbox, the lender and the negotiation, covering every category sent.
   */
  async runSandbox(offer: Offer, principal: Micro, negotiated?: { apr_bps: number; negotiation_id: Hex }): Promise<{ result: SandboxResult; attestation: Attestation; bundle_hash: Hex; consent?: ConsentReceipt }> {
    const { sandbox_pk, attestation } = await this.platform.sandboxPubkey()
    const bundle = await this.buildSandboxBundle(offer, principal, negotiated?.apr_bps)
    const now = Math.floor(Date.now() / 1000)
    const consent = negotiated ? signConsent(this.party.key, { purpose: `credit check for negotiation ${negotiated.negotiation_id.slice(0, 12)}`, purpose_id: negotiated.negotiation_id, scorer_id: sandboxScorerId(sandbox_pk, attestation.image_digest), scorer_pk: sandbox_pk, contract_hash: contractHash(loadScoringContract()), lender_pk: offer.lender_pk, data_categories: bundleCategories(bundle), issued_at: now, expires_at: now + 6 * 3600 }) : undefined
    // The receipt travels inside the encrypted bundle: the sandbox checks it before processing and signs its hash into the result.
    const sent = consent ? { ...bundle, consent } : bundle
    const ciphertext = encryptTo(this.party.key, sandbox_pk, JSON.stringify(sent))
    await this.say('Bundle encrypted to the sandbox key and submitted', { rows: bundle.history.length, candidate_inflows: bundle.candidate_inflows.length, bytes: ciphertext.length, sandbox_pk: sandbox_pk.slice(0, 12), ...(consent ? { consent: consentHash(consent).slice(0, 12) } : {}) })
    const result = await this.platform.submitToSandbox(this.pubkey, ciphertext)
    if (result.bundle_hash !== hashObject(sent)) throw new Error('sandbox result is not about our bundle')
    if (consent && (result.consent_hash !== consentHash(consent) || result.lender_result?.consent_hash !== consentHash(consent))) throw new Error('sandbox result does not commit to our consent receipt')
    await this.say('Sandbox result received', { checks: result.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}`), proposal: result.disclosure_proposal.length })
    return { result, attestation, bundle_hash: result.bundle_hash, ...(consent ? { consent } : {}) }
  }

  /**
   * The person approves each proposed item; nothing outside the proposal can be added.
   * `choose` is the approval screen; by default every proposed item is approved.
   */
  async approve(result: SandboxResult, choose: (items: DisclosureItem[]) => Hex[] | Promise<Hex[]> = (items) => items.map((i) => i.txid)): Promise<Hex[]> {
    const proposed = new Set(result.disclosure_proposal.map((i) => i.txid))
    const approved = (await choose(result.disclosure_proposal)).filter((t) => proposed.has(t))
    await this.say('Disclosure approved by the borrower', { approved: approved.length, of: proposed.size })
    return approved
  }

  async apply(offer: Offer, principal: Micro, s: { result: SandboxResult; attestation: Attestation; consent?: ConsentReceipt }, approved: Hex[], negotiation?: import('../market/negotiate.js').NegotiationMessage[]): Promise<void> {
    if (!s.result.lender_result) throw new Error('sandbox must provide a separately signed lender result')
    const proofs = approved.map((txid) => {
      const i = this.inflows.find((x) => x.txid === txid)
      if (!i) throw new Error(`no payer proof for ${txid}`)
      return { txid, amount: i.amount, payer_pk: i.payer_pk, payer_sig: i.payer_sig }
    })
    const outstanding = [...this.loans.values()].filter((l) => !l.release_txid && !l.settlement_txid).reduce((sum, l) => sum + debtOf(l.terms), 0)
    const app: ApplicationPayload = {
      offer_id: offer.id,
      principal,
      term_blocks: offer.payload.term_blocks,
      sandbox_result: s.result.lender_result,
      attestation: s.attestation,
      disclosed_inflows: approved,
      disclosure_items: s.result.disclosure_proposal.filter((item) => approved.includes(item.txid)),
      inflow_proofs: proofs,
      passbook: this.passbookDocument(),
      outstanding_statement: { outstanding_micro: outstanding, sig: signHash(hashObject({ outstanding_micro: outstanding }), this.party.key.secretKey) },
      ...(negotiation ? { negotiation } : {}),
      ...(s.consent ? { consent: s.consent } : {}),
    }
    await this.relay.send(KIND.APPLICATION, app, offer.lender_pk)
    await this.say('Application sent to the lender (NIP-44)', { lender: offer.lender_pk.slice(0, 12), disclosed: approved.length })
  }

  /**
   * The credit check on the deployment's external provider scorer instead of the platform's sandbox
   * (negotiated origination only: the negotiation is the consent's purpose). Before any data
   * leaves, checkWithVerifiedScorer checks the scorer's descriptor against the pinned release
   * manifest at the lender's trust minimum. The chain checks run on this wallet's own node,
   * re-checking the observer-signed allocations with gettxout, and are signed by the chain
   * observer. The consent receipt names the verified scorer, the lender and the negotiation.
   * The evidence comes back exactly as released; the lender verifies it, not this wallet.
   */
  async runProviderCheck(offer: Offer, principal: Micro, negotiated: { apr_bps: number; negotiation_id: Hex }): Promise<ScoredCheck> {
    const scoring = this.scoring
    if (!scoring) throw new Error('no external provider scorer configured for this wallet (deployment scorer.provider external)')
    const bundle = await this.buildSandboxBundle(offer, principal, negotiated.apr_bps)
    const bundleTerms = signBundleTerms(bundle, scoring.chainSigner, {lender_pk: offer.lender_pk, purpose_id: negotiated.negotiation_id})
    const outcome = await checkWithVerifiedScorer([...scoring.providers, ...(scoring.fallbacks ?? [])], bundle, (d) => {
      const now = Math.floor(Date.now() / 1000)
      // external provider takes a purpose id in its own format; a fallback scorer takes the negotiation id itself.
      const purposeId = negotiated.negotiation_id
      return signConsent(this.party.key, { purpose: `credit assessment for negotiation ${negotiated.negotiation_id.slice(0, 12)}`, purpose_id: purposeId, scorer_id: d.scorer_id, ...(d.enclave_pubkey ? { scorer_pk: d.enclave_pubkey } : {}), contract_hash: d.contract_hash, lender_pk: offer.lender_pk, data_categories: bundleCategories(bundle), issued_at: now, expires_at: now + 3600 })
    }, this.party.key, scoring.policy, (e) => void this.say('Primary scorer unavailable; trying the labelled fallback', { error: e.message }))
    let outputs: PassbookCheckOutputs | null = null
    try { outputs = outcome.kind === 'external-evidence' ? outcome.outputs : outcome.result.outputs } catch { /* refused below */ }
    const bundleHash = hashObject(bundle)
    if (!outputs || outputs.bundle_hash !== bundleHash || outputs.borrower_pk !== this.pubkey || outputs.lender_pk !== offer.lender_pk || outputs.purpose_id !== outcome.consent.purpose_id) throw new Error('scorer result is not about our bundle, lender and negotiation')
    // Outputs v2 name the loan that was scored: it must be the one this bundle asked for.
    const loan = scoredLoanProblems(outputs, bundleLoan(bundle))
    if (loan.length) throw new Error(`scorer result names another loan: ${loan.join('; ')}`)
    await this.say(`Credit check released by ${outcome.descriptor.provider}${outcome.fallback ? ' (FALLBACK)' : ''}`, {
      ...(outcome.kind === 'external-evidence' ? { reference: outcome.reference } : {}),
      recommendation: outputs.recommendation, income_band: outputs.income_band, checks: outputs.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}`), consent: consentHash(outcome.consent).slice(0, 12),
    })
    return { outcome, outputs, bundle_terms: bundleTerms, bundle_hash: bundleHash }
  }

  /**
   * Apply with a scorer's released evidence (runProviderCheck). Nothing is disclosed beyond it:
   * external provider releases an income band and check results only, so there is no inflow proposal to approve.
   */
  async applyScored(offer: Offer, principal: Micro, scored: ScoredCheck, negotiation: NegotiationMessage[]): Promise<void> {
    const { consent, ...outcome } = scored.outcome
    const outstanding = [...this.loans.values()].filter((l) => !l.release_txid && !l.settlement_txid).reduce((sum, l) => sum + debtOf(l.terms), 0)
    const app: ApplicationPayload = {
      offer_id: offer.id,
      principal,
      term_blocks: offer.payload.term_blocks,
      sandbox_result: null,
      attestation: null,
      scorer_outcome: outcome,
      ...(scored.bundle_terms ? { scorer_bundle_terms: scored.bundle_terms } : {}),
      disclosed_inflows: [],
      passbook: this.passbookDocument(),
      outstanding_statement: { outstanding_micro: outstanding, sig: signHash(hashObject({ outstanding_micro: outstanding }), this.party.key.secretKey) },
      negotiation,
      consent,
    }
    await this.relay.send(KIND.APPLICATION, app, offer.lender_pk)
    await this.say('Application sent to the lender (NIP-44) with the scorer evidence', { lender: offer.lender_pk.slice(0, 12), provider: outcome.descriptor.provider, disclosed: 0 })
  }

  /**
   * The check market's input to the negotiation's structure step: the offers on the relay (malformed or expired
   * ones dropped), what this wallet pays with, and the releases and TEE verifier it accepts. The signed
   * negotiation then picks the node from both policies (runNegotiation(..., { market })), or ends with CHECK_NODE.
   */
  async checkMarketInput(market: BorrowerCheckMarket): Promise<CheckMarketInput> {
    const now = Math.floor(Date.now() / 1000)
    const { valid, rejected } = await listOffers(this.relay, now)
    await this.say('Check-node offers read from the relay for the structure step', { offers: valid.map((o) => `${o.operator_pk.slice(0, 12)} ${usdt(o.price.amount)}`), malformed: rejected.length })
    return { offers: valid, payer: { payer: 'borrower', payment_asset_id: this.assetId, rails: market.rails }, trust: market.trust, tee: market.tee(now) }
  }

  /**
   * The credit check bought on the check market (docs/CHECK-MARKET.md) instead of the platform
   * sandbox, for a negotiated loan (the negotiation is the consent's purpose). The node is the one
   * the negotiation's structure step picked from both signed policies; the lender's check_nodes
   * rules come from the policy its OFFER named. The wallet keeps one RGB channel per check node,
   * checks the operator's signed commitment and invoice before paying from its own RGB Lightning
   * node, opens the sealed result with K (on the HODL rail, the payment's preimage) and forwards K
   * to the lender, which verifies everything itself. Code picks and pays; no model is asked.
   */
  async buyCheck(offer: Offer, principal: Micro, deal: { apr_bps: number; negotiation_id: Hex; messages: NegotiationMessage[]; lender_policy: SignedLenderPolicy; check_node: CheckNodeChoice }, market: BorrowerCheckMarket): Promise<BoughtCheck> {
    const lp = deal.lender_policy
    const named = deal.messages.find((m) => m.type === 'OFFER' && m.from_pk === offer.lender_pk)?.body.policy_hash
    if (lp.owner_pk !== offer.lender_pk || !policyValid(lp) || !named || policyHash(lp) !== named) throw new Error('the lender\'s check-node rules are not from the policy its OFFER named')
    const pick = deal.check_node.pick
    const picked = pick.picked
    if (!picked?.rail || !picked.pay_with || picked.operator_pk !== deal.check_node.operator_pk || picked.rail === 'rgb-onchain') throw new Error('the structure step picked no check node this wallet can pay over RGB Lightning')
    const rail = picked.rail as LightningCheckRail
    const payWith = picked.pay_with.asset_id
    const price = picked.pay_with.amount
    await this.say('Buying the credit check from the node the structure step picked', { operator: picked.operator_pk.slice(0, 12), price: usdt(price), rail: RAIL_LABEL[rail], execution: EXECUTION_TIER_LABEL[picked.execution.tier], release: picked.release_hash.slice(0, 12) })

    // One RGB channel per check node (docs/CHECK-MARKET.md, routing finding): close any channel of another asset, or one too empty to pay.
    const lnPub = picked.offer.ln_node_pubkey
    const host = lnPub ? market.peers[lnPub] : undefined
    if (!lnPub || !host) throw new Error(`no peer address for the Lightning node of check node ${picked.operator_pk.slice(0, 12)}…`)
    const miner = { mine: (n?: number) => this.mine(n) }
    // After a restart a channel is unusable until its peer is back: reconnect first, then judge the channels.
    await market.ln.request('/connectpeer', { peer_pubkey_and_addr: `${lnPub}@${host}:9735` }).catch(() => undefined)
    let channels = (await market.ln.request<{ channels: RlnChannel[] }>('/listchannels')).channels.filter((c) => c.peer_pubkey === lnPub)
    for (let i = 0; i < 5 && channels.some((c) => !c.is_usable); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      channels = (await market.ln.request<{ channels: RlnChannel[] }>('/listchannels')).channels.filter((c) => c.peer_pubkey === lnPub)
    }
    const stale = channelsToClose(channels, lnPub, payWith, price)
    if (stale.length) {
      const closed = await closeChannels(market.ln, stale, miner, host)
      await this.say('Closed RGB channels to this check node: one channel per node, of the payment asset (docs/CHECK-MARKET.md, routing finding)', { closed: stale.map((c) => `${c.asset_id !== payWith ? 'another asset' : !c.is_usable ? 'unusable' : 'too little USDT'} ${c.channel_id.slice(0, 12)}${closed.find((x) => x.channel_id === c.channel_id)?.mode === 'forced' ? ' (force-closed: no cooperative close)' : ''}`) })
    }
    let channel = channels.find((c) => !stale.includes(c) && c.asset_id === payWith && c.is_usable)
    if (!channel) {
      await this.fundCheckLightning(market, payWith)
      channel = await openAssetChannel(market.ln, lnPub, host, payWith, market.channelAmount, miner)
      await this.say('RGB Lightning channel to the check node is usable', { channel: channel.channel_id.slice(0, 12), usdt: usdt(channel.asset_local_amount ?? 0), peer: lnPub.slice(0, 12) })
    }

    // The bundle is built now, after the wallet funded its own Lightning node, so it shows that labelled transfer too.
    const bundle = await this.buildSandboxBundle(offer, principal, deal.apr_bps)
    const before = new Set((await heldUdas(market.ln)).map((a) => a.asset_id))
    const receiptInvoice = (await market.ln.request<{ invoice: string }>('/rgbinvoice', { min_confirmations: 1, witness: false, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600 })).invoice
    await this.say('Bundle goes to the check node, encrypted to its scorer key, with a consent naming the operator', { rows: bundle.history.length, candidate_inflows: bundle.candidate_inflows.length, operator: picked.operator_pk.slice(0, 12) })
    const paid = await runPaidCheck({
      bus: this.relay, payer: this.party.key, borrower: this.party.key, lenderPk: offer.lender_pk, negotiationId: deal.negotiation_id, bundle, offer: picked.offer, rail, payWith,
      payerRail: new RlnPayerRail(market.ln), dataCategories: bundleCategories(bundle), pick, timeoutMs: market.timeoutMs ?? 300_000, receiptInvoice,
      beforePay: (c) => this.say('Commitment and invoice checked before paying', { commitment: c.commitment.slice(0, 12), payment_hash: c.payment.payment_hash.slice(0, 12), locked_to_key: c.payment.payment_hash === c.key_hash, amount: usdt(c.payment.amount), rail: RAIL_LABEL[rail] }),
    })
    let outputs: PassbookCheckOutputs | null = null
    try { outputs = paid.outcome.kind === 'external-evidence' ? paid.outcome.outputs : paid.outcome.result.outputs } catch { /* refused below */ }
    const bundleHash = hashObject(bundle)
    if (!outputs || outputs.bundle_hash !== bundleHash || outputs.borrower_pk !== this.pubkey || outputs.lender_pk !== offer.lender_pk || outputs.purpose_id !== deal.negotiation_id) throw new Error('check result is not about our bundle, lender and negotiation')
    const loan = scoredLoanProblems(outputs, bundleLoan(bundle))
    if (loan.length) throw new Error(`check result names another loan: ${loan.join('; ')}`)
    await this.say(`Credit check paid and opened: ${paid.outcome.descriptor.provider}${paid.outcome.fallback ? ' (FALLBACK)' : ''} on check node ${picked.operator_pk.slice(0, 12)}…`, {
      paid: usdt(paid.commitment.payment.amount), rail: RAIL_LABEL[rail], key: paid.key_source === 'lightning-preimage' ? 'K is the preimage of the paid invoice' : 'K came from the operator after payment (trusts the node)',
      recommendation: outputs.recommendation, income_band: outputs.income_band, checks: outputs.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}`), consent: consentHash(paid.consent).slice(0, 12),
    })
    const keyMessage = await forwardKey(this.relay, this.party.key, offer.lender_pk, paid)
    await this.say('K forwarded to the lender (KEY, NIP-44): it verifies the check from that message alone', { key_message: checkMessageHash(keyMessage).slice(0, 12), messages: keyMessage.seq + 1 })
    const { receipt, status } = await this.awaitCheckReceipt(market, before, paid)
    await this.say(receipt ? 'Check receipt held: an RGB token with hashes only' : 'Check receipt not held (labelled)', { contract_id: receipt?.contract_id ?? null, status })
    return { paid, outputs, bundle_hash: bundleHash, pick, key_hash: checkMessageHash(keyMessage), rail_label: RAIL_LABEL[rail], receipt, receipt_status: status }
  }

  /** USDT from this wallet to its own RGB Lightning node, through the policy gate, until the node holds the channel amount on chain. */
  private async fundCheckLightning(market: BorrowerCheckMarket, assetId: string): Promise<void> {
    const balance = await market.ln.request<{ spendable: number }>('/assetbalance', { asset_id: assetId }).catch(() => null)
    if ((balance?.spendable ?? 0) >= market.channelAmount) return
    const amount = market.channelAmount - (balance?.spendable ?? 0)
    // An invoice for any asset: the node may not know this contract yet.
    const inv = await market.ln.request<{ invoice: string }>('/rgbinvoice', { min_confirmations: 1, witness: true, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600 })
    const { txid } = await this.sendRgb({ invoice: inv.invoice, assetId, amount }, { action: 'fee-payment', recipientOwner: this.pubkey, reason: 'fund our own RGB Lightning node to pay a check node (docs/CHECK-MARKET.md)' })
    this.label(txid, { counterparty_pk: this.pubkey, memo: 'own Lightning node (check fees)' })
    for (let i = 0; i < 15; i++) {
      await market.ln.request('/refreshtransfers', { skip_sync: false })
      this.party.rgb.refresh()
      const held = await market.ln.request<{ spendable: number }>('/assetbalance', { asset_id: assetId }).catch(() => null)
      const t = this.party.rgb.transferByTxid(assetId, txid, 'Send')
      if (t?.status === 'Failed') throw new Error('the RGB transfer to our own Lightning node failed')
      if ((held?.spendable ?? 0) >= market.channelAmount && t?.status === 'Settled') {
        await this.say('USDT moved to our own RGB Lightning node for check fees (on chain, through our policy gate)', { amount: usdt(amount), txid: txid.slice(0, 12) })
        return
      }
      await this.mine(1)
    }
    throw new Error('the RGB transfer to our own Lightning node did not settle')
  }

  /**
   * The receipt UDA the operator sends once paid: it settles on chain into our Lightning node's RGB
   * wallet. Its media must be the receipt JSON naming our commitment, the operator and the release,
   * and its details that JSON's hash; a receipt naming anything else is not put in the term sheet.
   */
  private async awaitCheckReceipt(market: BorrowerCheckMarket, before: Set<string>, paid: PaidCheckResult): Promise<{ receipt: BoughtCheck['receipt']; status: string }> {
    // The operator broadcasts the transfer only after its own node sees our acknowledgement, so blocks are mined
    // only once the receipt's transaction is on the chain (at most 12), and otherwise the wallet waits.
    const started = Date.now(), deadline = started + 180_000
    let blocks = 0, minedAt = started
    const mine = async () => { await this.mine(1); blocks++; minedAt = Date.now() }
    while (Date.now() < deadline) {
      await market.ln.request('/refreshtransfers', { skip_sync: false }).catch(() => undefined)
      const incoming = (await heldUdas(market.ln)).find((a) => !before.has(a.asset_id) && a.ticker === RECEIPT_TICKER)
      const held = incoming?.balance.settled === 1 ? incoming : undefined
      if (incoming && !held && blocks < 12) {
        const { transfers } = await market.ln.request<{ transfers: { status: string; txid: string | null }[] }>('/listtransfers', { asset_id: incoming.asset_id }).catch(() => ({ transfers: [] }))
        const txid = transfers.find((t) => t.status === 'WaitingConfirmations' && t.txid)?.txid
        if (txid && await this.chain.getTx(txid).catch(() => null)) { await mine(); continue }
      }
      // A node that lists the token only once settled: after 30 s, a block every 10 s (still at most 12).
      if (!incoming && blocks < 12 && Date.now() - started > 30_000 && Date.now() - minedAt > 10_000) await mine()
      if (held) {
        // Only a receipt whose contents were read and checked goes into the application; an unread one is not named.
        let read = await readReceipt(market.ln, held)
        for (let i = 0; i < 3 && read.error; i++) { await new Promise((resolve) => setTimeout(resolve, 2000)); read = await readReceipt(market.ln, held) }
        if (read.error || !read.data) return { receipt: null, status: `settled, but its media could not be read (${read.error ?? 'empty'}); the term sheet names no receipt` }
        const problems = receiptProblemsFor(read.data, held.details, { commitment: paid.commitment.commitment, operator_pk: paid.offer.operator_pk, release_hash: releaseHash(paid.offer.release), evidence_digest: receiptEvidenceDigest(paid.outcome) })
        if (problems.length) return { receipt: null, status: `a receipt arrived but does not name this check: ${problems.join(', ')}; the term sheet names no receipt` }
        const status = 'settled in our RGB Lightning wallet; its media is the receipt JSON (hashes only) naming our commitment, the operator, the release and the evidence digest of the result we opened, and its details are that JSON\'s hash'
        return { receipt: { contract_id: held.asset_id, status }, status }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    return { receipt: null, status: `not settled within 3 minutes (${blocks} block(s) mined); the term sheet names no receipt` }
  }

  /**
   * Apply with a check bought on the market (buyCheck). The application names the KEY message
   * already forwarded to the lender, and the receipt's contract id; the lender takes the check only
   * from that KEY message. Nothing else is disclosed: the scorer released an income band and check
   * results, so there is no inflow proposal to approve.
   */
  async applyChecked(offer: Offer, principal: Micro, bought: BoughtCheck, negotiation: NegotiationMessage[]): Promise<void> {
    const outstanding = [...this.loans.values()].filter((l) => !l.release_txid && !l.settlement_txid).reduce((sum, l) => sum + debtOf(l.terms), 0)
    const app: ApplicationPayload = {
      offer_id: offer.id,
      principal,
      term_blocks: offer.payload.term_blocks,
      sandbox_result: null,
      attestation: null,
      check_key: bought.key_hash,
      ...(bought.receipt ? { check_receipt: { contract_id: bought.receipt.contract_id } } : {}),
      disclosed_inflows: [],
      passbook: this.passbookDocument(),
      outstanding_statement: { outstanding_micro: outstanding, sig: signHash(hashObject({ outstanding_micro: outstanding }), this.party.key.secretKey) },
      negotiation,
      consent: bought.paid.consent,
    }
    await this.relay.send(KIND.APPLICATION, app, offer.lender_pk)
    await this.say('Application sent to the lender (NIP-44) naming the forwarded check', { lender: offer.lender_pk.slice(0, 12), key_message: bought.key_hash.slice(0, 12), receipt: bought.receipt?.contract_id ?? null, disclosed: 0 })
  }

  /** The lender's terms, checked against what was asked and what the chain allows. */
  /**
   * `negotiated`: the agreement both agents signed, the transcript (whose lender OFFER names the
   * lender's policy hash), the deployment's maker-checker threshold and the run record of this
   * borrower's own credit check (or, scored by external provider, the evidence it released to this borrower).
   * The sheet must follow all of them before the collateral can lock.
   */
  async awaitAcceptance(offer: Offer, principal: Micro, negotiated?: { agreed: Position; accept_hash: Hex; messages: NegotiationMessage[]; maker_checker_above_micro: Micro; run_record?: SandboxResult['run_record']; scored?: ScorerOutcome; check?: { commitment: Hex; operator_pk: Hex; receipt_contract_id: string | null } }): Promise<{ loan_id: Hex; terms: LoanTerms }> {
    const { payload } = await this.relay.receive<AcceptancePayload>(KIND.ACCEPTANCE, offer.lender_pk, { match: (a) => a.offer_id === offer.id })
    const t = payload.terms
    validateTerms(t)
    if (t.v === 2) {
      if (!this.lightning) throw new Error('atomic terms require a configured borrower RGB Lightning node')
      await verifyAtomicInvoice(this.lightning, t, Math.floor(Date.now() / 1000), atomicCoverageSeconds(t))
    }
    const state = await this.platform.state()
    const passbook = await verifyPassbook(this.passbookDocument(), this.chain)
    const lastClose = [...passbook.pages].reverse().find((p) => p.verified.close && p.close_txid)?.close_txid ?? null
    const problems: string[] = []
    if (termsHash(t) !== payload.terms_hash) problems.push('terms hash')
    if (t.borrower_pk !== this.pubkey || t.lender_pk !== offer.lender_pk || t.platform_pk !== state.platform_pk) problems.push('keys')
    if (t.principal !== principal || t.asset_id !== this.assetId) problems.push('amount or asset')
    if (t.maturity_height - t.open_height !== offer.payload.term_blocks) problems.push('term')
    if (t.ltv_bps > passbook.ladder.allowed_ltv_bps || ltvBps(debtOf(t), t.collateral_sats, t.oracle_quote.price_cents) > passbook.ladder.allowed_ltv_bps) problems.push('LTV above the earned ladder')
    if (!verifyQuote(t.oracle_quote, state.oracle_pk)) problems.push('oracle quote')
    if (t.prev_passbook_txid !== lastClose) problems.push('passbook chain')
    // the lender's policy band is at most +200 bps over the offer, or exactly the negotiated APR; compare fees, so cent rounding never rejects a fair price
    if (!feeWithinApr({ principal: t.principal, fee: t.fee, term_blocks: t.maturity_height - t.open_height }, negotiated ? negotiated.agreed.apr_bps : offer.payload.apr_bps + 200)) problems.push(`fee implies ${impliedAprBps(t) / 100}% APR`)
    const sheet = payload.termsheet
    if (negotiated) {
      // The sheet must follow the ACCEPT both agents signed, be signed by the lender, hash to these terms, and carry the lender's approval.
      if (!sheet) problems.push('no term sheet for a negotiated loan')
      else {
        const sheetProblems = termSheetProblems(sheet, { agreed: negotiated.agreed, accept_hash: negotiated.accept_hash })
        if (sheetProblems.length || !sheet.signatures.lender) problems.push(`term sheet: ${sheetProblems.join('; ') || 'not signed by the lender'}`)
        else if (termSheetHash(sheet) !== payload.terms_hash || hashObject(sheet.terms) !== hashObject(t)) problems.push('term sheet does not hash to these terms')
        // The evidence the sheet binds on chain must be the run record this borrower's own check produced.
        if (!sheetProblems.length && negotiated.run_record) problems.push(...sheetDigestProblems(sheet, runRecordDigest(negotiated.run_record)).map((p) => `term sheet: ${p}`))
        // Scored by external provider: the sheet names exactly the envelope and result released to this borrower, from the same provider.
        if (!sheetProblems.length && negotiated.scored) {
          problems.push(...termSheetEvidenceProblems(sheet, negotiated.scored).map((p) => `term sheet: ${p}`))
          problems.push(...scoredSheetProblems(sheet, negotiated.scored).map((p) => `term sheet: ${p}`))
          if (sheet.scorer.provider !== negotiated.scored.descriptor.provider || sheet.scorer.fallback !== negotiated.scored.fallback) problems.push('term sheet: names another scorer than the one that checked us')
        }
        // Bought on the check market: the sheet names the receipt this wallet holds, for the commitment it paid for, from that operator; or none.
        if (!sheetProblems.length && negotiated.check) {
          const r = sheet.scorer.check_receipt, c = negotiated.check
          if (c.receipt_contract_id ? r?.contract_id !== c.receipt_contract_id || r.commitment !== c.commitment || r.operator_pk !== c.operator_pk : r !== undefined) problems.push('term sheet: names another check receipt than the one we hold')
        }
        // Every lender approval the lender's own policy requires (two keys above maker-checker) before anything locks, under the policy its OFFER named.
        const policy = payload.lender_policy
        const named = negotiated.messages.find((m) => m.type === 'OFFER' && m.from_pk === t.lender_pk)?.body.policy_hash
        if (!policy || !policyValid(policy) || policy.owner_pk !== t.lender_pk || !named || policyHash(policy) !== named) problems.push('lender policy missing or not the one its OFFER named')
        else if (!sheetProblems.length) {
          const s = approvalStatus(sheet, payload.lender_approvals ?? [], policy, negotiated.maker_checker_above_micro)
          if (s.lender_approvers.length < s.required_lender_approvals || s.problems.length) problems.push(`lender approvals incomplete: ${s.lender_approvers.length}/${s.required_lender_approvals}${s.problems.length ? ` (${s.problems.join(', ')})` : ''}`)
        }
        if (!(payload.lender_approvals ?? []).some((a) => a.approver_pk === t.lender_pk && a.role === 'lender' && a.termsheet_hash === payload.terms_hash && verifyObject(a, a.approver_pk))) problems.push('no lender approval of this term sheet')
      }
    }
    const loan = await this.platform.loan(payload.terms_hash)
    if (loan.status !== 'pending') problems.push(`loan is ${loan.status}`)
    if (problems.length) throw new Error(`terms rejected: ${problems.join(', ')}`)
    this.loans.set(payload.terms_hash, { terms: t, lender_pk: offer.lender_pk, ...(sheet && negotiated ? { termsheet: sheet, lender_approvals: payload.lender_approvals } : {}) })
    await this.say('Terms checked and accepted', { loan_id: payload.terms_hash.slice(0, 12), fee: usdt(t.fee), ltv: `${t.ltv_bps / 100}%`, collateral: btc(t.collateral_sats), maturity: t.maturity_height })
    return { loan_id: payload.terms_hash, terms: t }
  }

  /** The borrower's human approval (the phone's accept stop): countersign exactly this sheet and approve its hash. */
  approveTermSheet(loanId: Hex): Approval {
    const l = this.loan(loanId)
    if (!l.termsheet) throw new Error('this loan has no term sheet to approve')
    l.termsheet = signTermSheet(l.termsheet, 'borrower', this.party.key.secretKey)
    l.borrower_approval = approveSheet(this.party.key, l.termsheet, 'borrower')
    return l.borrower_approval
  }

  private loan(loanId: Hex): BorrowerLoan {
    const l = this.loans.get(loanId)
    if (!l) throw new Error(`no loan ${loanId.slice(0, 12)} on this borrower`)
    return l
  }

  /**
   * What the wallet shows at the accept stop, before anything is signed: the
   * default split's two payouts, computed in code, and the local model's plain
   * wording of them. Cached on the loan so lockAndSplit hands the lender the same text.
   */
  async explainTerms(loanId: Hex): Promise<{ explanation: string; lender_sats_on_default: Sats; borrower_sats_on_default: Sats }> {
    const l = this.loan(loanId)
    const t = l.terms
    const outputs = splitOutputs(t)
    const lender = outputs[0].value
    const borrower = outputs[1]?.value ?? 0
    l.split_explanation ??= await this.ai.explainSplit({
      principal: t.principal,
      fee: t.fee,
      collateral_sats: t.collateral_sats,
      price_cents: t.oracle_quote.price_cents,
      maturity_height: t.maturity_height,
      grace_blocks: t.grace_blocks,
      lender_sats_on_default: lender,
      borrower_sats_on_default: borrower,
    })
    return { explanation: l.split_explanation, lender_sats_on_default: lender, borrower_sats_on_default: borrower }
  }

  /** Lock the collateral with the terms hash, then hand the lender the signed default split and a disbursement invoice. */
  async lockAndSplit(loanId: Hex): Promise<{ lock_txid: Hex; split_txid: Hex }> {
    const l = this.loan(loanId)
    // Nothing locks before the borrower approved this exact term sheet.
    if (l.termsheet && !l.borrower_approval) throw new Error('approve the term sheet before locking collateral')
    const t = l.terms
    const utxos = await this.btcUtxos()
    const inputs: KeyPathUtxo[] = []
    if (t.prev_passbook_txid) {
      const prev = utxos.find((u) => u.txid === t.prev_passbook_txid)
      if (!prev) throw new Error('the previous release output is not in our UTXO set')
      inputs.push({ ...prev, internal_pk: this.pubkey })
    }
    const need = t.collateral_sats + TX_FEE_SATS
    for (const u of utxos.sort((a, b) => b.value - a.value)) {
      if (inputs.reduce((s, x) => s + x.value, 0) >= need) break
      if (!inputs.some((x) => x.txid === u.txid && x.vout === u.vout)) inputs.push({ ...u, internal_pk: this.pubkey })
    }
    const lock = buildLock({ inputs, terms: t, changeScript: this.party.btcScript })
    ;(await this.signKeyPath(lock, { action: 'lock', terms: t, counterparty: l.lender_pk })).finalizeAllInputs()
    const lockTxid = await this.broadcast(extractHex(lock))
    await this.mine(1)
    await this.index('lock', () => this.platform.recordLock(loanId, lockTxid))
    l.lock = { txid: lockTxid, vout: 0 }
    this.savePassbookPage(loanId)
    await this.say('Collateral locked with the terms hash in OP_RETURN', { lock_txid: lockTxid.slice(0, 12), collateral: btc(t.collateral_sats), chained_to: t.prev_passbook_txid?.slice(0, 12) ?? 'first page' })

    const parties = partiesOf(t)
    const outputs = splitOutputs(t)
    const split = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: t.collateral_sats }, parties, leaf: 'A', outputs, locktime: splitLocktime(t) })
    await this.signLeaf(split, parties, 'A', { action: 'lock', terms: t, counterparty: l.lender_pk })
    await this.explainTerms(loanId)
    const invoice = this.party.rgb.invoice(t.principal, this.assetId)
    l.disbursement_invoice = invoice.invoice
    l.disbursement_recipient_id = invoice.recipientId
    const req: SignRequestPayload = { purpose: 'split', loan_id: loanId, psbt_base64: split.toBase64(), terms_hash: loanId, disbursement_invoice: invoice.invoice, ...(l.termsheet && l.borrower_approval ? { termsheet: l.termsheet, borrower_approval: l.borrower_approval } : {}) }
    await this.relay.send(KIND.SIGN_REQUEST, req, l.lender_pk)
    await this.say('Default split signed and handed to the lender', { locktime: splitLocktime(t), explanation: l.split_explanation })
    return { lock_txid: lockTxid, split_txid: unsignedTxid(split) }
  }

  /** Wait for the lender's funding notice and see the USDT settle in our own wallet. */
  async awaitFunding(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (l.disbursement_txid) throw new Error('funding already verified for this loan')
    if (!l.lock || !l.disbursement_invoice || !l.disbursement_recipient_id) throw new Error('no locked collateral and disbursement invoice for this loan')
    const { payload } = await this.relay.receive<FundedPayload>(KIND.FUNDED, l.lender_pk, { match: (f) => f.loan_id === loanId, timeoutMs: 120_000 })
    const lock = await this.chain.getTx(l.lock.txid)
    const funding = await this.chain.getTx(payload.disbursement_txid)
    if (!lock?.height || !funding?.height || funding.height <= lock.height) throw new Error('funding witness must confirm after this loan collateral lock')
    const t = await awaitSettled(this.party.rgb, { assetId: this.assetId, txid: payload.disbursement_txid, kind: 'ReceiveWitness', mine: () => this.mine(1) })
    if (t.recipientId !== l.disbursement_recipient_id) throw new Error('funding does not settle this loan disbursement invoice')
    if (t.amount !== l.terms.principal) throw new Error(`received ${usdt(t.amount)}, expected ${usdt(l.terms.principal)}`)
    // repay only to the invoice the platform issued and watches, so it can validate the repayment without the lender
    if (l.terms.v === 2) {
      if (payload.repayment_invoice !== l.terms.atomic_repayment?.invoice) throw new Error('repayment invoice differs from committed atomic terms')
      const record = await this.platform.loan(loanId)
      if (!payload.fallback_repayment_invoice || payload.fallback_repayment_invoice !== record.repayment_watch?.invoice) throw new Error('atomic loan requires the watched on-chain fallback invoice')
      l.fallback_repayment_invoice = payload.fallback_repayment_invoice
    } else {
      const record = await this.platform.loan(loanId)
      if (!payload.repayment_invoice || record.repayment_watch?.invoice !== payload.repayment_invoice) throw new Error('the repayment invoice is not the one the platform issued for this loan')
    }
    l.disbursement_txid = payload.disbursement_txid
    l.repayment_invoice = payload.repayment_invoice
    if (payload.iou_invoice) l.iou = await this.iou.issue(l.terms, payload.iou_invoice, l.lock!)
    this.label(payload.disbursement_txid, { counterparty_pk: l.lender_pk, memo: 'loan disbursement' })
    await this.say('USDT received over RGB; loan open', { txid: payload.disbursement_txid.slice(0, 12), amount: usdt(t.amount), balance: usdt(this.party.rgb.balance(this.assetId).settled) })
    return payload.disbursement_txid
  }

  async awaitIouReturn(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (!l.iou) throw new Error('no IOU issued')
    const { payload } = await this.relay.receive<{ loan_id: Hex; asset_id: string; txid: Hex }>(KIND.NOTE_RETURNED, l.ownership?.holder_pk ?? l.lender_pk, { match: (p) => p.loan_id === loanId && p.asset_id === l.iou!.asset_id })
    const received = await awaitSettled(this.party.rgb, { assetId: l.iou.asset_id, txid: payload.txid, kind: 'ReceiveWitness', mine: () => this.mine(1) })
    if (received.amount !== debtOf(l.terms)) throw new Error('returned IOU is incomplete')
    return payload.txid
  }

  /** Pay principal + fee to the lender's invoice and tell the lender. */
  async repay(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (l.terms.v === 2) throw new Error('use repayAtomic for the committed Lightning invoice')
    if (!l.repayment_invoice) throw new Error('no repayment invoice from the lender')
    return this.repayOnchain(loanId, l.repayment_invoice)
  }

  /** Explicit fallback when the committed Lightning invoice cannot be paid.
   * Uses the platform-watched RGB invoice so leaf C can still release BTC. */
  async repayFallback(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (l.terms.v === 1) return this.repay(loanId)
    if (l.repayment_preimage || l.release_txid) throw new Error('atomic payment already completed; do not pay twice')
    if (l.repayment_atomic_attempted) {
      if (!this.lightning) throw new Error('inspect the previous Lightning payment before switching repayment rails')
      const previous = await this.lightning.getPayment(l.terms.atomic_repayment!.payment_hash)
      if (previous.status !== 'Failed') throw new Error('Lightning payment may still settle; refusing a second payment over RGB')
    }
    if (!l.fallback_repayment_invoice) throw new Error('no watched fallback invoice for this atomic loan')
    return this.repayOnchain(loanId, l.fallback_repayment_invoice)
  }

  private async repayOnchain(loanId: Hex, invoice: string): Promise<Hex> {
    const l = this.loan(loanId)
    if (l.repayment_txid || l.release_txid || l.settlement_txid) throw new Error('loan was already repaid or settled')
    const debt = debtOf(l.terms)
    const { txid } = await this.sendRgb({ invoice, assetId: this.assetId, amount: debt }, { action: 'repay', terms: l.terms, counterparty: l.ownership?.holder_pk ?? l.lender_pk, recipientOwner: l.ownership?.holder_pk ?? l.lender_pk })
    await awaitSettled(this.party.rgb, { assetId: this.assetId, txid, kind: 'Send', mine: () => this.mine(1) })
    l.repayment_txid = txid
    this.label(txid, { counterparty_pk: l.ownership?.holder_pk ?? l.lender_pk, memo: 'loan repayment' })
    const holder = l.ownership?.holder_pk ?? l.lender_pk
    const msg: RepaidPayload = { loan_id: loanId, repayment_txid: txid, note_return_invoice: l.iou ? this.party.rgb.invoice(debt, l.iou.asset_id).invoice : undefined }
    await this.relay.send(KIND.REPAID, msg, holder)
    const height = (await this.chain.getTx(txid))?.height
    await this.say('Repaid over RGB', { txid: txid.slice(0, 12), amount: usdt(debt), height, maturity: l.terms.maturity_height })
    return txid
  }

  /** Pay the committed RGB Lightning invoice and release through leaf E.
   * The platform is only a best-effort indexer; no co-sign request is made. */
  async repayAtomic(loanId: Hex): Promise<{ payment_hash: Hex; preimage: Hex; release_txid: Hex }> {
    const l = this.loan(loanId)
    if (!l.lock || !l.disbursement_txid) throw new Error('atomic loan must be locked and funded')
    if (!this.lightning || l.terms.v !== 2 || !l.terms.atomic_repayment) throw new Error('atomic repayment requires v2 terms and a real RGB Lightning node')
    if (l.repayment_txid) throw new Error('loan was already repaid over on-chain RGB; release through leaf A or C')
    if (l.release_txid || l.settlement_txid) throw new Error('loan collateral already released or settled')
    const parties = partiesOf(l.terms)
    const utxo = await this.chain.rpc<{ scriptPubKey: { hex: string }; value: number } | null>('gettxout', [l.lock.txid, l.lock.vout, true])
    if (!utxo || utxo.scriptPubKey.hex !== escrowFor(parties).script || Math.round(utxo.value * 1e8) !== l.terms.collateral_sats) throw new Error('loan collateral is spent or does not match terms')
    if (l.repayment_preimage && !verifyPreimage(l.repayment_preimage, l.terms.atomic_repayment.payment_hash)) throw new Error('saved repayment preimage does not match terms')
    if (!l.repayment_preimage) await verifyAtomicInvoice(this.lightning, l.terms)
    l.repayment_atomic_attempted = true
    const preimage = l.repayment_preimage ?? await payAtomicInvoice(this.lightning, l.terms)
    l.repayment_preimage = preimage
    l.repayment_payment_hash = l.terms.atomic_repayment.payment_hash
    const psbt = buildEscrowSpend({ escrow: { ...l.lock, value: l.terms.collateral_sats }, parties, leaf: 'E', outputs: releaseOutputs(l.terms) })
    await this.signLeaf(psbt, parties, 'E', { action: 'release', terms: l.terms, counterparty: l.lender_pk })
    finalizeEscrowSpend(psbt, parties, 'E', preimage)
    const txid = await this.broadcast(extractHex(psbt))
    await this.mine(1)
    l.release_txid = txid
    this.savePassbookPage(loanId, { kind: 'atomic', preimage }, 'repaid')
    if (l.iou) {
      const paid: AtomicRepaidPayload = { loan_id: loanId, payment_hash: l.repayment_payment_hash, release_txid: txid, note_return_invoice: this.party.rgb.invoice(debtOf(l.terms), l.iou.asset_id).invoice }
      try { await this.relay.send(KIND.ATOMIC_REPAID, paid, l.lender_pk) } catch (e) { await this.say('Atomic release confirmed; IOU return request could not be delivered', { reason: (e as Error).message }) }
    }
    // The release itself contains the repayment proof. Platform support may
    // be offline or older; the portable passbook reads Bitcoin directly.
    try { await this.platform.recordRelease(loanId, txid) } catch (e) {
      await this.say('Atomic release confirmed; platform indexing unavailable', { reason: (e as Error).message })
    }
    await this.say('Repaid over Lightning → secret revealed → collateral released', { loan_id: loanId, payment_hash: l.repayment_payment_hash, preimage, release_txid: txid, leaf: 'E', co_signer: 'none' })
    return { payment_hash: l.repayment_payment_hash, preimage, release_txid: txid }
  }

  /** Sign the release (leaf A), get the lender's signature over Nostr, broadcast, record. */
  async release(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (!l.lock) throw new Error('not locked')
    const parties = partiesOf(l.terms)
    const psbt = buildEscrowSpend({ escrow: { ...l.lock, value: l.terms.collateral_sats }, parties, leaf: 'A', outputs: releaseOutputs(l.terms) })
    await this.signLeaf(psbt, parties, 'A', { action: 'release', terms: l.terms, counterparty: l.lender_pk })
    const req: SignRequestPayload = { purpose: 'release', loan_id: loanId, psbt_base64: psbt.toBase64(), terms_hash: loanId }
    await this.relay.send(KIND.SIGN_REQUEST, req, l.lender_pk)
    let payload: SignaturePayload
    try {
      ;({ payload } = await this.relay.receive<SignaturePayload>(KIND.SIGNATURE, l.lender_pk, { match: (s) => s.loan_id === loanId }))
    } catch (error) {
      if (!/timed out waiting/.test((error as Error).message)) throw error
      await this.say('Lender did not answer; asking the platform to validate the repayment')
      return this.releaseWithPlatform(loanId)
    }
    if ('refused' in payload) {
      await this.say('Lender refused the release; asking the platform to validate the repayment', { reason: payload.refused })
      return this.releaseWithPlatform(loanId)
    }
    addLeafSignature(psbt, parties, 'A', 'lender', payload.signature)
    finalizeEscrowSpend(psbt, parties, 'A')
    const txid = await this.broadcast(extractHex(psbt))
    await this.mine(1)
    await this.index('release', () => this.platform.recordRelease(loanId, txid))
    l.release_txid = txid
    l.repayment_receipt = payload.repayment_receipt
    this.savePassbookPage(loanId, l.repayment_receipt ? { kind: 'rgb_receipt', receipt: l.repayment_receipt, ownership: l.ownership } : undefined, 'repaid')
    await this.say('Collateral released; passbook page stamped', { release_txid: txid.slice(0, 12), receipt: { repayment: l.repayment_txid?.slice(0, 12), release: txid.slice(0, 12) } })
    return txid
  }

  /**
   * Where an open loan stands at the oracle's current price: the platform's
   * margin call (if any), the headroom computed in code, and a plain-language
   * note drafted by the model. The note explains; it changes nothing.
   */
  async marginStatus(loanId: Hex): Promise<MarginView> {
    const l = this.loan(loanId)
    const record = await this.platform.loan(loanId)
    const state = await this.platform.state()
    const quote = await this.platform.quote()
    if (!verifyQuote(quote, state.oracle_pk)) throw new Error('oracle quote does not verify')
    const debt = debtOf(l.terms)
    const h = headroom(debt, l.terms.collateral_sats, quote.price_cents)
    const cureUntil = record.margin_call_height === undefined ? undefined : record.margin_call_height + CURE_BLOCKS
    const note = await this.ai.marginNote({
      ltv_bps: h.ltv_bps,
      price_cents: quote.price_cents,
      margin_call_price_cents: h.margin_call_price_cents,
      liquidation_price_cents: h.liquidation_price_cents,
      cure_until_height: cureUntil,
      debt,
      collateral_sats: l.terms.collateral_sats,
    })
    await this.say(record.margin_call_height === undefined ? 'Loan healthy at the current price' : 'Margin call received from the platform', {
      ltv: pct(h.ltv_bps),
      state: h.state,
      price: `$${(quote.price_cents / 100).toLocaleString('en-US')}`,
      margin_call_at: `$${(h.margin_call_price_cents / 100).toLocaleString('en-US')}`,
      liquidation_at: `$${(h.liquidation_price_cents / 100).toLocaleString('en-US')}`,
      cure_until: cureUntil ?? null,
      note,
    })
    return { loan_id: loanId, price_cents: quote.price_cents, margin_call_height: record.margin_call_height, cure_until_height: cureUntil, headroom: h, note }
  }

  /**
   * After a liquidation: the escrow is spent through leaf B. Find the change the
   * borrower got back in that transaction, read from Bitcoin, not from the lender.
   */
  async liquidated(loanId: Hex): Promise<{ settlement_txid: Hex; returned_sats: Sats }> {
    const l = this.loan(loanId)
    const record = await this.platform.loan(loanId)
    if (record.status !== 'liquidated' || !record.settlement_txid) throw new Error(`loan is ${record.status}, not liquidated`)
    const tx = await this.chain.getTx(record.settlement_txid)
    if (!tx?.height || !tx.inputs.some((i) => i.txid === l.lock?.txid && i.vout === l.lock?.vout)) throw new Error('the settlement does not spend our collateral')
    const returned = tx.outputs.filter((o) => o.script === this.party.btcScript).reduce((s, o) => s + o.value, 0)
    l.settlement_txid = record.settlement_txid
    this.savePassbookPage(loanId, undefined, 'liquidated')
    await this.say('Collateral liquidated; the remainder came back to our key', { settlement_txid: record.settlement_txid.slice(0, 12), returned: btc(returned), kept: usdt(l.terms.principal) })
    return { settlement_txid: record.settlement_txid, returned_sats: returned }
  }

  /**
   * Without the lender: the platform validates the RGB repayment with its watch-only wallet on the
   * lender's repayment account, then adds its leaf C signature to a release that pays everything back to us.
   */
  async releaseWithPlatform(loanId: Hex): Promise<Hex> {
    const l = this.loan(loanId)
    if (!l.lock) throw new Error('not locked')
    if (!l.repayment_txid) throw new Error('nothing repaid yet')
    const proof = await this.platform.verifyRepayment(loanId, l.repayment_txid)
    await this.say(proof.ok ? 'Platform validated the RGB repayment' : 'Platform could not validate the repayment', { checks: proof.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}`) })
    if (!proof.ok) throw new Error(`repayment not validated: ${proof.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
    const parties = partiesOf(l.terms)
    const psbt = buildEscrowSpend({ escrow: { ...l.lock, value: l.terms.collateral_sats }, parties, leaf: 'C', outputs: releaseOutputs(l.terms) })
    const decision = await this.platform.cosign({ loan_id: loanId, purpose: 'release', psbt: psbt.toBase64(), repayment_txid: l.repayment_txid })
    if (!decision.ok || !decision.psbt) throw new Error(`platform refused the release: ${decision.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
    const signed = psbtFromBase64(decision.psbt)
    await this.signLeaf(signed, parties, 'C', { action: 'release', terms: l.terms, counterparty: l.terms.platform_pk })
    finalizeEscrowSpend(signed, parties, 'C')
    const txid = await this.broadcast(extractHex(signed))
    await this.mine(1)
    await this.index('release', () => this.platform.recordRelease(loanId, txid))
    l.release_txid = txid
    this.savePassbookPage(loanId, proof.receipt ? { kind: 'rgb_receipt', receipt: proof.receipt } : undefined, 'repaid')
    await this.say('Collateral released through leaf C with the platform; passbook page stamped', { release_txid: txid.slice(0, 12), receipt: { repayment: l.repayment_txid.slice(0, 12), release: txid.slice(0, 12) } })
    return txid
  }

}
