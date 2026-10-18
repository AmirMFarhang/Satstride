import type { Regtest } from '../chain/regtest.js'

// One new coinbase needs 100 further blocks before it is safely spendable.
// Starting from an empty chain, 101 blocks provide that maturity window.
const BOOTSTRAP_BLOCKS = 101

/** Fund a fresh showcase's miner without advancing an already funded chain.
 * The caller must select its isolated chain before invoking this helper. */
export async function ensureShowcaseFunds(regtest: Regtest, minimumBtc = 5): Promise<{ minedBlocks: number; balanceBtc: number }> {
  if (!Number.isFinite(minimumBtc) || minimumBtc < 0) throw new Error('showcase minimum BTC must be a finite non-negative number')
  const info = await regtest.chain.rpc<{ chain: string }>('getblockchaininfo')
  if (info.chain !== 'regtest') throw new Error('showcase funding is regtest-only')
  await regtest.ensureMiner()

  const balance = async (): Promise<number> => {
    const btc = await regtest.chain.rpc<number>('getbalance', ['*', 1, false], 'miner')
    if (!Number.isFinite(btc) || btc < 0) throw new Error('miner returned an invalid spendable BTC balance')
    return btc
  }

  let balanceBtc = await balance()
  if (balanceBtc >= minimumBtc) return { minedBlocks: 0, balanceBtc }
  // Also matures existing immature coinbases. One bounded attempt avoids
  // silently mining indefinitely on an old chain with a reduced subsidy.
  await regtest.mine(BOOTSTRAP_BLOCKS)
  balanceBtc = await balance()
  if (balanceBtc < minimumBtc) throw new Error(`miner has insufficient spendable BTC after ${BOOTSTRAP_BLOCKS} bootstrap blocks: ${balanceBtc} available, ${minimumBtc} required`)
  return { minedBlocks: BOOTSTRAP_BLOCKS, balanceBtc }
}
