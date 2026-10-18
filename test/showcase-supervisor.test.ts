import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, it, type TestContext } from 'node:test'
import { DemoSessions, type DemoSession, type DemoSessionStatus } from '../src/cli/demo-sessions.js'
import { Showcase, type Launch } from '../src/cli/showcase.js'

interface Snapshot { token: string; generation: string | number; phase: string; current: DemoSession; changing: boolean }
interface Child {
  session: DemoSession; inspect: boolean; server: Server; safe: boolean; stops: number
  notify: Parameters<Launch>[2]
  stopError?: Error; stopWait?: Promise<void>; requests: { method: string; url: string }[]
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
}
async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await setImmediate()
  }
  assert.fail(message)
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-supervisor-')), sessions = new DemoSessions(dir)
  const children: Child[] = [], events: string[] = []
  const retained = new Set<Child>()
  const control = { failStarts: 0, cancelCalls: 0, cancelError: undefined as Error | undefined, cancelWait: undefined as Promise<void> | undefined }
  const launch: Launch = async (session, inspect, notify) => {
    events.push(`launch:${session.id}`)
    const requests: Child['requests'] = []
    const server = createServer(async (req, res) => {
      requests.push({ method: req.method!, url: req.url! })
      for await (const _chunk of req) { /* consume mutation bodies before replying */ }
      if (req.url?.startsWith('/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ run: session.id })}\n\n`)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ run: session.id, inspect }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const child: Child = { session, inspect, server, safe: true, stops: 0, requests, notify }
    children.push(child)
    if (!inspect) {
      mkdirSync(session.paths.wallets, { recursive: true }); mkdirSync(session.paths.runDir, { recursive: true })
      writeFileSync(session.paths.state, JSON.stringify({ seed_for: session.id }))
      writeFileSync(session.paths.db, `database:${session.id}`)
      writeFileSync(join(session.paths.wallets, 'seed.fixture'), `seed:${session.id}`)
      writeFileSync(join(session.paths.runDir, 'case.fixture'), `evidence:${session.id}`)
    }
    sessions.update(session.id, { status: inspect ? 'inspection' : 'running' })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    if (control.failStarts > 0) {
      control.failStarts--
      retained.add(child)
      throw new Error('startup failed while its child is still alive')
    }
    return {
      port: address.port,
      quiesce: async () => { events.push(`quiesce:${session.id}`); return child.safe },
      stop: async () => {
        child.stops++; events.push(`stop:${session.id}`)
        if (child.stopError) throw child.stopError
        await child.stopWait
        await closeServer(server)
        events.push(`stopped:${session.id}`)
      },
    }
  }
  launch.cancel = async () => {
    control.cancelCalls++; events.push('cancel')
    await control.cancelWait
    if (control.cancelError) throw control.cancelError
    for (const child of retained) {
      await closeServer(child.server)
      events.push(`cancelled:${child.session.id}`)
      retained.delete(child)
    }
  }
  const showcase = new Showcase(sessions, launch)
  const port = await showcase.listen(0), base = `http://127.0.0.1:${port}`
  t.after(async () => {
    control.cancelError = undefined; control.cancelWait = undefined
    for (const child of children) { child.stopError = undefined; child.stopWait = undefined }
    await showcase.close().catch(() => { /* a test may deliberately retain the lock */ })
    for (const child of children) await closeServer(child.server)
    sessions.releaseLock()
    rmSync(dir, { recursive: true, force: true })
  })
  const snapshot = async (): Promise<Snapshot> => {
    const response = await fetch(`${base}/showcase/session`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    return await response.json() as Snapshot
  }
  const ready = async (): Promise<Snapshot> => {
    for (let i = 0; i < 100; i++) {
      const state = await snapshot()
      if (state.phase === 'ready' && !state.changing) return state
      assert.notEqual(state.phase, 'failed', JSON.stringify(state))
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('fake HTTP writer did not become ready')
  }
  const headers = (state: Snapshot) => ({ 'content-type': 'application/json', 'x-passbook-demo-run': state.current.id, 'x-passbook-demo-generation': String(state.generation) })
  const post = async (path: string, body: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) })
    await response.text()
    return response.status
  }
  return { dir, sessions, showcase, base, children, events, control, snapshot, ready, headers, post }
}
function savedBytes(session: DemoSession) {
  return [session.paths.state, session.paths.db, join(session.paths.wallets, 'seed.fixture'), join(session.paths.runDir, 'case.fixture')].map((path) => ({ path, bytes: readFileSync(path) }))
}

describe('managed showcase writer lifecycle', () => {
  it('allocates an isolated fresh writer on first use and holds one supervisor lock', async (t) => {
    const f = await fixture(t)
    await f.showcase.start()
    const state = await f.ready()
    assert.equal(f.children.length, 1); assert.equal(f.children[0].inspect, false)
    assert.equal(state.current.id, f.sessions.current()!.id)
    assert.equal(state.current.status, 'running')
    assert.equal(existsSync(state.current.paths.state), true)
    assert.equal(typeof state.token, 'string'); assert.ok(state.token.length >= 20)
    assert.ok(state.generation !== undefined, 'every writer has a tab-binding generation')
    assert.throws(() => new DemoSessions(f.dir).acquireLock(), /already running/)
  })

  it('never executes a recovered run, including an interrupted newly allocated manifest', async (t) => {
    const statuses: DemoSessionStatus[] = ['new', 'seeding', 'starting', 'running', 'complete', 'interrupted', 'failed', 'inspection']
    for (const status of statuses) await t.test(status, async (sub) => {
      const f = await fixture(sub), old = f.sessions.create()
      f.sessions.update(old.id, { status })
      await f.showcase.start(false)
      assert.equal(f.children.length, 1)
      assert.equal(f.children[0].session.id, old.id)
      assert.equal(f.children[0].inspect, true, `${status} is recovered state, not authority to seed again`)
      assert.equal(existsSync(old.paths.state), false, 'the fake fresh-only seed never ran')
      assert.equal(f.sessions.list().length, 1)
    })
  })

  it('stops the previous writer before allocating fresh paths and preserves its files', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const first = await f.ready(), original = savedBytes(first.current), stop = deferred()
    f.children[0].stopWait = stop.promise
    const replacement = f.showcase.replace()
    try {
      for (let i = 0; !f.events.includes(`stop:${first.current.id}`) && i < 100; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1))
      assert.equal(f.children[0].stops, 1)
      assert.equal(f.sessions.list().length, 1, 'no replacement namespace exists while the old writer can still write')
      assert.equal(f.sessions.current()!.id, first.current.id)
    } finally { stop.resolve() }
    assert.equal(await replacement, true)
    const second = await f.ready()
    assert.notEqual(second.current.id, first.current.id)
    assert.notEqual(second.generation, first.generation)
    for (const key of ['wallets', 'state', 'db', 'runDir'] as const) assert.notEqual(second.current.paths[key], first.current.paths[key])
    assert.equal(f.children[1].inspect, false)
    assert.ok(f.events.indexOf(`stopped:${first.current.id}`) < f.events.indexOf(`launch:${second.current.id}`))
    for (const saved of original) assert.deepEqual(readFileSync(saved.path), saved.bytes)
  })

  it('rejects replay while the writer is busy without changing its session or generation', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const before = await f.ready()
    f.children[0].safe = false
    assert.equal(await f.showcase.replace(), false)
    const after = await f.snapshot()
    assert.equal(after.current.id, before.current.id); assert.equal(after.generation, before.generation)
    assert.equal(after.phase, 'ready'); assert.equal(after.changing, false)
    assert.equal(f.children.length, 1); assert.equal(f.children[0].stops, 0); assert.equal(f.sessions.list().length, 1)
    assert.equal(await f.post('/demo/confirm', { accept: true }, f.headers(before)), 200, 'the current gate remains usable')
  })

  it('accepts only one of two concurrent replacements', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const first = await f.ready(), stop = deferred()
    f.children[0].stopWait = stop.promise
    const a = f.showcase.replace(), b = f.showcase.replace()
    assert.equal(await b, false)
    assert.equal(f.children.length, 1); assert.equal(f.sessions.current()!.id, first.current.id)
    stop.resolve()
    assert.equal(await a, true)
    await f.ready()
    assert.equal(f.children.length, 2); assert.equal(f.children[0].stops, 1); assert.equal(f.sessions.list().length, 2)
  })

  it('activates an old run only for inspection, preserving its exact paths and evidence', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const first = await f.ready(), original = savedBytes(first.current)
    assert.equal(await f.showcase.replace(), true)
    const second = await f.ready()
    assert.equal(await f.showcase.replace(first.current.id), true)
    const revisited = await f.ready()
    assert.equal(f.children.length, 3); assert.equal(f.children[2].inspect, true)
    assert.equal(f.children[1].stops, 1)
    assert.equal(revisited.current.id, first.current.id); assert.deepEqual(revisited.current.paths, first.current.paths)
    assert.notEqual(revisited.generation, first.generation); assert.notEqual(revisited.generation, second.generation)
    assert.equal(f.sessions.list().length, 2)
    for (const saved of original) assert.deepEqual(readFileSync(saved.path), saved.bytes)
  })

  it('retains the supervisor lock if shutdown cannot prove its writer stopped', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const before = await f.ready(), child = f.children[0]
    child.stopError = new Error('writer still closing a financial operation')
    await assert.rejects(f.showcase.close(), /writer still closing/)
    assert.throws(() => new DemoSessions(f.dir).acquireLock(), /already running/)
    assert.equal(f.sessions.current()!.id, before.current.id)
    assert.equal(f.children.length, 1)
    child.stopError = undefined
    await f.showcase.close()
    const nextOwner = new DemoSessions(f.dir)
    nextOwner.acquireLock(); nextOwner.releaseLock()
  })

  it('keeps session controls reachable after a ready writer reports failure and permits a new run', async (t) => {
    for (const exited of [false, true]) await t.test(exited ? 'writer exited' : 'story failed while HTTP still serves', async (sub) => {
      const f = await fixture(sub)
      await f.showcase.start(true)
      const first = await f.ready(), original = savedBytes(first.current), child = f.children[0]
      if (exited) await closeServer(child.server)
      child.notify('failed', exited ? 'Demo writer exited unexpectedly' : 'Demo story failed after readiness')
      const failed = await f.snapshot()
      assert.equal(failed.current.status, 'failed')
      const response = await fetch(`${f.base}/`, { signal: AbortSignal.timeout(2000) })
      assert.equal(response.status, 200, 'a failed writer must not leave the page at a dead-child JSON error')
      assert.match(response.headers.get('content-type')!, /text\/html/)
      const shell = await response.text()
      assert.match(shell, /data-showcase-loading/)
      assert.match(shell, /\/showcase\/session\.js/, 'session management remains available after either kind of failure')
      assert.equal(failed.phase, 'failed')
      assert.equal(await f.post('/showcase/restart', { token: failed.token, current: failed.current.id, generation: failed.generation }), 202)
      const next = await f.ready()
      assert.notEqual(next.current.id, first.current.id)
      assert.equal(f.children.length, 2); assert.equal(child.stops, 1)
      assert.equal(f.sessions.get(first.current.id).status, 'failed')
      for (const saved of original) assert.deepEqual(readFileSync(saved.path), saved.bytes)
    })
  })

  it('awaits retained startup-child cancellation and allocates nothing when cancellation fails', async (t) => {
    const f = await fixture(t)
    f.control.failStarts = 1
    await f.showcase.start(true)
    const first = await f.snapshot(), original = savedBytes(first.current)
    assert.equal(first.phase, 'failed'); assert.equal(f.children.length, 1)
    assert.equal(f.children[0].server.listening, true, 'the failed launch still owns its real HTTP child')
    const cancel = deferred()
    f.control.cancelWait = cancel.promise
    f.control.cancelError = new Error('retained startup child cannot stop yet')
    let settled = false
    const replacement = f.showcase.replace().finally(() => { settled = true })
    const refused = assert.rejects(replacement, /retained startup child cannot stop yet/)
    try {
      await until(() => f.control.cancelCalls === 1, 'replacement never attempted startup cleanup')
      await setImmediate()
      assert.equal(settled, false, 'replacement must await cancellation before changing the namespace')
      assert.equal(f.sessions.list().length, 1); assert.equal(f.children.length, 1)
      assert.equal(f.sessions.current()!.id, first.current.id)
    } finally { cancel.resolve() }
    await refused
    assert.equal(f.children[0].server.listening, true)
    assert.equal(f.sessions.list().length, 1); assert.equal(f.children.length, 1)
    assert.equal(f.sessions.current()!.id, first.current.id)
    assert.throws(() => new DemoSessions(f.dir).acquireLock(), /already running/)

    f.control.cancelError = undefined; f.control.cancelWait = undefined
    assert.equal(await f.showcase.replace(), true)
    const second = await f.ready()
    assert.equal(f.control.cancelCalls, 2)
    assert.equal(f.children[0].server.listening, false)
    assert.equal(f.children.length, 2); assert.notEqual(second.current.id, first.current.id)
    assert.ok(f.events.indexOf(`cancelled:${first.current.id}`) < f.events.indexOf(`launch:${second.current.id}`))
    for (const saved of original) assert.deepEqual(readFileSync(saved.path), saved.bytes)
  })

  it('waits for an in-progress replacement stop and never allocates or launches after closing begins', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const first = await f.ready(), original = savedBytes(first.current), stop = deferred()
    f.children[0].stopWait = stop.promise
    const replacement = f.showcase.replace()
    await until(() => f.children[0].stops > 0, 'replacement never began stopping the old writer')
    let closed = false
    const closing = f.showcase.close().then(() => { closed = true })
    try {
      await setImmediate()
      assert.equal(closed, false, 'close must wait for the existing writer stop')
      assert.equal(f.children[0].stops, 1, 'shutdown joins the existing stop instead of stopping the writer twice')
      assert.equal(f.children.length, 1); assert.equal(f.sessions.list().length, 1)
      assert.throws(() => new DemoSessions(f.dir).acquireLock(), /already running/)
    } finally { stop.resolve() }
    const [accepted] = await Promise.all([replacement, closing])
    assert.equal(accepted, false, 'the interrupted replacement does not become an accepted new run')
    assert.equal(closed, true); assert.equal(f.children.length, 1)
    assert.equal(f.sessions.list().length, 1); assert.equal(f.sessions.current()!.id, first.current.id)
    assert.equal(f.children[0].server.listening, false)
    assert.equal(await f.showcase.replace(), false)
    for (const saved of original) assert.deepEqual(readFileSync(saved.path), saved.bytes)
    const nextOwner = new DemoSessions(f.dir)
    nextOwner.acquireLock(); nextOwner.releaseLock()
  })

  it('coalesces concurrent close requests into one writer stop and releases the lock after that stop', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const stop = deferred()
    f.children[0].stopWait = stop.promise
    let completed = 0
    const first = f.showcase.close().then(() => { completed++ })
    const second = f.showcase.close().then(() => { completed++ })
    try {
      await until(() => f.children[0].stops > 0, 'close never began stopping its writer')
      await setImmediate()
      assert.equal(f.children[0].stops, 1)
      assert.equal(completed, 0)
      assert.throws(() => new DemoSessions(f.dir).acquireLock(), /already running/)
    } finally { stop.resolve() }
    await Promise.all([first, second])
    assert.equal(completed, 2); assert.equal(f.children[0].stops, 1)
    assert.equal(f.children.length, 1); assert.equal(f.sessions.list().length, 1)
    assert.equal(f.children[0].server.listening, false)
    await f.showcase.close()
    assert.equal(f.children[0].stops, 1, 'a completed close stays idempotent')
    const nextOwner = new DemoSessions(f.dir)
    nextOwner.acquireLock(); nextOwner.releaseLock()
  })
})

describe('showcase management and stale-tab isolation', () => {
  it('rejects empty inspect and resume selections without replacing the current writer', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const before = await f.ready(), body = { token: before.token, current: before.current.id, generation: before.generation }
    // An unknown saved-run id is refused too, and the healthy writer stays ready (no 'failed' phase).
    for (const selection of [{ inspect: '' }, { resume: '' }, { inspect: before.current.id, resume: before.current.id }, { inspect: 'no-such-run' }, { resume: 'no-such-run' }]) {
      assert.equal(await f.post('/showcase/restart', { ...body, ...selection }), 400)
      const after = await f.snapshot()
      assert.equal(after.current.id, before.current.id); assert.equal(after.generation, before.generation)
      assert.equal(after.phase, 'ready'); assert.equal(after.changing, false)
      assert.equal(f.children.length, 1); assert.equal(f.children[0].stops, 0)
      assert.equal(f.sessions.list().length, 1)
    }
  })

  it('denies cross-origin, missing-token, missing-generation and stale restart requests', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const state = await f.ready(), body = { token: state.token, current: state.current.id, generation: state.generation }
    assert.equal(await f.post('/showcase/restart', body, { origin: 'https://untrusted.example' }), 403)
    assert.equal(await f.post('/showcase/restart', { ...body, token: 'wrong' }), 409)
    assert.equal(await f.post('/showcase/restart', { current: state.current.id, generation: state.generation }), 409)
    assert.equal(await f.post('/showcase/restart', { token: state.token, current: state.current.id }), 409)
    assert.equal(await f.post('/showcase/restart', { ...body, current: 'not-this-run' }), 409)
    assert.equal(f.children.length, 1)
    assert.equal(await f.post('/showcase/restart', body, { origin: f.base }), 202)
    await f.ready()
    assert.equal(await f.post('/showcase/restart', body, { origin: f.base }), 409)
    assert.equal(f.children.length, 2, 'a repeated request cannot create another writer')
  })

  it('blocks unbound and stale financial POSTs even after the same saved run is revisited', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const first = await f.ready()
    assert.equal(await f.post('/demo/confirm', { accept: true }), 409)
    assert.equal(await f.post('/demo/confirm', { accept: true }, f.headers(first)), 200)
    assert.equal(f.children[0].requests.length, 1)
    assert.equal(await f.showcase.replace(), true)
    const second = await f.ready()
    for (const path of ['/demo/confirm', '/demo/next', '/oracle/set', '/loans/example/repay']) {
      assert.equal(await f.post(path, { accept: true }, f.headers(first)), 409)
    }
    assert.equal(f.children[1].requests.length, 0, 'stale financial requests never reach the replacement writer')
    assert.equal(await f.post('/demo/confirm', { accept: true }, f.headers(second)), 200)
    assert.equal(await f.showcase.replace(first.current.id), true)
    const revisited = await f.ready()
    assert.equal(revisited.current.id, first.current.id)
    assert.equal(await f.post('/demo/confirm', { accept: true }, f.headers(first)), 409, 'matching run IDs do not revive old approval authority')
    assert.equal(f.children[2].requests.length, 0)
    assert.equal(await f.post('/demo/confirm', { accept: true }, f.headers(revisited)), 409, 'saved-run inspection remains read-only even with a current binding')
    assert.equal(f.children[2].requests.length, 0)
  })

  it('closes the old SSE stream and refuses stale or unbound subscriptions to the new writer', async (t) => {
    const f = await fixture(t)
    await f.showcase.start(true)
    const first = await f.ready()
    const query = (state: Snapshot) => new URLSearchParams({ showcase_run: state.current.id, showcase_generation: String(state.generation) })
    const req = get(`${f.base}/events?${query(first)}`)
    req.on('error', () => { /* replacing a writer deliberately closes its proxy socket */ })
    t.after(() => req.destroy())
    const [stream] = await once(req, 'response')
    assert.equal(stream.statusCode, 200)
    const closed = new Promise<void>((resolve) => stream.once('close', resolve))
    stream.on('error', () => { /* expected when the old upstream is disconnected */ })
    const [firstEvent] = await once(stream, 'data')
    assert.match(String(firstEvent), new RegExp(first.current.id))
    assert.equal(await f.showcase.replace(), true)
    const second = await f.ready()
    let timeout: NodeJS.Timeout | undefined
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('old SSE remained connected')), 1000) })]) }
    finally { clearTimeout(timeout) }
    for (const suffix of ['', `?${query(first)}`, `?${new URLSearchParams({ showcase_run: second.current.id, showcase_generation: String(first.generation) })}`]) {
      const response = await fetch(`${f.base}/events${suffix}`, { signal: AbortSignal.timeout(2000) })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /text\/event-stream/)
      assert.match(await response.text(), /^event: showcase-replaced\ndata: \{\}\n\n$/, 'a stale EventSource gets only a replacement notice, never new financial events')
    }
    assert.equal(f.children[1].requests.length, 0, 'an old tab cannot consume events from the new run')
    const fresh = get(`${f.base}/events?${query(second)}`)
    fresh.on('error', () => { /* teardown closes this stream */ })
    t.after(() => fresh.destroy())
    const [newStream] = await once(fresh, 'response')
    newStream.on('error', () => { /* teardown closes this stream */ })
    assert.equal(newStream.statusCode, 200)
    const [newEvent] = await once(newStream, 'data')
    assert.match(String(newEvent), new RegExp(second.current.id))
    fresh.destroy()
  })
})
