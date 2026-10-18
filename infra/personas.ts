// All payments below are real, settled RGB transfers between our regtest wallets.
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Regtest } from '../src/chain/regtest.js'
import { settle } from '../src/rgb/wallet.js'
import { payInflow } from '../src/wallet/income.js'
import { loadSeed, openParty, type Party, type PersonaRole } from '../src/wallet/party.js'
import type { SeedState } from '../src/wallet/state.js'
import { historyObserverDir, RgbHistoryObserver } from '../src/rgb/history-observer.js'
import { watchKeys } from '../src/rgb/watch.js'
import { loadPlatformKey } from '../src/wallet/platform-key.js'

const CLIENTS = ['client1', 'client2', 'client3', 'client4'] as const
const ROLES: PersonaRole[] = ['fatima', 'walter', ...CLIENTS, 'wash-payer', 'wash-proxy']
const AMOUNTS = [[600, 1000, 1400, 800], [1100, 700, 900, 1300], [800, 1400, 600, 1000]]

export async function seedPersonas(state: SeedState, issuer: Party, regtest: Regtest, blocksPerMonth: number): Promise<void> {
  if (blocksPerMonth < 15) throw new Error('persona seed needs BLOCKS_PER_MONTH >= 15')
  const parties = {} as Record<PersonaRole, Party>
  const signer = loadPlatformKey()
  if (!signer || signer.pubkey !== state.platform_pk) throw new Error('persona history observer requires the trusted platform key')
  const observer = new RgbHistoryObserver({ rootDir: historyObserverDir(), signer, chain: regtest.chain })
  observer.identifyWallet(issuer.key.pubkey, issuer.rgb)
  const log = (message: string) => console.log(`[personas] ${message}`)
  const label = (party: Party, txid: string, other: Party, memo: string) => {
    const file = join(dirname(party.rgb.dataDir), 'labels.json')
    const labels = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    writeFileSync(file, JSON.stringify({ ...labels, [txid]: { counterparty_pk: other.key.pubkey, memo } }, null, 2) + '\n')
  }
  const heightOf = async (txid: string) => (await regtest.chain.getTx(txid))!.height!
  const pay = async (from: Party, to: Party, amount: number, memo: string) => {
    const invoice = to.rgb.invoice(amount, state.asset.id)
    const { txid } = await from.rgb.send({ invoice: invoice.invoice, amount, assetId: state.asset.id })
    await settle({ sender: from.rgb, receiver: to.rgb, assetId: state.asset.id, txid, mine: () => regtest.mine(1) })
    label(from, txid, to, memo)
    label(to, txid, from, memo)
    return { txid, height: await heightOf(txid), amount }
  }
  try {
    for (const role of ROLES) {
      const p = parties[role] = await openParty(role, { create: true })
      observer.identifyWallet(p.key.pubkey, p.rgb)
      await regtest.send(p.rgb.address(), 0.025)
      if (role === 'fatima' || role === 'walter') await regtest.send(p.btcAddress, 0.25)
    }
    await regtest.mine(1)
    for (const role of ['fatima', 'walter'] as const) observer.registerFreshWallet({ borrowerPk: parties[role].key.pubkey, wallet: parties[role].rgb, watchKeys: await watchKeys(loadSeed(role)), assetId: state.asset.id })
    for (const p of Object.values(parties)) await p.rgb.createUtxos(8)
    await regtest.mine(1)
    for (const role of CLIENTS) await pay(issuer, parties[role], 15_000e6, 'demo client working capital')
    await pay(issuer, parties.walter, 10_000e6, 'starting wallet funds, not income')
    await pay(issuer, parties['wash-payer'], 5_000e6, 'demo payer working capital')
    const part = (p: Party) => ({ pubkey: p.key.pubkey, btc_address: p.btcAddress, rgb_address: p.rgb.address() })
    const fatima = { party: part(parties.fatima), inflows: [] as SeedState['borrower_inflows'], seeded_height: 0 }
    const walter = { party: part(parties.walter), inflows: [] as SeedState['borrower_inflows'], seeded_height: 0 }
    const off_history: NonNullable<SeedState['personas']>['off_history'] = []
    const start = await regtest.chain.getHeight()
    for (let month = 0; month < 3; month++) {
      const target = start + month * blocksPerMonth
      const height = await regtest.chain.getHeight()
      if (height < target) await regtest.mine(target - height)
      for (let client = 0; client < 4; client++) {
        const payer = parties[CLIENTS[client]]
        const memo = client === 1 ? `retainer, month ${month + 1}` : `invoice ${month * 4 + client + 23}: logo design`
        const inflow = await payInflow({ payer, borrower: parties.fatima, amount: AMOUNTS[month][client] * 1e6, memo, assetId: state.asset.id, mine: () => regtest.mine(1), heightOf })
        fatima.inflows.push(inflow)
      }
      await pay(parties.walter, parties['wash-proxy'], 2500e6, 'transfer')
      const hidden = await pay(parties['wash-proxy'], parties['wash-payer'], 2500e6, 'intermediary pays salary wallet')
      off_history.push({ ...hidden, direction: 'out', counterparty_pk: parties['wash-payer'].key.pubkey, memo: 'real K to W transfer, outside Walter history' })
      walter.inflows.push(await payInflow({ payer: parties['wash-payer'], borrower: parties.walter, amount: 2500e6, memo: 'salary', assetId: state.asset.id, mine: () => regtest.mine(1), heightOf }))
      log(`month ${month + 1}: four client payments and Walter → K → W → Walter settled`)
    }
    fatima.seeded_height = walter.seeded_height = await regtest.chain.getHeight()
    state.personas = { fatima, walter, off_history }
    log(`Fatima ${fatima.inflows.length} signed inflows; Walter ${walter.inflows.length}; K→W ${off_history.length} real transfers`)
  } finally {
    observer.close()
    for (const p of Object.values(parties)) p.close()
  }
}
