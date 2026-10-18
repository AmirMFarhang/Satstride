import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'node:test'
import { DemoCheckpoints, DemoCheckpointError, type DemoCheckpointErrorCode } from '../src/cli/demo-checkpoints.js'

function fixture() { const dir = mkdtempSync(join(tmpdir(), 'passbook-checkpoints-')); return { dir, file: join(dir, 'private', 'checkpoint.json'), dispose: () => rmSync(dir, { recursive: true, force: true }) } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const identity = { runtime: 'source-hash', asset: 'test-usdt', borrower: 'alice', options: { atomic: true, oracle: 'demo' } }
const code = (expected: DemoCheckpointErrorCode) => (e: unknown) => e instanceof DemoCheckpointError && e.code === expected

describe('durable demo operation checkpoints', () => {
  it('replays completed actions without invoking money functions or overwriting the latest restored state', async () => {
    const f = fixture(); let effects = 0, snapshots = 0, state = { balance: 100, loan: 'open' }
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => { snapshots++; return state })
      assert.equal(journal.savedState, undefined)
      const receipt = await journal.call('1:pay', () => { effects++; state = { balance: 70, loan: 'paid' }; return { txid: 'confirmed', amount: 30, nested: { ok: true } } })
      receipt.nested.ok = false
      await journal.call('2:notify', () => undefined)
      const reload = new DemoCheckpoints(f.file, { ...identity, options: { oracle: 'demo', atomic: true } }, () => { throw new Error('replay must not snapshot') })
      const restored = reload.savedState as typeof state; assert.deepEqual(restored, state); restored.balance = -1
      assert.equal((reload.savedState as typeof state).balance, 70)
      assert.equal(reload.replaying, true)
      const cached = await reload.call('1:pay', () => { effects++; throw new Error('must not pay twice') })
      assert.deepEqual(cached, { txid: 'confirmed', amount: 30, nested: { ok: true } })
      assert.equal(reload.replaying, true)
      assert.equal(await reload.call('2:notify', () => { effects++; return 'not cached' }), undefined)
      assert.equal(reload.replaying, false); assert.equal(effects, 1); assert.equal(snapshots, 2)
      assert.deepEqual(reload.savedState, state)
    } finally { f.dispose() }
  })
  it('replays answered approvals and resumes a cancelled unanswered gate with the latest private edits', async () => {
    const f = fixture(), started = deferred<void>(), answer = deferred<string>()
    let asks = 0, state = { judgeMemo: '', apiOff: false, oracle: 95000 }
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => state)
      await journal.wait('1:approve', { loan: 'L1', principal: 300 }, () => { asks++; return { approved: true } })
      const paused = journal.wait('2:continue', { step: 3 }, async () => { asks++; started.resolve(); return answer.promise })
      await started.promise
      state = { judgeMemo: 'new work context', apiOff: true, oracle: 88000 }
      await journal.checkpoint()
      assert.equal(journal.pending, false); assert.deepEqual(journal.waiting, { key: '2:continue', info: { step: 3 } })
      const stopped = assert.rejects(paused, /DemoStopped/); answer.reject(new Error('DemoStopped')); await stopped
      const reload = new DemoCheckpoints(f.file, identity, () => state)
      assert.deepEqual(reload.savedState, state); assert.equal(reload.pending, false)
      assert.deepEqual(await reload.wait('1:approve', { principal: 300, loan: 'L1' }, () => { throw new Error('approval must be cached') }), { approved: true })
      assert.equal(await reload.wait('2:continue', { step: 3 }, () => { asks++; return 'continue' }), 'continue')
      assert.equal(asks, 3); assert.equal(reload.waiting, null)
    } finally { f.dispose() }
  })
  it('serializes a stop snapshot before an approval that arrives while the snapshot is being written', async () => {
    const f = fixture(), entered = deferred<void>(), answer = deferred<string>(), snapshot = deferred<{ stage: number }>()
    let snapshots = 0, finished = false
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => ++snapshots === 2 ? snapshot.promise : { stage: snapshots })
      const waiting = journal.wait('approval', { loan: 'L1' }, async () => { entered.resolve(); return answer.promise }).then((value) => { finished = true; return value })
      await entered.promise
      const saving = journal.checkpoint(); answer.resolve('yes'); await setImmediate()
      assert.equal(finished, false)
      snapshot.resolve({ stage: 2 }); await saving; assert.equal(await waiting, 'yes')
      const reload = new DemoCheckpoints(f.file, identity, () => undefined)
      assert.equal(reload.waiting, null); assert.deepEqual(reload.savedState, { stage: 3 })
    } finally { f.dispose() }
  })
  it('persists the pending marker before a real child process performs its effect and is killed', async () => {
    const f = fixture(), effect = join(f.dir, 'effect.txt')
    const source = `
      import { writeFileSync } from 'node:fs';
      import { DemoCheckpoints } from ${JSON.stringify(new URL('../src/cli/demo-checkpoints.ts', import.meta.url).href)};
      process.on('message', () => {});
      const journal = new DemoCheckpoints(process.env.PASSBOOK_CHECKPOINT_TEST_FILE, ${JSON.stringify(identity)}, () => ({ paid: false }));
      await journal.call('1:pay', async () => {
        writeFileSync(process.env.PASSBOOK_CHECKPOINT_TEST_EFFECT, 'exactly one effect');
        process.send('effect'); await new Promise(() => {});
      });
    `
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', source], { env: { ...process.env, PASSBOOK_CHECKPOINT_TEST_FILE: f.file, PASSBOOK_CHECKPOINT_TEST_EFFECT: effect }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const exited = once(child, 'exit')
    try {
      assert.equal((await once(child, 'message'))[0], 'effect')
      assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).pending.key, '1:pay')
      child.kill('SIGKILL'); assert.deepEqual(await exited, [null, 'SIGKILL'])
      assert.throws(() => new DemoCheckpoints(f.file, identity, () => undefined), code('pending'))
      assert.equal(readFileSync(effect, 'utf8'), 'exactly one effect')
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; f.dispose() }
  })
  it('never repeats an effect after its operation, result encoding or post-action snapshot fails', async () => {
    const f = fixture()
    try {
      for (const failure of ['action', 'snapshot', 'result'] as const) {
        let effects = 0
        const file = join(f.dir, failure, 'checkpoint.json')
        const journal = new DemoCheckpoints(file, identity, () => { if (failure === 'snapshot') throw new Error('snapshot failed'); return {} })
        await assert.rejects(journal.call('pay', () => { effects++; if (failure === 'action') throw new Error('action failed'); return failure === 'result' ? 1n : { txid: 'paid' } }))
        assert.equal(journal.pending, true)
        await assert.rejects(journal.call('pay', () => { effects++; }), code('pending'))
        await assert.rejects(journal.checkpoint(), code('pending'))
        assert.throws(() => new DemoCheckpoints(file, identity, () => ({})), code('pending'))
        assert.equal(effects, 1)
      }
    } finally { f.dispose() }
  })
  it('refuses identity changes, reordered calls, wrong call kinds and altered approval details', async () => {
    const f = fixture(); let effects = 0
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => ({}))
      await journal.call('1:fund', () => 'funded'); await journal.wait('2:approve', { loan: 'L1', principal: 300 }, () => true)
      assert.throws(() => new DemoCheckpoints(f.file, { ...identity, runtime: 'other-source' }, () => ({})), code('identity_mismatch'))
      assert.throws(() => new DemoCheckpoints(f.file, { ...identity, borrower: 'other-borrower' }, () => ({})), code('identity_mismatch'))
      const reload = new DemoCheckpoints(f.file, identity, () => ({})), effect = () => { effects++; return true }
      await assert.rejects(reload.call('2:approve', effect), code('order'))
      await assert.rejects(reload.wait('1:fund', {}, effect), code('order'))
      assert.equal(await reload.call('1:fund', effect), 'funded')
      await assert.rejects(reload.wait('2:approve', { loan: 'L1', principal: 301 }, effect), code('order'))
      assert.equal(await reload.wait('2:approve', { principal: 300, loan: 'L1' }, effect), true)
      assert.equal(effects, 0)
    } finally { f.dispose() }
  })
  it('refuses a different operation or changed details at a saved unanswered gate', async () => {
    const f = fixture()
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => ({ step: 2 }))
      await assert.rejects(journal.wait('approve', { principal: 300 }, () => { throw new Error('DemoStopped') }))
      const reload = new DemoCheckpoints(f.file, identity, () => ({}))
      await assert.rejects(reload.call('fund', () => { throw new Error('must not fund') }), code('order'))
      await assert.rejects(reload.wait('approve', { principal: 900 }, () => true), code('order'))
      assert.equal(reload.pending, false)
    } finally { f.dispose() }
  })
  it('rejects corrupt and unsupported records rather than starting a new journal', async () => {
    const f = fixture()
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => ({})); await journal.call('pay', () => 'txid')
      const saved = JSON.parse(readFileSync(f.file, 'utf8'))
      for (const broken of ['{broken', JSON.stringify({ ...saved, v: 2 }), JSON.stringify({ ...saved, snapshot: { type: 'json' } }), JSON.stringify({ ...saved, entries: [{ kind: 'call', key: 'pay', result: null }] }), JSON.stringify({ ...saved, unexpected: true }), JSON.stringify({ ...saved, completed: true, waiting: { key: 'approve', info: { type: 'undefined' } } })]) {
        writeFileSync(f.file, broken)
        assert.throws(() => new DemoCheckpoints(f.file, identity, () => ({})), code('corrupt'))
        assert.equal(readFileSync(f.file, 'utf8'), broken)
      }
    } finally { f.dispose() }
  })
  it('refuses parallel or nested journal calls while allowing the enclosing action to finish', async () => {
    const f = fixture(), entered = deferred<void>(), finish = deferred<string>()
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => ({}))
      const action = journal.call('outer', async () => {
        await assert.rejects(journal.call('nested', () => 'not executed'), code('busy'))
        entered.resolve(); return finish.promise
      })
      await entered.promise
      await assert.rejects(journal.wait('parallel', {}, () => true), code('busy'))
      finish.resolve('done'); assert.equal(await action, 'done'); assert.equal(journal.pending, false)
    } finally { f.dispose() }
  })
  it('persists completion, rejects unfinished completion and never runs a new action after completion', async () => {
    const f = fixture(); let state = { done: false }, effects = 0
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => state)
      await journal.checkpoint(); assert.equal(journal.savedState, undefined)
      await journal.call('pay', () => 'txid'); state = { done: true }; await journal.markComplete(); assert.equal(journal.completed, true)
      const reload = new DemoCheckpoints(f.file, identity, () => ({}))
      assert.equal(reload.completed, true); assert.deepEqual(reload.savedState, { done: true })
      assert.equal(await reload.call('pay', () => { effects++; return 'duplicate' }), 'txid')
      await assert.rejects(reload.call('another-payment', () => { effects++; }), code('complete')); assert.equal(effects, 0)
      const waiting = new DemoCheckpoints(join(f.dir, 'waiting.json'), identity, () => ({}))
      await assert.rejects(waiting.wait('approve', {}, () => { throw new Error('DemoStopped') }))
      await assert.rejects(waiting.markComplete(), code('order')); assert.equal(waiting.completed, false)
    } finally { f.dispose() }
  })
  it('keeps undefined results distinct from JSON objects with sentinel-looking fields', async () => {
    const f = fixture()
    try {
      const journal = new DemoCheckpoints(f.file, identity, () => undefined)
      await journal.call('nothing', () => undefined); await journal.call('object', () => ({ type: 'undefined' }))
      const reload = new DemoCheckpoints(f.file, identity, () => ({}))
      assert.equal(await reload.call('nothing', () => 'bad'), undefined)
      assert.deepEqual(await reload.call('object', () => 'bad'), { type: 'undefined' }); assert.equal(reload.savedState, undefined)
    } finally { f.dispose() }
  })
  it('creates private files/directories and refuses dangling file or directory symlinks', () => {
    const f = fixture(), outside = fixture()
    try {
      new DemoCheckpoints(f.file, identity, () => ({}))
      assert.equal(statSync(f.file).mode & 0o777, 0o600); assert.equal(statSync(dirname(f.file)).mode & 0o777, 0o700)
      rmSync(f.file); symlinkSync(join(outside.dir, 'missing'), f.file)
      assert.throws(() => new DemoCheckpoints(f.file, identity, () => ({})), code('unsafe'))
      symlinkSync(outside.dir, join(f.dir, 'link'))
      assert.throws(() => new DemoCheckpoints(join(f.dir, 'link', 'checkpoint.json'), identity, () => ({})), code('unsafe'))
      assert.throws(() => new DemoCheckpoints(join(f.dir, 'invalid.json'), { value: undefined }, () => ({})), code('json'))
    } finally { f.dispose(); outside.dispose() }
  })
})
