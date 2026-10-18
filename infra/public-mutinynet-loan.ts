// The negotiated provider loan in public: offer and negotiation on public Nostr relays,
// the rules credit check, then lock, fund, repay and release on Mutinynet (a public signet).
//
//   npx tsx infra/public-mutinynet-loan.ts status   balances, the run's steps
//   npx tsx infra/public-mutinynet-loan.ts run      resumable; writes docs/PUBLIC-NETWORK-RUN.json
//   npx tsx infra/public-mutinynet-loan.ts record   rewrite the record from the saved run state (no new transactions)
//
// Who does what:
//   - the lender (this process, only the lender's key for the market part): signs its policy, publishes a
//     38388 offer on the public relays and answers the negotiation (src/market/negotiate-nostr.ts);
//   - the borrower (a separate process, `borrower`, only the borrower's key): finds the offer on the public
//     relays, signs its own policy, negotiates, submits its rules credit check, and sends the lender the
//     signed result NIP-44 over the same relays;
//   - the platform: the real Platform code in this process (src/server/app.ts) on Mutinynet through Esplora,
//     with the sandbox in rules mode (RuleReasoner: no model);
//   - the on-chain legs: this process opens both wallets, as Add-on 4's run did (infra/mutinynet-run.ts);
//     the record says so.
// Wallets: Add-on 4's Mutinynet wallets (data/mutinynet, git-ignored). Every public event carries the test
// labels (infra/public-nostr.ts): network mutinynet, a NIP-31 alt "test USDT ... no value", NIP-40 expiry on
// the offer. Mainnet does not exist here: the profile refuses it.

import './public-ws-guard.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as bitcoin from 'bitcoinjs-lib'
import { finalizeEvent, SimplePool, verifyEvent, type Event } from 'nostr-tools'
import { EsploraChain } from '../src/chain/esplora.js'
import { loadConfig, type PassbookConfig } from '../src/core/config.js'
import { hashObject, isHex, keyPairFromSecret, randomHex, signHash, type Hex, type KeyPair } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { explorerTx, probeNetwork, type NetworkProfile } from '../src/core/network.js'
import { debtOf } from '../src/core/terms.js'
import { buildEscrowSpend, buildLock, extractHex, finalizeEscrowSpend, keyPathOutput, partiesOf, releaseOutputs, signKeyPath, signLeaf } from '../src/escrow/escrow.js'
import { KIND, TOPIC } from '../src/market/kinds.js'
import { isOfferPayload, type OfferPayload } from '../src/market/messages.js'
import { DEFAULT_TOLERANCE, type EngineParams, type NegotiationMessage, type Position } from '../src/market/negotiate.js'
import { awaitNegotiation, negotiateAsBorrower, negotiationTerms, negotiationTermsProblems, type NegotiationResult, type NegotiationTerms } from '../src/market/negotiate-nostr.js'
import { signBorrowerPolicy, signLenderPolicy, type LenderPolicy } from '../src/market/policy.js'
import { buildTermSheet, signTermSheet, termSheetHash, type TermSheet } from '../src/market/termsheet.js'
import type { RgbRowLabel } from '../src/networks/rgb.js'
import { RgbWallet } from '../src/rgb/wallet.js'
import { Store } from '../src/registry/store.js'
import { createApp } from '../src/server/app.js'
import { loadSeed, partyKey } from '../src/wallet/party.js'
import { LocalKeySigner } from '../src/wallet/signer.js'
import { DEFAULT_OFFER_TTL_S, isLabelled, labelTags, labelledSigner, parseRelays, PUBLIC_RELAYS, publicTransport, testLabel, type PublishedEvent } from './public-nostr.js'
import { borrowerRulesCheck, lenderVerifiesCheck, type CheckReport, type IncomeStatement } from './public-rules-check.js'

const NETWORK = 'mutinynet'
const ROOT = resolve(process.env.MUTINYNET_DIR ?? 'data/mutinynet')
const WALLETS = join(ROOT, 'wallets')
const OUT = resolve(process.env.PUBLIC_RUN_DIR ?? 'data/public-mutinynet')
const RUN_FILE = join(OUT, 'run.json')
const RECORD = resolve(process.env.PUBLIC_RUN_RECORD ?? 'docs/PUBLIC-NETWORK-RUN.json')
const CONFIG = process.env.PASSBOOK_CONFIG ?? 'infra/passbook.config.mutinynet.yaml'
const RELAYS = parseRelays(process.env.PASSBOOK_PUBLIC_RELAYS ?? PUBLIC_RELAYS.join(','))
/** The sandbox's HTTP port for the borrower process (lane D4's reserved platform port). */
const PLATFORM_PORT = Number(process.env.PUBLIC_PLATFORM_PORT ?? 4391)

// the loan: small and short (Mutinynet mines a block about every 30 s; 1 block = 1 demo day). 2 test USDT, so the
// borrower's own balance passes the sandbox's affordability check honestly (the lender's policy requires it)
const PRINCIPAL = 2 * MICRO_PER_USDT
const INCOME = 2 * MICRO_PER_USDT // the test payer's income payment to the borrower
const PAYER_FUNDS = 5 * MICRO_PER_USDT // the lender's (the asset issuer's) wallet funds the test payer
const PAYER_SATS = 14_000
const TERM_BLOCKS = 60
const GRACE_BLOCKS = 5
const PRICE_CENTS = 10_000_000 // the platform's configured test price, $100,000, labelled "configured"
const OFFER_D = 'mutinynet-public-1'
const PARAMS = (cfg: PassbookConfig): EngineParams => ({ max_rounds: 3, concession_bps: 2500, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: ['cosign-rgb'], economics: cfg.economics })

interface Step { txid?: Hex; at: string; height?: number | null; note?: string; [k: string]: unknown }
interface RunState {
  v: 1; started_at: string; steps: Record<string, Step>
  offer?: { event_id: Hex; created_at: number; expiration: number; payload: OfferPayload; policy_hash: Hex; accepted_by: string[]; refused_by: PublishedEvent['refused_by'] }
  negotiation?: { negotiation_id: Hex; agreed: Position; accept_hash: Hex; messages: NegotiationMessage[]; lender_events: PublishedEvent[]; borrower_events: PublishedEvent[]; started_at: string; agreed_at: string; borrower_pid: number }
  check?: CheckReport
  income?: IncomeStatement & { payer_rgb_address: string }
  borrower_side?: { part_event_id: Hex; checks: { id: string; ok: boolean; detail: string }[] }
  sheet?: TermSheet; loan_id?: Hex; platform_pk?: Hex
  /** Earlier market attempts whose check did not pass the lender's verification (kept for the record). */
  attempts?: { offer?: RunState['offer']; negotiation?: RunState['negotiation']; check: CheckReport; failed: string }[]
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function readRun(): RunState { return existsSync(RUN_FILE) ? (JSON.parse(readFileSync(RUN_FILE, 'utf8')) as RunState) : { v: 1, started_at: new Date().toISOString(), steps: {} } }
function writeRun(run: RunState): void {
  mkdirSync(OUT, { recursive: true, mode: 0o700 })
  writeFileSync(`${RUN_FILE}.tmp`, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${RUN_FILE}.tmp`, RUN_FILE)
}

function config(): PassbookConfig {
  const cfg = loadConfig(CONFIG, { checkFiles: false })
  if (cfg.network.name !== NETWORK) throw new Error(`${CONFIG} is a ${cfg.network.name} profile; this run is Mutinynet only`)
  return cfg
}

/** Add-on 4's test asset on Mutinynet ("Passbook test USDT (mutinynet, no value)"). */
function assetId(): string {
  const s = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8')) as { network: string; asset: { id: string } }
  if (s.network !== NETWORK) throw new Error('data/mutinynet/state.json is not the Mutinynet asset')
  return s.asset.id
}

const net = (p: NetworkProfile) => bitcoin.networks[p.addressNetwork]
const addressOf = (script: string, p: NetworkProfile) => bitcoin.address.fromOutputScript(Buffer.from(script, 'hex'), net(p))
const keyOf = (role: 'borrower' | 'lender1' | 'payer') => partyKey(loadSeed(role, { dir: WALLETS, create: false }))
const platformKey = () => keyPairFromSecret(readFileSync(join(WALLETS, 'platform.secret'), 'utf8').trim())
const rgbOf = (role: 'borrower' | 'lender1' | 'payer', p: NetworkProfile) => RgbWallet.open(loadSeed(role, { dir: WALLETS, create: false }), join(WALLETS, role, 'rgb'), { network: p.rgbNetwork, indexerUrl: p.endpoints.rgb_indexer, transportEndpoint: p.endpoints.rgb_proxy })

// ---- the market part: offer and negotiation on public relays ----

export async function lenderPolicy(key: KeyPair, asset: string, nowSec: number): Promise<LenderPolicy> {
  return signLenderPolicy(new LocalKeySigner(key), {
    asset_id: asset, max_per_loan: 20 * MICRO_PER_USDT, max_outstanding: 40 * MICRO_PER_USDT, min_apr_bps: 900, max_ltv_bps: 5000,
    term_blocks: { min: TERM_BLOCKS, max: TERM_BLOCKS }, required_checks: ['inflows'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'],
    approval_rules: { approvers: [key.pubkey], maker_checker_above: 20 * MICRO_PER_USDT }, issued_at: nowSec,
  })
}

/** The 38388 offer: OfferPayload plus `test_note` (isOfferPayload ignores extra fields), labelled, expiring. */
export function offerEvent(key: KeyPair, payload: OfferPayload, nowSec: number, ttlSec = DEFAULT_OFFER_TTL_S): Event {
  const content = JSON.stringify({ ...payload, test_note: testLabel(NETWORK) })
  const tags = labelTags([['t', TOPIC], ['d', OFFER_D], ['expiration', String(nowSec + ttlSec)]], NETWORK)
  return finalizeEvent({ kind: KIND.OFFER, created_at: nowSec, tags, content }, key.secretKey)
}

/** The newest labelled, authentic Mutinynet offer by this lender with valid negotiation terms. */
export function pickOffer(events: Event[], lenderPk: Hex, asset: string): { event: Event; payload: OfferPayload; terms: NegotiationTerms } | null {
  const ok = events
    .filter((e) => e.kind === KIND.OFFER && e.pubkey === lenderPk && e.tags.some((t) => t[0] === 'network' && t[1] === NETWORK))
    .map((e) => { try { return { event: e, payload: JSON.parse(e.content) as OfferPayload } } catch { return null } })
    .filter((x): x is { event: Event; payload: OfferPayload } => !!x && isOfferPayload(x.payload) && x.payload.asset_id === asset && !!x.payload.negotiation && !negotiationTermsProblems(x.payload.negotiation).length && x.payload.negotiation.lender_pk === lenderPk)
    .sort((a, b) => b.event.created_at - a.event.created_at)
  return ok.length ? { ...ok[0], terms: ok[0].payload.negotiation! } : null
}

const transcriptLine = (m: NegotiationMessage, d: string) => {
  const pos = m.body.position as Position | undefined
  return `${d.padEnd(8)} seq ${m.seq} ${m.type}${pos ? ` ${pos.apr_bps / 100}% APR, LTV ${pos.ltv_bps / 100}%, ${pos.principal / MICRO_PER_USDT} test USDT, ${pos.term_blocks} blocks` : ` ${String(m.body.reason ?? '')}`}`
}

/** The borrower's own labels for its earlier Mutinynet transfers (Add-on 4's loan), as its wallet records them. */
function addon4Labels(lenderPk: Hex): Record<Hex, RgbRowLabel> {
  const f = join(ROOT, 'run.json')
  if (!existsSync(f)) return {}
  const steps = (JSON.parse(readFileSync(f, 'utf8')) as { steps: Record<string, { txid?: Hex }> }).steps
  const labels: Record<Hex, RgbRowLabel> = {}
  if (steps.income?.txid) labels[steps.income.txid] = { counterparty_pk: lenderPk, memo: 'stipend (test income, Add-on 4 run)' }
  if (steps.fund?.txid) labels[steps.fund.txid] = { counterparty_pk: lenderPk, memo: 'loan disbursement (Add-on 4 loan)' }
  if (steps.repay?.txid) labels[steps.repay.txid] = { counterparty_pk: lenderPk, memo: 'loan repayment (Add-on 4 loan)' }
  return labels
}

/** The borrower process: only the borrower's key and wallet. Writes its side of the market part to `out`. */
async function borrowerProcess(lenderPk: Hex, allowedLtv: number, sandboxUrl: string, out: string): Promise<void> {
  const cfg = config()
  const key = keyOf('borrower')
  const asset = assetId()
  const income = JSON.parse(readFileSync(join(OUT, 'income.json'), 'utf8')) as IncomeStatement
  const pool = new SimplePool()
  const published: PublishedEvent[] = []
  const transport = publicTransport(pool, RELAYS, NETWORK, { log: published })
  const rgb = await rgbOf('borrower', cfg.network)
  try {
    const events = await pool.querySync(RELAYS, { kinds: [KIND.OFFER], authors: [lenderPk], '#t': [TOPIC] }, { maxWait: 6000 })
    const offer = pickOffer(events as Event[], lenderPk, asset)
    if (!offer) throw new Error(`no labelled Mutinynet offer from ${lenderPk.slice(0, 12)}… with negotiation terms on ${RELAYS.join(', ')}`)
    log(`borrower: offer ${offer.event.id.slice(0, 12)}… read from the public relays`)
    const policy = await signBorrowerPolicy(new LocalKeySigner(key), {
      asset_id: asset, principal: { min: PRINCIPAL, max: PRINCIPAL }, max_apr_bps: 1500, max_ltv_bps: allowedLtv,
      term_blocks: { min: TERM_BLOCKS, max: TERM_BLOCKS }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: Math.floor(Date.now() / 1000),
    })
    const deal = await negotiateAsBorrower({ transport, signer: labelledSigner(key, NETWORK), policy, terms: offer.terms, params: PARAMS(cfg), timeoutMs: 90_000, onMessage: (m, d) => log(`borrower: ${transcriptLine(m, d)}`) })
    if (!('agreed' in deal.outcome) || !deal.verified.ok) throw new Error(`no deal: ${JSON.stringify(deal.outcome)} ${deal.problems.join('; ')}`)
    const check = await borrowerRulesCheck({ key, lenderPk, sandboxUrl, offer: offer.payload, offerId: `${lenderPk}:${OFFER_D}`, negotiationId: deal.negotiation_id, agreed: deal.outcome.agreed, transport, network: NETWORK, cfg, rgb, income, labels: addon4Labels(lenderPk), allowedLtv, log })
    writeFileSync(out, `${JSON.stringify({ offer_event_id: offer.event.id, negotiation_id: deal.negotiation_id, outcome: deal.outcome, verified: deal.verified, messages: deal.messages, published, check }, null, 2)}\n`, { mode: 0o600 })
  } finally { rgb.close(); pool.close(RELAYS) }
}

/**
 * The borrower's income for the check, paid on Mutinynet by a separate test payer (its own key and wallet), so the
 * payer is not the lender: the lender's wallet (the asset's issuer) funds the payer, the payer pays the borrower and
 * signs { txid, amount, borrower_pk } (src/wallet/income.ts). The BTC for the payer's RGB wallet comes from the
 * borrower key's change, never from the previous page's release output (the next lock spends that one).
 */
async function payIncome(p: NetworkProfile, chain: EsploraChain, state: RunState, prevClose: Hex | null): Promise<void> {
  const borrower = keyOf('borrower')
  const payerKey = partyKey(loadSeed('payer', { dir: WALLETS, create: true }))
  const payer = await rgbOf('payer', p)
  const lenderRgb = await rgbOf('lender1', p)
  const borrowerRgb = await rgbOf('borrower', p)
  const asset = assetId()
  try {
    if (!state.steps.payer_btc?.txid) {
      const bScript = keyPathOutput(borrower.pubkey).script
      const utxo = (await chain.utxos(addressOf(bScript, p))).filter((u) => u.status.confirmed && u.txid !== prevClose).sort((a, b) => b.value - a.value)[0]
      if (!utxo || utxo.value < PAYER_SATS + 2000) throw new Error('the borrower key has no spare confirmed output for the test payer')
      const psbt = new bitcoin.Psbt({ network: net(p) })
      psbt.addInput({ hash: utxo.txid, index: utxo.vout, witnessUtxo: { script: Buffer.from(bScript, 'hex'), value: BigInt(utxo.value) }, tapInternalKey: Buffer.from(borrower.pubkey, 'hex') })
      psbt.addOutput({ script: Buffer.from(bitcoin.address.toOutputScript(payer.address(), net(p))), value: BigInt(PAYER_SATS) })
      psbt.addOutput({ script: Buffer.from(bScript, 'hex'), value: BigInt(utxo.value - PAYER_SATS - 300) })
      signKeyPath(psbt, borrower.secretKey).finalizeAllInputs()
      const txid = await chain.broadcast(extractHex(psbt))
      state.steps.payer_btc = { txid, at: new Date().toISOString(), note: `${PAYER_SATS} sats from the borrower key's change to the test payer's RGB wallet (for its colored outputs and fees)` }
      writeRun(state)
      log(`payer_btc ${txid}`)
    }
    state.steps.payer_btc.height = await waitConfirmed(chain, state.steps.payer_btc.txid!, 'payer_btc')
    if (!state.steps.payer_utxos) {
      payer.refresh()
      const created = await payer.createUtxos(3, 3000)
      state.steps.payer_utxos = { at: new Date().toISOString(), created, note: `${created} colored outputs of 3000 sats in the test payer's RGB wallet` }
      writeRun(state)
    }
    for (const until = Date.now() + 15 * 60_000; ;) {
      payer.refresh()
      if (payer.btcBalance().colored.settled > 0) break
      if (Date.now() > until) throw new Error('the payer\'s colored outputs never confirmed')
      await sleep(10_000)
    }
    const spends = await chain.outspends(state.steps.payer_btc.txid!)
    if (spends[0]?.spent && spends[0].txid && !state.steps.payer_utxos.txid) { state.steps.payer_utxos = { ...state.steps.payer_utxos, txid: spends[0].txid, height: spends[0].status?.block_height ?? null }; writeRun(state) }
    await rgbSend(lenderRgb, payer, asset, PAYER_FUNDS, state, 'payer_funding', chain)
    const txid = await rgbSend(payer, borrowerRgb, asset, INCOME, state, 'income', chain)
    const height = (await chain.getTx(txid))?.height
    if (!height) throw new Error('the income transfer is not confirmed')
    const statement: IncomeStatement = { txid, height, amount: INCOME, payer_pk: payerKey.pubkey, payer_sig: signHash(hashObject({ txid, amount: INCOME, borrower_pk: borrower.pubkey }), payerKey.secretKey), memo: 'stipend (test income from the test payer)' }
    state.income = { ...statement, payer_rgb_address: payer.address() }
    writeRun(state)
    writeFileSync(join(OUT, 'income.json'), `${JSON.stringify(statement, null, 2)}\n`, { mode: 0o600 })
    log(`income ${txid}: ${INCOME / MICRO_PER_USDT} test USDT from the test payer ${payerKey.pubkey.slice(0, 12)}…, signed statement saved for the borrower`)
  } finally { payer.close(); lenderRgb.close(); borrowerRgb.close() }
}

// ---- the on-chain legs ----

async function waitConfirmed(chain: EsploraChain, txid: Hex, label: string, timeoutMs = 20 * 60_000): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const tx = await chain.getTx(txid).catch(() => null)
    if (tx?.height) { log(`${label} confirmed at height ${tx.height}`); return tx.height }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} ${txid} not confirmed after ${timeoutMs / 60_000} min`)
    await sleep(6000)
  }
}

async function waitSettled(sender: RgbWallet, receiver: RgbWallet, asset: string, txid: Hex, label: string, timeoutMs = 25 * 60_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    try { receiver.refresh() } catch (err) { log(`  receiver refresh: ${(err as Error).message}`) }
    try { sender.refresh() } catch (err) { log(`  sender refresh: ${(err as Error).message}`) }
    const sent = sender.transferByTxid(asset, txid, 'Send')
    const got = receiver.transferByTxid(asset, txid)
    for (const t of [sent, got]) if (t?.status === 'Failed') throw new Error(`${label}: RGB transfer ${txid} failed (${t.kind})`)
    if (sent?.status === 'Settled' && got?.status === 'Settled') { log(`${label} settled on both sides`); return }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: ${txid} not settled after ${timeoutMs / 60_000} min (sender ${sent?.status ?? 'none'}, receiver ${got?.status ?? 'none'})`)
    await sleep(10_000)
  }
}

async function rgbSend(from: RgbWallet, to: RgbWallet, asset: string, amount: number, run: RunState, step: string, chain: EsploraChain): Promise<Hex> {
  if (!run.steps[step]?.txid) {
    const invoice = to.invoice(amount, asset)
    log(`${step}: ${amount / MICRO_PER_USDT} test USDT (mutinynet) to witness invoice ${invoice.recipientId.slice(0, 32)}…`)
    const sent = await from.send({ invoice: invoice.invoice, assetId: asset, amount, feeRate: 1 })
    run.steps[step] = { txid: sent.txid, at: new Date().toISOString(), amount_micro: amount, recipient_id: invoice.recipientId }
    writeRun(run)
  }
  const txid = run.steps[step].txid!
  await waitSettled(from, to, asset, txid, step)
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
  if (probe.some((r) => !r.ok)) throw new Error('an endpoint does not answer as Mutinynet')
  const state = readRun()
  // the sandbox's signed run records go next to this run's state (git-ignored), not into the shared data/sandbox-runs
  process.env.PASSBOOK_RUN_DIR ??= join(OUT, 'sandbox-runs')
  const asset = assetId()
  const lender = keyOf('lender1')
  const borrowerPk = keyOf('borrower').pubkey
  const pk = platformKey()
  state.platform_pk = pk.pubkey
  writeRun(state)
  const app = createApp({ platformKey: pk, store: new Store(join(ROOT, 'passbook.sqlite')), chain, initialPriceCents: PRICE_CENTS, blocksPerMonth: 30, relays: [], deployment: cfg, wallet: null })
  // the sandbox's two routes for the borrower process, on loopback only (no auth configured: nothing else listens here)
  await app.api.listen(PLATFORM_PORT, '127.0.0.1')
  try {
    const passbook = await app.platform.passbookView(borrowerPk)
    log(`borrower passbook: ladder step ${passbook.ladder.step}, allowed LTV ${passbook.ladder.allowed_ltv_bps / 100}%, ${passbook.pages.length} page(s)`)

    // 1. the borrower's income from a separate test payer, then offer + negotiation + check on the public relays
    const prevClose = [...passbook.pages].reverse().find((pg) => pg.verified.close && pg.close_txid)?.close_txid ?? null
    if (!state.income) await payIncome(p, chain, state, prevClose)
    // a check that did not pass the lender's verification is never underwritten: start the market part afresh
    if (state.check && !state.check.passed && !state.sheet) {
      state.attempts = [...(state.attempts ?? []), { offer: state.offer, negotiation: state.negotiation, check: { ...state.check, part: undefined }, failed: state.check.problems.join('; ') }]
      delete state.check; delete state.negotiation; delete state.offer; delete state.borrower_side
      writeRun(state)
      log('the last check did not pass the lender\'s verification: new offer, new negotiation, new check')
    }
    if (!state.check) {
      const nowSec = Math.floor(Date.now() / 1000)
      const policy = await lenderPolicy(lender, asset, nowSec)
      const height = await chain.getHeight()
      const payload: OfferPayload = {
        asset_id: asset, min: PRINCIPAL, max: 20 * MICRO_PER_USDT, apr_bps: 1200, term_blocks: TERM_BLOCKS, grace_blocks: GRACE_BLOCKS, ltv_ladder_bps: [5000],
        requirements: { income_evidence: 'payer_signatures', reconciliation: 'optional', investigation: 'optional', affordability: true, inflow_months: 0, inflow_multiple_bps: 900 },
        expires_height: height + 240, negotiation: negotiationTerms(policy, { max_rounds: 3, min_principal: PRINCIPAL }),
      }
      const pool = new SimplePool()
      const lenderEvents: PublishedEvent[] = []
      const transport = publicTransport(pool, RELAYS, NETWORK, { log: lenderEvents })
      try {
        const ev = offerEvent(lender, payload, nowSec)
        await transport.publish(ev as Parameters<typeof transport.publish>[0])
        const row = lenderEvents.find((e) => e.id === ev.id)!
        state.offer = { event_id: ev.id, created_at: ev.created_at, expiration: nowSec + DEFAULT_OFFER_TTL_S, payload, policy_hash: hashObject(policy), accepted_by: row.accepted_by, refused_by: row.refused_by }
        writeRun(state)
        log(`offer ${ev.id} on ${row.accepted_by.join(', ')}`)
        const startedAt = new Date().toISOString()
        const dealP = awaitNegotiation({ transport, policy, params: PARAMS(cfg), signer: () => labelledSigner(lender, NETWORK), min_principal: payload.min, waitMs: 240_000, timeoutMs: 90_000, onMessage: (m, d) => log(`lender:   ${transcriptLine(m, d)}`) })
        await sleep(2000)
        const out = join(OUT, 'borrower.json')
        const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'borrower', '--lender-pk', lender.pubkey, '--allowed-ltv', String(passbook.ladder.allowed_ltv_bps), '--sandbox', `http://127.0.0.1:${PLATFORM_PORT}`, '--out', out], { stdio: 'inherit', env: process.env })
        const exited = new Promise<number>((r) => child.on('exit', (code) => r(code ?? 1)))
        const deal: NegotiationResult = await Promise.race([dealP, exited.then((code) => { throw new Error(`the borrower process exited (${code}) before an agreement`) })])
        if (!('agreed' in deal.outcome) || !deal.verified.ok || deal.counterparty_pk !== borrowerPk) throw new Error(`no verified deal with the run's borrower: ${JSON.stringify(deal.outcome)}`)
        const agreedAt = new Date().toISOString()
        // the borrower's check result arrives NIP-44 over the same relays; the lender verifies it on its own
        const check = await lenderVerifiesCheck({ key: lender, borrowerPk, negotiationId: deal.negotiation_id, offerId: `${lender.pubkey}:${OFFER_D}`, agreed: deal.outcome.agreed, offer: payload, transport, platform: app.platform, platformPk: pk.pubkey, oraclePk: app.oracle.pubkey, cfg, chain, timeoutMs: 300_000, log })
        if ((await exited) !== 0) throw new Error('the borrower process failed')
        const b = JSON.parse(readFileSync(out, 'utf8')) as { negotiation_id: Hex; published: PublishedEvent[]; offer_event_id: Hex; check: { part_event_id: Hex; checks: { id: string; ok: boolean; detail: string }[] } }
        if (b.negotiation_id !== deal.negotiation_id || b.offer_event_id !== ev.id) throw new Error('the borrower process reports another negotiation or offer')
        state.negotiation = { negotiation_id: deal.negotiation_id, agreed: deal.outcome.agreed, accept_hash: deal.verified.accept_hash!, messages: deal.messages, lender_events: lenderEvents.filter((e) => e.id !== ev.id), borrower_events: b.published, started_at: startedAt, agreed_at: agreedAt, borrower_pid: child.pid ?? 0 }
        state.borrower_side = { part_event_id: b.check.part_event_id, checks: b.check.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })) }
        state.check = check
        writeRun(state)
        if (!check.lender_verified || !check.passed) throw new Error(`the rules check did not pass the lender's verification: ${check.problems.join('; ')}`)
      } finally { pool.close(RELAYS) }
    }
    const neg = state.negotiation!
    const check = state.check!

    // 2. the term sheet: follows the agreement exactly; its terms hash (the lock's OP_RETURN) commits the
    //    negotiation's accept hash, the check's run-record digest and the consent hash
    const borrowerRgb = await rgbOf('borrower', p)
    const lenderRgb = await rgbOf('lender1', p)
    const borrower = keyOf('borrower')
    try {
      if (!state.sheet) {
        const passbook = await app.platform.passbookView(borrower.pubkey)
        const lastClose = [...passbook.pages].reverse().find((pg) => pg.verified.close && pg.close_txid)?.close_txid ?? null
        const quote = app.oracle.quote(await chain.getHeight())
        let sheet = buildTermSheet({
          agreed: neg.agreed, negotiation: { id: neg.negotiation_id, accept_hash: neg.accept_hash }, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: pk.pubkey,
          asset_id: asset, oracle_quote: quote, grace_blocks: GRACE_BLOCKS, ladder_step: passbook.ladder.step, prev_passbook_txid: lastClose, economics: cfg.economics,
          settlement: { kind: 'cosign-rgb' }, scorer: check.termsheet_scorer, consent_hash: check.consent_hash, salt: randomHex(32),
        })
        sheet = signTermSheet(signTermSheet(sheet, 'lender', lender.secretKey), 'borrower', borrower.secretKey)
        const { loan, verdict } = await app.platform.registerLoan(sheet.terms)
        state.sheet = sheet
        state.loan_id = loan.id
        state.steps.register = { at: new Date().toISOString(), loan_id: loan.id, checks: verdict.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}: ${c.detail}`) }
        writeRun(state)
        log(`registered ${loan.id.slice(0, 16)}… = termSheetHash: ${sheet.terms.principal / MICRO_PER_USDT} + ${sheet.terms.fee / MICRO_PER_USDT} test USDT at ${sheet.apr_bps / 100}% APR against ${sheet.terms.collateral_sats} sats (LTV ${sheet.terms.ltv_bps / 100}%)`)
      }
      const sheet = state.sheet
      const terms = sheet.terms
      const loanId = state.loan_id!
      if (termSheetHash(sheet) !== loanId) throw new Error('the saved term sheet does not hash to the loan id')

      // 3. lock: the borrower's coins (the previous page's release output first) into the escrow, terms hash in OP_RETURN
      const bScript = keyPathOutput(borrower.pubkey).script
      if (!state.steps.lock?.txid) {
        const utxos = (await chain.utxos(addressOf(bScript, p))).filter((u) => u.status.confirmed)
        const prev = terms.prev_passbook_txid
        const ordered = [...utxos.filter((u) => u.txid === prev), ...utxos.filter((u) => u.txid !== prev).sort((a, b) => b.value - a.value)]
        if (prev && ordered[0]?.txid !== prev) throw new Error(`the previous release output ${prev} is not unspent on the borrower's key`)
        const inputs = []
        for (const u of ordered) { inputs.push({ txid: u.txid, vout: u.vout, value: u.value, internal_pk: borrower.pubkey }); if (inputs.reduce((s, x) => s + x.value, 0) >= terms.collateral_sats + 1000) break }
        const lock = buildLock({ inputs, terms, changeScript: bScript })
        signKeyPath(lock, borrower.secretKey).finalizeAllInputs()
        const txid = await chain.broadcast(extractHex(lock))
        state.steps.lock = { txid, at: new Date().toISOString(), collateral_sats: terms.collateral_sats, escrow_address: addressOf(Buffer.from(lock.txOutputs[0].script).toString('hex'), p), chained_to: prev }
        writeRun(state)
        log(`lock ${txid}`)
      }
      state.steps.lock.height = await waitConfirmed(chain, state.steps.lock.txid!, 'lock')
      if (app.store.getLoan(loanId)?.status === 'pending') state.steps.lock.platform = `recorded: ${(await app.platform.recordLock(loanId, state.steps.lock.txid!)).status}`
      writeRun(state)

      // 4. fund: the lender pays the principal in test USDT over RGB
      const fundTxid = await rgbSend(lenderRgb, borrowerRgb, asset, terms.principal, state, 'fund', chain)
      if (app.store.getLoan(loanId)?.status === 'locked') {
        state.steps.fund.platform = `recorded: ${(await app.platform.recordFunded(loanId, fundTxid, signHash(hashObject({ loan_id: loanId, disbursement_txid: fundTxid }), lender.secretKey))).status}`
        writeRun(state)
      }

      // 5. repay: principal + the negotiated interest back over RGB; the lender acknowledges after its rgb-lib validated it
      const repayTxid = await rgbSend(borrowerRgb, lenderRgb, asset, debtOf(terms), state, 'repay', chain)
      if (!app.store.getLoan(loanId)?.repayment_proof) {
        await app.platform.recordRepaid(loanId, repayTxid, signHash(hashObject({ loan_id: loanId, repayment_txid: repayTxid }), lender.secretKey))
        state.steps.repay.platform = 'recorded: repayment confirmed by the lender (lender_ack)'
        writeRun(state)
      }

      // 6. release: leaf A, co-signed by borrower and lender, the collateral back to the borrower
      if (!state.steps.release?.txid) {
        const parties = partiesOf(terms)
        const psbt = buildEscrowSpend({ escrow: { txid: state.steps.lock.txid!, vout: 0, value: terms.collateral_sats }, parties, leaf: 'A', outputs: releaseOutputs(terms) })
        signLeaf(psbt, parties, 'A', borrower.secretKey)
        signLeaf(psbt, parties, 'A', lender.secretKey)
        finalizeEscrowSpend(psbt, parties, 'A')
        const txid = await chain.broadcast(extractHex(psbt))
        state.steps.release = { txid, at: new Date().toISOString(), note: 'leaf A: borrower + lender signatures; the collateral minus the fee back to the borrower\'s key' }
        writeRun(state)
        log(`release ${txid}`)
      }
      state.steps.release.height = await waitConfirmed(chain, state.steps.release.txid!, 'release')
      if (app.store.getLoan(loanId)?.status === 'open') state.steps.release.platform = `recorded: ${(await app.platform.recordRelease(loanId, state.steps.release.txid!)).status}`
      writeRun(state)
      await writeRecord(cfg, app, chain, state, probe)
    } finally {
      borrowerRgb.close()
      lenderRgb.close()
    }
  } finally {
    await app.close()
  }
}

// ---- the record ----

/**
 * Re-read what the record claims from sources the driver did not use: the transactions from mutinynet.com's own
 * API (not KaleidoSwap's Esplora), and every public event by id from each relay.
 */
async function independentCheck(state: RunState, eventIds: string[]): Promise<Record<string, unknown>> {
  const api = 'https://mutinynet.com/api'
  const tx = async (txid: string) => { const r = await fetch(`${api}/tx/${txid}`, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${api}/tx/${txid}: ${r.status}`); return (await r.json()) as { status: { confirmed: boolean; block_height?: number }; vin: { txid: string; vout: number }[]; vout: { scriptpubkey: string; scriptpubkey_type: string; scriptpubkey_address?: string; value: number }[] } }
  const lock = await tx(state.steps.lock!.txid!)
  const release = await tx(state.steps.release!.txid!)
  const opReturn = lock.vout.find((o) => o.scriptpubkey_type === 'op_return')?.scriptpubkey.slice(4) ?? null
  const borrowerAddress = addressOf(keyPathOutput(state.sheet!.terms.borrower_pk).script, config().network)
  const pool = new SimplePool()
  const relays: Record<string, { found: number; labelled_and_valid: number; of: number }> = {}
  try {
    for (const r of RELAYS) {
      const got = (await pool.querySync([r], { ids: eventIds }, { maxWait: 6000 })) as Event[]
      relays[r] = { found: got.length, labelled_and_valid: got.filter((e) => verifyEvent(e) && isLabelled(e, NETWORK)).length, of: eventIds.length }
    }
  } finally { pool.close(RELAYS) }
  return {
    at: new Date().toISOString(), source: `${api} and each relay, by id`,
    lock: { confirmed: lock.status.confirmed, height: lock.status.block_height, op_return_is_loan_id: opReturn === state.loan_id, spends_previous_page: lock.vin.some((i) => i.txid === state.sheet!.terms.prev_passbook_txid), collateral_output_sats: lock.vout[0]?.value },
    release: { confirmed: release.status.confirmed, height: release.status.block_height, spends_lock: release.vin.some((i) => i.txid === state.steps.lock!.txid && i.vout === 0), pays_borrower_sats: release.vout.filter((o) => o.scriptpubkey_address === borrowerAddress).reduce((a, o) => a + o.value, 0) },
    relays,
  }
}

async function writeRecord(cfg: PassbookConfig, app: ReturnType<typeof createApp>, chain: EsploraChain, state: RunState, probe: Awaited<ReturnType<typeof probeNetwork>>): Promise<void> {
  const p = cfg.network
  const sheet = state.sheet!
  const neg = state.negotiation!
  const loan = app.store.getLoan(state.loan_id!)!
  const view = await app.platform.passbookView(sheet.terms.borrower_pk)
  const time = async (txid?: Hex) => (txid ? (await chain.txStatus(txid))?.block_time ?? null : null)
  const lockT = await time(state.steps.lock?.txid)
  const releaseT = await time(state.steps.release?.txid)
  const njump = (id: string) => `https://njump.me/${id}`
  const ev = (e: PublishedEvent, who: string) => ({ who, id: e.id, kind: e.kind, created_at: e.created_at, accepted_by: e.accepted_by, refused_by: e.refused_by, view: njump(e.id) })
  const probeFile = join(OUT, '..', 'public', 'probe-summary.json')
  const eventIds = [...new Set([state.offer!.event_id, ...neg.borrower_events.map((e) => e.id), ...neg.lender_events.map((e) => e.id)])]
  const independent = await independentCheck(state, eventIds).catch((err: Error) => ({ error: err.message }))
  const record = {
    title: 'Passbook in public: a negotiated provider loan over public Nostr relays, settled on Mutinynet',
    recorded_at: new Date().toISOString(),
    test_data: 'Everything here is test data: Mutinynet test BTC and our own test USDT stand-in ("Passbook test USDT (mutinynet, no value)"). No real money, no fiat value.',
    network: { name: p.name, label: p.label, explorer: p.explorer, endpoints: { esplora: p.endpoints.esplora, rgb_indexer: p.endpoints.rgb_indexer, rgb_proxy: p.endpoints.rgb_proxy }, probe: probe.map((r) => ({ endpoint: r.endpoint, url: r.url, saw: r.saw })) },
    relays: { used: RELAYS, probe: existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, 'utf8')) : null },
    labels: { every_public_event: ['["network","mutinynet"]', `["alt","${testLabel(NETWORK)}"]`], offer: ['["expiration", created_at + 6 h] (NIP-40)', 'test_note in the content'], note: 'Negotiation messages are signed objects, so their label is in the tags; the NIP-44 content is unchanged.' },
    parties: { lender_pk: sheet.terms.lender_pk, borrower_pk: sheet.terms.borrower_pk, platform_pk: sheet.terms.platform_pk, processes: 'lender and platform in the driver; the borrower in its own process (pid ' + neg.borrower_pid + ') holding only its key' },
    offer: { event_id: state.offer!.event_id, kind: KIND.OFFER, created_at: state.offer!.created_at, expiration: state.offer!.expiration, accepted_by: state.offer!.accepted_by, refused_by: state.offer!.refused_by, view: njump(state.offer!.event_id), apr_bps: state.offer!.payload.apr_bps, range_micro: [state.offer!.payload.min, state.offer!.payload.max], policy_hash: state.offer!.policy_hash },
    negotiation: {
      negotiation_id: neg.negotiation_id, started_at: neg.started_at, agreed_at: neg.agreed_at, agreed: neg.agreed, accept_hash: neg.accept_hash, transcript_hash: hashObject(neg.messages),
      moves: neg.messages.map((m) => ({ seq: m.seq, type: m.type, from: m.from_pk === sheet.terms.lender_pk ? 'lender' : 'borrower', ...(m.body.position ? { apr_bps: (m.body.position as Position).apr_bps, ltv_bps: (m.body.position as Position).ltv_bps } : {}) })),
      events: [...neg.borrower_events.map((e) => ev(e, 'borrower')), ...neg.lender_events.map((e) => ev(e, 'lender'))].sort((a, b) => a.created_at - b.created_at),
    },
    income: state.income ? { ...state.income, explorer: explorerTx(p, state.income.txid), note: 'paid on Mutinynet by a separate test payer (its own key and RGB wallet), funded by the lender\'s wallet, which issued the test asset; the payer signed { txid, amount, borrower_pk }' } : null,
    earlier_attempts: (state.attempts ?? []).map((a) => ({ offer_event_id: a.offer?.event_id ?? null, negotiation_id: a.negotiation?.negotiation_id ?? null, agreed: a.negotiation?.agreed ?? null, sandbox_checks: a.check.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.id}`), lender_refused: a.failed, note: 'Not underwritten. The lender\'s re-verification of the disclosed inflow failed because of a bug in this driver (verifyHash was given the hash and the signature in the wrong order), not because of the inflow. It failed safe: nothing was locked. Fixed (unit test in test/public-relays.test.ts), then a new offer, negotiation and check. When the new lender server started, it answered this attempt\'s ASK, still on the relays, with NO_DEAL STALE_TERMS (the first lender event below).' })),
    check: state.check ? { ...state.check, part: undefined, borrower_view: state.borrower_side ?? null, part_view: state.check.part_event_id ? njump(state.check.part_event_id) : null } : null,
    term_sheet: { loan_id: state.loan_id, terms_hash_is_term_sheet_hash: termSheetHash(sheet) === state.loan_id, apr_bps: sheet.apr_bps, principal_micro: sheet.terms.principal, interest_micro: sheet.terms.fee, collateral_sats: sheet.terms.collateral_sats, ltv_bps: sheet.terms.ltv_bps, ladder_step: sheet.ladder_step, prev_passbook_txid: sheet.terms.prev_passbook_txid, evidence: sheet.scorer.evidence, consent_hash: sheet.consent_hash, signatures: Object.keys(sheet.signatures) },
    steps: Object.fromEntries(Object.entries(state.steps).map(([k, s]) => [k, { ...s, ...(s.txid ? { explorer: explorerTx(p, s.txid) } : {}) }])),
    timings: { lock_block_time: lockT ? new Date(lockT * 1000).toISOString() : null, release_block_time: releaseT ? new Date(releaseT * 1000).toISOString() : null, lock_to_release_s: lockT && releaseT ? releaseT - lockT : null, negotiation_s: (Date.parse(neg.agreed_at) - Date.parse(neg.started_at)) / 1000, note: 'chain times are block header timestamps (set by the signet block producer)' },
    independent_check: independent,
    platform: { loan_status: loan.status, repayment_proof: loan.repayment_proof, register_checks: state.steps.register?.checks, passbook: { pages: view.pages.map((pg) => ({ loan_id: pg.loan_id, status: pg.status, verified: pg.verified })), ladder: view.ladder } },
    not_covered: [
      'The on-chain legs (lock, fund, repay, release) ran in the driver with both wallets open, as in Add-on 4; the offer, the negotiation and the check ran with each side holding only its own key (two processes). Invoices and the release PSBT were not exchanged over Nostr.',
      'The credit check is the platform sandbox in rules mode (RuleReasoner, no model), not Compex: the lender-paid Compex check is paid over RGB Lightning HODL, and there is no RGB Lightning on Mutinynet here, so there was no check payment. Nothing pretends one happened.',
      'The platform ran in the driver process (the same Platform code as the server), on Mutinynet through Esplora; its repayment proof is the lender\'s signed acknowledgement (lender_ack), as in Add-on 4.',
      'The price is the platform\'s configured test price ($100,000), not a market feed. 1 block = 1 demo day; Mutinynet blocks come about every 30 s.',
      'This run is the Mutinynet half. The regtest service provider on the same public relays (lender peer, check node, a borrower process on public relays only, a lender-paid Compex check) is recorded under regtest_provider.',
    ],
  }
  // the regtest provider proof (infra/public-regtest-proof.ts) lives in the same file; a rewrite keeps it
  const previous = existsSync(RECORD) ? (JSON.parse(readFileSync(RECORD, 'utf8')) as { regtest_provider?: unknown }) : {}
  mkdirSync(resolve(RECORD, '..'), { recursive: true })
  writeFileSync(RECORD, `${JSON.stringify({ ...record, ...(previous.regtest_provider ? { regtest_provider: previous.regtest_provider } : {}) }, null, 2)}\n`)
  log(`record written: ${RECORD}`)
  for (const [k, s] of Object.entries(record.steps)) if ((s as Step).txid) console.log(`  ${k.padEnd(8)} ${(s as Step).txid}  ${(s as { explorer?: string }).explorer}`)
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status'
  if (cmd === 'borrower') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { 'lender-pk': { type: 'string' }, 'allowed-ltv': { type: 'string' }, sandbox: { type: 'string' }, out: { type: 'string' } } })
    if (!isHex(values['lender-pk'], 32) || !values.out || !values.sandbox) throw new Error('usage: borrower --lender-pk <hex> --allowed-ltv <bps> --sandbox <url> --out <file>')
    return borrowerProcess(values['lender-pk'] as Hex, Number(values['allowed-ltv'] ?? 5000), values.sandbox, values.out)
  }
  const cfg = config()
  if (cmd === 'run') return run(cfg)
  if (cmd === 'record') {
    const state = readRun()
    if (!state.steps.release?.txid) throw new Error('no finished run to record')
    const chain = new EsploraChain(cfg.network.endpoints.esplora!)
    const app = createApp({ platformKey: platformKey(), store: new Store(join(ROOT, 'passbook.sqlite')), chain, initialPriceCents: PRICE_CENTS, blocksPerMonth: 30, relays: [], deployment: cfg, wallet: null })
    try { await writeRecord(cfg, app, chain, state, await probeNetwork(cfg.network)) } finally { await app.close() }
    return
  }
  if (cmd === 'status') {
    const state = readRun()
    console.log(`relays: ${RELAYS.join(', ')}`)
    console.log(`steps done: ${Object.keys(state.steps).join(', ') || 'none'}${state.negotiation ? `; agreed ${state.negotiation.agreed.apr_bps / 100}% APR, LTV ${state.negotiation.agreed.ltv_bps / 100}%` : ''}`)
    return
  }
  throw new Error(`unknown command ${cmd}; use status | run | record`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().then(() => process.exit(0), (err) => {
    console.error((err as Error).stack ?? (err as Error).message)
    process.exit(1)
  })
}
