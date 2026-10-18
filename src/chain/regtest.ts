// Regtest-only helpers on top of the bitcoind client: mine blocks to the node's
// own "miner" wallet and fund addresses from it. Used by the seed script, the
// demo and the regtest integration tests; the platform never calls these.

import { BitcoindChain } from './bitcoind.js'

const MINER_WALLET = 'miner'

export class Regtest {
  constructor(
    readonly chain: BitcoindChain = BitcoindChain.fromEnv(),
    /** pause after mining so electrs indexes the block before wallets sync */
    readonly indexDelayMs = Number(process.env.ELECTRS_INDEX_DELAY_MS ?? 1500),
  ) {}

  private walletRpc<T>(method: string, params: unknown[] = []): Promise<T> {
    return this.chain.rpc<T>(method, params, MINER_WALLET)
  }

  async ensureMiner(): Promise<void> {
    const loaded = await this.chain.rpc<string[]>('listwallets')
    if (loaded.includes(MINER_WALLET)) return
    try {
      await this.chain.rpc('loadwallet', [MINER_WALLET])
    } catch {
      await this.chain.rpc('createwallet', [MINER_WALLET])
    }
  }

  async mine(blocks = 1): Promise<number> {
    const addr = await this.walletRpc<string>('getnewaddress')
    await this.chain.rpc('generatetoaddress', [blocks, addr])
    if (this.indexDelayMs > 0) await new Promise((r) => setTimeout(r, this.indexDelayMs))
    return this.chain.getHeight()
  }

  /** Send BTC from the miner wallet; does not mine. Returns the txid. */
  async send(address: string, btc: number): Promise<string> {
    return this.walletRpc<string>('sendtoaddress', [address, btc])
  }

  async fund(address: string, btc: number): Promise<string> {
    const txid = await this.send(address, btc)
    await this.mine(1)
    return txid
  }
}
