// Network profiles (src/core/network.ts): regtest is the default; a mainnet
// profile does not exist and refuses to start; a mixed network (endpoints from
// two chains) refuses to start, statically from known hosts and live from the
// genesis/marker blocks each endpoint reports.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ConfigError, loadConfig, parseConfig } from '../src/core/config.js'
import { headerHash, knownNetworkOf, NETWORKS, networkProblems, networkProfile, NetworkError, probeNetwork, type ProbeIo } from '../src/core/network.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = `
scorer:
  provider: in-process
  fallback: none
  min_trust_for_lenders: dev-inprocess
  approved_builds: infra/scorer-releases.json
settlement:
  default: cosign-rgb
  enabled: [cosign-rgb]
negotiation:
  enabled: true
  max_rounds: 3
compliance:
  identity: none
  sanctions: none
  consent_receipts: required
  approvals: { maker_checker_above_usdt: 5000 }
  data_retention_days: 0
asset:
  id_from: infra/state.json
`
const MUTINY = `network: mutinynet
endpoints:
  esplora: https://esplora.signet.kaleidoswap.com
  rgb_indexer: https://esplora.signet.kaleidoswap.com
  rgb_proxy: rpcs://proxy.kaleidoswap.com/json-rpc
  nostr: []
`

function problems(text: string): string[] {
  try {
    parseConfig(text, { checkFiles: false })
  } catch (err) {
    assert.ok(err instanceof ConfigError, (err as Error).message)
    return err.problems
  }
  return []
}

const GENESIS = { regtest: NETWORKS.regtest.identity.genesis, signet: NETWORKS.mutinynet.identity.genesis, testnet4: NETWORKS.testnet4.identity.genesis }
const MUTINY_1 = NETWORKS.mutinynet.identity.marker!.hash
const DEFAULT_SIGNET_1 = '00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53'

/** Fake endpoints: each base URL answers as the chain given. */
function io(chains: Record<string, { genesis: string; block1?: string }>, proxyOk = true): ProbeIo {
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && /json-rpc/.test(url)) return new Response(JSON.stringify(proxyOk ? { result: { protocol_version: '0.2', version: '0.3.0' } } : { error: 'nope' }))
    for (const [base, c] of Object.entries(chains)) {
      if (!url.startsWith(base)) continue
      const h = Number(url.split('/block-height/')[1])
      return new Response(h === 0 ? c.genesis : (c.block1 ?? 'ff'.repeat(32)))
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetch: fetchImpl, electrum: async () => { throw new Error('no electrum in this test') } }
}

describe('network profiles', () => {
  it('defaults to regtest, which stays the CI network and the live demo', () => {
    const cfg = parseConfig(BASE, { checkFiles: false })
    assert.equal(cfg.network.name, 'regtest')
    assert.equal(cfg.network.public, false)
    assert.match(cfg.network.endpoints.rgb_indexer, /^tcp:\/\/127\.0\.0\.1:\d+$/)
    const repo = loadConfig(join(ROOT, 'passbook.config.yaml'))
    assert.equal(repo.network.name, 'regtest')
  })

  it('labels test coins as test coins on every profile: never plain USDT or BTC', () => {
    for (const spec of Object.values(NETWORKS)) {
      assert.match(spec.assetLabel, new RegExp(`^test USDT \\(${spec.label}\\)$`))
      assert.match(spec.coinLabel, new RegExp(`^${spec.label} BTC$`))
    }
  })

  it('refuses a mainnet profile: it does not exist', () => {
    for (const name of ['mainnet', 'bitcoin', 'main']) {
      const p = problems(`${BASE}network: ${name}\n`)
      assert.equal(p.length, 1, p.join('\n'))
      assert.match(p[0], /has no profile in this release; Passbook refuses to start on mainnet/)
    }
    assert.throws(() => networkProfile('mainnet' as never), NetworkError)
    assert.match(problems(`${BASE}network: signet\n`)[0], /must be one of regtest \| mutinynet \| testnet4/)
  })

  it('refuses a mixed network: a testnet4 node with a Mutinynet indexer', () => {
    const p = problems(`${BASE}network: testnet4
endpoints:
  esplora: https://mempool.space/testnet4/api
  rgb_indexer: https://esplora.signet.kaleidoswap.com
  rgb_proxy: rpcs://proxy.kaleidoswap.com/json-rpc
`)
    assert.deepEqual(p, ['endpoints.rgb_indexer: https://esplora.signet.kaleidoswap.com serves mutinynet, not testnet4; refusing a mixed network'])
    // and the other way round, and a mainnet Esplora on a test profile
    assert.match(problems(`${BASE}${MUTINY.replace('esplora: https://esplora.signet.kaleidoswap.com', 'esplora: https://mempool.space/testnet4/api')}`)[0], /serves testnet4, not mutinynet/)
    assert.match(problems(`${BASE}${MUTINY.replace('esplora: https://esplora.signet.kaleidoswap.com', 'esplora: https://mempool.space/api')}`)[0], /serves mainnet, not mutinynet/)
    assert.equal(knownNetworkOf('https://mutinynet.com/api'), 'mutinynet')
    assert.equal(knownNetworkOf('https://blockstream.info/testnet/api'), 'testnet3')
  })

  it('needs every endpoint on a public network, and only local endpoints on regtest', () => {
    const p = problems(`${BASE}network: mutinynet\n`)
    assert.ok(p.some((x) => /mutinynet needs bitcoin_rpc or esplora/.test(x)))
    assert.ok(p.some((x) => /rgb_indexer: required on mutinynet/.test(x)))
    assert.ok(p.some((x) => /rgb_proxy: required on mutinynet/.test(x)))
    assert.match(problems(`${BASE}network: regtest\nendpoints:\n  rgb_indexer: tcp://electrum.example.com:50001\n`)[0], /regtest endpoints must be local or private hosts/)
    assert.match(problems(`${BASE}network: regtest\nendpoints:\n  rgb_proxy: http://127.0.0.1:3010/json-rpc\n`)[0], /rgb_proxy: must be an rpc:\/\/ or rpcs:\/\/ URL/)
    assert.match(problems(`${BASE}network: regtest\nendpoints:\n  wallet: x\n`)[0], /endpoints.wallet: unknown endpoint/)
  })

  it('loads the shipped Mutinynet profile with KaleidoSwap endpoints', () => {
    const cfg = loadConfig(join(ROOT, 'infra/passbook.config.mutinynet.yaml'), { checkFiles: false })
    assert.equal(cfg.network.name, 'mutinynet')
    assert.equal(cfg.network.rgbNetwork, 'signet')
    assert.equal(cfg.network.endpoints.esplora, 'https://esplora.signet.kaleidoswap.com')
    assert.equal(cfg.network.endpoints.rgb_proxy, 'rpcs://proxy.kaleidoswap.com/json-rpc')
    assert.equal(cfg.network.explorer, 'https://mutinynet.com')
    assert.deepEqual(networkProblems('mutinynet', cfg.network.endpoints), [])
  })

  it('probes every endpoint live and refuses one that serves another chain', async () => {
    const mutiny = parseConfig(`${BASE}${MUTINY}`, { checkFiles: false }).network
    const good = await probeNetwork(mutiny, io({ 'https://esplora.signet.kaleidoswap.com': { genesis: GENESIS.signet, block1: MUTINY_1 } }))
    assert.deepEqual(good.map((r) => [r.endpoint, r.ok]), [['esplora', true], ['rgb_indexer', true], ['rgb_proxy', true]])
    assert.match(good[0].saw, /mutinynet/)
    // an Esplora that turns out to be testnet4, and a default-signet one (same genesis as every signet)
    await assert.rejects(probeNetwork(mutiny, io({ 'https://esplora.signet.kaleidoswap.com': { genesis: GENESIS.testnet4 } })), (err: NetworkError) => /testnet4; the mutinynet profile needs mutinynet/.test(err.message))
    await assert.rejects(probeNetwork(mutiny, io({ 'https://esplora.signet.kaleidoswap.com': { genesis: GENESIS.signet, block1: DEFAULT_SIGNET_1 } })), /default signet; the mutinynet profile needs mutinynet/)
    await assert.rejects(probeNetwork(mutiny, io({})), /esplora https:\/\/esplora.signet.kaleidoswap.com: unreachable/)
    await assert.rejects(probeNetwork(mutiny, io({ 'https://esplora.signet.kaleidoswap.com': { genesis: GENESIS.signet, block1: MUTINY_1 } }, false)), /rgb_proxy .*no server.info answer/)
  })

  it('reads an Electrum header as its block hash (regtest genesis)', () => {
    const header = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000'
    assert.equal(headerHash(header), GENESIS.regtest)
  })

  it('refuses to start the server process on a mainnet or mixed profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-net-'))
    try {
      const cases: [string, RegExp][] = [
        [`${BASE.replaceAll('infra/', `${ROOT}infra/`)}network: mainnet\n`, /refuses to start on mainnet/],
        [`${BASE.replaceAll('infra/', `${ROOT}infra/`)}network: testnet4\nendpoints:\n  esplora: https://mempool.space/testnet4/api\n  rgb_indexer: https://mutinynet.com/api\n  rgb_proxy: rpcs://proxy.kaleidoswap.com/json-rpc\n`, /serves mutinynet, not testnet4/],
      ]
      for (const [i, [text, want]] of cases.entries()) {
        const file = join(dir, `bad-${i}.yaml`)
        writeFileSync(file, text)
        const run = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/server/main.ts')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PASSBOOK_CONFIG: file, PORT: '0', PASSBOOK_CHAIN: 'fake', BITCOIND_URL: '' } })
        assert.notEqual(run.status, 0, `server started on ${want}`)
        assert.match(run.stderr, want)
        assert.doesNotMatch(run.stdout, /passbook platform on/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
