// Cross-layer netting and typologies, through the real btc-onchain adapter on
// a small regtest chain: own movements add zero income, a round trip through
// an own channel raises LAYER_WASH, BTC locked in an undisclosed Passbook
// escrow raises HIDDEN_LIABILITY, money paid out and back across layers raises
// CIRCULAR_FLOW, and CoinJoin is neutral.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keyPairFromLabel, type Hex } from '../src/core/crypto.js'
import { escrowFor, keyPathOutput } from '../src/escrow/escrow.js'
import { BtcOnchainAdapter } from '../src/networks/btc-onchain.js'
import { classifyRows, computeFeatures, DEFAULT_EVIDENCE_WEIGHTS, type FeatureInput, type OwnEntities } from '../src/networks/features.js'
import type { OwnChannel } from '../src/networks/lightning.js'
import type { LayerHistory, NormalizedRow } from '../src/networks/types.js'
import { channelScript, FakeBitcoin, regtestWallet } from './networks-chain.js'

const PRICE = 10_000_000 // $100,000 per BTC, in cents
const WINDOW = { from_time: 0, to_time: 2_000_000_000 }
const NODE = `02${'7a'.repeat(32)}`
const BORROWER = keyPairFromLabel('layers-test-borrower').pubkey

function input(histories: LayerHistory[], own: Partial<OwnEntities> = {}, extra: Partial<FeatureInput> = {}): FeatureInput {
  return {
    histories,
    own: { btc_addresses: [], node_pubkeys: [NODE], party_pks: [BORROWER], channels: [], ...own },
    liabilities: { open_loans: [], ious_held_by_others: [] },
    known_escrows: [],
    known_payers: [],
    weights: { ...DEFAULT_EVIDENCE_WEIGHTS },
    layer_weights_bps: { rgb: 10_000, 'btc-onchain': 10_000, lightning: 10_000 },
    trust_modes: { rgb: 'client-side-validated', 'btc-onchain': 'lender-recompute', lightning: 'signature-verified' },
    price_cents: PRICE,
    window: WINDOW,
    ...extra,
  }
}

function rgbRow(chain: FakeBitcoin, direction: 'in' | 'out', amount: number, counterparty: string, heightDelta = 1): NormalizedRow {
  const height = chain.height + heightDelta
  return { txid: `${(chain.height * 7 + amount).toString(16).padStart(8, '0')}${'ee'.repeat(28)}`, height, direction, amount, counterparty_pk: /^[0-9a-f]{64}$/.test(counterparty) ? counterparty : '00'.repeat(32), memo: '', layer: 'rgb', chain: 'regtest', asset: 'rgb:usdt', unit: 'micro-usdt', counterparty, time: null, provenance: { txid: 'x', source: 'rgb wallet', confirmations: 1 }, evidence_level: 'client-side-validated' }
}
const rgbHistory = (rows: NormalizedRow[]): LayerHistory => ({ layer: 'rgb', chain: 'regtest', subjects: [BORROWER], rows, height: null, source: 'rgb wallet', first_seen_time: null, balance: null, calls: [], limits: [] })
const channel = (funding_txid: Hex, capacity_sat: number): OwnChannel => ({ channel_id: 'chan-1', funding_txid, peer_pubkey: `03${'5c'.repeat(32)}`, capacity_sat, asset_id: null, ready: true })
const income = (f: ReturnType<typeof computeFeatures>, layer = 'all') => f.features.find((x) => x.name === 'weighted_income_per_month' && x.layer === layer)!.value

describe('own movements across layers', () => {
  it('self-movement on-chain, into an own channel, then RGB from the own node adds zero income', async () => {
    const chain = new FakeBitcoin()
    const a = regtestWallet(), b = regtestWallet('p2tr'), employer = regtestWallet()
    // money the person already had: received once from an employer
    const salary = chain.pay(employer.script, [{ script: a.script, value: 2_000_000 }])
    // a -> b, both proven: a self-transfer
    const move = chain.tx([{ txid: salary, vout: 0 }], [{ script: b.script, value: 1_999_000 }])
    // b -> own channel funding output
    const open = chain.tx([{ txid: move, vout: 0 }], [{ script: channelScript(), value: 1_998_000 }])
    const btc = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address, b.address], WINDOW)
    // USDT bought over the own channel arrives in the RGB wallet from the own node
    const rgb = rgbHistory([rgbRow(chain, 'in', 1_900_000_000, NODE)])
    const withNetting = computeFeatures(input([btc, rgb], { btc_addresses: [a.address, b.address], channels: [channel(open, 1_998_000)] }))
    const classes = classifyRows(input([btc, rgb], { btc_addresses: [a.address, b.address], channels: [channel(open, 1_998_000)] }))
    assert.deepEqual(classes.map((c) => [c.row.layer, c.class, c.why]), [
      ['btc-onchain', 'income', 'external inflow, chain-recomputable'],
      ['btc-onchain', 'own-movement', 'self-transfer between proven addresses'],
      ['btc-onchain', 'own-movement', 'opened own channel'],
      ['rgb', 'own-movement', 'from or to own node'],
    ])
    // only the employer's payment counts: 0.02 BTC = $2,000 at 70% (unknown payer) over 67 months -> under 100 USD
    assert.equal(income(withNetting, 'rgb'), '0 USD')
    assert.equal(income(withNetting, 'btc-onchain'), income(computeFeatures(input([btc], { btc_addresses: [a.address, b.address] })), 'btc-onchain'))
    // without the employer's payment, the whole loop is zero
    const loopOnly = computeFeatures(input([{ ...btc, rows: btc.rows.slice(1) }, rgb], { btc_addresses: [a.address, b.address], channels: [channel(open, 1_998_000)] }))
    assert.equal(income(loopOnly), '0 USD')
    // the same rows without netting would count the RGB transfer as income
    const naive = computeFeatures(input([btc, rgb], { btc_addresses: [a.address, b.address], node_pubkeys: [], channels: [] }))
    assert.notEqual(income(naive, 'rgb'), '0 USD')
  })
})

describe('LAYER_WASH', () => {
  async function roundTrip(declared: boolean) {
    const chain = new FakeBitcoin()
    const a = regtestWallet(), payer = regtestWallet()
    const got = chain.pay(payer.script, [{ script: a.script, value: 1_000_000 }])
    const chan = channelScript()
    const open = chain.tx([{ txid: got, vout: 0 }], [{ script: chan, value: 999_000 }])
    // a few blocks later the channel closes back to the same address
    chain.tx([], [{ script: regtestWallet().script, value: 1 }])
    chain.tx([{ txid: open, vout: 0 }], [{ script: a.script, value: 998_000 }])
    const btc = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    return computeFeatures(input([btc], { btc_addresses: [a.address], channels: declared ? [channel(open, 999_000)] : [] }))
  }

  it('a round trip through an own, declared channel raises LAYER_WASH as an alert and adds zero income', async () => {
    const f = await roundTrip(true)
    const t = f.typologies.find((x) => x.type === 'LAYER_WASH')!
    assert.equal(t.matched, true)
    assert.equal(t.disposition, 'alert')
    assert.deepEqual(t.layers, ['btc-onchain', 'lightning'])
    assert.equal(t.support.length, 2)
    assert.equal(f.rows.find((r) => r.class === 'own-movement')?.count, 2)
  })

  it('the same round trip through a channel the node did not declare is found from the chain and blocks', async () => {
    const f = await roundTrip(false)
    const t = f.typologies.find((x) => x.type === 'LAYER_WASH')!
    assert.equal(t.matched, true)
    assert.equal(t.disposition, 'block')
    assert.equal(f.disposition, 'block')
    assert.ok(t.rules.find((r) => r.id === 'channel_not_declared')!.matched)
  })

  it('no round trip, no LAYER_WASH', async () => {
    const chain = new FakeBitcoin()
    const a = regtestWallet(), payer = regtestWallet()
    chain.pay(payer.script, [{ script: a.script, value: 1_000_000 }])
    const btc = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    assert.equal(computeFeatures(input([btc], { btc_addresses: [a.address] })).typologies.find((x) => x.type === 'LAYER_WASH')!.matched, false)
  })
})

describe('HIDDEN_LIABILITY', () => {
  async function lockedHistory() {
    const chain = new FakeBitcoin()
    const a = regtestWallet(), payer = regtestWallet()
    const got = chain.pay(payer.script, [{ script: a.script, value: 5_000_000 }])
    const escrow = escrowFor({ borrower_pk: keyPairFromLabel('hl-b').pubkey, lender_pk: keyPairFromLabel('hl-l').pubkey, platform_pk: keyPairFromLabel('hl-p').pubkey, recovery_height: 5_000 })
    chain.tx([{ txid: got, vout: 0 }], [{ script: escrow.script, value: 4_000_000 }, { script: a.script, value: 999_000 }])
    const btc = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    return { btc, a, escrow }
  }

  it('undisclosed BTC locked in a known Passbook escrow raises HIDDEN_LIABILITY and blocks', async () => {
    const { btc, a, escrow } = await lockedHistory()
    const f = computeFeatures(input([btc], { btc_addresses: [a.address] }, { known_escrows: [{ loan_id: 'loan-elsewhere', script: escrow.script }] }))
    const t = f.typologies.find((x) => x.type === 'HIDDEN_LIABILITY')!
    assert.equal(t.matched, true)
    assert.equal(t.disposition, 'block')
    assert.equal(f.features.find((x) => x.name === 'liabilities')!.value, '1-2 items, 2.5k-5k USD')
  })

  it('the same lock, disclosed, is a counted liability and no typology', async () => {
    const { btc, a, escrow } = await lockedHistory()
    const f = computeFeatures(input([btc], { btc_addresses: [a.address] }, { known_escrows: [{ loan_id: 'loan-elsewhere', script: escrow.script }], liabilities: { open_loans: [{ loan_id: 'loan-elsewhere', principal: 2_000_000_000 }], ious_held_by_others: [] } }))
    assert.equal(f.typologies.find((x) => x.type === 'HIDDEN_LIABILITY')!.matched, false)
    assert.equal(f.features.find((x) => x.name === 'liabilities')!.value, '1-2 items, 5k-10k USD')
  })
})

describe('CIRCULAR_FLOW across layers', () => {
  it('BTC paid to a Passbook party on chain and the same value back from that party over RGB', async () => {
    const chain = new FakeBitcoin()
    const a = regtestWallet(), payer = regtestWallet()
    const friend = keyPairFromLabel('layers-test-friend').pubkey
    const got = chain.pay(payer.script, [{ script: a.script, value: 2_000_000 }])
    // pays the friend's own Passbook key-path address: $1,500 at $100k
    chain.tx([{ txid: got, vout: 0 }], [{ script: keyPathOutput(friend).script, value: 1_500_000 }, { script: a.script, value: 499_000 }])
    const btc = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    // two blocks later the friend "pays salary" of 1,450 USDT over RGB
    const rgb = rgbHistory([rgbRow(chain, 'in', 1_450_000_000, friend, 2)])
    const f = computeFeatures(input([btc, rgb], { btc_addresses: [a.address] }))
    const t = f.typologies.find((x) => x.type === 'CIRCULAR_FLOW')!
    assert.equal(t.matched, true)
    assert.deepEqual(t.layers, ['btc-onchain', 'rgb'])
    assert.ok(t.rules.find((r) => r.id === 'cross_layer')!.matched)
    assert.equal(t.support.find((s) => s.layer === 'rgb')!.txid, null, 'RGB txids stay private')
    assert.equal(f.disposition, 'block')
    // a different payer on RGB is not circular
    const clean = computeFeatures(input([btc, rgbHistory([rgbRow(chain, 'in', 1_450_000_000, keyPairFromLabel('employer').pubkey, 2)])], { btc_addresses: [a.address] }))
    assert.equal(clean.typologies.find((x) => x.type === 'CIRCULAR_FLOW')!.matched, false)
  })
})

describe('privacy tools are neutral', () => {
  it('a CoinJoin output received at a proven address is neither income nor a penalty nor a typology leg', async () => {
    const chain = new FakeBitcoin()
    const a = regtestWallet(), employer = regtestWallet()
    chain.pay(employer.script, [{ script: a.script, value: 3_000_000 }])
    const base = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    // a CoinJoin: six inputs from others' outputs, five equal outputs, one of them to the proven address
    const others = Array.from({ length: 6 }, () => regtestWallet())
    const funding = others.map((w) => chain.tx([], [{ script: w.script, value: 1_100_000 }]))
    const cj = chain.tx(funding.map((txid) => ({ txid, vout: 0 })), [a.script, ...others.slice(0, 4).map((w) => w.script)].map((script) => ({ script, value: 1_000_000 })))
    const withCj = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    const row = withCj.rows.find((r) => r.txid === cj)!
    assert.equal(row.links?.coinjoin_like, true)
    const f0 = computeFeatures(input([base], { btc_addresses: [a.address] }))
    const f1 = computeFeatures(input([withCj], { btc_addresses: [a.address] }))
    assert.equal(income(f1), income(f0), 'income unchanged')
    assert.equal(f1.score, f0.score)
    assert.equal(f1.disposition, 'clear')
    assert.ok(f1.typologies.every((t) => !t.matched))
    assert.equal(f1.features.find((x) => x.name === 'privacy_tools')!.value, 'used (1-2 transactions), neutral')
    assert.equal(f0.features.find((x) => x.name === 'privacy_tools')!.value, 'none seen')
  })
})

describe('evidence weights', () => {
  it('chain-recomputable: 100% for a known payer, 70% for an unknown address; self-reported counts zero', async () => {
    const chain = new FakeBitcoin()
    const a = regtestWallet(), payer = regtestWallet()
    chain.pay(payer.script, [{ script: a.script, value: 10_000_000 }])
    const btc = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    const known = classifyRows(input([btc], { btc_addresses: [a.address] }, { known_payers: [payer.address] }))[0]
    const unknown = classifyRows(input([btc], { btc_addresses: [a.address] }))[0]
    assert.equal(known.weight_bps, 10_000)
    assert.equal(unknown.weight_bps, 7_000)
    const selfReported = classifyRows(input([{ ...btc, rows: btc.rows.map((r) => ({ ...r, evidence_level: 'self-reported' as const })) }], { btc_addresses: [a.address] }))[0]
    assert.equal(selfReported.weight_bps, 0)
    const rgbSigned = classifyRows(input([rgbHistory([{ ...rgbRow(chain, 'in', 5, keyPairFromLabel('p').pubkey), evidence_level: 'counterparty-signed' }])]))[0]
    const rgbUnsigned = classifyRows(input([rgbHistory([rgbRow(chain, 'in', 5, keyPairFromLabel('p').pubkey)])]))[0]
    assert.equal(rgbSigned.weight_bps, 10_000)
    assert.equal(rgbUnsigned.weight_bps, 7_000)
  })

  it('every feature names its trust mode and is a band, not an amount', async () => {
    const chain = new FakeBitcoin()
    const a = regtestWallet()
    chain.pay(regtestWallet().script, [{ script: a.script, value: 123_456 }])
    const btc = await new BtcOnchainAdapter('regtest', chain.source()).history([a.address], WINDOW)
    const f = computeFeatures(input([btc, rgbHistory([rgbRow(chain, 'in', 777_777, keyPairFromLabel('p').pubkey)])], { btc_addresses: [a.address] }))
    for (const x of f.features) {
      assert.ok(x.trust_mode, x.name)
      assert.ok(!/123456|777777|123,456|777,777/.test(x.value), `${x.name} leaks an amount`)
    }
  })
})
