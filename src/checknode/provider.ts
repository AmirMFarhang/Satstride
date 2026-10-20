import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Relay } from '../agents/relay.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { EsploraChain } from '../chain/esplora.js'
import type { ChainClient } from '../chain/types.js'
import type { NetworkProfile } from '../core/network.js'
import { DEFAULT_CONFIG_PATH, loadConfig } from '../core/config.js'
import { keyPairFromLabel, keyPairFromSecret } from '../core/crypto.js'
import { MICRO_PER_USDT } from '../core/money.js'
import { buildNode, sandboxEngineFromEnv, serveStatus, type NodeSpec } from './market.js'
import { billingFromEnv } from './bill-ledger.js'
import type { CheckBilling } from './node.js'
import { releaseHash } from './offer.js'
import { RAIL_LABEL } from './rail.js'

/** A local scorer's deployment configuration. */
export function providerConfig(x: { approvedBuilds: string; seedState: string }): string {
 return `scorer:\n  provider: in-process\n  fallback: none\n  min_trust_for_lenders: dev-inprocess\n  approved_builds: ${x.approvedBuilds}\nsettlement:\n  default: cosign-rgb\n  enabled: [cosign-rgb]\nnegotiation:\n  enabled: true\n  max_rounds: 3\ncompliance:\n  identity: none\n  sanctions: none\n  consent_receipts: required\n  approvals: { maker_checker_above_usdt: 5000 }\n  data_retention_days: 0\nasset:\n  id_from: ${x.seedState}\n`
}

/** The chain the node's chain checks read: on a public network (Mutinynet, testnet4) the profile's Esplora or bitcoind RPC, never a default; else the local regtest bitcoind from the environment. */
export function chainForProfile(net: NetworkProfile | undefined, env: NodeJS.ProcessEnv = process.env): ChainClient {
  if (!net?.public) return BitcoindChain.fromEnv()
  if (net.endpoints.esplora) return new EsploraChain(net.endpoints.esplora)
  if (net.endpoints.bitcoin_rpc) return new BitcoindChain({ url: net.endpoints.bitcoin_rpc, user: env.BITCOIND_USER ?? 'user', password: env.BITCOIND_PASSWORD ?? 'password' })
  throw new Error(`network ${net.label}: no esplora or bitcoin_rpc endpoint for the chain checks`)
}

export const PROVIDE_USAGE = 'Usage: passbook check-node provide --name <n> --price <USDT> --asset <asset id> --status-port <port> --bill-at-close [--bill-max-per-day <n>] [--operator-secret-file <file>] [--chain-check-secret-file <file>] [--payer-modes lender] [--p50 <s>] [--info-out <file>]'

export async function runProvideCli(args: string[]): Promise<number> {
  const one = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const name = one('--name') ?? 'provider'
  const price = Number(one('--price') ?? '0.5')
  if (args.includes('--ln')) { console.error('check-node provide: --ln is retired; use --bill-at-close (no up-front payment)'); return 2 }
  // bill-at-close: lenders with no Lightning get the check on credit, billed with the platform fee at close (bill.ts).
  const billAtClose = args.includes('--bill-at-close')
  const asset = one('--asset') ?? process.env.PASSBOOK_CHECK_ASSET_ID
  const port = Number(one('--status-port'))
  const payerModes = (one('--payer-modes') ?? 'lender').split(',').map((m) => m.trim())
  if (!billAtClose || !asset || !Number.isFinite(price) || price <= 0 || !Number.isInteger(port) || port <= 0 || !payerModes.length || payerModes.some((m) => m !== 'lender' && m !== 'borrower')) { console.error(PROVIDE_USAGE); return 2 }
  if (payerModes.length !== 1 || payerModes[0] !== 'lender') { console.error('check-node provide: --bill-at-close bills the lender; --payer-modes must be lender only'); return 2 }
  let billing: CheckBilling | undefined
  if (billAtClose) {
    try { billing = billingFromEnv({ ...(one('--bill-max-per-day') ? { maxPerDay: Number(one('--bill-max-per-day')) } : {}) }) } catch (err) { console.error(`check-node provide: ${(err as Error).message}`); return 3 }
  }
  const configPath = process.env.PASSBOOK_CONFIG || (existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : undefined)
  let cfg: ReturnType<typeof loadConfig> | undefined
  try { cfg = configPath ? loadConfig(configPath, { checkFiles: true }) : undefined } catch (err) { console.error(`check-node provide: ${(err as Error).message}`); return 3 }
  const secretFile = one('--operator-secret-file')
  const operator = secretFile ? keyPairFromSecret(readFileSync(secretFile, 'utf8').trim()) : keyPairFromLabel(`check-node-operator-${name}`)
  const engine = sandboxEngineFromEnv({chain:chainForProfile(cfg?.network)})
  const spec: NodeSpec = { name, operator, demoKey: !secretFile, priceMicro: Math.round(price * MICRO_PER_USDT), p50Seconds: Number(one('--p50') ?? 60), lnUrl: '', rails: [], paymentAssetId: asset }
  const relay = new Relay(operator)
  const node = await buildNode(spec, relay, engine, { payerModes: payerModes as ('lender' | 'borrower')[], paymentTimeoutMs: 600_000, approvalTimeoutMs: 300_000, ...(billing ? { billing } : {}) })
  const offer = node.currentOffer()
  const info = {
    v: 1, kind: 'passbook-check-node-provider', name, operator_pk: operator.pubkey, operator_key: spec.demoKey ? 'demo key (publicly derivable, regtest only)' : 'operator key',
    release: offer.release, release_hash: releaseHash(offer.release), payer_modes: offer.payer_modes, scorer_label: engine.label, rail_names: offer.rails, rails: offer.rails.map((r) => RAIL_LABEL[r]),
    price: offer.price, status_url: `http://127.0.0.1:${port}/status`, pid: process.pid,
  }
  const out = one('--info-out')
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`) }
  console.log(`check node ${name} (provider mode): operator ${operator.pubkey}${spec.demoKey ? ' (demo key, publicly derivable: regtest only)' : ''}`)
  console.log(`scorer: ${engine.label}; release ${info.release_hash.slice(0, 12)}…; payer modes ${offer.payer_modes.join(', ')}`)
  console.log(`rails: ${info.rails.join('; ')}. No TEE: software evidence. Bond: designed, not live. Retention: 0.`)
  const status = serveStatus(node, spec, port)
  const stop = () => { node.stop(); status.close(); relay.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await node.serve()
  return 0
}
