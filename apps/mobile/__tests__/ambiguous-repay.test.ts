// A repayment whose send failed after signing (it may be on the network) is never paid twice:
// a retry adopts it when it is on the network, sends anew only when rgb-lib has it as Failed
// (cancelled: it never left), and refuses while it can't be told.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyPairFromLabel, type Hex } from '../../../src/core/crypto.ts'
import type { LoanTerms } from '../../../src/core/terms.ts'
import { PhoneBorrower, type PhoneAgentState } from '../src/agent/borrower.ts'

const L = keyPairFromLabel('amb-lender'), B = keyPairFromLabel('amb-borrower')
const ID = 'aa'.repeat(32) as Hex
const AMB = 'bb'.repeat(32)

function setup(statuses: { state: string; rgbStatus: string | null }[]) {
  const sends: string[] = []
  const reported: unknown[] = []
  let sendCalls = 0
  const state: PhoneAgentState = { loans: { [ID]: { terms: { principal: 100_000_000, fee: 900_000, asset_id: 'rgb:a' } as unknown as LoanTerms, lender_pk: L.pubkey, lock: { txid: '11'.repeat(32) as Hex, vout: 0 }, disbursement_txid: '22'.repeat(32) as Hex, repayment_invoice: 'rgb:repay' } }, labels: {} }
  const rgb = {
    send: async () => {
      sendCalls++
      if (sendCalls === 1) throw new Error(`AMBIGUOUS_SEND:{"txid":"${AMB}","batchTransferIdx":3} the payment was signed and may have been broadcast (proxy timeout)`)
      sends.push('new'); return { txid: 'cc'.repeat(32) }
    },
    status: async () => statuses.shift() ?? { state: 'unknown', rgbStatus: null },
    refresh: async () => {},
    transfers: async () => [{ idx: 1, kind: 'Send', status: 'Settled', txid: AMB, recipientId: null, amount: 100_900_000 }, { idx: 2, kind: 'Send', status: 'Settled', txid: 'cc'.repeat(32), recipientId: null, amount: 100_900_000 }],
  }
  const chain = { getTx: async (txid: string) => ({ txid, height: 300, inputs: [], outputs: [] }) }
  const relay = { send: async (_k: number, p: unknown) => { reported.push(p) } }
  const key = { pubkey: B.pubkey, signObject: async (v: object) => ({ ...v, sig: '00' }) }
  const agent = new PhoneBorrower(key as never, { note: async () => ({}) } as never, relay as never, chain as never, rgb as never, 'rgb:a', state)
  return { agent, state, sends, reported, calls: () => sendCalls }
}

test('an ambiguous repayment is kept as pending and adopted once it is on the network: paid once', async () => {
  const s = setup([{ state: 'broadcast', rgbStatus: 'WaitingConfirmations' }])
  await assert.rejects(s.agent.repay(ID), /AMBIGUOUS_SEND/)
  assert.deepEqual(s.state.loans[ID].repay_pending, { txid: AMB })
  const txid = await s.agent.repay(ID)
  assert.equal(txid, AMB)
  assert.equal(s.calls(), 1, 'never sent a second time')
  assert.equal(s.state.loans[ID].repayment_txid, AMB)
  assert.equal(s.state.loans[ID].repay_pending, undefined)
  assert.equal(s.reported.length, 1)
  // reported once: a third call is a no-op
  await s.agent.repay(ID)
  assert.equal(s.reported.length, 1)
})

test('while the earlier repayment cannot be told, a retry refuses; once rgb-lib has it as Failed, it pays anew', async () => {
  const s = setup([{ state: 'not-seen', rgbStatus: 'Initiated' }, { state: 'not-seen', rgbStatus: 'Failed' }])
  await assert.rejects(s.agent.repay(ID), /AMBIGUOUS_SEND/)
  await assert.rejects(s.agent.repay(ID), /not on the network yet/)
  assert.equal(s.calls(), 1)
  const txid = await s.agent.repay(ID)
  assert.equal(txid, 'cc'.repeat(32))
  assert.deepEqual(s.sends, ['new'])
})
