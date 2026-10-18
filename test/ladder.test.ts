import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CURE_BLOCKS, headroom, ladderFromHistory, LADDER_BPS, liquidationDue } from '../src/registry/ladder.js'

describe('ladder', () => {
  it('starts at 50% and climbs one step per on-time repayment, capped', () => {
    assert.equal(ladderFromHistory([]).allowed_ltv_bps, 5000)
    const h = [
      { open_height: 1, outcome: 'on_time' as const },
      { open_height: 2, outcome: 'on_time' as const },
      { open_height: 3, outcome: 'on_time' as const },
      { open_height: 4, outcome: 'on_time' as const },
      { open_height: 5, outcome: 'on_time' as const },
    ]
    const s = ladderFromHistory(h)
    assert.equal(s.step, LADDER_BPS.length - 1)
    assert.equal(s.allowed_ltv_bps, 6500)
    assert.equal(s.on_time, 5)
  })
  it('holds on late and resets on default, in opening order', () => {
    const s = ladderFromHistory([
      { open_height: 30, outcome: 'defaulted' },
      { open_height: 10, outcome: 'on_time' },
      { open_height: 20, outcome: 'late' },
      { open_height: 40, outcome: 'on_time' },
      { open_height: 50, outcome: 'open' },
    ])
    assert.equal(s.step, 1)
    assert.equal(s.late, 1)
    assert.equal(s.defaults, 1)
    assert.equal(s.open, 1)
    assert.equal(s.allowed_ltv_bps, 5500)
  })
})

describe('headroom', () => {
  it('reports thresholds and state', () => {
    // $606 debt, 0.01212 BTC at $100k = 50% LTV
    const h = headroom(606_000_000, 1_212_000, 10_000_000)
    assert.equal(h.ltv_bps, 5000)
    assert.equal(h.state, 'healthy')
    assert.equal(h.drop_to_margin_call_bps, 2857)
    assert.equal(h.drop_to_liquidation_bps, 3750)
    assert.equal(headroom(606_000_000, 1_212_000, 7_000_000).state, 'margin_call')
    assert.equal(headroom(606_000_000, 1_212_000, 6_200_000).state, 'liquidatable')
    assert.equal(headroom(606_000_000, 1_212_000, 5_800_000).state, 'hard_stop')
  })

  it('liquidation is due at 80% LTV only once the cure window ran out, or at the hard stop', () => {
    // 606 USDT against 0.01212 BTC: 50% at $100,000, 82% at $60,975, 86% at $58,000
    const debt = 606_000_000
    const sats = 1_212_000
    assert.equal(liquidationDue(debt, sats, 10_000_000, undefined, 500).ok, false)
    const at82 = liquidationDue(debt, sats, 6_097_500, 100, 105)
    assert.ok(at82.at_liquidation && !at82.cure_over && !at82.ok, 'inside the cure window')
    assert.equal(at82.cure_until_height, 100 + CURE_BLOCKS)
    assert.ok(liquidationDue(debt, sats, 6_097_500, 100, 100 + CURE_BLOCKS).ok, 'window over')
    assert.ok(!liquidationDue(debt, sats, 8_000_000, 100, 200).ok, 'margin call long standing but LTV under 80%')
    assert.ok(!liquidationDue(debt, sats, 6_097_500, undefined, 200).ok, 'no margin call raised')
    const stop = liquidationDue(debt, sats, 5_800_000, undefined, 200)
    assert.ok(stop.ok && stop.headroom.state === 'hard_stop', 'hard stop needs no cure window')
  })
})
