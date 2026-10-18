// The loan receipt: one signed file per loan, receipts/<loan_id>.json, that
// anyone can re-check against Bitcoin with `passbook check-loan <file>`. It
// holds the term sheet (whose hash is the loan id and the terms hash in the
// lock), the credit-check evidence digest, every human approval, the lock,
// the disbursement, the repayment proof (payment hash, preimage and leaf-E
// release, or the co-signed RGB receipt), the platform fee and the passbook
// page.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isConfirmed, opReturnPayload, type ChainClient } from '../chain/types.js'
import { hashObject, hexToBytes, isHex, sha256Hex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, type Economics } from '../core/economics.js'
import type { Bps, Micro } from '../core/money.js'
import { escrowFor, partiesOf } from '../escrow/escrow.js'
import { approvalStatus, type Approval } from '../market/approvals.js'
import { policyValid, type LenderPolicy } from '../market/policy.js'
import { termSheetHash, termSheetProblems, type TermSheet, type TermSheetEvidence } from '../market/termsheet.js'
import { platformFeeOf } from '../server/fees.js'
import { repaymentProven } from '../settlement/adapters.js'
import type { RepaymentEvidence } from '../settlement/types.js'
import type { PortablePage, RgbRepaymentReceipt } from './passbook-doc.js'
import { verifyLog, type LogEntry } from '../governance/log.js'

export type ReceiptRepayment =
  | { kind: 'ln-rln'; payment_hash: Hex; preimage: Hex; release_txid: Hex }
  | { kind: 'cosign-rgb'; receipt: RgbRepaymentReceipt; release_txid: Hex }

export interface LoanReceipt {
  v: 1
  kind: 'passbook-loan-receipt'
  /** termSheetHash(termsheet) = the terms hash committed in the lock's OP_RETURN */
  loan_id: Hex
  termsheet: TermSheet
  /** Must equal termsheet.scorer.evidence (the Compex envelope digest or the sandbox run record); null only for a v1 sheet, which predates the digest. */
  evidence: TermSheetEvidence | null
  approvals: Approval[]
  lock: { txid: Hex; vout: number }
  /** The RGB transfer's anchor; the receive itself is validated by the borrower's wallet. */
  disbursement: { txid: Hex } | null
  repayment: ReceiptRepayment | null
  fee: { amount: Micro; share_bps: Bps; invoice: string | null; status: 'fee_due' | 'fee_paid'; paid_txid?: Hex } | null
  passbook_page: PortablePage | null
  /** Optional: the issuer's decision-log entries for this loan (gate decisions, signatures, sanctions and scorer results) and the policy version that allowed it. */
  governance?: GovernanceLink
  /** The borrower or the lender, who assembled and signed the receipt. */
  issued_by: Hex
  issued_at: number
  sig: Hex
}

export interface GovernanceLink {
  /** The issuer node's gate key, which signs its decision log. */
  node_pk: Hex
  policy_version: number | null
  entries: { seq: number; hash: Hex; kind: string; action_id: string | null }[]
  /** The log head when the receipt was assembled. */
  log_head: Hex | null
}

/** The receipt's link to a node's decision log: every entry about this loan. */
export function governanceLink(log: LogEntry[], loanId: Hex): GovernanceLink | undefined {
  const actions = new Set(log.filter((e) => e.loan_id === loanId && e.action_id).map((e) => e.action_id))
  const mine = log.filter((e) => e.loan_id === loanId || (e.action_id !== null && actions.has(e.action_id)))
  if (!mine.length) return undefined
  const allowed = mine.find((e) => e.kind === 'gate-decision' && e.result === 'allow')
  return { node_pk: mine[0].node_pk, policy_version: allowed?.policy_version ?? null, entries: mine.map((e) => ({ seq: e.seq, hash: e.hash, kind: e.kind, action_id: e.action_id })), log_head: log.at(-1)?.hash ?? null }
}

/** Problems with a receipt's governance link against the node's full log; empty when every linked entry is in an intact log. */
export function governanceLinkProblems(link: GovernanceLink, log: LogEntry[]): string[] {
  const problems = verifyLog(log, link.node_pk)
  for (const e of link.entries) if (log[e.seq]?.hash !== e.hash) problems.push(`linked entry #${e.seq} is not in this log`)
  if (link.log_head && !log.some((e) => e.hash === link.log_head)) problems.push('log head at issue is not in this log')
  return problems
}

export function assembleLoanReceipt(signer: KeyPair, input: Omit<LoanReceipt, 'v' | 'kind' | 'loan_id' | 'evidence' | 'issued_by' | 'sig'>): LoanReceipt {
  return signObject({ v: 1 as const, kind: 'passbook-loan-receipt' as const, loan_id: termSheetHash(input.termsheet), evidence: input.termsheet.scorer.evidence ?? null, issued_by: signer.pubkey, ...input }, signer.secretKey)
}

export function receiptPath(dir: string, loanId: Hex): string {
  if (!isHex(loanId, 32)) throw new Error('loan id must be 32-byte hex')
  return join(dir, `${loanId}.json`)
}

export function writeLoanReceipt(dir: string, receipt: LoanReceipt): string {
  mkdirSync(dir, { recursive: true })
  const path = receiptPath(dir, receipt.loan_id)
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`)
  return path
}

export function readLoanReceipt(path: string): LoanReceipt {
  return JSON.parse(readFileSync(path, 'utf8')) as LoanReceipt
}

export interface ReceiptCheck { id: string; ok: boolean; detail: string }

function repaymentEvidence(r: ReceiptRepayment): RepaymentEvidence {
  return r.kind === 'ln-rln' ? { kind: 'ln-rln', preimage: r.preimage } : { kind: 'cosign-rgb', receipt: r.receipt }
}

/** Every check that can be made from the file and a Bitcoin client; ok only when all pass. */
export async function checkLoanReceipt(r: LoanReceipt, chain: ChainClient, ctx: { lenderPolicy?: LenderPolicy; deploymentMakerCheckerMicro: Micro; economics?: Economics; decisionLog?: LogEntry[] }): Promise<{ ok: boolean; checks: ReceiptCheck[] }> {
  const checks: ReceiptCheck[] = []
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail })
  if (!r || r.v !== 1 || r.kind !== 'passbook-loan-receipt' || !r.termsheet?.terms) return { ok: false, checks: [{ id: 'format', ok: false, detail: 'not a v1 Passbook loan receipt' }] }
  const sheet = r.termsheet
  const t = sheet.terms
  const economics = ctx.economics ?? DEFAULT_ECONOMICS
  check('receipt-signature', [t.borrower_pk, t.lender_pk].includes(r.issued_by) && verifyObject(r, r.issued_by), r.issued_by === t.borrower_pk ? 'signed by the borrower' : r.issued_by === t.lender_pk ? 'signed by the lender' : 'signed by neither party')

  let loanId: Hex | null = null
  try { loanId = termSheetHash(sheet) } catch { /* reported below */ }
  const sheetProblems = termSheetProblems(sheet, { requireSignatures: true, economics })
  check('termsheet', !!loanId && loanId === r.loan_id && sheetProblems.length === 0, sheetProblems.length ? sheetProblems.slice(0, 3).join('; ') : loanId === r.loan_id ? 'signed by both agents; its hash is the loan id' : 'loan id is not the term-sheet hash')
  check('evidence', hashObject(r.evidence ?? null) === hashObject(sheet.scorer.evidence ?? null), !r.evidence ? 'no evidence digest (v1 term sheet, issued before evidence binding)' : r.evidence.kind === 'compex-dsse' ? `Compex envelope ${r.evidence.envelope_sha256.slice(0, 12)}…, as named in the term sheet` : 'sandbox run record, as named in the term sheet')

  const policy = ctx.lenderPolicy
  if (policy && (!policyValid(policy) || policy.owner_pk !== t.lender_pk)) check('approvals', false, 'lender policy signature invalid or for another lender')
  else if (loanId) {
    const fallbackPolicy = { owner_pk: t.lender_pk, approval_rules: { approvers: [], maker_checker_above: ctx.deploymentMakerCheckerMicro } } as unknown as LenderPolicy
    const s = approvalStatus(sheet, r.approvals ?? [], policy ?? fallbackPolicy, ctx.deploymentMakerCheckerMicro)
    check('approvals', s.complete && s.problems.length === 0, `borrower ${s.borrower ? 'approved' : 'missing'}; lender approvers ${s.lender_approvers.length}/${s.required_lender_approvals}${policy ? '' : ' (no lender policy: only the lender key counts)'}${s.problems.length ? `; ${s.problems.join(', ')}` : ''}`)
  } else check('approvals', false, 'no valid term-sheet hash to approve')

  const lock = await chain.getTx(r.lock.txid)
  const out = lock?.outputs[r.lock.vout]
  check('lock', isConfirmed(lock) && !!loanId && lock.outputs.some((o) => opReturnPayload(o.script) === loanId) && out?.script === escrowFor(partiesOf(t)).script && out.value === t.collateral_sats, isConfirmed(lock) ? 'confirmed; OP_RETURN commits the loan id; output pays the derived escrow with the agreed collateral' : 'lock not confirmed')

  if (r.disbursement) {
    const d = await chain.getTx(r.disbursement.txid)
    check('disbursement', isConfirmed(d), isConfirmed(d) ? 'RGB transfer anchor confirmed (the receive is validated by the borrower’s wallet, not here)' : 'disbursement anchor not confirmed')
  }

  if (r.repayment) {
    const proven = await repaymentProven(t, repaymentEvidence(r.repayment), chain, { lock_txid: r.lock.txid, lock_vout: r.lock.vout, outcome_txid: r.repayment.release_txid })
    const hashOk = r.repayment.kind !== 'ln-rln' || (t.atomic_repayment?.payment_hash === r.repayment.payment_hash && isHex(r.repayment.preimage, 32) && sha256Hex(hexToBytes(r.repayment.preimage)) === r.repayment.payment_hash)
    check('repayment', proven.ok && hashOk, !hashOk ? 'payment hash or preimage does not match the terms' : proven.ok ? `${proven.assurance === 'bitcoin_hashlock' ? 'leaf-E spend reveals the committed preimage' : 'co-signed RGB receipt and release'} at height ${proven.repaid_height}` : proven.reason)
  }

  if (r.fee) {
    const want = platformFeeOf(t, economics)
    let paidOk = r.fee.status !== 'fee_paid'
    if (r.fee.status === 'fee_paid') paidOk = !!r.fee.paid_txid && isConfirmed(await chain.getTx(r.fee.paid_txid))
    check('platform-fee', r.fee.amount === want && r.fee.share_bps === economics.platform_share_bps && paidOk, `${r.fee.status}: ${r.fee.amount} of ${want} expected (${economics.platform_share_bps} bps of the term interest)${r.fee.status === 'fee_paid' ? (paidOk ? '; payment anchor confirmed' : '; payment anchor not confirmed') : ''}`)
  }

  if (r.passbook_page) {
    const p = r.passbook_page
    const outcomeOk = !r.repayment || (p.outcome === 'repaid' && p.outcome_txid === r.repayment.release_txid && (r.repayment.kind !== 'ln-rln' || (p.repayment?.kind === 'atomic' && p.repayment.preimage === r.repayment.preimage)))
    check('passbook-page', hashObject(p.terms) === hashObject(t) && p.lock_txid === r.lock.txid && p.lock_vout === r.lock.vout && outcomeOk, 'the page carries these terms, this lock and this outcome')
  }
  if (r.governance) {
    const g = r.governance
    if (!ctx.decisionLog) check('governance', true, `links ${g.entries.length} decision-log entries (policy version ${g.policy_version ?? 'none'}); supply the node's log to verify them`)
    else { const problems = governanceLinkProblems(g, ctx.decisionLog); check('governance', problems.length === 0, problems.length ? problems.slice(0, 3).join('; ') : `${g.entries.length} linked entries in an intact, node-signed log; policy version ${g.policy_version ?? 'none'}`) }
  }
  return { ok: checks.every((c) => c.ok), checks }
}
