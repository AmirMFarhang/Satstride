import { hashObject, verifyHash, type Hex } from '../core/crypto.js'
import type { Bundle, HistoryRow } from './types.js'

export type IncomeTier = 1 | 2 | 3 | 'out'
export interface TierProposal { payer_pk: Hex; tier: IncomeTier }
export interface IncomeTierOptions {
  currentHeight: number
  blocksPerMonth: number
  months: number
  reconciliationVerified: boolean
  verifiedCounterpartyPks?: Set<Hex>
  excludedPayers?: Set<Hex>
  excludedTxids?: Set<Hex>
  knownLenders?: Set<Hex>
  /** A code-confirmed irregular_genuine finding's independent payer cohort. */
  irregularPayers?: Set<Hex>
  proposals?: TierProposal[]
}
export interface TieredPayer { payer_pk: Hex; tier: IncomeTier; haircut_bps: number; gross_micro: number; counted_micro: number; reason: string }
export interface IncomeTiers { payers: TieredPayer[]; monthly_counted_micro: number[]; median_monthly_micro: number; rejected_proposals: number }
const workMemo = /\b(invoice|retainer|design|development|consulting|freelanc\w*|client|project|service|salary|payroll|wages)\b/i
const excludedMemo = /\b(loan|borrow(?:ed)?|repay\w*|refund|gift|donation|dinner|reimburs\w*|starting wallet funds|working capital)\b/i
export const excludedIncomeMemo = (memo: string): boolean => excludedMemo.test(memo)
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b), m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : Number((BigInt(v[m - 1]) + BigInt(v[m])) / 2n) }
const add = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n)) throw new RangeError('income evidence exceeds safe arithmetic capacity'); return n }

/** All amounts, recurrence tests and haircuts come from verified rows, never proposals. */
export function tierIncomeEvidence(bundle: Bundle, opts: IncomeTierOptions): IncomeTiers {
  if (!Number.isInteger(opts.blocksPerMonth) || opts.blocksPerMonth <= 0 || !Number.isInteger(opts.months) || opts.months < 1 || opts.months > 120) throw new RangeError('invalid income window')
  if (bundle.history.some((r) => !Number.isSafeInteger(r.amount) || r.amount <= 0)) throw new RangeError('income evidence amount invalid')
  const own = new Set([bundle.borrower_pk, ...bundle.own_pks])
  const incoming = bundle.history.filter((r) => r.direction === 'in' && r.height <= opts.currentHeight && opts.currentHeight - r.height < opts.months * opts.blocksPerMonth)
  const payers: TieredPayer[] = [], monthly = new Array<number>(opts.months).fill(0)
  const validSigned = new Set(bundle.candidate_inflows.filter((c) => bundle.history.some((r) => r.txid === c.txid && r.direction === 'in' && r.height === c.height && r.amount === c.amount && r.counterparty_pk === c.payer_pk) && verifyHash(c.payer_sig, hashObject({ txid: c.txid, amount: c.amount, borrower_pk: bundle.borrower_pk }), c.payer_pk)).map((c) => c.txid))
  const isLoop = (pk: Hex, rows: HistoryRow[]) => {
    const gross = rows.reduce((s, r) => add(s, r.amount), 0)
    const direct = bundle.history.filter((r) => r.direction === 'out' && r.counterparty_pk === pk && rows.some((inflow) => Math.abs(inflow.height - r.height) <= opts.blocksPerMonth)).reduce((s, r) => add(s, r.amount), 0)
    const prefundedMonths = new Set(rows.filter((i) => bundle.history.some((o) => o.direction === 'out' && !own.has(o.counterparty_pk) && o.counterparty_pk !== pk && o.height < i.height && i.height - o.height <= 5 && BigInt(Math.abs(o.amount - i.amount)) * 100n <= BigInt(i.amount) * 5n)).map((i) => Math.floor((opts.currentHeight - i.height) / opts.blocksPerMonth)))
    return BigInt(direct) * 2n >= BigInt(gross) || prefundedMonths.size >= 2
  }
  for (const pk of new Set(incoming.map((r) => r.counterparty_pk))) {
    const rows = incoming.filter((r) => r.counterparty_pk === pk)
    let tier: IncomeTier = 'out', reason = 'INSUFFICIENT_INCOME_EVIDENCE'
    if (!opts.reconciliationVerified) reason = 'HISTORY_NOT_RECONCILED'
    else if (pk === '00'.repeat(32)) reason = 'COUNTERPARTY_IDENTITY_UNKNOWN'
    else if (own.has(pk)) reason = 'SELF_TRANSFER'
    else if (opts.excludedPayers?.has(pk) || opts.knownLenders?.has(pk) || rows.some((r) => opts.excludedTxids?.has(r.txid) || excludedIncomeMemo(r.memo))) reason = 'LOAN_GIFT_REFUND_OR_FLAGGED'
    else if (isLoop(pk, rows)) reason = 'CODE_CONFIRMED_LOOP'
    else if (rows.every((r) => validSigned.has(r.txid))) { tier = 1; reason = 'SIGNED_ANCHORED_INCOME' }
    else {
      const byMonth = new Map<number, HistoryRow[]>()
      for (const row of rows) { const month = Math.floor((opts.currentHeight - row.height) / opts.blocksPerMonth); byMonth.set(month, [...(byMonth.get(month) ?? []), row]) }
      const positions = rows.map((r) => ((r.height % opts.blocksPerMonth) + opts.blocksPerMonth) % opts.blocksPerMonth)
      const recurrence = byMonth.size >= 3 && [...byMonth.values()].every((r) => r.length === 1) && Math.max(...positions) - Math.min(...positions) <= Math.max(2, Math.floor(opts.blocksPerMonth / 5))
      if (!opts.verifiedCounterpartyPks?.has(pk)) reason = 'UNSIGNED_COUNTERPARTY_NOT_INDEPENDENTLY_IDENTIFIED'
      else if (recurrence) { tier = 2; reason = 'ESTABLISHED_RECURRING_UNSIGNED' }
      else if ((opts.irregularPayers?.size ?? 0) >= 3 && opts.irregularPayers?.has(pk) && rows.every((r) => workMemo.test(r.memo))) { tier = 3; reason = 'CONFIRMED_IRREGULAR_WORK' }
    }
    const haircut = tier === 1 ? 10000 : tier === 2 ? 7000 : tier === 3 ? 5000 : 0
    const gross = rows.reduce((s, r) => add(s, r.amount), 0)
    let counted = 0
    for (const row of rows) { const n = Number(BigInt(row.amount) * BigInt(haircut) / 10000n); counted = add(counted, n); const month = Math.floor((opts.currentHeight - row.height) / opts.blocksPerMonth); monthly[month] = add(monthly[month], n) }
    payers.push({ payer_pk: pk, tier, haircut_bps: haircut, gross_micro: gross, counted_micro: counted, reason })
  }
  return { payers, monthly_counted_micro: monthly, median_monthly_micro: median(monthly), rejected_proposals: (opts.proposals ?? []).filter((p) => payers.find((v) => v.payer_pk === p.payer_pk)?.tier !== p.tier).length }
}
