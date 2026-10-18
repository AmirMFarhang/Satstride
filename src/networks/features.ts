// Deterministic features across layers. Code only: no model reads or writes a
// number here, and the same input always gives the same output.
//
// 1. Net out the borrower's own movements across layers: transfers between
//    proven addresses, opening and closing the borrower's own channels, value
//    coming back from an output the borrower itself funded, and RGB or
//    Lightning transfers from the borrower's own node or Passbook key. Own
//    movements add zero income.
// 2. Count liabilities: open loans and IOUs the borrower disclosed, and BTC
//    locked in known Passbook escrows (found on chain, disclosed or not).
// 3. Weight what remains by evidence level and the lender's layer weights, and
//    report every feature as a band that names its trust mode.
// 4. Typologies, on the existing rule -> typology -> threshold model
//    (src/sandbox/typologies.ts thresholds): LAYER_WASH, HIDDEN_LIABILITY and
//    cross-layer CIRCULAR_FLOW. Privacy tools (CoinJoin-like transactions) are
//    neutral: neither income nor a penalty nor a typology leg.

import type { Hex } from '../core/crypto.js'
import type { Micro } from '../core/money.js'
import type { AddressScreeningResult, ScreeningSubject } from './sanctions.js'
import { keyPathOutput } from '../escrow/escrow.js'
import { TYPOLOGY_SCORE_THRESHOLDS, type TypologyDisposition } from '../sandbox/typologies.js'
import { decodeAddress, scriptToAddress } from './bip322.js'
import type { OwnChannel } from './lightning.js'
import type { EvidenceLevel, HistoryWindow, LayerHistory, LayerId, NormalizedRow, TrustMode } from './types.js'
import { bytesToHex } from '../core/crypto.js'

export const LAYER_FEATURES_POLICY = 'passbook-layer-features-v1'

export interface OwnEntities {
  /** Addresses proven with BIP-322. */
  btc_addresses: string[]
  /** Node keys proven with a node signature. */
  node_pubkeys: Hex[]
  /** The borrower's Passbook party key and any other declared own keys. */
  party_pks: Hex[]
  /** The borrower's own channels, as its node reports them. */
  channels: OwnChannel[]
}

export interface Liabilities {
  open_loans: { loan_id: string; principal: Micro }[]
  ious_held_by_others: { iou_id: string; amount: Micro; holder_pk: Hex }[]
}

/** A Passbook escrow output the platform registry knows (script of the Taproot escrow). */
export interface KnownEscrow { loan_id: string; script: Hex }

/** Share of a row's value that counts, in bps, by evidence level. Defaults from the Add-on 4 brief; the lender policy may change them. */
export interface EvidenceWeights {
  chain_recomputable_known_payer_bps: number
  chain_recomputable_unknown_payer_bps: number
  counterparty_signed_bps: number
  client_side_validated_bps: number
  self_reported_bps: number
}

export const DEFAULT_EVIDENCE_WEIGHTS: Readonly<EvidenceWeights> = Object.freeze({
  chain_recomputable_known_payer_bps: 10_000,
  chain_recomputable_unknown_payer_bps: 7_000,
  counterparty_signed_bps: 10_000,
  client_side_validated_bps: 7_000,
  self_reported_bps: 0,
})

export const LAYER_TYPOLOGY_THRESHOLDS = Object.freeze({ max_return_seconds: 30 * 86_400, min_returned_share_bps: 8_000, seconds_per_block: 600 })
export const LAYER_TYPOLOGY_WEIGHTS = Object.freeze({ LAYER_WASH_DECLARED: 60, LAYER_WASH_UNDECLARED: 100, HIDDEN_LIABILITY: 100, CIRCULAR_FLOW: 100 })

export interface FeatureInput {
  histories: LayerHistory[]
  own: OwnEntities
  liabilities: Liabilities
  known_escrows: KnownEscrow[]
  /** Payers the lender recognises (addresses, node keys, party keys): chain-recomputable rows from them count in full. */
  known_payers: string[]
  weights: EvidenceWeights
  /** The lender's weight per accepted layer, in bps; a layer absent here counts zero. */
  layer_weights_bps: Partial<Record<LayerId, number>>
  trust_modes: Partial<Record<LayerId, TrustMode>>
  /** BTC/USD in cents from the signed oracle quote, so one income band spans layers. */
  price_cents: number
  window: HistoryWindow
  /** The address screening result, gathered before (the screen is async; this module is not). */
  sanctions?: AddressScreeningResult
}

export type RowClass = 'own-movement' | 'coinjoin' | 'income' | 'spend' | 'escrow-lock'
export interface ClassifiedRow { row: NormalizedRow; class: RowClass; why: string; value_micro: bigint; weight_bps: number }

export interface FeatureValue {
  name: string
  layer: LayerId | 'all'
  /** A band or a count label, never a raw amount. */
  value: string
  trust_mode: TrustMode | 'mixed'
  trust_modes: TrustMode[]
  evidence: EvidenceLevel[]
  note?: string
}

export interface LayerTypology {
  type: 'LAYER_WASH' | 'HIDDEN_LIABILITY' | 'CIRCULAR_FLOW'
  matched: boolean
  weight: number
  disposition: TypologyDisposition
  /** Supporting rows. RGB txids are private to the borrower and shown as null. */
  support: { layer: LayerId; txid: Hex | null }[]
  layers: LayerId[]
  rules: { id: string; matched: boolean }[]
  limitations: string[]
}

export interface LayerFeatures {
  policy: typeof LAYER_FEATURES_POLICY
  features: FeatureValue[]
  /** Per-row classification counts; no amounts. */
  rows: { layer: LayerId; class: RowClass; count: number }[]
  typologies: LayerTypology[]
  score: number
  disposition: TypologyDisposition
  /** `not_screened` when no list was checked (the stub), never reported as clear. */
  sanctions: { screen: string; list_version: string; screened: { proven: number; counterparties: number }; hits: { address: string; hop: 0 | 1; via?: string; list_id: string }[]; status: 'not_screened' | 'clear' | 'hit' }
}

// ---- values and bands ----

export function valueMicroUsd(row: Pick<NormalizedRow, 'unit' | 'amount'>, priceCents: number): bigint {
  const amount = BigInt(row.amount)
  if (row.unit === 'micro-usdt') return amount
  if (row.unit === 'sat') return (amount * BigInt(priceCents)) / 10_000n
  return (amount * BigInt(priceCents)) / 10_000_000n
}

const USD_BANDS: [bigint, string][] = [[100n, 'under 100 USD'], [500n, '100-500 USD'], [1_000n, '500-1k USD'], [2_500n, '1k-2.5k USD'], [5_000n, '2.5k-5k USD'], [10_000n, '5k-10k USD']]
export function usdBand(micro: bigint): string {
  if (micro <= 0n) return '0 USD'
  for (const [limit, label] of USD_BANDS) if (micro < limit * 1_000_000n) return label
  return '10k+ USD'
}

export function ageBand(seconds: number | null): string {
  if (seconds === null) return 'unknown'
  const days = Math.floor(seconds / 86_400)
  return days < 30 ? 'under 30 days' : days < 90 ? '30-90 days' : days < 180 ? '90-180 days' : days < 365 ? '180-365 days' : days < 730 ? '1-2 years' : '2+ years'
}

export function countBand(n: number): string {
  return n === 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : n <= 11 ? '6-11' : '12+'
}

function evidenceWeight(row: NormalizedRow, weights: EvidenceWeights, knownPayers: Set<string>): number {
  switch (row.evidence_level) {
    case 'chain-recomputable': return knownPayers.has(row.counterparty) ? weights.chain_recomputable_known_payer_bps : weights.chain_recomputable_unknown_payer_bps
    case 'counterparty-signed': return weights.counterparty_signed_bps
    case 'client-side-validated': return weights.client_side_validated_bps
    default: return weights.self_reported_bps
  }
}

// ---- classification (netting) ----

export function classifyRows(input: Pick<FeatureInput, 'histories' | 'own' | 'known_escrows' | 'known_payers' | 'weights' | 'layer_weights_bps' | 'price_cents'>): ClassifiedRow[] {
  const ownAddr = new Set(input.own.btc_addresses)
  const ownKeys = new Set([...input.own.node_pubkeys, ...input.own.party_pks])
  const channelFunding = new Set(input.own.channels.map((c) => c.funding_txid).filter((t): t is Hex => !!t))
  const escrows = new Map(input.known_escrows.map((e) => [e.script, e.loan_id]))
  const knownPayers = new Set(input.known_payers)
  const rows = input.histories.flatMap((h) => h.rows)
  const fundedByBorrower = new Set(rows.filter((r) => r.layer === 'btc-onchain' && r.direction === 'out').map((r) => r.txid))
  return rows.map((row) => {
    const value_micro = valueMicroUsd(row, input.price_cents)
    const own = (why: string): ClassifiedRow => ({ row, class: 'own-movement', why, value_micro, weight_bps: 0 })
    if (row.links?.coinjoin_like) return { row, class: 'coinjoin', why: 'CoinJoin-like transaction: privacy tools are neutral', value_micro, weight_bps: 0 }
    if (row.layer === 'btc-onchain') {
      if (row.links?.self_transfer) return own('self-transfer between proven addresses')
      if (row.direction === 'out' && channelFunding.has(row.txid)) return own('opened own channel')
      const lock = row.direction === 'out' ? row.links?.outputs?.find((o) => !o.own && escrows.has(o.script)) : undefined
      if (lock) return { row, class: 'escrow-lock', why: `BTC locked in Passbook escrow of loan ${escrows.get(lock.script)}`, value_micro, weight_bps: 0 }
      if (row.direction === 'in' && row.links?.spends?.some((t) => channelFunding.has(t))) return own('closed own channel')
      if (row.direction === 'in' && row.links?.spends?.some((t) => fundedByBorrower.has(t))) return own('returned from an output this borrower funded')
      if (ownAddr.has(row.counterparty)) return own('counterparty is a proven own address')
    } else if (ownKeys.has(row.counterparty) || ownKeys.has(row.counterparty_pk)) {
      return own(input.own.node_pubkeys.includes(row.counterparty) ? 'from or to own node' : 'from or to own Passbook key')
    }
    if (row.direction === 'out') return { row, class: 'spend', why: 'paid to an external counterparty', value_micro, weight_bps: 0 }
    const layerWeight = input.layer_weights_bps[row.layer] ?? 0
    const weight_bps = Math.floor((layerWeight * evidenceWeight(row, input.weights, knownPayers)) / 10_000)
    return { row, class: 'income', why: `external inflow, ${row.evidence_level}`, value_micro, weight_bps }
  })
}

// ---- typologies ----

/** Seconds from a to b, or null when the two rows cannot be ordered (no times and different chains). */
function elapsed(a: NormalizedRow, b: NormalizedRow): number | null {
  if (a.time !== null && b.time !== null) return b.time - a.time
  if (a.chain === b.chain) return (b.height - a.height) * LAYER_TYPOLOGY_THRESHOLDS.seconds_per_block
  return null
}
const withinReturn = (a: NormalizedRow, b: NormalizedRow) => { const s = elapsed(a, b); return s !== null && s >= 0 && s <= LAYER_TYPOLOGY_THRESHOLDS.max_return_seconds }
const reaches = (part: bigint, whole: bigint) => whole > 0n && part * 10_000n >= whole * BigInt(LAYER_TYPOLOGY_THRESHOLDS.min_returned_share_bps)
const disposition = (score: number): TypologyDisposition => score >= TYPOLOGY_SCORE_THRESHOLDS.block ? 'block' : score >= TYPOLOGY_SCORE_THRESHOLDS.alert ? 'alert' : 'clear'
const supportOf = (rows: NormalizedRow[]) => rows.map((r) => ({ layer: r.layer, txid: r.layer === 'rgb' ? null : r.txid }))

/** Value out into an own channel (or into an output the borrower funded) that comes back within 30 days, at least 80% of it. */
export function detectLayerWash(classified: ClassifiedRow[], own: OwnEntities): LayerTypology {
  const declared = new Set(own.channels.map((c) => c.funding_txid).filter((t): t is Hex => !!t))
  const entries = classified.filter((c) => c.row.layer === 'btc-onchain' && c.row.direction === 'out' && c.class !== 'coinjoin')
  const returns = classified.filter((c) => c.class === 'own-movement' && c.row.direction === 'in' && ['closed own channel', 'returned from an output this borrower funded', 'from or to own node'].includes(c.why))
  let match: { entry: ClassifiedRow; back: ClassifiedRow; declared: boolean } | null = null
  for (const entry of entries) {
    const intoChannel = declared.has(entry.row.txid) || returns.some((r) => r.row.links?.spends?.includes(entry.row.txid))
    if (!intoChannel) continue
    for (const back of returns) {
      const linked = back.row.links?.spends?.includes(entry.row.txid) || (back.why === 'from or to own node' && declared.has(entry.row.txid))
      if (!linked || !withinReturn(entry.row, back.row) || !reaches(back.value_micro, entry.value_micro)) continue
      const isDeclared = declared.has(entry.row.txid)
      if (!match || (match.declared && !isDeclared)) match = { entry, back, declared: isDeclared }
    }
  }
  const weight = match ? (match.declared ? LAYER_TYPOLOGY_WEIGHTS.LAYER_WASH_DECLARED : LAYER_TYPOLOGY_WEIGHTS.LAYER_WASH_UNDECLARED) : 0
  return {
    type: 'LAYER_WASH', matched: !!match, weight, disposition: disposition(weight),
    support: match ? supportOf([match.entry.row, match.back.row]) : [],
    layers: match ? [...new Set([match.entry.row.layer, 'lightning' as const, match.back.row.layer])] : [],
    rules: [
      { id: 'value_entered_own_channel', matched: !!match },
      { id: 'value_returned_within_30_days', matched: !!match },
      { id: 'returned_at_least_80_percent', matched: !!match },
      { id: 'channel_not_declared', matched: !!match && !match.declared },
    ],
    limitations: ['Own movements are already netted to zero income; the typology tells the lender a round trip happened.', 'Declared round trips are an alert; a channel the node did not declare, found from the chain, is a block.', 'Legs on different chains without block times cannot be ordered and are not matched.'],
  }
}

/** BTC locked in a known Passbook escrow whose loan the borrower did not disclose. */
export function detectHiddenLiability(classified: ClassifiedRow[], liabilities: Liabilities, escrows: KnownEscrow[]): LayerTypology {
  const disclosed = new Set(liabilities.open_loans.map((l) => l.loan_id))
  const byScript = new Map(escrows.map((e) => [e.script, e.loan_id]))
  const locks = classified.filter((c) => c.class === 'escrow-lock')
  const hidden = locks.filter((c) => c.row.links?.outputs?.some((o) => !o.own && byScript.has(o.script) && !disclosed.has(byScript.get(o.script)!)))
  const weight = hidden.length ? LAYER_TYPOLOGY_WEIGHTS.HIDDEN_LIABILITY : 0
  return {
    type: 'HIDDEN_LIABILITY', matched: hidden.length > 0, weight, disposition: disposition(weight),
    support: supportOf(hidden.map((c) => c.row)), layers: hidden.length ? ['btc-onchain'] : [],
    rules: [{ id: 'btc_locked_in_known_passbook_escrow', matched: locks.length > 0 }, { id: 'loan_not_disclosed', matched: hidden.length > 0 }],
    limitations: ['Only escrows the platform registry knows, paid from proven addresses, are found.', 'IOUs held by others count only when disclosed in this release.'],
  }
}

/** The script a Passbook party key controls on chain (BIP-86 key path): links an RGB counterparty to its Bitcoin address. */
function partyScript(pk: string): Hex | null {
  if (!/^[0-9a-f]{64}$/.test(pk) || /^0+$/.test(pk)) return null
  try { return keyPathOutput(pk).script } catch { return null }
}

function scriptsOf(row: NormalizedRow, side: 'payer' | 'recipient'): Set<string> {
  const out = new Set<string>()
  if (row.layer === 'btc-onchain') {
    if (side === 'payer') for (const s of row.links?.input_scripts ?? []) out.add(s)
    else for (const o of row.links?.outputs ?? []) if (!o.own) out.add(o.script)
    return out
  }
  const s = partyScript(row.counterparty_pk) ?? partyScript(row.counterparty)
  if (s) out.add(s)
  out.add(`id:${row.counterparty}`)
  return out
}

/** Paid out to a counterparty on one layer, back from the same counterparty (linked across layers) within 30 days, at least 80%. */
export function detectCircularFlow(classified: ClassifiedRow[]): LayerTypology {
  const spends = classified.filter((c) => c.class === 'spend')
  const income = classified.filter((c) => c.class === 'income')
  let match: { out: ClassifiedRow; back: ClassifiedRow } | null = null
  for (const out of spends) {
    const to = scriptsOf(out.row, 'recipient')
    if (out.row.layer === 'btc-onchain') to.add(`id:${out.row.counterparty}`)
    for (const back of income) {
      const from = scriptsOf(back.row, 'payer')
      if (back.row.layer === 'btc-onchain') from.add(`id:${back.row.counterparty}`)
      if (![...from].some((s) => to.has(s)) || !withinReturn(out.row, back.row) || !reaches(back.value_micro, out.value_micro)) continue
      if (!match || (match.out.row.layer === match.back.row.layer && out.row.layer !== back.row.layer)) match = { out, back }
    }
  }
  const weight = match ? LAYER_TYPOLOGY_WEIGHTS.CIRCULAR_FLOW : 0
  return {
    type: 'CIRCULAR_FLOW', matched: !!match, weight, disposition: disposition(weight),
    support: match ? supportOf([match.out.row, match.back.row]) : [],
    layers: match ? [...new Set([match.out.row.layer, match.back.row.layer])] : [],
    rules: [
      { id: 'paid_external_counterparty', matched: spends.length > 0 },
      { id: 'same_counterparty_paid_back', matched: !!match },
      { id: 'cross_layer', matched: !!match && match.out.row.layer !== match.back.row.layer },
    ],
    limitations: ['Counterparties are linked across layers only by keys Passbook can tie together (a party key and its BIP-86 address, or the same address).', 'Temporal amount matching is not coin lineage.'],
  }
}

// ---- features ----

export function computeFeatures(input: FeatureInput): LayerFeatures {
  const classified = classifyRows(input)
  const months = Math.max(1, Math.ceil((input.window.to_time - input.window.from_time) / (30 * 86_400)))
  const features: FeatureValue[] = []
  const modeOf = (layer: LayerId): TrustMode => input.trust_modes[layer] ?? 'borrower-device'
  const layers = [...new Set(input.histories.map((h) => h.layer))]
  for (const h of input.histories) {
    const mine = classified.filter((c) => c.row.layer === h.layer)
    const income = mine.filter((c) => c.class === 'income')
    const weighted = income.reduce((s, c) => s + (c.value_micro * BigInt(c.weight_bps)) / 10_000n, 0n)
    const evidence = [...new Set(mine.map((c) => c.row.evidence_level))]
    const tm = modeOf(h.layer)
    const base = { layer: h.layer, trust_mode: tm, trust_modes: [tm], evidence }
    features.push({ name: 'weighted_income_per_month', ...base, value: usdBand(weighted / BigInt(months)), note: `average over the window, weighted by evidence level and the lender's layer weight (${input.layer_weights_bps[h.layer] ?? 0} bps)` })
    const activeMonths = new Set(income.concat(mine.filter((c) => c.class === 'spend')).map((c) => (c.row.time === null ? `h${Math.floor(c.row.height / 30)}` : `t${Math.floor(c.row.time / (30 * 86_400))}`))).size
    features.push({ name: 'months_with_external_activity', ...base, value: countBand(activeMonths) })
    if (h.first_seen_time !== null) features.push({ name: 'wallet_age', ...base, value: ageBand(input.window.to_time - h.first_seen_time) })
    if (h.balance !== null) features.push({ name: 'balance', ...base, value: usdBand(valueMicroUsd({ unit: h.layer === 'rgb' ? 'micro-usdt' : 'sat', amount: h.balance }, input.price_cents)) })
    const own = mine.filter((c) => c.class === 'own-movement')
    features.push({ name: 'own_movements_netted', ...base, value: `${countBand(own.length)} rows, ${usdBand(own.reduce((s, c) => s + c.value_micro, 0n))}`, note: 'counted as zero income' })
    const cj = mine.filter((c) => c.class === 'coinjoin').length
    if (h.layer === 'btc-onchain') features.push({ name: 'privacy_tools', ...base, value: cj ? `used (${countBand(cj)} transactions), neutral` : 'none seen', note: 'neutral by default: neither income nor a penalty' })
  }
  const allModes = [...new Set(layers.map(modeOf))]
  const allEvidence = [...new Set(classified.map((c) => c.row.evidence_level))]
  const total = classified.filter((c) => c.class === 'income').reduce((s, c) => s + (c.value_micro * BigInt(c.weight_bps)) / 10_000n, 0n)
  features.push({ name: 'weighted_income_per_month', layer: 'all', value: usdBand(total / BigInt(months)), trust_mode: allModes.length === 1 ? allModes[0] : 'mixed', trust_modes: allModes, evidence: allEvidence, note: `BTC converted at the oracle price; each layer keeps its own trust mode` })
  const escrowLocked = classified.filter((c) => c.class === 'escrow-lock').reduce((s, c) => s + c.value_micro, 0n)
  const liabilities = BigInt(input.liabilities.open_loans.reduce((s, l) => s + l.principal, 0) + input.liabilities.ious_held_by_others.reduce((s, i) => s + i.amount, 0))
  const liabilityCount = input.liabilities.open_loans.length + input.liabilities.ious_held_by_others.length + classified.filter((c) => c.class === 'escrow-lock').length
  features.push({ name: 'liabilities', layer: 'all', value: `${countBand(liabilityCount)} items, ${usdBand(liabilities + escrowLocked)}`, trust_mode: escrowLocked > 0n ? 'mixed' : 'borrower-device', trust_modes: escrowLocked > 0n ? ['borrower-device', 'lender-recompute'] : ['borrower-device'], evidence: escrowLocked > 0n ? ['self-reported', 'chain-recomputable'] : ['self-reported'], note: 'disclosed open loans and IOUs held by others, plus BTC found locked in known Passbook escrows' })
  const typologies = [detectLayerWash(classified, input.own), detectHiddenLiability(classified, input.liabilities, input.known_escrows), detectCircularFlow(classified)]
  const score = Math.min(100, typologies.reduce((s, t) => s + t.weight, 0))
  const counts = new Map<string, number>()
  for (const c of classified) counts.set(`${c.row.layer}|${c.class}`, (counts.get(`${c.row.layer}|${c.class}`) ?? 0) + 1)
  const sx = input.sanctions
  const hits = (sx?.hits ?? []).map((h) => ({ address: h.address, hop: h.hop, ...(h.via ? { via: h.via } : {}), list_id: h.list_id }))
  return {
    policy: LAYER_FEATURES_POLICY,
    features,
    rows: [...counts].map(([k, count]) => { const [layer, cls] = k.split('|'); return { layer: layer as LayerId, class: cls as RowClass, count } }),
    typologies,
    score,
    disposition: disposition(score),
    sanctions: { screen: sx?.screen ?? 'none', list_version: sx?.list_version ?? 'none', screened: sx?.screened ?? { proven: 0, counterparties: 0 }, hits, status: hits.length || sx?.status === 'hit' ? 'hit' : sx && sx.lists.length > 0 ? 'clear' : 'not_screened' },
  }
}

/**
 * The governance screen's subject (src/compliance/sanctions.ts): the proven
 * Bitcoin addresses (hop 0) and the addresses that paid them or that they paid
 * (hop 1), from the on-chain rows. Lightning node keys and RGB party keys are
 * not addresses and are not on the address lists. CoinJoin rows are left out:
 * privacy tools are neutral.
 */
export function sanctionsSubject(histories: LayerHistory[], own: OwnEntities, subjectPk?: Hex, chain: 'bitcoin' | 'signet' | 'regtest' = 'bitcoin'): ScreeningSubject {
  const proven = new Set(own.btc_addresses)
  const byScript = new Map(own.btc_addresses.map((a) => [addressScript(a, chain), a]))
  const counterparties = new Map<string, { address: string; of: string; txid?: string }>()
  for (const h of histories) for (const r of h.rows) {
    if (r.layer !== 'btc-onchain' || r.links?.coinjoin_like || r.links?.self_transfer) continue
    const of = r.links?.outputs?.map((o) => byScript.get(o.script)).find((a): a is string => !!a) ?? own.btc_addresses[0]
    if (!of) continue
    const addresses = r.direction === 'in'
      ? (r.links?.input_scripts ?? []).map((s) => (s === 'coinbase' || s === 'unknown' ? null : scriptToAddress(s, chain)))
      : (r.links?.outputs ?? []).filter((o) => !o.own && !o.script.startsWith('6a')).map((o) => scriptToAddress(o.script, chain))
    for (const a of addresses) if (a && !proven.has(a) && !counterparties.has(`${a}|${of}`)) counterparties.set(`${a}|${of}`, { address: a, of, txid: r.txid })
  }
  return { ...(subjectPk ? { subject_pk: subjectPk } : {}), proven_addresses: [...proven], counterparties: [...counterparties.values()] }
}

/** For tests and callers that hold addresses: the scriptPubKey hex of a proven address. */
export const addressScript = (address: string, chain: 'bitcoin' | 'signet' | 'regtest') => bytesToHex(decodeAddress(address, chain).script)
