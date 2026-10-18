// The wallet panel's bitcoin account, on WDK's BTC module (@tetherto/wdk-wallet-btc,
// pinned 1.0.0-beta.17): BIP-84 P2WPKH at m/84'/1'/0'/0/0 on every test network.
// Regtest talks Electrum to the local electrs; Mutinynet and testnet4 talk to
// Esplora through EsploraBtcClient, a small IBtcClient over src/chain/esplora.ts.
//
// The same seed also drives the RGB wallet (m/86'/…, src/rgb/wallet.ts) and the
// Passbook party key (m/86'/1'/0'/0/0, src/wallet/party.ts); the paths never overlap.

import * as bitcoin from 'bitcoinjs-lib'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import { EsploraChain } from '../chain/esplora.js'
import type { NetworkProfile } from '../core/network.js'

/** The account surface we use (1.0.0-beta.17). */
interface BtcAccount {
  getAddress(): Promise<string>
  getBalance(): Promise<bigint>
  quoteSendTransaction(tx: { to: string; value: number | bigint; feeRate?: number | bigint } | string): Promise<{ fee: bigint }>
  signTransaction(tx: { to: string; value: number | bigint; feeRate?: number | bigint }): Promise<string>
  sendTransaction(tx: string, timeoutMs?: number): Promise<{ hash: string; fee: bigint }>
  getTransfers(o?: { direction?: 'incoming' | 'outgoing' | 'all'; limit?: number }): Promise<{ txid: string; height: number; value: bigint; direction: 'incoming' | 'outgoing'; fee?: bigint; recipient?: string }[]>
  dispose(): void
}

/** IBtcClient over Esplora (the shape wdk-wallet-btc's transports/btc-client.js defines). */
export class EsploraBtcClient {
  readonly esplora: EsploraChain
  constructor(base: string, private readonly network: bitcoin.Network) { this.esplora = new EsploraChain(base) }
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async reconnect(): Promise<void> {}
  async getBalance(address: string) { return this.esplora.addressStats(address) }
  async listUnspent(address: string) {
    return (await this.esplora.utxos(address)).map((u) => ({ tx_hash: u.txid, tx_pos: u.vout, value: u.value, height: u.status.confirmed ? u.status.block_height ?? 0 : 0 }))
  }
  async getHistory(address: string) {
    return (await this.esplora.addressTxs(address)).map((t) => ({ tx_hash: t.txid, height: t.status.confirmed ? t.status.block_height ?? 0 : 0 }))
  }
  async getBlockHeight() { return this.esplora.getHeight() }
  async getTransaction(txid: string) {
    const hex = await this.esplora.rawTx(txid)
    if (!hex) throw new Error(`unknown transaction ${txid}`)
    return hex
  }
  async broadcast(hex: string) { return this.esplora.broadcast(hex) }
  /** BTC/kB, as Electrum's estimatefee returns it. */
  async estimateFee(blocks: number) {
    const est = await this.esplora.feeEstimates()
    const satVb = est[String(blocks)] ?? est['1'] ?? 1
    return (Math.max(1, satVb) * 1000) / 1e8
  }
  /** the address network, for callers that need it */
  get bitcoinNetwork(): bitcoin.Network { return this.network }
}

export function addressNetwork(profile: Pick<NetworkProfile, 'addressNetwork'>): bitcoin.Network {
  return bitcoin.networks[profile.addressNetwork]
}

/** Which test network an address belongs to; null when it does not decode on this profile (a mainnet bc1… never does). */
export function decodeAddress(address: string, profile: Pick<NetworkProfile, 'addressNetwork'>): { type: string; script: string } | null {
  try {
    const script = bitcoin.address.toOutputScript(address.trim(), addressNetwork(profile))
    const s = Buffer.from(script).toString('hex')
    const type = s.startsWith('0014') && s.length === 44 ? 'P2WPKH (native SegWit)' : s.startsWith('5120') && s.length === 68 ? 'P2TR (Taproot)' : s.startsWith('0020') && s.length === 68 ? 'P2WSH' : s.startsWith('a914') ? 'P2SH' : s.startsWith('76a914') ? 'P2PKH (legacy)' : 'other script'
    return { type, script: s }
  } catch {
    return null
  }
}

export interface DecodedTx {
  txid: string
  vsize: number
  inputs: { txid: string; vout: number }[]
  outputs: { address: string | null; value: number; script: string }[]
}

export function decodeTx(hex: string, profile: Pick<NetworkProfile, 'addressNetwork'>): DecodedTx {
  const tx = bitcoin.Transaction.fromHex(hex)
  const net = addressNetwork(profile)
  return {
    txid: tx.getId(),
    vsize: tx.virtualSize(),
    inputs: tx.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })),
    outputs: tx.outs.map((o) => {
      let address: string | null = null
      try { address = bitcoin.address.fromOutputScript(o.script, net) } catch { /* OP_RETURN and friends */ }
      return { address, value: Number(o.value), script: Buffer.from(o.script).toString('hex') }
    }),
  }
}

export interface BtcTransferRow { txid: string; height: number; sats: number; direction: 'in' | 'out'; fee: number | null; counterparty: string | null }

export class WdkBtcWallet {
  private constructor(private readonly manager: { dispose(): void }, private readonly account: BtcAccount, readonly profile: NetworkProfile, readonly feeRate: number) {}

  static async open(words: string, profile: NetworkProfile): Promise<WdkBtcWallet> {
    const network = profile.addressNetwork
    let client: unknown
    if (/^https?:/.test(profile.endpoints.esplora ?? '')) client = new EsploraBtcClient(profile.endpoints.esplora!, addressNetwork(profile))
    else if (/^https?:/.test(profile.endpoints.rgb_indexer)) client = new EsploraBtcClient(profile.endpoints.rgb_indexer, addressNetwork(profile))
    else {
      const u = new URL(profile.endpoints.rgb_indexer)
      client = { type: 'electrum', clientConfig: { host: u.hostname, port: Number(u.port || 50001), protocol: u.protocol === 'ssl:' ? 'ssl' : 'tcp', maxRetry: 2 } }
    }
    const manager = new WalletManagerBtc(words, { network, bip: 84, client } as never) as unknown as { getAccount(i: number): Promise<BtcAccount>; dispose(): void }
    // regtest relays at 1 sat/vB; public test networks: 1 sat/vB too (Mutinynet's estimate rounds to 0)
    return new WdkBtcWallet(manager, await manager.getAccount(0), profile, Number(process.env.PASSBOOK_WALLET_FEE_RATE ?? (profile.public ? 1 : 2)))
  }

  address(): Promise<string> { return this.account.getAddress() }
  async balanceSats(): Promise<number> { return Number(await this.account.getBalance()) }

  async quote(to: string, sats: number): Promise<{ fee: number }> {
    const q = await this.account.quoteSendTransaction({ to, value: sats, feeRate: this.feeRate })
    return { fee: Number(q.fee) }
  }

  /** The fee a signed transaction pays, from its inputs' values. */
  async signedFee(hex: string): Promise<number> { return Number((await this.account.quoteSendTransaction(hex)).fee) }

  /** Signs without broadcasting; the caller decodes and checks it against what the user approved. */
  sign(to: string, sats: number): Promise<string> { return this.account.signTransaction({ to, value: sats, feeRate: this.feeRate }) }

  async broadcast(hex: string): Promise<{ txid: string; fee: number }> {
    const r = await this.account.sendTransaction(hex, 3000)
    return { txid: r.hash, fee: Number(r.fee) }
  }

  async transfers(limit = 50): Promise<BtcTransferRow[]> {
    const rows = await this.account.getTransfers({ direction: 'all', limit })
    return rows.map((t) => ({ txid: t.txid, height: t.height, sats: Number(t.value), direction: t.direction === 'incoming' ? 'in' : 'out', fee: t.fee === undefined ? null : Number(t.fee), counterparty: t.recipient ?? null }))
  }

  close(): void { this.manager.dispose() }
}
