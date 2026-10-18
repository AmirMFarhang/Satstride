// The lightning layer: proof that the borrower runs a node, and the public
// facts about it. Two proof formats, both verified by recovering the node key:
//
// - ln-signmessage: LDK/LND message signing, zbase32 of [31 + recovery id | r | s]
//   over sha256d("Lightning Signed Message:" || message).
// - ln-invoice: a BOLT11 invoice (no amount, short expiry) whose description is
//   the challenge text; the node key signs every invoice it creates.
//
// Checked against the pinned RGB Lightning Node (d4762ac): its /signmessage
// signs `message.as_bytes()[message.len()..]`, an EMPTY slice, so it returns
// the same signature for every message and proves nothing about a challenge
// (test/fixtures/networks/rln-signmessage.json). The verifier refuses any
// signature that is also valid for the empty message, and the RLN adapter
// proves control with a challenge invoice instead. Public facts (age,
// channels, capacity, closes) come from a public graph source on mainnet; a
// regtest node has none, and says so.
//
// Built: node proof and public node facts. After the hackathon: payment proofs
// (a payee-signed or preimage-backed record per payment), so this layer adds no
// history rows today and never moves income.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { isHex, type Hex } from '../core/crypto.js'
import { decodeInvoice } from './bolt11.js'
import { challengeProblems } from './challenge.js'
import type { ChainId, ControlChallenge, ControlProof, ControlVerdict, HistoryWindow, LayerAdapter, LayerHistory, LayerVisibility, SourceCall, VerifyExpectation } from './types.js'

const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const LN_PREFIX = 'Lightning Signed Message:'

export function zbase32Decode(text: string): Uint8Array {
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of text) {
    const i = ZBASE32.indexOf(ch)
    if (i < 0) throw new Error('not zbase32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Uint8Array.from(out)
}

export function zbase32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) { out += ZBASE32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31]
  return out
}

export function lnMessageHash(message: string): Uint8Array {
  return sha256(sha256(utf8ToBytes(LN_PREFIX + message)))
}

/** The compressed node key that signed `message`, or null. */
export function recoverLnSigner(message: string, signature: string): Hex | null {
  try {
    const raw = zbase32Decode(signature)
    if (raw.length !== 65 || raw[0] < 31 || raw[0] > 34) return null
    const sig = secp256k1.Signature.fromBytes(raw.slice(1), 'compact').addRecoveryBit(raw[0] - 31)
    if (sig.hasHighS()) return null
    return bytesToHex(sig.recoverPublicKey(lnMessageHash(message)).toBytes(true))
  } catch {
    return null
  }
}

export function verifyLnMessage(message: string, signature: string, nodePubkey: Hex): boolean {
  return isHex(nodePubkey, 33) && recoverLnSigner(message, signature) === nodePubkey
}

/** The borrower's node, as RGB Lightning Node's REST API exposes it. */
export interface LightningNodeApi {
  nodeInfo(): Promise<{ pubkey: Hex }>
  signMessage(message: string): Promise<string>
  /** A BOLT11 invoice with no amount whose description is `description`. */
  descriptionInvoice(description: string, expirySec: number): Promise<string>
  listChannels(): Promise<OwnChannel[]>
}

/** Seconds a challenge invoice stays payable; nobody is expected to pay it. */
export const CHALLENGE_INVOICE_EXPIRY = 600

export interface OwnChannel {
  channel_id: string
  funding_txid: Hex | null
  peer_pubkey: Hex
  capacity_sat: number
  asset_id: string | null
  ready: boolean
}

export class RlnNodeApi implements LightningNodeApi {
  constructor(readonly url: string, private readonly token?: string, private readonly timeoutMs = 15_000) {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`RGB Lightning ${path}: HTTP ${res.status}`)
    return await res.json() as T
  }
  async nodeInfo(): Promise<{ pubkey: Hex }> { return { pubkey: (await this.request<{ pubkey: Hex }>('/nodeinfo')).pubkey } }
  async signMessage(message: string): Promise<string> { return (await this.request<{ signed_message: string }>('/signmessage', { message })).signed_message }
  async descriptionInvoice(description: string, expirySec: number): Promise<string> { return (await this.request<{ invoice: string }>('/lninvoice', { amt_msat: null, expiry_sec: expirySec, description })).invoice }
  async listChannels(): Promise<OwnChannel[]> {
    const r = await this.request<{ channels: { channel_id: string; funding_txid?: string | null; peer_pubkey: string; capacity_sat: number; asset_id?: string | null; ready?: boolean }[] }>('/listchannels')
    return r.channels.map((c) => ({ channel_id: c.channel_id, funding_txid: c.funding_txid && isHex(c.funding_txid, 32) ? c.funding_txid : null, peer_pubkey: c.peer_pubkey, capacity_sat: c.capacity_sat, asset_id: c.asset_id ?? null, ready: !!c.ready }))
  }
}

/** Public facts about a node from the public channel graph. Null when the node is not public (or on regtest). */
export interface NodeFacts {
  source: string
  first_seen: number | null
  active_channels: number | null
  capacity_sat: number | null
  closed_channels: number | null
  /** Force closes among the most recently closed channels the source returned, with how many were looked at. */
  force_closes_sampled: { force: number; sampled: number } | null
}

export interface NodeFactsSource {
  readonly label: string
  readonly calls: SourceCall[]
  facts(pubkey: Hex): Promise<NodeFacts | null>
}

/** mempool.space's Lightning API (mainnet graph). */
export class MempoolLightningFacts implements NodeFactsSource {
  readonly calls: SourceCall[] = []
  readonly label: string
  constructor(baseUrl = 'https://mempool.space/api', private readonly timeoutMs = 15_000) { this.label = baseUrl.replace(/\/$/, '') }
  private async get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${this.label}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) })
      this.calls.push({ at: Math.floor(Date.now() / 1000), source: this.label, endpoint: path, ok: res.ok, height: null, ...(res.ok ? {} : { note: `HTTP ${res.status}` }) })
      return res.ok ? await res.json() as T : null
    } catch (e) {
      this.calls.push({ at: Math.floor(Date.now() / 1000), source: this.label, endpoint: path, ok: false, height: null, note: (e as Error).message.slice(0, 120) })
      return null
    }
  }
  async facts(pubkey: Hex): Promise<NodeFacts | null> {
    const node = await this.get<{ first_seen?: number; active_channel_count?: number; capacity?: string | number; closed_channel_count?: number }>(`/v1/lightning/nodes/${pubkey}`)
    if (!node) return null
    // mempool.space closing_reason: 1 mutual, 2 force, 3 force with penalty
    const closed = await this.get<{ closing_reason?: number }[]>(`/v1/lightning/channels?public_key=${pubkey}&status=closed&index=0`)
    const capacity = Number(node.capacity)
    return {
      source: this.label,
      first_seen: Number.isSafeInteger(node.first_seen) ? node.first_seen! : null,
      active_channels: Number.isSafeInteger(node.active_channel_count) ? node.active_channel_count! : null,
      capacity_sat: Number.isSafeInteger(capacity) ? capacity : null,
      closed_channels: Number.isSafeInteger(node.closed_channel_count) ? node.closed_channel_count! : null,
      force_closes_sampled: Array.isArray(closed) ? { force: closed.filter((c) => c.closing_reason === 2 || c.closing_reason === 3).length, sampled: closed.length } : null,
    }
  }
}

export interface LightningHistory extends LayerHistory {
  node_pubkey: Hex | null
  /** Public graph facts, labelled with their source; null when the node is not in a public graph. */
  public_facts: NodeFacts | null
  /** Channels the node itself reports (borrower-device evidence; funding txids are checked on-chain by the btc-onchain layer). */
  own_channels: OwnChannel[]
}

export class LightningAdapter implements LayerAdapter {
  readonly id = 'lightning' as const
  readonly visibility: LayerVisibility = {
    public_history: false,
    lender_recomputable: false,
    best_evidence: 'counterparty-signed',
    default_trust_mode: 'signature-verified',
    limits: ['Lightning payments are private: this release proves the node key and reads public graph facts only.', 'RGB Lightning Node d4762ac /signmessage signs an empty message; node control is proven with a challenge invoice instead.', 'Payment proofs (payee-signed or preimage-backed records) are designed, not built.', 'A regtest or private node has no public graph facts.'],
  }
  /** `method`: 'invoice' for RGB Lightning Node (its /signmessage does not bind the message), 'signmessage' for nodes whose signing does. */
  constructor(readonly chain: ChainId, private readonly node: LightningNodeApi | null, private readonly facts: NodeFactsSource | null = null, private readonly method: 'invoice' | 'signmessage' = 'invoice') {}

  async proveControl(challenge: ControlChallenge): Promise<ControlProof> {
    if (!this.node) throw new Error('no Lightning node configured on this device')
    const { pubkey } = await this.node.nodeInfo()
    if (pubkey !== challenge.subject) throw new Error('the challenge names a different node key')
    return this.method === 'invoice'
      ? { layer: 'lightning', subject: pubkey, challenge, format: 'ln-invoice', signature: await this.node.descriptionInvoice(challenge.text, CHALLENGE_INVOICE_EXPIRY) }
      : { layer: 'lightning', subject: pubkey, challenge, format: 'ln-signmessage', signature: await this.node.signMessage(challenge.text) }
  }

  verifyControl(proof: ControlProof, expect: VerifyExpectation): ControlVerdict {
    const reasons = challengeProblems(proof.challenge, proof.subject, 'lightning', expect)
    if (!isHex(proof.subject, 33)) reasons.push('NODE_KEY_MALFORMED')
    let key: Hex | null = null
    if (proof.format === 'ln-signmessage') {
      key = recoverLnSigner(proof.challenge?.text ?? '', proof.signature)
      if (!key) reasons.push('SIGNATURE_INVALID')
      else if (key !== proof.subject) reasons.push('SIGNED_BY_ANOTHER_KEY')
      // RLN d4762ac signs the empty message whatever it is asked: such a signature binds no challenge.
      if (recoverLnSigner('', proof.signature) === proof.subject) reasons.push('MESSAGE_INDEPENDENT_SIGNATURE')
    } else if (proof.format === 'ln-invoice') {
      try {
        const inv = decodeInvoice(proof.signature)
        key = inv.signer
        if (inv.network !== this.chain) reasons.push('INVOICE_WRONG_CHAIN')
        if (inv.description !== proof.challenge?.text) reasons.push('INVOICE_DESCRIPTION_IS_NOT_THE_CHALLENGE')
        if (inv.signer !== proof.subject) reasons.push('SIGNED_BY_ANOTHER_KEY')
        if (inv.timestamp + 300 < (proof.challenge?.issued_at ?? 0) || inv.timestamp > expect.now + 300) reasons.push('INVOICE_TIME_OUTSIDE_CHALLENGE')
      } catch {
        reasons.push('INVOICE_INVALID')
      }
    } else reasons.push('FORMAT_UNSUPPORTED')
    return { ok: reasons.length === 0, layer: 'lightning', subject: proof.subject, format: proof.format, reasons, ...(key ? { key } : {}) }
  }

  async history(subjects: string[], _window: HistoryWindow): Promise<LightningHistory> {
    const node_pubkey = subjects[0] && isHex(subjects[0], 33) ? subjects[0] : null
    const limits = ['LIGHTNING_PAYMENT_PROOFS_NOT_BUILT']
    let own_channels: OwnChannel[] = []
    if (this.node) {
      try { own_channels = await this.node.listChannels() } catch { limits.push('NODE_CHANNELS_UNAVAILABLE') }
    } else limits.push('NO_NODE_ON_DEVICE')
    let public_facts: NodeFacts | null = null
    if (node_pubkey && this.facts && this.chain === 'bitcoin') public_facts = await this.facts.facts(node_pubkey)
    if (!public_facts) limits.push(this.chain === 'bitcoin' ? 'NODE_NOT_IN_PUBLIC_GRAPH' : `NO_PUBLIC_GRAPH_ON_${this.chain.toUpperCase()}`)
    return { layer: 'lightning', chain: this.chain, subjects: node_pubkey ? [node_pubkey] : [], rows: [], height: null, source: public_facts?.source ?? (this.node ? 'rln node' : 'none'), first_seen_time: public_facts?.first_seen ?? null, balance: null, calls: [...(this.facts?.calls ?? [])], limits, node_pubkey, public_facts, own_channels }
  }
}
