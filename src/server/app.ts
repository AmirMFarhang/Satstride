// Wires the platform together and exposes it over HTTP. Importable so tests can
// start it on a random port with a fake chain and an in-process sandbox.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuleReasoner } from '../ai/rule-reasoner.js'
import { primaryReasonerFromEnv } from '../ai/engine.js'
import type { Reasoner } from '../ai/types.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { FakeChain } from '../chain/fake.js'
import type { ChainClient } from '../chain/types.js'
import { hashObject, keyPairFromLabel, randomKeyPair, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, publishedEconomics, type Economics } from '../core/economics.js'
import { OrderBook } from '../market/orderbook.js'
import { Oracle } from '../oracle/oracle.js'
import { Store } from '../registry/store.js'
import type { RepaymentWatcher, WatchKeys } from '../rgb/watch.js'
import { InProcessSandbox, RemoteSandbox, type Sandbox } from '../sandbox/broker.js'
import { loadPlatformKey, walletsDir } from '../wallet/platform-key.js'
import { Api, HttpError, str } from './api.js'
import { ApiAuth, authFromEnv, type ApiAuthConfig, type PartyBinding } from './auth.js'
import { rgbFeeWallet, type FeeWallet } from './fees.js'
import { mountDeviceRoutes } from './devices.js'
import { deploymentConfigFromEnv, describeConfig, type PassbookConfig } from '../core/config.js'
import { complianceFromConfig, type ComplianceHooks } from '../compliance/hooks.js'
import { Platform, type CosignPurpose } from './platform.js'
import { NodeGovernance } from '../governance/node.js'
import { availableSanctionsScreen } from '../compliance/sanctions.js'
import { EsploraChain } from '../chain/esplora.js'
import { networkProfile } from '../core/network.js'
import { walletPanelFromEnv, type WalletPanel } from '../wallet/panel.js'
import { sendGateFromEnv } from '../wallet/send-gate.js'
import { mountWalletRoutes } from './wallet-routes.js'
import { mountConsoleRoutes } from './console.js'

export interface AppConfig {
  platformKey: KeyPair
  /** Stable local-demo key for restarting a saved signed investigation. */
  sandboxKey?: KeyPair
  oracleKey?: KeyPair
  /** Fetch the public three-source median every 30 s. Tests default to configured prices. */
  liveOracle?: boolean
  /** Recovered dashboards observe prices without advancing loan monitoring. */
  monitorLivePrices?: boolean
  store: Store
  chain: ChainClient
  sandbox?: Sandbox
  reasoner?: Reasoner
  initialPriceCents: number
  blocksPerMonth: number
  relays: string[]
  /** watch-only rgb-lib wallets for repayment invoices; see repaymentWatchFromEnv */
  repayments?: RepaymentWatcher
  /** Request signing, authentication and rate limits; absent means off. */
  auth?: ApiAuthConfig
  /** The platform's own RGB wallet that receives lenders' fees; see feeWalletFromEnv. Without it fees are recorded but not invoiced or enforced. */
  feeWallet?: FeeWallet
  /** Where the platform's policy gate keeps its store and decision log; null keeps them in memory. Default: <wallets>/platform/governance for the seeded platform key. */
  governanceDir?: string | null
  /** Published pricing bounds and platform share; DEFAULT_ECONOMICS (= passbook.config.yaml) when absent. */
  economics?: Economics
  /** The validated passbook.config.yaml, or null for built-in demo defaults. */
  deployment?: PassbookConfig | null
  /** The user's own wallet panel (/wallet); undefined builds one from the environment, null runs none (PASSBOOK_WALLET=off). */
  wallet?: WalletPanel | null
}

export interface App {
  api: Api
  /** Built from the deployment config; `none` hooks when there is none. */
  compliance: ComplianceHooks
  platform: Platform
  orderbook: OrderBook
  oracle: Oracle
  chain: ChainClient
  store: Store
  close(): Promise<void>
}

export function configFromEnv(): AppConfig {
  // PLATFORM_SECRET, else the key `npm run seed` wrote, else a fixed demo key
  const platformKey = loadPlatformKey() ?? keyPairFromLabel('platform')
  const chain: ChainClient = process.env.PASSBOOK_CHAIN === 'fake' || (!process.env.BITCOIND_URL && process.env.PASSBOOK_CHAIN !== 'bitcoind') ? new FakeChain(100) : BitcoindChain.fromEnv()
  const reasoner = primaryReasonerFromEnv()
  // Refuses to start on an invalid deployment config.
  const deployment = deploymentConfigFromEnv()
  // a public test network has no bitcoind of ours: the platform reads Bitcoin through the profile's Esplora
  const net = deployment?.network
  const publicChain = net?.public ? (net.endpoints.esplora ? new EsploraChain(net.endpoints.esplora) : new BitcoindChain({ url: net.endpoints.bitcoin_rpc!, user: process.env.BITCOIND_USER ?? 'user', password: process.env.BITCOIND_PASSWORD ?? 'password' })) : undefined
  return {
    platformKey,
    store: new Store(process.env.PASSBOOK_DB ?? ':memory:'),
    chain: publicChain ?? chain,
    sandbox: process.env.SANDBOX_URL ? new RemoteSandbox(process.env.SANDBOX_URL) : undefined,
    reasoner,
    liveOracle: process.env.PASSBOOK_ORACLE === 'live',
    initialPriceCents: Number(process.env.BTC_PRICE_CENTS ?? 10_000_000),
    blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30),
    relays: (process.env.PASSBOOK_RELAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    auth: authFromEnv(platformKey.pubkey),
    deployment,
  }
}

/**
 * The platform's watch-only RGB wallets, under PASSBOOK_WATCH_DIR or <wallets>/platform/watch.
 * Imported on demand so a platform on the fake chain never loads the rgb-lib native binding.
 */
export async function repaymentWatchFromEnv(): Promise<RepaymentWatcher> {
  const { RgbRepaymentWatch } = await import('../rgb/watch.js')
  return new RgbRepaymentWatch(process.env.PASSBOOK_WATCH_DIR ?? join(walletsDir(), 'platform', 'watch'))
}

/** The platform's fee wallet under PASSBOOK_FEE_WALLET_DIR or <wallets>/platform/fees, from a key derived from the platform key. */
export async function feeWalletFromEnv(platformKey: KeyPair): Promise<FeeWallet> {
  return rgbFeeWallet(platformKey, process.env.PASSBOOK_FEE_WALLET_DIR ?? join(walletsDir(), 'platform', 'fees'))
}

/** <wallets>/platform/governance when this is the seeded platform key; otherwise (tests, a fixed demo key) in memory. */
export function platformGovernanceDir(platformKey: KeyPair): string | null {
  const dir = join(walletsDir(), 'platform')
  return existsSync(dir) && loadPlatformKey()?.pubkey === platformKey.pubkey ? join(dir, 'governance') : null
}

export function createApp(cfg: AppConfig): App {
  if (cfg.economics && cfg.deployment && hashObject(cfg.economics) !== hashObject(cfg.deployment.economics)) throw new Error('economics: the app config and the deployment config disagree; set them in one place')
  const auth = cfg.auth ? new ApiAuth(cfg.auth) : undefined
  const api = new Api(cfg.store, auth)
  // a paired phone (apps/android): one-time pairing codes and scoped, expiring device keys,
  // bound to the borrower the running demo announced (src/cli/demo.ts emits { type: 'demo', borrower_pk })
  if (auth) {
    let seen = 0
    let borrower: Hex | undefined
    auth.devices.currentBorrower = () => {
      for (let batch = cfg.store.listEvents(seen); batch.length; batch = cfg.store.listEvents(seen)) {
        for (const e of batch) {
          seen = e.seq ?? seen
          if (e.type === 'demo' && typeof e.borrower_pk === 'string') borrower = e.borrower_pk
        }
      }
      return borrower
    }
    mountDeviceRoutes(api, auth.devices, () => auth.cfg.now?.() ?? Date.now())
  }
  const compliance = complianceFromConfig(cfg.deployment ?? { compliance: { identity: 'none', sanctions: 'none', consent_receipts: 'required', approvals: { maker_checker_above_micro: 0 }, data_retention_days: 0 } })
  const oracle = new Oracle(cfg.oracleKey ?? cfg.platformKey, cfg.initialPriceCents, { live: cfg.liveOracle })
  const reasoner = cfg.reasoner ?? new RuleReasoner()
  const sandbox = cfg.sandbox ?? new InProcessSandbox(cfg.sandboxKey ?? randomKeyPair(), cfg.chain, reasoner, cfg.blocksPerMonth, oracle.pubkey, {
    onInvestigationStep: (step) => api.emit({ type: 'ai_step', ...step }),
    investigationContext: { payerProfile: async (pk) => ({
      known_lender: cfg.store.listOffers().some((offer) => offer.lender_pk === pk),
      known_borrower: cfg.store.loansByBorrower(pk).length > 0,
      passbook_pages: cfg.store.loansByBorrower(pk).length,
      // No source establishes global first-seen height: leave it unknown.
      disbursement_txids: cfg.store.allLoans().filter((loan) => loan.terms.lender_pk === pk && loan.disbursement_txid).map((loan) => loan.disbursement_txid!),
    }) },
  })
  // The deployment's economics are what the platform enforces and what /state publishes.
  const economics = cfg.economics ?? cfg.deployment?.economics ?? DEFAULT_ECONOMICS
  const governance = new NodeGovernance({ ownerKey: cfg.platformKey, dir: cfg.governanceDir !== undefined ? cfg.governanceDir : platformGovernanceDir(cfg.platformKey), sanctions: availableSanctionsScreen() })
  const platform = new Platform(cfg.platformKey, cfg.store, cfg.chain, oracle, sandbox, (e) => api.emit(e), cfg.repayments, undefined, { feeWallet: cfg.feeWallet, economics, governance })
  // the order book refuses and hides offers from lenders with an overdue platform fee
  const orderbook = new OrderBook(cfg.store, { economics, gate: (lenderPk, height) => platform.fees.blockedAt(lenderPk, height) })
  orderbook.onChange((offer, action) => api.emit({ type: 'offer', action, id: offer.id, lender_pk: offer.lender_pk, payload: offer.payload }))
  if (cfg.relays.length) orderbook.subscribe(cfg.relays)

  // Party binding (src/server/auth.ts): who must have signed each party write. A loan's
  // parties are the borrower and lender keys in its registered terms; an unknown loan has none.
  const loanParties = (id: unknown): Hex[] => {
    const loan = typeof id === 'string' ? cfg.store.getLoan(id) : undefined
    return loan ? [loan.terms.borrower_pk, loan.terms.lender_pk] : []
  }
  const field = (v: unknown, name: string): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>)[name] : undefined)
  const loanParty: PartyBinding = { who: "the loan's borrower or lender", keys: ({ params }) => loanParties(params.id) }

  // the dashboard: four fixed files, nothing else from disk
  const WEB: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/session-auth.js': ['session-auth.js', 'text/javascript; charset=utf-8'] }
  for (const [route, [file, type]] of Object.entries(WEB)) {
    api.on('GET', route, async ({ res }) => {
      const body = await readFile(new URL(`../../web/${file}`, import.meta.url))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    })
  }

  // The user's own wallet panel and the network badge every screen shows (src/server/wallet-routes.ts).
  const network = cfg.deployment?.network ?? networkProfile('regtest')
  const wallet = cfg.wallet !== undefined ? cfg.wallet : process.env.PASSBOOK_WALLET === 'off' ? null : walletPanelFromEnv(network, sendGateFromEnv(process.env, network), cfg.deployment?.asset.id_from)
  mountWalletRoutes(api, network, wallet)
  mountConsoleRoutes(api, { store: cfg.store, chain: cfg.chain, relays: cfg.relays, auth, platform, orderbook, oracle, governance, network, economics })

  api.on('GET', '/state', async () => ({
    platform_pk: platform.pubkey,
    oracle_pk: oracle.pubkey,
    chain: cfg.chain.kind,
    height: await cfg.chain.getHeight(),
    price_cents: oracle.currentPrice(),
    oracle: oracle.status(),
    engine: reasoner.engine,
    relays: cfg.relays,
    economics: publishedEconomics(economics),
    deployment: cfg.deployment ? { summary: describeConfig(cfg.deployment), scorer: { provider: cfg.deployment.scorer.provider, fallback: cfg.deployment.scorer.fallback, min_trust_for_lenders: cfg.deployment.scorer.min_trust_for_lenders }, settlement: cfg.deployment.settlement, negotiation: cfg.deployment.negotiation, compliance: { identity: compliance.identity.name, sanctions: compliance.sanctions.name } } : null,
    api_auth: cfg.auth?.mode ?? 'off',
    loans: cfg.store.allLoans().map((l) => ({ id: l.id, status: l.status, borrower_pk: l.terms.borrower_pk, lender_pk: l.terms.lender_pk, principal: l.terms.principal, ltv_bps: l.terms.ltv_bps })),
  }))

  api.on('GET', '/orderbook', async () => ({ offers: orderbook.list(await cfg.chain.getHeight()) }))
  api.on('POST', '/orderbook', async ({ body }) => {
    const b = await body()
    const out = orderbook.ingest(b.event as never, await cfg.chain.getHeight())
    if (out.rejected) throw new HttpError(422, out.rejected)
    return out.offer
  }, { who: 'the lender who signed the offer', keys: ({ body }) => [field(body.event, 'pubkey')] })

  api.on('GET', '/oracle/quote', async () => oracle.quote(await cfg.chain.getHeight()))
  api.on('POST', '/oracle/set', async ({ body }) => {
    const b = await body()
    const price = Number(b.price_cents)
    if (!Number.isSafeInteger(price) || price <= 0) throw new HttpError(400, 'price_cents must be a positive integer')
    oracle.setPrice(price)
    api.emit({ type: 'oracle', price_cents: price, ...oracle.status() })
    return { price_cents: price, monitor: await platform.monitor() }
  }, 'operator')
  api.on('POST', '/oracle/live', async () => {
    try { await oracle.useLive() } catch (err) { throw new HttpError(503, (err as Error).message) }
    api.emit({ type: 'oracle', price_cents: oracle.currentPrice(), ...oracle.status() })
    return { price_cents: oracle.currentPrice(), monitor: await platform.monitor() }
  }, 'operator')
  oracle.start(() => {
    api.emit({ type: 'oracle', price_cents: oracle.currentPrice(), ...oracle.status() })
    if (cfg.monitorLivePrices !== false) void platform.monitor().catch((err) => console.error('oracle monitor:', (err as Error).message))
  })
  api.on('POST', '/monitor', async () => ({ loans: await platform.monitor() }), 'operator')

  api.on('GET', '/sandbox/pubkey', () => platform.sandboxPubkey())
  api.on('POST', '/sandbox/submit', async ({ body }) => {
    const b = await body()
    // the sandbox decrypts with sender_pk and refuses a bundle whose borrower_pk is another key
    return platform.submitToSandbox(str(b.sender_pk, 'sender_pk') as Hex, str(b.ciphertext, 'ciphertext'))
  }, { who: 'the borrower sending the bundle (sender_pk)', keys: ({ body }) => [body.sender_pk] })

  api.on('POST', '/loans', async ({ body }) => {
    const b = await body()
    const { loan, verdict } = await platform.registerLoan(b.terms, b.passbook as import('../registry/passbook-doc.js').PassbookDocument | undefined)
    return { loan, verdict }
  }, { who: 'the lender named in the terms', keys: ({ body }) => [field(body.terms, 'lender_pk')] })
  api.on('GET', '/loans/:id', ({ params }) => {
    const loan = cfg.store.getLoan(params.id)
    if (!loan) throw new HttpError(404, 'unknown loan')
    // the repayment account's xpubs stay with the platform; the invoice is what the borrower needs
    const watch = loan.repayment_watch
    return watch ? { ...loan, repayment_watch: { invoice: watch.invoice, recipient_id: watch.recipient_id } } : loan
  })
  api.on('POST', '/loans/:id/lock', async ({ params, body }) => platform.recordLock(params.id, str((await body()).lock_txid, 'lock_txid')), loanParty)
  api.on('POST', '/loans/:id/funded', async ({ params, body }) => {
    const b = await body()
    return platform.recordFunded(params.id, str(b.disbursement_txid, 'disbursement_txid'), str(b.lender_sig, 'lender_sig'))
  }, loanParty)
  api.on('POST', '/loans/:id/repaid', async ({ params, body }) => {
    const b = await body()
    return platform.recordRepaid(params.id, str(b.repayment_txid, 'repayment_txid'), typeof b.lender_sig === 'string' ? b.lender_sig : undefined)
  }, loanParty)
  api.on('POST', '/loans/:id/repayment-watch', async ({ params, body }) => {
    const b = await body()
    const keys: WatchKeys = { account_xpub_vanilla: str(b.account_xpub_vanilla, 'account_xpub_vanilla'), account_xpub_colored: str(b.account_xpub_colored, 'account_xpub_colored'), master_fingerprint: str(b.master_fingerprint, 'master_fingerprint') }
    return platform.registerRepaymentWatch(params.id, keys, str(b.lender_sig, 'lender_sig'))
  }, loanParty)
  api.on('POST', '/loans/:id/repayment/verify', async ({ params, body }) => {
    const b = await body()
    return platform.verifyRepayment(params.id, typeof b.repayment_txid === 'string' ? b.repayment_txid : undefined)
  }, loanParty)
  api.on('POST', '/loans/:id/release', async ({ params, body }) => platform.recordRelease(params.id, str((await body()).release_txid, 'release_txid')), loanParty)
  api.on('POST', '/loans/:id/settle', async ({ params, body }) => {
    const b = await body()
    const outcome = str(b.outcome, 'outcome')
    if (outcome !== 'defaulted' && outcome !== 'liquidated' && outcome !== 'refunded') throw new HttpError(400, 'outcome must be defaulted, liquidated or refunded')
    return platform.recordSettlement(params.id, str(b.txid, 'txid'), outcome)
  }, loanParty)

  api.on('GET', '/passbook/:pk', ({ params }) => platform.passbookView(params.pk))

  // Platform fees: what each lender owes after its loans closed, and whether it is blocked.
  api.on('GET', '/fees', async ({ url }) => {
    const lender = url.searchParams.get('lender') ?? undefined
    const height = await cfg.chain.getHeight()
    // a lender's own listing hands out payable invoices: missing or expiring ones are replaced first
    const fees = lender ? platform.fees.refreshInvoices(lender, height) : platform.fees.list()
    return { height, economics: publishedEconomics(economics), fees, ...(lender ? { blocked: platform.fees.blockedAt(lender, height) } : {}) }
  })
  /** A payable invoice for a due fee: the current one, or a fresh one if it never issued or is about to expire. */
  api.on('POST', '/fees/:loan_id/invoice', async ({ params }) => {
    const fee = cfg.store.getFee(params.loan_id)
    if (!fee) throw new HttpError(404, 'no platform fee for this loan')
    const out = platform.fees.ensureInvoice(fee, await cfg.chain.getHeight(), Date.now(), { force: true })
    if (out.status === 'fee_due' && !out.invoice) throw new HttpError(503, 'the platform could not issue a fee invoice yet; try again later')
    return out
  })
  api.on('GET', '/fees/:loan_id', ({ params }) => {
    const fee = cfg.store.getFee(params.loan_id)
    if (!fee) throw new HttpError(404, 'no platform fee for this loan')
    return fee
  })
  api.on('POST', '/fees/:loan_id/verify', async ({ params, body }) => {
    const b = await body()
    return platform.fees.verifyPayment(params.loan_id, typeof b.txid === 'string' ? b.txid : undefined)
  }, { who: 'the lender who owes the fee', keys: ({ params }) => [cfg.store.getFee(params.loan_id)?.lender_pk] })

  // Agents narrate their own steps on the wire. Each note is signed by the agent's key.
  api.on('POST', '/wire', async ({ body }) => {
    const b = await body()
    const note = { actor_pk: str(b.actor_pk, 'actor_pk'), role: str(b.role, 'role'), title: str(b.title, 'title'), detail: b.detail, sig: str(b.sig, 'sig') }
    if (!verifyObject(note, note.actor_pk)) throw new HttpError(401, 'note not signed by actor_pk')
    api.emit({ type: 'agent', role: note.role, actor_pk: note.actor_pk, title: note.title, detail: note.detail ?? null })
    return { ok: true }
  }, { who: "the note's actor (actor_pk)", keys: ({ body }) => [body.actor_pk] })

  api.on('POST', '/cosign', async ({ body }) => {
    const b = await body()
    const purpose = str(b.purpose, 'purpose')
    if (purpose !== 'refund' && purpose !== 'release' && purpose !== 'liquidate') throw new HttpError(400, 'purpose must be refund, release or liquidate')
    return platform.decideCosign({
      loan_id: str(b.loan_id, 'loan_id'),
      purpose: purpose as CosignPurpose,
      psbt: typeof b.psbt === 'string' ? b.psbt : undefined,
      txid: typeof b.txid === 'string' ? b.txid : undefined,
      repayment_txid: typeof b.repayment_txid === 'string' ? b.repayment_txid : undefined,
    })
  }, { who: "the loan's borrower or lender", keys: ({ body }) => loanParties(body.loan_id) })

  return {
    api,
    compliance,
    platform,
    orderbook,
    oracle,
    chain: cfg.chain,
    store: cfg.store,
    close: async () => {
      oracle.stop()
      orderbook.close()
      await api.close()
      cfg.repayments?.close()
      cfg.feeWallet?.close?.()
      wallet?.lock()
      cfg.store.close()
    },
  }
}
