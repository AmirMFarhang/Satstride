import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { primaryReasonerFromEnv } from '../src/ai/engine.js'
import { GuardedReasoner } from '../src/ai/guarded.js'
import { CATEGORISE_BATCH, categoriseInBatches, disclosePrompt, explainSplitPrompt, marginNotePrompt } from '../src/ai/prompts.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import type { AiTrace, CategoriseRow, Reasoner } from '../src/ai/types.js'

const row = (txid: string, direction: 'in' | 'out', memo: string): CategoriseRow => ({ txid, direction, amount: 1_000_000, height: 100, counterparty_pk: 'aa'.repeat(32), memo, hints: [] })

/** A primary whose answers the test dictates. */
function fake(over: Partial<Reasoner>): Reasoner {
  const rules = new RuleReasoner()
  return {
    engine: 'fake-model',
    categorise: (r) => rules.categorise(r),
    disclose: (i) => rules.disclose(i),
    creditMemo: (i) => rules.creditMemo(i),
    explainSplit: (i) => rules.explainSplit(i),
    marginNote: (i) => rules.marginNote(i),
    investigate: () => rules.investigate(),
    ...over,
  }
}

describe('guarded reasoner', () => {
  it('keeps the model rows that fit and takes the rules for the rest, saying which', async () => {
    const traces: AiTrace[] = []
    const rows = [row('t1', 'in', 'salary'), row('t2', 'out', 'rent'), row('t3', 'out', 'coffee')]
    const ai = new GuardedReasoner(
      fake({
        categorise: async () => ({
          rows: [
            { txid: 't1', category: 'income', confidence: 0.9 },
            { txid: 't2', category: 'income', confidence: 0.9 }, // money out labelled income: wrong whatever the model says
          ],
        }),
      }),
      (t) => traces.push(t),
    )
    const out = await ai.categorise(rows)
    assert.deepEqual(
      out.rows.map((r) => [r.txid, r.category]),
      [
        ['t1', 'income'],
        ['t2', 'rent_or_fixed_bill'],
        ['t3', 'discretionary'],
      ],
    )
    assert.equal(traces[0].engine, 'fake-model')
    assert.match(traces[0].fallbackReason ?? '', /2 of 3 row\(s\) from the rules: t2 income on money out; t3 missing/)
  })

  it('falls back entirely when the model fails, and traces the reason', async () => {
    const traces: AiTrace[] = []
    const ai = new GuardedReasoner(fake({ categorise: async () => Promise.reject(new Error('QVAC categorise timed out after 60000 ms')) }), (t) => traces.push(t))
    const out = await ai.categorise([row('t1', 'in', 'salary')])
    assert.equal(out.rows[0].category, 'income')
    assert.equal(traces[0].engine, 'rules')
    assert.match(traces[0].fallbackReason ?? '', /timed out/)
  })

  it('rejects a disclosure that names a txid outside the candidates', async () => {
    const traces: AiTrace[] = []
    const ai = new GuardedReasoner(fake({ disclose: async () => ({ selected_txids: ['not-a-candidate'], reason: 'x' }) }), (t) => traces.push(t))
    const out = await ai.disclose({ requirement: { inflow_months: 1, inflow_multiple_bps: 10_000, repayment: 1 }, candidates: [{ txid: 'c1', amount: 5, height: 1, payer_pk: 'p', month_index: 0 }] })
    assert.deepEqual(out.selected_txids, ['c1'])
    assert.equal(traces[0].fallbackReason, 'output failed schema validation')
  })
})

describe('model selection and prompts', () => {
  const saved = { ai: process.env.PASSBOOK_AI, model: process.env.QVAC_MODEL }
  afterEach(() => {
    process.env.PASSBOOK_AI = saved.ai
    process.env.QVAC_MODEL = saved.model
    if (saved.ai === undefined) delete process.env.PASSBOOK_AI
    if (saved.model === undefined) delete process.env.QVAC_MODEL
  })

  it('picks rules by default, an explicit deterministic playbook, local QVAC backends, and nothing else', () => {
    delete process.env.PASSBOOK_AI
    assert.equal(primaryReasonerFromEnv().engine, 'rules')
    process.env.PASSBOOK_AI = 'qvac'
    assert.equal(primaryReasonerFromEnv().engine, 'qvac-sdk:qwen3-1.7b', 'constructed without loading the SDK or a model')
    process.env.QVAC_MODEL = 'qwen3-4b'
    assert.equal(primaryReasonerFromEnv().engine, 'qvac-sdk:qwen3-4b')
    process.env.PASSBOOK_AI = 'qvac-http'
    assert.match(primaryReasonerFromEnv().engine, /^qvac-http:/)
    process.env.PASSBOOK_AI = 'playbook'
    assert.equal(primaryReasonerFromEnv().engine, 'playbook:passbook-v1')
    process.env.PASSBOOK_AI = 'cloud'
    assert.throws(() => primaryReasonerFromEnv(), /PASSBOOK_AI must be rules, playbook, qvac or qvac-http/)
  })

  it('categorises long histories in batches and keeps the order', async () => {
    const rows = Array.from({ length: 2 * CATEGORISE_BATCH + 3 }, (_, i) => row(`t${i}`, 'in', 'salary'))
    const sizes: number[] = []
    const out = await categoriseInBatches(rows, async (batch) => {
      sizes.push(batch.length)
      return { rows: batch.map((r) => ({ txid: r.txid, category: 'income', confidence: 1 })) }
    })
    assert.deepEqual(sizes, [CATEGORISE_BATCH, CATEGORISE_BATCH, 3])
    assert.deepEqual(
      (out.rows as { txid: string }[]).map((r) => r.txid),
      rows.map((r) => r.txid),
    )
  })

  it('gives the model amounts the way a person reads them, never cents or micro-units', () => {
    const margin = JSON.parse(marginNotePrompt({ ltv_bps: 8200, price_cents: 6_100_000, margin_call_price_cents: 7_143_000, liquidation_price_cents: 6_250_000, cure_until_height: 360, debt: 606_250_000, collateral_sats: 1_212_500 }).messages[1].content)
    assert.deepEqual(margin, { loan_to_value: '82.00%', btc_price_now: '$61,000', margin_call_below: '$71,430', liquidation_below: '$62,500', cure_window_ends_at_block: 360, owed: '606.25 USDT', locked: '0.01212500 BTC' })
    const split = JSON.parse(explainSplitPrompt({ principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000, price_cents: 10_000_000, maturity_height: 130, grace_blocks: 5, lender_sats_on_default: 606_000, borrower_sats_on_default: 605_500 }).messages[1].content)
    assert.equal(split.claim_block, 135)
    assert.equal(split.owed, '606.00 USDT')
    const disclose = JSON.parse(disclosePrompt({ requirement: { inflow_months: 3, inflow_multiple_bps: 20_000, repayment: 606_000_000 }, candidates: [{ txid: 'c1', amount: 2_500_000_000, height: 1, payer_pk: 'p', month_index: 2 }] }).messages[1].content)
    assert.deepEqual(disclose, { required_months: [0, 1, 2], required_total: '1,212.00 USDT', candidates: [{ txid: 'c1', month: 2, amount: '2,500.00 USDT' }] })
  })
})
