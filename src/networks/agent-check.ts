// `passbook agent check`: the credit agent on the borrower's device reads the
// layers the borrower shares (RGB, Bitcoin mainnet, Lightning), and the lender
// checks what it can itself. Both roles run here, each with its own source:
//
//   lender  issues one challenge per layer and subject (negotiation, lender key, expiry, nonce)
//   device  proves control: the person's wallet signs (BIP-322), the node signs, the party key signs
//   lender  verifies each proof
//   device  reads the consented layers' history from the device's own source
//   lender  recomputes the on-chain rows from ITS OWN source and names any row that differs
//   both    deterministic features, typologies and sanctions screening (code, not a model)
//   lender  intersects its layer policy with what was shared: NO_DEAL with a reason, or an LTV bonus, bounded and clamped
//
// Every number in the result carries its trust mode. The device never sees a
// mainnet key; the lender never takes the device's indexer.

import { hashObject, isHex, randomHex, type Hex, type KeyPair } from '../core/crypto.js'
import { NETWORK as ESCROW_NETWORK } from '../escrow/escrow.js'
import { rgbConfigFromEnv } from '../rgb/wallet.js'
import { BtcOnchainAdapter } from './btc-onchain.js'
import type { BitcoinSource } from './bitcoin-source.js'
import { issueChallenge } from './challenge.js'
import { computeFeatures, sanctionsSubject, type KnownEscrow, type LayerFeatures, type Liabilities } from './features.js'
import { assertTxNetworks, loanChainFromEnv, refuseSecret, type LoanChain } from './guard.js'
import type { LightningAdapter, LightningHistory } from './lightning.js'
import { layerConsentProblems, negotiateLayers, signLayerConsent, type BorrowerShareable, type LayerConsent, type LayerNegotiation, type LayerResult, type LenderLayerPolicy } from './policy.js'
import type { RgbAdapter } from './rgb.js'
import type { SanctionsScreen } from './sanctions.js'
import type { ChainId, ControlChallenge, ControlProof, ControlVerdict, HistoryWindow, LayerHistory, LayerId, RecomputeResult, SourceCall } from './types.js'

export const AGENT_CHECK_VERSION = 'passbook-agent-check-v1' as const
const MAX_SCREENED = 200

/** The lender's book of issued challenges: single use, looked up by layer and subject. Public data only. */
export class ChallengeBook {
  private readonly byNonce = new Map<Hex, ControlChallenge>()
  private readonly used = new Set<Hex>()
  constructor(readonly lender_pk: Hex, readonly negotiation_id: Hex, issued: ControlChallenge[] = []) {
    for (const c of issued) this.byNonce.set(c.nonce, c)
  }
  issue(layer: LayerId, chain: ChainId, subject: string, now = Math.floor(Date.now() / 1000), ttl_seconds?: number): ControlChallenge {
    const c = issueChallenge({ layer, chain, subject, negotiation_id: this.negotiation_id, lender_pk: this.lender_pk, now, ...(ttl_seconds ? { ttl_seconds } : {}) })
    this.byNonce.set(c.nonce, c)
    return c
  }
  /** The newest unexpired, unused challenge for this layer and subject; null when none. */
  current(layer: LayerId, subject: string, now = Math.floor(Date.now() / 1000)): ControlChallenge | null {
    const all = [...this.byNonce.values()].filter((c) => c.layer === layer && c.subject === subject && c.expires_at >= now && !this.used.has(c.nonce))
    return all.sort((a, b) => b.issued_at - a.issued_at)[0] ?? null
  }
  issued(nonce: Hex): ControlChallenge | undefined { return this.byNonce.get(nonce) }
  consume(nonce: Hex): boolean { if (this.used.has(nonce)) return false; this.used.add(nonce); return true }
  toJSON() { return { lender_pk: this.lender_pk, negotiation_id: this.negotiation_id, issued: [...this.byNonce.values()], used: [...this.used] } }
  static fromJSON(j: { lender_pk: Hex; negotiation_id: Hex; issued: ControlChallenge[]; used?: Hex[] }): ChallengeBook {
    const b = new ChallengeBook(j.lender_pk, j.negotiation_id, j.issued)
    for (const n of j.used ?? []) b.used.add(n)
    return b
  }
}

export interface AgentCheckConfig {
  history_chain: ChainId
  window_days: number
  /** The device's source (credit.sources.bitcoin). */
  borrower_source: BitcoinSource
  /** The lender's own source (credit.lender_sources.bitcoin): a different indexer. */
  lender_source: BitcoinSource
  policy: LenderLayerPolicy
  /** BTC/USD cents from the demo oracle, for one income band across layers. */
  price_cents: number
  sanctions: SanctionsScreen
  known_escrows: KnownEscrow[]
  liabilities: Liabilities
  loan_chain?: LoanChain
  now?: number
}

export interface DeviceInputs {
  borrower: KeyPair
  shareable: BorrowerShareable
  rgb?: RgbAdapter | null
  lightning?: LightningAdapter | null
  /** BIP-322 signatures the person made in their own wallet, by address. */
  btc_signatures: Record<string, string>
}

export interface AgentCheckResult {
  v: 1
  kind: typeof AGENT_CHECK_VERSION
  negotiation_id: Hex
  lender_pk: Hex
  borrower_pk: Hex
  history_chain: ChainId
  loan_chain: LoanChain
  window: HistoryWindow & { days: number }
  price: { cents: number; source: string }
  /** Challenges still waiting for a signature from the person's own wallet. */
  awaiting_signature: ControlChallenge[]
  consents: LayerConsent[]
  layers: (LayerResult & { trust_mode: string | null; source: string | null; lender_source: string | null; height: number | null; rows: number; first_seen_time: number | null })[]
  recompute: RecomputeResult[]
  lightning: { node_pubkey: Hex | null; public_facts: LightningHistory['public_facts']; channels: number } | null
  features: LayerFeatures | null
  negotiation: LayerNegotiation
  source_calls: SourceCall[]
  decided_by: 'code: every number here comes from deterministic code; no model produced one'
  result_hash: Hex
}

const DAY = 86_400

/** Runs the lender's and the device's steps. Pure orchestration; no key leaves the device and no transaction is built. */
export async function runAgentCheck(cfg: AgentCheckConfig, device: DeviceInputs, book: ChallengeBook): Promise<AgentCheckResult> {
  const loan_chain = cfg.loan_chain ?? loanChainFromEnv()
  assertTxNetworks({ loanChain: loan_chain, escrowBech32: ESCROW_NETWORK.bech32, rgbNetwork: rgbConfigFromEnv().network })
  const now = cfg.now ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(cfg.window_days) || cfg.window_days < 1 || cfg.window_days > 3650) throw new Error('window must be 1 to 3650 days')
  const window: HistoryWindow = { from_time: now - cfg.window_days * DAY, to_time: now }
  const { lender_pk, negotiation_id } = book
  const borrower_pk = device.borrower.pubkey
  // A layer the lender does not accept is never read: no proof, no consent, no source call, no rows downstream.
  const accepted = (layer: LayerId) => layer in cfg.policy.accepted_layers
  const shared = new Set(device.shareable.shareable_layers.filter(accepted))
  const results: LayerResult[] = []
  const consents: LayerConsent[] = []
  const awaiting: ControlChallenge[] = []
  const histories: LayerHistory[] = []
  const recompute: RecomputeResult[] = []
  const lenderBtc = new BtcOnchainAdapter(cfg.history_chain, cfg.lender_source)
  const deviceBtc = new BtcOnchainAdapter(cfg.history_chain, cfg.borrower_source)
  let lightning: AgentCheckResult['lightning'] = null
  const meta = new Map<LayerId, { source: string | null; lender_source: string | null; height: number | null; rows: number; first_seen_time: number | null }>()

  const consent = (layer: LayerId, subject: string, chain: ChainId): LayerConsent => {
    const c = signLayerConsent(device.borrower, { lender_pk, negotiation_id, layer, chain, subject, trust_mode: cfg.policy.trust_mode_by_layer[layer] ?? 'borrower-device', scope: 'proof-and-history', window_days: cfg.window_days, issued_at: now, expires_at: now + 6 * 3600 })
    consents.push(c)
    return c
  }
  const consentOk = (c: LayerConsent) => layerConsentProblems(c, { borrower_pk, lender_pk, negotiation_id, now }).length === 0
  const verify = (adapter: { verifyControl(p: ControlProof, e: { negotiation_id: Hex; lender_pk: Hex; now: number; issued?: ControlChallenge }): ControlVerdict }, proof: ControlProof): ControlVerdict => {
    const issued = book.issued(proof.challenge.nonce)
    const v = adapter.verifyControl(proof, { negotiation_id, lender_pk, now, ...(issued ? { issued } : {}) })
    if (!issued) return { ...v, ok: false, reasons: [...v.reasons, 'CHALLENGE_NOT_ISSUED'] }
    if (v.ok && !book.consume(issued.nonce)) return { ...v, ok: false, reasons: ['CHALLENGE_ALREADY_USED'] }
    return v
  }

  // ---- rgb ----
  if (shared.has('rgb')) {
    const r: LayerResult = { layer: 'rgb', shared: true, consented: false, control: [], recompute: null, wallet_age_days: null, evidence: false, limits: [] }
    if (!device.rgb) r.limits.push('NO_RGB_WALLET_ON_DEVICE')
    else {
      r.consented = consentOk(consent('rgb', borrower_pk, device.rgb.chain))
      const ch = book.current('rgb', borrower_pk, now) ?? book.issue('rgb', device.rgb.chain, borrower_pk, now)
      try { r.control.push(verify(device.rgb, await device.rgb.proveControl(ch))) } catch (e) { r.limits.push(`RGB_PROOF_FAILED: ${(e as Error).message.slice(0, 80)}`) }
      if (r.consented && r.control.every((v) => v.ok) && r.control.length) {
        const h = await device.rgb.history([borrower_pk], window)
        histories.push(h)
        r.evidence = h.rows.length > 0
        r.limits.push(...h.limits)
        meta.set('rgb', { source: h.source, lender_source: null, height: h.height, rows: h.rows.length, first_seen_time: null })
      }
    }
    results.push(r)
  }

  // ---- lightning ----
  if (shared.has('lightning')) {
    const r: LayerResult = { layer: 'lightning', shared: true, consented: false, control: [], recompute: null, wallet_age_days: null, evidence: false, limits: [] }
    const node = device.shareable.subjects.lightning?.[0]
    if (!device.lightning || !node) r.limits.push('NO_LIGHTNING_NODE_ON_DEVICE')
    else {
      r.consented = consentOk(consent('lightning', node, device.lightning.chain))
      const ch = book.current('lightning', node, now) ?? book.issue('lightning', device.lightning.chain, node, now)
      try { r.control.push(verify(device.lightning, await device.lightning.proveControl(ch))) } catch (e) { r.limits.push(`NODE_PROOF_FAILED: ${(e as Error).message.slice(0, 80)}`) }
      if (r.consented && r.control.length && r.control.every((v) => v.ok)) {
        const h = await device.lightning.history([node], window)
        histories.push(h)
        r.limits.push(...h.limits)
        lightning = { node_pubkey: h.node_pubkey, public_facts: h.public_facts, channels: h.own_channels.length }
        r.evidence = h.own_channels.length > 0 || !!h.public_facts
        r.wallet_age_days = h.public_facts?.first_seen ? Math.floor((now - h.public_facts.first_seen) / DAY) : null
        meta.set('lightning', { source: h.source, lender_source: h.public_facts?.source ?? null, height: null, rows: 0, first_seen_time: h.first_seen_time })
      }
    }
    results.push(r)
  }

  // ---- btc-onchain ----
  if (shared.has('btc-onchain')) {
    const r: LayerResult = { layer: 'btc-onchain', shared: true, consented: false, control: [], recompute: null, wallet_age_days: null, evidence: false, limits: [] }
    const addresses = device.shareable.subjects['btc-onchain'] ?? []
    if (!addresses.length) r.limits.push('NO_ADDRESS_SHARED')
    const proven: string[] = []
    let allConsented = addresses.length > 0
    for (const address of addresses) {
      refuseSecret(address, 'address')
      allConsented = consentOk(consent('btc-onchain', address, cfg.history_chain)) && allConsented
      const ch = book.current('btc-onchain', address, now) ?? book.issue('btc-onchain', cfg.history_chain, address, now)
      const sig = device.btc_signatures[address]
      if (!sig) { awaiting.push(ch); r.limits.push(`AWAITING_SIGNATURE:${address}`); continue }
      refuseSecret(sig, 'signature')
      const v = verify(lenderBtc, await deviceBtc.proveControl(ch, { signature: sig }))
      r.control.push(v)
      if (v.ok) proven.push(address)
    }
    r.consented = allConsented
    if (r.consented && proven.length && proven.length === addresses.length) {
      try {
        const h = await deviceBtc.history(proven, window)
        r.limits.push(...h.limits)
        const rc = await lenderBtc.recompute(h, window)
        r.recompute = rc
        recompute.push(rc)
        // The lender's features use its own reading; the device's rows are kept only for the comparison.
        histories.push(rc.ok && rc.lender_history ? rc.lender_history : h)
        r.wallet_age_days = h.first_seen_time === null ? 0 : Math.floor((now - h.first_seen_time) / DAY)
        r.evidence = h.rows.length > 0 || (h.balance ?? 0) > 0
        meta.set('btc-onchain', { source: h.source, lender_source: rc.source, height: rc.height, rows: h.rows.length, first_seen_time: h.first_seen_time })
      } catch (e) {
        r.limits.push(`HISTORY_UNAVAILABLE: ${(e as Error).message.slice(0, 100)}`)
      }
    }
    results.push(r)
  }

  for (const layer of device.shareable.shareable_layers) {
    if (!accepted(layer) && !results.some((r) => r.layer === layer)) results.push({ layer, shared: true, consented: false, control: [], recompute: null, wallet_age_days: null, evidence: false, limits: ['NOT_ACCEPTED_BY_LENDER: not read'] })
  }

  // ---- features, screening, policy ----
  let features: LayerFeatures | null = null
  if (histories.length) {
    const lnHistory = histories.find((h) => h.layer === 'lightning') as LightningHistory | undefined
    const own = {
      btc_addresses: results.find((r) => r.layer === 'btc-onchain')?.control.filter((v) => v.ok).map((v) => v.subject) ?? [],
      node_pubkeys: results.find((r) => r.layer === 'lightning')?.control.filter((v) => v.ok).map((v) => v.subject) ?? [],
      party_pks: [borrower_pk],
      channels: lnHistory?.own_channels ?? [],
    }
    const subject = sanctionsSubject(histories, own, borrower_pk, cfg.history_chain)
    const screened = await cfg.sanctions.screen({ ...subject, counterparties: (subject.counterparties ?? []).slice(0, MAX_SCREENED) })
    const layerWeights = Object.fromEntries(Object.entries(cfg.policy.accepted_layers))
    features = computeFeatures({ histories, own, liabilities: cfg.liabilities, known_escrows: cfg.known_escrows, known_payers: cfg.policy.known_payers, weights: cfg.policy.evidence_weights, layer_weights_bps: layerWeights, trust_modes: cfg.policy.trust_mode_by_layer, price_cents: cfg.price_cents, window, sanctions: screened })
  }
  const negotiation = awaiting.length
    ? { outcome: 'NO_DEAL' as const, reasons: [`waiting for ${awaiting.length} BIP-322 signature(s) from the borrower's own wallet`], layers: [], ltv_bonus_bps: 0 }
    : negotiateLayers(cfg.policy, device.shareable, results, features)
  const body = {
    v: 1 as const, kind: AGENT_CHECK_VERSION, negotiation_id, lender_pk, borrower_pk, history_chain: cfg.history_chain, loan_chain,
    window: { ...window, days: cfg.window_days }, price: { cents: cfg.price_cents, source: 'demo oracle quote' },
    awaiting_signature: awaiting, consents,
    layers: results.map((r) => ({ ...r, trust_mode: cfg.policy.trust_mode_by_layer[r.layer] ?? null, ...(meta.get(r.layer) ?? { source: null, lender_source: null, height: null, rows: 0, first_seen_time: null }) })),
    recompute: recompute.map(({ lender_history: _own, ...rc }) => rc),
    lightning, features, negotiation,
    source_calls: [
      ...cfg.borrower_source.calls.map((c) => ({ ...c, note: `device${c.note ? `: ${c.note}` : ''}` })),
      ...cfg.lender_source.calls.map((c) => ({ ...c, note: `lender${c.note ? `: ${c.note}` : ''}` })),
      ...histories.filter((h) => h.layer === 'lightning').flatMap((h) => h.calls).map((c) => ({ ...c, note: `device: lightning public facts${c.note ? `: ${c.note}` : ''}` })),
    ],
    decided_by: 'code: every number here comes from deterministic code; no model produced one' as const,
  }
  return { ...body, result_hash: hashObject(body) }
}

/** A standalone check outside a live negotiation still binds a fresh negotiation id. */
export function standaloneNegotiationId(borrowerPk: Hex): Hex {
  if (!isHex(borrowerPk, 32)) throw new Error('borrower key must be 32-byte hex')
  return hashObject({ kind: 'passbook-standalone-layer-check', borrower_pk: borrowerPk, nonce: randomHex(16) })
}

/** One-line, number-free summary per layer for the panel and the terminal (templates, no model). */
export function describeOutcome(r: AgentCheckResult): string[] {
  const lines: string[] = []
  for (const l of r.layers) {
    const control = l.control.length ? (l.control.every((v) => v.ok) ? 'control proven' : `control failed (${l.control.flatMap((v) => v.reasons).join(', ')})`) : 'control not proven'
    const rc = l.recompute ? (l.recompute.ok ? `lender recomputed from ${l.recompute.source}: all rows match` : `lender recompute differs: ${[...l.recompute.tampered.map((t) => `${t.txid.slice(0, 10)}… ${t.field}`), ...l.recompute.missing.map((t) => `${t.slice(0, 10)}… missing`), ...l.recompute.unknown.map((t) => `${t.slice(0, 10)}… unknown`)].join('; ') || 'source incomplete'}`) : ''
    lines.push(`${l.layer}: ${control}${rc ? `; ${rc}` : ''}${l.trust_mode ? ` [${l.trust_mode}]` : ''}`)
  }
  lines.push(r.negotiation.outcome === 'NO_DEAL' ? `NO_DEAL: ${r.negotiation.reasons.join('; ')}` : r.negotiation.ltv_bonus_bps > 0 ? `layers agree with the lender's policy; its LTV bound moves by the optional-layer bonus` : `layers agree with the lender's policy; no optional layer adds LTV`)
  return lines
}
