// #57 review: the phone lender never pays out over spent collateral or a closed loan, finishes
// the steps after a payout exactly once even across failures, and never accepts an application
// to an offer that has expired.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyPairFromLabel, type Hex } from '../../../src/core/crypto.ts'
import type { LoanTerms } from '../../../src/core/terms.ts'
import { PASSBOOK_ONLY, PhoneLender, type PhoneLenderState } from '../src/agent/lender.ts'

const B = keyPairFromLabel('lr-borrower'), L = keyPairFromLabel('lr-lender'), P = keyPairFromLabel('lr-platform')
const ID = 'aa'.repeat(32) as Hex
const LOCK = '11'.repeat(32) as Hex, PAYOUT = 'cc'.repeat(32) as Hex
const terms = { v: 1, borrower_pk: B.pubkey, lender_pk: L.pubkey, platform_pk: P.pubkey, asset_id: 'rgb:a', principal: 100_000_000, fee: 900_000, collateral_sats: 183_455, recovery_height: 344 } as unknown as LoanTerms

function lender(state: PhoneLenderState, over: Record<string, unknown> = {}) {
  const calls: Record<string, number> = {}
  const count = (k: string) => { calls[k] = (calls[k] ?? 0) + 1 }
  const key = { pubkey: L.pubkey, signObject: async (v: object) => ({ ...v, sig: '00' }) }
  const record = { status: 'locked', lock_txid: LOCK, lock_vout: 0, disbursement_txid: undefined as string | undefined, ...(over.record as object) }
  const platform = {
    note: async () => ({}), loan: async () => ({ ...record }),
    recordLock: async (_id: Hex, txid: Hex) => {
      count('recordLock'); assert.equal(txid, LOCK)
      if ((over.lockFails as number) >= calls.recordLock) throw new Error('422: lock transaction not confirmed')
      Object.assign(record, { status: 'locked', lock_txid: txid, lock_vout: 0 })
      if (over.lockAnswerLost) throw new Error('no answer from platform')
    },
    recordFunded: async (_id: Hex, txid: Hex) => {
      count('recordFunded'); assert.equal(txid, PAYOUT)
      if ((over.fundedFails as number) >= calls.recordFunded) throw new Error('422: disbursement transaction not confirmed')
      Object.assign(record, { status: 'open', disbursement_txid: txid })
      if (over.fundedAnswerLost) throw new Error('no answer from platform')
    },
    repaymentWatch: async () => { count('repaymentWatch'); return { invoice: 'rgb:repay', recipient_id: 'bcrt:wvout:r', backup: 'YmFja3Vw', password: 'p' } }, ...(over.platform as object),
  }
  const chain = { utxos: async () => [], getHeight: async () => 300, ...(over.chain as object) }
  const rgb = { send: async () => { count('principalSend'); throw new Error('principal must never be resent') }, refresh: async () => {}, transfers: async () => [{ idx: 1, kind: 'Send', status: 'Settled', txid: PAYOUT, recipientId: null, amount: 100_000_000 }], witnessInvoice: async () => { count('witnessInvoice'); return { invoice: 'rgb:iou', recipientId: 'x' } } }
  const repay = { keys: async () => ({ account_xpub_vanilla: 'tpubA', account_xpub_colored: 'tpubB', master_fingerprint: '88ebaef6' }), restore: async () => { count('restore'); if ((over.restoreFails as number) > (calls.restore - 1)) throw new Error('disk full') } }
  const relay = { send: async (kind: number) => { count(`send:${kind}`) } }
  const a = new PhoneLender(key as never, platform as never, relay as never, chain as never, rgb as never, repay as never, 'rgb:a', state)
  return { a, calls, record }
}

test('no payout when the escrow output is spent or the platform closed the loan', async () => {
  const state: PhoneLenderState = { loans: { [ID]: { terms, borrower_pk: B.pubkey, accepted_at: 1, checks: [], memo: '' } }, declined: [] }
  const outpoint = { txid: '11'.repeat(32) as Hex, vout: 0 }
  await assert.rejects(lender(state).a.assertCollateralLive(ID, outpoint), /no longer locked/)
  const live = { chain: { utxos: async () => [{ txid: outpoint.txid, vout: 0, value: 183_455, height: 290 }] } }
  await assert.rejects(lender(state, { ...live, platform: { loan: async () => ({ status: 'refunded' }) } }).a.assertCollateralLive(ID, outpoint), /platform has the loan as refunded/)
  assert.equal(state.loans[ID].cancelled, 'refunded')
  delete state.loans[ID].cancelled
  await lender(state, live).a.assertCollateralLive(ID, outpoint)
})

test('the steps after a payout are resumed once each: a failed restore keeps the issued watch, FUNDED goes once', async () => {
  const state: PhoneLenderState = { loans: { [ID]: { terms, borrower_pk: B.pubkey, accepted_at: 1, checks: [], memo: '', lock: { txid: LOCK, vout: 0 }, disbursement_txid: PAYOUT, funded_sent: false } }, declined: [] }
  const { a, calls } = lender(state, { restoreFails: 1 })
  await assert.rejects(a.finishPayout(ID), /disk full/)
  assert.ok(state.loans[ID].repayment_watch_issued, 'the issued watch is kept for the retry')
  assert.equal(state.loans[ID].funded_sent, false)
  await a.finishPayout(ID)
  assert.equal(calls.repaymentWatch, 1, 'the platform is asked for the watch once')
  assert.equal(calls.restore, 2)
  assert.equal(calls.recordFunded, 1)
  assert.equal(calls['send:7474'], 1, 'FUNDED once')
  assert.equal(state.loans[ID].repayment_account, '88ebaef6')
  assert.equal(state.loans[ID].repayment_watch_issued, undefined)
  await a.finishPayout(ID)
  assert.equal(calls['send:7474'], 1, 'a later call changes nothing')
  // a loan paid out before these steps were recorded (it sent FUNDED right after the restore) is done
  const legacy: PhoneLenderState = { loans: { [ID]: { terms, borrower_pk: B.pubkey, accepted_at: 1, checks: [], memo: '', disbursement_txid: 'cc'.repeat(32) as Hex, repayment_account: 'x', repayment_invoice: 'rgb:r' } }, declined: [] }
  const old = lender(legacy)
  await old.a.finishPayout(ID)
  assert.equal(old.calls['send:7474'], undefined)
})

function paidState(): PhoneLenderState {
  return { loans: { [ID]: { terms, borrower_pk: B.pubkey, accepted_at: 1, checks: [], memo: '', lock: { txid: LOCK, vout: 0 }, disbursement_txid: PAYOUT, funded_sent: false, funded_recorded: true } }, declined: [] }
}

test('an old falsely recorded payout repairs the same lock and payout before issuing its watch, without resending principal', async () => {
  const state = paidState()
  const { a, calls, record } = lender(state, { record: { status: 'pending', lock_txid: undefined, lock_vout: undefined }, lockFails: 1 })
  await assert.rejects(a.finishPayout(ID), /lock transaction not confirmed/)
  assert.equal(state.loans[ID].funded_recorded, false)
  assert.equal(calls.recordFunded, undefined)
  assert.equal(calls.repaymentWatch, undefined)
  await a.finishPayout(ID)
  assert.equal(record.status, 'open')
  assert.equal(record.disbursement_txid, PAYOUT)
  assert.equal(calls.recordLock, 2)
  assert.equal(calls.recordFunded, 1)
  assert.equal(calls.repaymentWatch, 1)
  assert.equal(calls['send:7474'], 1)
  assert.equal(calls.principalSend, undefined)
  assert.equal(state.loans[ID].disbursement_txid, PAYOUT)
  assert.equal(state.loans[ID].funded_recorded, true)
})

test('a failed funding notice is retried before the repayment watch and the flag means success', async () => {
  const state = paidState()
  const { a, calls } = lender(state, { fundedFails: 1 })
  await assert.rejects(a.finishPayout(ID), /disbursement transaction not confirmed/)
  assert.equal(state.loans[ID].funded_recorded, false)
  assert.equal(calls.repaymentWatch, undefined)
  await a.finishPayout(ID)
  assert.equal(calls.recordFunded, 2)
  assert.equal(calls.principalSend, undefined)
})

test('lost indexing answers are reconciled from exact matching records without replaying successful writes', async () => {
  const state = paidState()
  const { a, calls } = lender(state, { record: { status: 'pending' }, lockAnswerLost: true, fundedAnswerLost: true })
  await a.finishPayout(ID)
  assert.equal(calls.recordLock, 1)
  assert.equal(calls.recordFunded, 1)
  assert.equal(calls.principalSend, undefined)
})

test('an already open exact payout needs no indexing writes; conflicting locks, payouts and closed loans refuse', async () => {
  const good = lender(paidState(), { record: { status: 'open', disbursement_txid: PAYOUT } })
  await good.a.finishPayout(ID)
  assert.equal(good.calls.recordLock, undefined)
  assert.equal(good.calls.recordFunded, undefined)
  for (const record of [
    { status: 'open', disbursement_txid: 'dd'.repeat(32) },
    { status: 'locked', lock_txid: 'ee'.repeat(32) },
    { status: 'locked', lock_vout: 1 },
    { status: 'refunded' },
  ]) {
    const bad = lender(paidState(), { record })
    await assert.rejects(bad.a.finishPayout(ID), /platform has not accepted/)
    assert.equal(bad.calls.repaymentWatch, undefined)
    assert.equal(bad.calls.principalSend, undefined)
  }
})

test('before a first payout the platform must accept the independently verified unspent lock', async () => {
  const state: PhoneLenderState = { loans: { [ID]: { terms, borrower_pk: B.pubkey, accepted_at: 1, checks: [], memo: '' } }, declined: [] }
  const { a, calls } = lender(state, { record: { status: 'pending' }, lockFails: 3, chain: { utxos: async () => [{ txid: LOCK, vout: 0, value: terms.collateral_sats, height: 290 }] } })
  await assert.rejects(a.assertCollateralLive(ID, { txid: LOCK, vout: 0 }), /lock transaction not confirmed/)
  assert.equal(calls.recordLock, 3, 'only explicit index confirmation lag gets bounded metadata retries')
  assert.equal(calls.principalSend, undefined)
})

test('a concurrent transition to open while indexing cannot authorize a first payout', async () => {
  const state: PhoneLenderState = { loans: { [ID]: { terms, borrower_pk: B.pubkey, accepted_at: 1, checks: [], memo: '' } }, declined: [] }
  let reads = 0
  const { a, calls } = lender(state, {
    platform: { loan: async () => ({ status: ++reads === 1 ? 'pending' : 'open', lock_txid: LOCK, lock_vout: 0, disbursement_txid: PAYOUT }) },
    chain: { utxos: async () => [{ txid: LOCK, vout: 0, value: terms.collateral_sats, height: 290 }] },
  })
  await assert.rejects(a.assertCollateralLive(ID, { txid: LOCK, vout: 0 }), /already has this loan as funded/)
  assert.equal(calls.principalSend, undefined)
})

test('an application to an expired offer is declined', async () => {
  const state: PhoneLenderState = { loans: {}, declined: [], offer: { d: PASSBOOK_ONLY.d, payload: { expires_height: 150 } as never, event_id: 'e', published_at: 0 } }
  const platform = { sandboxPubkey: async () => ({ sandbox_pk: P.pubkey, attestation: { image_digest: 'in-process' } }), state: async () => ({ height: 200, platform_pk: P.pubkey, oracle_pk: P.pubkey }) }
  const { a } = lender(state, { platform })
  const app = { offer_id: `${L.pubkey}:${PASSBOOK_ONLY.d}`, principal: 100_000_000, term_blocks: 30, disclosed_inflows: [] }
  const r = await a.review(PASSBOOK_ONLY, app as never, B.pubkey)
  assert.ok('declined' in r)
  const live = (r as { declined: { failed: { id: string; detail: string }[] } }).declined.failed.find((c) => c.id === 'offer-live')
  assert.match(live!.detail, /valid until block 150, now 200/)
})
