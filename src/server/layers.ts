// Dashboard panel for the multi-layer credit agent: "RGB + Bitcoin mainnet +
// Lightning: on-chain recomputed by the lender". Self-contained: mounted by the
// demo next to its other /demo routes (operator-only writes, served with the
// platform API off too). The person pastes an address and, later, the BIP-322
// signature their own wallet made; nothing here takes a key or a seed.

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChainClient } from '../chain/types.js'
import { deploymentConfigFromEnv, DEFAULT_CREDIT, type CreditConfig } from '../core/config.js'
import { DEFAULT_ECONOMICS } from '../core/economics.js'
import type { Hex, KeyPair } from '../core/crypto.js'
import type { LoanTerms } from '../core/terms.js'
import { ChallengeBook, describeOutcome, runAgentCheck, standaloneNegotiationId, type AgentCheckResult } from '../networks/agent-check.js'
import { loanChainFromEnv, refuseSecret } from '../networks/guard.js'
import { LightningAdapter, MempoolLightningFacts, RlnNodeApi } from '../networks/lightning.js'
import { DEFAULT_LENDER_LAYER_POLICY } from '../networks/policy.js'
import { RgbAdapter, rgbHistoryRows, type RgbRowLabel } from '../networks/rgb.js'
import { availableSanctionsScreen } from '../compliance/sanctions.js'
import { creditSources, knownEscrows, registryLiabilities } from '../networks/setup.js'
import type { LayerId } from '../networks/types.js'
import type { CandidateInflow } from '../sandbox/types.js'
import { HttpError, type Api } from './api.js'

export interface LayersPanelDeps {
  /** The borrower's party and RGB wallet in this demo process. */
  party: { key: KeyPair; rgb: { dataDir: string; transfers(assetId?: string): { kind: string; status: string; txid: string | null; amount: number }[] } }
  assetId: string
  chain: Pick<ChainClient, 'getTx' | 'getHeight'>
  inflows: readonly (CandidateInflow & { memo: string })[]
  lenderPk: Hex
  store: { allLoans(): { id: string; status: string; terms: LoanTerms }[] }
  priceCents: () => number
  credit?: CreditConfig
}

export function mountLayersPanel(api: Api, deps: LayersPanelDeps): void {
  // An invalid config throws here, as it already does in createApp: never a silent switch to the public default sources.
  const deployment = deps.credit ? null : deploymentConfigFromEnv()
  const credit = deps.credit ?? deployment?.credit ?? DEFAULT_CREDIT
  const blocksPerDay = deployment?.economics.blocks_per_day ?? DEFAULT_ECONOMICS.blocks_per_day
  const chain = credit.history_chains[0] ?? 'bitcoin'
  const negotiation_id = standaloneNegotiationId(deps.party.key.pubkey)
  const book = new ChallengeBook(deps.lenderPk, negotiation_id)
  let last: AgentCheckResult | null = null
  let address: string | null = null
  const labelsFile = join(dirname(deps.party.rgb.dataDir), 'labels.json')
  const rgb = new RgbAdapter(loanChainFromEnv(), {
    party: deps.party.key, borrowerPk: deps.party.key.pubkey, assetId: deps.assetId,
    rows: () => rgbHistoryRows({ wallet: deps.party.rgb, assetId: deps.assetId, chain: deps.chain, inflows: deps.inflows, labels: existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, 'utf8')) as Record<Hex, RgbRowLabel> : {} }),
    signed: deps.inflows.map(({ memo: _m, ...c }) => c), height: () => deps.chain.getHeight(), blocksPerDay,
  })
  const lnUrl = process.env.PASSBOOK_BORROWER_LIGHTNING_URL
  const lnChain = loanChainFromEnv()

  api.on('GET', '/demo/layers.js', async ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(await readFile(new URL('../../web/layers.js', import.meta.url)))
  })

  api.on('GET', '/demo/layers', () => ({
    title: 'RGB + Bitcoin mainnet + Lightning: on-chain recomputed by the lender',
    borrower_pk: deps.party.key.pubkey, lender_pk: deps.lenderPk, negotiation_id,
    history_chain: chain, loan_chain: lnChain, window_days: credit.window_days,
    sources: { device: credit.sources[chain] ?? null, lender: credit.lender_sources[chain] ?? null, recorded: credit.snapshot ? 'recorded mainnet data (offline fallback)' : null },
    lightning: lnUrl ? 'RGB Lightning Node (challenge invoice)' : null,
    address, challenge: address ? book.current('btc-onchain', address) : null,
    last: last ? { ...last, summary: describeOutcome(last) } : null,
  }))

  api.on('POST', '/demo/layers/challenge', async ({ body }) => {
    const b = await body()
    const a = typeof b.address === 'string' ? b.address.trim() : ''
    try { refuseSecret(a, 'address') } catch (e) { throw new HttpError(400, (e as Error).message) }
    try {
      const c = book.current('btc-onchain', a) ?? book.issue('btc-onchain', chain, a)
      address = a
      return { challenge: c }
    } catch (e) { throw new HttpError(400, (e as Error).message) }
  })

  api.on('POST', '/demo/layers/check', async ({ body }) => {
    const b = await body()
    const signature = typeof b.signature === 'string' ? b.signature.trim() : ''
    if (signature) { try { refuseSecret(signature, 'signature') } catch (e) { throw new HttpError(400, (e as Error).message) } }
    const layers: LayerId[] = ['rgb', ...(address ? ['btc-onchain' as const] : []), ...(lnUrl ? ['lightning' as const] : [])]
    let lightning: LightningAdapter | null = null, nodePk: Hex | null = null
    if (lnUrl) {
      const node = new RlnNodeApi(lnUrl, process.env.PASSBOOK_BORROWER_LIGHTNING_TOKEN)
      try { nodePk = (await node.nodeInfo()).pubkey; lightning = new LightningAdapter(lnChain, node, lnChain === 'bitcoin' ? new MempoolLightningFacts() : null) } catch { /* the layer reports NO_LIGHTNING_NODE_ON_DEVICE */ }
    }
    const { device, lender } = creditSources(credit, chain, { offline: b.offline === true })
    const loans = deps.store.allLoans()
    last = await runAgentCheck({
      history_chain: chain, window_days: credit.window_days, borrower_source: device, lender_source: lender, policy: { ...DEFAULT_LENDER_LAYER_POLICY },
      price_cents: deps.priceCents(), sanctions: availableSanctionsScreen(), known_escrows: knownEscrows(loans), liabilities: registryLiabilities(loans, deps.party.key.pubkey),
    }, { borrower: deps.party.key, shareable: { shareable_layers: layers, subjects: { ...(address ? { 'btc-onchain': [address] } : {}), ...(nodePk ? { lightning: [nodePk] } : {}) } }, rgb, lightning, btc_signatures: address && signature ? { [address]: signature } : {} }, book)
    api.emit({ type: 'layers', outcome: last.negotiation.outcome, result_hash: last.result_hash })
    return { ...last, summary: describeOutcome(last) }
  })
}
