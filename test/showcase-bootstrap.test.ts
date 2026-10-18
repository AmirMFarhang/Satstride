import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BitcoindChain } from '../src/chain/bitcoind.js'
import { Regtest } from '../src/chain/regtest.js'
import { ensureShowcaseFunds } from '../src/cli/showcase-bootstrap.js'

interface Call { method: string; params: unknown[]; wallet?: string }

// Exercises the actual Regtest.ensureMiner/mine methods against a fake RPC.
// Balance snapshots stand for bitcoind's spendable balance, excluding immature
// rewards; these tests never start a service or use a real wallet or chain.
class BootstrapChain extends BitcoindChain {
  calls: Call[] = []
  private balanceReads = 0
  constructor(readonly snapshots: unknown[], public height = 0, readonly network = 'regtest', private loaded = true) {
    super({ url: 'http://unused.invalid', user: '', password: '' })
  }
  override async rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    this.calls.push({ method, params, wallet })
    let result: unknown
    switch (method) {
      case 'getblockchaininfo': result = { chain: this.network, blocks: this.height }; break
      case 'listwallets': result = this.loaded ? ['miner'] : []; break
      case 'loadwallet': throw new Error('wallet does not exist')
      case 'createwallet': this.loaded = true; result = { name: 'miner' }; break
      case 'getbalance': result = this.snapshots[Math.min(this.balanceReads++, this.snapshots.length - 1)]; break
      case 'getnewaddress': result = 'regtest-miner-address'; break
      case 'generatetoaddress': this.height += params[0] as number; result = []; break
      case 'getblockcount': result = this.height; break
      default: throw new Error(`unexpected RPC: ${method}`)
    }
    return result as T
  }
  get miningCalls(): Call[] { return this.calls.filter((call) => call.method === 'generatetoaddress') }
}

describe('showcase miner bootstrap (fake RPC)', () => {
  it('refuses other networks before loading wallets or mining', async () => {
    for (const network of ['main', 'test', 'signet']) {
      const chain = new BootstrapChain([0], 0, network, false)
      await assert.rejects(ensureShowcaseFunds(new Regtest(chain, 0)), /regtest-only/)
      assert.deepEqual(chain.calls.map((call) => call.method), ['getblockchaininfo'])
    }
  })

  it('creates an empty miner and matures its first reward by block 101', async () => {
    const chain = new BootstrapChain([0, 50], 0, 'regtest', false)
    assert.deepEqual(await ensureShowcaseFunds(new Regtest(chain, 0)), { minedBlocks: 101, balanceBtc: 50 })
    assert.equal(chain.height, 101)
    assert.equal(chain.calls.filter((call) => call.method === 'createwallet').length, 1)
    assert.deepEqual(chain.miningCalls.map((call) => call.params), [[101, 'regtest-miner-address']])
    assert.ok(chain.calls.filter((call) => call.method === 'getbalance').every((call) => call.wallet === 'miner' && JSON.stringify(call.params) === '["*",1,false]'))
  })

  it('does not advance a funded chain, including an exact budget match', async () => {
    for (const btc of [5, 100]) {
      const chain = new BootstrapChain([btc], 3187)
      assert.deepEqual(await ensureShowcaseFunds(new Regtest(chain, 0)), { minedBlocks: 0, balanceBtc: btc })
      assert.equal(chain.height, 3187)
      assert.deepEqual(chain.calls.map((call) => call.method), ['getblockchaininfo', 'listwallets', 'getbalance'])
    }
  })

  it('rechecks spendable funds after maturing a partially funded miner', async () => {
    const chain = new BootstrapChain([4.9, 12], 80)
    assert.deepEqual(await ensureShowcaseFunds(new Regtest(chain, 0)), { minedBlocks: 101, balanceBtc: 12 })
    assert.equal(chain.height, 181)
    assert.equal(chain.miningCalls.length, 1)
  })

  it('honors an explicit seed budget', async () => {
    const chain = new BootstrapChain([6, 56], 200)
    assert.deepEqual(await ensureShowcaseFunds(new Regtest(chain, 0), 7), { minedBlocks: 101, balanceBtc: 56 })
  })

  it('stops after one maturity window when funds are still insufficient', async () => {
    const chain = new BootstrapChain([0.1, 0.2], 100_000)
    await assert.rejects(ensureShowcaseFunds(new Regtest(chain, 0)), /insufficient spendable BTC after 101 bootstrap blocks/)
    assert.equal(chain.miningCalls.length, 1)
    assert.equal(chain.height, 100_101)
    assert.equal(chain.calls.filter((call) => call.method === 'getbalance').length, 2)
  })

  it('rejects invalid budgets and invalid RPC balances without mining', async () => {
    for (const budget of [-1, NaN, Infinity]) {
      const chain = new BootstrapChain([0])
      await assert.rejects(ensureShowcaseFunds(new Regtest(chain, 0), budget), /minimum BTC/)
      assert.deepEqual(chain.calls, [])
    }
    for (const btc of [-1, NaN, Infinity, undefined, '50']) {
      const chain = new BootstrapChain([btc])
      await assert.rejects(ensureShowcaseFunds(new Regtest(chain, 0)), /invalid spendable BTC balance/)
      assert.deepEqual(chain.miningCalls, [])
    }
  })
})
