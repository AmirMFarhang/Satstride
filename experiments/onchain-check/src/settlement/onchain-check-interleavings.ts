/**
 * Finite, standalone model of one RGB payment box Q for one sealed report.
 * This is analysis, not a wallet, Bitcoin/RGB validator, or live payment rail.
 *
 * Assumptions: the payer holds the exact signed, consent-bound ciphertext
 * before funding; the report is well formed and passes independent scorer
 * verification when opened with K; SHA256/encryption/signatures are sound.
 * Publication exposes the right K to the payer, but opening/verifying the
 * report remains a separate action. No key bytes or wallet data are modeled.
 *
 * Q has an operator+K claim and a payer refund after a fixed height. Both
 * consume the same outpoint. A claim has no consensus expiry. The honest
 * operator publishes only a prevalidated RGB claim in its claim window;
 * the adversarial mode also admits late publication and Bitcoin-valid claims
 * that disclose K but burn/misdirect RGB instead of paying the operator.
 *
 * A reorg substitutes a chain at the same abstract height, retaining the
 * timing phase but removing the chosen transaction and its descendants.
 * Previously exported claims and information survive. Funding can reappear
 * only as the same transaction creating the same Q. Three time phases, one
 * fixed funding transaction and three fixed competing spends are modeled;
 * there is no fee market, real block execution, RGB state, native journal,
 * replacement graph, arbitrary transaction set or universal fairness proof.
 */

export type OnchainCheckPhase = 'claim-window' | 'claim-cutoff-passed' | 'refund-eligible'
export type OnchainCheckSpend = 'none' | 'valid-rgb-claim' | 'rgb-invalid-claim' | 'refund'
export type OnchainCheckOperatorPolicy = 'adversarial' | 'honest-bounded'

export interface OnchainCheckModelOptions {
  /** An operational disclosure guard, never a consensus expiry of claim. */
  operatorPolicy?: OnchainCheckOperatorPolicy
}

export interface OnchainCheckModelState {
  readonly phase: OnchainCheckPhase
  readonly fundingConfirmed: boolean
  readonly canonicalSpend: OnchainCheckSpend
  /** First publication phase; publication and its authorization are not revoked by reorg. */
  readonly validClaimPublishedAt: OnchainCheckPhase | null
  readonly rgbInvalidClaimPublished: boolean
  readonly keyObserved: boolean
  readonly reportVerified: boolean
  readonly claimReorgSeen: boolean
  readonly fundingReorgSeen: boolean
}

export type OnchainCheckModelEvent =
  | 'confirm-funding'
  | 'publish-valid-claim'
  | 'publish-rgb-invalid-claim'
  | 'verify-report'
  | 'confirm-valid-claim'
  | 'confirm-rgb-invalid-claim'
  | 'confirm-refund'
  | 'reorg-claim'
  | 'reorg-refund'
  | 'reorg-funding'
  | 'pass-claim-cutoff'
  | 'reach-refund-height'

export interface OnchainCheckTransition {
  event: OnchainCheckModelEvent
  state: OnchainCheckModelState
}

export interface OnchainCheckTrace {
  state: OnchainCheckModelState
  /** A shortest path from the initial state, using deterministic BFS order. */
  trace: OnchainCheckModelEvent[]
}

/** Chain facts are deliberately separate from learned K and verified report. */
export function onchainCheckFacts(s: OnchainCheckModelState) {
  return {
    fundingInputSpent: s.fundingConfirmed,
    boxCreated: s.fundingConfirmed,
    boxUnspent: s.fundingConfirmed && s.canonicalSpend === 'none',
    canonicalRgbPayment: s.fundingConfirmed && s.canonicalSpend === 'valid-rgb-claim',
    canonicalRgbRefund: s.fundingConfirmed && s.canonicalSpend === 'refund',
    canonicalRgbLoss: s.fundingConfirmed && s.canonicalSpend === 'rgb-invalid-claim',
    keyObserved: s.keyObserved,
    reportVerified: s.reportVerified,
  }
}

export function initialOnchainCheckState(): OnchainCheckModelState {
  return {
    phase: 'claim-window', fundingConfirmed: false, canonicalSpend: 'none',
    validClaimPublishedAt: null, rgbInvalidClaimPublished: false,
    keyObserved: false, reportVerified: false,
    claimReorgSeen: false, fundingReorgSeen: false,
  }
}

const PHASES: readonly OnchainCheckPhase[] = ['claim-window', 'claim-cutoff-passed', 'refund-eligible']
const SPENDS: readonly OnchainCheckSpend[] = ['none', 'valid-rgb-claim', 'rgb-invalid-claim', 'refund']

/** Invariants of this bounded model, not assertions about a native implementation. */
export function onchainCheckInvariantErrors(s: OnchainCheckModelState): string[] {
  const errors: string[] = []
  if (!PHASES.includes(s.phase)) errors.push('UNKNOWN_PHASE')
  if (!SPENDS.includes(s.canonicalSpend)) errors.push('UNKNOWN_SPEND')
  if (!s.fundingConfirmed && s.canonicalSpend !== 'none') errors.push('SPEND_WITHOUT_FUNDING')
  if (s.reportVerified && !s.keyObserved) errors.push('VERIFIED_REPORT_WITHOUT_KEY')
  if ((s.validClaimPublishedAt !== null || s.rgbInvalidClaimPublished) && !s.keyObserved) errors.push('PUBLICATION_WITHOUT_KEY_OBSERVATION')
  if (s.validClaimPublishedAt !== null && (!PHASES.includes(s.validClaimPublishedAt) || PHASES.indexOf(s.validClaimPublishedAt) > PHASES.indexOf(s.phase))) errors.push('PUBLICATION_IN_FUTURE_PHASE')
  if (s.canonicalSpend === 'valid-rgb-claim' && s.validClaimPublishedAt === null) errors.push('CLAIM_WITHOUT_PUBLICATION')
  if (s.canonicalSpend === 'rgb-invalid-claim' && !s.rgbInvalidClaimPublished) errors.push('INVALID_RGB_CLAIM_WITHOUT_PUBLICATION')
  if (s.canonicalSpend === 'refund' && s.phase !== 'refund-eligible') errors.push('PREMATURE_REFUND')
  return errors
}

function operatorPolicy(o: OnchainCheckModelOptions): OnchainCheckOperatorPolicy {
  const policy = o.operatorPolicy ?? 'adversarial'
  if (policy !== 'adversarial' && policy !== 'honest-bounded') throw new Error('UNKNOWN_OPERATOR_POLICY')
  return policy
}

export function nextOnchainCheckStates(s: OnchainCheckModelState, o: OnchainCheckModelOptions = {}): OnchainCheckTransition[] {
  const errors = onchainCheckInvariantErrors(s)
  if (errors.length) throw new Error(`INVALID_MODEL_STATE:${errors.join(',')}`)
  const policy = operatorPolicy(o)
  const next: OnchainCheckTransition[] = []
  const add = (event: OnchainCheckModelEvent, patch: Partial<OnchainCheckModelState>) => next.push({ event, state: { ...s, ...patch } })
  const unspent = s.fundingConfirmed && s.canonicalSpend === 'none'

  if (!s.fundingConfirmed) add('confirm-funding', { fundingConfirmed: true })
  if (unspent && s.validClaimPublishedAt === null && (policy === 'adversarial' || s.phase === 'claim-window')) {
    add('publish-valid-claim', { validClaimPublishedAt: s.phase, keyObserved: true })
  }
  if (unspent && !s.rgbInvalidClaimPublished && policy === 'adversarial') {
    add('publish-rgb-invalid-claim', { rgbInvalidClaimPublished: true, keyObserved: true })
  }
  if (s.keyObserved && !s.reportVerified) add('verify-report', { reportVerified: true })
  // Canonical claims and refunds compete for Q. Publication alone spends nothing.
  if (unspent && s.validClaimPublishedAt !== null) add('confirm-valid-claim', { canonicalSpend: 'valid-rgb-claim' })
  if (unspent && s.rgbInvalidClaimPublished) add('confirm-rgb-invalid-claim', { canonicalSpend: 'rgb-invalid-claim' })
  if (unspent && s.phase === 'refund-eligible') add('confirm-refund', { canonicalSpend: 'refund' })
  if (s.canonicalSpend === 'valid-rgb-claim' || s.canonicalSpend === 'rgb-invalid-claim') {
    add('reorg-claim', { canonicalSpend: 'none', claimReorgSeen: true })
  }
  if (s.canonicalSpend === 'refund') add('reorg-refund', { canonicalSpend: 'none' })
  if (s.fundingConfirmed) {
    add('reorg-funding', {
      fundingConfirmed: false, canonicalSpend: 'none', fundingReorgSeen: true,
      claimReorgSeen: s.claimReorgSeen || s.canonicalSpend === 'valid-rgb-claim' || s.canonicalSpend === 'rgb-invalid-claim',
    })
  }
  if (s.phase === 'claim-window') add('pass-claim-cutoff', { phase: 'claim-cutoff-passed' })
  if (s.phase === 'claim-cutoff-passed') add('reach-refund-height', { phase: 'refund-eligible' })
  return next
}

/** Stable model identity; no transaction/secret hashing or runtime evidence. */
export function onchainCheckStateKey(s: OnchainCheckModelState): string {
  return JSON.stringify([
    s.phase, s.fundingConfirmed, s.canonicalSpend, s.validClaimPublishedAt,
    s.rgbInvalidClaimPublished, s.keyObserved, s.reportVerified,
    s.claimReorgSeen, s.fundingReorgSeen,
  ])
}

/** Exhaustive BFS of this finite abstraction; each state retains its shortest trace. */
export function enumerateOnchainCheckStates(o: OnchainCheckModelOptions = {}): OnchainCheckTrace[] {
  operatorPolicy(o)
  const initial = initialOnchainCheckState()
  const queue: OnchainCheckTrace[] = [{ state: initial, trace: [] }]
  const seen = new Set([onchainCheckStateKey(initial)])
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]
    for (const next of nextOnchainCheckStates(current.state, o)) {
      const key = onchainCheckStateKey(next.state)
      if (seen.has(key)) continue
      seen.add(key)
      queue.push({ state: next.state, trace: [...current.trace, next.event] })
    }
  }
  return queue
}

export function findOnchainCheckTrace(predicate: (s: OnchainCheckModelState) => boolean, o: OnchainCheckModelOptions = {}): OnchainCheckTrace | null {
  return enumerateOnchainCheckStates(o).find(({ state }) => predicate(state)) ?? null
}

/** Replays exact public event names and refuses transitions not enabled in this model. */
export function replayOnchainCheckTrace(trace: readonly OnchainCheckModelEvent[], o: OnchainCheckModelOptions = {}): OnchainCheckModelState {
  operatorPolicy(o)
  let state = initialOnchainCheckState()
  for (const event of trace) {
    const next = nextOnchainCheckStates(state, o).find((t) => t.event === event)
    if (!next) throw new Error(`MODEL_EVENT_NOT_ENABLED:${event}`)
    state = next.state
  }
  return state
}
