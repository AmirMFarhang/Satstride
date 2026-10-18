// Executable finite model of the rejected independent-output design. This is
// neither Bitcoin consensus execution nor RGB validation. G1 tests real scripts.
export interface HtlcModel {
  // Observed tip: nLockTime N can enter the next block when tip >= N.
  tip: number
  payment: 'unspent' | 'claimed' | 'refunded' | 'burned'
  collateral: 'unspent' | 'released-e' | 'defaulted' | 'liquidated' | 'recovered-d'
  secret_public: boolean
  liquidation_authorized: boolean
}
export type HtlcEvent = 'publish-secret' | 'confirm-claim' | 'confirm-uncolored-claim' | 'confirm-refund' | 'confirm-e' | 'confirm-default' | 'authorize-liquidation' | 'confirm-liquidation' | 'confirm-recovery' | 'advance-refund' | 'advance-default' | 'advance-recovery' | 'reorg-claim'
export const HTLC_MODEL_TIMES = { initial_tip: 170, refund_locktime: 178, default_locktime: 185, recovery_locktime: 205 } as const
export const HTLC_MODEL_INITIAL: HtlcModel = { tip: HTLC_MODEL_TIMES.initial_tip, payment: 'unspent', collateral: 'unspent', secret_public: false, liquidation_authorized: false }

export function htlcTransition(state: HtlcModel, event: HtlcEvent): HtlcModel | undefined {
  const s = { ...state }
  switch (event) {
    // Even a stale, conflicting, non-mined or invalid-RGB witness can disclose r.
    case 'publish-secret': if (s.secret_public) return; s.secret_public = true; break
    case 'confirm-claim':
      if (s.payment !== 'unspent') return
      s.payment = 'claimed'; s.secret_public = true; break // NO maximum claim time
    case 'confirm-uncolored-claim':
      if (s.payment !== 'unspent') return
      s.payment = 'burned'; s.secret_public = true; break
    case 'confirm-refund':
      if (s.payment !== 'unspent' || s.tip < HTLC_MODEL_TIMES.refund_locktime) return
      s.payment = 'refunded'; break
    case 'confirm-e':
      if (s.collateral !== 'unspent' || !s.secret_public) return
      s.collateral = 'released-e'; break
    case 'confirm-default':
      if (s.collateral !== 'unspent' || s.tip < HTLC_MODEL_TIMES.default_locktime) return
      s.collateral = 'defaulted'; break
    case 'authorize-liquidation': if (s.liquidation_authorized) return; s.liquidation_authorized = true; break
    case 'confirm-liquidation':
      if (s.collateral !== 'unspent' || !s.liquidation_authorized) return
      s.collateral = 'liquidated'; break
    case 'confirm-recovery':
      if (s.collateral !== 'unspent' || s.tip < HTLC_MODEL_TIMES.recovery_locktime) return
      s.collateral = 'recovered-d'; break
    case 'advance-refund': if (s.tip >= HTLC_MODEL_TIMES.refund_locktime) return; s.tip = HTLC_MODEL_TIMES.refund_locktime; break
    case 'advance-default': if (s.tip >= HTLC_MODEL_TIMES.default_locktime) return; s.tip = HTLC_MODEL_TIMES.default_locktime; break
    case 'advance-recovery': if (s.tip >= HTLC_MODEL_TIMES.recovery_locktime) return; s.tip = HTLC_MODEL_TIMES.recovery_locktime; break
    case 'reorg-claim':
      if (s.payment !== 'claimed') return
      s.payment = 'unspent'; break // disclosure does NOT reverse with confirmation
  }
  return s
}
export function htlcViolation(s: HtlcModel): string | undefined {
  if (s.payment === 'claimed' && ['defaulted', 'liquidated'].includes(s.collateral)) return 'lender-collects-rgb-and-collateral'
  if (s.payment === 'refunded' && s.collateral === 'released-e') return 'borrower-recovers-rgb-and-collateral'
  if (s.payment === 'burned' && s.collateral === 'released-e') return 'e-release-without-valid-rgb-receipt'
  return undefined
}
export function modelTrace(events: HtlcEvent[]): HtlcModel {
  let state = { ...HTLC_MODEL_INITIAL }
  for (const event of events) {
    const next = htlcTransition(state, event)
    if (!next) throw new Error(`ineligible event: ${event}`)
    state = next
  }
  return state
}

/** Breadth-first exploration, with no watcher-policy predicates in consensus. */
export function findHtlcCounterexamples(): Record<string, { events: HtlcEvent[]; state: HtlcModel }> {
  const events: HtlcEvent[] = ['publish-secret', 'confirm-claim', 'confirm-uncolored-claim', 'confirm-refund', 'confirm-e', 'confirm-default', 'authorize-liquidation', 'confirm-liquidation', 'confirm-recovery', 'advance-refund', 'advance-default', 'advance-recovery', 'reorg-claim']
  const queue = [{ events: [] as HtlcEvent[], state: { ...HTLC_MODEL_INITIAL } }]
  const seen = new Set<string>(), result: Record<string, { events: HtlcEvent[]; state: HtlcModel }> = {}
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i], key = JSON.stringify(current.state)
    if (seen.has(key)) continue
    seen.add(key)
    const violation = htlcViolation(current.state)
    if (violation && !result[violation]) result[violation] = current
    for (const event of events) {
      const next = htlcTransition(current.state, event)
      if (next && !seen.has(JSON.stringify(next))) queue.push({ events: [...current.events, event], state: next })
    }
  }
  return result
}

// Authorized redesign: atomic funding and repayment, under the stated honest
// signer/RGB-validation policy. Atomic transitions model Bitcoin transactions;
// this is finite exploration, not a consensus interpreter or a global proof.
export interface JointModel {
  tip: number; funding_verified: boolean; enforcement_presigned: boolean
  funding_exported: boolean; principal_paid: boolean
  collateral: 'absent' | 'unspent' | 'returned' | 'defaulted' | 'liquidated' | 'recovered'
  rgb_debt: 'available' | 'paid' | 'spent-elsewhere'
  repayment_verified: boolean; repayment_exported: boolean; liquidation_authorized: boolean
}
export type JointEvent = 'verify-funding' | 'presign-enforcement' | 'export-funding' | 'confirm-funding' | 'verify-repayment' | 'export-repayment' | 'confirm-repayment' | 'spend-rgb-elsewhere' | 'confirm-default' | 'authorize-liquidation' | 'confirm-liquidation' | 'confirm-recovery' | 'advance-default' | 'advance-recovery' | 'reorg-repayment' | 'reorg-enforcement' | 'reorg-funding'
export const JOINT_INITIAL: JointModel = { tip: 170, funding_verified: false, enforcement_presigned: false, funding_exported: false, principal_paid: false, collateral: 'absent', rgb_debt: 'available', repayment_verified: false, repayment_exported: false, liquidation_authorized: false }
export function jointTransition(state: JointModel, event: JointEvent): JointModel | undefined {
  const s = { ...state }
  switch (event) {
    case 'verify-funding': if (s.funding_verified) return; s.funding_verified = true; break
    case 'presign-enforcement': if (!s.funding_verified || s.enforcement_presigned) return; s.enforcement_presigned = true; break
    case 'export-funding': if (!s.funding_verified || !s.enforcement_presigned || s.funding_exported) return; s.funding_exported = true; break
    case 'confirm-funding':
      if (!s.funding_exported || s.collateral !== 'absent') return
      s.principal_paid = true; s.collateral = 'unspent'; break
    case 'verify-repayment': if (s.collateral !== 'unspent' || s.rgb_debt !== 'available' || s.repayment_verified) return; s.repayment_verified = true; break
    case 'export-repayment': if (!s.repayment_verified || s.repayment_exported) return; s.repayment_exported = true; break
    case 'confirm-repayment':
      if (!s.repayment_exported || s.collateral !== 'unspent' || s.rgb_debt !== 'available') return
      s.collateral = 'returned'; s.rgb_debt = 'paid'; break
    case 'spend-rgb-elsewhere': if (s.rgb_debt !== 'available') return; s.rgb_debt = 'spent-elsewhere'; break
    case 'confirm-default': if (s.collateral !== 'unspent' || !s.enforcement_presigned || s.tip < 185) return; s.collateral = 'defaulted'; break
    case 'authorize-liquidation': if (s.liquidation_authorized) return; s.liquidation_authorized = true; break
    case 'confirm-liquidation': if (s.collateral !== 'unspent' || !s.liquidation_authorized) return; s.collateral = 'liquidated'; break
    case 'confirm-recovery': if (s.collateral !== 'unspent' || s.tip < 205) return; s.collateral = 'recovered'; break
    case 'advance-default': if (s.tip >= 185) return; s.tip = 185; break
    case 'advance-recovery': if (s.tip >= 205) return; s.tip = 205; break
    case 'reorg-repayment': if (s.collateral !== 'returned') return; s.collateral = 'unspent'; s.rgb_debt = 'available'; break
    case 'reorg-enforcement': if (!['defaulted', 'liquidated', 'recovered'].includes(s.collateral)) return; s.collateral = 'unspent'; break
    case 'reorg-funding':
      if (!s.principal_paid) return
      s.principal_paid = false; s.collateral = 'absent'
      if (s.rgb_debt === 'paid') s.rgb_debt = 'available'
      break // all descendants roll back; exported signatures remain
    default: return undefined
  }
  return s
}
export function jointViolation(s: JointModel): string | undefined {
  if ((s.collateral !== 'absent') !== s.principal_paid) return 'collateral-without-principal'
  if ((s.rgb_debt === 'paid') !== (s.collateral === 'returned')) return 'split-repayment-outcome'
  return undefined
}
export function jointTrace(events: JointEvent[]): JointModel {
  let s = { ...JOINT_INITIAL }
  for (const event of events) { const next = jointTransition(s, event); if (!next) throw new Error(`ineligible event: ${event}`); s = next }
  return s
}
export function exploreJointModel(): { states: number; violations: string[] } {
  const events: JointEvent[] = ['verify-funding', 'presign-enforcement', 'export-funding', 'confirm-funding', 'verify-repayment', 'export-repayment', 'confirm-repayment', 'spend-rgb-elsewhere', 'confirm-default', 'authorize-liquidation', 'confirm-liquidation', 'confirm-recovery', 'advance-default', 'advance-recovery', 'reorg-repayment', 'reorg-enforcement', 'reorg-funding']
  const seen = new Set<string>(), violations = new Set<string>(), queue = [{ ...JOINT_INITIAL }]
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i], key = JSON.stringify(s)
    if (seen.has(key)) continue
    seen.add(key)
    const violation = jointViolation(s); if (violation) violations.add(violation)
    for (const event of events) { const next = jointTransition(s, event); if (next && !seen.has(JSON.stringify(next))) queue.push(next) }
  }
  return { states: seen.size, violations: [...violations] }
}
