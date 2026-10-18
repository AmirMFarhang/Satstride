// `passbook agent check` end to end, offline: RGB from the device's wallet
// rows, a regtest address the person signs for with BIP-322 (a regtest test
// key), a Lightning node signing in LDK format. The lender reads the chain
// through its own source; the device through another. Nothing here is mainnet.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, keyPairFromLabel, randomHex } from '../src/core/crypto.js'
import { BtcOnchainAdapter } from '../src/networks/btc-onchain.js'
import { ChallengeBook, describeOutcome, runAgentCheck, type AgentCheckConfig } from '../src/networks/agent-check.js'
import { LightningAdapter, lnMessageHash, zbase32Encode, type LightningNodeApi, type NodeFactsSource } from '../src/networks/lightning.js'
import type { SourceCall } from '../src/networks/types.js'
import { DEFAULT_LENDER_LAYER_POLICY } from '../src/networks/policy.js'
import { RgbAdapter } from '../src/networks/rgb.js'
import { FixedListSanctionsScreen, StubSanctionsScreen } from '../src/networks/sanctions.js'
import { FakeBitcoin, regtestWallet } from './networks-chain.js'
import { testSignBip322, testSignLn } from './networks-signer.js'

const borrower = keyPairFromLabel('agent-check-borrower')
const L = keyPairFromLabel('agent-check-lender').pubkey

function setup() {
  const chain = new FakeBitcoin()
  const a = regtestWallet(), employer = regtestWallet()
  chain.pay(employer.script, [{ script: a.script, value: 5_000_000 }])
  const secret = secp256k1.utils.randomSecretKey()
  const nodePk = bytesToHex(secp256k1.getPublicKey(secret, true))
  const node: LightningNodeApi = { nodeInfo: async () => ({ pubkey: nodePk }), signMessage: async (m) => testSignLn(m, secret, lnMessageHash, zbase32Encode), descriptionInvoice: async () => { throw new Error('unused') }, listChannels: async () => [{ channel_id: 'c1', funding_txid: null, peer_pubkey: `03${'44'.repeat(32)}`, capacity_sat: 200_000, asset_id: null, ready: true }] }
  const rgb = new RgbAdapter('regtest', { party: borrower, borrowerPk: borrower.pubkey, assetId: 'rgb:usdt', rows: async () => [{ txid: 'aa'.repeat(32), height: chain.height, direction: 'in', amount: 900_000_000, counterparty_pk: keyPairFromLabel('employer').pubkey, memo: 'salary' }], signed: [] })
  const cfg: AgentCheckConfig = { history_chain: 'regtest', window_days: 365, borrower_source: chain.source('device electrs'), lender_source: chain.source('lender electrs'), policy: { ...DEFAULT_LENDER_LAYER_POLICY }, price_cents: 10_000_000, sanctions: new StubSanctionsScreen(), known_escrows: [], liabilities: { open_loans: [], ious_held_by_others: [] }, loan_chain: 'regtest', now: chain.time + 60 }
  const device = { borrower, shareable: { shareable_layers: ['rgb', 'btc-onchain', 'lightning'] as const, subjects: { 'btc-onchain': [a.address], lightning: [nodePk] } }, rgb, lightning: new LightningAdapter('regtest', node, null, 'signmessage'), btc_signatures: {} as Record<string, string> }
  return { chain, a, cfg, device: { ...device, shareable: { ...device.shareable, shareable_layers: [...device.shareable.shareable_layers] } }, nodePk, node }
}

describe('agent check', () => {
  it('first run prints the BIP-322 challenge and waits; with the signature, all three layers pass and LTV moves by the capped bonus', async () => {
    const { a, cfg, device } = setup()
    const book = new ChallengeBook(L, randomHex(32))
    const first = await runAgentCheck(cfg, device, book)
    assert.equal(first.awaiting_signature.length, 1)
    assert.equal(first.awaiting_signature[0].subject, a.address)
    assert.equal(first.negotiation.outcome, 'NO_DEAL')
    assert.match(first.negotiation.reasons[0], /waiting for 1 BIP-322 signature/)
    // the person signs the printed text in their own wallet (here: a regtest test key)
    const sig = testSignBip322(a.address, first.awaiting_signature[0].text, a.secret, true, 'regtest')
    const second = await runAgentCheck(cfg, { ...device, btc_signatures: { [a.address]: sig } }, book)
    assert.deepEqual(second.awaiting_signature, [])
    assert.equal(second.negotiation.outcome, 'DEAL', second.negotiation.reasons.join('; '))
    assert.equal(second.negotiation.ltv_bonus_bps, 400)
    const btc = second.layers.find((l) => l.layer === 'btc-onchain')!
    assert.equal(btc.source, 'device electrs')
    assert.equal(btc.lender_source, 'lender electrs')
    assert.equal(btc.recompute?.ok, true)
    assert.equal(btc.trust_mode, 'lender-recompute')
    assert.equal(second.consents.length, 3)
    assert.ok(second.consents.every((c) => c.negotiation_id === book.negotiation_id && c.lender_pk === L && c.trust_mode))
    assert.ok(second.source_calls.some((c) => c.note?.startsWith('lender')) && second.source_calls.some((c) => c.note?.startsWith('device')))
    assert.ok(second.features!.features.every((f) => f.trust_mode))
    assert.equal(second.decided_by, 'code: every number here comes from deterministic code; no model produced one')
    assert.ok(describeOutcome(second).some((l) => l.startsWith('btc-onchain: control proven; lender recomputed from lender electrs')))
    // the same proof cannot be used again
    const replay = await runAgentCheck(cfg, { ...device, btc_signatures: { [a.address]: sig } }, book)
    assert.equal(replay.awaiting_signature.length, 0)
    assert.ok(replay.layers.find((l) => l.layer === 'btc-onchain')!.control[0].reasons.length > 0)
  })

  it('without the RGB layer there is no deal, whatever else passes', async () => {
    const { a, cfg, device } = setup()
    const book = new ChallengeBook(L, randomHex(32))
    const c = book.issue('btc-onchain', 'regtest', a.address, cfg.now)
    const r = await runAgentCheck(cfg, { ...device, shareable: { ...device.shareable, shareable_layers: ['btc-onchain', 'lightning'] }, btc_signatures: { [a.address]: testSignBip322(a.address, c.text, a.secret, true, 'regtest') } }, book)
    assert.equal(r.negotiation.outcome, 'NO_DEAL')
    assert.deepEqual(r.negotiation.reasons, ['required layer rgb not shared'])
  })

  it('a signature from another key for the address fails control and the layer gives nothing', async () => {
    const { a, cfg, device } = setup()
    const book = new ChallengeBook(L, randomHex(32))
    const c = book.issue('btc-onchain', 'regtest', a.address, cfg.now)
    const other = regtestWallet()
    const r = await runAgentCheck(cfg, { ...device, btc_signatures: { [a.address]: testSignBip322(other.address, c.text, other.secret, true, 'regtest') } }, book)
    const btc = r.layers.find((l) => l.layer === 'btc-onchain')!
    assert.equal(btc.control[0].ok, false)
    assert.equal(r.negotiation.outcome, 'DEAL')
    assert.equal(r.negotiation.ltv_bonus_bps, 200, 'only the Lightning layer adds')
  })

  it('a sanctions hit on a proven address or a counterparty is NO_DEAL; the stub says not_screened, never clear', async () => {
    const { a, cfg, device, chain } = setup()
    const book = new ChallengeBook(L, randomHex(32))
    const c = book.issue('btc-onchain', 'regtest', a.address, cfg.now)
    const sig = { [a.address]: testSignBip322(a.address, c.text, a.secret, true, 'regtest') }
    const first = await runAgentCheck(cfg, { ...device, btc_signatures: sig }, book)
    assert.equal(first.features!.sanctions.status, 'not_screened')
    const payer = (await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], { from_time: 0, to_time: 2e9 })).rows[0].counterparty
    const book2 = new ChallengeBook(L, randomHex(32))
    const c2 = book2.issue('btc-onchain', 'regtest', a.address, cfg.now)
    const r = await runAgentCheck({ ...cfg, sanctions: new FixedListSanctionsScreen([payer], 'test list') }, { ...device, btc_signatures: { [a.address]: testSignBip322(a.address, c2.text, a.secret, true, 'regtest') } }, book2)
    assert.equal(r.features!.sanctions.status, 'hit')
    assert.deepEqual(r.features!.sanctions.hits, [{ address: payer, hop: 1, via: a.address, list_id: 'test list' }])
    assert.equal(r.negotiation.outcome, 'NO_DEAL')
    // the proven address itself on a list is a hop-0 hit
    const book3 = new ChallengeBook(L, randomHex(32))
    const c3 = book3.issue('btc-onchain', 'regtest', a.address, cfg.now)
    const own = await runAgentCheck({ ...cfg, sanctions: new FixedListSanctionsScreen([a.address]) }, { ...device, btc_signatures: { [a.address]: testSignBip322(a.address, c3.text, a.secret, true, 'regtest') } }, book3)
    assert.equal(own.features!.sanctions.hits[0].hop, 0)
    assert.equal(own.negotiation.outcome, 'NO_DEAL')
  })

  it('a layer the lender does not accept is never read: no source call, no rows, no typology or sanctions effect', async () => {
    const { a, cfg, device, chain } = setup()
    const payer = (await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], { from_time: 0, to_time: 2e9 })).rows[0].counterparty
    const policy = { ...DEFAULT_LENDER_LAYER_POLICY, accepted_layers: { rgb: 10_000, lightning: 10_000 }, trust_mode_by_layer: { rgb: 'client-side-validated' as const, lightning: 'signature-verified' as const } }
    // the payer is on the list: if the address were read, this would be NO_DEAL
    const r = await runAgentCheck({ ...cfg, policy, sanctions: new FixedListSanctionsScreen([payer]) }, device, new ChallengeBook(L, randomHex(32)))
    assert.deepEqual(r.awaiting_signature, [], 'no challenge for a layer that is not read')
    const btc = r.layers.find((l) => l.layer === 'btc-onchain')!
    assert.deepEqual([btc.control, btc.limits, btc.rows], [[], ['NOT_ACCEPTED_BY_LENDER: not read'], 0])
    assert.ok(!r.consents.some((c) => c.layer === 'btc-onchain'))
    assert.equal(cfg.borrower_source.calls.length + cfg.lender_source.calls.length, 0, 'the address went to no source')
    assert.equal(r.negotiation.outcome, 'DEAL')
    assert.equal(r.negotiation.layers.find((l) => l.layer === 'btc-onchain')!.status, 'not-accepted')
  })

  it('Lightning public-fact calls are in the audit trail', async () => {
    const { cfg, device, nodePk, node } = setup()
    const calls: SourceCall[] = []
    const facts: NodeFactsSource = {
      label: 'https://mempool.space/api', calls,
      async facts(pk) { calls.push({ at: 1, source: 'https://mempool.space/api', endpoint: `/v1/lightning/nodes/${pk}`, ok: true, height: null }); return { source: 'https://mempool.space/api', first_seen: 1_600_000_000, active_channels: 3, capacity_sat: 5_000_000, closed_channels: 1, force_closes_sampled: { force: 0, sampled: 1 } } },
    }
    const r = await runAgentCheck(cfg, { ...device, shareable: { ...device.shareable, shareable_layers: ['rgb', 'lightning'] }, lightning: new LightningAdapter('bitcoin', node, facts, 'signmessage') }, new ChallengeBook(L, randomHex(32)))
    assert.ok(r.source_calls.some((c) => c.endpoint === `/v1/lightning/nodes/${nodePk}` && c.note?.startsWith('device: lightning public facts')))
    assert.equal(r.lightning?.public_facts?.active_channels, 3)
  })

  it('refuses a pasted private key in the signature field', async () => {
    const { a, cfg, device } = setup()
    const book = new ChallengeBook(L, randomHex(32))
    await assert.rejects(runAgentCheck(cfg, { ...device, btc_signatures: { [a.address]: 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k' } }, book), /Never paste a private key/)
  })
})
