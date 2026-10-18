// The Mutinynet run's blocker (lender phone, 0.9.6): the issuer's test USDT has ticker TUSDT, and the Lend tab and
// Send only took ticker USDT, so the phone showed "You can lend 0.00" with 150 TUSDT in the wallet. Only the ticker
// (USDT or TUSDT) makes an asset test USDT; the market's public asset ids only choose among those; a PB-IOU never counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTestUsdt, pickLendAsset, pickSendAsset } from '../src/lender/assets.ts'

const MUTINY = 'rgb:Dh80a_Ge-1mV__mk-7SM61cr-_MZwAlT-X~5Ni4e-E2nkmZU'
const tusdt = { assetId: MUTINY, ticker: 'TUSDT', name: 'Passbook test USDT (mutinynet, no value)', spendable: 150_000_000 }
const iou = { assetId: 'rgb:iou', ticker: 'PBIOU', name: 'PB-IOU 1234', spendable: 10_090_000 }
const regtest = { assetId: 'rgb:regtest-usdt', ticker: 'USDT', name: 'Tether test', spendable: 5_000_000 }
const junk = { assetId: 'rgb:junk', ticker: 'XYZ', name: 'named by someone on the relay', spendable: 1_000_000 }

test('a TUSDT-ticker asset is lendable: the 150 TUSDT on the Mutinynet lender phone', () => {
  assert.ok(isTestUsdt(tusdt))
  assert.equal(pickLendAsset([iou, tusdt]), tusdt)
  assert.equal(pickLendAsset([iou, tusdt], [MUTINY]), tusdt)
})

test('the market\'s asset id chooses among test-USDT assets, but never makes another asset USDT', () => {
  // regtest USDT holds more, but the market names the TUSDT and it has something spendable
  assert.equal(pickLendAsset([regtest, { ...tusdt, spendable: 1_000_000 }], [MUTINY])!.assetId, MUTINY)
  // without a market id, the test USDT held most of
  assert.equal(pickLendAsset([{ ...regtest, spendable: 1 }, tusdt])!.assetId, MUTINY)
  // a market asset with nothing spendable falls back to the largest test USDT
  assert.equal(pickLendAsset([{ ...tusdt, spendable: 0 }, regtest], [MUTINY])!.assetId, regtest.assetId)
  // a relay offer naming a PB-IOU or any other asset the wallet holds: still not lendable, never preferred over TUSDT
  assert.equal(pickLendAsset([iou, junk, tusdt], [iou.assetId, junk.assetId]), tusdt)
  assert.equal(pickLendAsset([iou, junk], [iou.assetId, junk.assetId]), null)
})

test('a PB-IOU or any other asset is never lent or sent as test USDT', () => {
  assert.ok(!isTestUsdt(iou))
  assert.ok(!isTestUsdt(junk))
  assert.equal(pickLendAsset([iou]), null)
  assert.equal(pickSendAsset([iou, junk], 1), undefined)
})

test('a request without an asset id is paid from TUSDT that covers it', () => {
  assert.equal(pickSendAsset([iou, tusdt], 10_000_000), tusdt)
  assert.equal(pickSendAsset([{ ...regtest, spendable: 1 }, tusdt], 10_000_000), tusdt, 'the one that covers the amount')
  assert.equal(pickSendAsset([{ ...tusdt, spendable: 1 }], 10_000_000)!.assetId, MUTINY, 'else any test USDT (the screen says how much can go)')
  assert.equal(pickSendAsset([regtest], 1), regtest, 'regtest USDT unchanged')
})
