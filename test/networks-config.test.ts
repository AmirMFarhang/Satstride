// The credit section of passbook.config.yaml: read-only history chains, the
// device's source and the lender's own, separate from the loan chain.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, DEFAULT_CREDIT, loadConfig, parseConfig } from '../src/core/config.js'

const base = `scorer:\n  provider: in-process\n  min_trust_for_lenders: dev-inprocess\n  approved_builds: infra/scorer-releases.json\nsettlement:\n  default: cosign-rgb\n  enabled: [cosign-rgb]\nnegotiation:\n  enabled: true\n  max_rounds: 3\ncompliance:\n  identity: none\n  sanctions: none\n  consent_receipts: required\n  approvals: { maker_checker_above_usdt: 5000 }\n  data_retention_days: 0\nasset:\n  id_from: infra/state.json\n`
const parse = (extra: string) => parseConfig(base + extra, { checkFiles: false })

describe('credit config', () => {
  it('the repository config reads Bitcoin mainnet from mempool.space and lets the lender recompute from Blockstream', () => {
    const cfg = loadConfig('passbook.config.yaml', { checkFiles: false })
    assert.deepEqual(cfg.credit.history_chains, ['bitcoin'])
    assert.equal(cfg.credit.sources.bitcoin, 'https://mempool.space/api')
    assert.equal(cfg.credit.lender_sources.bitcoin, 'https://blockstream.info/api')
    assert.ok(cfg.credit.snapshot.endsWith('test/fixtures/networks/mainnet-snapshot.json'))
    assert.equal(cfg.credit.window_days, 365)
  })
  it('absent means the defaults', () => {
    assert.deepEqual(parse('').credit, DEFAULT_CREDIT)
  })
  it('refuses an unknown chain, a missing source, a lender source equal to the device source and a bad URL', () => {
    const bad = (yaml: string, re: RegExp) => assert.throws(() => parse(yaml), (e: ConfigError) => e.problems.some((p) => re.test(p)))
    bad(`credit:\n  history_chains: [ethereum]\n`, /unknown chain "ethereum"/)
    bad(`credit:\n  history_chains: [bitcoin, signet]\n`, /no source for history chain signet/)
    bad(`credit:\n  history_chains: [bitcoin]\n  sources: { bitcoin: 'https://e.example/api' }\n  lender_sources: { bitcoin: 'https://e.example/api' }\n`, /must differ/)
    bad(`credit:\n  history_chains: [bitcoin]\n  sources: { bitcoin: 'ftp://e.example' }\n`, /http\(s\) Esplora URL/)
    bad(`credit:\n  history_chains: [bitcoin]\n  window_days: 0\n`, /window_days/)
  })
})
