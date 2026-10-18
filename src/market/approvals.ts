// Human approval of a term sheet, bound to its hash (which is the on-chain
// terms hash). Nothing moves until the borrower and the lender have approved.
// Above the maker-checker threshold two distinct lender keys must approve.

import { isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import type { Micro } from '../core/money.js'
import type { LenderPolicy } from './policy.js'
import { termSheetHash, type TermSheet } from './termsheet.js'

export interface Approval {
  v: 1
  domain: 'passbook-approval-v1'
  termsheet_hash: Hex
  approver_pk: Hex
  role: 'borrower' | 'lender'
  /** Unix seconds */
  approved_at: number
  sig: Hex
}

export function approve(key: KeyPair, sheet: TermSheet, role: Approval['role'], approvedAt = Math.floor(Date.now() / 1000)): Approval {
  return signObject({ v: 1 as const, domain: 'passbook-approval-v1' as const, termsheet_hash: termSheetHash(sheet), approver_pk: key.pubkey, role, approved_at: approvedAt }, key.secretKey)
}

export interface ApprovalStatus {
  borrower: boolean
  lender_approvers: Hex[]
  required_lender_approvals: 1 | 2
  complete: boolean
  problems: string[]
}

/** The stricter of the lender's own rule and the deployment's (compliance.approvals). */
export function makerCheckerThreshold(policy: LenderPolicy, deploymentAboveMicro: Micro): Micro {
  return Math.min(policy.approval_rules.maker_checker_above, deploymentAboveMicro)
}

export function approvalStatus(sheet: TermSheet, approvals: Approval[], policy: LenderPolicy, deploymentAboveMicro: Micro): ApprovalStatus {
  const problems: string[] = []
  const hash = termSheetHash(sheet)
  const t = sheet.terms
  if (policy.owner_pk !== t.lender_pk) problems.push('LENDER_POLICY_FOR_ANOTHER_KEY')
  const lenderKeys = new Set([t.lender_pk, ...policy.approval_rules.approvers])
  let borrower = false
  const lenders = new Set<Hex>()
  for (const a of approvals) {
    if (!a || a.v !== 1 || a.domain !== 'passbook-approval-v1' || !isHex(a.approver_pk, 32) || !verifyObject(a, a.approver_pk)) { problems.push('APPROVAL_SIGNATURE'); continue }
    if (a.termsheet_hash !== hash) { problems.push('APPROVAL_FOR_ANOTHER_TERMSHEET'); continue }
    if (a.role === 'borrower') {
      if (a.approver_pk === t.borrower_pk) borrower = true
      else problems.push('BORROWER_APPROVAL_FROM_ANOTHER_KEY')
    } else if (lenderKeys.has(a.approver_pk)) lenders.add(a.approver_pk)
    else problems.push('LENDER_APPROVAL_FROM_UNLISTED_KEY')
  }
  const required = t.principal > makerCheckerThreshold(policy, deploymentAboveMicro) ? 2 : 1
  return { borrower, lender_approvers: [...lenders], required_lender_approvals: required, complete: borrower && lenders.size >= required, problems }
}
