// `passbook audit export <loan>`: one hash-chained file per loan with the
// negotiation messages, the term sheet, the human approvals, the scorer
// evidence (Compex envelope or sandbox-signed result) and, when present, the
// loan receipt. Each entry commits to its content and to the previous entry,
// and the export re-runs the checks that can be run offline.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashObject, type Hex } from '../core/crypto.js'
import type { Economics } from '../core/economics.js'
import type { Micro } from '../core/money.js'
import { approvalStatus, type Approval } from '../market/approvals.js'
import { verifyTranscript, type NegotiationMessage } from '../market/negotiate.js'
import { policyValid, type LenderPolicy } from '../market/policy.js'
import { termSheetHash, termSheetProblems, type TermSheet } from '../market/termsheet.js'
import { termSheetEvidenceProblems } from '../scorer/evidence-digest.js'
import type { ScorerOutcome } from '../scorer/types.js'
import { governanceLinkProblems, type LoanReceipt, type ReceiptCheck } from '../registry/receipt.js'
import { readLog, verifyLog, type LogEntry } from '../governance/log.js'

export interface AuditInputs {
  negotiation?: NegotiationMessage[]
  termsheet?: TermSheet
  approvals?: Approval[]
  scorer?: ScorerOutcome
  lender_policy?: LenderPolicy
  /** The loan receipt (src/registry/receipt.ts). */
  receipt?: LoanReceipt
  /** checkLoanReceipt's result against Bitcoin; without it the receipt is attached unverified and fails the check. */
  receipt_check?: { ok: boolean; checks: ReceiptCheck[] }
  /** A node's decision log (decision-log.jsonl): its entries about this loan are bundled and the chain re-checked. */
  decision_log?: LogEntry[]
  /** The node's gate key the log must be signed with (`--node-pk`); otherwise the receipt's governance link names it. Without either the log is not verified. */
  decision_log_node_pk?: Hex
}

export type AuditKind = 'negotiation-message' | 'termsheet' | 'approval' | 'scorer-evidence' | 'lender-policy' | 'loan-receipt' | 'decision-log'

export interface AuditEntry { seq: number; kind: AuditKind; ref: string; content_hash: Hex; prev_hash: Hex | null; entry_hash: Hex }

export interface AuditBundle {
  v: 1
  kind: 'passbook-audit-export'
  /** The term-sheet hash, which is the terms hash committed on chain. */
  loan_id: Hex | null
  generated_at: number
  entries: AuditEntry[]
  contents: Record<Hex, unknown>
  checks: { id: string; ok: boolean; detail: string }[]
  root_hash: Hex | null
}

export function buildAuditBundle(inputs: AuditInputs, ctx: { blocksPerMonth: number; maxRounds: number; deploymentMakerCheckerMicro: Micro; economics?: Economics; now?: number }): AuditBundle {
  const entries: AuditEntry[] = []
  const contents: Record<Hex, unknown> = {}
  const add = (kind: AuditKind, ref: string, content: unknown) => {
    const content_hash = hashObject(content)
    contents[content_hash] = content
    const prev_hash = entries.at(-1)?.entry_hash ?? null
    const seq = entries.length
    entries.push({ seq, kind, ref, content_hash, prev_hash, entry_hash: hashObject({ seq, kind, ref, content_hash, prev_hash }) })
  }
  const checks: AuditBundle['checks'] = []
  const sheet = inputs.termsheet
  let loanId: Hex | null = null
  if (inputs.lender_policy) add('lender-policy', inputs.lender_policy.owner_pk, inputs.lender_policy)
  for (const m of inputs.negotiation ?? []) add('negotiation-message', `${m.seq}:${m.type}`, m)
  let transcript: ReturnType<typeof verifyTranscript> | undefined
  if (inputs.negotiation?.length && sheet) {
    transcript = verifyTranscript(inputs.negotiation, { borrower_pk: sheet.terms.borrower_pk, lender_pk: sheet.terms.lender_pk, max_rounds: ctx.maxRounds })
    checks.push({ id: 'negotiation', ok: transcript.ok, detail: transcript.ok ? `${inputs.negotiation.length} signed, hash-chained messages` : transcript.problems.slice(0, 3).join('; ') })
  }
  if (sheet) {
    add('termsheet', sheet.negotiation.id, sheet)
    try {
      loanId = termSheetHash(sheet)
    } catch {
      loanId = null
    }
    const problems = termSheetProblems(sheet, { requireSignatures: true, economics: ctx.economics, ...(transcript?.agreed ? { agreed: transcript.agreed, accept_hash: transcript.accept_hash } : {}) })
    checks.push({ id: 'termsheet', ok: problems.length === 0 && !!loanId, detail: problems.length ? problems.slice(0, 3).join('; ') : 'bound to the on-chain terms hash, follows the accepted position, signed by both agents' })
  }
  if (inputs.scorer) {
    add('scorer-evidence', `${inputs.scorer.kind}:${inputs.scorer.descriptor.provider}${inputs.scorer.fallback ? ':fallback' : ''}`, inputs.scorer)
    if (sheet) {
      const problems = termSheetEvidenceProblems(sheet, inputs.scorer)
      checks.push({ id: 'scorer-reference', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : sheet.v === 1 ? 'the term sheet names this scorer result (v1 sheet: issued before evidence digests)' : 'the term sheet names this scorer result and its evidence digest' })
    }
  }
  for (const a of inputs.approvals ?? []) add('approval', `${a.role}:${a.approver_pk.slice(0, 16)}`, a)
  // The policy file is untrusted input: its approvers and threshold count only if its owner signed them.
  const policy = inputs.lender_policy
  const policyOk = !!policy && policyValid(policy) && (!sheet || policy.owner_pk === sheet.terms.lender_pk)
  if (policy) checks.push({ id: 'lender-policy', ok: policyOk, detail: policyOk ? 'signed by the lender named in the term sheet' : 'lender policy signature invalid or for another lender' })
  if (sheet && inputs.approvals) {
    if (!inputs.lender_policy) checks.push({ id: 'approvals', ok: false, detail: 'lender policy not supplied; maker-checker cannot be checked' })
    else if (!policyOk) checks.push({ id: 'approvals', ok: false, detail: 'lender policy not trusted; maker-checker cannot be checked' })
    else {
      const s = approvalStatus(sheet, inputs.approvals, inputs.lender_policy, ctx.deploymentMakerCheckerMicro)
      checks.push({ id: 'approvals', ok: s.complete && s.problems.length === 0, detail: `borrower ${s.borrower ? 'approved' : 'missing'}; lender approvers ${s.lender_approvers.length}/${s.required_lender_approvals}${s.problems.length ? `; ${s.problems.join(', ')}` : ''}` })
    }
  }
  if (inputs.receipt !== undefined) {
    const rc = inputs.receipt_check
    const sameLoan = !loanId || inputs.receipt.loan_id === loanId
    add('loan-receipt', rc ? (rc.ok ? 'verified' : 'failed-verification') : 'attached-unverified', inputs.receipt)
    checks.push({ id: 'loan-receipt', ok: !!rc?.ok && sameLoan, detail: !sameLoan ? 'receipt is for another loan' : rc ? (rc.ok ? `verified against Bitcoin: ${rc.checks.map((c) => c.id).join(', ')}` : `failed: ${rc.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.detail})`).join('; ')}`) : 'not verified against Bitcoin' })
  }
  if (inputs.decision_log) {
    const log = inputs.decision_log
    const actions = new Set(log.filter((e) => loanId && e.loan_id === loanId && e.action_id).map((e) => e.action_id))
    const mine = log.filter((e) => (loanId && e.loan_id === loanId) || (e.action_id !== null && actions.has(e.action_id)))
    for (const e of mine) add('decision-log', `${e.seq}:${e.kind}:${e.result}`, e)
    // bind the log to a key from outside it, never to the entries' own node_pk
    const nodePk = inputs.decision_log_node_pk ?? inputs.receipt?.governance?.node_pk
    const problems = nodePk ? verifyLog(log, nodePk) : ['no node key to verify the log against: pass --node-pk, or a receipt with a governance link']
    if (nodePk && inputs.receipt?.governance && inputs.receipt.governance.node_pk !== nodePk) problems.push('the receipt names another node key than --node-pk')
    if (inputs.receipt?.governance) problems.push(...governanceLinkProblems(inputs.receipt.governance, log))
    checks.push({ id: 'decision-log', ok: problems.length === 0 && mine.length > 0, detail: problems.length ? problems.slice(0, 3).join('; ') : mine.length ? `${mine.length} entries about this loan in an intact log, every entry signed by node key ${nodePk!.slice(0, 16)}…, of ${log.length}` : 'no decision-log entry about this loan' })
  }
  return { v: 1, kind: 'passbook-audit-export', loan_id: loanId, generated_at: ctx.now ?? Math.floor(Date.now() / 1000), entries, contents, checks, root_hash: entries.at(-1)?.entry_hash ?? null }
}

/** Integrity only: every entry hash, link and content hash. */
export function auditBundleProblems(b: AuditBundle): string[] {
  const problems: string[] = []
  if (!b || b.v !== 1 || b.kind !== 'passbook-audit-export' || !Array.isArray(b.entries)) return ['AUDIT_MALFORMED']
  b.entries.forEach((e, i) => {
    if (e.seq !== i || e.prev_hash !== (i === 0 ? null : b.entries[i - 1].entry_hash)) problems.push(`entry ${i}: broken chain`)
    if (e.entry_hash !== hashObject({ seq: e.seq, kind: e.kind, ref: e.ref, content_hash: e.content_hash, prev_hash: e.prev_hash })) problems.push(`entry ${i}: entry hash mismatch`)
    if (!(e.content_hash in b.contents) || hashObject(b.contents[e.content_hash]) !== e.content_hash) problems.push(`entry ${i}: content missing or altered`)
  })
  if (b.root_hash !== (b.entries.at(-1)?.entry_hash ?? null)) problems.push('root hash mismatch')
  return problems
}

/** Reads <dir>/{negotiation,termsheet,approvals,scorer,lender-policy,receipt}.json and decision-log.jsonl; any may be absent. */
export function readAuditInputs(dir: string): AuditInputs {
  const read = <T>(name: string): T | undefined => (existsSync(join(dir, name)) ? (JSON.parse(readFileSync(join(dir, name), 'utf8')) as T) : undefined)
  return { negotiation: read('negotiation.json'), termsheet: read('termsheet.json'), approvals: read('approvals.json'), scorer: read('scorer.json'), lender_policy: read('lender-policy.json'), receipt: read('receipt.json'), ...(existsSync(join(dir, 'decision-log.jsonl')) ? { decision_log: readLog(join(dir, 'decision-log.jsonl')) } : {}) }
}
