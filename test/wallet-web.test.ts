// The wallet panel's screens (web/wallet.js): every screen carries the network
// badge, and the dollar asset is never plain "USDT", on every network profile.
// The renderer is pure, so every screen is drawn here without a browser; the
// strings file shared with the Android client is checked too.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { NETWORKS } from '../src/core/network.js'
// @ts-expect-error plain browser module, no types
import { badge, parseDecimal, render, SCREENS, t } from '../web/wallet.js'
// @ts-expect-error plain browser module, no types
import STRINGS from '../web/wallet-strings.js'

const nets = Object.values(NETWORKS).map((n) => ({ name: n.name, label: n.label, coin: n.coinLabel, asset: n.assetLabel, public: n.public, explorer: n.explorer ?? null }))

/** A model that fills every screen with realistic, labelled content. */
function model(net: (typeof nets)[number]) {
  return {
    net,
    status: { unlocked: true, has_wallet: true, backup: { verified: false } },
    balances: { btc: { label: `0.005 ${net.coin}` }, rgb_btc: { label: `0.00012 ${net.coin}` }, usdt: { label: `600.00 ${net.asset}`, pending_label: `610.00 ${net.asset} incl. pending` }, asset_id: 'rgb:abc' },
    words: 'one two three four five six seven eight nine ten eleven twelve'.split(' '),
    positions: [2, 7, 11],
    receive: { address: 'tb1qexample', explorer: net.explorer ? `${net.explorer}/address/tb1qexample` : null, invoice: 'rgb:~/~/utxob:x', needsPrepare: true, rgbAddress: 'tb1prgb' },
    preview: { id: 'p1', decoded: { to: 'tb1qdest', to_type: 'P2WPKH (native SegWit)', amount_label: `1.00 ${net.asset}`, fee_label: `0.00000141 ${net.coin}`, total_label: `1.00 ${net.asset} + network fee`, asset_id: 'rgb:abc', transport_endpoints: ['rpcs://proxy.kaleidoswap.com/json-rpc'] }, gate: { name: 'interim wallet gate', adapter: true }, irreversible: "Can't be undone" },
    result: { ok: true, txid: 'ab'.repeat(32), explorer: null },
    history: { rows: [{ label: `+600.00 ${net.asset}`, direction: 'in', status: 'Settled', txid: 'cd'.repeat(32), explorer: null }], attempts: [{ kind: 'rgb', unit: 'micro', amount: 1_000_000, status: 'failed', reason: 'InsufficientAllocationSlots' }, { kind: 'btc', unit: 'sats', amount: 10_000, status: 'sent' }] },
    about: { endpoints: { rgb_indexer: 'tcp://127.0.0.1:50141', nostr: [] }, modules: { '@tetherto/wdk-wallet-btc': '1.0.0-beta.17' }, gate: { name: 'interim wallet gate' } },
    sendKind: 'rgb',
    error: null,
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
/** Every "USDT" must be the start-of-label "test USDT". */
const plainUsdt = (s: string) => [...s.matchAll(/USDT/g)].filter((m) => s.slice(Math.max(0, m.index! - 5), m.index) !== 'test ')

describe('wallet panel screens', () => {
  it('shows the network badge on every screen, on every network', () => {
    assert.ok(SCREENS.length >= 16)
    for (const net of nets) {
      for (const screen of SCREENS) {
        const html = render(screen, model(net))
        assert.ok(html.includes(`data-network-badge="${net.label}"`), `${screen} on ${net.name} has the badge`)
        assert.match(text(html), new RegExp(`${net.label} · test coins`, 'i'), `${screen} on ${net.name} says test coins`)
      }
      // and on a failed send, an empty model and an unknown screen
      assert.ok(render('result', { net, result: { ok: false, error: 'Not sent: x' } }).includes('data-network-badge'))
      assert.ok(render('home', { net }).includes('data-network-badge'))
      assert.ok(render('nope', { net }).includes('data-network-badge'))
    }
  })

  it('never names the test asset plain "USDT", on any screen or in any shared string', () => {
    for (const net of nets) {
      for (const screen of SCREENS) {
        const shown = text(render(screen, model(net)))
        assert.deepEqual(plainUsdt(shown).map((m) => shown.slice(Math.max(0, m.index! - 20), m.index! + 10)), [], `${screen} on ${net.name}`)
      }
    }
    for (const [key, value] of Object.entries(STRINGS as Record<string, string>)) assert.deepEqual(plainUsdt(value), [], `string ${key}`)
    // the file itself states the rule, nowhere else does "USDT" appear
    const file = readFileSync(new URL('../web/wallet-strings.js', import.meta.url), 'utf8')
    assert.ok(plainUsdt(file.slice(file.indexOf('export default'))).length === 0)
  })

  it('shows the decoded send with "Can\'t be undone" and the gate before signing', () => {
    const net = nets[1]
    const html = render('review', model(net))
    const shown = text(html)
    assert.match(shown, /Can't be undone\./)
    assert.match(shown, /tb1qdest/)
    assert.match(shown, /1\.00 test USDT \(mutinynet\)/)
    assert.match(shown, /interim wallet gate .*interim gate until the governance gate merges/)
    assert.match(html, /data-action="confirm"/)
    const noGate = text(render('review', { ...model(net), preview: { ...model(net).preview, gate: null } }))
    assert.match(noGate, /none: sends are refused/)
  })

  it('says on About that the web app is the screen over your own node through its signed API', () => {
    const shown = text(render('about', model(nets[0])))
    assert.match(shown, /screen over YOUR OWN Passbook node/)
    assert.match(shown, /signed API/)
    assert.match(shown, /regtest is a test network/)
    assert.match(shown, /1\.0\.0-beta\.17/)
  })

  it('asks for the backup before the first loan until it is proven', () => {
    const m = model(nets[0])
    assert.match(text(render('home', m)), /Prove your backup before your first loan/)
    assert.doesNotMatch(text(render('home', { ...m, status: { ...m.status, backup: { verified: true } } })), /Prove your backup/)
    assert.match(text(render('backup', m)), /Type words 2, 7, 11 from your paper/)
  })

  it('escapes what it shows', () => {
    const html = render('result', { net: nets[0], result: { ok: false, error: '<img src=x onerror=alert(1)>' } })
    assert.doesNotMatch(html, /<img/)
    assert.match(badge({ name: 'x"><script>', label: '<b>' }), /&quot;&gt;&lt;script&gt;/)
  })

  it('reads amounts without floating point', () => {
    assert.equal(parseDecimal('1.5', 6), 1_500_000)
    assert.equal(parseDecimal('0,00012', 8), 12_000)
    assert.equal(parseDecimal('600', 6), 600_000_000)
    assert.equal(parseDecimal('0.1234567', 6), null)
    assert.equal(parseDecimal('-1', 6), null)
    assert.equal(parseDecimal('1e3', 6), null)
    assert.equal(t('send.amount.rgb', nets[2]), 'Amount in test USDT (testnet4)')
  })

  it('mounts the badge on the dashboard too', () => {
    const index = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
    assert.match(index, /id="network-badge"/)
    assert.match(index, /mountBadge\(document.getElementById\('network-badge'\)\)/)
    assert.match(index, /href="\/wallet"/)
  })
})
