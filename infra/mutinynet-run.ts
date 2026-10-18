// The Mutinynet public run: one Passbook loan on a public test network, through
// KaleidoSwap's Esplora and RGB proxy (infra/passbook.config.mutinynet.yaml).
//
//   npx tsx infra/mutinynet-run.ts probe      ask every endpoint which chain it serves
//   npx tsx infra/mutinynet-run.ts address    the address the user funds from the faucet
//   npx tsx infra/mutinynet-run.ts status     balances of every wallet in the run
//   npx tsx infra/mutinynet-run.ts run        lock BTC -> fund test USDT -> repay over RGB -> co-signed release
//
// What runs, and where:
//   - borrower and lender: party keys (escrow signers) and RGB wallets (WDK RGB / rgb-lib,
//     network signet = Mutinynet) from seeds under data/mutinynet/wallets (git-ignored);
//   - the platform: the real Platform code in this process (src/server/app.ts), reading
//     Mutinynet through Esplora (src/chain/esplora.ts); its checks are the regtest ones;
//   - the dollar asset: our own NIA test asset "Passbook test USDT (mutinynet, no value)",
//     issued here by the lender. Never presented as USDT.
//   - the price: the platform's configured test price (source "configured"), not a market feed.
// Steps are idempotent and resumable: each records its result in data/mutinynet/run.json
// before the next starts, and a rerun continues from the first unfinished step.
// The summary (every txid with its mutinynet.com link) goes to docs/MUTINYNET-RUN.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as bitcoin from 'bitcoinjs-lib'
import { EsploraChain } from '../src/chain/esplora.js'
import { loadConfig, type PassbookConfig } from '../src/core/config.js'
import { hashObject, keyPairFromSecret, randomHex, signHash, type Hex, type KeyPair } from '../src/core/crypto.js'
import { termInterest } from '../src/core/economics.js'
import { collateralFor, ltvBps, MICRO_PER_USDT } from '../src/core/money.js'
import { explorerAddress, explorerTx, probeNetwork, type NetworkProfile } from '../src/core/network.js'
import { debtOf, type LoanTerms } from '../src/core/terms.js'
import { buildEscrowSpend, buildLock, extractHex, finalizeEscrowSpend, keyPathOutput, partiesOf, releaseOutputs, signKeyPath, signLeaf } from '../src/escrow/escrow.js'
import { RgbWallet } from '../src/rgb/wallet.js'
import { Store } from '../src/registry/store.js'
import { createApp } from '../src/server/app.js'
import { loadSeed, partyKey } from '../src/wallet/party.js'
import { walletModuleVersions } from '../src/server/wallet-routes.js'

const ROOT = resolve(process.env.MUTINYNET_DIR ?? 'data/mutinynet')
const WALLETS = join(ROOT, 'wallets')
const RUN_FILE = join(ROOT, 'run.json')
const STATE_FILE = join(ROOT, 'state.json')
const SUMMARY = resolve(process.env.MUTINYNET_SUMMARY ?? 'docs/MUTINYNET-RUN.json')
const CONFIG = process.env.PASSBOOK_CONFIG ?? 'infra/passbook.config.mutinynet.yaml'

// the loan: small, labelled, and short (Mutinynet mines a block about every 30 s)
const PRINCIPAL = 10 * MICRO_PER_USDT
const INCOME = 1 * MICRO_PER_USDT // the borrower's test income, so it can pay the interest
const APR_BPS = 1000
const TERM_BLOCKS = 60 // demo mapping 1 block = 1 day: a "60-day" loan that matures in about 30 minutes
const GRACE_BLOCKS = 5
const PRICE_CENTS = 10_000_000 // configured test price, $100,000; labelled "configured"
const ASSET = { ticker: 'TUSDT', name: 'Passbook test USDT (mutinynet, no value)', precision: 6, supply: 1_000 * MICRO_PER_USDT }
const LENDER_RGB_SATS = 40_000
const BORROWER_RGB_SATS = 15_000
const DIST_FEE = 400

interface Step { txid?: Hex; at: string; height?: number | null; note?: string; [k: string]: unknown }
/** A transaction the user sent from the faucet to the run address; the split spends every one of them. */
interface Funding { txid: Hex; height: number | null; block_time: number | null }
interface RunState { v: 1; started_at: string; steps: Record<string, Step>; asset_id?: string; loan_id?: Hex; terms?: LoanTerms; platform_pk?: Hex; funding?: Funding[] }

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function readRun(): RunState {
  return existsSync(RUN_FILE) ? (JSON.parse(readFileSync(RUN_FILE, 'utf8')) as RunState) : { v: 1, started_at: new Date().toISOString(), steps: {} }
}
function writeRun(run: RunState): void {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  writeFileSync(`${RUN_FILE}.tmp`, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${RUN_FILE}.tmp`, RUN_FILE)
}

function config(): PassbookConfig {
  const cfg = loadConfig(CONFIG, { checkFiles: false })
  if (cfg.network.name !== 'mutinynet') throw new Error(`${CONFIG} is a ${cfg.network.name} profile; this run is Mutinynet only`)
  return cfg
}

const net = (p: NetworkProfile) => bitcoin.networks[p.addressNetwork]
const addressOf = (script: string, p: NetworkProfile) => bitcoin.address.fromOutputScript(Buffer.from(script, 'hex'), net(p))
const scriptOf = (address: string, p: NetworkProfile) => Buffer.from(bitcoin.address.toOutputScript(address, net(p))).toString('hex')

function platformKey(): KeyPair {
  const file = join(WALLETS, 'platform.secret')
  if (!existsSync(file)) { mkdirSync(WALLETS, { recursive: true, mode: 0o700 }); writeFileSync(file, `${randomHex(32)}\n`, { mode: 0o600 }) }
  return keyPairFromSecret(readFileSync(file, 'utf8').trim())
}

async function parties(p: NetworkProfile) {
  mkdirSync(WALLETS, { recursive: true, mode: 0o700 })
  const rgbCfg = { network: p.rgbNetwork, indexerUrl: p.endpoints.rgb_indexer, transportEndpoint: p.endpoints.rgb_proxy }
  const open = async (role: 'borrower' | 'lender1') => {
    const seed = loadSeed(role, { dir: WALLETS, create: true })
    const key = partyKey(seed)
    const script = keyPathOutput(key.pubkey).script
    return { role, key, script, address: addressOf(script, p), rgb: await RgbWallet.open(seed, join(WALLETS, role, 'rgb'), rgbCfg) }
  }
  return { borrower: await open('borrower'), lender: await open('lender1') }
}

async function waitConfirmed(chain: EsploraChain, txid: Hex, label: string, timeoutMs = 20 * 60_000): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const tx = await chain.getTx(txid).catch(() => null)
    if (tx?.height) { log(`${label} confirmed at height ${tx.height}`); return tx.height }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} ${txid} not confirmed after ${timeoutMs / 60_000} min`)
    await sleep(6000)
  }
}

/** Refresh both RGB wallets until the transfer for `txid` is Settled on both sides (no mining: wait for Mutinynet's blocks). */
async function waitSettled(sender: RgbWallet, receiver: RgbWallet, assetId: string, txid: Hex, label: string, timeoutMs = 20 * 60_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    try { receiver.refresh() } catch (err) { log(`  receiver refresh: ${(err as Error).message}`) }
    try { sender.refresh() } catch (err) { log(`  sender refresh: ${(err as Error).message}`) }
    const sent = sender.transferByTxid(assetId, txid, 'Send')
    const got = receiver.transferByTxid(assetId, txid)
    for (const t of [sent, got]) if (t?.status === 'Failed') throw new Error(`${label}: RGB transfer ${txid} failed (${t.kind})`)
    if (sent?.status === 'Settled' && got?.status === 'Settled') { log(`${label} settled on both sides`); return }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: ${txid} not settled after ${timeoutMs / 60_000} min (sender ${sent?.status ?? 'none'}, receiver ${got?.status ?? 'none'})`)
    await sleep(10_000)
  }
}

async function rgbSend(from: RgbWallet, to: RgbWallet, assetId: string, amount: number, run: RunState, step: string, chain: EsploraChain): Promise<Hex> {
  if (!run.steps[step]?.txid) {
    const invoice = to.invoice(amount, assetId)
    log(`${step}: ${amount / MICRO_PER_USDT} ${ASSET.name} to witness invoice ${invoice.recipientId.slice(0, 32)}…`)
    const sent = await from.send({ invoice: invoice.invoice, assetId, amount, feeRate: 1 })
    run.steps[step] = { txid: sent.txid, at: new Date().toISOString(), amount_micro: amount, recipient_id: invoice.recipientId }
    writeRun(run)
  }
  const txid = run.steps[step].txid!
  await waitSettled(from, to, assetId, txid, step)
  run.steps[step].height = (await chain.getTx(txid))?.height ?? null
  run.steps[step].settled = true
  writeRun(run)
  return txid
}

async function run(cfg: PassbookConfig): Promise<void> {
  const p = cfg.network
  const chain = new EsploraChain(p.endpoints.esplora!)
  const probe = await probeNetwork(p)
  for (const r of probe) log(`probe ${r.endpoint} ${r.url}: ${r.saw}`)
  const runState = readRun()
  const { borrower, lender } = await parties(p)
  const pk = platformKey()
  runState.platform_pk = pk.pubkey
  writeRun(runState)

  // 1. split the faucet coins: the lender's RGB wallet, the borrower's RGB wallet, the rest stays for the collateral
  if (!runState.steps.distribute?.txid) {
    const utxos = (await chain.utxos(borrower.address)).filter((u) => u.status.confirmed)
    const total = utxos.reduce((s, u) => s + u.value, 0)
    const need = LENDER_RGB_SATS + BORROWER_RGB_SATS + DIST_FEE + 30_000
    if (total < need) throw new Error(`fund ${borrower.address} first: ${total} confirmed sats, the run needs at least ${need} (see 'address')`)
    const psbt = new bitcoin.Psbt({ network: net(p) })
    for (const u of utxos) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: Buffer.from(borrower.script, 'hex'), value: BigInt(u.value) }, tapInternalKey: Buffer.from(borrower.key.pubkey, 'hex') })
    psbt.addOutput({ script: Buffer.from(scriptOf(lender.rgb.address(), p), 'hex'), value: BigInt(LENDER_RGB_SATS) })
    psbt.addOutput({ script: Buffer.from(scriptOf(borrower.rgb.address(), p), 'hex'), value: BigInt(BORROWER_RGB_SATS) })
    psbt.addOutput({ script: Buffer.from(borrower.script, 'hex'), value: BigInt(total - LENDER_RGB_SATS - BORROWER_RGB_SATS - DIST_FEE) })
    signKeyPath(psbt, borrower.key.secretKey).finalizeAllInputs()
    const txid = await chain.broadcast(extractHex(psbt))
    runState.steps.distribute = { txid, at: new Date().toISOString(), note: `${LENDER_RGB_SATS} sats to the lender's RGB wallet, ${BORROWER_RGB_SATS} to the borrower's; change stays on the borrower's key for the collateral` }
    writeRun(runState)
    log(`distribute ${txid}`)
  }
  runState.steps.distribute.height = await waitConfirmed(chain, runState.steps.distribute.txid!, 'distribute')
  // every faucet transaction the user sent: one entry each, read from the split's inputs
  if (!runState.funding) {
    const tx = await chain.getTx(runState.steps.distribute.txid!)
    runState.funding = []
    for (const txid of [...new Set(tx!.inputs.map((i) => i.txid))]) {
      const s = await chain.txStatus(txid)
      runState.funding.push({ txid, height: s?.block_height ?? null, block_time: s?.block_time ?? null })
    }
    delete runState.steps.faucet // older run files kept only the first funding transaction here
  }
  writeRun(runState)

  // 2. colored outputs on both RGB wallets (a sender pays the witness output and fee from free colored UTXOs)
  for (const [step, party, num] of [['utxos_lender', lender, 5], ['utxos_borrower', borrower, 3]] as const) {
    if (!runState.steps[step]) {
      party.rgb.refresh()
      const created = await party.rgb.createUtxos(num, 3000)
      runState.steps[step] = { at: new Date().toISOString(), created, note: `${created} colored outputs of 3000 sats in the ${party.role === 'lender1' ? 'lender' : 'borrower'}'s RGB wallet` }
      writeRun(runState)
      log(`${step}: ${created} outputs`)
    }
  }
  // createUtxos returns a count, not a txid: wait until the wallets see their colored balance confirmed
  for (const party of [lender, borrower]) {
    const until = Date.now() + 15 * 60_000
    for (;;) {
      party.rgb.refresh()
      const b = party.rgb.btcBalance()
      if (b.colored.settled > 0) break
      if (Date.now() > until) throw new Error(`${party.role}: colored outputs never confirmed`)
      await sleep(10_000)
    }
  }
  log('colored outputs confirmed on both wallets')
  // createUtxos returns a count: its transactions are the spends of the split's RGB outputs (vout 0 lender, vout 1 borrower)
  const spends = await chain.outspends(runState.steps.distribute.txid!)
  for (const [step, vout] of [['utxos_lender', 0], ['utxos_borrower', 1]] as const) {
    const s = spends[vout]
    if (s?.spent && s.txid && !runState.steps[step].txid) runState.steps[step] = { ...runState.steps[step], txid: s.txid, height: s.status?.block_height ?? null }
  }
  writeRun(runState)

  // 3. our own NIA test asset, issued by the lender, labelled test
  if (!runState.asset_id) {
    runState.asset_id = lender.rgb.issueNia({ ticker: ASSET.ticker, name: ASSET.name, precision: ASSET.precision, amount: ASSET.supply })
    runState.steps.issue = { at: new Date().toISOString(), note: `${ASSET.supply / MICRO_PER_USDT} ${ASSET.ticker} "${ASSET.name}"; NIA issuance commits to a colored output, no transaction of its own`, asset_id: runState.asset_id }
    writeRun(runState)
    writeFileSync(STATE_FILE, `${JSON.stringify({ network: 'mutinynet', asset: { id: runState.asset_id, ticker: ASSET.ticker, name: ASSET.name, precision: ASSET.precision, label: 'test USDT (mutinynet)' } }, null, 2)}\n`)
    log(`issued ${runState.asset_id}`)
  }
  const assetId = runState.asset_id

  // 4. the borrower's test income (so it can pay the interest later)
  await rgbSend(lender.rgb, borrower.rgb, assetId, INCOME, runState, 'income', chain)

  // 5. terms, registered with the platform (the real Platform code, reading Mutinynet through Esplora)
  const app = createApp({ platformKey: pk, store: new Store(join(ROOT, 'passbook.sqlite')), chain, initialPriceCents: PRICE_CENTS, blocksPerMonth: 30, relays: [], deployment: cfg, wallet: null })
  try {
    if (!runState.loan_id) {
      const height = await chain.getHeight()
      const quote = app.oracle.quote(height)
      const fee = termInterest({ principal: PRINCIPAL, apr_bps: APR_BPS, term_blocks: TERM_BLOCKS }, cfg.economics)
      const collateral = collateralFor(PRINCIPAL + fee, 5000, quote.price_cents)
      const terms: LoanTerms = {
        v: 1, borrower_pk: borrower.key.pubkey, lender_pk: lender.key.pubkey, platform_pk: pk.pubkey, asset_id: assetId,
        principal: PRINCIPAL, fee, collateral_sats: collateral, oracle_quote: quote,
        open_height: quote.height, maturity_height: quote.height + TERM_BLOCKS, grace_blocks: GRACE_BLOCKS,
        recovery_height: quote.height + TERM_BLOCKS + GRACE_BLOCKS + 20, ladder_step: 0,
        ltv_bps: ltvBps(PRINCIPAL + fee, collateral, quote.price_cents), prev_passbook_txid: null, nonce: randomHex(32),
      }
      const { loan, verdict } = await app.platform.registerLoan(terms)
      runState.loan_id = loan.id
      runState.terms = terms
      runState.steps.register = { at: new Date().toISOString(), height, loan_id: loan.id, checks: verdict.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}: ${c.detail}`) }
      writeRun(runState)
      log(`registered loan ${loan.id.slice(0, 16)}…: ${PRINCIPAL / MICRO_PER_USDT} + ${fee / MICRO_PER_USDT} test USDT against ${collateral} sats`)
    }
    const terms = runState.terms!
    const loanId = runState.loan_id!

    // 6. lock: the borrower's coins into the escrow, the terms hash in OP_RETURN
    if (!runState.steps.lock?.txid) {
      const utxos = (await chain.utxos(borrower.address)).filter((u) => u.status.confirmed)
      const lock = buildLock({ inputs: utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, internal_pk: borrower.key.pubkey })), terms, changeScript: borrower.script })
      signKeyPath(lock, borrower.key.secretKey).finalizeAllInputs()
      const txid = await chain.broadcast(extractHex(lock))
      runState.steps.lock = { txid, at: new Date().toISOString(), collateral_sats: terms.collateral_sats, escrow_address: addressOf(Buffer.from(lock.txOutputs[0].script).toString('hex'), p) }
      writeRun(runState)
      log(`lock ${txid}`)
    }
    runState.steps.lock.height = await waitConfirmed(chain, runState.steps.lock.txid!, 'lock')
    if (app.store.getLoan(loanId)?.status === 'pending') {
      const rec = await app.platform.recordLock(loanId, runState.steps.lock.txid!)
      runState.steps.lock.platform = `recorded: ${rec.status}`
    }
    writeRun(runState)

    // 7. fund: the lender pays the principal in test USDT over RGB to the borrower's invoice
    const fundTxid = await rgbSend(lender.rgb, borrower.rgb, assetId, terms.principal, runState, 'fund', chain)
    if (app.store.getLoan(loanId)?.status === 'locked') {
      const rec = await app.platform.recordFunded(loanId, fundTxid, signHash(hashObject({ loan_id: loanId, disbursement_txid: fundTxid }), lender.key.secretKey))
      runState.steps.fund.platform = `recorded: ${rec.status}`
      writeRun(runState)
    }

    // 8. repay: principal + interest back over RGB; the lender's rgb-lib validated the consignment and it signs the receipt
    const repayTxid = await rgbSend(borrower.rgb, lender.rgb, assetId, debtOf(terms), runState, 'repay', chain)
    if (!app.store.getLoan(loanId)?.repayment_proof) {
      await app.platform.recordRepaid(loanId, repayTxid, signHash(hashObject({ loan_id: loanId, repayment_txid: repayTxid }), lender.key.secretKey))
      runState.steps.repay.platform = 'recorded: repayment confirmed by the lender (lender_ack)'
      writeRun(runState)
    }

    // 9. release: leaf A, co-signed by borrower and lender, the collateral back to the borrower
    if (!runState.steps.release?.txid) {
      const parties = partiesOf(terms)
      const psbt = buildEscrowSpend({ escrow: { txid: runState.steps.lock.txid!, vout: 0, value: terms.collateral_sats }, parties, leaf: 'A', outputs: releaseOutputs(terms) })
      signLeaf(psbt, parties, 'A', borrower.key.secretKey)
      signLeaf(psbt, parties, 'A', lender.key.secretKey)
      finalizeEscrowSpend(psbt, parties, 'A')
      const txid = await chain.broadcast(extractHex(psbt))
      runState.steps.release = { txid, at: new Date().toISOString(), note: 'leaf A: borrower + lender signatures; pays the collateral minus the fee to the borrower\'s key' }
      writeRun(runState)
      log(`release ${txid}`)
    }
    runState.steps.release.height = await waitConfirmed(chain, runState.steps.release.txid!, 'release')
    if (app.store.getLoan(loanId)?.status === 'open') {
      const rec = await app.platform.recordRelease(loanId, runState.steps.release.txid!)
      runState.steps.release.platform = `recorded: ${rec.status}`
    }
    writeRun(runState)

    // Elapsed time from durable chain data, whatever invocations the run took: from the block that
    // confirmed the last faucet payment to the block that confirmed the release (block header timestamps).
    const funded = Math.max(...runState.funding!.map((f) => f.block_time ?? Number.NaN))
    const released = (await chain.txStatus(runState.steps.release.txid!))?.block_time ?? Number.NaN
    if (!Number.isFinite(funded) || !Number.isFinite(released)) throw new Error('block times missing for the funding or the release transaction')
    const view = await app.platform.passbookView(borrower.key.pubkey)
    const loan = app.store.getLoan(loanId)!
    const summary = {
      title: 'Passbook on Mutinynet: one loan, every transaction public',
      network: { name: p.name, label: p.label, explorer: p.explorer, note: 'Mutinynet is a public signet (30-second blocks). Test coins only: nothing here has value.' },
      endpoints: { esplora: p.endpoints.esplora, rgb_indexer: p.endpoints.rgb_indexer, rgb_proxy: p.endpoints.rgb_proxy },
      probe: probe.map((r) => ({ endpoint: r.endpoint, url: r.url, saw: r.saw })),
      modules: walletModuleVersions(),
      funded_at: new Date(funded * 1000).toISOString(),
      released_at: new Date(released * 1000).toISOString(),
      elapsed_s: released - funded,
      elapsed_note: 'block timestamp of the last faucet payment\'s block to that of the release\'s block (header times, set by the signet block producer); covers every invocation of the driver',
      funding: runState.funding!.map((f) => ({ ...f, explorer: explorerTx(p, f.txid) })),
      asset: { id: assetId, ticker: ASSET.ticker, name: ASSET.name, label: 'test USDT (mutinynet)', issuer: 'the run\'s lender wallet (our own NIA test asset)' },
      price: { cents: PRICE_CENTS, source: 'configured test price, not a market feed' },
      parties: { borrower_pk: borrower.key.pubkey, borrower_address: borrower.address, lender_pk: lender.key.pubkey, platform_pk: pk.pubkey },
      loan: { id: loanId, principal_micro: terms.principal, fee_micro: terms.fee, collateral_sats: terms.collateral_sats, ltv_bps: terms.ltv_bps, open_height: terms.open_height, maturity_height: terms.maturity_height, status: loan.status, repayment_proof: loan.repayment_proof, term_note: '1 block = 1 day demo mapping; Mutinynet blocks are ~30 s' },
      steps: Object.fromEntries(Object.entries(runState.steps).map(([k, s]) => [k, { ...s, ...(s.txid ? { explorer: explorerTx(p, s.txid) } : {}) }])),
      passbook: { pages: view.pages.map((pg) => ({ loan_id: pg.loan_id, status: pg.status, verified: pg.verified })), ladder: view.ladder },
      not_covered: [
        'The platform ran in this process (same Platform code as the server), not as a separate host.',
        'Repayment proof is the lender\'s signed acknowledgement after its own rgb-lib validated the consignment; the platform watch-only validator (rgb_consignment) runs on regtest only in this release.',
        'No Nostr order book, sandbox or negotiation in this run: the terms were set directly by the driver.',
      ],
    }
    mkdirSync(resolve(SUMMARY, '..'), { recursive: true })
    writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`)
    log(`done: loan ${loan.status}, passbook page 1 ${view.pages[0]?.status}; summary in ${SUMMARY}`)
    for (const f of summary.funding) console.log(`  ${'funding'.padEnd(8)} ${f.txid}  ${f.explorer}`)
    for (const [k, s] of Object.entries(summary.steps)) if ((s as Step).txid) console.log(`  ${k.padEnd(8)} ${(s as Step).txid}  ${explorerTx(p, (s as Step).txid!)}`)
    log(`elapsed ${summary.elapsed_s} s by block times (${summary.funded_at} to ${summary.released_at})`)
  } finally {
    await app.close()
    borrower.rgb.close()
    lender.rgb.close()
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status'
  const cfg = config()
  const p = cfg.network
  if (cmd === 'probe') {
    for (const row of await probeNetwork(p)) console.log(`${row.ok ? 'ok ' : 'BAD'} ${row.endpoint.padEnd(12)} ${row.url}  ${row.saw}`)
    return
  }
  if (cmd === 'address') {
    mkdirSync(WALLETS, { recursive: true, mode: 0o700 })
    const key = partyKey(loadSeed('borrower', { dir: WALLETS, create: true }))
    const address = addressOf(keyPathOutput(key.pubkey).script, p)
    console.log(`network   ${p.label} (test coins only)`)
    console.log(`fund this ${address}`)
    console.log(`explorer  ${explorerAddress(p, address)}`)
    return
  }
  if (cmd === 'status') {
    const chain = new EsploraChain(p.endpoints.esplora!)
    const { borrower, lender } = await parties(p)
    const run = readRun()
    try {
      for (const x of [borrower, lender]) {
        const s = await chain.addressStats(x.address)
        try { x.rgb.refresh() } catch { /* offline */ }
        const b = x.rgb.btcBalance()
        console.log(`${x.role.padEnd(9)} key ${x.address}: ${s.confirmed} sats confirmed, ${s.unconfirmed} pending; RGB wallet ${x.rgb.address()}: vanilla ${b.vanilla.settled}, colored ${b.colored.settled}${run.asset_id ? `; test USDT ${x.rgb.balance(run.asset_id).settled / MICRO_PER_USDT}` : ''}`)
      }
      console.log(`steps done: ${Object.keys(run.steps).join(', ') || 'none'}`)
    } finally {
      borrower.rgb.close()
      lender.rgb.close()
    }
    return
  }
  if (cmd === 'run') return run(cfg)
  throw new Error(`unknown command ${cmd}; use probe | address | status | run`)
}

await main().then(() => process.exit(0), (err) => {
  console.error((err as Error).stack ?? (err as Error).message)
  process.exit(1)
})

