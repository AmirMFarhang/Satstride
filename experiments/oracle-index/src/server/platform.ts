// The platform's rules. Everything the server does that is not plumbing lives
// here so it can be tested without HTTP: registering a loan, recording each
// on-chain step after checking it on Bitcoin, deciding whether to co-sign a
// refund, release or liquidation, and watching open loans against the oracle.
// The only Bitcoin signature the platform ever makes is its escrow leaf signature
// on leaf C (refund, release on proven repayment) or leaf B (liquidation), and
// only on a PSBT that spends this loan's escrow and pays exactly what the policy
// says. It never signs leaf A and holds only its own key. For repayments it also
// runs a watch-only rgb-lib wallet per loan (xpubs of the lender's repayment
// account, see src/rgb/watch.ts): it can see and validate the repayment, never spend it.
// When a funded loan closes it invoices the lender for the platform's share of the
// interest (src/server/fees.ts); that fee never touches the escrow or the repayment.

import { isConfirmed, opReturnPayload, type ChainClient } from '../chain/types.js'
import { bytesToHex, canonicalJson, hashObject, signObject, verifyHash, type Hex, type KeyPair } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, type Economics } from '../core/economics.js'
import { ltvBps } from '../core/money.js'
import { debtOf, termsHash, validateTerms, type LoanTerms, type OracleQuote } from '../core/terms.js'
import {
  describe as describePsbt,
  escrowFor,
  keyPathOutput,
  liquidationOutputs,
  partiesOf,
  psbtFromBase64,
  releaseOutputs,
  leafSignature,
  unsignedTxid,
  type Leaf,
  type TxOut,
} from '../escrow/escrow.js'
import { GateRefused } from '../governance/gate.js'
import { NodeGovernance } from '../governance/node.js'
import type { Oracle } from '../oracle/oracle.js'
import { liquidationPrices, verifyQuote } from '../oracle/oracle.js'
import { CURE_BLOCKS, FUND_TIMEOUT_BLOCKS, LADDER_BPS, MARGIN_CALL_BPS, headroom, liquidationDecision, type Headroom } from '../registry/ladder.js'
import { atomicWitnessPreimage, verifyPassbook, rgbRepaymentReceipt, type PassbookDocument, type RgbRepaymentReceipt } from '../registry/passbook-doc.js'
import { buildPassbook, type Passbook, type PassbookPage } from '../registry/passbook.js'
import type { LoanRecord, NewWireEvent, Store } from '../registry/store.js'
import type { IssuedInvoice, RepaymentWatcher, WatchKeys } from '../rgb/watch.js'
import { attest, type Attestation, type Sandbox } from '../sandbox/broker.js'
import { resultHash } from '../sandbox/run.js'
import type { SandboxResult } from '../sandbox/types.js'
import { FeeDesk, OUTSTANDING_FEE_MESSAGE, type FeeWallet } from './fees.js'

export interface Check {
  id: string
  ok: boolean
  detail: string
}

export interface PassbookViewPage extends PassbookPage {
  /** only on a funded (open) loan, at the current oracle price */
  headroom?: Headroom
  /** only while a margin call is running */
  cure_until_height?: number
  returned_sats?: number
  repayment_txid?: Hex
}

export interface PassbookView extends Passbook {
  pages: PassbookViewPage[]
  price_cents: number
  ladder_bps: readonly number[]
}

export interface Verdict {
  ok: boolean
  checks: Check[]
}

export type CosignPurpose = 'refund' | 'release' | 'liquidate'

export interface CosignRequest {
  loan_id: Hex
  purpose: CosignPurpose
  /** the escrow spend to co-sign, base64 PSBT; without it the platform only decides */
  psbt?: string
  /** txid of the transaction to be co-signed; derived from the PSBT when one is given and must match it */
  txid?: Hex
  /** release: the RGB repayment txid the borrower claims paid the lender */
  repayment_txid?: Hex
  /** liquidate: the quote the lender priced its outputs with; used when it is ours and recent */
  oracle_quote?: OracleQuote
}

export interface CosignDecision extends Verdict {
  /** platform signature over { loan_id, purpose, txid, height } */
  approval?: { loan_id: Hex; purpose: CosignPurpose; txid: Hex; height: number; platform_pk: Hex; sig: Hex }
  /** the request's PSBT with the platform's leaf signature added */
  psbt?: string
  leaf?: Leaf
  /** the platform's BIP-340 signature for that leaf, hex */
  leaf_sig?: Hex
}

/** The leaf each purpose spends. Leaf A (borrower + lender) is never the platform's. */
export const COSIGN_LEAF: Record<CosignPurpose, Leaf> = { refund: 'C', release: 'C', liquidate: 'B' }

export type Emit = (event: NewWireEvent) => void

export class Platform {
  readonly imageDigest: string
  readonly economics: Economics
  /** Platform fees owed by lenders after close; see src/server/fees.ts. */
  readonly fees: FeeDesk
  /** The policy gate every platform co-signature passes. */
  readonly governance: NodeGovernance

  constructor(
    readonly key: KeyPair,
    readonly store: Store,
    readonly chain: ChainClient,
    readonly oracle: Oracle,
    readonly sandbox: Sandbox,
    readonly emit: Emit,
    /** watch-only rgb-lib wallets for repayment invoices; without it only the lender's acknowledgement proves a repayment */
    readonly repayments?: RepaymentWatcher,
    imageDigest = process.env.SANDBOX_IMAGE_DIGEST ?? 'in-process',
    opts: { feeWallet?: FeeWallet; economics?: Economics; governance?: NodeGovernance } = {},
  ) {
    this.imageDigest = imageDigest
    // The platform's co-signatures pass its own policy gate and decision log, like every agent's.
    this.governance = opts.governance ?? new NodeGovernance({ ownerKey: key, dir: null })
    this.economics = opts.economics ?? DEFAULT_ECONOMICS
    this.fees = new FeeDesk(store, chain, emit, opts.feeWallet, this.economics)
  }

  get pubkey(): Hex {
    return this.key.pubkey
  }

  // ---- order book side: nothing here, the OrderBook class owns it ----

  // ---- sandbox ----

  async sandboxPubkey(): Promise<{ sandbox_pk: Hex; attestation: Attestation }> {
    const sandbox_pk = await this.sandbox.pubkey()
    return { sandbox_pk, attestation: attest(this.key, sandbox_pk, this.imageDigest) }
  }

  async submitToSandbox(senderPk: Hex, ciphertext: string): Promise<SandboxResult> {
    const result = await this.sandbox.run(senderPk, ciphertext)
    const id = resultHash(result)
    this.store.recordSandboxRun({ id, borrower_pk: result.borrower_pk, bundle_hash: result.bundle_hash, result_hash: id, sandbox_pk: result.sandbox_pk, created_at: Date.now() })
    this.emit({
      type: 'sandbox',
      borrower_pk: result.borrower_pk,
      offer_id: result.offer_id,
      checks: result.checks,
      model_trace: result.model_trace,
      note: 'raw bundle decrypted and discarded inside the sandbox; only this signed result left it',
    })
    return result
  }

  // ---- loan lifecycle ----

  /** A lender registers the terms it accepted. The platform checks them before it will ever co-sign anything about them. */
  async registerLoan(terms: unknown, portable?: PassbookDocument): Promise<{ loan: LoanRecord; verdict: Verdict }> {
    validateTerms(terms, this.economics)
    if (portable) {
      const backfillHeight = await this.chain.getHeight()
      const verified = await verifyPassbook(portable, this.chain)
      if (portable.borrower_pk !== terms.borrower_pk || !verified.document_valid || verified.unverified) throw new PolicyError('portable passbook failed verification', { ok: false, checks: [] })
      // Optional index backfill after a platform restart. Every imported claim
      // passed the same local verifier the lender uses; no history is dropped.
      for (let i = 0; i < portable.pages.length; i++) {
        const page = portable.pages[i]
        const p = verified.pages[i]
        if (!p.verified.close || !page.outcome_txid) continue
        const receipt = page.repayment?.kind === 'rgb_receipt' ? page.repayment.receipt : undefined
        const repayment = receipt ? await this.chain.getTx(receipt.repayment_txid) : null
        const closed = await this.chain.getTx(page.outcome_txid)
        const now = Date.now()
        const row: LoanRecord = { id: p.loan_id, terms: page.terms, status: page.outcome!, lock_txid: page.lock_txid, lock_vout: page.lock_vout, ...(page.outcome === 'repaid' ? { release_txid: page.outcome_txid, repayment_txid: receipt?.repayment_txid, repayment_proof: page.repayment?.kind === 'atomic' ? 'atomic_preimage' : 'portable_receipt', repayment_preimage: page.repayment?.kind === 'atomic' ? page.repayment.preimage : undefined, repaid_height: repayment?.height ?? closed?.height ?? undefined } : { settlement_txid: page.outcome_txid }), closed_height: closed?.height ?? undefined, created_at: now, updated_at: now }
        const prior = this.store.getLoan(row.id)
        if (prior) this.store.updateLoan(row.id, row)
        else this.store.insertLoan(row)
        // a loan funded through this platform that closed while it was offline: invoice its fee now
        if (prior?.status === 'open') this.fees.onClose(this.store.getLoan(row.id)!, backfillHeight)
      }
    }
    const checks: Check[] = []
    const height = await this.chain.getHeight()
    checks.push(c('platform', 'Platform key matches', terms.platform_pk === this.key.pubkey, terms.platform_pk.slice(0, 12)))
    checks.push(c('oracle', 'Oracle quote is ours and valid', verifyQuote(terms.oracle_quote, this.oracle.pubkey), `height ${terms.oracle_quote.height}`))
    checks.push(c('fresh', 'Quote is recent', height - terms.oracle_quote.height <= 2, `${height - terms.oracle_quote.height} block(s) old`))
    const ltv = ltvBps(debtOf(terms), terms.collateral_sats, terms.oracle_quote.price_cents)
    checks.push(c('ltv-stated', 'Stated LTV matches the amounts', Math.abs(ltv - terms.ltv_bps) <= 5, `${ltv} bps computed, ${terms.ltv_bps} stated`))
    const passbook = await buildPassbook(terms.borrower_pk, this.store, this.chain)
    checks.push(c('ladder', 'LTV within the borrower\'s earned ladder', terms.ltv_bps <= passbook.ladder.allowed_ltv_bps, `${terms.ltv_bps} bps asked, ${passbook.ladder.allowed_ltv_bps} bps allowed at step ${passbook.ladder.step}`))
    checks.push(c('step', 'Ladder step stated correctly', terms.ladder_step === passbook.ladder.step, `step ${terms.ladder_step} stated, ${passbook.ladder.step} on chain`))
    const lastClosed = [...passbook.pages].reverse().find((p) => p.verified.close && p.close_txid)
    const expectedPrev = lastClosed?.close_txid ?? null
    checks.push(c('chain', 'Chains to the previous passbook page', terms.prev_passbook_txid === expectedPrev, expectedPrev ? expectedPrev.slice(0, 12) : 'first page'))
    checks.push(c('open', 'No other open loan for this key', passbook.ladder.open === 0, `${passbook.ladder.open} open`))
    const id = termsHash(terms)
    checks.push(c('unique', 'Terms not registered before', !this.store.getLoan(id), id.slice(0, 12)))
    const feeCheck = this.fees.enforcementCheck(terms.lender_pk, height)
    checks.push(feeCheck)
    const verdict = { ok: checks.every((x) => x.ok), checks }
    this.emit({ type: 'policy', actor: 'platform', title: `Register loan ${id.slice(0, 8)}`, ok: verdict.ok, checks })
    if (!verdict.ok) throw new PolicyError(feeCheck.ok ? 'loan registration refused' : OUTSTANDING_FEE_MESSAGE, verdict)
    const now = Date.now()
    // the share the lender accepts by registering: the fee at close is charged at this rate
    const loan: LoanRecord = { id, terms, status: 'pending', platform_share_bps: this.economics.platform_share_bps, created_at: now, updated_at: now }
    this.store.insertLoan(loan)
    return { loan, verdict }
  }

  /** The borrower (or the lender) reports the lock. Accepted only if Bitcoin agrees. */
  async recordLock(loanId: Hex, lockTxid: Hex): Promise<LoanRecord> {
    const loan = this.mustGet(loanId, 'pending')
    const tx = await this.chain.getTx(lockTxid)
    if (!isConfirmed(tx)) throw new PolicyError('lock transaction not confirmed', { ok: false, checks: [] })
    const hash = termsHash(loan.terms)
    const commits = tx.outputs.some((o) => opReturnPayload(o.script) === hash)
    const script = escrowFor(partiesOf(loan.terms)).script
    const vout = tx.outputs.findIndex((o) => o.value === loan.terms.collateral_sats && o.script === script)
    const chained = loan.terms.prev_passbook_txid === null || tx.inputs.some((i) => i.txid === loan.terms.prev_passbook_txid)
    const checks = [
      c('commit', 'Lock commits to the terms hash', commits, hash.slice(0, 12)),
      c('amount', 'An output carries the collateral', tx.outputs.some((o) => o.value === loan.terms.collateral_sats), `${loan.terms.collateral_sats} sats`),
      c('script', 'Collateral pays the escrow derived from these terms', vout >= 0, script),
      c('chain', 'Lock spends the previous release', chained, loan.terms.prev_passbook_txid?.slice(0, 12) ?? 'first page'),
    ]
    const ok = checks.every((x) => x.ok)
    this.emit({ type: 'policy', actor: 'platform', title: `Record lock for ${loanId.slice(0, 8)}`, ok, checks })
    if (!ok) throw new PolicyError('lock rejected', { ok, checks })
    const updated = this.store.updateLoan(loanId, { status: 'locked', lock_txid: lockTxid, lock_vout: vout, locked_height: tx.height })
    this.emit({ type: 'loan', loan_id: loanId, status: 'locked', txid: lockTxid, height: tx.height })
    return updated
  }

  /** The lender reports it sent the dollars. The platform cannot validate an RGB transfer itself; it records the lender's signed claim. */
  async recordFunded(loanId: Hex, disbursementTxid: Hex, lenderSig: Hex): Promise<LoanRecord> {
    const loan = this.mustGet(loanId, 'locked')
    if (!verifyHash(lenderSig, hashObject({ loan_id: loanId, disbursement_txid: disbursementTxid }), loan.terms.lender_pk)) throw new PolicyError('funding notice not signed by the lender', { ok: false, checks: [] })
    const tx = await this.chain.getTx(disbursementTxid)
    if (!isConfirmed(tx)) throw new PolicyError('disbursement transaction not confirmed', { ok: false, checks: [] })
    const updated = this.store.updateLoan(loanId, { status: 'open', disbursement_txid: disbursementTxid, funded_height: tx.height })
    this.emit({ type: 'loan', loan_id: loanId, status: 'open', txid: disbursementTxid, height: tx.height })
    return updated
  }

  /**
   * The borrower reports the RGB repayment, or the lender confirms it with a signature.
   * Only the lender's signature (or a consignment the platform validated, see verifyRepayment) is proof.
   */
  async recordRepaid(loanId: Hex, repaymentTxid: Hex, lenderSig?: Hex): Promise<LoanRecord> {
    const loan = this.mustGet(loanId, 'open')
    const tx = await this.chain.getTx(repaymentTxid)
    if (!isConfirmed(tx)) throw new PolicyError('repayment transaction not confirmed', { ok: false, checks: [] })
    const lenderAck = lenderSig !== undefined && verifyHash(lenderSig, hashObject({ loan_id: loanId, repayment_txid: repaymentTxid }), loan.terms.lender_pk)
    // an unproven report never replaces a proven repayment
    if (!lenderAck && loan.repayment_proof) return loan
    const updated = this.store.updateLoan(loanId, { repayment_txid: repaymentTxid, repaid_height: tx.height, repayment_proof: lenderAck ? 'lender_ack' : undefined })
    this.emit({ type: 'loan', loan_id: loanId, status: 'open', note: lenderAck ? 'repayment confirmed by lender' : 'repayment reported by borrower', txid: repaymentTxid, height: tx.height })
    return updated
  }

  /**
   * The lender hands over the xpubs of its repayment account for this loan. The platform
   * opens a watch-only rgb-lib wallet on them, issues the repayment invoice (principal + fee)
   * there and returns it with a backup the lender restores into its own account.
   * The borrower pays only this invoice, so the platform can always validate the repayment.
   */
  async registerRepaymentWatch(loanId: Hex, keys: WatchKeys, lenderSig: Hex): Promise<IssuedInvoice> {
    const loan = this.store.getLoan(loanId)
    if (!loan) throw new PolicyError('unknown loan', { ok: false, checks: [] })
    if (!this.repayments) throw new PolicyError('this platform runs no RGB watcher', { ok: false, checks: [] })
    const fields = { account_xpub_vanilla: keys.account_xpub_vanilla, account_xpub_colored: keys.account_xpub_colored, master_fingerprint: keys.master_fingerprint }
    const checks = [
      c('status', 'Loan locked or open', loan.status === 'locked' || loan.status === 'open', loan.status),
      c('once', 'No repayment invoice issued yet', !loan.repayment_watch, loan.repayment_watch?.recipient_id ?? 'none'),
      c('lender', 'Requested by the lender', verifyHash(lenderSig, hashObject({ loan_id: loanId, ...fields }), loan.terms.lender_pk), loan.terms.lender_pk.slice(0, 12)),
    ]
    const ok = checks.every((x) => x.ok)
    this.emit({ type: 'policy', actor: 'platform', title: `Repayment invoice for ${loanId.slice(0, 8)}`, ok, checks })
    if (!ok) throw new PolicyError('repayment invoice refused', { ok, checks })
    const height = await this.chain.getHeight()
    // seconds, generous: the invoice must outlive maturity + grace however fast blocks come
    const issued = this.repayments.issue(loanId, fields, debtOf(loan.terms), Math.max(30 * 24 * 3600, (loan.terms.recovery_height - height) * 600 * 2))
    this.store.updateLoan(loanId, { repayment_watch: { ...fields, invoice: issued.invoice, recipient_id: issued.recipient_id } })
    this.emit({ type: 'loan', loan_id: loanId, status: loan.status, note: 'repayment invoice issued from the platform\'s watch-only wallet on the lender\'s repayment account', recipient_id: issued.recipient_id })
    return issued
  }

  /**
   * Validate the RGB repayment without the lender: the platform's watch-only wallet refreshes,
   * rgb-lib fetches the consignment for the platform-issued invoice from the proxy and validates
   * it against the indexer. Recorded as proof when every check passes.
   */
  async verifyRepayment(loanId: Hex, claimedTxid?: Hex): Promise<Verdict & { repayment_txid?: Hex; receipt?: RgbRepaymentReceipt }> {
    const loan = this.store.getLoan(loanId)
    if (!loan) return { ok: false, checks: [c('loan', 'Loan known', false, loanId.slice(0, 12))] }
    const checks: Check[] = [c('status', 'Loan open', loan.status === 'open', loan.status)]
    const watch = loan.repayment_watch
    // the beneficiary holds by construction: rgb-lib settles this receive only for a consignment whose
    // seal is this invoice's output, derived from the lender's repayment account
    checks.push(c('watch', 'Repayment invoice issued by the platform on the lender\'s repayment account', !!watch && !!this.repayments, watch ? `${watch.recipient_id.slice(0, 24)}… on ${watch.master_fingerprint}` : 'none for this loan'))
    let txid: Hex | undefined
    if (watch && this.repayments) {
      const r = this.repayments.inspect(loanId, watch, watch.recipient_id, loan.terms.asset_id)
      const debt = debtOf(loan.terms)
      txid = r?.txid ?? undefined
      checks.push(c('consignment', 'Consignment validated by rgb-lib and settled', r?.status === 'Settled', r ? `${r.status}${r.txid ? ` in ${r.txid.slice(0, 12)}` : ''}` : 'nothing received'))
      checks.push(c('asset', 'Pays the loan\'s asset', !!r && r.amount > 0, loan.terms.asset_id.slice(0, 24)))
      checks.push(c('amount', 'At least principal + fee', !!r && r.amount >= debt, `${r?.amount ?? 0} of ${debt}`))
      const tx = txid ? await this.chain.getTx(txid) : null
      checks.push(c('witness', 'Witness transaction confirmed on Bitcoin', isConfirmed(tx), tx?.height ? `height ${tx.height}` : 'not confirmed'))
      if (claimedTxid !== undefined) checks.push(c('claimed', 'Matches the claimed repayment', claimedTxid === txid, claimedTxid.slice(0, 12)))
      const passed = checks.every((x) => x.ok)
      if (passed && isConfirmed(tx) && !(loan.repayment_proof === 'lender_ack' && loan.repayment_txid === txid)) {
        this.store.updateLoan(loanId, { repayment_txid: txid, repaid_height: tx.height, repayment_proof: 'rgb_consignment' })
        this.emit({ type: 'loan', loan_id: loanId, status: 'open', note: 'repayment validated by the platform from the RGB consignment', txid, height: tx.height })
      }
    }
    const ok = checks.every((x) => x.ok)
    this.emit({ type: 'policy', actor: 'platform', title: `Validate repayment for ${loanId.slice(0, 8)}`, ok, checks })
    return { ok, checks, repayment_txid: txid, receipt: ok && txid ? rgbRepaymentReceipt(this.key, loan.terms, txid, debtOf(loan.terms)) : undefined }
  }

  /** The release (leaf A, borrower + lender, or leaf C on proven repayment) closed the escrow. The page is complete. */
  async recordRelease(loanId: Hex, releaseTxid: Hex): Promise<LoanRecord> {
    const loan = this.mustGet(loanId, 'open')
    const tx = await this.chain.getTx(releaseTxid)
    if (!isConfirmed(tx)) throw new PolicyError('release transaction not confirmed', { ok: false, checks: [] })
    if (!tx.inputs.some((i) => i.txid === loan.lock_txid && i.vout === loan.lock_vout)) throw new PolicyError('release does not spend the collateral output', { ok: false, checks: [] })
    const input = tx.inputs.find((i) => i.txid === loan.lock_txid && i.vout === loan.lock_vout)!
    const preimage = atomicWitnessPreimage(input, loan.terms)
    if (!preimage && (!loan.repayment_txid || !loan.repayment_proof)) throw new PolicyError('no validated repayment recorded for this loan', { ok: false, checks: [] })
    const updated = this.store.updateLoan(loanId, { status: 'repaid', release_txid: releaseTxid, closed_height: tx.height, ...(preimage ? { repayment_proof: 'atomic_preimage' as const, repayment_preimage: preimage, repaid_height: tx.height } : {}) })
    const onTime = (updated.repaid_height ?? Infinity) <= loan.terms.maturity_height
    this.emit({ type: 'loan', loan_id: loanId, status: 'repaid', txid: releaseTxid, height: tx.height, on_time: onTime })
    this.fees.onClose(updated)
    return updated
  }

  /** A split, liquidation or refund closed the escrow. */
  async recordSettlement(loanId: Hex, txid: Hex, outcome: 'defaulted' | 'liquidated' | 'refunded'): Promise<LoanRecord> {
    const loan = this.store.getLoan(loanId)
    if (!loan) throw new PolicyError('unknown loan', { ok: false, checks: [] })
    if (loan.status !== 'open' && loan.status !== 'locked') throw new PolicyError(`loan is ${loan.status}`, { ok: false, checks: [] })
    // a refund is only for a loan the lender never funded; a split or liquidation only for a funded one.
    // Otherwise a funded loan reported as refunded would escape the platform fee.
    if ((outcome === 'refunded') !== (loan.status === 'locked')) throw new PolicyError(`${loan.status === 'open' ? 'an open' : 'a locked'} loan cannot be ${outcome}`, { ok: false, checks: [] })
    const tx = await this.chain.getTx(txid)
    if (!isConfirmed(tx)) throw new PolicyError('settlement transaction not confirmed', { ok: false, checks: [] })
    if (!tx.inputs.some((i) => i.txid === loan.lock_txid && i.vout === loan.lock_vout)) throw new PolicyError('settlement does not spend the collateral output', { ok: false, checks: [] })
    const updated = this.store.updateLoan(loanId, { status: outcome, settlement_txid: txid, closed_height: tx.height })
    this.emit({ type: 'loan', loan_id: loanId, status: outcome, txid, height: tx.height })
    // the same fee on a split or a liquidation as on a repayment; none on a refund (never funded)
    if (loan.status === 'open') this.fees.onClose(updated)
    return updated
  }

  // ---- co-signing ----

  async decideCosign(req: CosignRequest): Promise<CosignDecision> {
    const loan = this.store.getLoan(req.loan_id)
    const height = await this.chain.getHeight()
    const checks: Check[] = []
    if (!loan) return { ok: false, checks: [c('loan', 'Loan known', false, req.loan_id.slice(0, 12))] }
    let liquidationPrice = this.oracle.currentPrice()
    switch (req.purpose) {
      case 'refund': {
        checks.push(c('status', 'Loan locked and never funded', loan.status === 'locked', loan.status))
        checks.push(c('timeout', 'Funding window has passed', loan.locked_height !== undefined && height >= loan.locked_height + FUND_TIMEOUT_BLOCKS, `locked at ${loan.locked_height}, now ${height}`))
        break
      }
      case 'release': {
        checks.push(c('status', 'Loan open', loan.status === 'open', loan.status))
        let claimed = req.repayment_txid ?? loan.repayment_txid
        let proven = loan.repayment_proof !== undefined && loan.repayment_txid === claimed ? loan.repayment_proof : undefined
        if (!proven && loan.status === 'open' && loan.repayment_watch && this.repayments) {
          const v = await this.verifyRepayment(loan.id, req.repayment_txid)
          if (v.ok) {
            proven = 'rgb_consignment'
            claimed = v.repayment_txid
          }
        }
        const tx = claimed ? await this.chain.getTx(claimed) : null
        checks.push(c('repayment', 'Repayment transaction confirmed', isConfirmed(tx), claimed?.slice(0, 12) ?? 'none'))
        checks.push(
          c(
            'proof',
            'Repayment proof accepted',
            proven !== undefined,
            proven === 'lender_ack'
              ? 'acknowledged by the lender'
              : proven === 'rgb_consignment'
                ? 'consignment validated by the platform\'s watch-only rgb-lib wallet'
                : 'neither a lender acknowledgement nor a validated RGB consignment for this repayment',
          ),
        )
        break
      }
      case 'liquidate': {
        // The last good price remains visible during an outage, but must not
        // authorize spending collateral once its live observation is stale.
        let quote: OracleQuote | undefined
        try {
          quote = this.oracle.quote(height)
          checks.push(c('oracle', 'Current oracle observation is usable', true, quote.source ?? 'configured'))
        } catch (err) {
          checks.push(c('oracle', 'Current oracle observation is usable', false, (err as Error).message))
        }
        // Averages move every refresh. Decide from the quote the lender priced
        // its outputs with when it is ours and recent, so both sides agree.
        const lenders = req.oracle_quote !== undefined && this.oracle.recentForLiquidation(req.oracle_quote)
        if (lenders) quote = req.oracle_quote
        checks.push(c('status', 'Loan open', loan.status === 'open', loan.status))
        const prices = quote ? liquidationPrices(quote) : { spot: this.oracle.currentPrice(), slow: null, fast: null }
        const due = liquidationDecision(debtOf(loan.terms), loan.terms.collateral_sats, prices, loan.margin_call_height, height)
        liquidationPrice = due.price_cents ?? prices.spot
        const at = (p: number | null) => p === null ? 'not yet available' : `${p} cents`
        checks.push(c('average', 'Time-averaged prices available', prices.slow !== null || prices.fast !== null, `30-minute ${at(prices.slow)}, 5-minute ${at(prices.fast)}${lenders ? " (lender's quote)" : ''}`))
        checks.push(c('ltv', 'Averaged LTV at the liquidation level, or the 5-minute average at the hard stop', due.at_liquidation, due.basis ? `${due.basis === 'fast' ? '5-minute hard stop' : '30-minute average'} at ${due.price_cents} cents` : `spot ${due.headroom.ltv_bps} bps at ${prices.spot} cents`))
        checks.push(c('cure', 'Cure window expired or hard stop reached', due.cure_over, loan.margin_call_height === undefined ? 'no margin call recorded' : `margin call at ${loan.margin_call_height}, now ${height}`))
        break
      }
    }
    const leaf = COSIGN_LEAF[req.purpose]
    let psbt: ReturnType<typeof psbtFromBase64> | undefined
    let txid = req.txid
    if (req.psbt !== undefined) {
      try {
        psbt = psbtFromBase64(req.psbt)
      } catch {
        psbt = undefined
      }
      checks.push(c('psbt', 'PSBT parses', psbt !== undefined, psbt ? 'ok' : 'not a PSBT'))
      if (psbt) {
        const expected: TxOut[] = req.purpose === 'liquidate' ? liquidationOutputs(loan.terms, liquidationPrice) : releaseOutputs(loan.terms)
        checks.push(...spendChecks(psbt, loan, leaf, expected))
        const derived = unsignedTxid(psbt)
        checks.push(c('txid', 'Stated txid matches the PSBT', req.txid === undefined || req.txid === derived, derived.slice(0, 12)))
        txid = derived
      }
    }
    if (txid === undefined) checks.push(c('txid', 'Transaction identified', false, 'send a psbt or a txid'))
    const ok = checks.every((x) => x.ok)
    this.emit({ type: 'policy', actor: 'platform', title: `Co-sign ${req.purpose} for ${req.loan_id.slice(0, 8)}`, ok, checks })
    if (!ok) return { ok, checks }
    const approval = signObject({ loan_id: req.loan_id, purpose: req.purpose, txid: txid!, height, platform_pk: this.key.pubkey }, this.key.secretKey)
    if (!psbt) return { ok, checks, approval }
    const parties = partiesOf(loan.terms)
    try {
      await this.governance.signLeaf(psbt, parties, leaf, this.key.secretKey, { action: req.purpose === 'liquidate' ? 'liquidate' : 'release', initiator: { service: `platform-cosign-${req.purpose}` }, terms: loan.terms, counterparty: req.purpose === 'liquidate' ? loan.terms.lender_pk : loan.terms.borrower_pk })
    } catch (err) {
      if (!(err instanceof GateRefused)) throw err
      checks.push(c('gate', 'Platform policy gate allows the co-signature', false, `${err.decision.reason} (${err.decision.action_id})`))
      return { ok: false, checks }
    }
    return { ok, checks, approval, psbt: psbt.toBase64(), leaf, leaf_sig: leafSignature(psbt, parties, leaf, 'platform')! }
  }

  // ---- monitoring ----

  /** Compare every open loan with the current oracle price; raise or clear margin calls. */
  async monitor(): Promise<{ loan_id: Hex; ltv_bps: number; state: string }[]> {
    const height = await this.chain.getHeight()
    const out: { loan_id: Hex; ltv_bps: number; state: string }[] = []
    for (const loan of this.store.loansByStatus('open')) {
      const h = headroom(debtOf(loan.terms), loan.terms.collateral_sats, this.oracle.currentPrice())
      out.push({ loan_id: loan.id, ltv_bps: h.ltv_bps, state: h.state })
      if (h.ltv_bps >= MARGIN_CALL_BPS && loan.margin_call_height === undefined) {
        // The cure window starts only with a signed quote. While none can be
        // signed (stale feed, USDT off its peg) the call waits for the next tick.
        let sig: Hex
        try { sig = this.oracle.quote(height).sig } catch { continue }
        this.store.updateLoan(loan.id, { margin_call_height: height })
        this.store.recordQuote(height, this.oracle.currentPrice(), sig)
        this.emit({ type: 'margin_call', loan_id: loan.id, borrower_pk: loan.terms.borrower_pk, ltv_bps: h.ltv_bps, cure_until_height: height + CURE_BLOCKS, price_cents: this.oracle.currentPrice(), state: h.state })
      } else if (h.ltv_bps < MARGIN_CALL_BPS && loan.margin_call_height !== undefined) {
        this.store.updateLoan(loan.id, { margin_call_height: undefined })
        this.emit({ type: 'margin_call_cleared', loan_id: loan.id, ltv_bps: h.ltv_bps })
      }
    }
    return out
  }

  passbook(borrowerPk: Hex): Promise<Passbook> {
    return buildPassbook(borrowerPk, this.store, this.chain)
  }

  /**
   * The passbook as the borrower's wallet shows it: the verified pages and the
   * ladder, plus the oracle price, the ladder's steps, and for a funded loan the
   * margin and liquidation prices and the end of any cure window. All of it is
   * computed here from verified state; the wallet only formats it.
   */
  async passbookView(borrowerPk: Hex): Promise<PassbookView> {
    const pb = await this.passbook(borrowerPk)
    const price = this.oracle.currentPrice()
    const pages = await Promise.all(pb.pages.map(async (p): Promise<PassbookViewPage> => {
      const loan = this.store.getLoan(p.loan_id)
      const view: PassbookViewPage = { ...p }
      if (p.status === 'open') view.headroom = headroom(p.principal + p.fee, p.collateral_sats, price)
      if (p.status === 'open' && loan?.margin_call_height !== undefined) view.cure_until_height = loan.margin_call_height + CURE_BLOCKS
      if (loan?.repayment_txid) view.repayment_txid = loan.repayment_txid
      if (p.verified.close && p.close_txid) {
        const tx = await this.chain.getTx(p.close_txid)
        const script = keyPathOutput(borrowerPk).script
        view.returned_sats = tx!.outputs.filter((o) => o.script === script).reduce((sum, o) => sum + o.value, 0)
      }
      return view
    }))
    return { ...pb, pages, price_cents: price, ladder_bps: LADDER_BPS }
  }

  private mustGet(loanId: Hex, status: LoanRecord['status']): LoanRecord {
    const loan = this.store.getLoan(loanId)
    if (!loan) throw new PolicyError('unknown loan', { ok: false, checks: [] })
    if (loan.status !== status) throw new PolicyError(`loan is ${loan.status}, expected ${status}`, { ok: false, checks: [] })
    return loan
  }
}

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly verdict: Verdict,
  ) {
    super(message)
  }
}

/** What the platform checks on a PSBT before adding its leaf signature. */
function spendChecks(psbt: ReturnType<typeof psbtFromBase64>, loan: LoanRecord, leaf: Leaf, expected: TxOut[]): Check[] {
  const d = describePsbt(psbt)
  const escrow = escrowFor(partiesOf(loan.terms))
  const input = psbt.data.inputs[0]
  const prevout = input?.witnessUtxo
  const tapLeaf = input?.tapLeafScript?.[0]
  const spendsEscrow = d.inputs.length === 1 && d.inputs[0].txid === loan.lock_txid && d.inputs[0].vout === loan.lock_vout
  const prevoutOk = !!prevout && bytesToHex(prevout.script) === escrow.script && Number(prevout.value) === loan.terms.collateral_sats
  const expectedLeaf = escrow.leaves[leaf]
  const leafOk = !!tapLeaf && !!expectedLeaf && bytesToHex(tapLeaf.script) === bytesToHex(expectedLeaf.script)
  const outputsOk = canonicalJson(d.outputs) === canonicalJson(expected)
  return [
    c('spend', 'Spends exactly this loan\'s escrow output', spendsEscrow, loan.lock_txid ? `${loan.lock_txid.slice(0, 12)}:${loan.lock_vout}` : 'no lock recorded'),
    c('prevout', 'Escrow script and amount as registered', prevoutOk, `${loan.terms.collateral_sats} sats`),
    c('leaf', `Spends through leaf ${leaf}`, leafOk, `leaf ${leaf}`),
    c('outputs', 'Pays exactly what the policy dictates', outputsOk, expected.map((o) => `${o.value} sats`).join(' + ')),
  ]
}

function c(id: string, label: string, ok: boolean, detail: string): Check {
  return { id, ok, detail: `${label}: ${detail}` }
}

/** Convenience for lenders and tests: the signatures the platform expects on notices. */
export function fundingNotice(lender: KeyPair, loanId: Hex, disbursementTxid: Hex): Hex {
  return signObject({ loan_id: loanId, disbursement_txid: disbursementTxid }, lender.secretKey).sig
}

export function repaymentAck(lender: KeyPair, loanId: Hex, repaymentTxid: Hex): Hex {
  return signObject({ loan_id: loanId, repayment_txid: repaymentTxid }, lender.secretKey).sig
}

/** The lender's request for a repayment invoice on its per-loan repayment account. */
export function repaymentWatchRequest(lender: KeyPair, loanId: Hex, keys: WatchKeys): Hex {
  return signObject({ loan_id: loanId, account_xpub_vanilla: keys.account_xpub_vanilla, account_xpub_colored: keys.account_xpub_colored, master_fingerprint: keys.master_fingerprint }, lender.secretKey).sig
}

export function buildTerms(input: Omit<LoanTerms, 'v' | 'nonce'> & { nonce?: Hex }, nonce: Hex): LoanTerms {
  return { v: 1, ...input, nonce }
}
