// The wallet panel's service: the person's own wallet on their own Passbook
// node, behind the signed API (src/server/wallet-routes.ts). One seed (encrypted
// at rest, src/wallet/seed-vault.ts) drives:
//   - Bitcoin on WDK's BTC module (src/wallet/btc-wdk.ts), and
//   - test USDT on RGB through the existing RGB wallet (src/rgb/wallet.ts).
//
// Rules this file enforces in code, not in the UI:
//   - every amount and screen carries the network label; the dollar asset is
//     always "test USDT (<network>)", never "USDT";
//   - a send is previewed first: decoded, with "Can't be undone", and stored
//     under a one-time id with the hash of exactly what was shown;
//   - confirming a preview asks the send gate (src/wallet/send-gate.ts); no
//     gate, no send. The BTC transaction is then signed, decoded again and
//     compared with the preview before it is broadcast;
//   - a failed send is recorded as failed, with the reason, and never shown
//     as sent;
//   - the backup must be proven (3 words) before the first loan.

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hashObject, type Hex } from '../core/crypto.js'
import { explorerAddress, explorerTx, probeNetwork, type NetworkProfile, type ProbeResult } from '../core/network.js'
import type { HistoryRow } from '../sandbox/types.js'
import { decodeAddress, decodeTx, type BtcTransferRow } from './btc-wdk.js'
import { SeedVault, VaultError } from './seed-vault.js'
import { intentHash, type GateDecision, type SendGate, type SendIntent } from './send-gate.js'

// ---- ports (real wallets in production, fakes in tests) ----

export interface BtcPort {
  address(): Promise<string>
  balanceSats(): Promise<number>
  quote(to: string, sats: number): Promise<{ fee: number }>
  sign(to: string, sats: number): Promise<string>
  /** fee of a signed transaction, from its inputs' values */
  signedFee?(hex: string): Promise<number>
  broadcast(hex: string): Promise<{ txid: string; fee: number }>
  transfers(limit?: number): Promise<BtcTransferRow[]>
  close(): void
}

export interface RgbBalance { settled: number; future: number; spendable: number }
export interface RgbTransferLike { idx: number; kind: string; status: string; txid: string | null; amount: number; recipientId: string | null }

export interface RgbPort {
  address(): string
  btcBalance(): { vanilla: RgbBalance; colored: RgbBalance }
  balance(assetId: string): RgbBalance
  blindInvoice(amount: number, assetId?: string): { invoice: string; recipientId: string; expirationTimestamp: number }
  invoice(amount: number, assetId?: string): { invoice: string; recipientId: string; expirationTimestamp: number }
  decodeInvoice(invoice: string): { recipientId: string; assetId?: string; network?: string; assignment?: Record<string, unknown>; transportEndpoints: string[] }
  send(o: { invoice: string; assetId: string; amount: number; feeRate?: number }): Promise<{ txid: string }>
  createUtxos(num?: number, size?: number): Promise<number>
  transfers(assetId?: string): RgbTransferLike[]
  refresh(): void
  close(): void
}

export interface WalletPanelOptions {
  profile: NetworkProfile
  /** wallet directory: the vault, the RGB data and the send log */
  dir: string
  /** the test USDT contract id this node uses (regtest: infra/state.json) */
  assetId?: () => string | undefined
  gate?: SendGate
  openBtc?: (words: string, profile: NetworkProfile) => Promise<BtcPort>
  openRgb?: (words: string, dir: string, profile: NetworkProfile) => Promise<RgbPort>
  /** ask every endpoint which chain it serves before opening wallets (default true) */
  probe?: (profile: NetworkProfile) => Promise<ProbeResult[]>
  now?: () => number
  /** lock again after this long without a request (default 15 min) */
  idleMs?: number
}

export class WalletError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'WalletError'
  }
}

export type SendKind = 'btc' | 'rgb'

export interface SendPreview {
  id: string
  kind: SendKind
  network: string
  /** what the person reads, decoded */
  decoded: {
    to: string
    to_type: string
    amount: number
    unit: 'sats' | 'micro'
    amount_label: string
    fee_sats: number
    fee_label: string
    total_label: string
    asset_id?: string
    recipient_id?: string
    transport_endpoints?: string[]
    note?: string
  }
  irreversible: "Can't be undone"
  gate: { name: string; adapter: boolean } | null
  preview_hash: Hex
  expires_at: number
}

interface StoredPreview extends SendPreview {
  /** the raw invoice for an RGB send (not echoed back) */
  invoice?: string
  used: boolean
}

export interface SendLogEntry {
  at: number
  preview_id: string
  kind: SendKind | 'prepare'
  network: string
  to: string
  amount: number
  unit: 'sats' | 'micro'
  status: 'sent' | 'refused' | 'failed' | 'unknown'
  txid?: string
  reason?: string
  gate?: string
}

export interface HistoryEntry {
  layer: 'btc' | 'rgb'
  direction: 'in' | 'out'
  amount: number
  unit: 'sats' | 'micro'
  label: string
  txid: string | null
  height: number | null
  status: string
  explorer: string | null
  network: string
}

const PREVIEW_TTL_MS = 5 * 60_000
const btcText = (sats: number) => {
  let s = (sats / 1e8).toFixed(8).replace(/0+$/, '')
  if (s.endsWith('.')) s += '0'
  return s
}
const usdtText = (micro: number) => (micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })

export class WalletPanel {
  readonly vault: SeedVault
  private open: { btc: BtcPort; rgb: RgbPort; at: number } | null = null
  private previews = new Map<string, StoredPreview>()
  private probed: ProbeResult[] | null = null
  private readonly now: () => number

  constructor(private readonly opts: WalletPanelOptions) {
    this.vault = new SeedVault(opts.dir, opts.profile.name)
    this.now = opts.now ?? Date.now
  }

  get profile(): NetworkProfile { return this.opts.profile }
  get gate(): SendGate | undefined { return this.opts.gate }

  /** Labels everything on screen uses; the asset is never plain "USDT". */
  labels() {
    const p = this.profile
    return { network: p.label, coin: p.coinLabel, asset: p.assetLabel, public: p.public, explorer: p.explorer ?? null }
  }

  private assetId(): string | undefined {
    try { return this.opts.assetId?.() } catch { return undefined }
  }

  private touch(): void {
    if (!this.open) return
    if (this.now() - this.open.at > (this.opts.idleMs ?? 15 * 60_000)) { this.lock(); return }
    this.open.at = this.now()
  }

  private wallets(): { btc: BtcPort; rgb: RgbPort } {
    this.touch()
    if (!this.open) throw new WalletError(423, this.vault.exists() ? 'wallet locked: unlock it with your passphrase' : 'no wallet yet: create one or restore from your words')
    return this.open
  }

  status() {
    this.touch()
    const v = this.vault.info()
    return {
      network: this.labels(),
      has_wallet: v.exists,
      unlocked: !!this.open,
      backup: { verified: v.backup_verified, at: v.backup_verified_at, origin: v.origin ?? null, required_before_first_loan: true },
      asset_id: this.assetId() ?? null,
      gate: this.gate ? { name: this.gate.name, adapter: this.gate.adapter } : null,
      endpoints_checked: this.probed,
    }
  }

  // ---- seed ----

  async create(passphrase: string): Promise<{ words: string[] }> {
    // check the endpoints before making a seed, so a refused network never leaves unseen words behind
    await this.ensureProbed()
    const words = this.guard(() => this.vault.create(passphrase))
    await this.openWallets(words)
    return { words: words.split(' ') }
  }

  async restore(words: string, passphrase: string): Promise<void> {
    await this.ensureProbed()
    this.guard(() => this.vault.restore(words, passphrase))
    await this.unlock(passphrase)
  }

  async unlock(passphrase: string): Promise<void> {
    const words = this.guard(() => this.vault.unlock(passphrase))
    await this.openWallets(words)
  }

  lock(): void {
    if (!this.open) return
    try { this.open.btc.close() } catch { /* already closed */ }
    try { this.open.rgb.close() } catch { /* already closed */ }
    this.open = null
    this.previews.clear()
  }

  backupChallenge(): { positions: number[] } {
    return { positions: this.guard(() => this.vault.backupChallenge()) }
  }

  backupVerify(passphrase: string, answers: Record<string, string>): { verified: boolean } {
    return { verified: this.guard(() => this.vault.verifyBackup(passphrase, answers)) }
  }

  /** The gate before a first loan: the backup must be proven. */
  assertReadyToBorrow(): void {
    this.guard(() => this.vault.assertBackupVerified())
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      if (err instanceof VaultError) throw new WalletError(err.code === 'passphrase' ? 401 : err.code === 'exists' ? 409 : err.code === 'missing' ? 404 : 400, err.message)
      throw err
    }
  }

  /** Refuse to open wallets against endpoints that serve another chain (src/core/network.ts). */
  private async ensureProbed(): Promise<void> {
    if (this.probed) return
    try { this.probed = await (this.opts.probe ?? probeNetwork)(this.profile) } catch (err) { throw new WalletError(503, (err as Error).message) }
  }

  private async openWallets(words: string): Promise<void> {
    if (this.open) return
    await this.ensureProbed()
    const openBtc = this.opts.openBtc ?? (async (w, p) => (await import('./btc-wdk.js')).WdkBtcWallet.open(w, p))
    const openRgb = this.opts.openRgb ?? defaultOpenRgb
    const btc = await openBtc(words, this.profile)
    let rgb: RgbPort
    try { rgb = await openRgb(words, join(this.opts.dir, 'rgb'), this.profile) } catch (err) { btc.close(); throw err }
    this.open = { btc, rgb, at: this.now() }
  }

  // ---- balances and receive ----

  async balances() {
    const { btc, rgb } = this.wallets()
    try { rgb.refresh() } catch { /* offline indexer: show what we have, marked below */ }
    const assetId = this.assetId()
    const sats = await btc.balanceSats()
    const rgbBtc = rgb.btcBalance()
    const usdt = assetId ? rgb.balance(assetId) : { settled: 0, future: 0, spendable: 0 }
    const l = this.labels()
    return {
      network: l,
      btc: { sats, label: `${btcText(sats)} ${l.coin}` },
      rgb_btc: { sats: rgbBtc.vanilla.settled + rgbBtc.colored.settled, spendable: rgbBtc.vanilla.spendable, label: `${btcText(rgbBtc.vanilla.settled + rgbBtc.colored.settled)} ${l.coin}` },
      usdt: { ...usdt, label: `${usdtText(usdt.settled)} ${l.asset}`, pending_label: usdt.future !== usdt.settled ? `${usdtText(usdt.future)} ${l.asset} incl. pending` : null },
      asset_id: assetId ?? null,
    }
  }

  async receiveBtc() {
    const address = await this.wallets().btc.address()
    return { network: this.labels(), address, explorer: explorerAddress(this.profile, address) }
  }

  receiveRgb(amountMicro?: number) {
    const { rgb } = this.wallets()
    const assetId = this.assetId()
    const amount = amountMicro ?? 0
    if (!Number.isSafeInteger(amount) || amount < 0) throw new WalletError(400, 'amount must be a whole number of micro test USDT')
    try {
      const inv = rgb.blindInvoice(amount, assetId)
      return { network: this.labels(), kind: 'blinded' as const, invoice: inv.invoice, recipient_id: inv.recipientId, expires_at: inv.expirationTimestamp, rgb_btc_address: rgb.address() }
    } catch (err) {
      // a blinded invoice needs a free colored UTXO; say so instead of guessing
      throw new WalletError(409, `A blinded invoice needs a free RGB output in this wallet. Fund the RGB address, then prepare outputs. (${(err as Error).message})`, { rgb_btc_address: rgb.address() })
    }
  }

  // ---- send: preview, then confirm through the gate ----

  async previewSend(input: { kind: SendKind; to: string; amount: number }): Promise<SendPreview> {
    const { btc, rgb } = this.wallets()
    const l = this.labels()
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new WalletError(400, 'amount must be a positive whole number')
    const id = randomBytes(12).toString('hex')
    let stored: StoredPreview
    if (input.kind === 'btc') {
      const to = String(input.to ?? '').trim()
      const decoded = decodeAddress(to, this.profile)
      if (!decoded) throw new WalletError(400, `That is not a ${l.network} address. Mainnet and other networks' addresses are refused.`)
      let fee: number
      try { fee = (await btc.quote(to, input.amount)).fee } catch (err) { throw new WalletError(422, `Can't send that: ${(err as Error).message}`) }
      const balance = await btc.balanceSats()
      if (input.amount + fee > balance) throw new WalletError(422, `Not enough ${l.coin}: ${btcText(input.amount + fee)} needed with the fee, ${btcText(balance)} available`)
      stored = this.stash(id, 'btc', {
        to, to_type: decoded.type, amount: input.amount, unit: 'sats',
        amount_label: `${btcText(input.amount)} ${l.coin}`, fee_sats: fee, fee_label: `${btcText(fee)} ${l.coin}`, total_label: `${btcText(input.amount + fee)} ${l.coin}`,
      })
    } else if (input.kind === 'rgb') {
      const assetId = this.assetId()
      if (!assetId) throw new WalletError(409, `No ${l.asset} contract is configured on this node`)
      const invoice = String(input.to ?? '').trim()
      let inv: ReturnType<RgbPort['decodeInvoice']>
      try { inv = rgb.decodeInvoice(invoice) } catch (err) { throw new WalletError(400, `That is not an RGB invoice: ${(err as Error).message}`) }
      if (inv.assetId && inv.assetId !== assetId) throw new WalletError(422, `The invoice asks for another asset (${inv.assetId.slice(0, 18)}…), not ${l.asset}`)
      if (inv.network && !sameRgbNetwork(inv.network, this.profile.rgbNetwork)) throw new WalletError(422, `The invoice is for ${inv.network}, this wallet is on ${l.network}`)
      const asked = Number((inv.assignment as { value?: unknown; Fungible?: unknown } | undefined)?.value ?? (inv.assignment as { Fungible?: unknown } | undefined)?.Fungible ?? 0)
      if (asked > 0 && asked !== input.amount) throw new WalletError(422, `The invoice asks for ${usdtText(asked)} ${l.asset}, not ${usdtText(input.amount)}`)
      const spendable = rgb.balance(assetId).spendable
      if (input.amount > spendable) throw new WalletError(422, `Not enough ${l.asset}: ${usdtText(spendable)} spendable`)
      const witness = inv.recipientId.includes(':wvout:') || inv.recipientId.startsWith('wvout:')
      const fee = 300 // ~1 sat/vB on a one-input, three-output RGB witness transaction; the wallet pays it in BTC
      stored = this.stash(id, 'rgb', {
        to: inv.recipientId, to_type: witness ? 'RGB witness invoice (the payment creates the receiver\'s output)' : 'RGB blinded invoice', amount: input.amount, unit: 'micro',
        amount_label: `${usdtText(input.amount)} ${l.asset}`, fee_sats: fee, fee_label: `about ${btcText(fee + (witness ? 1000 : 0))} ${l.coin} network fee${witness ? ' incl. 1,000 sats for the receiver\'s output' : ''}`, total_label: `${usdtText(input.amount)} ${l.asset} + network fee`,
        asset_id: assetId, recipient_id: inv.recipientId, transport_endpoints: inv.transportEndpoints,
        note: 'Sent over RGB: the payment proof (consignment) goes through the listed proxy.',
      }, invoice)
    } else {
      throw new WalletError(400, 'kind must be btc or rgb')
    }
    const { invoice: _hidden, used: _u, ...shown } = stored
    return shown
  }

  private stash(id: string, kind: SendKind, decoded: SendPreview['decoded'], invoice?: string): StoredPreview {
    const base = { id, kind, network: this.profile.label, decoded, irreversible: "Can't be undone" as const, gate: this.gate ? { name: this.gate.name, adapter: this.gate.adapter } : null, expires_at: this.now() + PREVIEW_TTL_MS }
    const stored: StoredPreview = { ...base, preview_hash: hashObject(base), ...(invoice ? { invoice } : {}), used: false }
    for (const [k, p] of this.previews) if (p.expires_at < this.now() || p.used) this.previews.delete(k)
    this.previews.set(id, stored)
    return stored
  }

  /**
   * The person confirmed a preview. Gate first, then sign, check, broadcast.
   * Returns the txid; throws WalletError with a plain reason otherwise.
   */
  async confirmSend(previewId: string, confirmed: boolean): Promise<{ txid: string; explorer: string | null; gate: GateDecision }> {
    const { btc, rgb } = this.wallets()
    const p = this.previews.get(previewId)
    if (!p || p.used) throw new WalletError(404, 'That preview is gone or was already used. Start the send again.')
    if (p.expires_at < this.now()) { this.previews.delete(previewId); throw new WalletError(410, 'That preview expired. Start the send again to see current fees.') }
    p.used = true // one confirmation per preview, whatever happens next
    const base = { at: this.now(), preview_id: p.id, kind: p.kind, network: p.network, to: p.decoded.to, amount: p.decoded.amount, unit: p.decoded.unit }
    if (!this.gate) {
      this.log({ ...base, status: 'refused', reason: 'no send gate configured' })
      throw new WalletError(403, 'Sends are refused: this node has no send gate configured.')
    }
    const intent: SendIntent = { action: p.kind === 'btc' ? 'wallet.send.btc' : 'wallet.send.rgb', network: this.profile.name, preview_id: p.id, preview_hash: p.preview_hash, amount: p.decoded.amount, unit: p.decoded.unit, ...(p.decoded.asset_id ? { asset_id: p.decoded.asset_id } : {}), to: p.decoded.to, fee_sats: p.decoded.fee_sats, confirmed }
    const decision = await this.gate.decide(intent)
    if (decision.intent_hash !== intentHash(intent)) {
      this.log({ ...base, status: 'refused', reason: 'gate decision is for another intent', gate: decision.gate })
      throw new WalletError(403, 'The gate answered for a different send; nothing was signed.')
    }
    if (!decision.allow) {
      this.log({ ...base, status: 'refused', reason: decision.reason, gate: decision.gate })
      throw new WalletError(403, `The gate refused this send: ${decision.reason}`, decision)
    }
    if (p.kind === 'btc') {
      let hex: string
      try { hex = await btc.sign(p.decoded.to, p.decoded.amount) } catch (err) {
        this.log({ ...base, status: 'failed', reason: (err as Error).message, gate: decision.gate })
        throw new WalletError(422, `Not sent: ${(err as Error).message}. Nothing left your wallet.`)
      }
      const tx = decodeTx(hex, this.profile)
      const pays = tx.outputs.some((o) => o.address === p.decoded.to && o.value === p.decoded.amount)
      const fee = btc.signedFee ? await btc.signedFee(hex) : p.decoded.fee_sats
      if (!pays || fee > p.decoded.fee_sats * 2 + 500) {
        this.log({ ...base, status: 'refused', reason: 'signed transaction differs from the preview', gate: decision.gate })
        throw new WalletError(409, 'The signed transaction differs from what you approved; it was not broadcast.')
      }
      try {
        const sent = await btc.broadcast(hex)
        this.log({ ...base, status: 'sent', txid: sent.txid, gate: decision.gate })
        return { txid: sent.txid, explorer: explorerTx(this.profile, sent.txid), gate: decision }
      } catch (err) {
        this.log({ ...base, status: 'unknown', txid: tx.txid, reason: (err as Error).message, gate: decision.gate })
        throw new WalletError(502, `The network did not accept it: ${(err as Error).message}. Check History before trying again (txid ${tx.txid}).`)
      }
    }
    try {
      const sent = await rgb.send({ invoice: p.invoice!, assetId: p.decoded.asset_id!, amount: p.decoded.amount, feeRate: 1 })
      this.log({ ...base, status: 'sent', txid: sent.txid, gate: decision.gate })
      return { txid: sent.txid, explorer: explorerTx(this.profile, sent.txid), gate: decision }
    } catch (err) {
      this.log({ ...base, status: 'failed', reason: (err as Error).message, gate: decision.gate })
      throw new WalletError(422, `Not sent: ${(err as Error).message}`)
    }
  }

  /** Create colored outputs so this wallet can hold and send test USDT. Spends only the RGB wallet's own BTC; gated like a send. */
  async prepareRgb(confirmed: boolean, num = 3, size = 3000): Promise<{ created: number }> {
    const { rgb } = this.wallets()
    if (!this.gate) throw new WalletError(403, 'Refused: this node has no send gate configured.')
    const id = randomBytes(12).toString('hex')
    const intent: SendIntent = { action: 'wallet.prepare.rgb', network: this.profile.name, preview_id: id, preview_hash: hashObject({ id, num, size }), amount: num * size, unit: 'sats', to: 'own RGB outputs', fee_sats: 300, confirmed }
    const decision = await this.gate.decide(intent)
    if (!decision.allow || decision.intent_hash !== intentHash(intent)) throw new WalletError(403, `The gate refused: ${decision.reason}`)
    try {
      const created = await rgb.createUtxos(num, size)
      this.log({ at: this.now(), preview_id: id, kind: 'prepare', network: this.profile.label, to: 'own RGB outputs', amount: num * size, unit: 'sats', status: 'sent', gate: decision.gate })
      return { created }
    } catch (err) {
      this.log({ at: this.now(), preview_id: id, kind: 'prepare', network: this.profile.label, to: 'own RGB outputs', amount: num * size, unit: 'sats', status: 'failed', reason: (err as Error).message, gate: decision.gate })
      throw new WalletError(422, `Not prepared: ${(err as Error).message}`)
    }
  }

  // ---- history ----

  private get logPath(): string { return join(this.opts.dir, 'sends.jsonl') }

  private log(entry: SendLogEntry): void {
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 })
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  sendLog(): SendLogEntry[] {
    if (!existsSync(this.logPath)) return []
    return readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SendLogEntry)
  }

  async history(): Promise<{ network: ReturnType<WalletPanel['labels']>; rows: HistoryEntry[]; attempts: SendLogEntry[]; credit_rows: HistoryRow[] }> {
    const { btc, rgb } = this.wallets()
    const l = this.labels()
    const rows: HistoryEntry[] = []
    for (const t of await btc.transfers(50)) rows.push({ layer: 'btc', direction: t.direction, amount: t.sats, unit: 'sats', label: `${t.direction === 'in' ? '+' : '-'}${btcText(t.sats)} ${l.coin}`, txid: t.txid, height: t.height > 0 ? t.height : null, status: t.height > 0 ? 'confirmed' : 'pending', explorer: explorerTx(this.profile, t.txid), network: l.network })
    const assetId = this.assetId()
    if (assetId) {
      for (const t of rgb.transfers(assetId)) {
        if (t.kind === 'Issuance') continue
        const out = t.kind === 'Send'
        rows.push({ layer: 'rgb', direction: out ? 'out' : 'in', amount: t.amount, unit: 'micro', label: `${out ? '-' : '+'}${usdtText(t.amount)} ${l.asset}`, txid: t.txid, height: null, status: t.status, explorer: t.txid ? explorerTx(this.profile, t.txid) : null, network: l.network })
      }
    }
    // newest first: pending (no height) on top, then by height
    rows.sort((a, b) => (b.height ?? Infinity) - (a.height ?? Infinity))
    return { network: l, rows, attempts: this.sendLog().slice(-50).reverse(), credit_rows: creditRows(rows) }
  }
}

/** rgb-lib names networks 'Regtest', 'Signet', 'Testnet4'… */
function sameRgbNetwork(invoiceNetwork: string, rgbNetwork: string): boolean {
  return invoiceNetwork.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(rgbNetwork.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

/**
 * The rows the credit agent reads (src/sandbox/types.ts HistoryRow): settled
 * test-USDT transfers only, in micro units. RGB does not reveal who paid, so the
 * counterparty is empty here; payer-signed inflows attach it (docs/WALLET.md).
 */
export function creditRows(rows: HistoryEntry[]): HistoryRow[] {
  return rows.filter((r) => r.layer === 'rgb' && r.status === 'Settled' && r.txid).map((r) => ({ txid: r.txid as Hex, height: r.height ?? 0, direction: r.direction, amount: r.amount, counterparty_pk: '' as Hex, memo: `wallet panel (${r.network})` }))
}

async function defaultOpenRgb(words: string, dir: string, profile: NetworkProfile): Promise<RgbPort> {
  const { RgbWallet } = await import('../rgb/wallet.js')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return RgbWallet.open(words, dir, { network: profile.rgbNetwork, indexerUrl: profile.endpoints.rgb_indexer, transportEndpoint: profile.endpoints.rgb_proxy })
}

/** The panel for this node: PASSBOOK_WALLET_DIR (default data/wallet/<network>), the asset from the deployment's state file. */
export function walletPanelFromEnv(profile: NetworkProfile, gate: SendGate | undefined, assetFrom?: string, env: NodeJS.ProcessEnv = process.env): WalletPanel {
  const dir = resolve(env.PASSBOOK_WALLET_DIR ?? join('data', 'wallet', profile.name))
  const stateFile = resolve(env.PASSBOOK_STATE ?? assetFrom ?? 'infra/state.json')
  return new WalletPanel({
    profile, dir, gate,
    assetId: () => existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { asset?: { id?: string } }).asset?.id : undefined,
  })
}
