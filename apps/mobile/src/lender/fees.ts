// What the lender pays at close: one platform fee over RGB, as before, whose amount is the
// platform's share of the interest plus the credit checks billed to this lender at close
// (lane E2: FeeRecord.share_amount and check_fees). The phone pays only an amount it can
// account for: every charged check must be one this phone asked for, at the price its
// operator signed, and the parts must add up to the total. Code decides; nothing is rounded.
import type { Hex } from '../../../../src/core/crypto.js'
import { usdt } from '../../../../src/core/money.js'
import type { FeeRecord } from '../../../../src/server/fees.js'

/** One billed check as the platform lists it on a fee (E2's FeeRecord.check_fees, ChargedCheckFee). */
export interface ChargedCheck { bill_hash: Hex; negotiation_id: Hex; operator_pk: Hex; commitment?: Hex; asset_id: string; amount: number; linked_by?: string }

/** A fee record with E2's optional fields (absent on a platform without billed checks). */
export type CloseFeeRecord = Omit<FeeRecord, 'share_amount' | 'check_fees'> & { share_amount?: number; check_fees?: ChargedCheck[] }

/** A bill this phone holds (CheckRecord.bill), by hash, with the borrower whose check it was. */
export interface HeldBill { bill_hash: Hex; negotiation_id: Hex; borrower_pk?: Hex; operator_pk: Hex; asset_id: string; amount: number }

export interface CloseFees {
  /** the platform's share of the interest */
  share: number
  /** the billed checks charged on this fee */
  checks: ChargedCheck[]
  checks_total: number
  /** what is paid: share + checks */
  total: number
  /** bills this phone holds for this loan's negotiation that the platform did not add (it charges nothing for them) */
  not_charged: HeldBill[]
  /** why this fee must not be paid as it stands; empty when it adds up */
  problems: string[]
}

/**
 * The fee's parts, checked against the bills this phone holds. `loan.borrower_pk`: the borrower of the loan this fee
 * closes; a charged bill must be from a check of that borrower (the platform's own link: same lender, borrower and
 * asset), so a bill from another borrower's negotiation is refused. `loan.own`: this loan's negotiation's bills.
 */
export function closeFees(f: CloseFeeRecord, held: HeldBill[], loan: { borrower_pk?: Hex | null; own?: HeldBill[] } = {}): CloseFees {
  const ownBills = loan.own ?? []
  const problems: string[] = []
  const checks = Array.isArray(f.check_fees) ? f.check_fees : []
  const checksTotal = checks.reduce((s, c) => s + (Number.isSafeInteger(c.amount) && c.amount >= 0 ? c.amount : NaN), 0)
  if (!Number.isFinite(checksTotal)) problems.push('a charged check has no valid amount')
  const share = f.share_amount ?? (checks.length ? NaN : f.amount)
  if (!Number.isSafeInteger(share) || share < 0) problems.push('the platform lists checks but not its own share')
  else if (Number.isFinite(checksTotal) && share + checksTotal !== f.amount) problems.push(`the fee ${usdt(f.amount)} is not the share ${usdt(share)} plus the checks ${usdt(checksTotal)}`)
  const byHash = new Map(held.map((b) => [b.bill_hash, b]))
  const seen = new Set<string>()
  for (const c of checks) {
    if (seen.has(c.bill_hash)) { problems.push(`check ${c.bill_hash.slice(0, 12)}… charged twice`); continue }
    seen.add(c.bill_hash)
    const b = byHash.get(c.bill_hash)
    if (!b) problems.push(`the platform charges a check this phone never asked for (${c.bill_hash.slice(0, 12)}…)`)
    else if (b.amount !== c.amount || b.asset_id !== c.asset_id || b.operator_pk !== c.operator_pk || b.negotiation_id !== c.negotiation_id) problems.push(`check ${c.bill_hash.slice(0, 12)}… is charged at another price or by another node than its bill`)
    else if (!loan.borrower_pk || b.borrower_pk !== loan.borrower_pk) problems.push(`check ${c.bill_hash.slice(0, 12)}… was for ${b.borrower_pk ? 'another borrower' : 'a borrower this phone did not record'}, not this loan's`)
    if (c.asset_id !== f.asset_id) problems.push(`check ${c.bill_hash.slice(0, 12)}… is in another asset than the fee`)
  }
  const notCharged = ownBills.filter((b) => !seen.has(b.bill_hash))
  return { share: Number.isFinite(share) ? share : 0, checks, checks_total: Number.isFinite(checksTotal) ? checksTotal : 0, total: f.amount, not_charged: notCharged, problems }
}

/** The fee's lines for the screen, in test USDT. */
export function closeFeeLines(c: CloseFees, unit = 'test USDT'): { k: string; v: string }[] {
  const n = (m: number) => `${usdt(m).replace(/ ?USDT$/, '')} ${unit}`
  return [
    { k: 'Platform share of the interest', v: n(c.share) },
    ...c.checks.map((x) => ({ k: 'Credit check billed at close', v: n(x.amount) })),
    ...c.not_charged.map((x) => ({ k: 'Credit check (not charged by the platform)', v: n(x.amount) })),
    { k: 'You pay now', v: n(c.total) },
  ]
}
