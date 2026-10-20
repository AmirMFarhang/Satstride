import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/core/config.js'

const run = (script: string, env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 })

describe('provider migration without a payment node', () => {
  it('sets up keys and configuration offline, keeps them stable and ignores old channel state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-provider-offline-'))
    try {
      const state = join(dir, 'state.json')
      writeFileSync(state, JSON.stringify({ asset: { id: 'rgb:test', ticker: 'USDT' }, parties: { lender1: { pubkey: 'aa'.repeat(32) } } }))
      const old = JSON.stringify({ channel: { channel_id: 'historic-channel', asset_local_amount: 10 } })
      writeFileSync(join(dir, 'rln.json'), old)
      const env = { PASSBOOK_SP_STATE: dir, PASSBOOK_STATE: state, PASSBOOK_SP_RLN_LENDER_URL: 'http://127.0.0.1:9', PASSBOOK_SP_RLN_CHECK_URL: 'http://127.0.0.1:9' }
      const first = run('infra/service-provider-setup.ts', env)
      assert.equal(first.status, 0, first.stderr)
      const setup = JSON.parse(first.stdout)
      assert.equal(setup.check_rail, 'bill-at-close')
      const secret = readFileSync(setup.operator_secret_file, 'utf8')
      const second = run('infra/service-provider-setup.ts', env)
      assert.equal(second.status, 0, second.stderr)
      assert.equal(readFileSync(setup.operator_secret_file, 'utf8'), secret)
      assert.equal(readFileSync(join(dir, 'rln.json'), 'utf8'), old, 'historical state is untouched')
      assert.deepEqual(loadConfig(setup.scorer_config, { checkFiles: false }).settlement.enabled, ['cosign-rgb'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('discovery never advertises a stale channel or mislabels an old check node as billed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-provider-discovery-'))
    try {
      writeFileSync(join(dir, 'rln.json'), JSON.stringify({ lender_ln_pubkey: 'old-lender', check_ln_pubkey: 'old-check', channel: { channel_id: 'old-channel' } }))
      const legacy = { name: 'old', operator_pk: 'bb'.repeat(32), payer_modes: ['lender'], status_url: 'http://127.0.0.1:4999/status', rails: ['RGB Lightning'] }
      writeFileSync(join(dir, 'check-node.json'), JSON.stringify(legacy))
      const env = { STATE: dir, LENDERS: 'none', NETWORK: 'regtest', PROJECT: 'offline-test' }
      let result = run('infra/service-provider-info.ts', env)
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout).check_nodes, [])
      writeFileSync(join(dir, 'check-node.json'), JSON.stringify({ ...legacy, rail_names: ['bill-at-close'] }))
      result = run('infra/service-provider-info.ts', env)
      assert.equal(result.status, 0, result.stderr)
      const info = JSON.parse(result.stdout)
      assert.equal(info.rails.lender_to_check_node.kind, 'bill-at-close')
      assert.equal(info.rails.lender_to_check_node.paid_up_front, false)
      assert.doesNotMatch(result.stdout, /old-channel|ln_node_pubkey|rgb-ln/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
