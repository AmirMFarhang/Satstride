// Regtest-only RGB Lightning setup for the check market (docs/CHECK-MARKET.md):
// unlock and fund a node on the HODL build (infra/check-market.sh), and keep
// ONE RGB channel per check node. Every node and channel is real; this file
// only wires them. Shared by the regtest driver (infra/check-market-run.ts)
// and the loan demo's --check-market path.

import type { Regtest } from '../chain/regtest.js'
import type { RgbLightningNode } from '../rgb/lightning.js'

/** What mines a block here: the regtest helper, or an agent's own `mine` in the demo. */
export interface Miner { mine(blocks?: number): Promise<unknown> }

export interface RlnChannel { asset_id: string | null; is_usable: boolean; channel_id: string; peer_pubkey: string; asset_local_amount: number | null }

const PASSWORD = 'passbook-check-market-regtest-only'

/** Initialises and unlocks a HODL-build node if needed, funds its BTC wallet and creates UTXOs; returns its node key. */
export async function unlockAndFund(node: RgbLightningNode, regtest: Regtest): Promise<string> {
  try { await node.request('/nodeinfo') } catch {
    try { await node.request('/init', { password: PASSWORD }) } catch (e) { if (!/AlreadyInitialized|already initialized/i.test(String(e))) throw e }
    await node.request('/unlock', { password: PASSWORD, bitcoind_rpc_username: 'user', bitcoind_rpc_password: 'password', bitcoind_rpc_host: 'bitcoind', bitcoind_rpc_port: 18443, indexer_url: 'electrs:50001', proxy_endpoint: process.env.PASSBOOK_CHECK_PROXY ?? 'rpc://rgb-proxy:3000/json-rpc', announce_addresses: [] })
  }
  const { btc_balance } = { btc_balance: await node.request<{ vanilla: { spendable: number } }>('/btcbalance', { skip_sync: false }).catch(() => null) }
  if (!btc_balance || btc_balance.vanilla.spendable < 5_000_000) {
    const { address } = await node.request<{ address: string }>('/address', {})
    await regtest.fund(address, 0.2)
  }
  await node.request('/createutxos', { up_to: true, num: 6, size: 50_000, fee_rate: 1, skip_sync: false }).catch((e) => { if (!/AllocationsAlreadyAvailable/.test(String(e))) throw e })
  await regtest.mine(1)
  return (await node.request<{ pubkey: string }>('/nodeinfo')).pubkey
}

/**
 * The channels to a check node a payer closes before paying it (one RGB channel per node, the routing
 * finding): any of another asset, any that is still unusable after reconnecting, and any with less of
 * the payment asset than the price. A usable channel of the asset with enough left is kept.
 */
export function channelsToClose(channels: RlnChannel[], payeePubkey: string, assetId: string, price: number): RlnChannel[] {
  return channels.filter((c) => c.peer_pubkey === payeePubkey && (c.asset_id !== assetId || !c.is_usable || (c.asset_local_amount ?? 0) < price))
}

/** A usable channel of this asset to the payee, opened (and confirmed by mining) if there is none. */
export async function openAssetChannel(payer: RgbLightningNode, payeePubkey: string, payeeHost: string, assetId: string, amount: number, regtest: Miner): Promise<RlnChannel> {
  const existing = (await payer.request<{ channels: RlnChannel[] }>('/listchannels')).channels.find((c) => c.asset_id === assetId && c.peer_pubkey === payeePubkey && c.is_usable)
  if (existing) return existing
  await payer.request('/connectpeer', { peer_pubkey_and_addr: `${payeePubkey}@${payeeHost}:9735` }).catch(() => undefined)
  await payer.request('/openchannel', { peer_pubkey_and_opt_addr: `${payeePubkey}@${payeeHost}:9735`, capacity_sat: 100_000, push_msat: 3_500_000, public: false, with_anchors: true, asset_id: assetId, asset_amount: amount, push_asset_amount: 0 })
  for (let i = 0; i < 40; i++) {
    const c = (await payer.request<{ channels: RlnChannel[] }>('/listchannels')).channels.find((x) => x.asset_id === assetId && x.peer_pubkey === payeePubkey && x.is_usable)
    if (c) return c
    await regtest.mine(1)
  }
  throw new Error('RGB channel did not become usable')
}

/**
 * Routing finding (docs/CHECK-MARKET.md): with two RGB channels to one node, this
 * RGB Lightning build may send a payment over the channel of the other asset. So a
 * payer keeps one channel per check node and closes the others first. The peer is
 * reconnected first (after a restart a channel waits for it); a channel whose
 * cooperative close is refused is force-closed, and the result says which.
 */
export async function closeChannels(payer: RgbLightningNode, channels: Pick<RlnChannel, 'channel_id' | 'peer_pubkey'>[], regtest: Miner, peerHost?: string): Promise<{ channel_id: string; mode: 'cooperative' | 'forced' }[]> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const closed: { channel_id: string; mode: 'cooperative' | 'forced' }[] = []
  for (const peer of new Set(channels.map((c) => c.peer_pubkey))) {
    if (peerHost) await payer.request('/connectpeer', { peer_pubkey_and_addr: `${peer}@${peerHost}:9735` }).catch(() => undefined)
  }
  for (const c of channels) {
    let mode: 'cooperative' | 'forced' = 'cooperative'
    for (let attempt = 0; ; attempt++) {
      try { await payer.request('/closechannel', { channel_id: c.channel_id, peer_pubkey: c.peer_pubkey, force: false }); break } catch (err) {
        if (attempt < 5) { await sleep(2000); continue }
        // The peer did not take a cooperative close: force it; the funds come back after the delay, the channel is gone now.
        await payer.request('/closechannel', { channel_id: c.channel_id, peer_pubkey: c.peer_pubkey, force: true }).catch(() => { throw err })
        mode = 'forced'
        break
      }
    }
    closed.push({ channel_id: c.channel_id, mode })
  }
  for (let i = 0; i < 12 && channels.length; i++) {
    const open = new Set((await payer.request<{ channels: RlnChannel[] }>('/listchannels')).channels.map((c) => c.channel_id))
    if (channels.every((c) => !open.has(c.channel_id))) return closed
    if (i === 11) throw new Error('RGB channels to the check node did not close')
    await regtest.mine(1)
  }
  return closed
}
