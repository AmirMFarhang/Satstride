import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { describe, it } from 'node:test'
import { DemoSessions, type SessionPaths } from '../src/cli/demo-sessions.js'

function fixture() { const dir = mkdtempSync(join(tmpdir(), 'passbook-session-')); return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) } }
describe('durable isolated demo sessions', () => {
  it('persists updates and current selection across reload without reusing paths or modifying prior evidence', () => {
    const f = fixture()
    try {
      const registry = new DemoSessions(f.dir), first = registry.create()
      mkdirSync(first.paths.wallets); writeFileSync(join(first.paths.wallets, 'seed'), 'private original seed')
      mkdirSync(first.paths.runDir); writeFileSync(join(first.paths.runDir, 'case.json'), 'private original evidence')
      registry.update(first.id, { status: 'failed', error: 'interrupted external action' })
      const reload = new DemoSessions(f.dir)
      assert.equal(reload.current()!.error, 'interrupted external action')
      const second = reload.create()
      assert.notEqual(second.id, first.id); assert.notEqual(second.paths.wallets, first.paths.wallets)
      assert.equal(new DemoSessions(f.dir).current()!.id, second.id)
      assert.equal(reload.list().length, 2)
      assert.equal(readFileSync(join(first.paths.wallets, 'seed'), 'utf8'), 'private original seed')
      assert.equal(readFileSync(join(first.paths.runDir, 'case.json'), 'utf8'), 'private original evidence')
      reload.activate(first.id); assert.equal(reload.current()!.id, first.id)
      reload.update(first.id, { status: 'inspection' }); assert.equal(reload.get(first.id).error, undefined)
      assert.equal(statSync(dirname(second.paths.wallets)).mode & 0o777, 0o700)
      assert.equal(statSync(join(f.dir, 'active.json')).mode & 0o777, 0o600)
      assert.equal(statSync(join(dirname(second.paths.wallets), 'session.json')).mode & 0o777, 0o600)
    } finally { f.dispose() }
  })
  it('adopts existing legacy paths in place without moving or changing a single byte', () => {
    const f = fixture(), legacy = fixture()
    try {
      const paths: SessionPaths = { wallets: join(legacy.dir, 'wallets'), state: join(legacy.dir, 'state.json'), db: join(legacy.dir, 'old.sqlite'), runDir: join(legacy.dir, 'cases') }
      mkdirSync(paths.wallets); mkdirSync(paths.runDir)
      writeFileSync(paths.state, '{"v":1,"existing":true}'); writeFileSync(paths.db, Buffer.from([0, 255, 33])); writeFileSync(join(paths.wallets, 'seed'), 'keep this seed')
      const registry = new DemoSessions(f.dir, paths), adopted = registry.current()!
      assert.equal(adopted.origin, 'legacy'); assert.equal(adopted.status, 'inspection'); assert.deepEqual(adopted.paths, paths)
      assert.equal(new DemoSessions(f.dir, paths).current()!.id, adopted.id)
      registry.create(); assert.deepEqual(registry.get('legacy').paths, paths)
      assert.equal(readFileSync(paths.state, 'utf8'), '{"v":1,"existing":true}')
      assert.deepEqual(readFileSync(paths.db), Buffer.from([0, 255, 33])); assert.equal(readFileSync(join(paths.wallets, 'seed'), 'utf8'), 'keep this seed')
    } finally { f.dispose(); legacy.dispose() }
  })
  it('refuses corrupted pointers, missing manifests and path/ID escapes instead of creating a replacement', () => {
    const f = fixture()
    try {
      const registry = new DemoSessions(f.dir), s = registry.create(), pointer = join(f.dir, 'active.json')
      writeFileSync(pointer, '{broken'); assert.throws(() => registry.current(), /Corrupt/); assert.throws(() => registry.create(), /Corrupt/)
      writeFileSync(pointer, JSON.stringify({ v: 1, id: '../outside' })); assert.throws(() => registry.current(), /Unsafe session ID/)
      writeFileSync(pointer, JSON.stringify({ v: 1, id: 'run-0000000000000-0000000000000000' })); assert.throws(() => registry.current(), /Unknown session/)
      writeFileSync(pointer, JSON.stringify({ v: 1, id: s.id }))
      const file = join(dirname(s.paths.wallets), 'session.json'); writeFileSync(file, JSON.stringify({ ...s, paths: { ...s.paths, wallets: '/tmp/another-wallet' } }))
      assert.throws(() => registry.current(), /namespace/)
    } finally { f.dispose() }
  })
  it('rejects symlink targets and unsupported manifest versions', () => {
    const f = fixture(), outside = fixture()
    try {
      const registry = new DemoSessions(f.dir), s = registry.create()
      symlinkSync(outside.dir, s.paths.wallets); assert.throws(() => registry.get(s.id), /Unsafe session path/)
      rmSync(s.paths.wallets); symlinkSync(join(outside.dir, 'missing-wallet'), s.paths.wallets)
      assert.throws(() => registry.get(s.id), /Unsafe session path/)
      rmSync(s.paths.wallets); const file = join(dirname(s.paths.wallets), 'session.json'); writeFileSync(file, JSON.stringify({ ...s, v: 2 }))
      assert.throws(() => registry.get(s.id), /Corrupt session manifest/)
      rmSync(join(f.dir, 'active.json')); symlinkSync(join(outside.dir, 'missing-pointer'), join(f.dir, 'active.json'))
      assert.throws(() => registry.create(), /Unsafe session file/)
    } finally { f.dispose(); outside.dispose() }
  })
  it('keeps an exclusive live-owner lock and releases only its own token', () => {
    const f = fixture(), a = new DemoSessions(f.dir), b = new DemoSessions(f.dir)
    try {
      const token = a.acquireLock(); assert.equal(a.acquireLock(), token)
      assert.throws(() => b.acquireLock(), /already running/)
      b.releaseLock(); assert.throws(() => b.acquireLock(), /already running/)
      a.releaseLock(); b.acquireLock(); b.releaseLock()
    } finally { f.dispose() }
  })
  it('reclaims a truly dead owner but refuses corrupt or changed ownership', async () => {
    const f = fixture(), registry = new DemoSessions(f.dir), child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await once(child, 'exit')
    try {
      const file = join(f.dir, 'supervisor.lock')
      writeFileSync(file, JSON.stringify({ v: 1, pid: child.pid!, token: 'a'.repeat(64), createdAt: new Date().toISOString(), startTime: null }))
      registry.acquireLock(); assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid); registry.releaseLock()
      writeFileSync(file, 'bad'); assert.throws(() => registry.acquireLock(), /Corrupt/)
      rmSync(file); registry.acquireLock(); const owner = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, JSON.stringify({ ...owner, token: 'b'.repeat(64) }))
      assert.throws(() => registry.releaseLock(), /refusing removal/); assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'b'.repeat(64))
    } finally { f.dispose() }
  })
  it('allows exactly one competing process to acquire either a fresh or stale lock', async () => {
    const f = fixture(), dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await once(dead, 'exit')
    const source = `
      import { DemoSessions } from ${JSON.stringify(new URL('../src/cli/demo-sessions.ts', import.meta.url).href)};
      const registry = new DemoSessions(process.env.PASSBOOK_SESSION_TEST_ROOT);
      process.once('message', () => {
        try {
          registry.acquireLock(); process.send('acquired');
          process.once('message', () => { registry.releaseLock(); process.exit(0); });
        } catch (error) { process.send('blocked'); process.exit(23); }
      });
      process.send('ready');
    `
    try {
      for (const stale of [false, true]) {
        if (stale) writeFileSync(join(f.dir, 'supervisor.lock'), JSON.stringify({ v: 1, pid: dead.pid!, token: 'c'.repeat(64), createdAt: new Date().toISOString(), startTime: null }))
        const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', source], { env: { ...process.env, PASSBOOK_SESSION_TEST_ROOT: f.dir }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }))
        const exits = children.map((child) => once(child, 'exit'))
        try {
          assert.deepEqual((await Promise.all(children.map((child) => once(child, 'message')))).map(([message]) => message), ['ready', 'ready'])
          const messages = children.map((child) => once(child, 'message'))
          children.forEach((child) => child.send('acquire'))
          const outcomes = (await Promise.all(messages)).map(([message]) => message)
          assert.deepEqual([...outcomes].sort(), ['acquired', 'blocked'])
          children[outcomes.indexOf('acquired')]!.send('release')
          const codes = (await Promise.all(exits)).map(([code]) => code)
          assert.deepEqual(codes.sort(), [0, 23])
        } finally { children.forEach((child) => { if (child.exitCode === null) child.kill() }); await Promise.all(exits) }
      }
    } finally { f.dispose() }
  })
})
