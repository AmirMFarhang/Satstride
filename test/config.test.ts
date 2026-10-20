import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ConfigError, deploymentConfigFromEnv, describeConfig, loadConfig, parseConfig, parseYamlSubset } from '../src/core/config.js'
import { FakeChain } from '../src/chain/fake.js'
import { Store } from '../src/registry/store.js'
import { createApp } from '../src/server/app.js'
import { complianceFromConfig, complianceGate, NoIdentityProvider, NoSanctionsScreen } from '../src/compliance/hooks.js'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { LocalKeySigner, signWith, verifySigned, WdkSigner } from '../src/wallet/signer.js'
import { partyKey } from '../src/wallet/party.js'

const REPO_CONFIG = fileURLToPath(new URL('../passbook.config.yaml', import.meta.url))

const VALID = `
scorer:
  provider: external
  fallback: container
  min_trust_for_lenders: software-evidence
  approved_builds: infra/scorer-releases.json
  external:
    package: '@private/scorer'
    options_file: infra/provider-options.json
settlement:
  default: cosign-rgb
  enabled: [cosign-rgb, ln-rln]
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

function problems(text: string): string[] {
  try {
    parseConfig(text, { checkFiles: false })
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${(err as Error).message}`)
    return err.problems
  }
  return []
}

describe('deployment config', () => {
  it('loads the repository config and resolves paths against its directory', () => {
    const cfg = loadConfig(REPO_CONFIG)
    assert.equal(cfg.scorer.provider, 'in-process')
    assert.equal(cfg.scorer.fallback, 'none')
    assert.equal(cfg.scorer.min_trust_for_lenders, 'dev-inprocess')
    assert.ok(cfg.scorer.approved_builds.endsWith('/infra/scorer-releases.json'))
    assert.deepEqual(cfg.settlement, { default: 'cosign-rgb', enabled: ['cosign-rgb', 'ln-rln'] })
    assert.deepEqual(cfg.negotiation, { enabled: true, max_rounds: 3, concession_bps: 2500 })
    assert.equal(cfg.compliance.approvals.maker_checker_above_micro, 5_000_000_000)
    assert.match(describeConfig(cfg), /scorer in-process; lenders need dev-inprocess; settlement cosign-rgb/)
  })

  it('validates installed external-provider configuration and refuses missing private options', () => {
    const cfg=parseConfig(VALID,{checkFiles:false})
    assert.equal(cfg.scorer.provider,'external');assert.equal(cfg.scorer.external?.package,'@private/scorer')
    assert.ok(problems(VALID.replace("package: '@private/scorer'","package: '../unsafe/module'" )).some(p=>p.includes('installed package')))
  })

  it('parses the YAML subset: nesting, inline lists and maps, comments, quotes', () => {
    assert.deepEqual(parseYamlSubset('a:\n  b: 1 # note\n  c: [x, "y z"]\n  d: { e: true }\nf: \'#not a comment\'\n'), { a: { b: 1, c: ['x', 'y z'], d: { e: true } }, f: '#not a comment' })
  })

  it('refuses YAML outside the subset instead of guessing', () => {
    for (const bad of ['a:\n\tb: 1', 'a:\n - b', 'a: yes', 'a: 1.5', 'a: 1\na: 2', 'a:\n   b: 1', 'a: [1, 2', 'a: b: c', 'a:']) {
      assert.throws(() => parseYamlSubset(bad), Error, bad)
    }
  })

  it('names every problem at once, including unknown keys and typos', () => {
    const found = problems(VALID.replace('max_rounds: 3', 'max_round: 3').replace('provider: external', 'provider: compx').replace('id_from: infra/state.json', 'id_from: infra/state.json\n  extra: 1'))
    assert.ok(found.some((p) => p.includes('negotiation.max_round: unknown setting')))
    assert.ok(found.some((p) => p.includes('negotiation.max_rounds: must be an integer')))
    assert.ok(found.some((p) => p.includes('scorer.provider: must be one of')))
    assert.ok(found.some((p) => p.includes('asset.extra: unknown setting')))
  })

  it('refuses a provider that can never meet the lenders\u2019 minimum trust', () => {
    assert.ok(problems(VALID.replace('provider: external', 'provider: container').replace('fallback: container', 'fallback: none')).some((p) => /at most dev-inprocess, below .* software-evidence/.test(p)))
    assert.deepEqual(problems(VALID.replace('provider: external', 'provider: container').replace('fallback: container', 'fallback: in-process').replace('min_trust_for_lenders: software-evidence', 'min_trust_for_lenders: dev-inprocess')), [])
    assert.ok(problems(VALID.replace('min_trust_for_lenders: software-evidence', 'min_trust_for_lenders: tee-simulated')).some((p) => p.includes('min_trust_for_lenders: must be one of dev-inprocess | software-evidence | hardware-attested')))
  })

  it('requires explicit external settings and a distinct fallback',()=>{
    assert.ok(problems(VALID.replace(/  external:\n(    .*\n){2}/,'')).some(p=>p.includes('scorer.external')))
    assert.ok(problems(VALID.replace('fallback: container','fallback: external')).some(p=>p.includes('scorer.fallback')))
  })

  it('refuses the roadmap Nitro backend and unbuilt settlement kinds at startup', () => {
    assert.ok(problems(VALID.replace('provider: external', 'provider: external-nitro')).some((p) => p.includes('must be one of')))
    assert.ok(problems(VALID.replace('[cosign-rgb, ln-rln]', '[cosign-rgb, onchain-swap]')).some((p) => p.includes('onchain-swap is not built')))
  })

  it('keeps cosign-rgb enabled as the fallback and the default inside the enabled set', () => {
    assert.ok(problems(VALID.replace('[cosign-rgb, ln-rln]', '[ln-rln]').replace('default: cosign-rgb', 'default: ln-rln')).some((p) => p.includes('must include cosign-rgb')))
    assert.ok(problems(VALID.replace('[cosign-rgb, ln-rln]', '[cosign-rgb]').replace('default: cosign-rgb', 'default: ln-rln')).some((p) => p.includes('settlement.default: ln-rln is not in settlement.enabled')))
    assert.ok(problems(VALID.replace('[cosign-rgb, ln-rln]', '[cosign-rgb, cosign-rgb]')).some((p) => p.includes('listed twice')))
  })

  it('fixes zero retention and refuses compliance hooks that are not implemented', () => {
    assert.ok(problems(VALID.replace('data_retention_days: 0', 'data_retention_days: 30')).some((p) => p.includes('must be 0')))
    assert.ok(problems(VALID.replace('sanctions: none', 'sanctions: opensanctions')).some((p) => p.includes('not integrated')))
    assert.ok(problems(VALID.replace('identity: none', 'identity: provider:acme')).some((p) => p.includes('no implementation')))
  })

  it('refuses a missing release manifest when file checks are on', () => {
    assert.throws(() => parseConfig(VALID, { baseDir: '/nonexistent-passbook-dir' }), /approved_builds: .* does not exist/)
    assert.throws(() => loadConfig('/nonexistent-passbook-dir/passbook.config.yaml'), /file not found/)
  })
})

describe('deployment config at process start', () => {
  it('loads PASSBOOK_CONFIG or ./passbook.config.yaml, refuses an invalid one, and defaults only when none exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-cfg-'))
    try {
      assert.equal(deploymentConfigFromEnv({}, dir), null)
      writeFileSync(join(dir, 'passbook.config.yaml'), 'scorer:\n  provider: nope\n')
      assert.throws(() => deploymentConfigFromEnv({}, dir), ConfigError)
      assert.throws(() => deploymentConfigFromEnv({ PASSBOOK_CONFIG: join(dir, 'missing.yaml') }, dir), /file not found/)
      assert.equal(deploymentConfigFromEnv({ PASSBOOK_CONFIG: REPO_CONFIG }, dir)?.scorer.provider, 'in-process')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the platform publishes the active deployment and builds its compliance hooks from it', async () => {
    const deployment = loadConfig(REPO_CONFIG)
    const app = createApp({ platformKey: keyPairFromLabel('cfg-platform'), store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], deployment })
    try {
      const port = await app.api.listen(0, '127.0.0.1')
      const state = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as { deployment: { summary: string; settlement: { enabled: string[] }; compliance: { identity: string } } }
      assert.equal(state.deployment.summary, describeConfig(deployment))
      assert.deepEqual(state.deployment.settlement.enabled, ['cosign-rgb', 'ln-rln'])
      assert.equal(state.deployment.compliance.identity, 'none')
      assert.ok(app.compliance.identity instanceof NoIdentityProvider)
    } finally {
      await app.close()
    }
  })
})

describe('deployment economics at runtime', () => {
  it('the platform enforces and publishes the economics the deployment config sets', async () => {
    const deployment = parseConfig(readFileSync(REPO_CONFIG, 'utf8').replace('max_apr_bps: 1900', 'max_apr_bps: 1500').replace('platform_share_bps: 1500', 'platform_share_bps: 1000'), { baseDir: dirname(REPO_CONFIG) })
    const app = createApp({ platformKey: keyPairFromLabel('cfg-econ-platform'), store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], deployment })
    try {
      const port = await app.api.listen(0, '127.0.0.1')
      const state = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as { economics: { max_apr_bps: number; platform_share_bps: number } }
      assert.deepEqual({ max_apr_bps: state.economics.max_apr_bps, platform_share_bps: state.economics.platform_share_bps }, { max_apr_bps: 1500, platform_share_bps: 1000 })
    } finally {
      await app.close()
    }
    assert.throws(() => createApp({ platformKey: keyPairFromLabel('cfg-econ-platform'), store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], deployment, economics: { ...deployment.economics, max_apr_bps: 1900 } }), /economics: the app config and the deployment config disagree/)
  })
})

describe('compliance hooks and signer port', () => {
  it('reports not_checked and not_screened instead of a clean result', async () => {
    const hooks = complianceFromConfig(parseConfig(VALID, { checkFiles: false }))
    assert.ok(hooks.identity instanceof NoIdentityProvider && hooks.sanctions instanceof NoSanctionsScreen)
    const pk = keyPairFromLabel('compliance-subject').pubkey
    const gate = complianceGate(await hooks.identity.check(pk), await hooks.sanctions.screen({ pk }))
    assert.equal(gate.ok, true)
    assert.match(gate.detail, /identity not_checked \(none\); sanctions not_screened \(none\)/)
    assert.equal(complianceGate({ status: 'verified', provider: 'x' }, { status: 'hit', list: 'eu' }).ok, false)
  })

  it('derives the WDK party key exactly like the agents and signs through the port', async () => {
    const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const wdk = new WdkSigner(seed)
    assert.equal(wdk.pubkey, partyKey(seed).pubkey)
    const signed = await signWith(wdk, { hello: 'world' })
    assert.ok(verifySigned(signed, wdk.pubkey))
    assert.ok(!verifySigned({ ...signed, hello: 'other' }, wdk.pubkey))
    const local = new LocalKeySigner(keyPairFromLabel('signer-port'))
    assert.ok(!verifySigned(await signWith(local, { a: 1 }), wdk.pubkey))
    assert.throws(() => new WdkSigner('not a seed phrase'), /BIP-39/)
  })
})
