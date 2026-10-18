import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { L2_POLICY, LenderAgent, sanctionsScreenVerdict } from '../src/agents/lender.js'
import type { PlatformClient } from '../src/agents/platform-client.js'
import type { Relay } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import type { BitcoindChain } from '../src/chain/bitcoind.js'
import type { AddressScreeningResult, SanctionsScreen, ScreeningSubject } from '../src/compliance/sanctions.js'
import { keyPairFromLabel, type Hex } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import type { LogEntry } from '../src/governance/log.js'
import { NodeGovernance } from '../src/governance/node.js'
import { demoDefaultPolicy } from '../src/governance/policy.js'
import { negotiationId } from '../src/market/negotiate.js'
import { signLenderPolicy } from '../src/market/policy.js'
import type { Party } from '../src/wallet/party.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const U = MICRO_PER_USDT
const L = keyPairFromLabel('sanctions-unit-lender')
const BORROWER = keyPairFromLabel('sanctions-unit-borrower').pubkey
const LIST = { list_id: 'unit-list', title: 'unit list', as_of: '2026-10-01', retrieved_at: '2026-10-01', source_url: 'file:unit', sha256: '00'.repeat(32), entries: 1 }

/** A screen with a fixed answer: clear or hit on a loaded list, or no list at all. */
function screen(answer: 'clear' | 'hit' | 'no-list'): SanctionsScreen {
  return {
    name: `unit ${answer}`, listVersion: answer === 'no-list' ? 'none' : 'unit-list@2026-10-01',
    async screen(subject: ScreeningSubject): Promise<AddressScreeningResult> {
      return { status: answer === 'hit' ? 'hit' : 'clear', screen: `unit ${answer}`, list_version: answer === 'no-list' ? 'none' : 'unit-list@2026-10-01', lists: answer === 'no-list' ? [] : [LIST], screened: { proven: subject.proven_addresses.length, counterparties: 0 }, hits: answer === 'hit' ? [{ address: subject.proven_addresses[0], hop: 0, list_id: 'unit-list', entry: {} }] : [], screened_at: 1 }
    },
  }
}

async function lender(governance: NodeGovernance): Promise<LenderAgent> {
  const agent = new LenderAgent({
    party: { role: 'lender1', key: L, rgb: { dataDir: '/nonexistent/rgb' } } as unknown as Party, relay: { close() {} } as unknown as Relay, platform: { note: async () => {} } as unknown as PlatformClient,
    chain: { getHeight: async () => 100 } as unknown as BitcoindChain, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: 'rgb:sanctions-unit', lightning: null, mine: async () => {}, governance,
  })
  agent.negotiateWith(await signLenderPolicy(new LocalKeySigner(L), { asset_id: 'rgb:sanctions-unit', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5000, term_blocks: { min: L2_POLICY.term_blocks, max: L2_POLICY.term_blocks }, required_checks: ['inflows'], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [L.pubkey], maker_checker_above: 5_000 * U }, issued_at: 1 }), { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb'] })
  return agent
}

const admit = (agent: LenderAgent, borrower: Hex, id: Hex) => (agent as unknown as { admitBorrower(b: Hex, n: Hex): Promise<true | string> }).admitBorrower(borrower, id)
const entry = (result: string): LogEntry => ({ seq: 4, hash: 'ab'.repeat(32), result, detail: { list_version: 'unit-list@2026-10-01' } }) as unknown as LogEntry

describe('lender sanctions screen for negotiations over Nostr (fail closed)', () => {
  it('only an exact clear passes; a hit always refuses; no list or no entry passes only with screening off, labelled', () => {
    assert.equal(sanctionsScreenVerdict(entry('clear'), 'when-provided').ok, true)
    assert.equal(sanctionsScreenVerdict(entry('hit'), 'when-provided').ok, false)
    assert.equal(sanctionsScreenVerdict(entry('hit'), 'off').ok, false, 'a known hit refuses whatever the policy')
    assert.equal(sanctionsScreenVerdict(entry('not-screened'), 'required').ok, false)
    assert.equal(sanctionsScreenVerdict(entry('not-screened'), 'when-provided').ok, false)
    assert.equal(sanctionsScreenVerdict(undefined, 'when-provided').ok, false)
    const off = sanctionsScreenVerdict(undefined, 'off')
    assert.equal(off.ok, true)
    assert.match(off.detail, /NOT SCREENED.*off/)
  })

  it('admits a clear borrower, logs the screen, and still finds it in the decision log after a restart', async () => {
    const governance = new NodeGovernance({ ownerKey: L, dir: null, sanctions: screen('clear') })
    const id = negotiationId(BORROWER, '01'.repeat(32))
    assert.equal(await admit(await lender(governance), BORROWER, id), true)
    const logged = governance.gate.log.entries().filter((e) => e.kind === 'sanctions-result')
    assert.equal(logged.length, 1)
    assert.equal(logged[0].result, 'clear')
    // a restarted lender: empty memory, same durable log
    const restarted = await lender(governance)
    assert.deepEqual(restarted.screeningCheck(id).ok, true, restarted.screeningCheck(id).detail)
    assert.equal(restarted.screeningCheck(negotiationId(BORROWER, '02'.repeat(32))).ok, false, 'another negotiation was never screened')
  })

  it('refuses a hit and a node with no sanctions list before anything is signed', async () => {
    const hit = new NodeGovernance({ ownerKey: L, dir: null, sanctions: screen('hit') })
    const idHit = negotiationId(BORROWER, '03'.repeat(32))
    assert.equal(await admit(await lender(hit), BORROWER, idHit), 'SANCTIONS')
    const noList = new NodeGovernance({ ownerKey: keyPairFromLabel('sanctions-unit-lender-2'), dir: null, sanctions: screen('no-list') })
    const L2 = keyPairFromLabel('sanctions-unit-lender-2')
    const agent2 = new LenderAgent({ party: { role: 'lender2', key: L2, rgb: { dataDir: '/nonexistent/rgb' } } as unknown as Party, relay: { close() {} } as unknown as Relay, platform: { note: async () => {} } as unknown as PlatformClient, chain: { getHeight: async () => 100 } as unknown as BitcoindChain, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: 'rgb:sanctions-unit', lightning: null, mine: async () => {}, governance: noList })
    const idNone = negotiationId(BORROWER, '04'.repeat(32))
    assert.equal(await admit(agent2, BORROWER, idNone), 'NOT_SCREENED')
    assert.equal(agent2.screeningCheck(idNone).ok, false)
    assert.equal(noList.gate.log.entries().find((e) => e.kind === 'sanctions-result')?.result, 'not-screened')
  })

  it('a node whose governance policy turns screening off admits an unscreened borrower, and says so', async () => {
    const L3 = keyPairFromLabel('sanctions-unit-lender-3')
    const off = new NodeGovernance({ ownerKey: L3, dir: null, sanctions: screen('no-list'), policy: (gatePk, ownerPk) => ({ ...demoDefaultPolicy(gatePk, ownerPk), sanctions: 'off' }) })
    const agent = new LenderAgent({ party: { role: 'lender1', key: L3, rgb: { dataDir: '/nonexistent/rgb' } } as unknown as Party, relay: { close() {} } as unknown as Relay, platform: { note: async () => {} } as unknown as PlatformClient, chain: { getHeight: async () => 100 } as unknown as BitcoindChain, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: 'rgb:sanctions-unit', lightning: null, mine: async () => {}, governance: off })
    const id = negotiationId(BORROWER, '05'.repeat(32))
    assert.equal(await admit(agent, BORROWER, id), true)
    assert.match(agent.screeningCheck(id).detail, /NOT SCREENED.*off/)
  })
})
