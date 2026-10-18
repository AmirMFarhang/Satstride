// `infra/service-provider.sh env` exports what the laptop clients actually read (Relay: PASSBOOK_RELAYS,
// PlatformClient: PASSBOOK_URL, the chain and RGB endpoints, the state paths), plus the phone-facing names.
// No Docker project is started: `env` only reads provider.json and the configured ports.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

describe('infra/service-provider.sh env', () => {
  it('exports the client variables for the configured ports and the phone-facing names', () => {
    const state = mkdtempSync(join(tmpdir(), 'passbook-sp-env-'))
    try {
      writeFileSync(join(state, 'provider.json'), JSON.stringify({ relay_url: 'ws://127.0.0.1:7997', platform_url: 'http://127.0.0.1:4351', lenders: [{ pubkey: 'aa'.repeat(32) }], check_nodes: [{ operator_pk: 'bb'.repeat(32) }] }))
      const r = spawnSync('bash', ['infra/service-provider.sh', 'env'], { encoding: 'utf8', env: { ...process.env, PASSBOOK_SP_STATE: state, PASSBOOK_SP_PROJECT: 'passbook-sp-envtest-none', PASSBOOK_SP_RELAY_PORT: '7997', PASSBOOK_SP_PLATFORM_PORT: '4351', PASSBOOK_SP_BITCOIND_PORT: '18663', PASSBOOK_SP_ELECTRS_PORT: '50231' } })
      assert.equal(r.status, 0, r.stderr)
      // Evaluate the exports the way `eval "$(infra/service-provider.sh env)"` would, then read them back.
      const shown = spawnSync('bash', ['-c', `${r.stdout}\nenv`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PASSBOOK_LENDER_LIGHTNING_URL: 'http://retired.invalid', PASSBOOK_SP_RLN_CHECK_URL: 'http://retired.invalid' } }).stdout
      const env = Object.fromEntries(shown.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      assert.equal(env.PASSBOOK_RELAYS, 'ws://127.0.0.1:7997', 'Relay reads PASSBOOK_RELAYS')
      assert.equal(env.PASSBOOK_URL, 'http://127.0.0.1:4351', 'PlatformClient reads PASSBOOK_URL')
      assert.equal(env.BITCOIND_URL, 'http://127.0.0.1:18663')
      assert.equal(env.RGB_INDEXER_URL, 'tcp://127.0.0.1:50231')
      assert.equal(env.PASSBOOK_LENDER_LIGHTNING_URL, undefined)
      assert.equal(env.PASSBOOK_SP_RLN_CHECK_URL, undefined)
      assert.equal(env.PASSBOOK_STATE, join(state, 'state.json'))
      assert.equal(env.PASSBOOK_WALLETS, join(state, 'wallets'))
      assert.equal(env.PASSBOOK_SP_STATE, state)
      assert.equal(env.PASSBOOK_RELAY_URL, 'ws://127.0.0.1:7997', 'the phone-facing name stays')
      assert.equal(env.PASSBOOK_PLATFORM_URL, 'http://127.0.0.1:4351')
      assert.equal(env.PASSBOOK_LENDER_PKS, 'aa'.repeat(32))
      assert.equal(env.PASSBOOK_CHECK_NODE_PKS, 'bb'.repeat(32))
      // Host wallets' RGB invoices name the proxy where the phone reaches it (adb reverse), not a Docker bridge address.
      assert.equal(env.RGB_TRANSPORT_URL, 'rpc://127.0.0.1:3330/json-rpc')
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })

  it('names the phone-reachable proxy and exports no retired payment endpoint', () => {
    const state = mkdtempSync(join(tmpdir(), 'passbook-sp-env-'))
    try {
      writeFileSync(join(state, 'provider.json'), JSON.stringify({ relay_url: 'ws://192.168.1.20:7997', platform_url: 'http://192.168.1.20:4351', lenders: [], check_nodes: [] }))
      const r = spawnSync('bash', ['infra/service-provider.sh', 'env'], { encoding: 'utf8', env: { ...process.env, PASSBOOK_SP_STATE: state, PASSBOOK_SP_PROJECT: 'passbook-sp-envtest-none', PASSBOOK_SP_PROXY_PORT: '3999', PASSBOOK_SP_PUBLIC_HOST: '192.168.1.20' } })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /export RGB_TRANSPORT_URL=rpc:\/\/192\.168\.1\.20:3999\/json-rpc\n/)
      assert.doesNotMatch(r.stdout, /export [^\n]*(?:LIGHTNING|RLN|PASSBOOK_CHECK_PROXY)/)
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })
})
