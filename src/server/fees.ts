// The platform's revenue: a share of each loan's term interest, paid by the
// lender in USDT over RGB after the loan closes (docs/REVENUE.md).
//
// When a funded loan reaches a final outcome (repaid on time or late, split
// at maturity, liquidated) the platform issues an RGB invoice from its own
// wallet to the lender for platform_share_bps of terms.fee, recorded as
// fee_due with the loan id. The share is the one snapshotted on the loan when
// it was registered, so a later change of the published share never reaches
// a loan already funded. An invoice that failed to issue, has expired or is
// about to is replaced before it is handed out; a payment to an earlier
// invoice of the same fee still counts. The amount is the same on every outcome, so the
// platform never earns more from a liquidation than from a repayment. A
// refunded loan was never funded and owes nothing.
//
// The lender pays from its own USDT. The platform validates the receive the
// way it validates anything it did not sign itself: its wallet must hold a
// Settled witness receive for exactly that invoice's recipient (receiver), of
// the loan's asset, for at least the fee (asset, amount, receiver), with the
// witness transaction confirmed on Bitcoin. Then the fee is fee_paid.
//
// Credit checks billed at close (src/checknode/bill.ts: a lender with no
// Lightning gets the check on credit) join this fee: each operator-signed bill is
// added once to the first closing loan of that lender and borrower, so the
// lender pays one invoice and the same gate covers it (checkFeesFor).
//
// Nothing here touches the escrow, the split, the liquidation outputs or any
// repayment path. Enforcement is the order book and registration: a lender
// with a fee_due older than fee_grace_blocks has its offers refused and
// dropped from the platform's order book, and registerLoan refuses its new
// loans. In P2P mode this is only as strong as the order book's indexer: an
// unpaid lender can still post offers to an open relay (docs/THREAT-MODEL.md).

import { isConfirmed, type ChainClient } from '../chain/types.js'
import type { Hex, KeyPair } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, platformShare, type Economics } from '../core/economics.js'
import { usdt, type Bps, type Micro } from '../core/money.js'
import type { LoanRecord, NewWireEvent, Store } from '../registry/store.js'
import { deploymentConfigFromEnv, type PassbookConfig } from '../core/config.js'
import type { RgbConfig } from '../rgb/wallet.js'
import { billHash, billSignatureProblems } from '../checknode/bill.js'
import { checkBillSourceFromEnv, type CheckBillSource } from '../checknode/bill-ledger.js'

export type FeeOutcome = 'repaid_on_time' | 'repaid_late' | 'liquidated' | 'split'

/** One operator-signed check bill added to a closed loan's platform fee. */
export interface ChargedCheckFee {
  bill_hash: Hex
  negotiation_id: Hex
  operator_pk: Hex
  commitment: Hex
  asset_id: string
  amount: Micro
  /**
   * How the bill was tied to this loan. 'lender-borrower-window': the first loan of the same lender, borrower and asset
   * registered after the bill and before it expired. The platform registers LoanTerms only and never sees the term
   * sheet, so a sheet's scorer.check_bill cannot be matched here today.
   */
  linked_by: 'lender-borrower-window'
}

export interface FeeRecord {
  loan_id: Hex
  lender_pk: Hex
  asset_id: string
  outcome: FeeOutcome
  /** terms.fee: the lender's interest for the term, the same on every outcome */
  interest: Micro
  share_bps: Bps
  /** 'registered': the share snapshotted at registration. 'current': the loan predates snapshots, so the share at close applies. */
  share_basis?: 'registered' | 'current'
  /** What the lender owes: platformShare(interest), half-up to 0.01 USDT, plus any credit checks billed at close (check_fees). */
  amount: Micro
  /** With check_fees: the platform's share alone (amount minus the billed checks). */
  share_amount?: Micro
  /** Credit checks run on credit for this lender and billed at close (src/checknode/bill.ts): billed at close, not paid up front. */
  check_fees?: ChargedCheckFee[]
  status: 'fee_due' | 'fee_paid'
  /** null when no invoice could be issued (no fee wallet, or issuance failed): still due, not enforced until one is issued */
  invoice: string | null
  recipient_id: string | null
  /** Unix seconds after which `invoice` cannot be paid; it is replaced a day before. Absent on older records: created_at + 90 days. */
  invoice_expires_at?: number
  /** Recipients of earlier invoices for this fee, replaced after expiry or a failure; a payment to one of them still counts. */
  previous_recipient_ids?: string[]
  closed_height: number
  /** past this height an unpaid fee blocks the lender's offers and new loans */
  grace_until_height: number
  paid_txid?: Hex
  paid_height?: number
  created_at: number
  updated_at: number
}

/** What the platform's own wallet saw for one fee invoice after a refresh. */
export interface FeeReceive {
  recipient_id: string
  /** rgb-lib's status: 'Settled' only after the consignment validated and the witness confirmed */
  status: string
  txid: Hex | null
  /** amount of `assetId` received; 0 when none of that asset arrived */
  amount: Micro
}

/** The platform's receiving wallet for fees. The platform's rules depend on this, not on rgb-lib. */
export interface FeeWallet {
  /** `expires_at` in Unix seconds when the wallet knows it. */
  invoice(amount: Micro, assetId: string, durationSeconds: number): { invoice: string; recipient_id: string; expires_at?: number }
  receive(recipientId: string, assetId: string): FeeReceive | null
  close?(): void
}

export const OUTSTANDING_FEE_MESSAGE = 'Pay your outstanding platform fee to publish offers.'
/** Fee invoices outlive any grace period by far; an expired one is replaced (ensureInvoice). */
export const INVOICE_SECONDS = 90 * 24 * 3600
/** Replace an invoice this long before it expires, so the lender never pays into one about to lapse. */
export const INVOICE_REISSUE_MARGIN_SECONDS = 24 * 3600
/** After a failed issuance, listings retry at most this often; an explicit request always retries. */
const REISSUE_RETRY_MS = 60_000

/** The fee outcome of a closed loan, or null when no fee is owed (still open, or refunded: never funded). */
export function feeOutcome(loan: Pick<LoanRecord, 'status' | 'repaid_height' | 'terms'>): FeeOutcome | null {
  switch (loan.status) {
    case 'repaid':
      return (loan.repaid_height ?? Infinity) <= loan.terms.maturity_height ? 'repaid_on_time' : 'repaid_late'
    case 'liquidated':
      return 'liquidated'
    case 'defaulted':
      return 'split'
    default:
      return null
  }
}

/** The fee the lender owes on a loan: the platform's share of terms.fee, whatever the outcome. */
export function platformFeeOf(terms: { fee: Micro }, e: Pick<Economics, 'platform_share_bps'> = DEFAULT_ECONOMICS): Micro {
  return platformShare(terms.fee, e)
}

interface Check {
  id: string
  ok: boolean
  detail: string
}

const check = (id: string, label: string, ok: boolean, detail: string): Check => ({ id, ok, detail: `${label}: ${detail}` })

export class FeeDesk {
  /** When issuing a fee's invoice last failed, so listings polled every few seconds do not retry each time. */
  private readonly failedAt = new Map<Hex, number>()

  constructor(
    readonly store: Store,
    readonly chain: ChainClient,
    readonly emit: (event: NewWireEvent) => void,
    readonly wallet?: FeeWallet,
    readonly economics: Economics = DEFAULT_ECONOMICS,
    /** Bills for credit checks run on credit (bill-at-close); from PASSBOOK_CHECK_BILLS and PASSBOOK_CHECK_BILL_OPERATORS. */
    readonly bills: CheckBillSource | null = checkBillSourceFromEnv(),
  ) {}

  /**
   * The check bills a closing loan carries: signed by an accepted operator, for this lender and borrower and the
   * loan's asset, issued before the loan was registered and still unexpired then, and never charged before. Each
   * bill is charged once, to the first such loan that closes. Bills that never meet a loan are the provider's cost.
   */
  checkFeesFor(loan: Pick<LoanRecord, 'terms' | 'created_at'>): ChargedCheckFee[] {
    if (!this.bills) return []
    const charged = new Set(this.store.listFees(loan.terms.lender_pk).flatMap((f) => (f.check_fees ?? []).map((c) => c.bill_hash)))
    const out = new Map<Hex, ChargedCheckFee>()
    for (const b of this.bills.bills()) {
      if (!this.bills.operators.includes(b?.operator_pk) || billSignatureProblems(b).length) continue
      if (b.lender_pk !== loan.terms.lender_pk || b.borrower_pk !== loan.terms.borrower_pk || b.fee.asset_id !== loan.terms.asset_id) continue
      const registered = Math.floor(loan.created_at / 1000)
      if (b.issued_at > registered + 300 || b.expires_at <= registered) continue
      const h = billHash(b)
      if (charged.has(h) || out.has(h)) continue
      out.set(h, { bill_hash: h, negotiation_id: b.negotiation_id, operator_pk: b.operator_pk, commitment: b.commitment, asset_id: b.fee.asset_id, amount: b.fee.amount, linked_by: 'lender-borrower-window' })
    }
    return [...out.values()]
  }

  /** The share a loan is charged at: its registration snapshot, else (registered before snapshots) the current share. */
  shareFor(loan: Pick<LoanRecord, 'platform_share_bps'>): { share_bps: Bps; basis: 'registered' | 'current' } {
    return loan.platform_share_bps === undefined ? { share_bps: this.economics.platform_share_bps, basis: 'current' } : { share_bps: loan.platform_share_bps, basis: 'registered' }
  }

  /**
   * Called when a loan closes. Idempotent: one fee per loan, whatever is reported later; an
   * existing fee only gets its invoice replaced if that one is unusable (ensureInvoice).
   * `issuedHeight` is the height the invoice is issued at when it is later than the close
   * (a close backfilled from a portable passbook): the grace period runs from the invoice.
   */
  onClose(loan: LoanRecord, issuedHeight?: number, nowMs = Date.now()): FeeRecord | null {
    const outcome = feeOutcome(loan)
    const closedHeight = loan.closed_height ?? issuedHeight
    if (!outcome || closedHeight === undefined) return null
    const existing = this.store.getFee(loan.id)
    if (existing) return this.ensureInvoice(existing, issuedHeight ?? closedHeight, nowMs, { force: true })
    const { share_bps, basis } = this.shareFor(loan)
    const share = platformFeeOf(loan.terms, { platform_share_bps: share_bps })
    // Credit checks billed at close, not paid up front: one fee, one invoice, the same gate.
    const checkFees = this.checkFeesFor(loan)
    const checkTotal = checkFees.reduce((sum, c) => sum + c.amount, 0)
    const amount = share + checkTotal
    const issued = amount > 0 ? this.issue(amount, loan.terms.asset_id, nowMs) : { note: 'nothing owed' }
    const fee: FeeRecord = {
      loan_id: loan.id,
      lender_pk: loan.terms.lender_pk,
      asset_id: loan.terms.asset_id,
      outcome,
      interest: loan.terms.fee,
      share_bps,
      share_basis: basis,
      amount,
      ...(checkFees.length ? { share_amount: share, check_fees: checkFees } : {}),
      status: amount > 0 ? 'fee_due' : 'fee_paid',
      invoice: issued.invoice?.invoice ?? null,
      recipient_id: issued.invoice?.recipient_id ?? null,
      ...(issued.invoice ? { invoice_expires_at: issued.invoice.expires_at } : {}),
      closed_height: closedHeight,
      grace_until_height: Math.max(closedHeight, issuedHeight ?? closedHeight) + this.economics.fee_grace_blocks,
      created_at: nowMs,
      updated_at: nowMs,
    }
    this.store.insertFee(fee)
    const shareNote = basis === 'registered' ? 'share fixed at registration' : 'loan registered before share snapshots: share current at close'
    const checkNote = checkFees.length ? ` plus ${checkFees.length} credit check${checkFees.length > 1 ? 's' : ''} billed at close, not paid up front (${usdt(checkTotal)})` : ''
    this.emit({ type: 'fee', status: fee.status, loan_id: fee.loan_id, lender_pk: fee.lender_pk, outcome, interest: fee.interest, amount, share_bps, share_basis: basis, grace_until_height: fee.grace_until_height, invoiced: !!fee.invoice, ...(checkFees.length ? { share_amount: share, check_fees: checkFees } : {}), note: `${issued.note}; ${shareNote}`, title: `Platform fee ${usdt(amount)} due from the lender (${share_bps / 100}% of ${usdt(fee.interest)} interest, ${outcome.replaceAll('_', ' ')})${checkNote}` })
    return fee
  }

  private issue(amount: Micro, assetId: string, nowMs: number): { invoice?: { invoice: string; recipient_id: string; expires_at: number }; note: string } {
    if (!this.wallet) return { note: 'no platform fee wallet configured: recorded, not payable, not enforced' }
    try {
      const inv = this.wallet.invoice(amount, assetId, INVOICE_SECONDS)
      return { invoice: { invoice: inv.invoice, recipient_id: inv.recipient_id, expires_at: inv.expires_at ?? Math.floor(nowMs / 1000) + INVOICE_SECONDS }, note: 'RGB invoice issued from the platform wallet' }
    } catch (err) {
      return { note: `invoice not issued: ${(err as Error).message}` }
    }
  }

  /** Whether a fee's invoice can still be paid with a day to spare. */
  invoiceUsable(fee: FeeRecord, nowMs = Date.now()): boolean {
    if (fee.invoice === null) return false
    const expires = fee.invoice_expires_at ?? Math.floor(fee.created_at / 1000) + INVOICE_SECONDS
    return expires - INVOICE_REISSUE_MARGIN_SECONDS > Math.floor(nowMs / 1000)
  }

  /**
   * Replace a due fee's invoice when it never issued, has expired or is about to. The old
   * recipient is kept so a payment to it still verifies. A fee that had no invoice at all
   * gets its grace period from the first one (`height`): it could not be paid before.
   */
  ensureInvoice(fee: FeeRecord, height: number, nowMs = Date.now(), opts: { force?: boolean } = {}): FeeRecord {
    if (fee.status !== 'fee_due' || !this.wallet || this.invoiceUsable(fee, nowMs)) return fee
    if (!opts.force && nowMs - (this.failedAt.get(fee.loan_id) ?? -Infinity) < REISSUE_RETRY_MS) return fee
    const issued = this.issue(fee.amount, fee.asset_id, nowMs)
    if (!issued.invoice) {
      this.failedAt.set(fee.loan_id, nowMs)
      this.emit({ type: 'fee', status: fee.status, loan_id: fee.loan_id, lender_pk: fee.lender_pk, amount: fee.amount, invoiced: false, note: issued.note, title: `Platform fee ${usdt(fee.amount)}: no payable invoice yet` })
      return fee
    }
    this.failedAt.delete(fee.loan_id)
    const first = fee.invoice === null
    const updated = this.store.updateFee(fee.loan_id, {
      invoice: issued.invoice.invoice,
      recipient_id: issued.invoice.recipient_id,
      invoice_expires_at: issued.invoice.expires_at,
      previous_recipient_ids: [...(fee.previous_recipient_ids ?? []), ...(fee.recipient_id ? [fee.recipient_id] : [])],
      ...(first ? { grace_until_height: Math.max(fee.grace_until_height, height + this.economics.fee_grace_blocks) } : {}),
    })
    this.emit({ type: 'fee', status: updated.status, loan_id: fee.loan_id, lender_pk: fee.lender_pk, amount: fee.amount, invoiced: true, grace_until_height: updated.grace_until_height, note: first ? 'first payable invoice issued; the grace period runs from it' : 'expiring invoice replaced; the earlier one still counts if paid', title: `Platform fee ${usdt(fee.amount)}: ${first ? 'invoice issued' : 'invoice replaced'}` })
    return updated
  }

  /** Make every due fee of a lender payable (replacing missing or expiring invoices), then list them. */
  refreshInvoices(lenderPk: Hex, height: number, nowMs = Date.now()): FeeRecord[] {
    return this.store.listFees(lenderPk).map((f) => this.ensureInvoice(f, height, nowMs))
  }

  list(lenderPk?: Hex): FeeRecord[] {
    return this.store.listFees(lenderPk)
  }

  /** Unpaid, payable fees past their grace period at `height`. Sync, so the order book can filter with it. */
  overdueAt(lenderPk: Hex, height: number): FeeRecord[] {
    return this.store.listFees(lenderPk).filter((f) => f.status === 'fee_due' && f.invoice !== null && height > f.grace_until_height)
  }

  /** The reason this lender may not publish or register at `height`, or null. */
  blockedAt(lenderPk: Hex, height: number): string | null {
    return this.overdueAt(lenderPk, height).length ? OUTSTANDING_FEE_MESSAGE : null
  }

  /** The check registerLoan runs. */
  enforcementCheck(lenderPk: Hex, height: number): Check {
    const overdue = this.overdueAt(lenderPk, height)
    return check('fees', 'No platform fee overdue for this lender', overdue.length === 0, overdue.length ? `${overdue.map((f) => `${usdt(f.amount)} for ${f.loan_id.slice(0, 8)} due since ${f.closed_height}, grace ended ${f.grace_until_height}`).join('; ')}. ${OUTSTANDING_FEE_MESSAGE}` : 'none overdue')
  }

  /** Validate the lender's payment from the platform's own wallet; marks the fee fee_paid when every check passes. */
  async verifyPayment(loanId: Hex, claimedTxid?: Hex): Promise<{ ok: boolean; checks: Check[]; fee?: FeeRecord }> {
    const fee = this.store.getFee(loanId)
    if (!fee) return { ok: false, checks: [check('fee', 'Platform fee recorded for this loan', false, loanId.slice(0, 12))] }
    if (fee.status === 'fee_paid') return { ok: true, checks: [check('status', 'Platform fee already paid', true, fee.paid_txid?.slice(0, 12) ?? 'nothing owed')], fee }
    const checks: Check[] = [check('invoice', 'Fee invoice issued from the platform wallet', !!fee.recipient_id && !!this.wallet, fee.recipient_id ? `${fee.recipient_id.slice(0, 24)}…` : 'none')]
    let paid: FeeRecord | undefined
    if (fee.recipient_id && this.wallet) {
      // the current invoice first, then any it replaced: a payment into an earlier one still counts
      const recipients = [fee.recipient_id, ...[...(fee.previous_recipient_ids ?? [])].reverse()]
      const seen = recipients.map((id) => ({ id, r: this.wallet!.receive(id, fee.asset_id) }))
      const { id: recipient, r } = seen.find((x) => x.r?.status === 'Settled') ?? seen[0]
      // receiver: rgb-lib settles a receive only for a consignment whose seal is this invoice's output
      checks.push(check('receiver', 'Receive settled for exactly an invoice of this fee', r?.status === 'Settled' && r.recipient_id === recipient, r ? `${r.status}${r.txid ? ` in ${r.txid.slice(0, 12)}` : ''}${recipient === fee.recipient_id ? '' : ' (an earlier invoice)'}` : 'nothing received'))
      checks.push(check('asset', "Pays the loan's asset", !!r && r.amount > 0, fee.asset_id.slice(0, 24)))
      checks.push(check('amount', 'At least the platform fee', !!r && r.amount >= fee.amount, `${r?.amount ?? 0} of ${fee.amount}`))
      const tx = r?.txid ? await this.chain.getTx(r.txid) : null
      checks.push(check('witness', 'Witness transaction confirmed on Bitcoin', isConfirmed(tx), tx?.height ? `height ${tx.height}` : 'not confirmed'))
      if (claimedTxid !== undefined) checks.push(check('claimed', 'Matches the claimed payment', claimedTxid === r?.txid, claimedTxid.slice(0, 12)))
      if (checks.every((c) => c.ok)) paid = this.store.updateFee(loanId, { status: 'fee_paid', paid_txid: r!.txid!, paid_height: tx!.height! })
    }
    const ok = checks.every((c) => c.ok)
    this.emit({ type: 'policy', actor: 'platform', title: `Validate platform fee for ${loanId.slice(0, 8)}`, ok, checks })
    if (paid) this.emit({ type: 'fee', status: 'fee_paid', loan_id: loanId, lender_pk: paid.lender_pk, amount: paid.amount, txid: paid.paid_txid, height: paid.paid_height, title: `Platform fee ${usdt(paid.amount)} paid by the lender over RGB` })
    return { ok, checks, fee: paid ?? fee }
  }
}

/** For tests and the fake-chain server: a fee wallet whose receives are set by the test. */
export class MemoryFeeWallet implements FeeWallet {
  private n = 0
  readonly receives = new Map<string, FeeReceive & { asset_id: string }>()
  readonly issued: { recipient_id: string; amount: Micro; asset_id: string }[] = []

  /** Set to make the next invoice() calls throw, as a wallet that cannot reach its indexer would. */
  failing: string | null = null

  invoice(amount: Micro, assetId: string): { invoice: string; recipient_id: string } {
    if (this.failing) throw new Error(this.failing)
    const recipient_id = `memory-fee-${++this.n}`
    this.issued.push({ recipient_id, amount, asset_id: assetId })
    return { invoice: `rgb:memory/${recipient_id}/${amount}`, recipient_id }
  }

  /** What the lender's payment would look like once settled. */
  settle(recipientId: string, assetId: string, amount: Micro, txid: Hex): void {
    this.receives.set(recipientId, { recipient_id: recipientId, status: 'Settled', txid, amount, asset_id: assetId })
  }

  receive(recipientId: string, assetId: string): FeeReceive | null {
    const r = this.receives.get(recipientId)
    if (!r) return null
    return { recipient_id: r.recipient_id, status: r.status, txid: r.txid, amount: r.asset_id === assetId ? r.amount : 0 }
  }
}

/**
 * The platform's own RGB wallet for fees, from a mnemonic derived from the platform key
 * (recoverable from it, unrelated to any other wallet). Witness receives need no
 * colorable UTXO, so it needs no BTC. Imported on demand: the fake-chain server never
 * loads the rgb-lib binding.
 */
/**
 * The fee wallet's RGB network and endpoints on a public test network (Mutinynet): the deployment profile's, so the
 * platform invoices fees there. Undefined on regtest: the wallet keeps rgbConfigFromEnv(), exactly as before.
 */
export function feeWalletRgbConfig(deployment: Pick<PassbookConfig, 'network'> | null | undefined = deploymentConfigFromEnv()): RgbConfig | undefined {
  const net = deployment?.network
  if (!net?.public) return undefined
  return { network: net.rgbNetwork, indexerUrl: net.endpoints.rgb_indexer, transportEndpoint: net.endpoints.rgb_proxy }
}

export async function rgbFeeWallet(platformKey: KeyPair, dataDir: string, rgb: RgbConfig | undefined = feeWalletRgbConfig()): Promise<FeeWallet> {
  const [{ RgbWallet }, { sha256 }, { concatBytes, utf8ToBytes }, { entropyToMnemonic }, { wordlist }] = await Promise.all([
    import('../rgb/wallet.js'),
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/utils.js'),
    import('@scure/bip39'),
    import('@scure/bip39/wordlists/english.js'),
  ])
  const entropy = sha256(concatBytes(utf8ToBytes('passbook/platform-fee-wallet/v1'), platformKey.secretKey)).slice(0, 16)
  const wallet = await RgbWallet.open(entropyToMnemonic(entropy, wordlist), dataDir, ...(rgb ? [rgb] : []))
  return {
    invoice: (amount, assetId, durationSeconds) => {
      const inv = wallet.invoice(amount, assetId, durationSeconds)
      return { invoice: inv.invoice, recipient_id: inv.recipientId, expires_at: inv.expirationTimestamp }
    },
    receive: (recipientId, assetId) => {
      // one refresh fetches and validates the consignment, the next settles it once the witness confirms
      let last: FeeReceive | null = null
      for (let i = 0; i < 4; i++) {
        wallet.refresh()
        const ofAsset = wallet.transfers(assetId).find((t) => t.recipientId === recipientId && t.kind === 'ReceiveWitness')
        const any = ofAsset ?? wallet.transfers().find((t) => t.recipientId === recipientId)
        const r: FeeReceive | null = any ? { recipient_id: recipientId, status: any.status, txid: any.txid, amount: ofAsset ? ofAsset.amount : 0 } : null
        if (r?.status === 'Settled' || r?.status === 'Failed' || (r && last && r.status === last.status)) return r
        last = r
      }
      return last
    },
    close: () => wallet.close(),
  }
}
