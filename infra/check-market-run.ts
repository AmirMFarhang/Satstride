// Regtest driver (like infra/lightning-spike.ts), not product code: one paid
// check on the isolated check-market regtest stack (infra/check-market.sh):
// two check nodes (A at 0.80, B at 0.50 test USDT), the borrower's agent picks
// by policy, pays B over RGB Lightning with a HODL invoice, opens the result
// with the preimage K, forwards K to the lender, and the lender verifies the
// same commitment on its own. Real relay, real RLN nodes, real regtest chain.
//
// The scorer input is the test persona bundle on its fixture chain: this run
// proves the market and the payment; the scorer itself has its own regtest
// tests. The record says so.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlaybookReasoner } from '../src/ai/playbook-reasoner.js'
import { Relay } from '../src/agents/relay.js'
import { Regtest } from '../src/chain/regtest.js'
import { keyPairFromLabel, randomHex, type Hex } from '../src/core/crypto.js'
import { KIND } from '../src/market/kinds.js'
import { RgbLightningNode } from '../src/rgb/lightning.js'
import { investigationFixture } from '../src/sandbox/investigation-fixtures.js'
import { contractHash, loadScoringContract } from '../src/scorer/contract.js'
import { SandboxScorerEngine } from '../src/scorer/providers.js'
import { devReleaseSigner, measureSource, signReleaseManifest } from '../src/scorer/releases.js'
import type { TrustPolicy } from '../src/scorer/verify.js'
import { openParty } from '../src/wallet/party.js'
import { forwardKey, listOffers, runPaidCheck, verifyForwardedCheck } from '../src/checknode/client.js'
import { CONTAINER_FALLBACK_LABEL, SandboxCheckEngine } from '../src/checknode/engine.js'
import { buildNode, marketRecord, nodeView, type CheckMarketRecord, type NodeSpec } from '../src/checknode/market.js'
import { chunkedBus } from '../src/checknode/bus.js'
import type { CheckMessage } from '../src/checknode/messages.js'
import { issueAndSendReceipt } from '../src/checknode/receipt.js'
import { structure } from '../src/market/negotiate.js'
import { signBorrowerPolicy, signLenderPolicy } from '../src/market/policy.js'
import { LocalKeySigner } from '../src/wallet/signer.js'
import { pickCheckNode } from '../src/checknode/select.js'
import { isInboundPayment, RlnPayerRail } from '../src/checknode/rail.js'
import { noTeeVerifier } from '../src/checknode/tee.js'
import { openAssetChannel, unlockAndFund, type RlnChannel } from '../src/checknode/regtest-ln.js'

type Channel = RlnChannel
interface AssetBalance { settled: number; spendable: number; offchain_outbound: number }

export { openAssetChannel, unlockAndFund }

/** Moves `amount` of a WDK-issued asset onto the borrower's Lightning node; returns the asset id and how it got there. */
async function usdtOnBorrowerNode(borrowerLn: RgbLightningNode, regtest: Regtest, amount: number, log: (l: string) => void): Promise<{ assetId: string; source: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-check-market-'))
  const issuer = await openParty('payer', { dir, create: true })
  try {
    await regtest.send(issuer.rgb.address(), 0.1)
    await regtest.mine(1)
    await issuer.rgb.createUtxos(5)
    await regtest.mine(1)
    const assetId = issuer.rgb.issueNia({ ticker: 'USDT', name: 'Tether USD (regtest stand-in)', precision: 6, amount: 10_000_000_000 })
    // The node does not know the asset yet, so the invoice takes any asset (the HODL build refuses an unknown contract id).
    const inv = await borrowerLn.request<{ invoice: string }>('/rgbinvoice', { min_confirmations: 1, witness: true, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600 })
    const sent = await issuer.rgb.send({ invoice: inv.invoice, assetId, amount })
    for (let i = 0; i < 12; i++) {
      await borrowerLn.request('/refreshtransfers', { skip_sync: false })
      issuer.rgb.refresh()
      const balance = await borrowerLn.request<AssetBalance>('/assetbalance', { asset_id: assetId }).catch(() => undefined)
      if (balance && balance.spendable >= amount && issuer.rgb.transferByTxid(assetId, sent.txid, 'Send')?.status === 'Settled') return { assetId, source: 'WDK-issued USDT stand-in, sent on chain to the borrower\'s RGB Lightning node' }
      await regtest.mine(1)
    }
    throw new Error('WDK-to-RLN transfer did not settle')
  } catch (err) {
    // Labelled fallback: the HODL build's rgb-lib may not accept this WDK consignment.
    log(`WDK bridge failed (${(err as Error).message.slice(0, 120)}); issuing the stand-in on the borrower's node instead`)
    const { asset } = await borrowerLn.request<{ asset: { asset_id: string } }>('/issueassetnia', { amounts: [amount], ticker: 'USDT', name: 'USDT regtest stand-in', precision: 6 })
    return { assetId: asset.asset_id, source: 'FALLBACK: USDT stand-in issued on the borrower\'s RGB Lightning node (the WDK bridge did not settle)' }
  } finally {
    issuer.close()
  }
}

async function waitFor<T>(what: string, regtest: Regtest, step: () => Promise<T | null | undefined>, rounds = 12): Promise<T> {
  for (let i = 0; i < rounds; i++) {
    const v = await step()
    if (v) return v
    await regtest.mine(1)
  }
  throw new Error(`${what} did not settle`)
}

interface UdaAsset { asset_id: string; balance: { settled: number } }

export interface RegtestRunOptions {
  lnBorrower: string
  lnA: string
  lnB: string
  /** docker hostnames of the operator nodes for peer connections */
  hostA?: string
  hostB?: string
  rails?: ('rgb-ln-hodl' | 'rgb-ln-pay-then-deliver')[]
  /** Run the voucher phase: B issues PBCHK, the lender sends one to the borrower, the borrower pays a check with it. */
  vouchers?: boolean
  log?: (line: string) => void
}

export interface VoucherRun { asset_id: string; ticker: string; name: string; issued: number; lender_received: number; borrower_received: number; picked_with_voucher: boolean; paid: { payment_hash: Hex; key_source: string; amount: number } | null; lender_verified: boolean; first_attempt?: { outcome: 'refused' | 'paid'; payer_error: string | null; node_status: string; node_reason: string | null }; usdt_channel_closed?: string; error?: string }

export async function runRegtestCheckMarket(o: RegtestRunOptions): Promise<CheckMarketRecord & { asset_source: string; scorer_input: string; timings_ms: Record<string, number>; voucher?: VoucherRun }> {
  const log = o.log ?? ((l: string) => console.log(`[check-market] ${l}`))
  const started = Date.now()
  const timings: Record<string, number> = {}
  const mark = (step: string) => { timings[step] = Date.now() - started; log(`${step}: ${timings[step]} ms`) }
  const regtest = new Regtest()
  await regtest.ensureMiner()
  const lnBorrower = new RgbLightningNode(o.lnBorrower), lnA = new RgbLightningNode(o.lnA), lnB = new RgbLightningNode(o.lnB)
  await unlockAndFund(lnBorrower, regtest)
  const pubA = await unlockAndFund(lnA, regtest)
  const pubB = await unlockAndFund(lnB, regtest)
  // A rerun starts clean: channels of earlier runs to the same node can carry other assets.
  const leftover = (await lnBorrower.request<{ channels: Channel[] }>('/listchannels')).channels
  for (const c of leftover) await lnBorrower.request('/closechannel', { channel_id: c.channel_id, peer_pubkey: c.peer_pubkey, force: false })
  if (leftover.length) await waitFor('closing earlier channels', regtest, async () => (await lnBorrower.request<{ channels: Channel[] }>('/listchannels')).channels.length === 0 || null)
  mark('lightning_nodes_funded')
  const CHANNEL_USDT = 50_000_000
  const { assetId, source } = await usdtOnBorrowerNode(lnBorrower, regtest, CHANNEL_USDT, log)
  mark('usdt_on_borrower_node')

  // Identities: demo keys, labelled. The fixture persona's bundle is the scorer input.
  const borrower = keyPairFromLabel('fatima')
  const lender = keyPairFromLabel('check-market-lender')
  const f = investigationFixture('fatima')
  const contract = loadScoringContract()
  const rails = o.rails ?? ['rgb-ln-hodl']
  // The release the nodes run: this checkout's source, measured (the container scorer's code in-process, labelled).
  const measurement = measureSource()
  const specs: NodeSpec[] = [
    { name: 'A', operator: keyPairFromLabel('check-node-operator-A'), demoKey: true, priceMicro: 800_000, p50Seconds: 20, lnUrl: o.lnA, rails, paymentAssetId: assetId },
    { name: 'B', operator: keyPairFromLabel('check-node-operator-B'), demoKey: true, priceMicro: 500_000, p50Seconds: 40, lnUrl: o.lnB, rails, paymentAssetId: assetId },
  ]
  const relays: Relay[] = []
  const receipts = new Map<Hex, { contract_id: string; txid: string; media_digest: string; details: string }>()
  const nodes = await Promise.all(specs.map(async (spec, i) => {
    const relay = new Relay(spec.operator)
    relays.push(relay)
    const engine = new SandboxCheckEngine(new SandboxScorerEngine({ provider: 'container', key: keyPairFromLabel(`check-node-enclave-${spec.name}-${randomHex(4)}`), chain: f.chain, reasoner: new PlaybookReasoner(), blocksPerMonth: 30, oraclePk: f.oracle.pubkey, measurement, runEnvironment: { image_digest: 'in-process', network_mode: 'in-process-host' } }), { label: CONTAINER_FALLBACK_LABEL, fallback: true, modelHash: null })
    const ln = i === 0 ? lnA : lnB
    const node = await buildNode(spec, relay, engine, {
      paymentTimeoutMs: 180_000, log: (l) => log(`node ${spec.name}: ${l}`),
      // The receipt: a UDA with hashes only, sent on chain to the borrower's invoice.
      onPaid: async (paid) => {
        if (!paid.receipt_invoice) return
        const sent = await issueAndSendReceipt(ln, paid.receipt_invoice, { v: 1, kind: 'passbook-check-receipt', commitment: paid.commitment.commitment, evidence_digest: paid.envelope_digest, release_hash: paid.commitment.release_hash, operator_pk: spec.operator.pubkey, tier: 'software-evidence', date: new Date().toISOString().slice(0, 10) })
        receipts.set(paid.negotiation_id, sent)
        log(`node ${spec.name}: receipt ${sent.contract_id} sent in ${sent.txid.slice(0, 12)}…`)
      },
    })
    return node
  }))
  const releases = signReleaseManifest(devReleaseSigner(), { builds: [{ label: 'container scorer (check market regtest run)', provider: 'container', code_measurement: measurement, contract_hash: contractHash(contract), max_trust: 'dev-inprocess' }] })
  const trust: TrustPolicy = { minTrust: 'dev-inprocess', releases, releaseSignerPk: devReleaseSigner().pubkey, contract }
  for (const n of nodes) await n.publishOffer()
  const serving = nodes.map((n) => n.serve({ republishMs: 600_000 }))
  const borrowerRelay = new Relay(borrower)
  const lenderRelay = new Relay(lender)
  relays.push(borrowerRelay, lenderRelay)
  try {
    const now = Math.floor(Date.now() / 1000)
    const { valid } = await listOffers(borrowerRelay, now)
    const ours = valid.filter((v) => specs.some((s) => s.operator.pubkey === v.operator_pk))
    // The pick lives in the negotiation's structure step: both signed policies plus the offers on the relay.
    const U = 1_000_000
    const bp = await signBorrowerPolicy(new LocalKeySigner(borrower), { asset_id: assetId, principal: { min: 300 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb', 'ln-rln'], max_check_price: { asset_id: assetId, amount: 600_000 }, issued_at: now })
    const lp = await signLenderPolicy(new LocalKeySigner(lender), { asset_id: assetId, max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: ['injection'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [], maker_checker_above: 5_000 * U }, check_nodes: { accepted_check_operators: specs.map((sp) => sp.operator.pubkey), min_execution: 'software', max_price: { asset_id: assetId, amount: 1_000_000 } }, issued_at: now })
    const s = structure(bp, lp, { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb', 'ln-rln'] }, 0, { offers: ours, payer: { payer: 'borrower', payment_asset_id: assetId, rails }, trust, tee: noTeeVerifier(now) })
    if (!s.ok || !s.check_node) throw new Error(`structure step: ${s.ok ? 'no market' : `${s.reason} ${(s.why ?? []).join(' ')}`}`)
    const pick = s.check_node.pick
    if (!pick.picked?.rail) throw new Error(`no node picked: ${pick.why.join(' ')}`)
    log(`structure step picked ${pick.picked.operator_pk.slice(0, 12)}…: ${pick.why.join(' ')}`)
    mark('offers_listed_and_picked')
    const pickedPub = pick.picked.operator_pk === specs[0].operator.pubkey ? pubA : pubB
    const pickedHost = pick.picked.operator_pk === specs[0].operator.pubkey ? (o.hostA ?? 'check-rln-a') : (o.hostB ?? 'check-rln-b')
    await openAssetChannel(lnBorrower, pickedPub, pickedHost, assetId, CHANNEL_USDT, regtest)
    mark('rgb_channel_usable')
    const negotiationId = randomHex(32)
    const receiptInvoice = (await lnBorrower.request<{ invoice: string }>('/rgbinvoice', { min_confirmations: 1, witness: false, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600 })).invoice
    const paid = await runPaidCheck({ bus: borrowerRelay, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId, bundle: f.bundle, offer: pick.picked.offer, rail: pick.picked.rail as 'rgb-ln-hodl', payWith: assetId, payerRail: new RlnPayerRail(lnBorrower), dataCategories: [...contract.inputs.data_categories], pick, timeoutMs: 180_000, receiptInvoice })
    mark('paid_and_opened')
    await forwardKey(borrowerRelay, borrower, lender.pubkey, paid)
    const got = await chunkedBus(lenderRelay).receive<CheckMessage>(KIND.CHECK_KEY, borrower.pubkey, { timeoutMs: 30_000, match: (m) => m.negotiation_id === negotiationId })
    const verified = await verifyForwardedCheck(got.payload, { negotiation_id: negotiationId, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, payer_pk: borrower.pubkey, rules: {}, trust, tee: noTeeVerifier(Math.floor(Date.now() / 1000)), requiredChecks: ['injection'], now: Math.floor(Date.now() / 1000) })
    mark('lender_verified')
    const inbound = await (pick.picked.operator_pk === specs[0].operator.pubkey ? lnA : lnB).getPayment(paid.commitment.payment.payment_hash)
    if (!isInboundPayment(inbound) || inbound.status !== 'Succeeded' || inbound.asset_id !== assetId || inbound.asset_amount !== paid.commitment.payment.amount) throw new Error(`the operator's node does not report the check payment: ${JSON.stringify(inbound)}`)
    // The receipt settles on chain: both nodes refresh while blocks are mined.
    const pickedLn = pick.picked.operator_pk === specs[0].operator.pubkey ? lnA : lnB
    let receipt: CheckMarketRecord['receipt']
    try {
      const sent = await waitFor('the receipt hand-off', regtest, async () => receipts.get(negotiationId), 3)
      const held = await waitFor('the receipt transfer', regtest, async () => {
        await pickedLn.request('/refreshtransfers', { skip_sync: false }).catch(() => undefined)
        await lnBorrower.request('/refreshtransfers', { skip_sync: false }).catch(() => undefined)
        const { uda } = await lnBorrower.request<{ uda?: UdaAsset[] }>('/listassets', { filter_asset_schemas: ['Uda'] })
        return (uda ?? []).find((a) => a.asset_id === sent.contract_id && a.balance.settled === 1)
      })
      receipt = { contract_id: held.asset_id, status: `settled on chain in the borrower's RGB wallet (UDA, hashes only; details "${sent.details}", media ${sent.media_digest.slice(0, 16)}…)` }
    } catch (err) {
      receipt = { contract_id: receipts.get(negotiationId)?.contract_id ?? null, status: `not settled: ${(err as Error).message.slice(0, 120)}` }
    }
    mark('receipt')
    const voucher = o.vouchers ? await runVoucherPhase() : undefined
    const record = marketRecord(nodes.map((n, i) => nodeView(n, specs[i])), pick, paid, verified, receipt)
    return { ...record, asset_source: source, scorer_input: 'the test persona bundle (fatima) on its fixture chain; the payment, relay and Lightning are real regtest', timings_ms: timings, ...(voucher ? { voucher } : {}) }

    // Vouchers: B issues PBCHK (1 unit = 1 check), sells 10 to the lender, the lender sends 1 to the borrower, the borrower pays a check with it.
    async function runVoucherPhase(): Promise<VoucherRun> {
      const nodeB = nodes[1], specB = specs[1]
      const name = `PBCHK-${specB.operator.pubkey.slice(0, 8)}`
      const { asset } = await lnB.request<{ asset: { asset_id: string } }>('/issueassetnia', { amounts: [100], ticker: 'PBCHK', name, precision: 0 })
      const voucherId = asset.asset_id
      const run: VoucherRun = { asset_id: voucherId, ticker: 'PBCHK', name, issued: 100, lender_received: 0, borrower_received: 0, picked_with_voucher: false, paid: null, lender_verified: false }
      const dir = mkdtempSync(join(tmpdir(), 'passbook-check-voucher-'))
      const lenderWallet = await openParty('lender1', { dir, create: true })
      try {
        await regtest.send(lenderWallet.rgb.address(), 0.1)
        await regtest.mine(1)
        await lenderWallet.rgb.createUtxos(5)
        await regtest.mine(1)
        const lenderInvoice = lenderWallet.rgb.blindInvoice(10)
        const decoded = await lnB.request<{ recipient_id: string; transport_endpoints: string[] }>('/decodergbinvoice', { invoice: lenderInvoice.invoice })
        await lnB.request('/sendrgb', { donation: false, fee_rate: 1, min_confirmations: 1, skip_sync: false, recipient_map: { [voucherId]: [{ recipient_id: decoded.recipient_id, assignment: { type: 'Fungible', value: 10 }, transport_endpoints: decoded.transport_endpoints }] } })
        await waitFor('vouchers to the lender', regtest, async () => {
          await lnB.request('/refreshtransfers', { skip_sync: false }).catch(() => undefined)
          lenderWallet.rgb.refresh()
          const settled = lenderWallet.rgb.knowsAsset(voucherId) ? lenderWallet.rgb.balance(voucherId).settled : 0
          return settled >= 10 ? settled : null
        })
        run.lender_received = 10
        mark('vouchers_to_lender')
        const borrowerInv = await lnBorrower.request<{ invoice: string }>('/rgbinvoice', { min_confirmations: 1, witness: true, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600 })
        const sent = await lenderWallet.rgb.send({ invoice: borrowerInv.invoice, assetId: voucherId, amount: 1 })
        await waitFor('the voucher to the borrower', regtest, async () => {
          await lnBorrower.request('/refreshtransfers', { skip_sync: false }).catch(() => undefined)
          lenderWallet.rgb.refresh()
          const b = await lnBorrower.request<AssetBalance>('/assetbalance', { asset_id: voucherId }).catch(() => undefined)
          return b && b.spendable >= 1 && lenderWallet.rgb.transferByTxid(voucherId, sent.txid, 'Send')?.status === 'Settled' ? b : null
        })
        run.borrower_received = 1
        mark('voucher_to_borrower')
        await openAssetChannel(lnBorrower, pubB, o.hostB ?? 'check-rln-b', voucherId, 1, regtest)
        mark('voucher_channel_usable')
        nodeB.setAssets([{ asset_id: assetId, ticker: 'USDT', amount: specB.priceMicro, kind: 'payment' }, { asset_id: voucherId, ticker: 'PBCHK', amount: 1, kind: 'voucher' }])
        await nodeB.publishOffer()
        const now2 = Math.floor(Date.now() / 1000)
        const offers2 = (await listOffers(borrowerRelay, now2)).valid.filter((v) => specs.some((sp) => sp.operator.pubkey === v.operator_pk))
        const pick2 = pickCheckNode(offers2, {}, { payer: 'borrower', payment_asset_id: assetId, vouchers_held: [voucherId], rails }, { trust, tee: noTeeVerifier(now2) })
        run.picked_with_voucher = pick2.picked?.operator_pk === specB.operator.pubkey && pick2.picked.pay_with?.asset_id === voucherId
        if (!run.picked_with_voucher || !pick2.picked) throw new Error(`voucher pick: ${pick2.why.join(' ')}`)
        const attempt = (neg: Hex) => runPaidCheck({ bus: borrowerRelay, payer: borrower, borrower, lenderPk: lender.pubkey, negotiationId: neg, bundle: f.bundle, offer: pick2.picked!.offer, rail: 'rgb-ln-hodl', payWith: voucherId, payerRail: new RlnPayerRail(lnBorrower), dataCategories: [...contract.inputs.data_categories], pick: pick2, timeoutMs: 180_000 })
        // With a USDT and a PBCHK channel to the same node, this RLN build may route the voucher invoice over
        // the USDT channel; the node's receive check then refuses the HTLC and K stays secret. Recorded, then
        // the USDT channel is closed and the voucher redeemed over its own channel.
        let neg2 = randomHex(32)
        let paid2 = await attempt(neg2).catch(async (err: Error) => {
          const entry = nodeB.log.find((e) => e.negotiation_id === neg2)
          run.first_attempt = { outcome: 'refused', payer_error: err.message.slice(0, 160), node_status: entry?.status ?? 'unknown', node_reason: entry?.reason?.slice(0, 200) ?? null }
          log(`voucher attempt with both channels open refused: ${entry?.reason ?? err.message}`)
          return null
        })
        if (!paid2) {
          const usdtChannel = (await lnBorrower.request<{ channels: Channel[] }>('/listchannels')).channels.find((c) => c.asset_id === assetId && c.peer_pubkey === pubB)
          if (!usdtChannel) throw new Error('no USDT channel to close')
          await lnBorrower.request('/closechannel', { channel_id: usdtChannel.channel_id, peer_pubkey: pubB, force: false })
          await waitFor('the USDT channel close', regtest, async () => !(await lnBorrower.request<{ channels: Channel[] }>('/listchannels')).channels.some((c) => c.channel_id === usdtChannel.channel_id) || null)
          run.usdt_channel_closed = usdtChannel.channel_id
          mark('usdt_channel_closed')
          neg2 = randomHex(32)
          paid2 = await attempt(neg2)
        } else run.first_attempt = { outcome: 'paid', payer_error: null, node_status: 'paid', node_reason: null }
        const inbound = await lnB.getPayment(paid2.commitment.payment.payment_hash)
        if (!isInboundPayment(inbound) || inbound.status !== 'Succeeded' || inbound.asset_id !== voucherId || inbound.asset_amount !== 1) throw new Error(`node B does not report the voucher payment: ${JSON.stringify(inbound)}`)
        run.paid = { payment_hash: paid2.commitment.payment.payment_hash, key_source: paid2.key_source, amount: paid2.commitment.payment.amount }
        await forwardKey(borrowerRelay, borrower, lender.pubkey, paid2)
        const got2 = await chunkedBus(lenderRelay).receive<CheckMessage>(KIND.CHECK_KEY, borrower.pubkey, { timeoutMs: 30_000, match: (m) => m.negotiation_id === neg2 })
        run.lender_verified = (await verifyForwardedCheck(got2.payload, { negotiation_id: neg2, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, payer_pk: borrower.pubkey, rules: {}, trust, tee: noTeeVerifier(Math.floor(Date.now() / 1000)), requiredChecks: ['injection'], now: Math.floor(Date.now() / 1000) })).ok
        mark('voucher_check_paid')
        return run
      } catch (err) {
        // Recorded, not hidden: the assertions read it.
        run.error = (err as Error).message.slice(0, 300)
        log(`voucher phase failed: ${run.error}`)
        return run
      } finally {
        lenderWallet.close()
      }
    }
  } finally {
    for (const n of nodes) n.stop()
    await Promise.race([Promise.allSettled(serving), new Promise((r) => setTimeout(r, 6000))])
    for (const r of relays) r.close()
  }
}
