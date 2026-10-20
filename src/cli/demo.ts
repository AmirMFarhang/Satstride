// npm run demo: the ten steps of handoff section 12 on regtest, with real
// Bitcoin transactions and real RGB transfers. Needs `infra/regtest.sh start`
// and `npm run seed`. The platform runs in this process on :4170 (so the
// dashboard can watch /events) unless PASSBOOK_URL points at a running one.
// The agents only talk to it over HTTP and to each other over the Nostr relay.
//
//   npm run demo                       run straight through
//   npm run demo -- --step             wait for Enter before each step
//   npm run demo -- --scenario margin  after step 7 the price falls, the margin call runs out
//                                      its cure window and lender + platform liquidate via leaf B
//   npm run demo -- --scenario cure    the same margin call, but the price recovers inside the window
//   npm run demo -- --lender-refuses   step 8 as the scenario: lender 1 keeps the USDT and will not sign;
//                                      the platform validates the RGB repayment itself and co-signs leaf C
//   npm run dev                        the dashboard on :4170 drives it: Next per step; the borrower's phone
//                                      answers the stops (share at step 5, accept at 7, repay at 8); a price
//                                      slider and a Margin call button (pressed while the loan is open, it
//                                      turns the run into the margin scenario), and at step 8 a
//                                      "Lender refuses release" button. When a loan closes, the lender
//                                      pays the platform's share of the interest: the lender panel's Pay
//                                      (can't be undone) on the dashboard, straight through in the terminal
//   npm run demo -- --check-market     the negotiated loan's credit check is bought from a check node over RGB
//                                      Lightning (HODL invoice) instead of the platform sandbox; the lender takes
//                                      it only from the forwarded K (docs/CHECK-MARKET.md). Needs the HODL RGB
//                                      Lightning nodes of infra/compose.checks.yaml on the demo chain. Off by default

import { createInterface } from 'node:readline/promises'
import { isDeepStrictEqual } from 'node:util'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { reasonerFromEnv } from '../agents/agent.js'
import { QvacSdkReasoner } from '../ai/qvac-sdk-reasoner.js'
import { privateReasonBars } from '../sandbox/reasons.js'
import { PlaybookReasoner } from '../ai/playbook-reasoner.js'
import { RgbHistoryObserver, historyObserverDir } from '../rgb/history-observer.js'
import { RuleReasoner } from '../ai/rule-reasoner.js'
import { runSandbox } from '../sandbox/run.js'
import { keyPairFromLabel, keyPairFromSecret, randomHex, randomKeyPair, type Hex, type KeyPair } from '../core/crypto.js'
import { BorrowerAgent, borrowerCheckpointProblems, type BorrowerLoan, type ProviderScoring, type ScoredCheck } from '../agents/borrower.js'
import { L1_POLICY, LEGACY_L1_POLICY, L2_POLICY, LenderAgent } from '../agents/lender.js'
import { PlatformClient } from '../agents/platform-client.js'
import { relaysFromEnv } from '../agents/relay.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { RgbLightningNode } from '../rgb/lightning.js'
import { prepareAtomicLiquidity } from '../rgb/lightning-liquidity.js'
import { Regtest } from '../chain/regtest.js'
import { btc, MICRO_PER_USDT, pct, priceAtLtv, usdt } from '../core/money.js'
import { debtOf, termsHash, type LoanTerms } from '../core/terms.js'
import { CURE_BLOCKS, FUND_TIMEOUT_BLOCKS } from '../registry/ladder.js'
import { verifyPassbook } from '../registry/passbook-doc.js'
import { Store } from '../registry/store.js'
import { RemoteSandbox } from '../sandbox/broker.js'
import { createApp, feeWalletFromEnv, repaymentWatchFromEnv, type App } from '../server/app.js'
import { mountLayersPanel } from '../server/layers.js'
import { DEFAULT_RECORD, mountCheckNodesPanel } from '../server/checknodes.js'
import type { FeeRecord } from '../server/fees.js'
import { borrowerCostLines, renderTermSheet, termSheetHash, type TermSheet } from '../market/termsheet.js'
import { approvalStatus, approve as approveSheet, makerCheckerThreshold, type Approval } from '../market/approvals.js'
import { messageHash, runNegotiation, verifyTranscript, type NegotiationMessage, type Position } from '../market/negotiate.js'
import { signBorrowerPolicy, signLenderPolicy, type LenderPolicy as MarketLenderPolicy } from '../market/policy.js'
import { LocalKeySigner } from '../wallet/signer.js'
import type { Offer } from '../market/orderbook.js'
import { authFromEnv, newDashboardSession, parseDashboardSession, sessionToken } from '../server/auth.js'
import { deploymentConfigFromEnv } from '../core/config.js'
import { openParty, type Party } from '../wallet/party.js'
import { loadPlatformKey } from '../wallet/platform-key.js'
import { keepSalaryCurrent } from '../wallet/income.js'
import { assertRegistryMatches, serveInspection, unfinishedLoans } from './recovery.js'
import { DemoGate as Gate, DemoStopped } from './demo-gate.js'
import { DemoCheckpoints } from './demo-checkpoints.js'
import { assertDemoWallets } from './demo-wallet-check.js'
import { demoRuntimeHash, demoSandboxKey, RecordedDemo } from './demo-checkpoint-tools.js'
import { readState, writeState } from '../wallet/state.js'
import { loadScoringContract } from '../scorer/contract.js'
import { approveWithEvidence } from '../scorer/evidence-digest.js'
import { ContainerScorer } from '../scorer/providers.js'
import { loadExternalProvider, type ExternalProviderPlugin } from '../scorer/external.js'
import { devReleaseSigner, loadReleaseManifest } from '../scorer/releases.js'
import type { ScorerOutcome } from '../scorer/types.js'
import type { TrustPolicy } from '../scorer/verify.js'
import type { ForwardedCheckVerification } from '../checknode/client.js'
import type { DemoCheckMarket } from './demo-check-market.js'

const PRINCIPAL = 600 * MICRO_PER_USDT
/** The margin scenario drops the price until the open loan sits here: past liquidation (80%), short of the hard stop (85%). */
const SCENARIO_LTV_BPS = 8200
type Scenario = 'standard' | 'margin' | 'cure'
/** What the dashboard can pick at a step instead of plain Next. */
type StepChoice = 'lender-refuses'

/** The oracle price at which a loan reaches the scenario's LTV. */
function marginScenarioPrice(terms: LoanTerms): number {
  return priceAtLtv(debtOf(terms), terms.collateral_sats, SCENARIO_LTV_BPS)
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
const c = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' }
const roleColour: Record<string, string> = { borrower: c.cyan, lender1: c.yellow, lender2: c.green }

function compact(detail: unknown): string {
  if (detail === undefined || detail === null) return ''
  const s = typeof detail === 'string' ? detail : JSON.stringify(detail)
  return s.length > 220 ? `${s.slice(0, 217)}...` : s
}

function log(role: string, title: string, detail?: unknown): void {
  if (title.startsWith('model:')) {
    const d = detail as { engine: string; ms: number; fallback: string | null }
    console.log(`  ${c.dim}[${role}] ${title} via ${d.engine} in ${d.ms} ms${d.fallback ? ` (fallback: ${d.fallback})` : ''}${c.reset}`)
    return
  }
  console.log(`  ${roleColour[role] ?? ''}[${role}]${c.reset} ${title} ${c.dim}${compact(detail)}${c.reset}`)
}

/** The borrower's own wallet, as its phone shows it. Read from the wallet between steps, never sent to the platform's wire. */
interface WalletView {
  at: number
  usdt_settled: number
  usdt_future: number
  /** BTC at the party key's address: what collateral is locked from */
  btc_free_sats: number
  /** vanilla BTC in the RGB wallet: network fees */
  fee_btc_sats: number
  /** BTC on colored outputs: the reserve the assets sit on */
  reserve_sats: number
  transfers: { kind: string; status: string; amount: number; txid: string | null }[]
  error?: string
}

// The showcase supervisor only replaces a writer after an atomic gate freeze.
let activeApp: App | undefined
let activeGate: Gate | null = null
let finished = false
let stopping = false
let shutdown: Promise<void> | undefined
let saveWaiting: (() => Promise<void>) | undefined
function send(message: object): void { if (process.connected) process.send?.(message, () => {}) }
let stopRequest: Promise<void> | undefined
function stopAtCheckpoint(): Promise<void> {
  return stopRequest ??= (async () => {
    stopping = true
    const waiting = activeGate?.freeze()
    try { if (waiting) await saveWaiting?.() }
    catch (error) { console.error(`Could not refresh the waiting checkpoint; the previous durable checkpoint is retained: ${(error as Error).message}`) }
    activeGate?.cancel()
    if (finished) await closeManaged().then(() => process.exit(0))
  })()
}

function closeManaged(): Promise<void> {
  return shutdown ??= (async () => {
    await activeApp?.close()
    await QvacSdkReasoner.shutdown()
  })()
}
if (process.send) {
  let quiesceId: string | undefined
  process.on('message', (message: unknown) => {
    const m = message as { type?: string; id?: string }
    if (m?.type === 'showcase:quiesce') { quiesceId = m.id; send({ type: 'showcase:quiesced', id: m.id, safe: finished || !!activeGate?.freeze() }) }
    if (m?.type === 'showcase:unfreeze' && m.id === quiesceId && !stopping) activeGate?.unfreeze()
    if (m?.type === 'showcase:stop') void stopAtCheckpoint().catch((error: Error) => { console.error(error.message); process.exit(1) })
  })
  process.once('disconnect', () => void stopAtCheckpoint().catch((error: Error) => console.error(error.message)))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stopAtCheckpoint().catch((error: Error) => console.error(error.message)))
}

async function main() {
  let inspect = process.argv.includes('--inspect')
  let recoveryError: string | undefined
  const atomic = process.argv.includes('--atomic')
  // Negotiated origination with term-sheet approvals is the default; --no-negotiate runs the fixed-offer flow.
  const negotiateFlag = !process.argv.includes('--no-negotiate')
  // The second lender approver (maker-checker), a labelled demo key; the threshold defaults to the deployment's 5,000 USDT.
  const checkerKey = keyPairFromLabel('demo-lender-checker')
  const makerChecker = process.env.PASSBOOK_MAKER_CHECKER_USDT ? Number(process.env.PASSBOOK_MAKER_CHECKER_USDT) * MICRO_PER_USDT : deploymentConfigFromEnv()?.compliance.approvals.maker_checker_above_micro ?? 5_000 * MICRO_PER_USDT
  const providerCfg = (() => { const d = deploymentConfigFromEnv(); return d?.scorer.provider === 'external' && d.scorer.external ? { ...d.scorer, external: d.scorer.external } : null })()
  const checkMarketFlag = process.argv.includes('--check-market')
  if (checkMarketFlag && !negotiateFlag) throw new Error('--check-market buys the negotiated loan\'s credit check (the negotiation is the consent\'s purpose); run without --no-negotiate')
  if (checkMarketFlag && providerCfg) throw new Error('--check-market and scorer.provider external both replace the platform scorer; use one')
  if (checkMarketFlag && process.env.PASSBOOK_DEMO_CHECKPOINT) throw new Error('--check-market is not journaled for the restartable showcase (a replay would pay a check node again); unset PASSBOOK_DEMO_CHECKPOINT')
  // --scorer-out <dir>: the external provider-scored loan's evidence for `passbook audit export <dir>`, plus its chain and funding record.
  const scorerOut = process.argv.includes('--scorer-out') ? resolve(process.argv[process.argv.indexOf('--scorer-out') + 1]) : undefined
  if (atomic && (process.argv.includes('--iou-sale') || process.argv.includes('--lender-refuses'))) throw new Error('--atomic uses a fixed origination invoice and no release co-signer; use the legacy demo for IOU sale or lender-refusal scenarios')
  const stepMode = process.argv.includes('--step')
  const dashboard = process.argv.includes('--dashboard')
  // PASSBOOK_DASHBOARD_SESSION=<id>.<secret> lets a rehearsal harness open the signed link; otherwise a fresh one per run.
  const dashboardSession = process.env.PASSBOOK_DASHBOARD_SESSION ? parseDashboardSession(process.env.PASSBOOK_DASHBOARD_SESSION) : newDashboardSession()
  const persona = process.argv.includes('--persona') ? process.argv[process.argv.indexOf('--persona') + 1] : undefined
  if (persona !== undefined && persona !== 'fatima' && persona !== 'walter') throw new Error('--persona must be fatima or walter')
  const scenarioArg = process.argv.includes('--scenario') ? process.argv[process.argv.indexOf('--scenario') + 1] : 'standard'
  if (scenarioArg !== 'standard' && scenarioArg !== 'margin' && scenarioArg !== 'cure') throw new Error(`--scenario must be standard, margin or cure, not ${scenarioArg}`)
  let scenario: Scenario = scenarioArg
  const rl = stepMode ? createInterface({ input: process.stdin, output: process.stdout }) : null
  const state = readState()
  if (persona && !state.personas && !inspect) throw new Error('Persona wallets are missing; run npm run seed -- --fresh --personas')
  const regtest = new Regtest()
  const chain = BitcoindChain.fromEnv()
  const relays = relaysFromEnv()
  const checkpointFile = process.env.PASSBOOK_DEMO_CHECKPOINT
  let takeCheckpoint: () => unknown | Promise<unknown> = () => undefined
  let journal: DemoCheckpoints | undefined
  let sandboxKey: ReturnType<typeof demoSandboxKey> | undefined
  if (checkpointFile && !inspect) {
    try {
      if (process.argv.includes('--resume') && !existsSync(checkpointFile)) throw new Error('No saved approval checkpoint exists for this run')
      const keyFile = join(dirname(checkpointFile), 'sandbox-key')
      if (process.argv.includes('--resume') && !existsSync(keyFile)) throw new Error('Saved sandbox signing key is missing; inspect the retained run')
      sandboxKey = demoSandboxKey(keyFile)
      journal = new DemoCheckpoints(checkpointFile, {
        sandbox: sandboxKey.pubkey,
        runtime: demoRuntimeHash(), asset: state.asset.id, platform: state.platform_pk,
        borrower: persona ? state.personas![persona].party.pubkey : state.parties.borrower.pubkey,
        args: process.argv.slice(2).filter((arg) => arg !== '--resume'),
        blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30), priceCents: Number(process.env.BTC_PRICE_CENTS ?? 10_000_000), oracle: process.env.PASSBOOK_ORACLE ?? '', sandboxUrl: process.env.SANDBOX_URL ?? '',
        ai: process.env.PASSBOOK_AI ?? 'rules', model: process.env.QVAC_MODEL ?? '', context: process.env.QVAC_CTX_SIZE ?? '',
      }, () => takeCheckpoint())
      if (journal.completed) inspect = true
      if (process.argv.includes('--resume') && !inspect) await assertDemoWallets(state, ['payer', 'lender1', 'lender2', persona ?? 'borrower', ...(persona === 'fatima' ? ['walter' as const] : [])])
      const previous = journal.savedState as { height?: number; block?: string } | undefined
      if (previous && (!Number.isSafeInteger(previous.height) || typeof previous.block !== 'string' || await chain.getHeight() !== previous.height || await chain.rpc<string>('getblockhash', [previous.height]) !== previous.block)) throw new Error('Chain tip changed since the saved approval checkpoint; inspect the retained run or start a new demo')
    } catch (error) { inspect = true; recoveryError = (error as Error).message }
  }
  // Opening a missing SQLite path would fabricate an empty registry on resume.
  if (process.argv.includes('--resume') && process.env.PASSBOOK_DB && !existsSync(process.env.PASSBOOK_DB)) throw new Error('Saved registry database is missing; its checkpoint cannot resume. Start a new demo; retained files were preserved.')
  if (!inspect) await regtest.ensureMiner()
  const recorded = new RecordedDemo(journal)


  // one model for the whole process (platform, in-process sandbox, agents): load it before step 1
  const ai = reasonerFromEnv()

  let app: App | undefined
  let base = process.env.PASSBOOK_URL ?? ''
  // The demo orchestrator's own operator calls (price moves, monitor) are signed with the platform key.
  let operatorKey = process.env.PASSBOOK_OPERATOR_SECRET ? keyPairFromSecret(process.env.PASSBOOK_OPERATOR_SECRET) : undefined
  if (!base) {
    const platformKey = loadPlatformKey()
    if (!platformKey || platformKey.pubkey !== state.platform_pk) throw new Error('platform key does not match infra/state.json; rerun npm run seed')
    const store = new Store(process.env.PASSBOOK_DB ?? (dashboard ? 'infra/passbook.sqlite' : ':memory:'))
    assertRegistryMatches(store, state.asset.id, state.platform_pk)
    app = createApp({
      platformKey,
      ...(sandboxKey && !inspect ? { sandboxKey } : {}),
      store,
      monitorLivePrices: !inspect && unfinishedLoans(store).length === 0,
      liveOracle: !inspect && (process.env.PASSBOOK_ORACLE === 'live' || (dashboard && process.env.PASSBOOK_ORACLE !== 'demo')),
      chain,
      sandbox: process.env.SANDBOX_URL ? new RemoteSandbox(process.env.SANDBOX_URL) : undefined,
      reasoner: ai,
      initialPriceCents: Number(process.env.BTC_PRICE_CENTS ?? 10_000_000),
      blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30),
      relays,
      repayments: await repaymentWatchFromEnv(),
      feeWallet: await feeWalletFromEnv(platformKey),
      // Writes must be signed (agents: party keys; dashboard: the operator session below).
      // An invalid passbook.config.yaml refuses to start.
      auth: authFromEnv(platformKey.pubkey, process.env, [dashboardSession]),
      deployment: deploymentConfigFromEnv(),
    })
    activeApp = app
    operatorKey ??= platformKey
    const port = await app.api.listen(Number(process.env.PORT ?? 4170), '127.0.0.1')
    base = `http://127.0.0.1:${port}`
    console.log(`${c.dim}platform on http://127.0.0.1:${port} (chain bitcoind, ai ${ai.engine}, sandbox ${process.env.SANDBOX_URL ? 'container' : 'in-process'}, relay ${relays.join(',')})${c.reset}`)
    // The session secret travels only in the fragment, which the browser never sends to the server.
    console.log(`dashboard (operator link, keep it private): http://127.0.0.1:${port}/#session=${sessionToken(dashboardSession)}`)
  }
  const unsignedPlatform = new PlatformClient(base)
  const platform = operatorKey ? unsignedPlatform.as(operatorKey) : unsignedPlatform
  if (dashboard && !app) throw new Error('--dashboard needs the in-process platform (unset PASSBOOK_URL)')
  const platformOff = process.argv.includes('--platform-off')
  const iouSale = process.argv.includes('--iou-sale')
  let fundedForOffline = false
  const disablePlatform = async () => {
    if (!app || !fundedForOffline) throw new Error('platform-off is available after funding with the in-process demo')
    app.api.setPlatformOnline(false)
    console.log('  platform API OFF: state, sandbox, loan index and co-signing return 503; static UI and demo controls remain')
    app.api.emit({ type: 'platform_offline', title: 'Platform API off; peers continue over Bitcoin, RGB and Nostr' })
  }
  if (app) {
    if (inspect || (!journal && unfinishedLoans(app.store).length)) {
      if (!dashboard) throw new Error('Saved unfinished loans exist. Start npm run dev with the same PASSBOOK_DB to inspect them; automated resume is unavailable.')
      serveInspection(app, {
        borrower_pk: app.store.allLoans().at(-1)?.terms.borrower_pk ?? (persona && state.personas ? state.personas[persona].party.pubkey : state.parties.borrower.pubkey), asset_id: state.asset.id, scenario,
        ...(recoveryError ? { recoveryError } : {}),
        lenders: { [state.parties.lender1.pubkey]: 'Lender 1', [state.parties.lender2.pubkey]: 'Lender 2' },
      })
      console.log(`Saved unfinished loans found; recovered history is available at ${base}/. Automated agent resume is unavailable; no payment or new loan was started.`)
      finished = true
      send({ type: 'showcase:ready', port: Number(new URL(base).port), inspection: true })
      if (!process.argv.includes('--serve')) await app.close()
      return
    }
    await app.oracle.refresh()
    const status = app.oracle.status()
    console.log(`oracle ${status.source}${status.last_error ? `: ${status.last_error}; choose Demo override to borrow offline` : ''}`)
  }
  if (ai instanceof QvacSdkReasoner) {
    const started = performance.now()
    let shown = -1
    const warm = new QvacSdkReasoner({ ...QvacSdkReasoner.configFromEnv(), onProgress: (p, done, total) => {
      const tenth = Math.floor(p / 10)
      if (tenth !== shown) console.log(`${c.dim}model download ${p.toFixed(0)}% (${done.toFixed(0)}/${total.toFixed(0)} MB)${c.reset}`)
      shown = tenth
    } })
    await warm.load()
    console.log(`${c.dim}${ai.engine} loaded in process in ${((performance.now() - started) / 1000).toFixed(1)} s${c.reset}`)
  }
  let gateCount = 0
  let announced = false
  let presentationRestored = false
  const gate = dashboard && app ? new Gate(app, scenario, journal ? <T>(kind: 'next' | 'approve' | 'confirm', info: Record<string, unknown>, wait: () => Promise<T>) => {
    if (!journal!.replaying && !presentationRestored && saved) {
      presentationRestored = true
      app?.api.setPlatformOnline(saved.ui.platform_online)
    }
    return journal!.wait(`${kind}:${gateCount++}`, JSON.parse(JSON.stringify(info)), async () => {
      if (!announced) { announced = true; send({ type: 'showcase:ready', port: Number(new URL(base).port), inspection: false }) }
      return wait()
    })
  } : undefined) : null
  activeGate = gate
  if (stopping) gate?.cancel()

  // the phone reads the borrower's wallet only at these safe points, never while a send is in flight
  let wallet: WalletView | null = null
  let privateReasons: ReturnType<typeof privateReasonBars> | null = null
  const snapshot = async (): Promise<void> => {
    if (!gate || journal?.replaying) return
    try {
      const u = borrowerParty.rgb.balance(assetId)
      const b = borrowerParty.rgb.btcBalance()
      const free = (await borrower.btcUtxos()).reduce((s, x) => s + x.value, 0)
      const transfers = borrowerParty.rgb
        .transfers(assetId)
        .filter((t) => t.kind !== 'Issuance')
        .slice(-6)
        .reverse()
        .map(({ kind, status, amount, txid }) => ({ kind, status, amount, txid }))
      wallet = { at: Date.now(), usdt_settled: u.settled, usdt_future: u.future, btc_free_sats: free, fee_btc_sats: b.vanilla.spendable, reserve_sats: b.colored.settled, transfers }
    } catch (err) {
      wallet = { ...(wallet ?? { usdt_settled: 0, usdt_future: 0, btc_free_sats: 0, fee_btc_sats: 0, reserve_sats: 0, transfers: [] }), at: Date.now(), error: (err as Error).message }
    }
  }

  let n = 0
  /** `gated: false` when the dashboard's Next for this step was already pressed */
  /**
   * `gated: false` when the dashboard's Next for this step was already pressed; `choices` are the
   * alternatives the dashboard may pick instead of Next, and the pick (or `picked`) is returned.
   */
  const step = async (title: string, opts: { hint?: string; gated?: boolean; choices?: StepChoice[]; picked?: StepChoice } = {}): Promise<StepChoice | undefined> => {
    const replayedStep = journal?.replaying === true
    let choice = opts.picked
    if (rl) await rl.question(`${c.dim}press Enter for step ${n + 1}: ${title}${c.reset}`)
    if (gate && opts.gated !== false) {
      await snapshot()
      choice = await gate.wait<StepChoice | undefined>('next', { n: n + 1, title, scenarios: opts.choices ?? [], ...(opts.hint ? { hint: opts.hint } : {}) })
    }
    n += 1
    console.log(`\n${c.bold}${n}. ${title}${c.reset}  ${c.dim}height ${await chain.getHeight()}${c.reset}`)
    if (!replayedStep) app?.api.emit({ type: 'step', n, title, ...(choice ? { scenario: choice } : {}) })
    return choice
  }

  const mine = (blocks = 1) => recorded.call('mine', () => regtest.mine(blocks))
  const open = (role: 'borrower' | 'lender1' | 'lender2') => openParty(role)
  const parties: Party[] = []
  const payer = await openParty('payer')
  const borrowerParty = await openParty(persona ?? 'borrower')
  // Both named borrowers occupy the phone's borrower role; their keys/wallets stay distinct.
  borrowerParty.role = 'borrower'
  const l1Party = await open('lender1')
  const l2Party = await open('lender2')
  parties.push(borrowerParty, l1Party, l2Party)
  const assetId = state.asset.id
  const payerLightning = atomic ? RgbLightningNode.fromEnv('BORROWER') ?? new RgbLightningNode('http://127.0.0.1:3101') : undefined
  const payeeLightning = atomic ? RgbLightningNode.fromEnv('LENDER') ?? new RgbLightningNode('http://127.0.0.1:3102') : undefined
  const common = { platform, mine, log: (role: string, title: string, detail?: unknown) => {
    log(role, title, detail)
    // The local display observes its own agents even with the business API off.
    if (app && !app.api.isPlatformOnline) app.api.emit({ type: 'agent', role, title, detail, actor_pk: [borrowerParty, l1Party, l2Party].find((p) => p.role === role)?.key.pubkey, source: 'local_agent_observer' })
  } }
  const inflows = persona ? state.personas![persona].inflows : state.borrower_inflows
  const observerSigner = loadPlatformKey()
  const historyObserver = persona && observerSigner ? new RgbHistoryObserver({ rootDir: historyObserverDir(), signer: observerSigner, chain }) : null
  if (historyObserver) for (const party of [borrowerParty, l1Party, l2Party, payer]) historyObserver.identifyWallet(party.key.pubkey, party.rgb)
  if (historyObserver) historyObserver.attachWallet(borrowerParty.key.pubkey, borrowerParty.rgb)
  const scorerPolicy: TrustPolicy | null = providerCfg ? { minTrust: providerCfg.min_trust_for_lenders, releases: loadReleaseManifest(providerCfg.approved_builds), releaseSignerPk: providerCfg.release_signer_pk ?? devReleaseSigner().pubkey, contract: loadScoringContract() } : null
  const plugin: ExternalProviderPlugin | null = providerCfg ? await loadExternalProvider(providerCfg.external.package, JSON.parse(readFileSync(providerCfg.external.options_file, 'utf8'))) : null
  const providerScoring: ProviderScoring | undefined = plugin && scorerPolicy ? { providers:[plugin.provider], chainSigner: keyPairFromLabel('passbook-demo-observer'), policy:scorerPolicy, fallbacks:providerCfg?.fallback==='container'&&providerCfg.url?[new ContainerScorer(providerCfg.url)]:[] } : undefined

  // Started at Setup with --check-market: two check nodes on the relay and the borrower's own RGB Lightning node.
  let market: DemoCheckMarket | undefined
  const startCheckMarket = async (): Promise<DemoCheckMarket> => {
    const { startDemoCheckMarket } = await import('./demo-check-market.js')
    const m = await startDemoCheckMarket({ assetId, chain, regtest, oraclePk: (await platform.state()).oracle_pk, reasoner: ai, blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30), log: (line) => console.log(`  ${c.dim}${line}${c.reset}`) })
    for (const v of m.views()) console.log(`  check node ${v.name}: operator ${v.operator_pk.slice(0, 12)}… (${v.operator_key}), ${v.price.amount / MICRO_PER_USDT} USDT, ${v.execution.label}, bond ${v.bond}; ${v.scorer_label}; runs in this demo process`)
    return m
  }
  const borrower = new BorrowerAgent({ ...common, party: borrowerParty, assetId, inflows, lightning: payerLightning, ...(historyObserver ? { historyProof: () => historyObserver.proof(borrowerParty.key.pubkey) } : {}), ...(providerScoring ? { scoring: providerScoring } : {}) })
  const lender1 = new LenderAgent({ ...common, party: l1Party, assetId, policy: persona ? L1_POLICY : LEGACY_L1_POLICY, lightning: payeeLightning ?? null, ...(plugin && scorerPolicy ? { scoring: { policy: scorerPolicy, externalVerifier: plugin.verifyOutcome, chainSigners: [providerScoring!.chainSigner.pubkey] } } : {}) })
  const lender2 = new LenderAgent({ ...common, party: l2Party, assetId, policy: L2_POLICY, lightning: null })
  const comparisonParty = persona === 'fatima' ? await openParty('walter') : null
  if (historyObserver && comparisonParty) historyObserver.attachWallet(comparisonParty.key.pubkey, comparisonParty.rgb)
  const comparison = comparisonParty ? new BorrowerAgent({ ...common, party: comparisonParty, assetId, inflows: state.personas!.walter.inflows, ...(historyObserver ? { historyProof: () => historyObserver.proof(comparisonParty.key.pubkey) } : {}) }) : null
  let comparisons: Record<string, unknown>[] = []
  let judgeMemo: string | undefined
  type Saved = {
    borrower: { pubkey: string; loans: [string, BorrowerLoan][]; inflows: typeof inflows }
    comparison?: { pubkey: string; loans: [string, BorrowerLoan][]; inflows: typeof inflows }
    lender1: ReturnType<LenderAgent['exportCheckpoint']>
    lender2: ReturnType<LenderAgent['exportCheckpoint']>
    ui: { judgeMemo?: string; platform_online: boolean; price_cents: number }
    relays: { borrower: ReturnType<typeof borrower.relay.exportCheckpoint>; lender1: ReturnType<typeof lender1.relay.exportCheckpoint>; lender2: ReturnType<typeof lender2.relay.exportCheckpoint>; comparison?: ReturnType<typeof borrower.relay.exportCheckpoint> }
    registry: ReturnType<Store['allLoans']>
    height: number; block: string
  }
  const saved = journal?.savedState as Saved | undefined
  const restoreBorrower = (agent: BorrowerAgent, value: Saved['borrower']) => {
    if (value.pubkey !== agent.pubkey || !Array.isArray(value.loans) || !Array.isArray(value.inflows)) throw new Error('Saved borrower checkpoint belongs to another wallet')
    const seen = new Set<string>()
    for (const [id, loan] of value.loans) {
      if (seen.has(id) || termsHash(loan.terms) !== id || loan.terms.asset_id !== assetId || loan.terms.borrower_pk !== agent.pubkey || borrowerCheckpointProblems(id, loan, agent.pubkey).length) throw new Error('Saved borrower loan checkpoint is invalid')
      seen.add(id)
    }
    agent.loans.clear(); for (const [id, loan] of value.loans) agent.loans.set(id, loan)
    agent.inflows.splice(0, agent.inflows.length, ...value.inflows)
  }
  if (saved) {
    try {
      if (!app || !isDeepStrictEqual(saved.registry, app.store.allLoans())) throw new Error('Saved registry rows differ from the approval checkpoint; automatic replay is unsafe')
    if (await chain.rpc<string>('getblockhash', [saved.height]) !== saved.block) throw new Error('Saved checkpoint is on a different chain; inspect this run before continuing')
    borrower.relay.restoreCheckpoint(saved.relays.borrower)
    lender1.relay.restoreCheckpoint(saved.relays.lender1)
    lender2.relay.restoreCheckpoint(saved.relays.lender2)
    if (comparison && saved.relays.comparison) comparison.relay.restoreCheckpoint(saved.relays.comparison)
    restoreBorrower(borrower, saved.borrower)
    if (comparison && saved.comparison) restoreBorrower(comparison, saved.comparison)
    await lender1.restoreCheckpoint(saved.lender1)
    await lender2.restoreCheckpoint(saved.lender2)
    if (historyObserver) for (const loan of borrower.loans.values()) {
      if (loan.disbursement_recipient_id) historyObserver.invoice(borrowerParty.rgb.dataDir, loan.disbursement_recipient_id)
    }
    judgeMemo = saved.ui.judgeMemo
    app?.oracle.setPrice(saved.ui.price_cents)
    } catch (error) {
      historyObserver?.close()
      for (const agent of [borrower, lender1, lender2, ...(comparison ? [comparison] : [])]) agent.close()
      for (const party of [...parties, payer, ...(comparisonParty ? [comparisonParty] : [])]) party.close()
      if (!app) throw error
      serveInspection(app, { borrower_pk: borrower.pubkey, asset_id: assetId, scenario, recoveryError: (error as Error).message, lenders: { [lender1.pubkey]: 'Lender 1', [lender2.pubkey]: 'Lender 2' } })
      finished = true
      send({ type: 'showcase:ready', port: Number(new URL(base).port), inspection: true })
      return
    }
  }
  takeCheckpoint = async (): Promise<Saved> => {
    const height = await chain.getHeight()
    const exportBorrower = (agent: BorrowerAgent) => ({ pubkey: agent.pubkey, loans: [...agent.loans], inflows: agent.inflows })
    return JSON.parse(JSON.stringify({
      borrower: exportBorrower(borrower), ...(comparison ? { comparison: exportBorrower(comparison) } : {}),
      lender1: lender1.exportCheckpoint(), lender2: lender2.exportCheckpoint(),
      relays: { borrower: borrower.relay.exportCheckpoint(), lender1: lender1.relay.exportCheckpoint(), lender2: lender2.relay.exportCheckpoint(), ...(comparison ? { comparison: comparison.relay.exportCheckpoint() } : {}) },
      ui: { judgeMemo, platform_online: app?.api.isPlatformOnline ?? true, price_cents: app?.oracle.currentPrice() ?? 10_000_000 },
      registry: app?.store.allLoans() ?? [],
      height, block: await chain.rpc<string>('getblockhash', [height]),
    })) as Saved
  }
  saveWaiting = () => journal?.checkpoint() ?? Promise.resolve()
  recorded.wrap(borrower, 'borrower', ['ask', 'findOffer', 'buildSandboxBundle', 'runSandbox', 'runProviderCheck', 'apply', 'applyScored', 'awaitAcceptance', 'explainTerms', 'approveTermSheet', 'lockAndSplit', 'awaitFunding', 'awaitIouReturn', 'marginStatus', 'liquidated'])
  if (comparison) recorded.wrap(comparison, 'comparison', ['buildSandboxBundle', 'runSandbox'])
  for (const [label, lender] of [['lender1', lender1], ['lender2', lender2]] as const) recorded.wrap(lender, label, ['publishOffer', 'underwrite', 'proposeTermSheet', 'sendTermSheet', 'fund', 'awaitIou', 'assess', 'liquidate', 'acceptIou', 'payPlatformFees'])
  recorded.wrap(platform, 'platform', ['state', 'quote', 'orderbook', 'loan', 'passbook', 'setPrice', 'monitor'])
  if (gate && app) {
    const lenders = { [lender1.pubkey]: 'Lender 1', [lender2.pubkey]: 'Lender 2' }
    app.api.on('GET', '/demo', () => ({ borrower_pk: borrower.pubkey, step: n, waiting: gate.waiting, scenario: gate.scenario, lenders, asset_id: assetId, persona, comparisons, can_edit_memo: !!comparison && n < 4, atomic, atomic_receipts: [...borrower.loans].filter(([, l]) => l.repayment_preimage && l.release_txid).map(([loan_id, l]) => ({ loan_id, payment_hash: l.repayment_payment_hash, preimage: l.repayment_preimage, release_txid: l.release_txid })), platform_online: app!.api.isPlatformOnline, can_disable_platform: fundedForOffline, negotiate: negotiateFlag }))
    // Add-on 4 Part A panel: RGB + Bitcoin mainnet + Lightning, on-chain recomputed by the lender (src/server/layers.ts)
    mountLayersPanel(app.api, { party: borrowerParty, assetId, chain, inflows, lenderPk: lender1.pubkey, store: app.store, priceCents: () => app!.oracle.currentPrice() })
    // Add-on 5 panel: check nodes as a market, read-only (src/server/checknodes.ts)
    mountCheckNodesPanel(app.api)
    app.api.on('POST', '/demo/memo', async ({ body }) => {
      const b = await body()
      if (!comparison || n >= 4 || typeof b.memo !== 'string' || b.memo.length > 400) return { ok: false }
      judgeMemo = b.memo
      return { ok: true }
    })
    app.api.on('POST', '/demo/platform-off', async () => { await disablePlatform(); return { ok: true } })
    app.api.on('GET', '/demo/local', async () => {
      const document = borrower.passbookDocument()
      const pb = await verifyPassbook(document, chain)
      const pages = await Promise.all(pb.pages.map(async (p, i) => {
        const close = p.close_txid ? await chain.getTx(p.close_txid) : null
        const proof = document.pages[i].repayment
        return { ...p, repayment_txid: proof?.kind === 'rgb_receipt' ? proof.receipt.repayment_txid : undefined, returned_sats: close?.outputs.filter((o) => o.script === borrowerParty.btcScript).reduce((sum, o) => sum + o.value, 0) }
      }))
      const priceCents = [...borrower.loans.values()].at(-1)?.terms.oracle_quote.price_cents ?? 10_000_000
      const loans = [...borrower.loans].map(([id, l]) => ({ id, terms: l.terms, lender_pk: l.ownership?.holder_pk ?? l.lender_pk, status: l.release_txid ? 'repaid' : l.disbursement_txid ? 'open' : 'locked' }))
      return { state: { height: await chain.getHeight(), chain: 'bitcoind', price_cents: priceCents, engine: ai.engine, relays, loans }, passbook: { ...pb, pages, price_cents: priceCents, ladder_bps: [5000,5500,6000,6500] } }
    })
    app.api.on('GET', '/demo/wallet', () => ({ ...(wallet ?? {}), private_reasons: privateReasons }))
    app.api.on('POST', '/demo/next', async ({ body }) => {
      const b = await body()
      return { ok: gate.answer('next', typeof b.scenario === 'string' ? b.scenario : undefined) }
    })
    app.api.on('POST', '/demo/approve', async ({ body }) => {
      const b = await body()
      return { ok: gate.answer('approve', Array.isArray(b.txids) ? b.txids.filter((t) => typeof t === 'string') : []) }
    })
    app.api.on('POST', '/demo/confirm', async ({ body }) => {
      const b = await body()
      return { ok: gate.answer('confirm', b.accept === true, typeof b.stop === 'string' ? b.stop : '', typeof b.loan_id === 'string' ? b.loan_id : '') }
    })
    app.api.emit({ type: 'demo', waiting: null, borrower_pk: borrower.pubkey, scenario })
    if (!journal) send({ type: 'showcase:ready', port: Number(new URL(base).port), inspection: false })
    console.log(`${c.bold}dashboard: ${base}/${c.reset}  press Next there to run each step`)
  }
  // stop 1: the borrower picks what this lender may see
  const chooseFor = (lenderPk: string) =>
    gate
      ? async (items: unknown[]) => {
          await snapshot()
          return gate.wait<string[]>('approve', { items, lender_pk: lenderPk })
        }
      : undefined
  // stops 2 and 3: the phone's Lock and accept, and Pay; terminal runs go straight through
  const confirm = async (stop: 'accept' | 'repay', info: Record<string, unknown>) => {
    if (!gate) return
    await snapshot()
    const ok = await gate.wait<boolean>('confirm', { stop, ...info })
    if (ok !== true) throw new Error(stop === 'accept' ? 'the borrower declined the terms' : 'the borrower did not confirm the repayment')
  }
  const acceptInfo = async (loanId: string, lenderPk: string) => {
    const t = borrower.loans.get(loanId)!.terms
    return {
      loan_id: loanId,
      lender_pk: lenderPk,
      principal: t.principal,
      fee: t.fee,
      collateral_sats: t.collateral_sats,
      maturity_height: t.maturity_height,
      grace_blocks: t.grace_blocks,
      price_cents: t.oracle_quote.price_cents,
      refund_blocks: FUND_TIMEOUT_BLOCKS,
      atomic_repayment: t.atomic_repayment,
      // code wrote these: principal + termInterest, no other fee, and the early-liquidation disclosure
      cost_lines: borrowerCostLines(t),
      ...(borrower.loans.get(loanId)?.termsheet ? { termsheet: { hash: loanId, render: renderTermSheet(borrower.loans.get(loanId)!.termsheet!, { audience: 'borrower' }) } } : {}),
      ...(await borrower.explainTerms(loanId)),
    }
  }
  /**
   * Both agents negotiate inside policies their owners signed. Every message is
   * signed by its sender's own key and hash-chained; the dashboard shows them as
   * they are made. Demo limit: both agents run in this process.
   */
  const negotiate = async (borrowerKey: KeyPair, lenderKey: KeyPair, lender: LenderAgent, offer: Offer, allowedLtv: number) => {
    const settlements: ('ln-rln' | 'cosign-rgb')[] = atomic ? ['ln-rln', 'cosign-rgb'] : ['cosign-rgb']
    const term = offer.payload.term_blocks
    const issued_at = Math.floor(Date.now() / 1000)
    // external provider: both owners sign the deployment's trust minimum, and the lender requires the chain-backed checks too.
    const minTrust = providerCfg ? providerCfg.min_trust_for_lenders : 'dev-inprocess'
    const bp = await signBorrowerPolicy(new LocalKeySigner(borrowerKey), { asset_id: assetId, principal: { min: PRINCIPAL, max: PRINCIPAL }, max_apr_bps: 1200, max_ltv_bps: allowedLtv, term_blocks: { min: term, max: term }, min_scorer_trust: minTrust, accepted_settlements: settlements, ...(market ? { max_check_price: market.maxCheckPrice } : {}), issued_at })
    const lp = await signLenderPolicy(new LocalKeySigner(lenderKey), { asset_id: assetId, max_per_loan: lender.policy.max, max_outstanding: lender.policy.max * 10, min_apr_bps: 1000, max_ltv_bps: Math.min(lender.policy.ltv_ladder_bps[0], allowedLtv), term_blocks: { min: term, max: term }, required_checks: providerCfg ? ['investigation', 'inflows', 'affordability', 'reconcile'] : ['investigation', 'inflows'], min_scorer_trust: minTrust, accepted_settlements: settlements, approval_rules: { approvers: [checkerKey.pubkey], maker_checker_above: makerChecker }, ...(market ? { check_nodes: market.rules } : {}), issued_at })
    const maxRounds = 3
    const nonce = randomHex()
    // --check-market: the borrower's agent reads the offers on the relay; the negotiation's structure step picks the node.
    const marketInput = market ? await borrower.checkMarketInput(market.borrower) : undefined
    const n = await runNegotiation(bp, lp, { max_rounds: maxRounds, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: settlements }, { borrower: new LocalKeySigner(borrowerKey), lender: lender.negotiationSigner(bp.owner_pk, nonce), nonce, ...(marketInput ? { market: marketInput } : {}) })
    for (const m of n.messages) {
      const role = m.from_pk === borrowerKey.pubkey ? 'borrower' : 'lender'
      const pos = m.body.position as Position | undefined
      console.log(`  ${m.seq} ${role.padEnd(8)} ${m.type.padEnd(7)} ${pos ? `${pct(pos.apr_bps)} APR, ${pct(pos.ltv_bps)} LTV, ${pos.settlement}` : String(m.body.reason ?? '')}  ${c.dim}${messageHash(m).slice(0, 12)}${c.reset}`)
      app?.api.emit({ type: 'negotiation', seq: m.seq, message: m.type, role, ...(pos ? { apr_bps: pos.apr_bps, ltv_bps: pos.ltv_bps, settlement: pos.settlement } : {}), hash: messageHash(m), negotiation_id: m.negotiation_id })
    }
    if (!('agreed' in n.outcome)) throw new Error(`negotiation ended without a deal: ${n.outcome.no_deal}${!n.structure.ok && n.structure.why ? ` (${n.structure.why.join(' ')})` : ''}`)
    const checkNode = n.structure.ok ? n.structure.check_node : undefined
    for (const why of checkNode?.why ?? []) console.log(`  check node pick: ${why}`)
    const v = verifyTranscript(n.messages, { borrower_pk: borrowerKey.pubkey, lender_pk: lenderKey.pubkey, max_rounds: maxRounds })
    if (!v.ok || !v.agreed || !v.accept_hash) throw new Error(`negotiation transcript does not verify: ${v.problems.join('; ')}`)
    return { messages: n.messages as NegotiationMessage[], agreed: v.agreed, accept_hash: v.accept_hash as Hex, negotiation_id: n.messages[0].negotiation_id, lenderPolicy: lp, maxRounds, ...(checkNode ? { checkNode } : {}) }
  }
  /**
   * The lender's human approval of exactly this term sheet, on the dashboard's lender
   * panel; above the maker-checker threshold a second, distinct lender key must
   * approve. A terminal run approves with both keys and says so. Each gate and the
   * signatures (timestamped, randomised) are journaled, so a restart resumes here.
   */
  const lenderApproval = async (lenderKey: KeyPair, policy: MarketLenderPolicy, sheet: TermSheet, render: ReturnType<typeof renderTermSheet>, scored?: ScorerOutcome): Promise<Approval[]> => {
    const loan_id = termSheetHash(sheet)
    const needsChecker = sheet.terms.principal > makerCheckerThreshold(policy, makerChecker)
    if (!gate) console.log(`  ${c.dim}term sheet approved by the terminal run (no dashboard): lender${needsChecker ? ' and second approver' : ''}${c.reset}`)
    else {
      await snapshot()
      if ((await gate.wait<boolean>('confirm', { stop: 'lender-approve', loan_id, lender_pk: lenderKey.pubkey, approver_pk: lenderKey.pubkey, render })) !== true) throw new Error('the lender declined the term sheet')
      // the phone's wallet view is read before every gate, so a resume at this one shows it too
      if (needsChecker) await snapshot()
      if (needsChecker && (await gate.wait<boolean>('confirm', { stop: 'checker-approve', loan_id, lender_pk: lenderKey.pubkey, approver_pk: checkerKey.pubkey, threshold: makerCheckerThreshold(policy, makerChecker), render })) !== true) throw new Error('the second lender approver declined the term sheet')
    }
    // Scored by external provider: each approval refuses a sheet that does not name exactly the evidence the lender verified.
    const sign = (key: KeyPair) => scored ? approveWithEvidence(key, sheet, 'lender', scored) : approveSheet(key, sheet, 'lender')
    const approvals = await recorded.call('lender-approvals', async () => [sign(lenderKey), ...(needsChecker ? [sign(checkerKey)] : [])])
    const status = approvalStatus(sheet, approvals, policy, makerChecker)
    console.log(`  lender approvals: ${status.lender_approvers.length}/${status.required_lender_approvals} for term sheet ${loan_id.slice(0, 12)}`)
    return approvals
  }

  /**
   * The lender pays the platform's share of the interest once a loan has closed. On the
   * dashboard it is the lender panel's Pay, a normal approval that can't be undone; a
   * terminal run pays straight through. Declining leaves the fee due: past its grace
   * period the platform refuses that lender's offers and new loans.
   */
  const settleFees = async (agent: LenderAgent, name: string): Promise<void> => {
    // Recorded with the platform-online decision, so a replay sees the same fees and stops.
    const due = await recorded.call(`fees-due-${name}`, async (): Promise<FeeRecord[]> => {
      if (app && !app.api.isPlatformOnline) return []
      try { return (await platform.fees(agent.pubkey)).fees.filter((f) => f.status === 'fee_due') } catch { return [] }
    })
    for (const f of due) {
      console.log(`  platform invoices ${name} ${usdt(f.amount)}: ${f.share_bps / 100}% of the ${usdt(f.interest)} interest, ${f.outcome.replaceAll('_', ' ')}; grace until block ${f.grace_until_height}`)
      if (gate) {
        await snapshot()
        const ok = await gate.wait<boolean>('confirm', { stop: 'fee', loan_id: f.loan_id, lender_pk: agent.pubkey, amount: f.amount, interest: f.interest, share_bps: f.share_bps, outcome: f.outcome, grace_until_height: f.grace_until_height })
        if (ok !== true) {
          console.log(`  ${name} left the fee outstanding; after block ${f.grace_until_height} the platform refuses its offers and new loans`)
          continue
        }
      }
      const [paid] = await agent.payPlatformFees({ loanId: f.loan_id })
      if (paid) console.log(`  platform fee ${usdt(paid.amount)} paid by ${name} over RGB in ${paid.paid_txid}; the platform validated the receive: ${paid.status}`)
    }
  }
  const repayInfo = (loanId: string, lenderPk: string, t: LoanTerms) => ({ loan_id: loanId, lender_pk: borrower.loans.get(loanId)?.ownership?.holder_pk ?? lenderPk, debt: debtOf(t), collateral_sats: t.collateral_sats, maturity_height: t.maturity_height, atomic_repayment: t.atomic_repayment })

  const repayLoan = async (loanId: string, holder: LenderAgent, refuses = false): Promise<{ repayment: string; release: string }> => {
    const terms = borrower.loans.get(loanId)!.terms
    if (terms.v === 2) {
      const proof = await borrower.repayAtomic(loanId)
      await holder.confirmAtomicRepayment(loanId)
      console.log(`  PB-IOU returned over RGB ${await borrower.awaitIouReturn(loanId)}`)
      app?.api.emit({ type: 'atomic_repayment', loan_id: loanId, ...proof, title: 'Repaid over Lightning → secret revealed → collateral released', co_signer: 'none' })
      console.log(`  Lightning payment ${proof.payment_hash}\n  preimage ${proof.preimage}\n  no co-signer needed; leaf E release ${proof.release_txid}`)
      return { repayment: proof.payment_hash, release: proof.release_txid }
    }
    const watchedInvoice = borrower.loans.get(loanId)?.repayment_invoice
    if (historyObserver && watchedInvoice) historyObserver.invoice((holder.pubkey === l1Party.key.pubkey ? l1Party : l2Party).rgb.dataDir, borrowerParty.rgb.invoiceRecipient(watchedInvoice))
    const repayment = await borrower.repay(loanId)
    await holder.confirmRepayment(loanId, { acknowledge: !refuses })
    if (!refuses) console.log(`  PB-IOU returned over RGB ${await borrower.awaitIouReturn(loanId)}`)
    const [release] = await Promise.all([borrower.release(loanId), lender1.signRelease(loanId, refuses ? { refuse: 'not releasing the collateral' } : {})])
    return { repayment, release }
  }

  /**
   * Handoff sections 7 and 12, margin call: the price falls, the platform's
   * monitor raises a margin call, the borrower's model explains the headroom,
   * the cure window runs on regtest, then either lender + platform liquidate
   * through leaf B or (price back up) the borrower repays and the release closes it.
   */
  const marginPath = async ({ scenario, loanId, terms, gated }: { scenario: Scenario; loanId: string; terms: LoanTerms; gated: boolean }) => {
    const target = marginScenarioPrice(terms)
    await step('Margin call: the oracle price falls', { gated, hint: `drag the price slider or press Margin call; Next drops it to ${dollars(target)} if no margin call stands` })
    if ((await platform.loan(loanId)).margin_call_height === undefined) {
      const set = await platform.setPrice(target)
      console.log(`  oracle: BTC ${dollars(terms.oracle_quote.price_cents)} -> ${dollars(set.price_cents)}; monitor ${set.monitor.map((m) => `${m.loan_id.slice(0, 8)} ${pct(m.ltv_bps)} ${m.state}`).join(', ')}`)
    }
    const mc = await borrower.marginStatus(loanId)
    console.log(`  platform margin call at height ${mc.margin_call_height}; cure until ${mc.cure_until_height}; LTV ${pct(mc.headroom.ltv_bps)} (${mc.headroom.state})`)
    console.log(`  margin call below ${dollars(mc.headroom.margin_call_price_cents)}, liquidation below ${dollars(mc.headroom.liquidation_price_cents)}`)
    console.log(`  note for the borrower: ${mc.note}`)
    console.log(`  topping up is not offered: the escrow is one Taproot output fixed by the terms hash, so more BTC would need a new lock and new terms`)

    await step(`Cure window: ${CURE_BLOCKS} blocks for the borrower`, { hint: `drag the price back above ${dollars(mc.headroom.margin_call_price_cents)} to cure, or press Next to let ${CURE_BLOCKS} blocks pass` })
    if (scenario === 'cure') {
      const back = await platform.setPrice(terms.oracle_quote.price_cents)
      console.log(`  oracle: BTC back to ${dollars(back.price_cents)}; monitor ${back.monitor.map((m) => `${m.loan_id.slice(0, 8)} ${pct(m.ltv_bps)} ${m.state}`).join(', ')}`)
    }
    const h0 = await chain.getHeight()
    await mine(CURE_BLOCKS)
    console.log(`  mined ${CURE_BLOCKS} blocks: height ${h0} -> ${await chain.getHeight()}`)
    await platform.monitor()
    const due = await lender1.assess(loanId)
    const after = await borrower.marginStatus(loanId)
    console.log(`  LTV ${pct(due.headroom.ltv_bps)} at ${dollars(due.price_cents)}; margin call ${after.margin_call_height === undefined ? 'cleared' : `standing since ${after.margin_call_height}`}; liquidation ${due.ok ? 'due' : 'not due'}`)

    if (due.ok) {
      await step('Liquidation: lender and platform spend leaf B')
      const liq = await lender1.liquidate(loanId)
      const back = await borrower.liquidated(loanId)
      for (const ch of liq.checks) console.log(`  ${ch.ok ? c.green + 'ok' : c.yellow + 'NO'}${c.reset} ${ch.id.padEnd(8)} ${c.dim}${ch.detail}${c.reset}`)
      console.log(`  liquidation ${liq.txid}`)
      console.log(`  at ${dollars(liq.price_cents)}: ${btc(liq.lender_sats)} to lender1 (exactly the debt, no penalty), ${btc(back.returned_sats)} back to the borrower`)
      await settleFees(lender1, 'lender1')
    } else {
      await step('Cured: repay and release')
      await confirm('repay', repayInfo(loanId, terms.lender_pk, terms))
      const { repayment: repay, release } = await recorded.call('repay-cure', () => repayLoan(loanId, lender1))
      console.log(`  receipt: RGB repayment ${repay}\n           release      ${release}`)
      await settleFees(lender1, 'lender1')
    }
    const pb = await platform.passbook(borrower.pubkey)
    const currentPage = pb.pages.find((p) => p.loan_id === loanId)!
    console.log(`  passbook page ${pb.pages.indexOf(currentPage) + 1}: ${currentPage.outcome}, verified ${JSON.stringify(currentPage.verified)}; ladder step ${pb.ladder.step}, allowed LTV ${pb.ladder.allowed_ltv_bps / 100}%`)

    await step('Outcome: read from the chain and the RGB wallets')
    for (const p of parties) p.rgb.refresh()
    const btcFree = (await borrower.btcUtxos()).reduce((s, u) => s + u.value, 0)
    const lenderBtc = (await lender1.btcUtxos()).reduce((s, u) => s + u.value, 0)
    const rows = [
      { who: 'borrower', holds: `${usdt(borrowerParty.rgb.balance(assetId).settled)}, ${btc(btcFree)} free` },
      { who: 'lender1', holds: `${usdt(l1Party.rgb.balance(assetId).settled)}, ${btc(lenderBtc)} at its key` },
      { who: 'passbook', holds: `${pb.pages.length} page(s), ${pb.pages.map((p) => p.outcome).join(', ')}; step ${pb.ladder.step}, ${pb.ladder.defaults} default(s), ${pb.unverified} unverified` },
    ]
    for (const r of rows) console.log(`  ${r.who.padEnd(9)} ${r.holds}`)
    app?.api.emit({ type: 'outcome', rows })
    await snapshot()
    console.log(
      `\n${c.green}done${c.reset}: ${
        due.ok
          ? 'margin call, cure window expired, leaf B liquidation co-signed by the platform; the ladder reset to step 0'
          : `${after.margin_call_height === undefined ? 'margin call cleared inside the cure window' : 'margin call cured by repaying in full'}; repaid and released ${currentPage.outcome === 'on_time' ? 'on time' : 'late'}`
      }.`,
    )
  }

  let failed = false
  try {
    await step('Setup')
    if (atomic) await recorded.call('atomic-liquidity', () => prepareAtomicLiquidity({ borrower: borrowerParty, send: (o) => borrower.sendRgb(o, { action: 'repay', recipientOwner: borrowerParty.key.pubkey, reason: 'fund our own Lightning node for the atomic repayment' }), assetId, amount: 650 * MICRO_PER_USDT, payer: payerLightning!, payee: payeeLightning!, regtest, progress: (title, detail) => { log('borrower', title, detail); app?.api.emit({ type: 'atomic_setup', title, detail }) } }))
    if (checkMarketFlag) market = await startCheckMarket()
    console.log(`  regtest height ${await chain.getHeight()}, mock USDT ${assetId}`)
    // income evidence ages: if the chain moved on since seeding, this month's salary arrives first
    await recorded.call('current-income', async () => {
      const paid = persona ? [] : await keepSalaryCurrent({
      payer,
      borrower: borrowerParty,
      assetId,
      inflows: state.borrower_inflows,
      blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30),
      getHeight: () => chain.getHeight(),
      mine,
      heightOf: async (txid) => (await chain.getTx(txid))!.height!,
      onPaid: (i) => {
        console.log(`  payday: payer sends ${usdt(i.amount)} salary over RGB at height ${i.height}`)
        app?.api.emit({ type: 'income', txid: i.txid, amount: i.amount, height: i.height, payer_pk: i.payer_pk })
      },
    })
      if (paid.length) {
      state.borrower_inflows.push(...paid)
      writeState(state)
    }
    })
    for (const i of inflows) console.log(`  inflow ${usdt(i.amount).padStart(14)}  ${i.memo.padEnd(18)} height ${i.height}  ${i.txid.slice(0, 16)}  signed by payer ${i.payer_pk.slice(0, 8)}`)
    for (const p of parties) p.rgb.refresh()
    console.log(`  borrower holds ${usdt(borrowerParty.rgb.balance(assetId).settled)}; lenders ${usdt(l1Party.rgb.balance(assetId).settled)} and ${usdt(l2Party.rgb.balance(assetId).settled)}`)

    await step('Ask: 600 USDT for 30 blocks')
    const ask1 = await borrower.ask(PRINCIPAL, L1_POLICY.apr_bps)
    console.log(`  at ${ask1.allowed_ltv_bps / 100}% LTV the wallet needs ${btc(ask1.collateral_sats)} locked (has ${btc(ask1.btc_available)})`)

    await step("Order book: L1's offer arrives from Nostr")
    await lender1.publishOffer()
    const offer1 = await borrower.findOffer({ lenderPk: lender1.pubkey, principal: PRINCIPAL })

    // Negotiated origination (add-on 3): the agents agree inside signed policies, then each human approves the term sheet.
    const deal = negotiateFlag ? await (async () => {
      await step('Negotiate: borrower and lender agents agree inside their signed policies')
      // Journaled: a replay must not negotiate again with a new nonce and new signatures.
      return recorded.call('negotiate', () => negotiate(borrowerParty.key, l1Party.key, lender1, offer1, ask1.allowed_ltv_bps))
    })() : undefined

    await step(market ? 'Credit check: bought from a check node over RGB Lightning; K goes to the lender' : providerScoring ? 'Credit check: external provider runs the bundle, the signed evidence comes out' : 'Sandbox: the bundle goes in encrypted, a signed result comes out')
    if (persona) {
      for (const [name, agent] of [[persona, borrower], ...(comparison ? [['walter', comparison] as const] : [])] as const) {
        const bundle = await agent.buildSandboxBundle(offer1, PRINCIPAL)
        const { history_proof: _nativeProof, ...originalChecksBundle } = bundle
        const fixed = await recorded.call(`fixed-${name}`, async () => runSandbox({ ...originalChecksBundle, lender_requirements: { ...bundle.lender_requirements, reconciliation: 'optional', income_evidence: 'payer_signatures' } }, { chain, key: randomKeyPair(), reasoner: new RuleReasoner(), blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30), oraclePk: (await platform.state()).oracle_pk }))
        const row = { persona: name, mode: 'fixed checks', passed: fixed.checks.filter((c) => c.id !== 'investigation' && c.id !== 'reconcile').every((c) => c.ok), investigation: fixed.investigation, checks: fixed.checks.map(({ id, ok }) => ({ id, ok })) }
        comparisons.push(row)
        app?.api.emit({ type: 'comparison', ...row })
        const playbook = await recorded.call(`playbook-${name}`, async () => runSandbox(bundle, { chain, key: randomKeyPair(), reasoner: new PlaybookReasoner(), blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30), oraclePk: (await platform.state()).oracle_pk }))
        const baseline = { persona: name, mode: 'playbook', passed: playbook.checks.every((c) => c.ok), investigation: playbook.investigation, checks: playbook.checks.map(({ id, ok }) => ({ id, ok })) }
        comparisons.push(baseline); app?.api.emit({ type: 'comparison', ...baseline })
      }
      if (comparison) {
        if (judgeMemo !== undefined) comparison.inflows[0].memo = judgeMemo
        const walter = await comparison.runSandbox(offer1, PRINCIPAL)
        const row = { persona: 'walter', mode: ai.engine === 'rules' ? 'AI unavailable' : 'local AI', passed: walter.result.checks.every((c) => c.ok), investigation: walter.result.investigation, checks: walter.result.checks.map(({ id, ok }) => ({ id, ok })) }
        comparisons.push(row)
        app?.api.emit({ type: 'comparison', ...row })

      }
    }
    const declined = async (who: string): Promise<void> => {
      console.log(`  ${who} declined: required checks did not pass. No collateral locked or USDT funded.`)
      app?.api.emit({ type: 'outcome', rows: [{ who, holds: 'Application declined; collateral remains in the wallet.' }] })
      await journal?.markComplete()
      finished = true
      send({ type: 'showcase:complete' })
      gate?.stop()
    }
    // external provider: the borrower's wallet sends the bundle to the verified external provider scorer; the platform sandbox does not run for this loan.
    const scored: ScoredCheck | undefined = providerScoring && deal ? await borrower.runProviderCheck(offer1, PRINCIPAL, { apr_bps: deal.agreed.apr_bps, negotiation_id: deal.negotiation_id }) : undefined
    // --check-market: the borrower's agent pays the node the structure step picked over RGB Lightning and forwards K to the lender.
    if (market && !deal?.checkNode) throw new Error('--check-market: the negotiation\'s structure step picked no check node')
    const bought = market && deal?.checkNode ? await borrower.buyCheck(offer1, PRINCIPAL, { apr_bps: deal.agreed.apr_bps, negotiation_id: deal.negotiation_id, messages: deal.messages, lender_policy: deal.lenderPolicy, check_node: deal.checkNode }, market.borrower) : undefined
    const sb1 = scored || bought ? undefined : await borrower.runSandbox(offer1, PRINCIPAL, deal ? { apr_bps: deal.agreed.apr_bps, negotiation_id: deal.negotiation_id } : undefined)
    if (bought) {
      const o = bought.outputs, p = bought.paid
      console.log(`  paid ${usdt(p.commitment.payment.amount)} to check node ${p.offer.operator_pk.slice(0, 12)}… from the borrower's own RGB Lightning node: ${bought.rail_label}; payment hash ${p.commitment.payment.payment_hash}`)
      console.log(`  K ${p.key_source === 'lightning-preimage' ? 'is the preimage of that paid HODL invoice' : 'came from the operator after payment (FALLBACK: pay, then deliver; trusts the node)'}; the sealed result opened and hashes to the operator-signed commitment ${p.commitment.commitment}`)
      for (const ch of o.checks) console.log(`  ${ch.ok ? c.green + 'ok  ' : c.yellow + 'FAIL'}${c.reset} ${ch.id.padEnd(22)} ${c.dim}in the released outputs${c.reset}`)
      console.log(`  ${p.outcome.descriptor.provider}${p.outcome.fallback ? ' (FALLBACK: no external provider config on the node)' : ''} on check node ${p.offer.operator_pk.slice(0, 12)}…, release ${bought.pick.picked!.release_hash.slice(0, 12)}…: ${o.recommendation}, income ${o.income_band}; findings ${o.findings.map((f) => f.type).join(', ') || 'none'}`)
      console.log(`  receipt: ${bought.receipt ? `RGB token ${bought.receipt.contract_id}, ${bought.receipt.status}` : bought.receipt_status}`)
      console.log(`  result fields: ${Object.keys(o).join(', ')}; no history rows, memos or counterparties`)
      if (persona) {
        const row = { persona, mode: `check node ${p.outcome.descriptor.provider}${p.outcome.fallback ? ' (fallback)' : ''}`, passed: o.recommendation === 'QUALIFY', checks: o.checks.map(({ id, ok }) => ({ id, ok })) }
        comparisons.push(row)
        app?.api.emit({ type: 'comparison', ...row })
      }
      if (o.recommendation !== 'QUALIFY') { await declined(persona ?? 'borrower'); return }
    } else if (scored) {
      const o = scored.outputs
      const ref = scored.outcome.kind === 'external-evidence' ? {execution_id:scored.outcome.reference} : null
      if (persona) {
        const row = { persona, mode: `${scored.outcome.descriptor.provider}${scored.outcome.fallback ? ' (fallback)' : ''}`, passed: o.recommendation === 'QUALIFY', checks: o.checks.map(({ id, ok }) => ({ id, ok })) }
        comparisons.push(row)
        app?.api.emit({ type: 'comparison', ...row })
      }
      for (const ch of o.checks) console.log(`  ${ch.ok ? c.green + 'ok  ' : c.yellow + 'FAIL'}${c.reset} ${ch.id.padEnd(22)} ${c.dim}in the released outputs${c.reset}`)
      console.log(`  ${scored.outcome.descriptor.provider} ${ref ? `execution ${ref.execution_id}, external reference, ` : ''}workload ${scored.outcome.descriptor.code_measurement.slice(0, 19)}…: ${o.recommendation}, income ${o.income_band}; findings ${o.findings.map((f) => f.type).join(', ') || 'none'}`)
      console.log(`  lender note: ${o.lender_note}`)
      console.log(`  result fields: ${Object.keys(o).join(', ')}; no history rows, memos or counterparties`)
      if (scorerOut) {
        mkdirSync(scorerOut, { recursive: true })
        writeFileSync(join(scorerOut, 'scorer.json'), `${JSON.stringify(scored.outcome, null, 2)}\n`)
        writeFileSync(join(scorerOut, 'negotiation.json'), `${JSON.stringify(deal!.messages, null, 2)}\n`)
        writeFileSync(join(scorerOut, 'lender-policy.json'), `${JSON.stringify(deal!.lenderPolicy, null, 2)}\n`)
      }
      if (o.recommendation !== 'QUALIFY') { await declined(persona ?? 'borrower'); return }
    } else if (sb1) {
      if (sb1.result.summary.history_metrics && sb1.result.reconciliation && sb1.result.typology_scores) privateReasons = privateReasonBars(sb1.result.summary.history_metrics, sb1.result.reconciliation, sb1.result.typology_scores)
      if (persona) {
        const row = { persona, mode: ai.engine === 'rules' ? 'AI unavailable' : 'local AI', passed: sb1.result.checks.every((c) => c.ok), investigation: sb1.result.investigation, checks: sb1.result.checks.map(({ id, ok }) => ({ id, ok })) }
        comparisons.push(row)
        app?.api.emit({ type: 'comparison', ...row })
      }
      for (const ch of sb1.result.checks) console.log(`  ${ch.ok ? c.green + 'ok  ' : c.yellow + 'FAIL'}${c.reset} ${ch.id.padEnd(13)} ${c.dim}${ch.detail}${c.reset}`)
      for (const t of sb1.result.model_trace) console.log(`  ${c.dim}model ${t.task} via ${t.engine} in ${t.ms} ms${t.fallback ? ` (fallback: ${t.fallback})` : ''}${c.reset}`)
      console.log(`  result fields: ${Object.keys(sb1.result).join(', ')}; no history rows, memos or counterparties`)
      console.log(`  categories: ${Object.entries(sb1.result.summary.categories).filter(([, k]) => k > 0).map(([cat, k]) => `${cat} ${k}`).join(', ')}`)
      if (persona && sb1.result.checks.some((c) => !c.ok)) { await declined(persona); return }
    }

    if (bought) {
      await step('Apply: the lender gets K and the chain from the borrower, then verifies on its own; nothing else is disclosed')
      console.log(`  no inflow disclosure: the check node released an income band and check results only`)
      await borrower.applyChecked(offer1, PRINCIPAL, bought, deal!.messages)
    } else if (scored) {
      await step('Apply: the external provider evidence goes to the lender; nothing else is disclosed')
      console.log(`  no inflow disclosure: ${scored.outcome.descriptor.provider} released an income band and check results only`)
      await borrower.applyScored(offer1, PRINCIPAL, scored, deal!.messages)
    } else if (sb1) {
      await step('Approve: the borrower picks what the lender may see')
      for (const d of sb1.result.disclosure_proposal) console.log(`  [x] ${usdt(d.amount).padStart(14)} at ${d.height}  ${d.reason}`)
      const approved1 = await borrower.approve(sb1.result, chooseFor(offer1.lender_pk))
      await borrower.apply(offer1, PRINCIPAL, sb1, approved1, deal?.messages)
    }

    await step(deal ? 'Underwrite: L1 verifies and builds the term sheet; the lender approves it' : 'Underwrite: L1 verifies, prices and accepts')
    // Negotiated: verify and build the sheet, the lender's approval gates, then register and send; each is journaled in turn.
    let checkVerification: ForwardedCheckVerification | undefined
    const uw1 = deal ? await (async () => {
      const proposal = await lender1.proposeTermSheet({ negotiation: { policy: deal.lenderPolicy, maxRounds: deal.maxRounds, makerCheckerAboveMicro: makerChecker }, ...(market ? { checkMarket: market.lender } : {}) })
      checkVerification = proposal.check
      const approvals = await lenderApproval(l1Party.key, deal.lenderPolicy, proposal.sheet, renderTermSheet(proposal.sheet, { audience: 'lender', economics: lender1.economics }), proposal.scored)
      return lender1.sendTermSheet(proposal, approvals)
    })() : await lender1.underwrite()
    for (const ch of uw1.checks) console.log(`  ${ch.ok ? c.green + 'ok' : c.yellow + 'NO'}${c.reset} ${ch.id.padEnd(18)} ${c.dim}${ch.detail}${c.reset}`)
    console.log(`  memo (policy ${uw1.memo.applied_bps} bps): ${uw1.memo.text}`)
    const acc1 = await borrower.awaitAcceptance(offer1, PRINCIPAL, deal ? { agreed: deal.agreed, accept_hash: deal.accept_hash, messages: deal.messages, maker_checker_above_micro: makerChecker, ...(sb1 ? { run_record: sb1.result.run_record } : {}), ...(scored ? { scored: scored.outcome } : {}), ...(bought ? { scored: bought.paid.outcome, check: { commitment: bought.paid.commitment.commitment, operator_pk: bought.paid.offer.operator_pk, receipt_contract_id: bought.receipt?.contract_id ?? null } } : {}) } : undefined)
    const sheet1 = borrower.loans.get(acc1.loan_id)?.termsheet
    if (bought && market) {
      const r = sheet1?.scorer.check_receipt
      if (sheet1?.scorer.evidence?.kind === 'passbook-run-record') console.log(`  term sheet ${acc1.loan_id.slice(0, 12)} binds the check node's run record ${sheet1.scorer.evidence.run_record_sha256} (trust ${sheet1.scorer.trust}${sheet1.scorer.fallback ? ', FALLBACK scorer' : ''}) and names ${r ? `check receipt ${r.contract_id} (commitment ${r.commitment.slice(0, 12)}…, operator ${r.operator_pk.slice(0, 12)}…)` : 'no check receipt'}; consent ${sheet1.consent_hash.slice(0, 12)}…`)
      const record = market.record(bought.pick, bought.paid, checkVerification ?? null, { contract_id: bought.receipt?.contract_id ?? null, status: bought.receipt_status })
      const recordPath = process.env.PASSBOOK_CHECK_MARKET_RECORD ?? DEFAULT_RECORD
      mkdirSync(dirname(recordPath), { recursive: true })
      writeFileSync(recordPath, `${JSON.stringify({ ...record, loan_id: acc1.loan_id }, null, 2)}\n`)
      if (scorerOut) { mkdirSync(scorerOut, { recursive: true }); writeFileSync(join(scorerOut, 'check.json'), `${JSON.stringify({ ...record, loan_id: acc1.loan_id }, null, 2)}\n`) }
    }

    await step('Lock and fund')
    if (gate) await confirm('accept', await acceptInfo(acc1.loan_id, offer1.lender_pk))
    // The phone's accept is the borrower's approval of this exact term sheet; a terminal run approves it (labelled).
    if (deal) {
      await borrower.approveTermSheet(acc1.loan_id)
      if (!gate) console.log(`  ${c.dim}term sheet approved by the terminal run (no dashboard): borrower countersigned ${acc1.loan_id.slice(0, 12)}${c.reset}`)
    }
    const lock1 = await borrower.lockAndSplit(acc1.loan_id)
    const fund1 = await lender1.fund(acc1.loan_id)
    await borrower.awaitFunding(acc1.loan_id)
    await lender1.awaitIou(acc1.loan_id)
    fundedForOffline = true
    if (iouSale) await recorded.call('sell-first-note', async () => {
      const sale = await lender1.iou.offer(acc1.terms, 590 * MICRO_PER_USDT, await chain.getHeight() + 100)
      const listed = (await lender2.iou.sales()).find((s) => s.sale_id === sale.sale_id)
      if (!listed) throw new Error('buyer did not discover the signed note sale on Nostr')
      const [owner] = await Promise.all([lender2.iou.buy(listed), lender1.sellIou(acc1.loan_id, sale)])
      await lender2.acceptIou(acc1.terms, owner)
      await borrower.awaitIouOwner(acc1.loan_id, lender2.pubkey)
      console.log(`  PB-IOU sold over Nostr/RGB; repayment invoice now belongs to ${lender2.pubkey}`)
    })
    if (platformOff) await disablePlatform()
    console.log(`  lock ${lock1.lock_txid}\n  USDT disbursement ${fund1.disbursement_txid}`)
    if ((scored || bought) && scorerOut) {
      const l = borrower.loans.get(acc1.loan_id)!
      writeFileSync(join(scorerOut, 'termsheet.json'), `${JSON.stringify(l.termsheet, null, 2)}\n`)
      writeFileSync(join(scorerOut, 'approvals.json'), `${JSON.stringify([...(l.lender_approvals ?? []), ...(l.borrower_approval ? [l.borrower_approval] : [])], null, 2)}\n`)
      writeFileSync(join(scorerOut, 'funding.json'), `${JSON.stringify({ loan_id: acc1.loan_id, terms_hash: acc1.loan_id, lock_txid: lock1.lock_txid, disbursement_txid: fund1.disbursement_txid, collateral_sats: acc1.terms.collateral_sats, principal: acc1.terms.principal, fee: acc1.terms.fee, height: await chain.getHeight() }, null, 2)}\n`)
    }

    // the dashboard's Margin call button, pressed while the loan is open, turns this run into the margin scenario
    const preWaited = !!gate && scenario === 'standard'
    if (preWaited) await snapshot()
    const prePicked = preWaited
      ? await gate!.wait<StepChoice | undefined>('next', { n: n + 1, title: atomic ? 'Repay over Lightning; release without a co-signer' : 'Repay: USDT back, release co-signed', scenarios: atomic ? [] : ['lender-refuses'], hint: 'or press Margin call first to take the margin path' })
      : undefined
    const marginBranch = await recorded.call('margin-route', async () => scenario === 'standard' && (!app || app.api.isPlatformOnline) && (await platform.loan(acc1.loan_id)).margin_call_height !== undefined)
    if (marginBranch) {
      scenario = 'margin'
      if (gate) gate.scenario = scenario
      app?.api.emit({ type: 'demo', scenario, waiting: null })
    }

    if (scenario !== 'standard') {
      await marginPath({ scenario, loanId: acc1.loan_id, terms: acc1.terms, gated: !preWaited })
    } else {
      const picked = await step(atomic ? 'Repay over Lightning; release without a co-signer' : 'Repay: USDT back, release co-signed', { gated: !preWaited, choices: atomic ? [] : ['lender-refuses'], picked: prePicked })
      const refuses = picked === 'lender-refuses' || process.argv.includes('--lender-refuses')
      if (refuses) console.log(`  ${c.yellow}scenario${c.reset}: lender 1 keeps the USDT, never acknowledges it and refuses to sign the release`)
      await confirm('repay', repayInfo(acc1.loan_id, offer1.lender_pk, acc1.terms))
      const holder = iouSale ? lender2 : lender1
      const { repayment: repay1, release: release1 } = await recorded.call('repay-first', () => repayLoan(acc1.loan_id, holder, refuses))
      if ((scored || bought) && scorerOut) writeFileSync(join(scorerOut, 'repayment.json'), `${JSON.stringify({ loan_id: acc1.loan_id, repayment: repay1, release_txid: release1, height: await chain.getHeight() }, null, 2)}\n`)
      if (refuses) console.log(`  the platform validated the RGB consignment itself and co-signed through leaf C (proof: ${(await platform.loan(acc1.loan_id)).repayment_proof})`)
      const pb1 = await verifyPassbook(borrower.passbookDocument(), chain)
      console.log(`  receipt: ${atomic ? 'Lightning payment hash' : 'RGB repayment'} ${repay1}\n           release      ${release1}`)
      console.log(`  passbook page 1: ${pb1.pages[0].outcome}, verified ${JSON.stringify(pb1.pages[0].verified)}`)
      await settleFees(lender1, 'lender1')

      await step('Ladder: L2 lends at the earned LTV against the same BTC')
      console.log(`  allowed LTV now ${pb1.ladder.allowed_ltv_bps / 100}% (step ${pb1.ladder.step}, ${pb1.ladder.on_time} on time)`)
      const offlineBranch = await recorded.call('offline-verification-route', async () => !!app && !app.api.isPlatformOnline)
      if (app && offlineBranch) {
        const independent = await verifyPassbook(borrower.passbookDocument(), lender2.chain)
        if (independent.unverified || independent.ladder.step !== 1) throw new Error('offline second-lender verification failed')
        console.log(`  platform-off verified locally: ${independent.ladder.allowed_ltv_bps / 100}% LTV; assurance ${independent.assurance.join(',')}`)
        app.api.setPlatformOnline(true)
        console.log('  platform API online for the next origination sandbox and legacy repayment-watch registration')
      }
      await borrower.ask(PRINCIPAL, L2_POLICY.apr_bps)
      await lender2.publishOffer()
      const offer2 = await borrower.findOffer({ lenderPk: lender2.pubkey, principal: PRINCIPAL })
      if (scored) console.log(`  ${c.dim}credit check for this fixed-offer loan: the platform's in-process sandbox (the external provider consent's purpose is a negotiation)${c.reset}`)
      if (bought) console.log(`  ${c.dim}credit check for this fixed-offer loan: the platform's in-process sandbox (a check bought on the market is bound to a negotiation)${c.reset}`)
      const sb2 = await borrower.runSandbox(offer2, PRINCIPAL)
      const approved2 = await borrower.approve(sb2.result, chooseFor(offer2.lender_pk))
      await borrower.apply(offer2, PRINCIPAL, sb2, approved2)
      const uw2 = await lender2.underwrite()
      const acc2 = await borrower.awaitAcceptance(offer2, PRINCIPAL)
      if (gate) await confirm('accept', await acceptInfo(acc2.loan_id, offer2.lender_pk))
      const lock2 = await borrower.lockAndSplit(acc2.loan_id)
      const fund2 = await lender2.fund(acc2.loan_id)
      await borrower.awaitFunding(acc2.loan_id)
      await lender2.awaitIou(acc2.loan_id)
      const lockTx2 = await chain.getTx(lock2.lock_txid)
      console.log(`  second loan at ${uw2.terms.ltv_bps / 100}% LTV, step ${uw2.terms.ladder_step}; lock ${lock2.lock_txid}`)
      console.log(`  lock spends ${lockTx2!.inputs.map((i) => `${i.txid.slice(0, 12)}:${i.vout}`).join(', ')} (the first release is ${release1.slice(0, 12)}:0)`)
      console.log(`  USDT disbursement ${fund2.disbursement_txid}`)

      await step('Outcome: read from the chain and the RGB wallets')
      for (const p of parties) p.rgb.refresh()
      const pb2 = await platform.passbook(borrower.pubkey)
      const btcFree = (await borrower.btcUtxos()).reduce((s, u) => s + u.value, 0)
      console.log(`  borrower: ${usdt(borrowerParty.rgb.balance(assetId).settled)}, ${btc(btcFree)} free, ${btc(acc2.terms.collateral_sats)} locked in escrow ${lock2.lock_txid.slice(0, 12)}:0`)
      const lender1Holding = atomic ? `${usdt(lender1.usdtHeld())} on-chain + ${usdt(debtOf(acc1.terms))} received over Lightning (interest earned ${usdt(acc1.terms.fee)})` : iouSale ? `${usdt(lender1.usdtHeld())} after selling the first note for 590.00 USDT` : `${usdt(lender1.usdtHeld())} with its repayment account (interest earned ${usdt(acc1.terms.fee)})`
      console.log(`  lender1:  ${lender1Holding}`)
      console.log(`  lender2:  ${usdt(l2Party.rgb.balance(assetId).settled)}, owed ${usdt(acc2.terms.principal + acc2.terms.fee)} by height ${acc2.terms.maturity_height}`)
      console.log(`  passbook: ${pb2.pages.length} pages, step ${pb2.ladder.step}, ${pb2.ladder.on_time} on time, ${pb2.unverified} unverified`)
      app?.api.emit({
        type: 'outcome',
        rows: [
          { who: 'borrower', holds: `${usdt(borrowerParty.rgb.balance(assetId).settled)}, ${btc(btcFree)} free, ${btc(acc2.terms.collateral_sats)} in escrow` },
          { who: 'lender1', holds: lender1Holding },
          { who: 'lender2', holds: `${usdt(l2Party.rgb.balance(assetId).settled)}, owed ${usdt(acc2.terms.principal + acc2.terms.fee)} by ${acc2.terms.maturity_height}` },
          { who: 'passbook', holds: `${pb2.pages.length} pages, step ${pb2.ladder.step}, ${pb2.ladder.on_time} on time, ${pb2.unverified} unverified` },
        ],
      })
      await snapshot()
      if (process.argv.includes('--governance')) await (await import('./demo-governance.js')).governanceDemoStep({ step, lender: lender2, borrower, terms: acc2.terms, assetId })
      console.log(`\n${c.green}done${c.reset}: lock with terms hash, USDT-RGB disbursement, ${atomic ? 'RGB Lightning repayment, borrower-only leaf E release' : 'USDT-RGB repayment, co-signed release'}, second lock at ${uw2.terms.ltv_bps / 100}% chained to the first release.`)
    }
  } catch (err) {
    if (!(err instanceof DemoStopped)) {
      failed = true
      send({ type: 'showcase:failed', error: (err as Error).message })
      gate?.stop((err as Error).message)
    }
    if (!gate && !(err instanceof DemoStopped)) throw err
    if (!(err instanceof DemoStopped)) console.error(`\nstopped: ${(err as Error).message}`)
  } finally {
    await market?.stop()
    historyObserver?.close()
    for (const a of [borrower, lender1, lender2, ...(comparison ? [comparison] : [])]) a.close()
    for (const p of [...parties, payer, ...(comparisonParty ? [comparisonParty] : [])]) p.close()
    rl?.close()
    if (app && (!process.argv.includes('--serve') || stopping)) await closeManaged()
  }
  finished = true
  if (stopping) send({ type: 'showcase:interrupted' })
  else if (!failed) { await journal?.markComplete(); send({ type: 'showcase:complete' }) }
  if (stopping) process.exit(0)
  gate?.stop()
  if (app && process.argv.includes('--serve')) console.log(`${c.dim}platform still serving on ${base} (Ctrl-C to stop)${c.reset}`)
}

main().catch((err) => {
  console.error(`\ndemo failed: ${(err as Error).stack ?? err}`)
  process.exit(1)
})
