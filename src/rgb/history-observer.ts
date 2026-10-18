// Demo trust boundary: the orchestrator, not the borrower agent, installs this
// observer before creating a fresh wallet's first receive. It journals actual
// broadcasts and reopens native RGB state with public keys only before signing.
// The backup alone does NOT prove that a borrower disclosed all prior history.
import './node-version.js'
import './native-exit.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { restoreFromBackup, WalletManager } from '@utexo/rgb-sdk'
import type { BitcoindChain } from '../chain/bitcoind.js'
import type { ChainClient } from '../chain/types.js'
import { hashObject, randomHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { historyLedger, type HistoryProof, type ObservedTransfer, type ProvenAllocation } from '../sandbox/reconcile.js'
import { installHistoryObserver, type HistoryObserverHooks } from './history-hooks.js'
import { rgbConfigFromEnv, type RgbConfig, type RgbWallet } from './wallet.js'
import type { WatchKeys } from './watch.js'
import { walletsDir } from '../wallet/platform-key.js'
import { readBtcHistory, TcpElectrum, type ElectrumReader } from '../wallet/btc-history.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { keyPathOutput } from '../escrow/escrow.js'

export function historyObserverDir(): string { return resolve(process.env.PASSBOOK_HISTORY_OBSERVER_DIR ?? join(walletsDir(), 'platform', 'history-observer')) }

interface JournalTransfer { txid: Hex; direction: 'in' | 'out'; amount: number; recipient_id: string; counterparty_pk: Hex }
interface Journal { v: 1; observer_pk: Hex; borrower_pk: Hex; asset_id: string; keys: WatchKeys; wallet_dir: string; born_zero: true; incomplete: boolean; transfers: JournalTransfer[]; sig: Hex }
/**
 * The chain the observer reads: bitcoind (regtest, unchanged: `gettxout`), or an Esplora on a public test network
 * (Mutinynet: the output's spent status from /tx/:id/outspend/:vout, its value and script from the transaction).
 */
export type ObserverChain = BitcoindChain | (Pick<ChainClient, 'getTx' | 'getHeight'> & { outspends(txid: Hex): Promise<{ spent: boolean }[]> })
export interface HistoryObserverConfig {
  rootDir: string; signer: KeyPair; chain: ObserverChain; cfg?: RgbConfig
  /** The Electrum server for the independent BTC history read, when the RGB indexer is not one (an Esplora on Mutinynet). */
  btcHistoryElectrum?: string
}

/** A confirmed unspent output's value, confirmations and script, or null when it is spent or unknown. */
export async function confirmedUnspent(chain: ObserverChain, txid: Hex, vout: number): Promise<{ sats: number; confirmations: number; script: Hex } | null> {
  if ('rpc' in chain) {
    const actual = await chain.rpc<{ value: number; confirmations: number; scriptPubKey: { hex: string } } | null>('gettxout', [txid, vout, true])
    return actual ? { sats: Math.round(actual.value * 1e8), confirmations: actual.confirmations, script: actual.scriptPubKey.hex } : null
  }
  const [spends, tx, tip] = await Promise.all([chain.outspends(txid), chain.getTx(txid), chain.getHeight()])
  const out = tx?.outputs[vout]
  if (!tx || tx.height === null || !out || spends[vout]?.spent !== false) return null
  return { sats: out.value, confirmations: tip - tx.height + 1, script: out.script }
}

/** The block hash of an 80-byte header (hex): double SHA-256, byte-reversed. */
export function blockHashOfHeader(headerHex: string): Hex {
  return bytesToHex(sha256(sha256(hexToBytes(headerHex))).reverse())
}

/**
 * Why a separate BTC-history Electrum server is not on the observer's chain (empty when it is): its block 0 and block 1
 * headers must hash to the chain's own (block 1 tells Mutinynet from the default signet). A server on another test
 * network would otherwise return empty histories that verify as a zero balance.
 */
export async function electrumChainProblems(electrum: ElectrumReader, expected: (height: number) => Promise<Hex | null>): Promise<string[]> {
  const problems: string[] = []
  for (const height of [0, 1]) {
    const [header, want] = await Promise.all([electrum.request<string>('blockchain.block.header', [height]).catch(() => null), expected(height).catch(() => null)])
    if (typeof header !== 'string' || !/^[0-9a-f]{160}$/i.test(header) || !want) { problems.push(`block ${height}: could not be compared`); continue }
    const got = blockHashOfHeader(header)
    if (got !== want) problems.push(`block ${height}: the Electrum server has ${got.slice(0, 16)}…, the chain ${want.slice(0, 16)}…`)
  }
  return problems
}

/** Where the BTC history is read: PASSBOOK_BTC_HISTORY_ELECTRUM (or the config's), else the RGB indexer as before. Never mainnet. */
export function btcHistoryEndpoint(cfg: RgbConfig, configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (cfg.network === 'mainnet') throw new Error('the history observer refuses mainnet')
  return configured ?? env.PASSBOOK_BTC_HISTORY_ELECTRUM ?? cfg.indexerUrl
}
export class RgbHistoryObserver implements HistoryObserverHooks {
  private readonly wallets = new Map<string, { borrowerPk: Hex; wallet: RgbWallet }>()
  private readonly invoices = new Map<string, string>()
  private readonly identities = new Map<string, Hex>()
  private readonly uninstall: () => void
  private readonly cfg: RgbConfig
  constructor(private readonly config: HistoryObserverConfig) {
    mkdirSync(config.rootDir, { recursive: true, mode: 0o700 })
    this.cfg = config.cfg ?? rgbConfigFromEnv()
    if (this.cfg.network === 'mainnet') throw new Error('the history observer refuses mainnet')
    this.uninstall = installHistoryObserver(this)
  }
  private file(pk: Hex): string { if (!/^[a-f0-9]{64}$/.test(pk)) throw new Error('invalid observer identity'); return join(this.config.rootDir, `${pk}.json`) }
  private read(pk: Hex): Journal {
    const j = JSON.parse(readFileSync(this.file(pk), 'utf8')) as Journal
    if (j.observer_pk !== this.config.signer.pubkey || j.borrower_pk !== pk || !verifyObject(j, this.config.signer.pubkey)) throw new Error('observer journal signature invalid')
    return j
  }
  private save(j: Omit<Journal, 'sig'> | Journal): void {
    const file = this.file(j.borrower_pk)
    writeFileSync(`${file}.tmp`, JSON.stringify(signObject(j, this.config.signer.secretKey)), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  /** Trusted seed orchestration only: never expose registration to remote borrowers. */
  registerFreshWallet(args: { borrowerPk: Hex; wallet: RgbWallet; watchKeys: WatchKeys; assetId: string }): void {
    if (existsSync(this.file(args.borrowerPk))) throw new Error('history observer already registered; cannot reset history')
    args.wallet.refresh()
    if (args.wallet.transfers(args.assetId).length || args.wallet.balance(args.assetId).settled || args.wallet.balance(args.assetId).future) throw new Error('history observer must begin before the first transfer')
    this.save({ v: 1, observer_pk: this.config.signer.pubkey, borrower_pk: args.borrowerPk, asset_id: args.assetId, keys: args.watchKeys, wallet_dir: resolve(args.wallet.dataDir), born_zero: true, incomplete: false, transfers: [] })
    this.wallets.set(resolve(args.wallet.dataDir), { borrowerPk: args.borrowerPk, wallet: args.wallet })
    this.identifyWallet(args.borrowerPk, args.wallet)
  }
  /** Reattach to an existing signed journal; a new journal is never inferred. */
  attachWallet(borrowerPk: Hex, wallet: RgbWallet): void {
    const j = this.read(borrowerPk)
    this.save({ ...j, wallet_dir: resolve(wallet.dataDir) })
    this.wallets.set(resolve(wallet.dataDir), { borrowerPk, wallet })
    this.identifyWallet(borrowerPk, wallet)
  }
  /** Trusted orchestrator binds a controlled wallet to its actual party key. */
  identifyWallet(pk: Hex, wallet: RgbWallet): void {
    if (!/^[a-f0-9]{64}$/.test(pk) || pk === '00'.repeat(32)) throw new Error('invalid observer wallet identity')
    const dir = resolve(wallet.dataDir), prior = this.identities.get(dir)
    if (prior && prior !== pk) throw new Error('wallet identity cannot be relabelled')
    this.identities.set(dir, pk)
  }
  hasWallet(borrowerPk: Hex): boolean { return existsSync(this.file(borrowerPk)) }
  invoice(walletDir: string, recipientId: string): void {
    const dir = resolve(walletDir)
    if (this.identities.has(dir)) this.invoices.set(recipientId, dir)
  }
  private append(walletDir: string | undefined, assetId: string, transfer: JournalTransfer): void {
    if (!walletDir) return
    const tracked = this.wallets.get(resolve(walletDir))
    if (!tracked) return
    const j = this.read(tracked.borrowerPk)
    if (j.asset_id !== assetId) return
    if (j.transfers.some((t) => t.txid === transfer.txid)) { j.incomplete = true; this.save(j); throw new Error('ambiguous duplicate history anchor') }
    this.save({ ...j, transfers: [...j.transfers, transfer] })
  }
  sent(senderDir: string, recipientId: string, assetId: string, amount: number, txid: string): void {
    const receiverDir = this.invoices.get(recipientId)
    this.append(senderDir, assetId, { txid, direction: 'out', amount, recipient_id: recipientId, counterparty_pk: receiverDir ? this.identities.get(receiverDir) ?? '00'.repeat(32) : '00'.repeat(32) })
    this.append(receiverDir, assetId, { txid, direction: 'in', amount, recipient_id: recipientId, counterparty_pk: this.identities.get(resolve(senderDir)) ?? '00'.repeat(32) })
  }
  ambiguous(senderDir: string, recipientId: string, assetId: string): void {
    for (const dir of [resolve(senderDir), this.invoices.get(recipientId)]) {
      const tracked = dir ? this.wallets.get(dir) : null
      if (!tracked) continue
      const j = this.read(tracked.borrowerPk)
      if (j.asset_id === assetId) this.save({ ...j, incomplete: true })
    }
  }
  async proof(borrowerPk: Hex): Promise<HistoryProof> {
    const j = this.read(borrowerPk)
    const tracked = [...this.wallets.values()].find((w) => w.borrowerPk === borrowerPk)
    if (!tracked || j.incomplete || !j.born_zero) throw new Error('history observer has incomplete coverage')
    const temp = mkdtempSync(join(tmpdir(), 'passbook-history-watch-'))
    let watch: WalletManager | undefined
    try {
      tracked.wallet.refresh()
      const password = randomHex(24)
      mkdirSync(join(temp, 'backup'), { mode: 0o700 })
      const backup = tracked.wallet.createWatchBackup(join(temp, 'backup'), password)
      const dataDir = join(temp, 'watch')
      mkdirSync(dataDir, { recursive: true })
      restoreFromBackup({ backupFilePath: backup, password, dataDir })
      // No mnemonic/seed is supplied. goOnline(false) performs consistency
      // checks and refresh fetches/validates any pending consignments.
      watch = new WalletManager({ dataDir, network: this.cfg.network, xpubVan: j.keys.account_xpub_vanilla, xpubCol: j.keys.account_xpub_colored, masterFingerprint: j.keys.master_fingerprint, indexerUrl: this.cfg.indexerUrl, transportEndpoint: this.cfg.transportEndpoint })
      watch.refreshWallet(); watch.refreshWallet()
      const raw = watch.listTransfers(j.asset_id) as unknown as { kind: string; status: string; txid: string | null; recipientId: string | null; requestedAssignment?: { Fungible?: number }; assignments?: { Fungible?: number }[] }[]
      if (raw.some((t) => t.status !== 'Settled' && t.status !== 'Failed')) throw new Error('history snapshot contains unsettled transfers')
      const native: ObservedTransfer[] = []
      for (const t of raw.filter((t) => t.status === 'Settled')) {
        if (!t.txid || !['Send', 'ReceiveWitness', 'ReceiveBlind'].includes(t.kind)) throw new Error('history snapshot cannot authenticate issuance or unanchored transfer')
        const tx = await this.config.chain.getTx(t.txid)
        if (!tx || tx.height === null) throw new Error('history anchor missing or unconfirmed')
        const amount = t.kind === 'Send' ? (t.requestedAssignment?.Fungible ?? 0) : (t.assignments ?? []).reduce((s, a) => s + (a.Fungible ?? 0), 0)
        native.push({ txid: t.txid, height: tx.height, direction: t.kind === 'Send' ? 'out' : 'in', amount, recipient_id: t.recipientId ?? '', counterparty_pk: j.transfers.find((o) => o.txid === t.txid)?.counterparty_pk ?? '00'.repeat(32) })
      }
      const observed: ObservedTransfer[] = []
      for (const t of j.transfers) {
        const actual = native.find((n) => n.txid === t.txid && n.direction === t.direction && n.amount === t.amount && n.recipient_id === t.recipient_id)
        if (!actual) throw new Error('native RGB transfers disagree with observer journal')
        observed.push(actual)
      }
      if (native.length !== observed.length) throw new Error('native wallet contains an unobserved transfer')
      const balance = watch.getAssetBalance(j.asset_id).settled ?? 0
      if (!Number.isSafeInteger(balance) || balance < 0 || observed.reduce((sum, t) => sum + (t.direction === 'in' ? BigInt(t.amount) : -BigInt(t.amount)), 0n) !== BigInt(balance)) throw new Error('native balance does not reconcile from zero')
      const allocations: ProvenAllocation[] = []
      // SDK .d.ts says `amount`; beta.8 actually returns an assignment enum.
      const unspents = watch.listUnspents() as unknown as { utxo: { outpoint: { txid: Hex; vout: number }; btcAmount: number }; rgbAllocations: { assetId: string; assignment: { Fungible?: number }; settled: boolean }[] }[]
      for (const u of unspents) {
        const amount = u.rgbAllocations.filter((a) => a.assetId === j.asset_id && a.settled).reduce((s, a) => s + (a.assignment?.Fungible ?? 0), 0)
        if (!amount) continue
        const o = u.utxo.outpoint
        const actual = await confirmedUnspent(this.config.chain, o.txid, o.vout)
        if (!actual || actual.confirmations < 1) throw new Error('native RGB allocation is not a confirmed unspent output')
        allocations.push({ txid: o.txid, vout: o.vout, amount, bitcoin_sats: actual.sats, script: actual.script })
      }
      if (allocations.reduce((sum, a) => sum + BigInt(a.amount), 0n) !== BigInt(balance)) throw new Error('native allocation sum does not match balance')
      const transfers = observed.sort((a, b) => a.height - b.height)
      const height = await this.config.chain.getHeight()
      const endpoint = btcHistoryEndpoint(this.cfg, this.config.btcHistoryElectrum)
      const electrum = new TcpElectrum(endpoint)
      // A separate Electrum server is trusted only on the observer's own chain (the RGB indexer path is unchanged).
      if (endpoint !== this.cfg.indexerUrl) {
        const problems = await electrumChainProblems(electrum, (h) => this.blockHash(h))
        if (problems.length) throw new Error(`BTC history Electrum server ${endpoint} is not on the observer's chain: ${problems.join('; ')}`)
      }
      const btc_history = await readBtcHistory([{ xpub: j.keys.account_xpub_vanilla, branches: [0, 1] }, { xpub: j.keys.account_xpub_colored, branches: [0, 1] }], electrum, this.config.chain as ChainClient, { additionalScripts: [keyPathOutput(borrowerPk).script] })
      if (btc_history.status !== 'verified') throw new Error('BTC history could not be independently read')
      return signObject({ v: 1 as const, assurance: 'trusted_wallet_snapshot' as const, observer_pk: this.config.signer.pubkey, borrower_pk: borrowerPk, asset_id: j.asset_id, wallet_xpubs_hash: hashObject(j.keys), observed_from_zero: true, first_transfer_txid: transfers[0]?.txid ?? null, opening_balance: 0, current_balance: balance, height, transfers, allocations, native_snapshot_hash: hashObject({ ledger: historyLedger(native), balance, allocations }), btc_history }, this.config.signer.secretKey)
    } finally { watch?.dispose(); rmSync(temp, { recursive: true, force: true }) }
  }
  /** The observer's chain's block hash at a height: bitcoind, else the Esplora RGB indexer rgb-lib already reads. */
  private async blockHash(height: number): Promise<Hex | null> {
    const chain = this.config.chain
    if ('rpc' in chain) return chain.rpc<Hex>('getblockhash', [height])
    if (!/^https?:\/\//.test(this.cfg.indexerUrl)) return null
    const res = await fetch(`${this.cfg.indexerUrl.replace(/\/$/, '')}/block-height/${height}`, { signal: AbortSignal.timeout(10_000) })
    return res.ok ? ((await res.text()).trim() as Hex) : null
  }
  close(): void { this.uninstall(); this.wallets.clear(); this.invoices.clear(); this.identities.clear() }
}
