// Real-only spike: WDK on-chain disbursement, bridge the SAME asset to RLN,
// funded RGB channel, Lightning payment, borrower-only collateral release.
// Run only against an isolated regtest stack; never uses QVAC or a mock node.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BorrowerAgent } from '../src/agents/borrower.js'
import { PlatformClient } from '../src/agents/platform-client.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { Regtest } from '../src/chain/regtest.js'
import { randomHex, randomKeyPair, hexToBytes, sha256Hex } from '../src/core/crypto.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { buildLock, extractHex, signKeyPath } from '../src/escrow/escrow.js'
import { Oracle } from '../src/oracle/oracle.js'
import { createAtomicRepayment, RgbLightningNode } from '../src/rgb/lightning.js'
import { settle } from '../src/rgb/wallet.js'
import { openParty } from '../src/wallet/party.js'

interface Channel { asset_id: string | null; is_usable: boolean; channel_id: string; asset_local_amount: number | null; asset_remote_amount: number | null }
interface AssetBalance { settled: number; spendable: number; offchain_outbound: number; offchain_inbound: number }

export async function runAtomicSpike() {
  if (process.env.BITCOIND_URL === undefined) throw new Error('set BITCOIND_URL explicitly to your isolated regtest node')
  const regtest = new Regtest()
  const dir = mkdtempSync(join(tmpdir(), 'passbook-atomic-'))
  const payer = new RgbLightningNode(process.env.PASSBOOK_BORROWER_LIGHTNING_URL ?? 'http://127.0.0.1:3101')
  const payee = new RgbLightningNode(process.env.PASSBOOK_LENDER_LIGHTNING_URL ?? 'http://127.0.0.1:3102')
  const timings: Record<string, number> = {}
  const started = Date.now()
  const mark = (step: string) => { timings[step] = Date.now() - started; process.stdout.write(`${step}: ${timings[step]} ms\n`) }
  const borrower = await openParty('borrower', { dir, create: true })
  const lender = await openParty('lender1', { dir, create: true })
  let agent: BorrowerAgent | undefined
  try {
    await regtest.ensureMiner()
    for (const node of [payer, payee]) {
      try { await node.request('/nodeinfo') } catch {
        try { await node.request('/init', { password: 'passbook-regtest-only' }) } catch (e) { if (!/AlreadyInitialized|already initialized/i.test(String(e))) throw e }
        await node.request('/unlock', { password: 'passbook-regtest-only', ldk_chain_sync: { mode: 'BlockSync', config: { bitcoind_rpc_username: 'user', bitcoind_rpc_password: 'password', bitcoind_rpc_host: 'bitcoind', bitcoind_rpc_port: 18443 } }, indexer_url: 'electrs:50001', announce_addresses: [] })
      }
      const { address } = await node.request<{ address: string }>('/address', {})
      await regtest.fund(address, 0.2)
      await node.request('/createutxos', { up_to: true, num: 5, size: 50_000, fee_rate: 1, skip_sync: false }).catch((e) => { if (!/AllocationsAlreadyAvailable/.test(String(e))) throw e })
      await regtest.mine(1)
    }
    mark('nodes_funded')
    await regtest.send(lender.rgb.address(), 0.1)
    await regtest.send(borrower.rgb.address(), 0.1)
    await regtest.send(borrower.btcAddress, 0.05)
    await regtest.mine(1)
    await lender.rgb.createUtxos(5)
    await borrower.rgb.createUtxos(5)
    await regtest.mine(1)
    const asset = lender.rgb.issueNia({ ticker: 'USDT', name: 'Passbook atomic test USD', precision: 6, amount: 10_000_000_000 })
    const inv = borrower.rgb.invoice(606_000_000, asset)
    const sent = await lender.rgb.send({ invoice: inv.invoice, assetId: asset, amount: 606_000_000 })
    await settle({ sender: lender.rgb, receiver: borrower.rgb, assetId: asset, txid: sent.txid, mine: () => regtest.mine(1) })
    mark('wdk_bootstrap_settled')
    const bridgeInv = await payer.request<{ invoice: string }>('/rgbinvoice', { min_confirmations: 1, witness: true, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600, transport_endpoints: [process.env.PASSBOOK_LIGHTNING_PROXY ?? 'rpc://rgb-proxy:3000/json-rpc'] })
    const bridge = await borrower.rgb.send({ invoice: bridgeInv.invoice, assetId: asset, amount: 606_000_000 })
    for (let i = 0; i < 12; i++) {
      await payer.request('/refreshtransfers', { skip_sync: false, filter: [] })
      borrower.rgb.refresh()
      const balance = await payer.request<AssetBalance>('/assetbalance', { asset_id: asset }).catch(() => undefined)
      if (balance?.spendable === 606_000_000 && borrower.rgb.transferByTxid(asset, bridge.txid, 'Send')?.status === 'Settled') break
      if (i === 11) throw new Error(`WDK-to-RLN bridge did not settle: ${JSON.stringify(balance)}`)
      await regtest.mine(1)
    }
    mark('same_wdk_asset_bridged_to_rln')
    const { pubkey } = await payee.request<{ pubkey: string }>('/nodeinfo')
    await payer.request('/openchannel', { peer_pubkey_and_opt_addr: `${pubkey}@passbook-rln-payee:9735`, capacity_sat: 100_000, push_msat: 3_500_000, public: false, with_anchors: true, asset_id: asset, asset_amount: 606_000_000, push_asset_amount: 0 })
    let channel: Channel | undefined
    for (let i = 0; i < 35; i++) {
      const { channels } = await payer.request<{ channels: Channel[] }>('/listchannels')
      channel = channels.find((c) => c.asset_id === asset && c.is_usable)
      if (channel) break
      if (i === 34) throw new Error(`RGB channel did not become usable: ${JSON.stringify(channels)}`)
      await regtest.mine(1)
    }
    mark('rgb_channel_usable')
    const payeeBefore = (await payee.request<{ channels: Channel[] }>('/listchannels')).channels.find((c) => c.channel_id === channel!.channel_id)
    if (!payeeBefore) throw new Error('payee has no matching RGB channel')
    const height = await regtest.chain.getHeight()
    const platform = randomKeyPair()
    const terms: LoanTerms = { v: 1, borrower_pk: borrower.key.pubkey, lender_pk: lender.key.pubkey, platform_pk: platform.pubkey, asset_id: asset, principal: 600_000_000, fee: 6_000_000, collateral_sats: 2_000_000, oracle_quote: new Oracle(platform, 10_000_000).quote(height), open_height: height, maturity_height: height + 30, grace_blocks: 5, recovery_height: height + 55, ladder_step: 0, ltv_bps: 3030, prev_passbook_txid: null, nonce: randomHex(32) }
    terms.atomic_repayment = await createAtomicRepayment(payee, terms)
    terms.v = 2
    agent = new BorrowerAgent({ party: borrower, assetId: asset, inflows: [], lightning: payer, chain: regtest.chain, mine: (n) => regtest.mine(n), platform: new PlatformClient('http://127.0.0.1:1'), reasoner: new RuleReasoner() })
    const inputs = (await agent.btcUtxos()).map((u) => ({ ...u, internal_pk: borrower.key.pubkey }))
    const lock = buildLock({ inputs, terms, changeScript: borrower.btcScript })
    signKeyPath(lock, borrower.key.secretKey).finalizeAllInputs()
    const lockTxid = await regtest.chain.rpc<string>('sendrawtransaction', [extractHex(lock)])
    await regtest.mine(1)
    const loanId = termsHash(terms)
    mark('v2_collateral_locked')
    const loanInvoice = borrower.rgb.invoice(terms.principal, asset)
    const disbursement = await lender.rgb.send({ invoice: loanInvoice.invoice, assetId: asset, amount: terms.principal })
    await settle({ sender: lender.rgb, receiver: borrower.rgb, assetId: asset, txid: disbursement.txid, mine: () => regtest.mine(1) })
    agent.loans.set(loanId, { terms, lender_pk: lender.key.pubkey, lock: { txid: lockTxid, vout: 0 }, disbursement_txid: disbursement.txid, repayment_invoice: terms.atomic_repayment.invoice })
    mark('loan_disbursement_settled')
    const repayment = await agent.repayAtomic(loanId)
    mark('lightning_paid_and_leaf_e_confirmed')
    const raw = await regtest.chain.rpc<{ confirmations: number; vin: { txinwitness: string[] }[] }>('getrawtransaction', [repayment.release_txid, true])
    const publicPreimage = raw.vin[0].txinwitness[1]
    if (publicPreimage !== repayment.preimage || sha256Hex(hexToBytes(publicPreimage)) !== terms.atomic_repayment.payment_hash || raw.confirmations < 1) throw new Error('confirmed leaf E witness does not prove repayment')
    const inbound = await payee.getPayment(repayment.payment_hash)
    if (!inbound.inbound || inbound.status !== 'Succeeded' || inbound.asset_id !== asset || inbound.asset_amount !== 606_000_000) throw new Error('payee does not report receipt of full RGB debt')
    const payerAfter = (await payer.request<{ channels: Channel[] }>('/listchannels')).channels.find((c) => c.channel_id === channel!.channel_id)
    const payeeAfter = (await payee.request<{ channels: Channel[] }>('/listchannels')).channels.find((c) => c.channel_id === channel!.channel_id)
    if (!payerAfter || !payeeAfter || channel!.asset_local_amount! - payerAfter.asset_local_amount! !== 606_000_000 || payeeAfter.asset_local_amount! - payeeBefore.asset_local_amount! !== 606_000_000) throw new Error('channel RGB balances did not move the full debt from payer to payee')
    const result = { status: 'paid_and_released' as const, source: 'real RLN APIs + real Bitcoin regtest', terms, loan_id: loanId, bootstrap_txid: sent.txid, disbursement_txid: disbursement.txid, bridge_txid: bridge.txid, lock_txid: lockTxid, channel_id: channel!.channel_id, channel_balances: { payer_before: channel, payee_before: payeeBefore, payer_after: payerAfter, payee_after: payeeAfter }, ...repayment, timings_ms: timings, questions: { expiry: `Invoice accepts 30-day expiry, exceeds nominal 30-block term; wall-clock expiry cannot guarantee arbitrary slow block production`, preimage: 'Payer getpayment returns preimage after Succeeded; confirmed E witness independently verified', custom_hash: 'Pinned upstream lninvoice does not expose custom payment hash or hold invoices; read generated H at origination' } }
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    if (process.env.PASSBOOK_ATOMIC_REPORT) writeFileSync(process.env.PASSBOOK_ATOMIC_REPORT, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`Real atomic evidence retained: ${join(dir, 'result.json')}\n`)
    return result
  } finally {
    agent?.close()
    borrower.close()
    lender.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runAtomicSpike().catch((e) => { process.stderr.write(`${e.stack ?? e}\n`); process.exitCode = 1 })
