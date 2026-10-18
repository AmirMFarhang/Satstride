// RGB wallet for one party, on the WDK RGB module (@utexo/wdk-wallet-rgb over
// rgb-lib). One data directory per party, never shared between processes.
//
// Verified against @utexo/wdk-wallet-rgb 2.0.3 / @utexo/rgb-sdk 1.0.3 /
// @utexo/rgb-lib 0.3.0-beta.8 on regtest:
// - the SDK hard-codes donation=false in sendBegin, so `send` calls the wrapped
//   rgb-lib wallet directly with donation=true: the sender broadcasts without
//   waiting for the receiver's proxy acknowledgement;
// - a receiver cannot name an asset it has never held in an invoice, so
//   `invoice` leaves the asset open unless the wallet already knows it;
// - a sender funds the witness output and the fee from free colored UTXOs, so
//   every wallet that sends must `createUtxos` first (vanilla BTC is not used);
// - transfer kind and status come back as strings ('ReceiveWitness', 'Settled'),
//   not the SDK's numeric enums;
// - the native binding is a SWIG addon that does not build on Node 25.

import './node-version.js' // before the native binding loads
import './native-exit.js' // its handles are finalized before node tears the isolate down
import { resolve } from 'node:path'
import WDK from '@tetherto/wdk'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { sha256Hex } from '../core/crypto.js'
import { authorizeSignature, enrollSigner, type GateToken } from '../wallet/signer.js'
import { historyAmbiguous, historyInvoice, historySent } from './history-hooks.js'

export interface RgbConfig {
  network: 'regtest' | 'testnet' | 'testnet4' | 'signet' | 'mainnet'
  /** Electrum indexer, e.g. tcp://127.0.0.1:50011 */
  indexerUrl: string
  /** RGB proxy, e.g. rpc://127.0.0.1:3010/json-rpc */
  transportEndpoint: string
}

/** The RGB network: regtest unless PASSBOOK_RGB_NETWORK names a public test network (signet is Mutinynet, or testnet4). Never mainnet. */
export function rgbNetworkFromEnv(env: NodeJS.ProcessEnv = process.env): RgbConfig['network'] {
  const n = env.PASSBOOK_RGB_NETWORK
  if (n === undefined || n === '' || n === 'regtest') return 'regtest'
  if (n === 'signet' || n === 'testnet4') return n
  throw new Error(`PASSBOOK_RGB_NETWORK=${n}: regtest, signet (Mutinynet) or testnet4 only; never mainnet`)
}

export function rgbConfigFromEnv(): RgbConfig {
  return {
    network: rgbNetworkFromEnv(),
    indexerUrl: process.env.RGB_INDEXER_URL ?? `tcp://127.0.0.1:${process.env.PASSBOOK_ELECTRS_PORT ?? 50011}`,
    transportEndpoint: process.env.RGB_TRANSPORT_URL ?? `rpc://127.0.0.1:${process.env.PASSBOOK_PROXY_PORT ?? 3010}/json-rpc`,
  }
}

export type TransferKind = 'Issuance' | 'ReceiveBlind' | 'ReceiveWitness' | 'Send' | 'Inflation'
export type TransferStatus = 'WaitingCounterparty' | 'WaitingConfirmations' | 'Settled' | 'Failed'

export interface Transfer {
  idx: number
  batchTransferIdx: number
  kind: TransferKind
  status: TransferStatus
  txid: string | null
  recipientId: string | null
  /** amount moved by this transfer in the asset's smallest unit (micro-USDT for our asset): sent for a Send, received otherwise */
  amount: number
  /** receiving output of a receive, as txid:vout */
  receiveUtxo: string | null
  /** local consignment file (outgoing for a Send, received for a receive) */
  consignmentPath: string | null
}

export interface AssetBalance {
  settled: number
  future: number
  spendable: number
}

export interface Invoice {
  invoice: string
  recipientId: string
  expirationTimestamp: number
  batchTransferIdx: number
}

/** BTC carried by the receiver's new output on a witness send. */
export const WITNESS_SATS = 1000

// The account surface we use, as the 2.0.3 JavaScript implements it (its bundled
// .d.ts lag behind: no dataDir, signed_psbt, sync issuance). The rgb-sdk client
// and the native wallet underneath are not in the public types at all.
interface Account {
  getAddress(): string
  getRgbWallet(): {
    getBtcBalance(): { vanilla: AssetBalance; colored: AssetBalance }
    getAssetBalance(assetId: string): Partial<AssetBalance>
    createBackup(p: { backupPath: string; password: string }): { backupPath: string }
  }
  createUtxos(o: { upTo: boolean; num: number; size: number; feeRate: number }): Promise<number>
  issueAssetNia(o: { ticker: string; name: string; precision: number; amounts: number[] }): { assetId?: string }
  listAssets(): { nia?: { assetId?: string }[] | null }
  receiveAsset(o: { witness: boolean; assetId?: string; amount: number; minConfirmations: number; durationSeconds?: number }): Invoice
  signPsbt(psbt: string): Promise<string>
  sendEnd(o: { signedPsbt: string }): { txid: string; batchTransferIdx: number }
  refreshWallet(): void
  toReadOnlyAccount(): ReadOnlyAccount
  dispose(): void
}

// WDK's read-only view of an account. In 2.0.3 it holds its own rgb-sdk wallet,
// a second native wallet on the account's data directory, and has no dispose().
interface ReadOnlyAccount { _wallet?: { dispose(): void } | null }

interface NativeClient {
  getOnline(): unknown
  decodeRGBInvoice(p: { invoice: string }): { recipientId: string; assetId?: string; transportEndpoints: string[] }
  wallet: {
    sendBegin(online: unknown, recipientMap: unknown, donation: boolean, feeRate: string, minConfirmations: string): string
    listTransfers(assetId: string | null): RawTransfer[]
  }
}
interface RawTransfer {
  idx: number
  batchTransferIdx: number
  kind: string
  status: string
  txid?: string | null
  recipientId?: string | null
  requestedAssignment?: { Fungible?: number } | null
  assignments?: { Fungible?: number }[]
  receiveUtxo?: { txid: string; vout: number } | null
  consignmentPath?: string | null
}

/** What a governed RGB send shows its approvers and binds its gate token to: the decoded invoice and amount. */
export interface RgbTransferSummary {
  kind: 'rgb-transfer'
  network: RgbConfig['network']
  asset_id: string
  /** In the asset's smallest unit. */
  amount: number
  recipient_id: string
  /** Witness send: the sender creates the receiver's output carrying `witness_sats`. */
  witness: boolean
  witness_sats: number
  transport_endpoints: string[]
  invoice_sha256: string
}

interface Wdk { registerPolicy(policies: unknown): unknown; getAccount(wallet: string, index: number): Promise<unknown> }

export class RgbWallet {
  /** The WDK account behind WDK's policy engine; set once the wallet is under a gate. */
  private governedAccount?: Account
  /** PSBTs whose gate token was verified and that WDK's policy may sign, one call each. */
  private readonly authorizedPsbts = new Set<string>()
  /** Read-only accounts WDK's policy engine built from this wallet; close() frees their native wallets. */
  private readonly policyViews: ReadOnlyAccount[] = []

  private constructor(
    private readonly account: Account,
    readonly dataDir: string,
    private readonly wdk: Wdk,
    readonly network: RgbConfig['network'],
  ) {}

  /** Opens (or creates) the wallet for a BIP-39 seed phrase in `dataDir`, registered with WDK core as its 'rgb' wallet. */
  static async open(seedPhrase: string, dataDir: string, cfg: RgbConfig = rgbConfigFromEnv()): Promise<RgbWallet> {
    const wdk = new WDK(seedPhrase).registerWallet('rgb', WalletManagerRgb as never, { ...cfg, dataDir } as never)
    return new RgbWallet((await wdk.getAccount('rgb', 0)) as unknown as Account, dataDir, wdk as unknown as Wdk, cfg.network)
  }

  /** The signer id a gate token names for this wallet's sends. */
  get signerId(): string {
    return `rgb:${sha256Hex(resolve(this.dataDir)).slice(0, 32)}`
  }

  /**
   * Put this wallet under a policy gate: every later send needs the gate's token
   * for its decoded transfer. WDK's own policy engine (registerPolicy) then also
   * refuses to sign a PSBT that did not come through a verified token. WDK's
   * policies check each call and keep no counters; the gate keeps them.
   */
  async enroll(gatePk: string): Promise<void> {
    enrollSigner(this.signerId, gatePk)
    if (this.governedAccount) return
    this.wdk.registerPolicy({
      id: 'passbook-gate',
      name: 'Passbook policy gate: sign only what the gate approved',
      scope: 'project',
      wallet: 'rgb',
      rules: [
        { name: 'psbt-needs-gate-token', reason: 'no verified Passbook gate token for this PSBT', operation: 'signPsbt', action: 'DENY', conditions: [(ctx: { args: readonly unknown[] }) => !this.authorizedPsbts.has(String(ctx.args[0]))] },
        { name: 'other-calls', operation: '*', action: 'ALLOW', conditions: [] },
      ],
    })
    // The RGB manager caches its account, so the policy proxy wraps this same account. For its
    // conditions WDK also builds a read-only account, which opens a second native wallet on the
    // data directory and is never disposed: keep it so close() frees it. The gate's rule does not read it.
    const toReadOnlyAccount = this.account.toReadOnlyAccount
    this.account.toReadOnlyAccount = () => {
      const view = toReadOnlyAccount.call(this.account)
      this.policyViews.push(view)
      return view
    }
    try {
      this.governedAccount = (await this.wdk.getAccount('rgb', 0)) as Account
    } finally {
      delete (this.account as { toReadOnlyAccount?: unknown }).toReadOnlyAccount
    }
  }

  /** Decode a send before signing it: what the gate approves and the signer re-checks. */
  transferSummary(opts: { invoice: string; assetId: string; amount: number }): RgbTransferSummary {
    const decoded = this.client.decodeRGBInvoice({ invoice: opts.invoice })
    if (decoded.assetId && decoded.assetId !== opts.assetId) throw new Error(`invoice is for ${decoded.assetId}, not ${opts.assetId}`)
    const witness = decoded.recipientId.includes(':wvout:')
    return { kind: 'rgb-transfer', network: this.network, asset_id: opts.assetId, amount: opts.amount, recipient_id: decoded.recipientId, witness, witness_sats: witness ? WITNESS_SATS : 0, transport_endpoints: [...decoded.transportEndpoints], invoice_sha256: sha256Hex(opts.invoice) }
  }

  private get client(): NativeClient {
    return (this.account.getRgbWallet() as unknown as { client: NativeClient }).client
  }

  /** Vanilla (BTC) deposit address. */
  address(): string {
    return this.account.getAddress()
  }

  btcBalance(): { vanilla: AssetBalance; colored: AssetBalance } {
    return this.account.getRgbWallet().getBtcBalance()
  }

  /** Create colorable UTXOs from the vanilla balance; mine afterwards. */
  async createUtxos(num = 5, size = 5000): Promise<number> {
    return this.account.createUtxos({ upTo: true, num, size, feeRate: 1 })
  }

  /** Issue a non-inflatable asset to this wallet. Returns the contract id. */
  issueNia(opts: { ticker: string; name: string; precision: number; amount: number }): string {
    const asset = this.account.issueAssetNia({ ticker: opts.ticker, name: opts.name, precision: opts.precision, amounts: [opts.amount] })
    if (!asset.assetId) throw new Error('issuance returned no asset id')
    return asset.assetId
  }

  knowsAsset(assetId: string): boolean {
    const assets = this.account.listAssets()
    return (assets.nia ?? []).some((a) => a.assetId === assetId)
  }

  /**
   * Witness-mode receive invoice: the sender creates the receiving output, so this
   * wallet needs no colorable UTXO. One confirmation is enough.
   */
  invoice(amount: number, assetId?: string, durationSeconds = 2000): Invoice {
    const named = assetId && this.knowsAsset(assetId) ? assetId : undefined
    const invoice = this.account.receiveAsset({ witness: true, assetId: named, amount, minConfirmations: 1, durationSeconds })
    historyInvoice(this.dataDir, invoice.recipientId)
    return invoice
  }

  /**
   * Blinded receive invoice (the wallet panel's Receive): the sender cannot see
   * which output receives. Needs a free colored UTXO here (createUtxos first).
   */
  blindInvoice(amount: number, assetId?: string, durationSeconds = 86_400): Invoice {
    const named = assetId && this.knowsAsset(assetId) ? assetId : undefined
    const invoice = this.account.receiveAsset({ witness: false, assetId: named, amount, minConfirmations: 1, durationSeconds })
    historyInvoice(this.dataDir, invoice.recipientId)
    return invoice
  }

  /** Every field of an RGB invoice, for showing what a send will pay before it is signed. */
  decodeInvoice(invoice: string): { recipientId: string; assetId?: string; network?: string; assignment?: Record<string, unknown>; expirationTimestamp?: number; transportEndpoints: string[] } {
    return this.client.decodeRGBInvoice({ invoice }) as ReturnType<RgbWallet['decodeInvoice']>
  }

  /** Encrypted native backup for a trusted observer; contains xpubs/state, no mnemonic. */
  createWatchBackup(backupPath: string, password: string): string { return this.account.getRgbWallet().createBackup({ backupPath, password }).backupPath }

  /** Decode the beneficiary so a receive can be bound to its exact repayment invoice. */
  invoiceRecipient(invoice: string): string { return this.client.decodeRGBInvoice({ invoice }).recipientId }

  /**
   * Pay an RGB invoice with donation=true: begin, sign, end. Broadcasts; does not mine.
   * A wallet under a gate needs `token`, the gate's decision for exactly this decoded transfer.
   */
  async send(opts: { invoice: string; assetId: string; amount: number; feeRate?: number; token?: GateToken }): Promise<{ txid: string; batchTransferIdx: number }> {
    const client = this.client
    const summary = this.transferSummary(opts)
    const ticket = authorizeSignature(this.signerId, summary, opts.token)
    const recipientMap = {
      [opts.assetId]: [
        {
          recipientId: summary.recipient_id,
          witnessData: summary.witness ? { amountSat: String(WITNESS_SATS), blinding: null } : null,
          assignment: { Fungible: opts.amount },
          transportEndpoints: summary.transport_endpoints,
        },
      ],
    }
    let signedPsbt: string
    try {
      const psbt = client.wallet.sendBegin(client.getOnline(), recipientMap, true, String(opts.feeRate ?? 1), '1')
      signedPsbt = await this.signPsbt(psbt)
    } catch (error) {
      // nothing was signed: the gate gives the reservation back and logs the failure
      ticket.failed(error)
      throw error
    }
    // signed: from here a broadcast may happen, so the reservation stays committed whatever sendEnd says
    ticket.signed()
    try {
      const sent = this.account.sendEnd({ signedPsbt })
      historySent(this.dataDir, summary.recipient_id, opts.assetId, opts.amount, sent.txid)
      return sent
    } catch (error) {
      // A timeout may follow a broadcast; no completeness claim after ambiguity.
      historyAmbiguous(this.dataDir, summary.recipient_id, opts.assetId)
      throw error
    }
  }

  /** Governed wallets sign through WDK's policy engine, which allows only the PSBT just authorized. */
  private async signPsbt(psbt: string): Promise<string> {
    if (!this.governedAccount) return this.account.signPsbt(psbt)
    this.authorizedPsbts.add(psbt)
    try { return await this.governedAccount.signPsbt(psbt) } finally { this.authorizedPsbts.delete(psbt) }
  }

  /** Sync with the indexer and advance pending transfers (fetch consignments, ack, confirm). */
  refresh(): void {
    this.account.refreshWallet()
  }

  balance(assetId: string): AssetBalance {
    if (!this.knowsAsset(assetId)) return { settled: 0, future: 0, spendable: 0 }
    const b = this.account.getRgbWallet().getAssetBalance(assetId)
    return { settled: b.settled ?? 0, future: b.future ?? 0, spendable: b.spendable ?? 0 }
  }

  transfers(assetId?: string): Transfer[] {
    if (assetId && !this.knowsAsset(assetId)) return []
    return this.client.wallet.listTransfers(assetId ?? null).map((t) => ({
      idx: t.idx,
      batchTransferIdx: t.batchTransferIdx,
      kind: t.kind as TransferKind,
      status: t.status as TransferStatus,
      txid: t.txid ?? null,
      recipientId: t.recipientId ?? null,
      // a Send's assignments are the sender's change; what it sent is the requested assignment
      amount: t.kind === 'Send' ? (t.requestedAssignment?.Fungible ?? 0) : (t.assignments ?? []).reduce((s, a) => s + (a.Fungible ?? 0), 0),
      receiveUtxo: t.receiveUtxo ? `${t.receiveUtxo.txid}:${t.receiveUtxo.vout}` : null,
      consignmentPath: t.consignmentPath ?? null,
    }))
  }

  /** The transfer this wallet holds for a Bitcoin txid, if any. */
  transferByTxid(assetId: string, txid: string, kind?: TransferKind): Transfer | undefined {
    return this.transfers(assetId).find((t) => t.txid === txid && (kind === undefined || t.kind === kind))
  }

  /** Frees every native wallet this wallet holds: the policy engine's read-only views, then the account's own. */
  close(): void {
    for (const view of this.policyViews.splice(0)) view._wallet?.dispose()
    this.account.dispose()
  }
}

/**
 * One side only: refresh this wallet, mining between rounds, until its transfer
 * for `txid` is Settled. What an agent does with just its own wallet.
 */
export async function awaitSettled(
  wallet: RgbWallet,
  opts: { assetId: string; txid: string; kind?: TransferKind; mine: () => Promise<unknown>; maxBlocks?: number },
): Promise<Transfer> {
  for (let round = 0; round <= (opts.maxBlocks ?? 4); round++) {
    wallet.refresh()
    const t = wallet.transferByTxid(opts.assetId, opts.txid, opts.kind)
    if (t?.status === 'Failed') throw new Error(`RGB transfer ${opts.txid} failed (${t.kind})`)
    if (t?.status === 'Settled') return t
    await opts.mine()
  }
  throw new Error(`RGB transfer ${opts.txid} did not settle in ${wallet.dataDir}`)
}

/**
 * Drive a transfer to Settled on both sides: refresh receiver then sender, and
 * mine a block whenever either side is still waiting. Throws if it fails or
 * does not settle within `maxBlocks`.
 */
export async function settle(
  opts: { sender: RgbWallet; receiver: RgbWallet; assetId: string; txid: string; mine: () => Promise<unknown>; maxBlocks?: number },
): Promise<{ sent: Transfer; received: Transfer }> {
  const { sender, receiver, assetId, txid } = opts
  for (let round = 0; round <= (opts.maxBlocks ?? 4); round++) {
    receiver.refresh()
    sender.refresh()
    const sent = sender.transferByTxid(assetId, txid, 'Send')
    const received = receiver.transferByTxid(assetId, txid)
    for (const t of [sent, received]) if (t?.status === 'Failed') throw new Error(`RGB transfer ${txid} failed (${t.kind})`)
    if (sent?.status === 'Settled' && received?.status === 'Settled') return { sent, received }
    await opts.mine()
  }
  throw new Error(`RGB transfer ${txid} did not settle`)
}
