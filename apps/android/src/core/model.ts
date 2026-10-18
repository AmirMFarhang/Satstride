// Which screen the phone shows, from the node's state: the dashboard phone's
// rules (web/app.js screenName) without its wire-event screens, which the thin
// client does not stream. The borrower's three stops take over the screen.

import type { Snapshot } from './client.js'

export type Tab = 'passbook' | 'wallet' | 'offers'
export type ScreenName = 'pair' | 'home' | 'wallet' | 'offers' | 'stop1' | 'stop2' | 'termsheet' | 'stop3' | 'page'

export interface UiState {
  tab: Tab
  /** loan_id of a page opened from the list */
  page: string | null
  /** the full term sheet, opened from stop 2 */
  termsheet: boolean
}

export interface Waiting {
  waiting: 'next' | 'approve' | 'confirm' | null
  stop?: string
  loan_id?: string
  lender_pk?: string
  [k: string]: unknown
}

export interface Page {
  loan_id: string
  open_height: number
  maturity_height: number
  principal: number
  fee: number
  collateral_sats: number
  ltv_bps: number
  status: string
  outcome: string
  verified: { lock: boolean; close: boolean; terms_commitment?: boolean; collateral_amount?: boolean; chain_link?: boolean }
  lock_txid?: string
  close_txid?: string
  repayment_txid?: string
  returned_sats?: number
  headroom?: { state: string; margin_call_price_cents: number; liquidation_price_cents: number; drop_to_margin_call_bps: number; drop_to_liquidation_bps: number }
  cure_until_height?: number
}

export const waitingOf = (s: Snapshot | null): Waiting | null => {
  const w = s?.demo?.waiting as Waiting | undefined
  return w && w.waiting ? w : null
}

/** Only the borrower's own stops; lender approvals, checker approvals and fees belong to other people. */
export function borrowerStop(w: Waiting | null): 'stop1' | 'stop2' | 'stop3' | null {
  if (w?.waiting === 'approve') return 'stop1'
  if (w?.waiting === 'confirm' && w.stop === 'accept') return 'stop2'
  if (w?.waiting === 'confirm' && w.stop === 'repay') return 'stop3'
  return null
}

export function screenName(paired: boolean, s: Snapshot | null, ui: UiState): ScreenName {
  if (!paired) return 'pair'
  const stop = borrowerStop(waitingOf(s))
  if (stop === 'stop2' && ui.termsheet) return 'termsheet'
  if (stop) return stop
  if (ui.page) return 'page'
  if (ui.tab === 'wallet') return 'wallet'
  if (ui.tab === 'offers') return 'offers'
  return 'home'
}

export const pagesOf = (s: Snapshot | null): Page[] => ((s?.passbook?.pages as Page[] | undefined) ?? [])
export const openPage = (s: Snapshot | null): Page | undefined => pagesOf(s).find((p) => p.outcome === 'open' && p.status !== 'pending')
export const pageNo = (s: Snapshot | null, p: Page): number => pagesOf(s).indexOf(p) + 1
export const priceOf = (s: Snapshot | null): number => Number(s?.passbook?.price_cents ?? s?.state?.price_cents ?? 0)
export const heightOf = (s: Snapshot | null): number => Number(s?.state?.height ?? 0)
export const allowedBps = (s: Snapshot | null): number => Number((s?.passbook?.ladder as { allowed_ltv_bps?: number } | undefined)?.allowed_ltv_bps ?? 5000)
export const ladderBps = (s: Snapshot | null): number[] => (s?.passbook?.ladder_bps as number[] | undefined) ?? [5000, 5500, 6000, 6500]
export const ladderStep = (s: Snapshot | null): number => Number((s?.passbook?.ladder as { step?: number } | undefined)?.step ?? 0)

/** A lender's display name, as the dashboard writes it. */
export function lenderName(s: Snapshot | null, pk: unknown): string {
  const lenders = (s?.demo?.lenders as Record<string, string> | undefined) ?? {}
  return typeof pk === 'string' && pk ? lenders[pk] ?? `Lender ${pk.slice(0, 6)}` : 'the lender'
}

export function lenderOf(s: Snapshot | null, p: Page): string | undefined {
  const loans = (s?.state?.loans as { id: string; lender_pk?: string; terms?: { lender_pk?: string } }[] | undefined) ?? []
  const loan = loans.find((l) => l.id === p.loan_id)
  return loan?.lender_pk ?? loan?.terms?.lender_pk
}

/** The dashboard's figure: free bitcoin at the earned limit, rounded down to whole dollars. */
export function borrowable(s: Snapshot | null): number {
  const free = Number(s?.wallet?.btc_free_sats ?? 0)
  return Math.floor((Math.round((free * priceOf(s)) / 1e8) * allowedBps(s)) / 10_000 / 100)
}

/** Loans the node has on record for this borrower, newest first: id, status, principal. */
export function loanStatuses(s: Snapshot | null, borrowerPk: string): { id: string; status: string; principal: number }[] {
  const loans = (s?.state?.loans as { id: string; status: string; borrower_pk?: string; principal: number; terms?: { borrower_pk?: string; principal?: number } }[] | undefined) ?? []
  return loans.filter((l) => (l.borrower_pk ?? l.terms?.borrower_pk) === borrowerPk).map((l) => ({ id: l.id, status: l.status, principal: l.principal ?? l.terms?.principal ?? 0 })).reverse()
}
