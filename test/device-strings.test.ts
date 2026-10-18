// The Android app uses the dashboard phone's words (apps/android/src/core/strings.ts)
// and never shows a test asset as plain "USDT" (apps/android/src/core/network.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { PHONE_ONLY, SHARED } from '../apps/android/src/core/strings.js'
import { labelAsset, networkOf } from '../apps/android/src/core/network.js'
import { usdt } from '../apps/android/src/core/format.js'

const web = ['../web/app.js', '../web/index.html'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n')

describe('Android thin client words', () => {
  it('every shared string is the dashboard’s, verbatim', () => {
    const missing = Object.entries(SHARED).filter(([, s]) => !web.includes(s))
    assert.deepEqual(missing, [], 'change the phone and the dashboard together')
  })

  it('says it is connected to the borrower’s node, and phone-only strings are not dashboard copies', () => {
    assert.equal(PHONE_ONLY.connected, 'connected to your Passbook node')
    assert.ok(Object.values(PHONE_ONLY).every((s) => !Object.values(SHARED).includes(s as never)))
  })

  it('badges every network and never labels a test asset plain USDT', () => {
    assert.deepEqual(networkOf({ chain: 'bitcoind' }), { id: 'regtest', badge: 'REGTEST · test coins', test: true, asset: 'test USDT (regtest)' })
    assert.equal(networkOf({ chain: 'fake' }).badge, 'FAKE CHAIN · test coins')
    assert.equal(networkOf({ chain: 'bitcoind', network: 'mutinynet' }).badge, 'MUTINYNET · test coins')
    assert.equal(networkOf({ network: { name: 'signet' } }).asset, 'test USDT (signet)')
    assert.equal(networkOf({ network: 'something-new' }).badge, 'UNKNOWN NETWORK · test coins', 'unknown counts as test')
    assert.equal(networkOf(null).test, true)
    assert.deepEqual(networkOf({ network: 'mainnet' }), { id: 'mainnet', badge: 'MAINNET', test: false, asset: 'USDT' })
    // the wallet panel's profile (GET /wallet/api/network on work/addon4-wallet) wins over /state
    assert.deepEqual(networkOf({ chain: 'bitcoind' }, { name: 'mutinynet', label: 'Mutinynet', asset: 'test USDT (mutinynet)', coin: 'mutinynet BTC' }), { id: 'mutinynet', badge: 'MUTINYNET · test coins', test: true, asset: 'test USDT (mutinynet)' })
    assert.equal(networkOf(null, { name: 'regtest', label: 'Regtest', asset: 'USDT' }).asset, 'test USDT (regtest)', 'a plain USDT label off mainnet is renamed')
    const regtest = networkOf({ chain: 'bitcoind' })
    assert.equal(usdt(600_000_000, regtest), '600.00 test USDT (regtest)')
    assert.equal(labelAsset('You receive 600.00 USDT (test USDT on regtest).', regtest), 'You receive 600.00 test USDT (regtest).')
    assert.equal(labelAsset('You repay 1,605.92 USDT by day 30. No other fees.', regtest), 'You repay 1,605.92 test USDT (regtest) by day 30. No other fees.')
    for (const text of ['You receive 600.00 USDT (test USDT on regtest).', 'Interest 5.92 USDT at 12.00% APR']) assert.doesNotMatch(labelAsset(text, regtest), /\d USDT/)
  })
})
