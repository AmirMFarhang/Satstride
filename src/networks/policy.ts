// Which layers a lender accepts and needs, which ones a borrower shares, and
// how the two meet. The lender's layer policy names, per layer, its weight and
// the trust mode it uses; `required_layers` defaults to RGB alone, so today's
// RGB-only loans are unchanged. The borrower shares layers per loan, per
// address or node, and consents to each with the trust mode named.
//
// The intersection is deterministic: a required layer that is not shared, not
// proven or not verified ends the negotiation with NO_DEAL and the reason; a
// shared optional layer that passes (control proven, history verified, old
// enough, and something to show) moves the lender's LTV bound up by a fixed
// step, capped, and always clamped to the platform's LTV limit for the term and
// to the lender's own ceiling. A blocking typology or a sanctions hit on any
// shared layer is NO_DEAL. The model never produces a number.

import { hashObject, isHex, signHash, verifyHash, type Hex, type KeyPair } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, maxLtvForTerm, type Economics } from '../core/economics.js'
import type { Bps } from '../core/money.js'
import type { LenderPolicy } from '../market/policy.js'
import { DEFAULT_EVIDENCE_WEIGHTS, type EvidenceWeights, type LayerFeatures } from './features.js'
import { isLayerId, LAYER_IDS, TRUST_MODES, type ChainId, type ControlVerdict, type LayerId, type RecomputeResult, type TrustMode } from './types.js'

export interface LenderLayerPolicy {
  v: 1
  kind: 'passbook-lender-layer-policy'
  /** Accepted layers and the weight each one's income gets, in bps. */
  accepted_layers: Partial<Record<LayerId, number>>
  /** Layers without which there is no deal. Default: ['rgb']. */
  required_layers: LayerId[]
  trust_mode_by_layer: Partial<Record<LayerId, TrustMode>>
  /** A shared layer younger than this does not pass (its first transaction or public first-seen). */
  min_wallet_age_days: number
  evidence_weights: EvidenceWeights
  /** LTV added per passing optional layer, and the cap on the total. */
  ltv_step_bps: Bps
  ltv_max_bonus_bps: Bps
  /** Payers the lender recognises; chain-recomputable rows from them count in full. */
  known_payers: string[]
  /** Privacy tools are neutral unless a lender writes otherwise; this release supports neutral only. */
  privacy_tools: 'neutral'
}

export const DEFAULT_LENDER_LAYER_POLICY: Readonly<LenderLayerPolicy> = Object.freeze({
  v: 1,
  kind: 'passbook-lender-layer-policy',
  accepted_layers: { rgb: 10_000, 'btc-onchain': 10_000, lightning: 10_000 },
  required_layers: ['rgb'],
  trust_mode_by_layer: { rgb: 'client-side-validated', 'btc-onchain': 'lender-recompute', lightning: 'signature-verified' },
  min_wallet_age_days: 0,
  evidence_weights: { ...DEFAULT_EVIDENCE_WEIGHTS },
  ltv_step_bps: 200,
  ltv_max_bonus_bps: 400,
  known_payers: [],
  privacy_tools: 'neutral',
}) as LenderLayerPolicy

export function layerPolicyProblems(p: LenderLayerPolicy): string[] {
  const problems: string[] = []
  if (!p || p.v !== 1 || p.kind !== 'passbook-lender-layer-policy') return ['POLICY_MALFORMED']
  const int = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
  for (const [layer, w] of Object.entries(p.accepted_layers ?? {})) if (!isLayerId(layer) || !int(w, 0, 10_000)) problems.push(`accepted_layers.${layer}`)
  if (!Array.isArray(p.required_layers) || p.required_layers.some((l) => !isLayerId(l) || !(l in p.accepted_layers))) problems.push('required_layers (each must be accepted)')
  for (const [layer, m] of Object.entries(p.trust_mode_by_layer ?? {})) if (!isLayerId(layer) || !(TRUST_MODES as readonly string[]).includes(m as string)) problems.push(`trust_mode_by_layer.${layer}`)
  if (p.trust_mode_by_layer['btc-onchain'] && p.trust_mode_by_layer['btc-onchain'] !== 'lender-recompute') problems.push('trust_mode_by_layer.btc-onchain must be lender-recompute: the lender never takes the borrower\'s indexer')
  if (!int(p.min_wallet_age_days, 0, 3650)) problems.push('min_wallet_age_days')
  const w = p.evidence_weights
  if (!w || !Object.values(w).every((x) => int(x, 0, 10_000)) || w.self_reported_bps !== 0) problems.push('evidence_weights (0-10000 bps; self-reported is always 0)')
  if (!int(p.ltv_step_bps, 0, 1_000) || !int(p.ltv_max_bonus_bps, 0, 2_000) || p.ltv_step_bps > p.ltv_max_bonus_bps) problems.push('ltv_step_bps / ltv_max_bonus_bps')
  if (!Array.isArray(p.known_payers) || p.known_payers.some((k) => typeof k !== 'string' || k.length > 120)) problems.push('known_payers')
  if (p.privacy_tools !== 'neutral') problems.push('privacy_tools (only neutral is supported)')
  return problems
}

/** What the borrower is willing to share for this loan, layer by layer, with the subject (address, node key, party key). */
export interface BorrowerShareable {
  shareable_layers: LayerId[]
  subjects: Partial<Record<LayerId, string[]>>
}

/** Per layer, per subject, per loan consent, naming the trust mode the lender will use. Signed by the borrower's party key. */
export interface LayerConsent {
  v: 1
  kind: 'passbook-layer-consent'
  borrower_pk: Hex
  lender_pk: Hex
  negotiation_id: Hex
  layer: LayerId
  chain: ChainId
  subject: string
  trust_mode: TrustMode
  /** What the lender may read: 'proof-and-history' or 'proof-only'. */
  scope: 'proof-and-history' | 'proof-only'
  window_days: number
  issued_at: number
  expires_at: number
  sig: Hex
}

export function signLayerConsent(key: KeyPair, c: Omit<LayerConsent, 'v' | 'kind' | 'borrower_pk' | 'sig'>): LayerConsent {
  const body = { v: 1 as const, kind: 'passbook-layer-consent' as const, borrower_pk: key.pubkey, ...c }
  return { ...body, sig: signHash(hashObject(body), key.secretKey) }
}

export function layerConsentProblems(c: LayerConsent, expect: { borrower_pk: Hex; lender_pk: Hex; negotiation_id: Hex; now: number }): string[] {
  const problems: string[] = []
  if (!c || c.v !== 1 || c.kind !== 'passbook-layer-consent') return ['CONSENT_MALFORMED']
  const { sig, ...body } = c
  if (!isHex(sig, 64) || !verifyHash(sig, hashObject(body), c.borrower_pk)) problems.push('CONSENT_SIGNATURE_INVALID')
  if (c.borrower_pk !== expect.borrower_pk) problems.push('CONSENT_WRONG_BORROWER')
  if (c.lender_pk !== expect.lender_pk) problems.push('CONSENT_WRONG_LENDER')
  if (c.negotiation_id !== expect.negotiation_id) problems.push('CONSENT_WRONG_NEGOTIATION')
  if (expect.now > c.expires_at) problems.push('CONSENT_EXPIRED')
  if (!(TRUST_MODES as readonly string[]).includes(c.trust_mode)) problems.push('CONSENT_TRUST_MODE')
  return problems
}

/** One layer's outcome, as the check produced it. */
export interface LayerResult {
  layer: LayerId
  shared: boolean
  consented: boolean
  control: ControlVerdict[]
  /** btc-onchain: the lender's recomputation; other layers: null. */
  recompute: RecomputeResult | null
  /** Age of the oldest proven subject, in days; null when unknown. */
  wallet_age_days: number | null
  /** The layer shows something: rows in the window, a balance, channels or a public record. An empty layer earns no bonus. */
  evidence: boolean
  limits: string[]
}

export interface LayerNegotiation {
  outcome: 'DEAL' | 'NO_DEAL'
  reasons: string[]
  layers: { layer: LayerId; status: 'required-pass' | 'optional-pass' | 'not-shared' | 'not-accepted' | 'failed'; trust_mode: TrustMode | null; why: string[] }[]
  /** LTV added to the lender's bound, after the cap; 0 on NO_DEAL. */
  ltv_bonus_bps: Bps
}

function layerFailures(r: LayerResult, policy: LenderLayerPolicy): string[] {
  const why: string[] = []
  if (!r.consented) why.push('no consent for this layer')
  if (!r.control.length) why.push('control not proven')
  for (const v of r.control) if (!v.ok) why.push(`control of ${v.subject.slice(0, 14)}… failed: ${v.reasons.join(', ')}`)
  if (r.recompute && !r.recompute.ok) {
    for (const t of r.recompute.tampered) why.push(`row ${t.txid.slice(0, 12)}… ${t.field}: borrower ${t.claimed}, lender recomputed ${t.recomputed}`)
    for (const t of r.recompute.missing) why.push(`row ${t.slice(0, 12)}… found by the lender, not sent by the borrower`)
    for (const t of r.recompute.unknown) why.push(`row ${t.slice(0, 12)}… sent by the borrower, unknown to the lender's source`)
    if (!r.recompute.tampered.length && !r.recompute.missing.length && !r.recompute.unknown.length) why.push('lender could not recompute this layer from its own source')
  }
  if (r.layer === 'btc-onchain' && !r.recompute) why.push('lender did not recompute this layer')
  if (policy.min_wallet_age_days > 0 && (r.wallet_age_days === null || r.wallet_age_days < policy.min_wallet_age_days)) why.push(`wallet age ${r.wallet_age_days ?? 'unknown'} days, under the lender's ${policy.min_wallet_age_days}`)
  return why
}

export function negotiateLayers(policy: LenderLayerPolicy, shareable: BorrowerShareable, results: LayerResult[], features: LayerFeatures | null): LayerNegotiation {
  const problems = layerPolicyProblems(policy)
  if (problems.length) return { outcome: 'NO_DEAL', reasons: [`lender layer policy invalid: ${problems.join(', ')}`], layers: [], ltv_bonus_bps: 0 }
  const reasons: string[] = []
  const layers: LayerNegotiation['layers'] = []
  let passingOptional = 0
  for (const layer of LAYER_IDS) {
    const accepted = layer in policy.accepted_layers
    const required = policy.required_layers.includes(layer)
    const shared = shareable.shareable_layers.includes(layer)
    const r = results.find((x) => x.layer === layer)
    const tm = policy.trust_mode_by_layer[layer] ?? null
    if (!shared || !r?.shared) {
      layers.push({ layer, status: 'not-shared', trust_mode: tm, why: [] })
      if (required) reasons.push(`required layer ${layer} not shared`)
      continue
    }
    if (!accepted) { layers.push({ layer, status: 'not-accepted', trust_mode: null, why: ['the lender does not accept this layer; it was not read'] }); continue }
    const why = layerFailures(r, policy)
    if (why.length) {
      layers.push({ layer, status: 'failed', trust_mode: tm, why })
      if (required) reasons.push(`required layer ${layer} failed: ${why[0]}`)
      continue
    }
    if (!required && !r.evidence) { layers.push({ layer, status: 'failed', trust_mode: tm, why: ['nothing to show on this layer yet (no rows, balance, channels or public record); proving control alone earns no LTV'] }); continue }
    layers.push({ layer, status: required ? 'required-pass' : 'optional-pass', trust_mode: tm, why: [] })
    if (!required) passingOptional++
  }
  for (const t of features?.typologies ?? []) if (t.disposition === 'block') reasons.push(`typology ${t.type} blocks (${t.layers.join(' + ')})`)
  if (features?.sanctions.status === 'hit') reasons.push(`sanctions hit on ${features.sanctions.hits.length} address(es) (${features.sanctions.list_version}): ${features.sanctions.hits.map((h) => `hop ${h.hop} ${h.address.slice(0, 14)}…`).join(', ')}`)
  if (reasons.length) return { outcome: 'NO_DEAL', reasons, layers, ltv_bonus_bps: 0 }
  return { outcome: 'DEAL', reasons: [], layers, ltv_bonus_bps: Math.min(policy.ltv_max_bonus_bps, passingOptional * policy.ltv_step_bps) }
}

/**
 * The lender policy the negotiation engine runs with after the layer step:
 * max LTV raised by the bonus, then clamped to the platform's limit for the
 * longest term the lender offers and to an absolute ceiling of 9,000 bps. The
 * returned copy is unsigned and says so; the signed original is unchanged.
 */
export function withLayerLtv(lp: LenderPolicy, bonus: Bps, e: Economics = DEFAULT_ECONOMICS): LenderPolicy & { layer_ltv_bonus_bps: Bps; unsigned_copy: true } {
  const limit = Math.min(maxLtvForTerm(lp.term_blocks.max, e), 9_000)
  const raised = Math.max(lp.max_ltv_bps, Math.min(lp.max_ltv_bps + Math.max(0, bonus), limit))
  return { ...lp, max_ltv_bps: raised, layer_ltv_bonus_bps: raised - lp.max_ltv_bps, unsigned_copy: true }
}
