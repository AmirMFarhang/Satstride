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
import { hashObject, keyPairFromLabel, signHash, signObject, verifyObject } from '../src/core/crypto.js'
import { collateralFor } from '../src/core/money.js'
import type { ApplicationPayload } from '../src/market/messages.js'
import { signPassbook } from '../src/registry/passbook-doc.js'
import { Store } from '../src/registry/store.js'
import { InProcessSandbox } from '../src/sandbox/broker.js'
import { runSandbox } from '../src/sandbox/run.js'
import type { Bundle } from '../src/sandbox/types.js'
import { createApp } from '../src/server/app.js'
import type { Party } from '../src/wallet/party.js'
import { termInterest } from '../src/core/economics.js'

it('rejects replaying a genuine 600-USDT sandbox approval for a larger application before accepting or registering it', async () => {
  const walletDir = mkdtempSync(join(tmpdir(), 'passbook-underwrite-unit-'))
  const chain = new FakeChain(280)
  const key = keyPairFromLabel('request-binding-sandbox')
  const lender = keyPairFromLabel('request-binding-lender')
  const borrower = keyPairFromLabel('request-binding-borrower')
  const platformKey = keyPairFromLabel('request-binding-platform')
  const reasoner = new RuleReasoner()
  const sandbox = new InProcessSandbox(key, chain, reasoner, 30, platformKey.pubkey)
  const app = createApp({ chain, platformKey, sandbox, store: new Store(), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [] })
  const port = await app.api.listen(0, '127.0.0.1')
  const platform = new PlatformClient(`http://127.0.0.1:${port}`)
  let payload: ApplicationPayload
  let accepted = 0
  let modelMemoCalls = 0
  const originalMemo = reasoner.creditMemo.bind(reasoner)
  reasoner.creditMemo = async (input) => { modelMemoCalls++; return originalMemo(input) }
  const relay = { receive: async () => ({ payload, event: { pubkey: borrower.pubkey } }), send: async () => { accepted++ }, close: () => {} } as unknown as Relay
  const agent = new LenderAgent({ party: { role: 'lender2', key: lender, rgb: { dataDir: join(walletDir, 'rgb') } } as unknown as Party, platform, chain: chain as unknown as BitcoindChain, relay, reasoner, policy: L2_POLICY, assetId: 'rgb:request-binding', mine: async () => {} })
  try {
    const principal = 600_000_000
    const fee = termInterest({ principal, apr_bps: L2_POLICY.apr_bps, term_blocks: L2_POLICY.term_blocks })
    const quote = await platform.quote()
    const bundle: Bundle = {
      v: 1, borrower_pk: borrower.pubkey, own_pks: [], offer_id: agent.offerId,
      loan_request: { principal, fee, term_blocks: L2_POLICY.term_blocks, grace_blocks: L2_POLICY.grace_blocks },
      lender_requirements: L2_POLICY.requirements, balance: 900_000_000,
      history: [], candidate_inflows: [], scheduled_outflows: [],
      collateral: { sats: collateralFor(principal + fee, 5000, quote.price_cents), oracle_quote: quote, allowed_ltv_bps: 5000 },
    }
    const cfg = { key, chain, reasoner, blocksPerMonth: 30, oraclePk: platformKey.pubkey }
    const submitted = { ...bundle, loan_request: { ...bundle.loan_request, unapproved_private_note: 'private-request-marker' } }
    const result = await runSandbox(submitted, cfg)
    const signed = result.lender_result!
    assert.ok(verifyObject(result, key.pubkey))
    assert.ok(verifyObject(signed, key.pubkey))
    assert.deepEqual(signed.loan_request, bundle.loan_request)
    assert.ok(!JSON.stringify(signed).includes('private-request-marker'), 'only the four public request fields leave the box')
    assert.ok(result.checks.every((check) => check.ok), JSON.stringify(result.checks))
    assert.equal(result.checks.find((check) => check.id === 'affordability')!.ok, true)

    const larger = 1_200_000_000
    const largerFee = termInterest({ principal: larger, apr_bps: L2_POLICY.apr_bps, term_blocks: L2_POLICY.term_blocks })
    const checkedLarger = await runSandbox({ ...bundle,
      loan_request: { ...bundle.loan_request, principal: larger, fee: largerFee },
      collateral: { ...bundle.collateral, sats: collateralFor(larger + largerFee, 5000, quote.price_cents) },
    }, cfg)
    assert.equal(checkedLarger.checks.find((check) => check.id === 'affordability')!.ok, false, 'the same wallet cannot afford the larger application')

    const application: ApplicationPayload = {
      passbook: signPassbook(borrower, []), offer_id: agent.offerId, principal, term_blocks: L2_POLICY.term_blocks,
      sandbox_result: signed, attestation: (await platform.sandboxPubkey()).attestation,
      disclosed_inflows: [], disclosure_items: [], inflow_proofs: [],
      outstanding_statement: { outstanding_micro: 0, sig: signHash(hashObject({ outstanding_micro: 0 }), borrower.secretKey) },
    }
    payload = { ...application, principal: larger }
    await assert.rejects(agent.underwrite(), /sandbox-request/)
    assert.equal(app.store.allLoans().length, 0)
    assert.equal(accepted, 0)
    assert.equal(modelMemoCalls, 0)

    // Every request field is signed. A borrower cannot edit the old approval.
    assert.equal(verifyObject({ ...signed, loan_request: { ...signed.loan_request, principal: larger } }, key.pubkey), false)
    const { sig: _signature, ...unsigned } = signed
    for (const loan_request of [
      { ...signed.loan_request, fee: fee - 1 },
      { ...signed.loan_request, term_blocks: L2_POLICY.term_blocks + 1 },
      { ...signed.loan_request, grace_blocks: L2_POLICY.grace_blocks + 1 },
    ]) {
      const inconsistent = signObject({ ...unsigned, loan_request }, key.secretKey)
      assert.ok(verifyObject(inconsistent, key.pubkey), 'even a valid sandbox signature must bind the advertised policy')
      payload = { ...application, sandbox_result: inconsistent }
      await assert.rejects(agent.underwrite(), /sandbox-request/)
    }
    const { loan_request: _oldRequest, ...unbound } = unsigned
    payload = { ...application, sandbox_result: signObject(unbound, key.secretKey) }
    await assert.rejects(agent.underwrite(), /sandbox-request/, 'an old signed result without request binding fails closed')
    assert.equal(app.store.allLoans().length, 0)
    assert.equal(accepted, 0)
    assert.equal(modelMemoCalls, 0)

    payload = application
    const approved = await agent.underwrite()
    assert.equal(approved.terms.principal, principal)
    assert.ok(approved.checks.find((check) => check.id === 'sandbox-request')?.ok)
    assert.equal(app.store.allLoans().length, 1)
    assert.equal(accepted, 1)
  } finally { agent.close(); await app.close(); rmSync(walletDir, { recursive: true, force: true }) }
})
