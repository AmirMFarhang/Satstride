// The standalone lender's platform fees (src/server/fees.ts): show what is due,
// ask the operator, pay from the lender's own USDT over RGB. Kept apart from
// peer.ts so the decisions can be tested without a chain.

import type { Hex } from '../core/crypto.js'
import { usdt } from '../core/money.js'
import { OUTSTANDING_FEE_MESSAGE, type FeeRecord } from '../server/fees.js'

/** What the peer CLI needs of a lender agent. */
export interface FeePayer {
  pubkey: Hex
  platform: { fees(lenderPk: Hex): Promise<{ height: number; fees: FeeRecord[]; blocked?: string | null }> }
  payPlatformFees(opts?: { loanId?: Hex }): Promise<FeeRecord[]>
}

/** The operator's answer to one question; false when declined. */
export type Confirm = (message: string) => Promise<boolean>

export function payFeesCommand(wallet: string, assetId: string): string {
  return `npm run peer -- --role lender --wallet ${wallet} --asset-id ${assetId} --pay-fees`
}

/**
 * Ask once for every due fee (or only `loanId`'s) and pay them if approved. Returns what was
 * paid and whether the lender is still blocked from publishing.
 */
export async function settlePlatformFees(lender: FeePayer, confirm: Confirm, opts: { loanId?: Hex } = {}): Promise<{ paid: FeeRecord[]; declined: boolean; blocked: string | null }> {
  const { height, fees, blocked } = await lender.platform.fees(lender.pubkey)
  const due = fees.filter((f) => f.status === 'fee_due' && (opts.loanId === undefined || f.loan_id === opts.loanId))
  if (!due.length) return { paid: [], declined: false, blocked: blocked ?? null }
  const total = due.reduce((s, f) => s + f.amount, 0)
  const lines = due.map((f) => `${usdt(f.amount)} (${f.share_bps / 100}% of ${usdt(f.interest)} interest) for loan ${f.loan_id.slice(0, 12)}, ${f.outcome.replaceAll('_', ' ')}, ${height > f.grace_until_height ? 'OVERDUE' : `due by block ${f.grace_until_height}`}`)
  const yes = await confirm(`Pay the platform ${usdt(total)} in fees from this lender's USDT over RGB? It can't be undone.\n  ${lines.join('\n  ')}`)
  if (!yes) return { paid: [], declined: true, blocked: blocked ?? null }
  const paid = await lender.payPlatformFees(opts.loanId === undefined ? {} : { loanId: opts.loanId })
  const after = await lender.platform.fees(lender.pubkey)
  return { paid, declined: false, blocked: after.blocked ?? null }
}

/** Before publishing: pay what is due if the operator approves; refuse, saying how to pay, if still blocked. */
export async function settleBeforePublishing(lender: FeePayer, confirm: Confirm, howToPay: string): Promise<FeeRecord[]> {
  const r = await settlePlatformFees(lender, confirm)
  if (r.blocked) throw new Error(`${OUTSTANDING_FEE_MESSAGE} ${r.declined ? 'Payment was declined.' : 'Some fees could not be paid yet.'} Pay them with: ${howToPay}`)
  return r.paid
}

/** After this run's loan closed: wait for its fee invoice (the borrower reports the release), then offer to pay it. */
export async function settleClosedLoan(lender: FeePayer, confirm: Confirm, loanId: Hex, opts: { timeoutMs: number; pollMs?: number }): Promise<{ paid: FeeRecord[]; invoiced: boolean }> {
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const fee = (await lender.platform.fees(lender.pubkey)).fees.find((f) => f.loan_id === loanId)
    if (fee) return { paid: fee.status === 'fee_due' ? (await settlePlatformFees(lender, confirm, { loanId })).paid : [], invoiced: true }
    if (Date.now() > deadline) return { paid: [], invoiced: false }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 1_000))
  }
}
