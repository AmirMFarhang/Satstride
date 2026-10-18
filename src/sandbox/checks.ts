// The deterministic checks. Each one computes its answer in code; the model is
// consulted only inside `categorise` (ambiguous rows) and `disclosure` (which
// items to reveal), and both of those are re-verified by code afterwards.

import { INJECTION, LOAN_MEMO, RuleReasoner } from '../ai/rule-reasoner.js'
import { CATEGORIES, type CategoriseRow, type Category, type DiscloseInput, type Reasoner } from '../ai/types.js'
import { isConfirmed, type ChainClient } from '../chain/types.js'
import { hashObject, verifyHash, type Hex } from '../core/crypto.js'
import { ltvBps, type Bps, type Micro } from '../core/money.js'
import { verifyQuote } from '../oracle/oracle.js'
import { headroom } from '../registry/ladder.js'
import type { Bundle, CandidateInflow, CheckResult, DisclosureItem, HistoryRow } from './types.js'

export interface CheckDeps {
  chain: ChainClient
  reasoner: Reasoner
  blocksPerMonth: number
  currentHeight: number
  /** when set, the oracle quote in the bundle must be from this key */
  oraclePk?: Hex
}

// ---- injection ----

export function injectionCheck(bundle: Bundle): { check: CheckResult; redacted: Bundle } {
  let hits = 0
  const clean = (s: string) => {
    if (INJECTION.test(s)) {
      hits += 1
      return '[redacted]'
    }
    return s
  }
  const redacted: Bundle = {
    ...bundle,
    offer_id: clean(bundle.offer_id),
    history: bundle.history.map((r) => ({ ...r, memo: clean(r.memo) })),
    scheduled_outflows: bundle.scheduled_outflows.map((s) => ({ ...s, label: clean(s.label) })),
  }
  return {
    check: { id: 'injection', ok: hits === 0, detail: hits === 0 ? 'no instructions aimed at software found' : `${hits} text field(s) contained instructions aimed at software and were redacted before any model call` },
    redacted,
  }
}

// ---- categorise ----

export interface Categorised {
  rows: { row: HistoryRow; category: Category; confidence: number; byModel: boolean }[]
  counts: Record<Category, number>
  historyMonths: number
  incomeMonthlyMedian: Micro
  fixedOutflowsMonthly: Micro
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2)
}

/** A counterparty is periodic when it has 3+ transfers in one direction with intervals within 25% of their median. */
function periodicCounterparties(history: HistoryRow[]): Set<string> {
  const groups = new Map<string, number[]>()
  for (const r of history) {
    const k = `${r.direction}:${r.counterparty_pk}`
    groups.set(k, [...(groups.get(k) ?? []), r.height])
  }
  const out = new Set<string>()
  for (const [k, heights] of groups) {
    if (heights.length < 3) continue
    const hs = [...heights].sort((a, b) => a - b)
    const gaps = hs.slice(1).map((h, i) => h - hs[i])
    const med = median(gaps)
    if (med > 0 && gaps.every((g) => Math.abs(g - med) <= med * 0.25)) out.add(k)
  }
  return out
}

export async function categoriseCheck(bundle: Bundle, deps: CheckDeps): Promise<{ check: CheckResult; data: Categorised }> {
  const own = new Set(bundle.own_pks)
  const periodic = periodicCounterparties(bundle.history)
  const hinted: CategoriseRow[] = bundle.history.map((r) => ({
    txid: r.txid,
    direction: r.direction,
    amount: r.amount,
    height: r.height,
    counterparty_pk: r.counterparty_pk,
    memo: r.memo,
    hints: [...(own.has(r.counterparty_pk) ? ['self'] : []), ...(periodic.has(`${r.direction}:${r.counterparty_pk}`) ? ['periodic'] : [])],
  }))
  // Rules label what they are sure about; the model gets the rest.
  const sure = new Map<string, { category: Category; confidence: number }>()
  const ambiguous: CategoriseRow[] = []
  for (const r of hinted) {
    if (r.hints.includes('self')) sure.set(r.txid, { category: 'transfer_self', confidence: 0.95 })
    // a periodic row labelled as a loan flow (a lender disbursing every run) is not income; the model or the rules label it
    else if (r.hints.includes('periodic') && !LOAN_MEMO.test(r.memo)) sure.set(r.txid, { category: r.direction === 'in' ? 'income' : 'rent_or_fixed_bill', confidence: 0.85 })
    else ambiguous.push(r)
  }
  const modelled = ambiguous.length ? await deps.reasoner.categorise(ambiguous) : { rows: [] }
  const byModel = new Map(modelled.rows.map((m) => [m.txid, m]))
  const rows = bundle.history.map((row) => {
    const s = sure.get(row.txid)
    if (s) return { row, ...s, byModel: false }
    const m = byModel.get(row.txid)
    return { row, category: m?.category ?? 'unknown', confidence: m?.confidence ?? 0, byModel: true }
  })
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
  for (const r of rows) counts[r.category] += 1

  const heights = bundle.history.map((r) => r.height)
  const minH = heights.length ? Math.min(...heights) : deps.currentHeight
  const historyMonths = Math.max(1, Math.ceil((deps.currentHeight - minH + 1) / deps.blocksPerMonth))
  const monthly = (cat: Category) => {
    const sums = new Array<number>(historyMonths).fill(0)
    for (const r of rows) {
      if (r.category !== cat) continue
      const idx = Math.min(historyMonths - 1, Math.floor((deps.currentHeight - r.row.height) / deps.blocksPerMonth))
      sums[idx] += r.row.amount
    }
    return median(sums)
  }
  const data: Categorised = { rows, counts, historyMonths, incomeMonthlyMedian: monthly('income'), fixedOutflowsMonthly: monthly('rent_or_fixed_bill') }
  const unknown = counts.unknown
  return {
    check: {
      id: 'categorise',
      ok: unknown <= Math.ceil(bundle.history.length * 0.25),
      detail: `${bundle.history.length} rows, ${ambiguous.length} sent to the model, ${unknown} left unknown, ${historyMonths} month(s) of history`,
    },
    data,
  }
}

// ---- affordability ----

export function affordabilityCheck(bundle: Bundle, cat: Categorised, deps: CheckDeps): { check: CheckResult; projected: Micro } {
  const repayment = bundle.loan_request.principal + bundle.loan_request.fee
  const windowBlocks = bundle.loan_request.term_blocks + bundle.loan_request.grace_blocks
  const months = windowBlocks / deps.blocksPerMonth
  const maturity = deps.currentHeight + bundle.loan_request.term_blocks
  let scheduled = 0
  for (const s of bundle.scheduled_outflows) {
    for (let h = s.next_height; h <= maturity && s.every_blocks > 0; h += s.every_blocks) scheduled += s.amount
    if (s.every_blocks <= 0 && s.next_height <= maturity) scheduled += s.amount
  }
  // The principal is assumed spent on whatever the borrower needed it for.
  const projected = Math.floor(bundle.balance + cat.incomeMonthlyMedian * months - cat.fixedOutflowsMonthly * months - scheduled)
  const needed = Math.ceil(repayment * 1.1)
  return {
    check: {
      id: 'affordability',
      ok: projected >= needed,
      detail: projected >= needed ? `projected balance at maturity covers the repayment with a 10% buffer` : `projected balance at maturity falls short of the repayment plus a 10% buffer`,
    },
    projected,
  }
}

// ---- headroom ----

export function headroomCheck(bundle: Bundle, deps: CheckDeps): { check: CheckResult; ltv: Bps } {
  const q = bundle.collateral.oracle_quote
  const quoteOk = verifyQuote(q, deps.oraclePk)
  const debt = bundle.loan_request.principal + bundle.loan_request.fee
  const h = headroom(debt, bundle.collateral.sats, q.price_cents)
  const ok = quoteOk && h.ltv_bps <= bundle.collateral.allowed_ltv_bps
  return {
    check: {
      id: 'headroom',
      ok,
      detail: !quoteOk
        ? 'oracle quote signature invalid'
        : `opens at ${(h.ltv_bps / 100).toFixed(1)}% LTV against ${(bundle.collateral.allowed_ltv_bps / 100).toFixed(1)}% allowed; BTC can fall ${(h.drop_to_margin_call_bps / 100).toFixed(1)}% before a margin call and ${(h.drop_to_liquidation_bps / 100).toFixed(1)}% before liquidation`,
    },
    ltv: ltvBps(debt, bundle.collateral.sats, q.price_cents),
  }
}

// ---- inflows ----

export interface VerifiedInflow extends CandidateInflow {
  month_index: number
}

export async function inflowsCheck(bundle: Bundle, deps: CheckDeps): Promise<{ check: CheckResult; verified: VerifiedInflow[]; rejected: { txid: Hex; reason: string }[] }> {
  const verified: VerifiedInflow[] = []
  const rejected: { txid: Hex; reason: string }[] = []
  for (const c of bundle.candidate_inflows) {
    const sigOk = verifyHash(c.payer_sig, hashObject({ txid: c.txid, amount: c.amount, borrower_pk: bundle.borrower_pk }), c.payer_pk)
    if (!sigOk) {
      rejected.push({ txid: c.txid, reason: 'payer signature invalid' })
      continue
    }
    const tx = await deps.chain.getTx(c.txid)
    if (!isConfirmed(tx)) {
      rejected.push({ txid: c.txid, reason: 'not confirmed on chain' })
      continue
    }
    if (tx.height > deps.currentHeight) {
      rejected.push({ txid: c.txid, reason: 'height in the future' })
      continue
    }
    verified.push({ ...c, height: tx.height, month_index: Math.floor((deps.currentHeight - tx.height) / deps.blocksPerMonth) })
  }
  const r = bundle.lender_requirements
  const repayment = bundle.loan_request.principal + bundle.loan_request.fee
  const { ok, months } = coverage(verified, r.inflow_months, Math.ceil((repayment * r.inflow_multiple_bps) / 10_000))
  // The fixed salary check deliberately cannot establish irregular freelance context.
  // The investigator may propose a broader payer pattern, confirmed separately in code.
  const regular = r.inflow_months === 0 || verified.some((candidate) => {
    const similar = verified.filter((row) => row.payer_pk === candidate.payer_pk && Math.abs(row.amount - candidate.amount) * 10000 <= candidate.amount * 500)
    return coverage(similar, r.inflow_months, 0).ok
  })
  return {
    check: {
      id: 'inflows',
      ok: ok && regular,
      detail: `${verified.length} verified payer-signed inflow(s) covering ${months} of ${r.inflow_months} required month(s); ${rejected.length} rejected${regular ? '' : '; no recurring salary-shaped payer in every required month'}`,
    },
    verified,
    rejected,
  }
}

export function coverage(items: { amount: Micro; month_index: number }[], monthsRequired: number, sumRequired: Micro): { ok: boolean; months: number; sum: Micro } {
  const months = new Set(items.filter((i) => i.month_index < monthsRequired).map((i) => i.month_index)).size
  const sum = items.reduce((s, i) => s + i.amount, 0)
  return { ok: months >= monthsRequired && sum >= sumRequired, months, sum }
}

// ---- sybil ----

/**
 * A payer whose inflow is mostly returned to it (directly, or through one of the
 * borrower's own keys) within the window is a loop, not income. Only the
 * borrower's own history is visible here, so this catches self-funding, not
 * collusion among strangers; the lender's graph check covers the rest.
 */
export function sybilCheck(bundle: Bundle, verified: VerifiedInflow[], deps: CheckDeps): { check: CheckResult; clean: VerifiedInflow[]; flagged: { payer_pk: Hex; returned_bps: Bps }[] } {
  const own = new Set(bundle.own_pks)
  const window = deps.blocksPerMonth
  const flagged: { payer_pk: Hex; returned_bps: Bps }[] = []
  const byPayer = new Map<Hex, VerifiedInflow[]>()
  for (const v of verified) byPayer.set(v.payer_pk, [...(byPayer.get(v.payer_pk) ?? []), v])
  for (const [payer, inflows] of byPayer) {
    const inSum = inflows.reduce((s, i) => s + i.amount, 0)
    const lo = Math.min(...inflows.map((i) => i.height)) - window
    const hi = Math.max(...inflows.map((i) => i.height)) + window
    const returned = bundle.history
      .filter((r) => r.direction === 'out' && r.height >= lo && r.height <= hi && (r.counterparty_pk === payer || own.has(r.counterparty_pk)))
      .reduce((s, r) => s + r.amount, 0)
    const bps = Math.floor((returned * 10_000) / inSum)
    if (bps >= 5000) flagged.push({ payer_pk: payer, returned_bps: bps })
  }
  const flaggedSet = new Set(flagged.map((f) => f.payer_pk))
  return {
    check: { id: 'sybil', ok: flagged.length === 0, detail: flagged.length === 0 ? 'no inflow loops back to its payer' : `${flagged.length} payer(s) excluded: most of their inflow returned to them within a month` },
    clean: verified.filter((v) => !flaggedSet.has(v.payer_pk)),
    flagged,
  }
}

// ---- disclosure ----

export async function disclosureCheck(bundle: Bundle, clean: VerifiedInflow[], deps: CheckDeps): Promise<{ check: CheckResult; proposal: DisclosureItem[] }> {
  const r = bundle.lender_requirements
  const repayment = bundle.loan_request.principal + bundle.loan_request.fee
  const sumRequired = Math.ceil((repayment * r.inflow_multiple_bps) / 10_000)
  const input: DiscloseInput = {
    requirement: { inflow_months: r.inflow_months, inflow_multiple_bps: r.inflow_multiple_bps, repayment },
    candidates: clean.map((c) => ({ txid: c.txid, amount: c.amount, height: c.height, payer_pk: c.payer_pk, month_index: c.month_index })),
  }
  let out = await deps.reasoner.disclose(input)
  let selected = clean.filter((c) => out.selected_txids.includes(c.txid))
  let verdict = coverage(selected, r.inflow_months, sumRequired)
  const full = coverage(clean, r.inflow_months, sumRequired)
  let note = ''
  if (!verdict.ok && full.ok) {
    out = await new RuleReasoner().disclose(input)
    selected = clean.filter((c) => out.selected_txids.includes(c.txid))
    verdict = coverage(selected, r.inflow_months, sumRequired)
    note = '; model proposal did not satisfy the requirement, replaced by the rule-based minimum'
  }
  const proposal: DisclosureItem[] = selected.map((c) => ({ txid: c.txid, amount: c.amount, height: c.height, payer_pk: c.payer_pk, reason: out.reason }))
  return {
    check: {
      id: 'disclosure',
      ok: verdict.ok,
      detail: verdict.ok ? `${selected.length} of ${clean.length} eligible inflow(s) proposed; the rest stay private${note}` : `eligible inflows cannot satisfy the lender's requirement${note}`,
    },
    proposal,
  }
}
