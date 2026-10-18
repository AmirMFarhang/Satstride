import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LenderAgent, L2_POLICY } from '../src/agents/lender.js'
import { PlatformClient } from '../src/agents/platform-client.js'
import type { Relay } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import type { BitcoindChain } from '../src/chain/bitcoind.js'
import { FakeChain } from '../src/chain/fake.js'
import { hashObject, keyPairFromLabel, signHash } from '../src/core/crypto.js'
import { signPassbook } from '../src/registry/passbook-doc.js'
import { Store } from '../src/registry/store.js'
import { InProcessSandbox } from '../src/sandbox/broker.js'
import { runSandbox } from '../src/sandbox/run.js'
import type { Bundle } from '../src/sandbox/types.js'
import { createApp } from '../src/server/app.js'
import type { Party } from '../src/wallet/party.js'
import { termInterest } from '../src/core/economics.js'

it('ignores adversarial model pricing numbers through complete underwriting and registered terms', async () => {
  const walletDir = mkdtempSync(join(tmpdir(), 'passbook-underwrite-unit-'))
  const chain = new FakeChain(280)
  const key = keyPairFromLabel('pricing-sandbox'), lender = keyPairFromLabel('pricing-lender'), platformKey = keyPairFromLabel('pricing-platform')
  const sandbox = new InProcessSandbox(key, chain, new RuleReasoner(), 30, platformKey.pubkey)
  const app = createApp({ chain, platformKey, sandbox, store: new Store(), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [] })
  const port = await app.api.listen(0, '127.0.0.1')
  const platform = new PlatformClient(`http://127.0.0.1:${port}`)
  try {
    const results = []
    for (const adjustment_bps of [-999_999, 999_999]) {
      const borrower = keyPairFromLabel(`pricing-borrower-${adjustment_bps}`)
      const ai = new RuleReasoner()
      ai.creditMemo = async () => ({ adjustment_bps, flags: [], memo: 'Adversarial model asks for a different price.' })
      const party = { role: 'lender2', key: lender, rgb: { dataDir: join(walletDir, 'rgb') } } as unknown as Party
      const policy = { ...L2_POLICY, d: `pricing-${adjustment_bps}`, requirements: { affordability: false, inflow_months: 0, inflow_multiple_bps: 0, investigation: 'optional' as const } }
      let payload: unknown
      const relay = { receive: async () => ({ payload, event: { pubkey: borrower.pubkey } }), send: async () => {}, close: () => {} } as unknown as Relay
      const agent = new LenderAgent({ party, platform, chain: chain as unknown as BitcoindChain, relay, reasoner: ai, policy, assetId: 'rgb:test', mine: async () => {} })
      const bundle: Bundle = { v: 1, borrower_pk: borrower.pubkey, own_pks: [], offer_id: agent.offerId, loan_request: { principal: 600e6, fee: termInterest({ principal: 600e6, apr_bps: policy.apr_bps, term_blocks: policy.term_blocks }), term_blocks: 30, grace_blocks: 5 }, lender_requirements: policy.requirements, balance: 1500e6, history: [], candidate_inflows: [], scheduled_outflows: [], collateral: { sats: 1_212_000, oracle_quote: await platform.quote(), allowed_ltv_bps: 5000 } }
      const result = await runSandbox(bundle, { key, chain, reasoner: ai, blocksPerMonth: 30, oraclePk: platformKey.pubkey })
      payload = { passbook: signPassbook(borrower, []), offer_id: agent.offerId, principal: 600e6, term_blocks: 30, sandbox_result: result.lender_result, attestation: (await platform.sandboxPubkey()).attestation, disclosed_inflows: [], disclosure_items: [], inflow_proofs: [], outstanding_statement: { outstanding_micro: 0, sig: signHash(hashObject({ outstanding_micro: 0 }), borrower.secretKey) } }
      const underwritten = await agent.underwrite()
      results.push(underwritten)
      assert.equal(underwritten.memo.adjustment_bps, adjustment_bps, 'the trace retains the ignored proposal')
      assert.equal(underwritten.memo.applied_bps, 50)
      agent.close()
    }
    for (const field of ['principal', 'fee', 'collateral_sats', 'ltv_bps', 'lender_pk', 'platform_pk', 'maturity_height'] as const) assert.equal(results[0].terms[field], results[1].terms[field], field)
    assert.equal(results[0].apr_bps, L2_POLICY.apr_bps + 50)
    assert.equal(app.store.allLoans().length, 2)
  } finally { await app.close(); rmSync(walletDir, { recursive: true, force: true }) }
})
