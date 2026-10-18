// Regtest-only channel preparation. Every bridge/channel is real; failure
// stops the opt-in atomic demo before any loan terms are accepted.
import { Regtest } from '../chain/regtest.js'
import type { Party } from '../wallet/party.js'
import { RgbLightningNode } from './lightning.js'

interface RgbChannel { channel_id: string; asset_id: string | null; is_usable: boolean; asset_local_amount: number | null; funding_txid: string | null }

export async function prepareAtomicLiquidity(opts: {
  borrower: Party
  assetId: string
  amount: number
  payer: RgbLightningNode
  payee: RgbLightningNode
  regtest: Regtest
  progress?: (title: string, detail?: unknown) => void
  /** The borrower agent's governed send (its policy gate); required once the borrower's wallet is under a gate. */
  send?: (o: { invoice: string; assetId: string; amount: number }) => Promise<{ txid: string }>
}): Promise<{ channel_id: string; bridge_txid?: string }> {
  const { borrower, assetId, amount, payer, payee, regtest, progress } = opts
  const network = await regtest.chain.rpc<{ chain: string }>('getblockchaininfo')
  if (network.chain !== 'regtest') throw new Error('automatic Lightning channel preparation is regtest-only')
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('invalid atomic liquidity amount')
  for (const node of [payer, payee]) {
    try { await node.request('/nodeinfo') } catch (e) {
      if (!/LockedNode/.test(String(e))) throw e
      try { await node.request('/init', { password: process.env.PASSBOOK_LIGHTNING_PASSWORD ?? 'passbook-regtest-only' }) } catch (init) { if (!/AlreadyInitialized|already initialized/i.test(String(init))) throw init }
      await node.request('/unlock', { password: process.env.PASSBOOK_LIGHTNING_PASSWORD ?? 'passbook-regtest-only', ldk_chain_sync: { mode: 'BlockSync', config: { bitcoind_rpc_username: process.env.BITCOIND_USER ?? 'user', bitcoind_rpc_password: process.env.BITCOIND_PASSWORD ?? 'password', bitcoind_rpc_host: process.env.PASSBOOK_LIGHTNING_BITCOIND_HOST ?? 'bitcoind', bitcoind_rpc_port: Number(process.env.PASSBOOK_LIGHTNING_BITCOIND_PORT ?? 18443) } }, indexer_url: process.env.PASSBOOK_LIGHTNING_INDEXER_URL ?? 'electrs:50001', announce_addresses: [] })
    }
  }
  const channels = (await payer.request<{ channels: RgbChannel[] }>('/listchannels')).channels
  const existing = channels.find((c) => c.asset_id === assetId && c.is_usable && (c.asset_local_amount ?? 0) >= amount)
  if (existing) {
    progress?.('RGB Lightning channel has sufficient outbound asset liquidity', { channel_id: existing.channel_id, amount })
    return { channel_id: existing.channel_id }
  }
  const proxy = process.env.PASSBOOK_LIGHTNING_PROXY
  if (!proxy) throw new Error('PASSBOOK_LIGHTNING_PROXY must be reachable by the host WDK wallet and both Lightning nodes; see docs/ATOMIC.md')
  borrower.rgb.refresh()
  if (borrower.rgb.balance(assetId).spendable < amount) throw new Error('borrower has insufficient RGB balance to provision the repayment channel')
  progress?.('Preparing real RGB Lightning wallets and channel', { amount })
  for (const node of [payer, payee]) {
    const { address } = await node.request<{ address: string }>('/address', {})
    await regtest.fund(address, 0.05)
    await node.request('/createutxos', { up_to: true, num: 5, size: 50_000, fee_rate: 1, skip_sync: false }).catch((e) => { if (!/AllocationsAlreadyAvailable/.test(String(e))) throw e })
    await regtest.mine(1)
  }
  const inv = await payer.request<{ invoice: string }>('/rgbinvoice', { min_confirmations: 1, witness: true, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600, transport_endpoints: [proxy] })
  const { txid } = await (opts.send ?? ((o) => borrower.rgb.send(o)))({ invoice: inv.invoice, assetId, amount })
  for (let n = 0; n < 15; n++) {
    await payer.request('/refreshtransfers', { skip_sync: false, filter: [] })
    borrower.rgb.refresh()
    const balance = await payer.request<{ spendable: number }>('/assetbalance', { asset_id: assetId }).catch(() => undefined)
    const transfer = borrower.rgb.transferByTxid(assetId, txid, 'Send')
    if (transfer?.status === 'Failed') throw new Error('RGB bridge to Lightning failed')
    if ((balance?.spendable ?? 0) >= amount && transfer?.status === 'Settled') break
    if (n === 14) throw new Error('RGB bridge to Lightning did not settle')
    await regtest.mine(1)
  }
  progress?.('Same WDK asset settled in the borrower Lightning node', { bridge_txid: txid, asset_id: assetId })
  const { pubkey } = await payee.request<{ pubkey: string }>('/nodeinfo')
  await payer.request('/openchannel', { peer_pubkey_and_opt_addr: `${pubkey}@${process.env.PASSBOOK_LIGHTNING_PAYEE_PEER_ADDR ?? 'passbook-rln-payee:9735'}`, capacity_sat: 100_000, push_msat: 3_500_000, public: false, with_anchors: true, asset_id: assetId, asset_amount: amount, push_asset_amount: 0 })
  for (let n = 0; n < 40; n++) {
    const current = (await payer.request<{ channels: RgbChannel[] }>('/listchannels')).channels
    const ready = current.find((c) => c.asset_id === assetId && c.is_usable && (c.asset_local_amount ?? 0) >= amount)
    if (ready) {
      progress?.('Real RGB Lightning channel ready', { channel_id: ready.channel_id, funding_txid: ready.funding_txid })
      return { channel_id: ready.channel_id, bridge_txid: txid }
    }
    if (n === 39) throw new Error('RGB Lightning channel did not become usable')
    await regtest.mine(1)
  }
  throw new Error('RGB Lightning channel unavailable')
}
