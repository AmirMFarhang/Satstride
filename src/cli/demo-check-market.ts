// The loan demo's opt-in check-market path (`npm run demo -- --check-market`,
// docs/CHECK-MARKET.md): the negotiated loan's credit check is bought from a
// check node over RGB Lightning instead of the platform sandbox. This file starts
// the market the demo needs on regtest: two check nodes on the relay (A at 0.80,
// B at 0.50 test USDT) with different operator keys (publicly derivable demo
// keys, labelled), each with its own RGB Lightning node on the HODL build
// (infra/check-market.sh), plus the borrower's own RGB Lightning node. Both nodes
// run IN THIS DEMO PROCESS on this laptop; a standing node is
// `passbook check-node serve`. Their scorer is the container scorer's code in
// process, labelled FALLBACK (no Compex config on the node). Without the flag
// the demo never loads this file.

import type { BorrowerCheckMarket } from '../agents/borrower.js'
import type { LenderCheckMarket } from '../agents/lender.js'
import { Relay } from '../agents/relay.js'
import type { Reasoner } from '../ai/types.js'
import type { Regtest } from '../chain/regtest.js'
import type { ChainClient } from '../chain/types.js'
import { randomKeyPair, type Hex } from '../core/crypto.js'
import { MICRO_PER_USDT } from '../core/money.js'
import type { ForwardedCheckVerification, PaidCheckResult } from '../checknode/client.js'
import { CONTAINER_FALLBACK_LABEL, SandboxCheckEngine } from '../checknode/engine.js'
import { buildNode, marketRecord, nodeView, type CheckMarketRecord, type NodeSpec } from '../checknode/market.js'
import type { CheckNode } from '../checknode/node.js'
import { issueAndSendReceipt } from '../checknode/receipt.js'
import { unlockAndFund } from '../checknode/regtest-ln.js'
import type { CheckNodePick, CheckNodeRules } from '../checknode/select.js'
import { noTeeVerifier } from '../checknode/tee.js'
import { RgbLightningNode } from '../rgb/lightning.js'
import { contractHash, loadScoringContract } from '../scorer/contract.js'
import { SandboxScorerEngine } from '../scorer/providers.js'
import { devReleaseSigner, measureSource, signReleaseManifest } from '../scorer/releases.js'
import type { TrustPolicy } from '../scorer/verify.js'
import { demoOperator } from './check-node.js'

export interface DemoCheckMarket {
  borrower: BorrowerCheckMarket
  lender: LenderCheckMarket
  /** The lender's check_nodes rules for its signed policy. */
  rules: CheckNodeRules
  /** The borrower policy's max_check_price. */
  maxCheckPrice: { asset_id: string; amount: number }
  views(): ReturnType<typeof nodeView>[]
  /** What the dashboard's Check nodes panel shows about this loan's check: hashes, no outputs, no personal data. */
  record(pick: CheckNodePick, paid: PaidCheckResult, lender: ForwardedCheckVerification | null, receipt: CheckMarketRecord['receipt']): CheckMarketRecord
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function startDemoCheckMarket(o: { assetId: string; chain: ChainClient; regtest: Regtest; oraclePk: Hex; reasoner: Reasoner; blocksPerMonth: number; log: (line: string) => void }): Promise<DemoCheckMarket> {
  const url = (name: string, port: number) => process.env[`PASSBOOK_CHECK_LN_${name}`] ?? `http://127.0.0.1:${port}`
  const lnBorrower = new RgbLightningNode(url('BORROWER', 3181))
  await unlockAndFund(lnBorrower, o.regtest)
  // The release both agents pin: the container scorer's code in process, this checkout measured, signed by the DEV release signer.
  const measurement = measureSource()
  const contract = loadScoringContract()
  const releases = signReleaseManifest(devReleaseSigner(), { builds: [{ label: 'container scorer on a check node (in process, this checkout measured)', provider: 'container', code_measurement: measurement, contract_hash: contractHash(contract), max_trust: 'dev-inprocess' }] })
  const trust: TrustPolicy = { minTrust: 'dev-inprocess', releases, releaseSignerPk: devReleaseSigner().pubkey, contract }
  const specs: (NodeSpec & { host: string })[] = [
    { name: 'A', operator: demoOperator('A'), demoKey: true, priceMicro: 800_000, p50Seconds: 20, lnUrl: url('A', 3182), rails: ['rgb-ln-hodl'], paymentAssetId: o.assetId, host: process.env.PASSBOOK_CHECK_HOST_A ?? 'check-rln-a' },
    { name: 'B', operator: demoOperator('B'), demoKey: true, priceMicro: 500_000, p50Seconds: 40, lnUrl: url('B', 3183), rails: ['rgb-ln-hodl'], paymentAssetId: o.assetId, host: process.env.PASSBOOK_CHECK_HOST_B ?? 'check-rln-b' },
  ]
  const relays: Relay[] = []
  const peers: Record<string, string> = {}
  let stopped = false
  const nodes: CheckNode[] = []
  for (const spec of specs) {
    const ln = new RgbLightningNode(spec.lnUrl)
    peers[await unlockAndFund(ln, o.regtest)] = spec.host
    const relay = new Relay(spec.operator)
    relays.push(relay)
    const engine = new SandboxCheckEngine(new SandboxScorerEngine({ provider: 'container', key: randomKeyPair(), chain: o.chain, reasoner: o.reasoner, blocksPerMonth: o.blocksPerMonth, oraclePk: o.oraclePk, measurement, runEnvironment: { image_digest: 'in-process', network_mode: 'in-process-host' } }), { label: CONTAINER_FALLBACK_LABEL, fallback: true, modelHash: null })
    nodes.push(await buildNode(spec, relay, engine, {
      paymentTimeoutMs: 300_000,
      log: (l) => o.log(`[check-node ${spec.name}] ${l}`),
      // The receipt: a UDA with hashes only, sent on chain to the borrower's invoice; this operator's node refreshes until it settles.
      onPaid: async (paid) => {
        if (!paid.receipt_invoice) return
        const sent = await issueAndSendReceipt(ln, paid.receipt_invoice, { v: 1, kind: 'passbook-check-receipt', commitment: paid.commitment.commitment, evidence_digest: paid.envelope_digest, release_hash: paid.commitment.release_hash, operator_pk: spec.operator.pubkey, tier: 'software-evidence', date: new Date().toISOString().slice(0, 10) })
        o.log(`[check-node ${spec.name}] receipt ${sent.contract_id} sent on chain in ${sent.txid.slice(0, 12)}…`)
        void (async () => {
          for (let i = 0; i < 150 && !stopped; i++) {
            await ln.request('/refreshtransfers', { skip_sync: false }).catch(() => undefined)
            const { transfers } = await ln.request<{ transfers: { kind: string; status: string }[] }>('/listtransfers', { asset_id: sent.contract_id }).catch(() => ({ transfers: [] }))
            // The token's own Issuance is Settled from the start: wait for the Send.
            if (transfers.some((t) => t.kind === 'Send' && t.status === 'Settled')) return
            await sleep(2000)
          }
        })()
      },
    }))
  }
  for (const n of nodes) await n.publishOffer()
  const serving = nodes.map((n) => n.serve({ republishMs: 600_000 }))
  return {
    borrower: { ln: lnBorrower, peers, trust, tee: noTeeVerifier, channelAmount: 2 * MICRO_PER_USDT, rails: ['rgb-ln-hodl', 'rgb-ln-pay-then-deliver'], timeoutMs: 300_000 },
    lender: { trust, tee: noTeeVerifier },
    rules: { accepted_check_operators: specs.map((s) => s.operator.pubkey), min_execution: 'software', max_price: { asset_id: o.assetId, amount: MICRO_PER_USDT } },
    maxCheckPrice: { asset_id: o.assetId, amount: 600_000 },
    views: () => nodes.map((n, i) => nodeView(n, specs[i])),
    record: (pick, paid, lender, receipt) => marketRecord(nodes.map((n, i) => nodeView(n, specs[i])), pick, paid, lender, receipt),
    stop: async () => {
      stopped = true
      for (const n of nodes) n.stop()
      await Promise.race([Promise.allSettled(serving), sleep(6000)])
      for (const r of relays) r.close()
    },
  }
}
