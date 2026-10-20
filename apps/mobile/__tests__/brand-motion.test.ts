// The motion components draw only real data: the negotiation visualizer reads a transcript the
// engine actually signed, the check visualizer reads the phone's own ticks, and the page-stamped
// moment needs a real release txid. These tests run the components' models on such data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyPairFromLabel } from '../../../src/core/crypto.ts'
import { MICRO_PER_USDT } from '../../../src/core/money.ts'
import { runNegotiation, type EngineParams } from '../../../src/market/negotiate.ts'
import { signBorrowerPolicy, signLenderPolicy, type BorrowerPolicy, type LenderPolicy } from '../../../src/market/policy.ts'
import { LocalKeySigner } from '../../../src/wallet/signer.ts'
import type { BorrowerCheckView, CheckTick } from '../../../src/checknode/borrower-check.ts'
import { aprText, cardWords, negotiationPicture } from '../src/motion/negotiation-model.ts'
import { KEY_TICKS, PHASE_OF_STAGE, checkPicture, envelopeAt, phaseWords, tickLabel } from '../src/motion/check-model.ts'
import { STAMP_BUZZ_MS, closeWord, isTxid, stampWords } from '../src/motion/stamp-model.ts'
import { mayAnimate, motionPlan } from '../src/motion/motion-plan.ts'

const U = MICRO_PER_USDT
const B = new LocalKeySigner(keyPairFromLabel('brand-borrower'))
const L = new LocalKeySigner(keyPairFromLabel('brand-lender'))
const PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { apr_bps: 25, ltv_bps: 100 }, enabled_settlements: ['cosign-rgb'] }

const borrowerPolicy = (over: Partial<BorrowerPolicy> = {}) => signBorrowerPolicy(B, { asset_id: 'rgb:usdt', principal: { min: 100 * U, max: 600 * U }, max_apr_bps: 1200, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: 1, ...over })
const lenderPolicy = (over: Partial<LenderPolicy> = {}) => signLenderPolicy(L, { asset_id: 'rgb:usdt', max_per_loan: 1_000 * U, max_outstanding: 10_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: [], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], approval_rules: { approvers: [keyPairFromLabel('brand-checker').pubkey], maker_checker_above: 5_000 * U }, issued_at: 1, ...over })

test('the negotiation visualizer draws a real signed transcript: cards, converging APRs, the deal', async () => {
  const run = await runNegotiation(await borrowerPolicy(), await lenderPolicy(), PARAMS, { borrower: B, lender: L, nonce: 'aa'.repeat(32) })
  assert.ok('agreed' in run.outcome, 'these policies overlap, so the engine agrees')
  const pic = negotiationPicture(run.messages, B.pubkey)
  assert.equal(pic.cards.length, run.messages.length, 'one card per signed message')
  assert.deepEqual(pic.cards.map((c) => c.seq), run.messages.map((m) => m.seq))
  assert.equal(pic.cards[0].type, 'ASK')
  assert.equal(pic.cards[0].from, 'you')
  assert.equal(pic.cards[0].chained, false)
  assert.ok(pic.cards.slice(1).every((c) => c.chained), 'every later message links to the one before')
  assert.ok(pic.cards.every((c, i) => c.sig === `${run.messages[i].sig.slice(0, 6)}…`), 'the card shows the message\'s own signature')
  assert.equal(pic.end.kind, 'accept')
  if (pic.end.kind !== 'accept' || !('agreed' in run.outcome)) return
  assert.equal(pic.end.position.apr_bps, run.outcome.agreed.apr_bps, 'the deal is the agreed APR, not a drawn one')
  assert.equal(pic.gap, 0)
  assert.equal(pic.closed, 1)
  // the APR lines are the positions in the messages, nothing interpolated
  const sent = run.messages.filter((m) => ['ASK', 'OFFER', 'COUNTER'].includes(m.type))
  assert.deepEqual([...pic.aprs.you, ...pic.aprs.lender].map((p) => p.apr_bps).sort(), sent.map((m) => (m.body.position as { apr_bps: number }).apr_bps).sort())
  assert.ok(pic.range.min <= Math.min(...sent.map((m) => (m.body.position as { apr_bps: number }).apr_bps)))
  assert.deepEqual(pic.problems, [])
  // a relay echo (the same message twice, out of order) is shown once, in order
  const echoed = negotiationPicture([...run.messages].reverse().concat(run.messages[0]), B.pubkey)
  assert.deepEqual(echoed.cards.map((c) => c.key), pic.cards.map((c) => c.key))
  assert.match(cardWords(pic.cards[0]), /^asks for \d+(\.\d+)?% APR$/)
})

test('no deal has its own end state, with the engine\'s reason', async () => {
  const run = await runNegotiation(await borrowerPolicy({ max_apr_bps: 900 }), await lenderPolicy({ min_apr_bps: 1500 }), PARAMS, { borrower: B, lender: L, nonce: 'bb'.repeat(32) })
  assert.ok('no_deal' in run.outcome)
  const pic = negotiationPicture(run.messages, B.pubkey)
  assert.equal(pic.end.kind, 'no_deal')
  if (pic.end.kind !== 'no_deal' || !('no_deal' in run.outcome)) return
  assert.equal(pic.end.reason, run.outcome.no_deal)
  assert.ok(pic.gap !== null && pic.gap > 0, 'they ended apart')
  assert.match(cardWords(pic.cards.at(-1)!), /^ends it \(/)
})

test('an open negotiation and a mixed list are shown as they are', async () => {
  const run = await runNegotiation(await borrowerPolicy(), await lenderPolicy(), PARAMS, { borrower: B, lender: L, nonce: 'cc'.repeat(32) })
  const two = negotiationPicture(run.messages.slice(0, 2), B.pubkey)
  assert.equal(two.end.kind, 'open')
  assert.equal(two.aprs.you.length, 1)
  assert.equal(two.aprs.lender.length, 1)
  assert.ok(two.firstGap !== null && two.gap === two.firstGap && two.closed === 0)
  assert.equal(negotiationPicture([], B.pubkey).cards.length, 0)
  const other = await runNegotiation(await borrowerPolicy(), await lenderPolicy(), PARAMS, { borrower: B, lender: L, nonce: 'dd'.repeat(32) })
  assert.match(negotiationPicture([...run.messages.slice(0, 1), ...other.messages.slice(1, 2)], B.pubkey).problems.join(), /2 negotiations mixed/)
  assert.equal(aprText(1250), '12.5%')
})

// the tick ids and order openForwardedCheck and borrowerscorerChecks produce (src/checknode/borrower-check.ts, src/scorer/portable-evidence.ts)
const IDS = ['key-message', 'offer', 'message-chain', 'request-is-this-part', 'consent-in-commitment', 'commitment', 'key-binding', 'scorer-is-offered-release',
  'evidence:output-schema', 'evidence:contract', 'evidence:scorer-key', 'evidence:offered-release', 'evidence:result-scorer', 'evidence:signature', 'evidence:run-record-signature', 'evidence:binding', 'evidence:consent', 'evidence:bundle', 'evidence:scored-loan']
const ticks = (fail?: string): CheckTick[] => IDS.map((id) => ({ id, ok: id !== fail, detail: `detail of ${id}` }))
const view = (t: CheckTick[], recommendation = 'QUALIFY') => ({ ok: t.every((x) => x.ok), ticks: t, outputs: { recommendation, income_band: 'B' } }) as unknown as Pick<BorrowerCheckView, 'ok' | 'ticks' | 'outputs'>

test('the check visualizer places the envelope by the real stage and shows the phone\'s own ticks', () => {
  assert.deepEqual(Object.keys(PHASE_OF_STAGE).sort(), ['approval-requested', 'approved', 'key-received', 'opened', 'part-sent', 'refused'], 'every stage runBorrowerCheck reports')
  assert.deepEqual(envelopeAt('out'), { at: 1, from: 0 })
  assert.deepEqual(envelopeAt('back'), { at: 0, from: 1 })
  assert.deepEqual(envelopeAt('running'), { at: 1, from: 1 })
  // before it is opened, no tick shows, whatever the view holds
  assert.deepEqual(checkPicture({ phase: 'running', view: view(ticks()) }).ticks, [])
  const ok = checkPicture({ phase: 'opened', view: view(ticks()) })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ticks.map((x) => x.id), IDS, 'every tick, in the phone\'s order')
  assert.deepEqual(ok.ticks.filter((x) => x.key).map((x) => x.id), [...KEY_TICKS])
  assert.equal(tickLabel('evidence:signature'), 'Result signature')
  assert.match(tickLabel('evidence:binding'), /Binding to this borrower/)
  assert.deepEqual(ok.verdict, { recommendation: 'QUALIFY', tone: 'good', income_band: 'B' })
  assert.equal(checkPicture({ phase: 'opened', view: view(ticks(), 'ESCALATE') }).verdict?.tone, 'hold')
  assert.equal(tickLabel('evidence:something-new'), 'something new', 'an unknown tick shows by its id')
})

test('a check that does not verify shows no verdict, and a refusal shows its code', () => {
  const bad = checkPicture({ phase: 'opened', view: view(ticks('evidence:binding')) })
  assert.equal(bad.ok, false)
  assert.equal(bad.verdict, null, 'a failed tick never shows a recommendation')
  assert.equal(bad.ticks.find((x) => x.id === 'evidence:binding')?.ok, false)
  assert.equal(checkPicture({ phase: 'opened', view: { ok: true, ticks: [], outputs: null } as unknown as BorrowerCheckView }).ok, false, 'no ticks is not a pass')
  const refused = checkPicture({ phase: 'refused', refusal: 'TIMEOUT' })
  assert.equal(refused.refusal, 'TIMEOUT')
  assert.equal(refused.ok, null)
  assert.match(phaseWords('approval', 'check node 9d1375'), /^Check node 9d1375 asks you to approve its scorer contract$/)
})

test('the page is stamped only with a real closing txid', () => {
  const tx = '31ad14f7'.padEnd(60, '0') + 'a71c'
  const w = stampWords({ pageNo: 3, closeTxid: tx, ladderStep: 2, ladderSteps: 4, limitBps: 6000 })
  assert.ok(w)
  assert.equal(w.title, 'Page 3 stamped')
  assert.equal(w.txShort, '31ad…a71c')
  assert.equal(w.ladder, 'Step 3 of 4 · limit now 60%')
  assert.equal(w.ring, 'PAID ON TIME · PAGE 3 · TEST COINS ·', 'the seal says the coins are test coins')
  assert.ok(w.a11y.includes(tx), 'the screen reader gets the whole txid')
  assert.equal(w.stepsFilled, 3)
  assert.equal(w.buzz, true)
  assert.equal(w.txWord, 'release')
  assert.match(w.a11y, /The release transaction /)
  assert.deepEqual([w.tone, w.glyph], ['green', 'check'])
  const def = stampWords({ pageNo: 1, closeTxid: tx, ladderStep: 0, ladderSteps: 4, outcome: 'defaulted' })!
  assert.equal(def.buzz, false, 'no celebration buzz on a default')
  assert.deepEqual([def.tone, def.glyph], ['warn', 'bar'], 'no check on a page that was not paid')
  // only a repaid page closes with the release; the others are named for their own spend
  assert.equal(def.txWord, 'default claim')
  assert.ok(!/release/i.test(def.a11y), 'a default is never called a release')
  assert.deepEqual(['on_time', 'late', 'defaulted', 'liquidated', 'refunded', 'open'].map(closeWord), ['release', 'release', 'default claim', 'sale', 'refund', 'closing transaction'])
  assert.equal(stampWords({ pageNo: 2, closeTxid: tx, ladderStep: 1, ladderSteps: 4, outcome: 'refunded' })!.tone, 'muted')
  for (const bad of ['', 'not-a-txid', tx.slice(1), `${tx}00`]) assert.equal(stampWords({ pageNo: 3, closeTxid: bad, ladderStep: 2, ladderSteps: 4 }), null, `no stamp for ${JSON.stringify(bad)}`)
  assert.equal(stampWords({ pageNo: 0, closeTxid: tx, ladderStep: 0, ladderSteps: 4 }), null)
  assert.ok(isTxid(tx.toUpperCase()))
  assert.ok(STAMP_BUZZ_MS > 0 && STAMP_BUZZ_MS <= 60, 'one short pulse')
})

test('one-shot moments wait for the reduce-motion setting, so a half page turn never shows', () => {
  // the first render, before AccessibilityInfo answers: nothing plays and nothing is marked played
  assert.equal(motionPlan(null, false), 'wait')
  assert.equal(motionPlan(null, true), 'wait')
  // known: jump to the end state with reduce motion on, play with it off, once
  assert.equal(motionPlan(true, false), 'jump')
  assert.equal(motionPlan(false, false), 'play')
  assert.equal(motionPlan(false, true), 'skip')
  assert.equal(motionPlan(true, true), 'skip')
  // loops (the shimmer, the loader, the node's pulse) start only once it is known to be off
  assert.deepEqual([mayAnimate(null), mayAnimate(true), mayAnimate(false)], [false, false, true])
})
