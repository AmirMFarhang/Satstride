// The laptop's payer (seeded by `npm run seed`) pays a phone's blinded RGB invoice in the
// lender's test USDT: the phone borrower's income history, the way the seeded laptop
// borrower got its salary. Regtest only. Env: the provider environment (provider.sh env).
//   npx tsx apps/mobile/infra/salary.ts <rgb invoice> <usdt>
import { openParty } from '../../../src/wallet/party.js'
import { readState } from '../../../src/wallet/state.js'
import { Regtest } from '../../../src/chain/regtest.js'
import { MICRO_PER_USDT } from '../../../src/core/money.js'

async function main() {
  const [invoice, usdtArg] = process.argv.slice(2)
  if (!invoice?.startsWith('rgb:') || !/^\d+(\.\d{1,6})?$/.test(usdtArg ?? '')) throw new Error('usage: salary.ts <rgb invoice> <usdt>')
  const amount = Math.round(Number(usdtArg) * MICRO_PER_USDT)
  const state = readState()
  const regtest = new Regtest()
  await regtest.ensureMiner()
  const payer = await openParty('payer')
  try {
    const decoded = payer.rgb.decodeInvoice(invoice)
    if (decoded.network && !/regtest/i.test(String(decoded.network))) throw new Error(`invoice is for ${decoded.network}`)
    payer.rgb.refresh()
    const sent = await payer.rgb.send({ invoice, assetId: state.asset.id, amount })
    await regtest.mine(1)
    for (let i = 0; i < 4; i++) { payer.rgb.refresh(); await new Promise((r) => setTimeout(r, 1500)) }
    console.log(JSON.stringify({ paid_usdt: usdtArg, asset_id: state.asset.id, txid: sent.txid, payer_pk: state.parties.payer.pubkey }))
  } finally { payer.close() }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
