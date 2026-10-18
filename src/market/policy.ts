// Standing policies the humans set once. Each is signed by its owner's key
// (through the Signer port) and stored locally; the negotiation engine never
// moves past a bound written here.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hashObject, isHex, type Hex } from '../core/crypto.js'
import { BPS, type Bps, type Micro } from '../core/money.js'
import type { CheckResult } from '../sandbox/types.js'
import { checkNodeRulesProblems, type CheckNodeRules } from '../checknode/select.js'
import { TRUST_LEVELS, type TrustLevel } from '../scorer/trust.js'
import { SETTLEMENT_KINDS, type SettlementKind } from '../settlement/kinds.js'
import { signWith, verifySigned, type Signer } from '../wallet/signer.js'

export interface Range { min: number; max: number }

export interface BorrowerPolicy {
  v: 1
  kind: 'passbook-borrower-policy'
  owner_pk: Hex
  asset_id: string
  principal: Range
  max_apr_bps: Bps
  max_ltv_bps: Bps
  term_blocks: Range
  min_scorer_trust: TrustLevel
  accepted_settlements: SettlementKind[]
  /** Where the borrower agent opens; defaults: three quarters of max APR, the max LTV. */
  opening?: { apr_bps?: Bps; ltv_bps?: Bps }
  /** Check market: the most the borrower pays a check node per check (src/checknode/select.ts). */
  max_check_price?: { asset_id: string; amount: number }
  issued_at: number
  sig: Hex
}

export interface LenderPolicy {
  v: 1
  kind: 'passbook-lender-policy'
  owner_pk: Hex
  asset_id: string
  max_per_loan: Micro
  max_outstanding: Micro
  min_apr_bps: Bps
  max_ltv_bps: Bps
  term_blocks: Range
  required_checks: CheckResult['id'][]
  min_scorer_trust: TrustLevel
  accepted_settlements: SettlementKind[]
  approval_rules: {
    /** Keys allowed to approve for this lender; the owner key is always one. */
    approvers: Hex[]
    /** Above this principal two distinct lender keys must approve (never weaker than the deployment config). */
    maker_checker_above: Micro
  }
  /** Where the lender agent opens; defaults: min APR plus 400 bps, max LTV minus 1,000 bps. */
  opening?: { apr_bps?: Bps; ltv_bps?: Bps }
  /** Check market: which check nodes this lender accepts (operators, releases, min trust and execution, max price). */
  check_nodes?: CheckNodeRules
  issued_at: number
  sig: Hex
}

const CHECK_IDS: CheckResult['id'][] = ['injection', 'categorise', 'affordability', 'headroom', 'inflows', 'sybil', 'disclosure', 'investigation', 'reconcile']
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const range = (r: Range | undefined, min = 1) => !!r && int(r.min, min) && int(r.max, r.min)
const settlements = (s: unknown) => Array.isArray(s) && s.length > 0 && new Set(s).size === s.length && s.every((k) => (SETTLEMENT_KINDS as readonly string[]).includes(k))

export function borrowerPolicyProblems(p: BorrowerPolicy): string[] {
  const problems: string[] = []
  if (!p || p.v !== 1 || p.kind !== 'passbook-borrower-policy') return ['POLICY_MALFORMED']
  if (!isHex(p.owner_pk, 32)) problems.push('owner_pk')
  if (typeof p.asset_id !== 'string' || !p.asset_id) problems.push('asset_id')
  if (!range(p.principal)) problems.push('principal')
  if (!int(p.max_apr_bps, 0, 100 * BPS)) problems.push('max_apr_bps')
  if (!int(p.max_ltv_bps, 1, BPS - 1)) problems.push('max_ltv_bps')
  if (!range(p.term_blocks)) problems.push('term_blocks')
  if (!(TRUST_LEVELS as readonly string[]).includes(p.min_scorer_trust)) problems.push('min_scorer_trust')
  if (!settlements(p.accepted_settlements)) problems.push('accepted_settlements')
  if (p.opening?.apr_bps !== undefined && !int(p.opening.apr_bps, 0, p.max_apr_bps)) problems.push('opening.apr_bps')
  if (p.opening?.ltv_bps !== undefined && !int(p.opening.ltv_bps, 1, p.max_ltv_bps)) problems.push('opening.ltv_bps')
  if (p.max_check_price !== undefined && (typeof p.max_check_price?.asset_id !== 'string' || !int(p.max_check_price.amount))) problems.push('max_check_price')
  if (!int(p.issued_at)) problems.push('issued_at')
  return problems
}

export function lenderPolicyProblems(p: LenderPolicy): string[] {
  const problems: string[] = []
  if (!p || p.v !== 1 || p.kind !== 'passbook-lender-policy') return ['POLICY_MALFORMED']
  if (!isHex(p.owner_pk, 32)) problems.push('owner_pk')
  if (typeof p.asset_id !== 'string' || !p.asset_id) problems.push('asset_id')
  if (!int(p.max_per_loan, 1) || !int(p.max_outstanding, p.max_per_loan)) problems.push('max_per_loan/max_outstanding')
  if (!int(p.min_apr_bps, 0, 100 * BPS)) problems.push('min_apr_bps')
  if (!int(p.max_ltv_bps, 1, BPS - 1)) problems.push('max_ltv_bps')
  if (!range(p.term_blocks)) problems.push('term_blocks')
  if (!Array.isArray(p.required_checks) || !p.required_checks.every((c) => CHECK_IDS.includes(c))) problems.push('required_checks')
  if (!(TRUST_LEVELS as readonly string[]).includes(p.min_scorer_trust)) problems.push('min_scorer_trust')
  if (!settlements(p.accepted_settlements)) problems.push('accepted_settlements')
  const rules = p.approval_rules
  if (!rules || !Array.isArray(rules.approvers) || !rules.approvers.every((k) => isHex(k, 32)) || !int(rules.maker_checker_above)) problems.push('approval_rules')
  if (p.opening?.apr_bps !== undefined && !int(p.opening.apr_bps, p.min_apr_bps, 100 * BPS)) problems.push('opening.apr_bps')
  if (p.opening?.ltv_bps !== undefined && !int(p.opening.ltv_bps, 1, p.max_ltv_bps)) problems.push('opening.ltv_bps')
  problems.push(...checkNodeRulesProblems(p.check_nodes))
  if (!int(p.issued_at)) problems.push('issued_at')
  return problems
}

type Unsigned<T> = Omit<T, 'v' | 'kind' | 'owner_pk' | 'sig'>

export async function signBorrowerPolicy(signer: Signer, input: Unsigned<BorrowerPolicy>): Promise<BorrowerPolicy> {
  const policy = await signWith(signer, { v: 1 as const, kind: 'passbook-borrower-policy' as const, owner_pk: signer.pubkey, ...input })
  const problems = borrowerPolicyProblems(policy)
  if (problems.length) throw new Error(`invalid borrower policy: ${problems.join(', ')}`)
  return policy
}

export async function signLenderPolicy(signer: Signer, input: Unsigned<LenderPolicy>): Promise<LenderPolicy> {
  const policy = await signWith(signer, { v: 1 as const, kind: 'passbook-lender-policy' as const, owner_pk: signer.pubkey, ...input })
  const problems = lenderPolicyProblems(policy)
  if (problems.length) throw new Error(`invalid lender policy: ${problems.join(', ')}`)
  return policy
}

export function policyValid(p: BorrowerPolicy | LenderPolicy): boolean {
  const problems = p.kind === 'passbook-borrower-policy' ? borrowerPolicyProblems(p) : lenderPolicyProblems(p as LenderPolicy)
  return problems.length === 0 && verifySigned(p, p.owner_pk)
}

/** Commits to a private policy without revealing it; sent in ASK and OFFER. */
export function policyHash(p: BorrowerPolicy | LenderPolicy): Hex {
  return hashObject(p)
}

export function savePolicy(path: string, p: BorrowerPolicy | LenderPolicy): void {
  if (!policyValid(p)) throw new Error('refusing to store an invalid or unsigned policy')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function loadPolicy<T extends BorrowerPolicy | LenderPolicy>(path: string): T {
  const p = JSON.parse(readFileSync(path, 'utf8')) as T
  if (!policyValid(p)) throw new Error(`${path}: policy is invalid or its signature does not verify`)
  return p
}
