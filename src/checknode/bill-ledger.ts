// Where billed checks are kept on the provider laptop: a JSONL file of the
// operator-signed bills (bill.ts). The check node appends one before it hands
// over K; the platform reads them when a loan closes and adds each bill once to
// that lender's platform fee (src/server/fees.ts). Every bill is signed by the
// operator and checked again by the platform, so the file is a mailbox between
// two processes of one provider, not a source of trust. Laptop only (node:fs).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Hex } from '../core/crypto.js'
import { DEFAULT_BILL_TTL_SECONDS, DEFAULT_BILLS_PER_DAY, type BilledCheckReceipt } from './bill.js'
import type { CheckBilling } from './node.js'

export interface BillLedger {
  all(): BilledCheckReceipt[]
  append(bill: BilledCheckReceipt): void
  countSince(lenderPk: Hex, sinceUnix: number): number
}

export class FileBillLedger implements BillLedger {
  constructor(readonly path: string) {}
  all(): BilledCheckReceipt[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try { return [JSON.parse(line) as BilledCheckReceipt] } catch { return [] }
    })
  }
  append(bill: BilledCheckReceipt): void {
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, `${JSON.stringify(bill)}\n`, { mode: 0o600 })
  }
  countSince(lenderPk: Hex, sinceUnix: number): number {
    return this.all().filter((b) => b.lender_pk === lenderPk && b.issued_at >= sinceUnix).length
  }
}

/** For tests: the same ledger in memory. */
export class MemoryBillLedger implements BillLedger {
  readonly bills: BilledCheckReceipt[] = []
  all(): BilledCheckReceipt[] { return [...this.bills] }
  append(bill: BilledCheckReceipt): void { this.bills.push(bill) }
  countSince(lenderPk: Hex, sinceUnix: number): number { return this.bills.filter((b) => b.lender_pk === lenderPk && b.issued_at >= sinceUnix).length }
}

/** The platform's verdict on a lender's fees, from its public `GET /fees?lender=`: a reason when blocked, null when not. Throws when it can't tell. */
export function platformFeeGate(platformUrl: string, fetchImpl: typeof fetch = fetch): (lenderPk: Hex) => Promise<string | null> {
  const base = platformUrl.replace(/\/+$/, '')
  return async (lenderPk) => {
    const res = await fetchImpl(`${base}/fees?lender=${encodeURIComponent(lenderPk)}`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`platform fees: HTTP ${res.status}`)
    const body = await res.json() as { blocked?: unknown }
    if (!('blocked' in body) || (body.blocked !== null && typeof body.blocked !== 'string')) throw new Error('platform fees: no verdict for this lender')
    return body.blocked as string | null
  }
}

/** A node's billing from its options and the environment: PASSBOOK_CHECK_BILLS (the ledger) and PASSBOOK_URL (the platform). */
export function billingFromEnv(o: { maxPerDay?: number; ttlSeconds?: number; env?: NodeJS.ProcessEnv } = {}): CheckBilling {
  const env = o.env ?? process.env
  if (!env.PASSBOOK_CHECK_BILLS) throw new Error('BILL_NO_LEDGER: --bill-at-close needs PASSBOOK_CHECK_BILLS, the bill ledger the platform reads at close')
  if (!env.PASSBOOK_URL) throw new Error('BILL_NO_PLATFORM: --bill-at-close needs PASSBOOK_URL, to refuse lenders blocked for unpaid fees')
  const maxPerDay = o.maxPerDay ?? Number(env.PASSBOOK_CHECK_BILL_MAX_PER_DAY ?? DEFAULT_BILLS_PER_DAY)
  if (!Number.isSafeInteger(maxPerDay) || maxPerDay <= 0) throw new Error('BILL_RATE_LIMIT_CONFIG: max per day must be a positive safe integer')
  return {
    maxPerDay,
    ttlSeconds: o.ttlSeconds ?? DEFAULT_BILL_TTL_SECONDS,
    ledger: new FileBillLedger(env.PASSBOOK_CHECK_BILLS),
    feeGate: platformFeeGate(env.PASSBOOK_URL),
  }
}

/** What the platform charges from: the ledger and the operator keys whose bills it accepts. */
export interface CheckBillSource {
  bills(): BilledCheckReceipt[]
  operators: Hex[]
}

/** PASSBOOK_CHECK_BILLS and PASSBOOK_CHECK_BILL_OPERATORS, or null: without both, no check fee is charged. */
export function checkBillSourceFromEnv(env: NodeJS.ProcessEnv = process.env): CheckBillSource | null {
  const path = env.PASSBOOK_CHECK_BILLS
  const operators = (env.PASSBOOK_CHECK_BILL_OPERATORS ?? '').split(',').map((k) => k.trim()).filter((k) => /^[0-9a-f]{64}$/.test(k))
  if (!path || !operators.length) return null
  const ledger = new FileBillLedger(path)
  return { bills: () => ledger.all(), operators }
}
