import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MESSAGE_DWELL_MS as D, negotiationFrame } from '../src/motion/negotiation-pacing.ts'

test('a burst of real messages displays one at a time, then keeps the completed result readable', () => {
  let frame = negotiationFrame(null, 'signed-run', 4, 100)
  assert.equal(frame.shown, 1)
  assert.equal(frame.ready, false)
  frame = negotiationFrame(frame, 'signed-run', 4, 100 + D - 1)
  assert.equal(frame.shown, 1)
  for (let n = 2; n <= 4; n++) {
    frame = negotiationFrame(frame, 'signed-run', 4, 100 + (n - 1) * D)
    assert.equal(frame.shown, n)
    assert.equal(frame.ready, false)
  }
  frame = negotiationFrame(frame, 'signed-run', 4, 100 + 4 * D)
  assert.equal(frame.ready, true)
  assert.deepEqual(negotiationFrame(frame, 'signed-run', 4, 100 + 50 * D), frame)
})

test('a delayed frame never skips queued messages or invents extra signed rounds', () => {
  let frame = negotiationFrame(null, 'run', 2, 0)
  frame = negotiationFrame(frame, 'run', 2, 50 * D)
  assert.equal(frame.shown, 2)
  assert.equal(frame.ready, false, 'the final message still gets its own dwell')
  frame = negotiationFrame(frame, 'run', 2, 51 * D)
  assert.equal(frame.ready, true)
  assert.equal(frame.shown, 2)
})

test('new negotiations reset, and empty/failed transcripts never fabricate a message', () => {
  const complete = negotiationFrame(negotiationFrame(null, 'one', 1, 0), 'one', 1, D)
  const next = negotiationFrame(complete, 'two', 3, D + 1)
  assert.equal(next.shown, 1)
  assert.equal(next.ready, false)
  assert.equal(negotiationFrame(null, 'failed-before-signing', 0, 0).shown, 0)
  assert.equal(negotiationFrame(null, 'failed-before-signing', 0, 0).ready, true)
})
