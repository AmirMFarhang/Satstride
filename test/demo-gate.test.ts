import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, it, type TestContext } from 'node:test'
import type { App } from '../src/server/app.js'
import { DemoCheckpoints, DemoCheckpointError } from '../src/cli/demo-checkpoints.js'
import { RecordedDemo } from '../src/cli/demo-checkpoint-tools.js'
import { DemoGate, DemoStopped } from '../src/cli/demo-gate.js'

type RecordWait = ConstructorParameters<typeof DemoGate>[2]
function gateFixture(record?: RecordWait) {
  const events: Record<string, unknown>[] = []
  const api = { emit: (event: Record<string, unknown>) => { events.push(structuredClone(event)); return event } } as unknown as App['api']
  return { gate: new DemoGate({ api }, 'standard', record), events }
}
function journalFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'private', 'checkpoint.json')
  return { file, identity: { runtime: 'gate-regression-v1', borrower: 'fixture-borrower', asset: 'fixture-asset' } }
}
async function waiting(gate: DemoGate, kind: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (gate.waiting.waiting === kind) return
    await setImmediate()
  }
  assert.fail(`human gate ${kind} was never presented`)
}

describe('demo human approval gates', () => {
  it('rejects confirmations for the wrong loan, stop or kind without consuming the real approval', async () => {
    const { gate, events } = gateFixture()
    let settled = false
    const approval = gate.wait<boolean>('confirm', { stop: 'repay', loan_id: 'loan-1' }).then((value) => { settled = true; return value })
    const presented = structuredClone(gate.waiting)
    assert.equal(gate.answer('confirm', true, 'repay', 'loan-2'), false)
    assert.equal(gate.answer('confirm', true, 'accept', 'loan-1'), false)
    assert.equal(gate.answer('confirm', true, 'repay'), false)
    assert.equal(gate.answer('approve', ['unrelated-row']), false)
    await setImmediate()
    assert.equal(settled, false)
    assert.deepEqual(gate.waiting, presented)
    assert.equal(events.length, 1, 'stale requests do not dismiss or replace the current prompt')
    assert.equal(gate.answer('confirm', false, 'repay', 'loan-1'), true)
    assert.equal(await approval, false, 'an explicit decline remains a decline')
    assert.equal(gate.answer('confirm', true, 'repay', 'loan-1'), false, 'a duplicate confirmation cannot approve another action')
  })

  it('freezes an unanswered approval until explicitly unfrozen', async () => {
    const { gate } = gateFixture()
    assert.equal(gate.freeze(), false)
    let settled = false
    const approval = gate.wait<string[]>('approve', { lender_pk: 'lender-1', items: [{ txid: 'income-1' }] }).then((value) => { settled = true; return value })
    const presented = structuredClone(gate.waiting)
    assert.equal(gate.freeze(), true)
    assert.equal(gate.answer('approve', ['income-1']), false)
    await setImmediate()
    assert.equal(settled, false); assert.deepEqual(gate.waiting, presented)
    gate.unfreeze()
    assert.equal(gate.answer('approve', ['income-1']), true)
    assert.deepEqual(await approval, ['income-1'])
    assert.deepEqual(gate.waiting, { waiting: null })
  })

  it('cancels the current wait and rejects every future wait without approving anything', async () => {
    const { gate, events } = gateFixture()
    const approval = gate.wait<boolean>('confirm', { stop: 'lock', loan_id: 'loan-1' })
    const rejected = assert.rejects(approval, DemoStopped)
    assert.equal(gate.freeze(), true)
    gate.cancel()
    await rejected
    assert.deepEqual(gate.waiting, { waiting: null })
    assert.deepEqual(events.at(-1), { type: 'demo', scenario: 'standard', waiting: null })
    gate.unfreeze()
    assert.equal(gate.answer('confirm', true, 'lock', 'loan-1'), false)
    for (const kind of ['next', 'approve', 'confirm'] as const) await assert.rejects(gate.wait(kind, {}), DemoStopped)
    assert.equal(gate.freeze(), false)
  })

  it('preserves an unanswered durable gate on cancellation and requires a new matching answer after restore', async (t) => {
    const f = journalFixture(t)
    let state = { step: 6, loan: 'loan-1', memo: 'initial context', platformOnline: true }
    const journal = new DemoCheckpoints(f.file, f.identity, () => state)
    let count = 0
    const first = gateFixture(<T>(kind: string, info: Record<string, unknown>, live: () => Promise<T>) => journal.wait(`${kind}:${count++}`, info, live))
    const info = { stop: 'repay', loan_id: 'loan-1' }
    const approval = first.gate.wait<boolean>('confirm', info)
    const cancelled = assert.rejects(approval, DemoStopped)
    await waiting(first.gate, 'confirm')
    assert.equal(first.gate.freeze(), true)
    state = { ...state, memo: 'private edit before shutdown', platformOnline: false }
    await journal.checkpoint()
    first.gate.cancel()
    await cancelled
    assert.equal(journal.pending, false, 'cancelling a human wait is not an ambiguous money operation')
    assert.deepEqual(journal.waiting, { key: 'confirm:0', info })
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).entries, [], 'cancellation must not write an approval result')

    const restored = new DemoCheckpoints(f.file, f.identity, () => state)
    assert.deepEqual(restored.savedState, state)
    assert.equal(restored.pending, false)
    count = 0
    const resumed = gateFixture(<T>(kind: string, details: Record<string, unknown>, live: () => Promise<T>) => restored.wait(`${kind}:${count++}`, details, live))
    let settled = false
    const newApproval = resumed.gate.wait<boolean>('confirm', { loan_id: 'loan-1', stop: 'repay' }).then((value) => { settled = true; return value })
    await waiting(resumed.gate, 'confirm')
    await setImmediate()
    assert.equal(settled, false, 'restoring an unanswered gate cannot approve it automatically')
    assert.equal(resumed.events.length, 1, 'the restored approval is presented to the human again')
    assert.equal(resumed.gate.answer('confirm', true, 'repay', 'old-loan'), false)
    assert.equal(resumed.gate.answer('confirm', true, 'lock', 'loan-1'), false)
    assert.equal(resumed.gate.answer('confirm', true, 'repay', 'loan-1'), true)
    assert.equal(await newApproval, true)
    assert.equal(restored.waiting, null)
    const accepted = JSON.parse(readFileSync(f.file, 'utf8')).entries
    assert.equal(accepted.length, 1); assert.equal(accepted[0].kind, 'wait')
    const replay = new DemoCheckpoints(f.file, f.identity, () => state)
    assert.equal(await replay.wait('confirm:0', info, () => { assert.fail('a previously completed approval is replayed without asking again') }), true)
  })
})

describe('recorded demo business operations', () => {
  it('journals nested asynchronous business calls once and never invokes money functions during replay', async (t) => {
    const f = journalFixture(t), effects = { repay: 0, transfer: 0, release: 0 }
    const journal = new DemoCheckpoints(f.file, f.identity, () => ({ ...effects }))
    const recorded = new RecordedDemo(journal)
    function business(recorder: RecordedDemo, replay: boolean) {
      const wallet = { send: async () => {
        assert.equal(replay, false, 'replay must not invoke the money function')
        effects.transfer++; await setImmediate(); return { txid: `transfer-${effects.transfer}` }
      } }
      const borrower = { repay: async () => {
        assert.equal(replay, false, 'replay must not invoke the outer repayment function')
        effects.repay++; await setImmediate()
        const [payment, release] = await Promise.all([
          wallet.send(),
          recorder.call('collateral.release', async () => { effects.release++; await setImmediate(); return { txid: 'release-1' } }),
        ])
        return { payment, release }
      } }
      recorder.wrap(wallet, 'wallet', ['send'])
      recorder.wrap(borrower, 'borrower', ['repay'])
      return { wallet, borrower }
    }
    const original = business(recorded, false), receipt = await original.borrower.repay()
    assert.deepEqual(receipt, { payment: { txid: 'transfer-1' }, release: { txid: 'release-1' } })
    assert.deepEqual(effects, { repay: 1, transfer: 1, release: 1 })
    const nested = JSON.parse(readFileSync(f.file, 'utf8')).entries
    assert.equal(nested.length, 1, 'nested calls remain inside the outer durable action')
    assert.match(nested[0].key, /^borrower\.repay@[a-f0-9]{64}:0$/)
    assert.deepEqual(await original.wallet.send(), { txid: 'transfer-2' }, 'the async context does not leak into a later independent action')
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).entries.length, 2)

    const restored = new DemoCheckpoints(f.file, f.identity, () => { assert.fail('replaying completed actions must not take a new snapshot') })
    const replay = business(new RecordedDemo(restored), true)
    assert.deepEqual(await replay.borrower.repay(), receipt)
    assert.deepEqual(await replay.wallet.send(), { txid: 'transfer-2' })
    assert.deepEqual(effects, { repay: 1, transfer: 2, release: 1 })
    assert.equal(restored.replaying, false)
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).entries.length, 2)
  })

  it('normalizes optional undefined fields before journaling and replays the same JSON result', async (t) => {
    const f = journalFixture(t)
    const recorded = new RecordedDemo(new DemoCheckpoints(f.file, f.identity, () => ({ step: 2 })))
    let calls = 0
    const value = await recorded.call('result', async () => {
      calls++
      return { txid: 'confirmed', optional: undefined, details: { ok: true, absent: undefined }, items: [undefined, { missing: undefined, id: 'kept' }] }
    })
    const expected = { txid: 'confirmed', details: { ok: true }, items: [null, { id: 'kept' }] }
    assert.deepEqual(value, expected)
    assert.equal(Object.hasOwn(value, 'optional'), false)
    assert.equal(await recorded.call('no-result', async () => { calls++; return undefined }), undefined)
    const replay = new RecordedDemo(new DemoCheckpoints(f.file, f.identity, () => { assert.fail('replay cannot replace a saved snapshot') }))
    assert.deepEqual(await replay.call('result', async () => { assert.fail('replay cannot invoke the result-producing action') }), expected)
    assert.equal(await replay.call('no-result', async () => { assert.fail('an undefined result is still a completed action') }), undefined)
    assert.equal(calls, 2)
  })

  it('binds cached wrapped funding to its arguments while ignoring object property insertion order', async (t) => {
    const f = journalFixture(t)
    const cases: { name: string; original: unknown[]; replayed: unknown[]; accepts: boolean }[] = [
      { name: 'different loan', original: ['loanA'], replayed: ['loanB'], accepts: false },
      { name: 'reordered objects', original: ['loanA', { invoice: { asset: 'fixture', recipient: 'alice' }, optional: undefined }], replayed: ['loanA', { optional: undefined, invoice: { recipient: 'alice', asset: 'fixture' } }], accepts: true },
      { name: 'undefined differs from null', original: ['loanA', undefined], replayed: ['loanA', null], accepts: false },
    ]
    for (const [index, test] of cases.entries()) {
      const file = `${f.file}.${index}`, receipt = { txid: `confirmed-funding-${index}` }
      let moneyCalls = 0
      const wrapped = (recorded: RecordedDemo, replay: boolean) => {
        const lender = { fund: async (..._args: unknown[]) => {
          moneyCalls++
          assert.equal(replay, false, 'cached replay must never execute funding')
          return receipt
        } }
        recorded.wrap(lender, 'lender', ['fund'])
        return lender
      }
      const original = wrapped(new RecordedDemo(new DemoCheckpoints(file, f.identity, () => ({ funded: true }))), false)
      assert.deepEqual(await original.fund(...test.original), receipt)
      const beforeReplay = readFileSync(file)
      const replay = wrapped(new RecordedDemo(new DemoCheckpoints(file, f.identity, () => { assert.fail('replay must not snapshot') })), true)
      if (test.accepts) assert.deepEqual(await replay.fund(...test.replayed), receipt, test.name)
      else await assert.rejects(replay.fund(...test.replayed), (error: unknown) => error instanceof DemoCheckpointError && error.code === 'order', test.name)
      assert.equal(moneyCalls, 1, `${test.name}: argument validation happens before invoking funding`)
      assert.deepEqual(readFileSync(file), beforeReplay, 'neither replay nor a refused argument change rewrites durable history')
      const exact = wrapped(new RecordedDemo(new DemoCheckpoints(file, f.identity, () => { assert.fail('exact replay must not snapshot') })), true)
      assert.deepEqual(await exact.fund(...test.original), receipt)
      assert.equal(moneyCalls, 1)
    }
  })
})
