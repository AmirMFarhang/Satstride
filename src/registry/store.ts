// The platform's registry. SQLite through node:sqlite (built into Node 22.13+),
// one file, no native module to download. It stores loan records, offers seen
// on the order book, oracle quotes, sandbox run digests (hashes and signatures
// only, never a bundle), platform fees owed by lenders (src/server/fees.ts) and
// the event wire the dashboard replays.

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Hex } from '../core/crypto.js'
import type { LoanTerms } from '../core/terms.js'
import type { WatchKeys } from '../rgb/watch.js'
import type { FeeRecord } from '../server/fees.js'

export type LoanStatus = 'pending' | 'locked' | 'open' | 'repaid' | 'defaulted' | 'liquidated' | 'refunded'

export interface LoanRecord {
  /** termsHash */
  id: Hex
  terms: LoanTerms
  status: LoanStatus
  lock_txid?: Hex
  /** index of the collateral output in the lock transaction */
  lock_vout?: number
  disbursement_txid?: Hex
  repayment_txid?: Hex
  /** what the platform accepts as proof that `repayment_txid` paid the lender */
  repayment_proof?: 'lender_ack' | 'rgb_consignment' | 'atomic_preimage' | 'portable_receipt'
  repayment_preimage?: Hex
  /** the repayment invoice the platform issued from its watch-only wallet on the lender's repayment account */
  repayment_watch?: WatchKeys & { invoice: string; recipient_id: string }
  release_txid?: Hex
  /** split, liquidation or refund transaction */
  settlement_txid?: Hex
  locked_height?: number
  funded_height?: number
  repaid_height?: number
  closed_height?: number
  margin_call_height?: number
  /**
   * The platform's share of the interest published when this loan was registered: the fee at
   * close is charged at this rate, whatever the platform publishes by then. Absent on loans
   * registered before the snapshot existed; those are charged at the share current at close.
   */
  platform_share_bps?: number
  created_at: number
  updated_at: number
}

export interface OfferRecord {
  id: string
  lender_pk: Hex
  event_id: string
  payload: unknown
  updated_at: number
}

export interface SandboxRunRecord {
  id: string
  borrower_pk: Hex
  bundle_hash: Hex
  result_hash: Hex
  sandbox_pk: Hex
  created_at: number
}

export interface WireEvent {
  seq?: number
  at: number
  type: string
  [k: string]: unknown
}

/** What callers pass to emit: the timestamp is filled in if missing. */
export interface NewWireEvent {
  type: string
  at?: number
  [k: string]: unknown
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  borrower_pk TEXT NOT NULL,
  lender_pk TEXT NOT NULL,
  status TEXT NOT NULL,
  open_height INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS loans_borrower ON loans(borrower_pk, open_height);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  lender_pk TEXT NOT NULL,
  event_id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oracle_quotes (
  height INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  sig TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_runs (
  id TEXT PRIMARY KEY,
  borrower_pk TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  sandbox_pk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_fees (
  loan_id TEXT PRIMARY KEY,
  lender_pk TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_fees_lender ON platform_fees(lender_pk, status);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  json TEXT NOT NULL
);
`

export class Store {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // ---- loans ----

  insertLoan(record: LoanRecord): void {
    this.db
      .prepare('INSERT INTO loans (id, borrower_pk, lender_pk, status, open_height, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.terms.borrower_pk, record.terms.lender_pk, record.status, record.terms.open_height, JSON.stringify(record), record.created_at, record.updated_at)
  }

  updateLoan(id: Hex, patch: Partial<Omit<LoanRecord, 'id' | 'terms' | 'created_at'>>): LoanRecord {
    const current = this.getLoan(id)
    if (!current) throw new Error(`unknown loan ${id.slice(0, 12)}`)
    const next: LoanRecord = { ...current, ...patch, updated_at: Date.now() }
    this.db.prepare('UPDATE loans SET status = ?, json = ?, updated_at = ? WHERE id = ?').run(next.status, JSON.stringify(next), next.updated_at, id)
    return next
  }

  getLoan(id: Hex): LoanRecord | undefined {
    const row = this.db.prepare('SELECT json FROM loans WHERE id = ?').get(id) as { json: string } | undefined
    return row ? (JSON.parse(row.json) as LoanRecord) : undefined
  }

  loansByBorrower(borrowerPk: Hex): LoanRecord[] {
    const rows = this.db.prepare('SELECT json FROM loans WHERE borrower_pk = ? ORDER BY open_height ASC').all(borrowerPk) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as LoanRecord)
  }

  loansByStatus(...statuses: LoanStatus[]): LoanRecord[] {
    if (statuses.length === 0) return []
    const marks = statuses.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT json FROM loans WHERE status IN (${marks}) ORDER BY open_height ASC`).all(...statuses) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as LoanRecord)
  }

  allLoans(): LoanRecord[] {
    const rows = this.db.prepare('SELECT json FROM loans ORDER BY created_at ASC').all() as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as LoanRecord)
  }

  // ---- offers ----

  upsertOffer(o: OfferRecord): void {
    this.db
      .prepare('INSERT INTO offers (id, lender_pk, event_id, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET event_id = excluded.event_id, json = excluded.json, updated_at = excluded.updated_at')
      .run(o.id, o.lender_pk, o.event_id, JSON.stringify(o.payload), o.updated_at)
  }

  deleteOffer(id: string): void {
    this.db.prepare('DELETE FROM offers WHERE id = ?').run(id)
  }

  listOffers(): OfferRecord[] {
    const rows = this.db.prepare('SELECT id, lender_pk, event_id, json, updated_at FROM offers ORDER BY updated_at DESC').all() as {
      id: string
      lender_pk: string
      event_id: string
      json: string
      updated_at: number
    }[]
    return rows.map((r) => ({ id: r.id, lender_pk: r.lender_pk, event_id: r.event_id, payload: JSON.parse(r.json), updated_at: r.updated_at }))
  }

  // ---- oracle ----

  recordQuote(height: number, priceCents: number, sig: Hex): void {
    this.db.prepare('INSERT INTO oracle_quotes (height, price_cents, sig, created_at) VALUES (?, ?, ?, ?)').run(height, priceCents, sig, Date.now())
  }

  // ---- sandbox ----

  recordSandboxRun(r: SandboxRunRecord): void {
    this.db
      .prepare('INSERT INTO sandbox_runs (id, borrower_pk, bundle_hash, result_hash, sandbox_pk, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.id, r.borrower_pk, r.bundle_hash, r.result_hash, r.sandbox_pk, r.created_at)
  }

  getSandboxRun(id: string): SandboxRunRecord | undefined {
    return this.db.prepare('SELECT * FROM sandbox_runs WHERE id = ?').get(id) as SandboxRunRecord | undefined
  }

  // ---- platform fees ----

  insertFee(fee: FeeRecord): void {
    this.db.prepare('INSERT INTO platform_fees (loan_id, lender_pk, status, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(fee.loan_id, fee.lender_pk, fee.status, JSON.stringify(fee), fee.created_at, fee.updated_at)
  }

  getFee(loanId: Hex): FeeRecord | undefined {
    const row = this.db.prepare('SELECT json FROM platform_fees WHERE loan_id = ?').get(loanId) as { json: string } | undefined
    return row ? (JSON.parse(row.json) as FeeRecord) : undefined
  }

  updateFee(loanId: Hex, patch: Partial<Omit<FeeRecord, 'loan_id' | 'lender_pk' | 'created_at'>>): FeeRecord {
    const current = this.getFee(loanId)
    if (!current) throw new Error(`no platform fee for loan ${loanId.slice(0, 12)}`)
    const next: FeeRecord = { ...current, ...patch, updated_at: Date.now() }
    this.db.prepare('UPDATE platform_fees SET status = ?, json = ?, updated_at = ? WHERE loan_id = ?').run(next.status, JSON.stringify(next), next.updated_at, loanId)
    return next
  }

  listFees(lenderPk?: Hex): FeeRecord[] {
    const rows = (lenderPk === undefined ? this.db.prepare('SELECT json FROM platform_fees ORDER BY created_at ASC').all() : this.db.prepare('SELECT json FROM platform_fees WHERE lender_pk = ? ORDER BY created_at ASC').all(lenderPk)) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as FeeRecord)
  }

  // ---- wire ----

  appendEvent(event: WireEvent): WireEvent {
    const { seq: _seq, ...rest } = event
    const result = this.db.prepare('INSERT INTO events (at, type, json) VALUES (?, ?, ?)').run(rest.at, rest.type, JSON.stringify(rest))
    return { ...rest, seq: Number(result.lastInsertRowid) }
  }

  listEvents(afterSeq = 0, limit = 1000): WireEvent[] {
    const rows = this.db.prepare('SELECT seq, json FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterSeq, limit) as { seq: number; json: string }[]
    return rows.map((r) => ({ ...(JSON.parse(r.json) as WireEvent), seq: r.seq }))
  }
}
