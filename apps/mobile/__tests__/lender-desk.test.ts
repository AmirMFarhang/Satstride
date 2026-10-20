// Lane E3 review (#77): the negotiated desk never promises more than the lender's signed max_outstanding. Open and
// agreed negotiations hold their principal from the ASK (so two borrowers at once cannot both get the same capacity),
// a failed check or no deal releases it, a stale one expires, and a sheet is approved only if everything else plus it
// stays under the cap. The pinned scorer keys are the desk's default, and the check price on screen is signed in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyPairFromLabel, type Hex } from '../../../src/core/crypto.ts'
import { MICRO_PER_USDT } from '../../../src/core/money.ts'
import { PHONE_OFFER, type PhoneLenderState } from '../src/agent/lender.ts'
import { NegotiatedDesk, RESERVE_SECONDS, reservedPrincipal, reserves } from '../src/lender/desk.ts'
import { pinnedScorerKeys, scorerKeysFromJson } from '../src/app/scorer-keys.ts'
import { engineParams, marketChoice, signMarketPolicy } from '../src/lender/market-policy.ts'
import type { NegotiationRecord } from '../src/lender/review.ts'
import pinned from '../src/app/scorer-keys.json'
import { partyKey } from './lender-helpers.ts'

const U = MICRO_PER_USDT
const L = keyPairFromLabel('e3d-lender'), OP = keyPairFromLabel('e3d-operator').pubkey
const ASSET = 'rgb:usdt-mutinynet'
const NOW = 1_800_000_000
const id = (n: number) => String(n).padStart(2, '0').repeat(32) as Hex
const pos = (principal: number) => ({ principal, apr_bps: 1000, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' as const })
const open = (n: number, principal: number, started = NOW): NegotiationRecord => ({ negotiation_id: id(n), borrower_pk: id(90 + n), started_at: started, messages: [{ body: { position: pos(principal) } } as never], outcome: 'open', verified: false, problems: [] })
const agreed = (n: number, principal: number, over: Partial<NegotiationRecord> = {}): NegotiationRecord => ({ ...open(n, principal), outcome: { agreed: pos(principal), accept_hash: id(70 + n) }, ...over })

async function desk(over: Partial<PhoneLenderState>, max = 30 * U) {
  const offer = { ...PHONE_OFFER, max }
  const policy = await signMarketPolicy(partyKey(L), ASSET, offer, marketChoice({ operator_pk: OP, price: 500_000 }, 900, ASSET), 1)
  const state: PhoneLenderState = { loans: {}, declined: [], offer: { d: offer.d, payload: { asset_id: ASSET, min: offer.min, max, apr_bps: 1100, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: offer.ltv_ladder_bps, requirements: offer.requirements, expires_height: 900 }, event_id: 'e', published_at: 1 }, market: { policy, params: engineParams(null) }, ...over }
  const lender = { pubkey: L.pubkey, key: partyKey(L), persist: async () => {}, say: async () => {}, platform: {}, relay: {}, assetId: ASSET, economics: undefined } as never
  return { d: new NegotiatedDesk({ lender, state, transport: () => ({}) as never, evidenceKeys: pinnedScorerKeys, changed: () => {}, now: () => NOW * 1000 }), state, policy }
}

test('reservations: open and agreed negotiations hold their principal; no deal, a failed check, or a stale one release it', async () => {
  assert.equal(reservedPrincipal(open(1, 10 * U)), 10 * U)
  assert.equal(reservedPrincipal(agreed(2, 12 * U)), 12 * U)
  assert.ok(reserves(open(1, 1)) && reserves(agreed(2, 1)))
  assert.ok(!reserves({ ...open(3, 1), outcome: { no_deal: 'TIMEOUT' } }))
  assert.ok(!reserves(agreed(4, 1, { check_error: 'BILL_RATE_LIMITED' })))
  assert.ok(!reserves(agreed(5, 1, { check: { refusals: ['recommendation ESCALATE: only QUALIFY is funded'] } as never })))
  const { d } = await desk({ negotiations: { [id(1)]: open(1, 10 * U), [id(2)]: agreed(2, 12 * U), [id(3)]: { ...open(3, 9 * U), outcome: { no_deal: 'X' } }, [id(6)]: open(6, 7 * U, NOW - RESERVE_SECONDS - 1) } })
  assert.equal(d.outstanding(), 22 * U, 'open 10 + agreed 12; the no-deal and the stale one hold nothing')
})

test('a negotiation that became a sheet or a loan is counted once, as the sheet or the loan', async () => {
  const sheet = { loan_id: id(40), negotiation_id: id(2), borrower_pk: id(92), sheet: { terms: { principal: 12 * U } }, passbook: {}, checks: [], at: NOW } as never
  const loan = { terms: { principal: 5 * U }, borrower_pk: id(93), accepted_at: NOW, checks: [], memo: '', negotiation_id: id(3) } as never
  const { d } = await desk({ negotiations: { [id(2)]: agreed(2, 12 * U), [id(3)]: agreed(3, 5 * U) }, proposals: { [id(40)]: sheet }, loans: { [id(41)]: loan } })
  assert.equal(d.outstanding(), 17 * U)
  assert.equal(d.outstanding(id(40)), 5 * U, 'leaving the sheet out for its own approval check')
})

test('approval refuses a sheet that would take the lender past its signed maximum, before anything is signed or sent', async () => {
  const sheet = { loan_id: id(40), negotiation_id: id(2), borrower_pk: id(92), sheet: { terms: { principal: 20 * U } }, passbook: {}, checks: [], at: NOW } as never
  // another borrower agreed 15 at the same time: 15 + 20 > 30
  const { d } = await desk({ negotiations: { [id(2)]: agreed(2, 20 * U), [id(5)]: agreed(5, 15 * U) }, proposals: { [id(40)]: sheet } })
  await assert.rejects(d.approveAndSend(id(40)), /above this lender's signed maximum/)
})

test('the check price on the post screen is signed into the policy as the most a check may be billed', async () => {
  const { policy } = await desk({})
  assert.deepEqual(policy.check_nodes, { accepted_check_operators: [OP], max_price: { asset_id: ASSET, amount: 500_000 } })
})

test('scorer pins are public configuration; malformed or absent pins never create a trusted signer', async () => {
  assert.deepEqual(await pinnedScorerKeys(), scorerKeysFromJson(pinned))
  assert.deepEqual(scorerKeysFromJson({ keys: [{ public_key_hex: '00'.repeat(32), secret: 'discarded' }, { public_key_hex: 'bad' }] }), [{ public_key_hex: '00'.repeat(32) }])
  assert.deepEqual(scorerKeysFromJson({ keys: 'not an array' }), [])
  assert.deepEqual(scorerKeysFromJson(null), [])
})
