import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MUTINYNET, REGTEST, assertTestNetwork, checkRecipient, dustFor, eventOnNetwork, overrideProblems, parseProviderLink, profileFor, testLabelTags } from '../src/core/network.ts'
import { formatBtc, groupSats, parseSats } from '../src/core/amounts.ts'
import { CHECK_COUNT, ordinal, pickCheckPositions, splitWords, verifyBackup } from '../src/core/backup.ts'
import { amountMismatch, parseAmbiguous, requestedAmount } from '../src/core/sends.ts'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const WORDS = splitWords('abandon ability able about above absent absorb abstract absurd abuse access accident')

test('the wallet refuses every network but regtest and Mutinynet, mainnet above all', () => {
  assert.doesNotThrow(() => assertTestNetwork(REGTEST))
  assert.doesNotThrow(() => assertTestNetwork(MUTINYNET))
  for (const p of [{ name: 'regtest', btcNetwork: 'bitcoin', rgbNetwork: 'Regtest' }, { name: 'mutinynet', btcNetwork: 'bitcoin', rgbNetwork: 'Signet' }, { name: 'mutinynet', btcNetwork: 'testnet', rgbNetwork: 'Mainnet' }, { name: 'mainnet', btcNetwork: 'bitcoin', rgbNetwork: 'Mainnet' }, { name: 'regtest', btcNetwork: 'testnet', rgbNetwork: 'Regtest' }])
    assert.throws(() => assertTestNetwork(p as never), /test networks only/)
  for (const n of ['mainnet', 'bitcoin', 'testnet', 'signet', '']) assert.throws(() => profileFor(n), /regtest or Mutinynet only/)
})

test("each network's BTC wallet has its own WDK key, registered in the worklet bundle (key == blockchain)", () => {
  // WDK caches addresses per network key: Mutinynet must not reuse regtest's (a bcrt1 address showed on Mutinynet)
  assert.notEqual(REGTEST.btcKey, MUTINYNET.btcKey)
  const bundle = createRequire(import.meta.url)('../wdk.config.js') as { networks: Record<string, { package: string }>; allowedMethods: Record<string, { methods: string[] }> }
  for (const p of [REGTEST, MUTINYNET]) {
    assert.equal(bundle.networks[p.btcKey]?.package, '@tetherto/wdk-wallet-btc', `${p.btcKey} in wdk.config.js`)
    assert.deepEqual(bundle.allowedMethods[p.btcKey], bundle.allowedMethods.bitcoin, `${p.btcKey} allows the same methods`)
  }
})

test('Mutinynet: tb1 addresses, labelled units, the provider link checked before anything is saved', () => {
  assert.equal(MUTINYNET.btcUnit, 'test BTC (mutinynet)')
  assert.equal(MUTINYNET.usdUnit, 'test USDT (mutinynet)')
  assert.match(MUTINYNET.badge, /MUTINYNET/)
  assert.equal(MUTINYNET.relays[0], 'wss://relay.primal.net', 'the relay that keeps large check events comes first')
  assert.equal(checkRecipient('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', MUTINYNET).ok, true)
  const reg = checkRecipient('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', MUTINYNET)
  assert.equal(reg.ok, false); assert.match((reg as { reason: string }).reason, /regtest address, not mutinynet/)
  assert.match((checkRecipient('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', MUTINYNET) as { reason: string }).reason, /mainnet/)
  const link = parseProviderLink('passbookwallet://provider?network=mutinynet&platform=http://192.168.1.20:4301&relays=wss://relay.primal.net,wss://nos.lol&platform_pk=' + 'ab'.repeat(32))
  assert.ok(!('error' in link))
  if (!('error' in link)) {
    assert.equal(link.name, 'mutinynet')
    assert.deepEqual(link.overrides.relays, ['wss://relay.primal.net', 'wss://nos.lol'])
    assert.equal(link.platformPk, 'ab'.repeat(32))
    const p = profileFor(link.name, link.overrides)
    assert.equal(p.platform, 'http://192.168.1.20:4301')
    assert.equal(p.electrum.host, 'electrum.mutinynet.com')
  }
  assert.match((parseProviderLink('passbookwallet://provider?network=mainnet') as { error: string }).error, /not a test network/)
  assert.match((parseProviderLink('passbookwallet://provider?network=mutinynet&relays=ws://relay.example.com') as { error: string }).error, /wss/)
  assert.match((parseProviderLink('https://evil.example/provider?network=mutinynet') as { error: string }).error, /not a Passbook provider link/)
  assert.throws(() => profileFor('regtest', { platform: 'http://203.0.113.5:4301' }), /local or private/)
})

test('test coins are always labelled as test coins', () => {
  assert.equal(REGTEST.btcUnit, 'test BTC')
  assert.equal(REGTEST.usdUnit, 'test USDT')
  assert.match(REGTEST.badge, /REGTEST/)
})

test('recipient check: regtest bech32 only', () => {
  const ok = checkRecipient('  bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080 ', REGTEST)
  assert.deepEqual(ok, { ok: true, address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080' })
  assert.equal(checkRecipient('BCRT1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KYGT080', REGTEST).ok, true)
  const main = checkRecipient('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', REGTEST)
  assert.equal(main.ok, false); assert.match((main as { reason: string }).reason, /mainnet/)
  assert.equal(checkRecipient('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', REGTEST).ok, false)
  assert.equal(checkRecipient('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', REGTEST).ok, false)
  assert.equal(checkRecipient('bcrt1qbIo', REGTEST).ok, false)
  assert.equal(checkRecipient('bcrt1Qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', REGTEST).ok, false)
  assert.equal(checkRecipient('', REGTEST).ok, false)
})

test('amounts are integer sats; display is derived', () => {
  assert.equal(formatBtc(123456789n), '1.23456789')
  assert.equal(formatBtc('5000'), '0.00005000')
  assert.equal(groupSats(1234567n), '1 234 567')
  assert.equal(parseSats('10 000'), 10000n)
  assert.equal(parseSats('0'), null)
  assert.equal(parseSats('1.5'), null)
  assert.equal(parseSats('-3'), null)
  assert.equal(parseSats('99999999999999999'), null)
})

test('backup check picks three distinct positions and needs all three right', () => {
  for (let i = 0; i < 200; i++) {
    const pos = pickCheckPositions(12)
    assert.equal(pos.length, CHECK_COUNT)
    assert.equal(new Set(pos).size, CHECK_COUNT)
    assert.ok(pos.every((p) => p >= 0 && p < 12))
    assert.deepEqual([...pos].sort((a, b) => a - b), pos)
  }
  let k = 0
  const seq = [0.99, 0.99, 0.0, 0.5]
  assert.deepEqual(pickCheckPositions(12, () => seq[k++ % seq.length]), [0, 6, 11])
  assert.equal(verifyBackup(WORDS, [0, 6, 11], ['abandon', ' Absorb ', 'accident']), true)
  assert.equal(verifyBackup(WORDS, [0, 6, 11], ['abandon', 'absorb', 'access']), false)
  assert.equal(verifyBackup(WORDS, [0, 6], ['abandon', 'absorb']), false)
  assert.equal(verifyBackup(WORDS, [0, 6, 12], ['abandon', 'absorb', 'x']), false)
  assert.throws(() => pickCheckPositions(2))
  assert.deepEqual([0, 1, 2, 10, 11, 12, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '11th', '12th', '13th', '22nd', '23rd'])
})

test('dust follows the output type: 294 sats P2WPKH, 330 sats P2WSH and P2TR', () => {
  assert.equal(dustFor('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', REGTEST), 294n)
  assert.equal(dustFor('bcrt1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qzf953q', REGTEST), 330n)
  assert.equal(dustFor('bcrt1pds4hgzedna3j3c2f0hajncxq35rxjuy99a65mywcqrzxp4s28jwsl5qyey', REGTEST), 330n)
  for (const a of ['bcrt1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qzf953q', 'bcrt1pds4hgzedna3j3c2f0hajncxq35rxjuy99a65mywcqrzxp4s28jwsl5qyey']) assert.equal(checkRecipient(a, REGTEST).ok, true)
})

test('an invoice with a fixed amount is paid exactly that amount', () => {
  for (const a of [{ Fungible: 25_000_000 }, '{"Fungible":25000000}', { type: 'Fungible', value: 25_000_000 }]) assert.equal(requestedAmount(a), 25_000_000)
  for (const a of ['Any', null, undefined, {}, { Fungible: 0 }, '{"NonFungible":1}', 'not json']) assert.equal(requestedAmount(a), null)
  const fmt = (u: bigint | number) => `${u}`
  assert.equal(amountMismatch(25_000_000, 25_000_000n, fmt), null)
  assert.match(amountMismatch(25_000_000, 2_500_000n, fmt)!, /asks for exactly 25000000; you entered 2500000/)
  assert.equal(amountMismatch(null, 1n, fmt), null)
})

test('the worklet\'s ambiguous-send error carries the signed txid and batch', () => {
  const txid = 'ab'.repeat(32)
  assert.deepEqual(parseAmbiguous(`Error: AMBIGUOUS_SEND:{"txid":"${txid}","batchTransferIdx":9} the payment was signed (proxy timeout)`), { txid, batchTransferIdx: 9 })
  assert.deepEqual(parseAmbiguous(`AMBIGUOUS_SEND:{"txid":"${txid}","batchTransferIdx":null} x`), { txid, batchTransferIdx: null })
  assert.equal(parseAmbiguous('RgbLib(InsufficientFunds)'), null)
  assert.equal(parseAmbiguous('AMBIGUOUS_SEND:{"txid":"zz"}'), null)
})

test('the native fetch refuses an x86_64 build: the worklet bundle and the pinned addon are arm64 only', () => {
  const r = spawnSync('bash', [join(import.meta.dirname, '../scripts/fetch-native.sh')], { env: { ...process.env, ABIS: 'arm64-v8a,x86_64' }, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /arm64-v8a only/)
})

test('on a public network every event carries the test-data labels, and only events naming the network are read', () => {
  assert.deepEqual(testLabelTags(REGTEST), [])
  assert.deepEqual(testLabelTags(MUTINYNET), [['network', 'mutinynet'], ['alt', 'Passbook test data: test USDT on mutinynet, no value. Not real USDT.']])
  assert.equal(eventOnNetwork([], REGTEST), true, 'a local relay carries only ours')
  assert.equal(eventOnNetwork([['network', 'mutinynet']], MUTINYNET), true)
  assert.equal(eventOnNetwork([['network', 'regtest']], MUTINYNET), false)
  assert.equal(eventOnNetwork([], MUTINYNET), false, 'an unlabelled event on a public relay is not ours')
})

test('a malformed relay in a provider link is reported, never thrown', () => {
  for (const relays of [['ws://'], ['ws:'], ['wss://relay.primal.net', 'ws://']]) {
    assert.doesNotThrow(() => overrideProblems('mutinynet', { relays }))
    assert.ok(overrideProblems('mutinynet', { relays }).length > 0, relays.join(','))
  }
  const r = parseProviderLink('passbookwallet://provider?network=mutinynet&relays=ws%3A%2F%2F')
  assert.ok('error' in r && /relay/.test(r.error))
})
