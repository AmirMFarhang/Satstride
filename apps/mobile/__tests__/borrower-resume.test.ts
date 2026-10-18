// The phone borrower resumes instead of repeating: an existing (or signed-and-maybe-broadcast)
// lock is never doubled, the relay listens back to an unfinished loan after a restart and
// never hands an event out twice, and accepted-but-never-locked terms are not debt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mnemonicToSeedSync } from '@scure/bip39'
import { keyPairFromLabel, type Hex } from '../../../src/core/crypto.ts'
import { debtOf, type LoanTerms } from '../../../src/core/terms.ts'
import { PhoneBorrower, relayWindow, type PhoneAgentState } from '../src/agent/borrower.ts'
import { PhoneRelay } from '../src/agent/relay.ts'
import type { PartySigner } from '../src/agent/ports.ts'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../worklet/keys.js')
const { PartyKey } = require('../worklet/party.js')

const party = new PartyKey(rootFromSeed(mnemonicToSeedSync('legal winner thank year wave sausage worth useful legal winner thank yellow')))
const key: PartySigner = {
  pubkey: party.pubkey,
  btc: party.btcOutput(),
  signObject: async (v) => party.signObject(v),
  signPassbookHash: async (h) => party.signPassbookHash(h),
  signRequest: async (r) => party.signRequest(r),
  signEvent: async (t) => party.signEvent(t),
  nip44Encrypt: async (p, s) => party.nip44Encrypt(p, s),
  nip44Decrypt: async (p, s) => party.nip44Decrypt(p, s),
  signKeyPath: async (p) => party.signKeyPath(p),
  signEscrowLeaf: async (p) => party.signEscrowLeaf(p),
} as PartySigner

const L = keyPairFromLabel('resume-lender'), P = keyPairFromLabel('resume-platform')
const terms = (nonce: string): LoanTerms => ({
  v: 1, borrower_pk: party.pubkey, lender_pk: L.pubkey, platform_pk: P.pubkey, asset_id: 'rgb:a', principal: 100_000_000, fee: 900_000,
  collateral_sats: 183_455, oracle_quote: { price_cents: 10_000_000, height: 289, oracle_pk: P.pubkey, sig: '00'.repeat(64) }, open_height: 289,
  maturity_height: 319, grace_blocks: 5, recovery_height: 344, ladder_step: 1, ltv_bps: 5499, prev_passbook_txid: null, nonce,
} as unknown as LoanTerms)

function agentWith(state: PhoneAgentState, over: { broadcast?: (hex: string) => Promise<string>; heights?: Record<string, number> } = {}) {
  const sent: { kind: number; payload: Record<string, unknown> }[] = []
  const broadcasts: string[] = []
  const chain = {
    kind: 'fake', getHeight: async () => 300,
    getTx: async (txid: string) => (over.heights?.[txid] ? { txid, height: over.heights[txid], inputs: [], outputs: [] } : null),
    utxos: async () => { throw new Error('a resumed lock must not pick coins again') },
    broadcast: async (hex: string) => { broadcasts.push(hex); return over.broadcast ? over.broadcast(hex) : 'x' },
  }
  const rgb = { witnessInvoice: async () => { throw new Error('the saved disbursement invoice must be reused') } }
  const relay = { send: async (kind: number, payload: Record<string, unknown>) => { sent.push({ kind, payload }) } }
  const platform = { recordLock: async () => ({}), note: async () => ({}) }
  const agent = new PhoneBorrower(key, platform as never, relay as never, chain as never, rgb as never, 'rgb:a', state)
  return { agent, sent, broadcasts }
}

test('an existing lock is resumed: no new coins, no new lock, the saved invoice, the split handed over again', async () => {
  const id = 'aa'.repeat(32) as Hex
  const state: PhoneAgentState = { loans: { [id]: { terms: terms('11'.repeat(32)), lender_pk: L.pubkey, lock: { txid: '22'.repeat(32), vout: 0 }, disbursement_invoice: 'rgb:saved', disbursement_recipient_id: 'r1' } }, labels: {} }
  const { agent, sent, broadcasts } = agentWith(state)
  const out = await agent.lockAndSplit(id)
  assert.equal(out.lock_txid, '22'.repeat(32))
  assert.equal(broadcasts.length, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.disbursement_invoice, 'rgb:saved')
  assert.equal(sent[0].payload.purpose, 'split')
})

test('a lock signed but maybe not broadcast is broadcast again as the same transaction, never rebuilt', async () => {
  const id = 'bb'.repeat(32) as Hex
  const pending = { txid: '33'.repeat(32), hex: 'deadbeef' }
  const state: PhoneAgentState = { loans: { [id]: { terms: terms('44'.repeat(32)), lender_pk: L.pubkey, lock_pending: pending, disbursement_invoice: 'rgb:saved', disbursement_recipient_id: 'r1' } }, labels: {} }
  const { agent, broadcasts } = agentWith(state, { broadcast: async () => { throw new Error('txn-already-in-mempool') }, heights: { [pending.txid]: 290 } })
  const out = await agent.lockAndSplit(id)
  assert.equal(out.lock_txid, pending.txid)
  assert.deepEqual(broadcasts, ['deadbeef'])
  assert.deepEqual(state.loans[id].lock, { txid: pending.txid, vout: 0 })
  assert.equal(state.loans[id].lock_pending, undefined)
})

test('accepted terms that were never locked are not reported as outstanding debt', async () => {
  const locked = 'cc'.repeat(32) as Hex, abandoned = 'dd'.repeat(32) as Hex, released = 'ee'.repeat(32) as Hex
  const state: PhoneAgentState = {
    loans: {
      [locked]: { terms: terms('55'.repeat(32)), lender_pk: L.pubkey, lock: { txid: '66'.repeat(32), vout: 0 } },
      [abandoned]: { terms: terms('77'.repeat(32)), lender_pk: L.pubkey },
      [released]: { terms: terms('88'.repeat(32)), lender_pk: L.pubkey, lock: { txid: '99'.repeat(32), vout: 0 }, release_txid: 'ab'.repeat(32) as Hex },
    },
    labels: {},
  }
  const { agent, sent } = agentWith(state)
  const offer = { id: `${L.pubkey}:usdt-30-record`, lender_pk: L.pubkey, payload: { term_blocks: 30 } }
  await agent.apply(offer as never, 100_000_000, { result: { lender_result: {} } as never, attestation: {} as never }, [])
  const statement = sent[0].payload.outstanding_statement as { outstanding_micro: number }
  assert.equal(statement.outstanding_micro, debtOf(state.loans[locked].terms))
})

test('after a restart the relay listens back to the oldest unfinished loan and skips events already handled', () => {
  const now = 1_800_000_000
  const state: PhoneAgentState = {
    loans: {
      ['11'.repeat(32)]: { terms: terms('a1'.repeat(32)), lender_pk: L.pubkey, accepted_at: now - 900 },
      ['22'.repeat(32)]: { terms: terms('a2'.repeat(32)), lender_pk: L.pubkey, accepted_at: now - 300 },
      ['33'.repeat(32)]: { terms: terms('a3'.repeat(32)), lender_pk: L.pubkey, accepted_at: now - 5000, release_txid: 'ab'.repeat(32) as Hex },
    },
    labels: {},
  }
  assert.equal(relayWindow(state, now), now - 960)
  assert.equal(relayWindow({ loans: {}, labels: {} }, now), now - 5)
  const handled: string[] = []
  const relay = new PhoneRelay(key, [], { since: relayWindow(state, now), seen: ['e1'], onSeen: (id) => handled.push(id) })
  assert.equal(relay.since, now - 960)
  assert.equal((relay as unknown as { seen: Set<string> }).seen.has('e1'), true)
  relay.close()
})
