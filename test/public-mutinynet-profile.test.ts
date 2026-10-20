// infra/service-provider.sh PASSBOOK_SP_NETWORK=mutinynet (lane E1): the provider for two phones on Mutinynet,
// with no chain, Lightning node or lender of ours. These run no service: argument checks, the generated deployment
// config, and what provider.json, the QR payload and `env` tell the phones.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/core/config.js'
import { mutinynetProviderConfig } from '../infra/service-provider-mutinynet.js'

const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom']
const sh = (args: string[], env: Record<string, string>) => spawnSync('bash', ['infra/service-provider.sh', ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } })

describe('PASSBOOK_SP_NETWORK', () => {
  it('is regtest or mutinynet, never mainnet', () => {
    const r = sh(['status'], { PASSBOOK_SP_NETWORK: 'mainnet' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /regtest or mutinynet \(never mainnet\)/)
  })
  it('refuses a laptop lender on Mutinynet: the lender is a phone', () => {
    const r = sh(['status'], { PASSBOOK_SP_NETWORK: 'mutinynet', PASSBOOK_SP_LENDERS: 'lender1' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no laptop lender on Mutinynet/)
  })
})

describe('up on Mutinynet', () => {
  const mainTs = readFileSync('src/server/main.ts', 'utf8')
  const publicServices = /network\.public[^\n]*\{\s*\n\s*cfg\.repayments = await repaymentWatchFromEnv/.test(mainTs)
  it('refuses while the platform starts no RGB repayment watch or fee wallet on a public network', { skip: publicServices && 'src/server/main.ts starts them on public networks now' }, () => {
    const state = mkdtempSync(join(tmpdir(), 'passbook-sp-mutinynet-up-'))
    try {
      const r = sh(['up'], { PASSBOOK_SP_NETWORK: 'mutinynet', PASSBOOK_SP_STATE: state })
      assert.equal(r.status, 3, r.stderr)
      assert.match(r.stderr, /starts no RGB repayment watch or fee wallet on a public network/)
    } finally { rmSync(state, { recursive: true, force: true }) }
  })
})

describe('the Mutinynet deployment config', () => {
  it('is the Mutinynet profile with the local scorer and the public relays, and loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-mutinynet-config-'))
    try {
      for (const f of ['verify.cjs', 'keys.json', 'token']) writeFileSync(join(dir, f), '{}')
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ network: 'mutinynet', asset: { id: 'rgb:test', ticker: 'TUSDT', name: 'Passbook test USDT (mutinynet, no value)', precision: 6 } }))
      const text = mutinynetProviderConfig({ profile: resolve('infra/passbook.config.mutinynet.yaml'), relays: RELAYS, assetState: join(dir, 'state.json'), approvedBuilds: resolve('infra/scorer-releases.json') })
      writeFileSync(join(dir, 'c.yaml'), text)
      const c = loadConfig(join(dir, 'c.yaml'), { checkFiles: false })
      assert.equal(c.network.name, 'mutinynet')
      assert.equal(c.network.endpoints.esplora, 'https://esplora.signet.kaleidoswap.com')
      assert.equal(c.network.endpoints.rgb_proxy, 'rpcs://proxy.kaleidoswap.com/json-rpc')
      assert.deepEqual(c.network.endpoints.nostr, RELAYS)
      assert.equal(c.scorer.provider, 'in-process')
      assert.equal(c.scorer.fallback, 'none')
      assert.deepEqual(c.settlement.enabled, ['cosign-rgb'])
      assert.equal(c.economics.blocks_per_day, 1, 'the Mutinynet profile\'s economics, unchanged')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('what the phones read on Mutinynet', () => {
  function stateDir(): string {
    const state = mkdtempSync(join(tmpdir(), 'passbook-sp-mutinynet-'))
    mkdirSync(join(state, 'pids'))
    writeFileSync(join(state, 'mutinynet.json'), JSON.stringify({ v: 1, network: 'mutinynet', platform_pk: 'aa'.repeat(32), asset: { id: 'rgb:StqVXLez-test', ticker: 'TUSDT', name: 'Passbook test USDT (mutinynet, no value)', label: 'test USDT (mutinynet)' }, config: resolve('infra/passbook.config.mutinynet.yaml') }))
    return state
  }

  it('provider.json: public endpoints, the platform (LAN fallback, auth enforced), no lender, and a small QR payload', () => {
    const state = stateDir()
    try {
      const r = spawnSync('npx', ['tsx', 'infra/service-provider-info.ts'], { encoding: 'utf8', env: { ...process.env, NETWORK: 'mutinynet', STATE: state, PUBLIC_HOST: '192.168.1.20', PLATFORM_PORT: '4391', RELAY_PORT: '0', PROJECT: 'passbook-provider-mutinynet', LENDERS: 'none', PUBLIC_RELAYS: RELAYS.join(',') } })
      assert.equal(r.status, 0, r.stderr)
      const p = JSON.parse(r.stdout)
      assert.equal(p.network, 'mutinynet')
      assert.deepEqual(p.public_relays, RELAYS)
      assert.equal(p.endpoints.esplora, 'https://esplora.signet.kaleidoswap.com')
      assert.equal(p.endpoints.rgb_network, 'signet')
      assert.equal(p.platform.lan_url, 'http://192.168.1.20:4391')
      assert.equal(p.platform.api_auth, 'enforce')
      assert.equal(p.platform.pubkey, 'aa'.repeat(32))
      assert.deepEqual(p.lenders, [])
      assert.match(p.lender_note, /the lender is a phone/)
      assert.equal(p.asset.label, 'test USDT (mutinynet)')
      const qr = JSON.parse(readFileSync(join(state, 'provider-qr.json'), 'utf8'))
      assert.equal(qr.kind, 'passbook-provider')
      assert.equal(qr.network, 'mutinynet')
      assert.deepEqual(qr.relays, RELAYS)
      assert.equal(qr.platform.url, 'http://192.168.1.20:4391')
      assert.equal(qr.rgb_proxy, 'rpcs://proxy.kaleidoswap.com/json-rpc')
      assert.ok(JSON.stringify(qr).length < 1500, 'fits a phone-scannable QR code')
      assert.ok(!/secret|seed|mnemonic/i.test(JSON.stringify(p)), 'public data only')
      // the QR carries the phone's deep link (mobile E4), relay.primal.net first
      const link = new URL(p.phone_link)
      assert.equal(link.protocol, 'passbookwallet:')
      assert.equal(link.host, 'provider')
      assert.equal(link.searchParams.get('network'), 'mutinynet')
      assert.equal(link.searchParams.get('platform'), 'http://192.168.1.20:4391')
      assert.equal(link.searchParams.get('platform_pk'), 'aa'.repeat(32))
      assert.equal(link.searchParams.get('proxy'), 'rpcs://proxy.kaleidoswap.com/json-rpc')
      assert.deepEqual(link.searchParams.get('relays')!.split(','), ['wss://relay.primal.net', 'wss://nos.lol', 'wss://nostr.mom'])
      assert.equal(readFileSync(join(state, 'provider-link.txt'), 'utf8').trim(), p.phone_link)
      assert.ok(p.phone_link.length < 400, 'a small QR code')
    } finally { rmSync(state, { recursive: true, force: true }) }
  })

  it('env prints the Mutinynet endpoints and the platform for the phones', () => {
    const state = stateDir()
    try {
      writeFileSync(join(state, 'provider.json'), JSON.stringify({ network: 'mutinynet', platform_url: 'http://192.168.1.20:4391', platform: { pubkey: 'aa'.repeat(32), relays: RELAYS }, public_relays: RELAYS, endpoints: { esplora: 'https://esplora.signet.kaleidoswap.com', rgb_indexer: 'https://esplora.signet.kaleidoswap.com', rgb_proxy: 'rpcs://proxy.kaleidoswap.com/json-rpc' }, asset: { asset_id: 'rgb:x' }, check_nodes: [{ operator_pk: 'bb'.repeat(32) }] }))
      const r = sh(['env'], { PASSBOOK_SP_NETWORK: 'mutinynet', PASSBOOK_SP_STATE: state })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /export PASSBOOK_SP_NETWORK=mutinynet/)
      assert.match(r.stdout, /export PASSBOOK_PLATFORM_URL=http:\/\/192\.168\.1\.20:4391/)
      assert.match(r.stdout, /export PASSBOOK_RGB_PROXY_URL=rpcs:\/\/proxy\.kaleidoswap\.com\/json-rpc/)
      assert.match(r.stdout, /export PASSBOOK_PUBLIC_RELAYS=wss:\/\/nos\.lol,wss:\/\/relay\.primal\.net,wss:\/\/nostr\.mom/)
      assert.match(r.stdout, new RegExp(`export PASSBOOK_CHECK_NODE_PKS=${'bb'.repeat(32)}`))
      assert.ok(!/BITCOIND_URL/.test(r.stdout), 'no chain of ours on Mutinynet')
    } finally { rmSync(state, { recursive: true, force: true }) }
  })
})

describe('test USDT for the phones (infra/public-mutinynet-fund.ts)', async () => {
  const { invoiceProblem, parseUsdt } = await import('../infra/public-mutinynet-fund.js')
  it('takes whole test USDT with six decimals, within a test float', () => {
    assert.equal(parseUsdt('50'), 50_000_000)
    assert.equal(parseUsdt('0.5'), 500_000)
    assert.throws(() => parseUsdt('0'), /between/)
    assert.throws(() => parseUsdt('1000'), /between 0 and 500/)
    assert.throws(() => parseUsdt('1.1234567'), /six decimals/)
  })
  it('refuses an invoice for another network, another asset or another amount', () => {
    assert.equal(invoiceProblem({ network: 'Signet', assetId: 'rgb:a' }, 'rgb:a', 1), null)
    assert.match(invoiceProblem({ network: 'Regtest' }, 'rgb:a', 1)!, /not Mutinynet/)
    assert.match(invoiceProblem({ assetId: 'rgb:b' }, 'rgb:a', 1)!, /names asset rgb:b/)
    assert.match(invoiceProblem({ assignment: { type: 'Fungible', value: 2_000_000 } }, 'rgb:a', 1_000_000)!, /asks for 2/)
    assert.equal(invoiceProblem({ assignment: { type: 'Fungible', value: 1_000_000 } }, 'rgb:a', 1_000_000), null)
    // the decoder's other shape, { Fungible: n } (src/wallet/panel.ts reads both)
    assert.match(invoiceProblem({ assignment: { Fungible: 2_000_000 } }, 'rgb:a', 1_000_000)!, /asks for 2/)
    assert.equal(invoiceProblem({ assignment: { Fungible: 1_000_000 } }, 'rgb:a', 1_000_000), null)
    assert.match(invoiceProblem({ assignment: { Fungible: 'lots' } }, 'rgb:a', 1_000_000)!, /cannot be read/)
  })
})
