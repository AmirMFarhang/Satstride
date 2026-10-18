// npm run seed: run once after `infra/regtest.sh start` (handoff section 5).
//
//  1. WDK seeds for borrower, lender1, lender2 and payer, a platform key; fund with regtest BTC
//  2. colorable UTXOs for every RGB wallet
//  3. the payer issues the mock dollar: RGB NIA, ticker USDT, precision 6
//  4. USDT to both lenders
//  5. six payer-signed USDT inflows to the borrower: a monthly salary and two irregular transfers
//  6. infra/state.json with every public key, address, txid and the contract id,
//     and the platform's published economics (platform share, APR cap, LTV per term)
//
// Every transfer is a real RGB transfer on regtest, settled on both sides before
// the next one starts. `--fresh` wipes existing wallets and state first.

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Regtest } from '../src/chain/regtest.js'
import { publishedEconomics } from '../src/core/economics.js'
import { MICRO_PER_USDT, usdt, type Micro } from '../src/core/money.js'
import { settle, type RgbWallet } from '../src/rgb/wallet.js'
import { payInflow, SALARY } from '../src/wallet/income.js'
import { openParty, ROLES, type Party, type Role } from '../src/wallet/party.js'
import { loadPlatformKey, walletsDir } from '../src/wallet/platform-key.js'
import { statePath, writeState, type SeedState, type SeededInflow } from '../src/wallet/state.js'
import { seedPersonas } from './personas.js'

const BLOCKS_PER_MONTH = Number(process.env.BLOCKS_PER_MONTH ?? 30)
const SUPPLY: Micro = 10_000_000 * MICRO_PER_USDT
const LENDER_FLOAT: Micro = 100_000 * MICRO_PER_USDT

/** The borrower's six inflows in order, with the blocks to mine before each. */
const INFLOWS: { amount: Micro; memo: string; gap: number }[] = [
  { amount: SALARY, memo: 'salary', gap: 0 },
  { amount: 420 * MICRO_PER_USDT, memo: 'freelance invoice', gap: 11 },
  { amount: SALARY, memo: 'salary', gap: BLOCKS_PER_MONTH - 11 },
  { amount: SALARY, memo: 'salary', gap: BLOCKS_PER_MONTH },
  { amount: 760 * MICRO_PER_USDT, memo: 'sold a bike', gap: 17 },
  { amount: SALARY, memo: 'salary', gap: BLOCKS_PER_MONTH - 17 },
]

const log = (msg: string) => console.log(`[seed] ${msg}`)

async function main() {
  const fresh = process.argv.includes('--fresh')
  if (existsSync(statePath()) || existsSync(join(walletsDir(), 'borrower'))) {
    if (!fresh) throw new Error(`${statePath()} or wallets already exist; rerun with --fresh to replace them (after infra/regtest.sh reset && start)`)
    rmSync(walletsDir(), { recursive: true, force: true })
    rmSync(statePath(), { force: true })
    log('removed previous wallets and state')
  }

  const regtest = new Regtest()
  await regtest.ensureMiner()
  log(`regtest height ${await regtest.chain.getHeight()}`)

  // 1. wallets and BTC
  const platform = loadPlatformKey({ create: true })!
  const parties = {} as Record<Role, Party>
  for (const role of ROLES) parties[role] = await openParty(role, { create: true })
  const { borrower, lender1, lender2, payer } = parties
  const funding = [
    await regtest.send(borrower.btcAddress, 0.5), // collateral
    await regtest.send(borrower.rgb.address(), 0.02), // RGB UTXOs to repay from
    await regtest.send(lender1.rgb.address(), 0.05),
    await regtest.send(lender2.rgb.address(), 0.05),
    await regtest.send(payer.rgb.address(), 0.1),
  ]
  await regtest.mine(1)
  log(`funded ${funding.length} addresses`)

  // 2. colorable UTXOs
  for (const [p, n] of [[payer, 12], [lender1, 5], [lender2, 5], [borrower, 5]] as const) {
    const made = await p.rgb.createUtxos(n)
    log(`${p.role}: ${made} colorable UTXOs`)
  }
  await regtest.mine(1)

  // 3. the mock dollar
  const assetId = payer.rgb.issueNia({ ticker: 'USDT', name: 'Tether USD (regtest stand-in)', precision: 6, amount: SUPPLY })
  log(`issued ${usdt(SUPPLY)} as ${assetId}`)

  const heightOf = async (txid: string) => (await regtest.chain.getTx(txid))!.height!
  const pay = async (from: Party, to: Party, amount: Micro) => {
    const inv = to.rgb.invoice(amount, assetId)
    const { txid } = await from.rgb.send({ invoice: inv.invoice, assetId, amount })
    await settle({ sender: from.rgb, receiver: to.rgb, assetId, txid, mine: () => regtest.mine(1) })
    const height = (await regtest.chain.getTx(txid))!.height!
    return { txid, height }
  }

  // 4. lenders' float
  const lenderFunding: SeedState['lender_funding'] = []
  for (const lender of [lender1, lender2]) {
    const { txid } = await pay(payer, lender, LENDER_FLOAT)
    lenderFunding.push({ role: lender.role as Role, txid, amount: LENDER_FLOAT })
    log(`${lender.role} received ${usdt(LENDER_FLOAT)} in ${txid.slice(0, 12)}`)
  }

  // 5. the borrower's income, each inflow signed by the payer for the sandbox
  const inflows: SeededInflow[] = []
  for (const i of INFLOWS) {
    if (i.gap > 0) await regtest.mine(i.gap)
    const inflow = await payInflow({ payer, borrower, assetId, amount: i.amount, memo: i.memo, mine: () => regtest.mine(1), heightOf })
    inflows.push(inflow)
    log(`borrower received ${usdt(i.amount)} (${i.memo}) at height ${inflow.height}`)
  }
  const balance = borrower.rgb.balance(assetId).settled
  log(`borrower USDT balance ${usdt(balance)}`)

  // 6. state
  const rgbAddress = (w: RgbWallet) => w.address()
  const state: SeedState = {
    v: 1,
    created_at: new Date().toISOString(),
    network: 'regtest',
    asset: { id: assetId, ticker: 'USDT', name: 'Tether USD (regtest stand-in)', precision: 6, supply: SUPPLY, issuer: 'payer' },
    platform_pk: platform.pubkey,
    economics: publishedEconomics(),
    parties: Object.fromEntries(ROLES.map((r) => [r, { pubkey: parties[r].key.pubkey, btc_address: parties[r].btcAddress, rgb_address: rgbAddress(parties[r].rgb) }])) as SeedState['parties'],
    funding_txids: funding,
    lender_funding: lenderFunding,
    borrower_inflows: inflows,
    seeded_height: await regtest.chain.getHeight(),
  }
  if (process.argv.includes('--personas')) await seedPersonas(state, payer, regtest, BLOCKS_PER_MONTH)
  state.seeded_height = await regtest.chain.getHeight()
  writeState(state)
  for (const p of Object.values(parties)) p.close()
  log(`wrote ${statePath()} at height ${state.seeded_height}`)
}

main().catch((err) => {
  console.error(`[seed] failed: ${(err as Error).message}`)
  process.exit(1)
})
