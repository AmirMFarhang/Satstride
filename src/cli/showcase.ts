// A stable dashboard around replaceable demo writers. Existing runs resume
// durable approval checkpoints or open read-only; only new runs may seed.
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DemoSessions, type DemoSession, type SessionPaths } from './demo-sessions.js'
import { newDashboardSession, parseDashboardSession, sessionToken } from '../server/auth.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
type Phase = 'starting' | 'ready' | 'failed' | 'stopping'
export interface DemoWriter { port: number; inspection?: boolean; quiesce(): Promise<boolean>; stop(): Promise<void> }
export type Launch = ((session: DemoSession, inspect: boolean, notify: (type: 'complete' | 'failed' | 'interrupted', error?: string) => void, resume?: boolean) => Promise<DemoWriter>) & { cancel?: () => Promise<void> }

function sessionEnv(paths: SessionPaths, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PORT: '0', PASSBOOK_URL: '', PASSBOOK_WALLETS: paths.wallets, PASSBOOK_STATE: paths.state,
    PASSBOOK_DB: paths.db, PASSBOOK_RUN_DIR: paths.runDir, PASSBOOK_DEMO_CHECKPOINT: join(dirname(paths.state), 'checkpoint.json'),
    PASSBOOK_WATCH_DIR: join(paths.wallets, 'platform/watch'), PASSBOOK_HISTORY_OBSERVER_DIR: join(paths.wallets, 'platform/history-observer') }
}

function waitExit(child: ChildProcess, timeoutMs = 90_000): Promise<void> {
  if ((child.exitCode !== null || child.signalCode !== null) && (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('close', done); reject(new Error('Demo is still closing its current operation. Its files were preserved; no replacement was started.')) }, timeoutMs)
    function done() { clearTimeout(timer); resolve() }
    child.once('close', done)
  })
}

export function localLauncher(args: string[], env: NodeJS.ProcessEnv, sessions: DemoSessions): Launch {
  let startup: ChildProcess | undefined
  let cancelled = false
  // The command that started the supervisor; a viewed or resumed run's saved options never replace it.
  const defaultArgs = args
  const defaultEnv = env
  let startupKind: 'services' | 'seed' | 'demo' = 'services'
  const launch: Launch = async (session, inspect, notify, resume = false) => {
    if (startup && startup.exitCode === null && startup.signalCode === null) throw new Error('Previous demo process has not confirmed exit; no replacement was started.')
    cancelled = false
    const launchFile = join(dirname(session.paths.state), 'launch.json')
    let runArgs = defaultArgs
    let runEnv = defaultEnv
    let resuming = false
    if (inspect) {
      if (existsSync(launchFile)) {
        const saved = JSON.parse(readFileSync(launchFile, 'utf8')) as { v: number; args: string[]; env: Record<string, string> }
        if (saved.v !== 1 || !Array.isArray(saved.args) || !saved.args.every((arg) => typeof arg === 'string') || !saved.env || typeof saved.env !== 'object') throw new Error('Invalid saved launch options; inspect the retained files.')
        runArgs = saved.args
        runEnv = { ...env, ...saved.env }
        resuming = resume && existsSync(join(dirname(session.paths.state), 'checkpoint.json'))
      } else runArgs = [] // legacy inspection infers the borrower from registry rows
    } else {
      const options = { v: 1, args: runArgs, env: Object.fromEntries(['PASSBOOK_AI', 'QVAC_MODEL', 'QVAC_CTX_SIZE', 'PASSBOOK_ORACLE', 'BLOCKS_PER_MONTH', 'COMPOSE_PROJECT_NAME', 'PASSBOOK_BITCOIND_PORT', 'PASSBOOK_ELECTRS_PORT', 'PASSBOOK_PROXY_PORT', 'PASSBOOK_RELAY_PORT', 'PASSBOOK_RLN_PAYER_PORT', 'PASSBOOK_RLN_PAYEE_PORT', 'PASSBOOK_RLN_VOLUME_SUFFIX', 'BITCOIND_URL', 'RGB_INDEXER_URL', 'RGB_TRANSPORT_URL', 'PASSBOOK_RELAYS', 'PASSBOOK_BORROWER_LIGHTNING_URL', 'PASSBOOK_LENDER_LIGHTNING_URL', 'PASSBOOK_LIGHTNING_PROXY'].filter((key) => runEnv[key] !== undefined).map((key) => [key, runEnv[key]])) }
      writeFileSync(launchFile + '.tmp', JSON.stringify(options) + '\n', { mode: 0o600 })
      renameSync(launchFile + '.tmp', launchFile)
    }
    const childEnv: NodeJS.ProcessEnv = { ...sessionEnv(session.paths, runEnv), PASSBOOK_DEMO_WRITER_LOCK: join(sessions.rootDir, '.writer') }
    const log = createWriteStream(join(dirname(session.paths.state), 'showcase.log'), { flags: 'a', mode: 0o600 })
    const spawn = (script: string, flags: string[]) => {
      const child = fork(join(ROOT, 'src/cli/showcase-worker.ts'), [script === 'infra/seed.ts' ? 'seed' : 'demo', ...flags], { cwd: ROOT, env: childEnv, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      child.stdout?.on('data', (data: Buffer) => { log.write(data); process.stdout.write(data) })
      child.stderr?.on('data', (data: Buffer) => { log.write(data); process.stderr.write(data) })
      startup = child
      startupKind = script === 'infra/seed.ts' ? 'seed' : 'demo'
      return child
    }
    try {
      const services = execFile('bash', ['infra/showcase-services.sh', ...((inspect && !resuming) ? ['--inspect'] : runArgs.includes('--atomic') ? [] : ['--legacy'])], { cwd: ROOT, env: childEnv }, (error, stdout, stderr) => {
        if (stdout) { log.write(stdout); process.stdout.write(stdout) }
        if (stderr) { log.write(stderr); process.stderr.write(stderr) }
      })
      startup = services
      startupKind = 'services'
      await new Promise<void>((resolveServices, reject) => { services.once('error', reject); services.once('exit', (code) => code === 0 ? resolveServices() : reject(new Error('Local services did not become ready; see showcase.log.'))) })
      if (cancelled) throw new Error('Showcase startup cancelled; files preserved.')
      if ((!inspect || resuming) && runArgs.includes('--atomic') && !childEnv.PASSBOOK_LIGHTNING_PROXY) {
        const exec = promisify(execFile)
        const { stdout: container } = await exec('docker', ['compose', '-f', 'infra/compose.yaml', 'ps', '-q', 'rgb-proxy'], { cwd: ROOT, env: childEnv })
        const { stdout: ip } = await exec('docker', ['inspect', container.trim(), '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'], { env: childEnv })
        childEnv.PASSBOOK_LIGHTNING_PROXY = `rpc://${ip.trim()}:3000/json-rpc`
      }
      if (!inspect) {
        sessions.update(session.id, { status: 'seeding' })
        if (cancelled) throw new Error('Showcase startup cancelled; files preserved.')
        const seed = spawn('infra/seed.ts', runArgs.includes('--persona') ? ['--personas'] : [])
        await waitExit(seed, 240_000)
        if (seed.exitCode !== 0) throw new Error('Demo seeding failed. See this run’s showcase.log; choose a new run to retry. Existing files have been preserved.')
      }
      if (cancelled) throw new Error('Showcase startup cancelled; files preserved.')
      if (!existsSync(session.paths.state)) throw new Error('This interrupted run has no completed seed. Start a new demo; its partial files remain preserved.')
      sessions.update(session.id, { status: inspect ? 'inspection' : 'starting' })
      const child = spawn('src/cli/demo.ts', ['--dashboard', '--serve', ...runArgs, ...(resuming ? ['--resume'] : inspect ? ['--inspect'] : [])])
      let intentional = false
      const ready = new Promise<DemoWriter>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('Demo startup timed out. Its run directory was preserved; inspect showcase.log.')), 240_000)
        child.once('error', (error) => { clearTimeout(timer); rejectReady(error) })
        child.on('message', (message: unknown) => {
          const m = message as { type?: string; port?: number; inspection?: boolean; error?: string }
          if (m?.type === 'showcase:ready' && Number.isInteger(m.port) && m.port! > 0) {
            clearTimeout(timer)
            sessions.update(session.id, { status: m.inspection ? 'inspection' : 'running' })
            resolveReady({
              port: m.port!, inspection: m.inspection === true,
              quiesce: () => new Promise<boolean>((answer) => {
                if (!child.connected) return answer(true)
                const id = randomUUID()
                const timeout = setTimeout(() => { child.off('message', receive); if (child.connected) child.send({ type: 'showcase:unfreeze', id }, () => {}); answer(false) }, 3000)
                const receive = (data: unknown) => {
                  const reply = data as { type?: string; id?: string; safe?: boolean }
                  if (reply?.type === 'showcase:quiesced' && reply.id === id) { clearTimeout(timeout); child.off('message', receive); answer(reply.safe === true) }
                }
                child.on('message', receive)
                child.send({ type: 'showcase:quiesce', id }, () => {})
              }),
              stop: async () => {
                intentional = true
                const exited = waitExit(child)
                if (child.connected) child.send({ type: 'showcase:stop' }, () => {})
                else child.kill('SIGTERM')
                await exited
              },
            })
          }
          if (m?.type === 'showcase:failed') notify('failed', m.error)
          if (m?.type === 'showcase:complete') notify('complete')
          if (m?.type === 'showcase:interrupted') notify('interrupted')
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          log.end()
          const message = `Demo writer exited (${signal ?? code}). Saved run retained for inspection.`
          rejectReady(new Error(message))
          if (!intentional) notify('failed', message)
        })
      })
      return await ready
    } catch (error) {
      if (startup?.pid && startup.exitCode === null && startup.signalCode === null) {
        if (startupKind === 'demo' && startup.connected) startup.send({ type: 'showcase:stop' }, () => {})
        else startup.kill('SIGTERM')
        await waitExit(startup) // A live startup handle is retained if exit cannot be confirmed.
      }
      if (!log.writableEnded) log.end(); throw error
    }
  }
  launch.cancel = async () => {
    cancelled = true
    if (startup?.pid && startup.exitCode === null && startup.signalCode === null) {
      if (startupKind === 'demo' && startup.connected) startup.send({ type: 'showcase:stop' }, () => {})
      else startup.kill('SIGTERM')
      await waitExit(startup)
    }
  }
  return launch
}

export class Showcase {
  readonly server = createServer((req, res) => void this.handle(req, res))
  private writer?: DemoWriter
  private session?: DemoSession
  private phase: Phase = 'starting'
  private error?: string
  private changing = false
  private readonly token = randomUUID()
  private generation = randomUUID()
  private inspecting = false
  private readonly responses = new Set<ServerResponse>()
  private closing = false
  private pending?: Promise<void>
  private closeRequest?: Promise<void>
  private replacement?: Promise<boolean>
  private readonly proxySockets = new Set<import('node:net').Socket>()

  constructor(readonly sessions: DemoSessions, private readonly launch: Launch) {}

  async listen(port = 4170): Promise<number> {
    this.sessions.acquireLock()
    try {
      await new Promise<void>((resolveReady, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolveReady() }) })
    } catch (error) { this.sessions.releaseLock(); throw error }
    const addr = this.server.address()
    return typeof addr === 'object' && addr ? addr.port : port
  }

  async start(fresh = false, id?: string): Promise<void> {
    if (id) this.sessions.current() // adopt a legacy run before resolving its ID
    const previous = id ? this.sessions.activate(id) : fresh ? null : this.sessions.current()
    this.session = previous ?? this.sessions.create()
    const inspect = !!previous
    this.pending = this.open(this.session, inspect, !!previous && !id)
    await this.pending
  }

  private async open(session: DemoSession, inspect: boolean, resume = false): Promise<void> {
    this.phase = 'starting'; this.error = undefined
    this.generation = randomUUID()
    this.inspecting = inspect
    try {
      this.writer = await this.launch(session, inspect, (kind, error) => {
        if (kind === 'failed') { this.phase = 'failed'; this.error = error; this.sessions.update(session.id, { status: 'failed', error }) }
        else if (kind === 'interrupted') this.sessions.update(session.id, { status: 'interrupted' })
        else if (this.sessions.get(session.id).status !== 'failed') this.sessions.update(session.id, { status: 'complete' })
      }, resume)
      this.inspecting = this.writer.inspection ?? inspect
      this.phase = 'ready'
    } catch (error) {
      this.phase = 'failed'; this.error = (error as Error).message
      this.sessions.update(session.id, { status: 'failed', error: this.error })
      console.error(this.error)
    }
  }

  replace(id?: string, resume = false): Promise<boolean> {
    if (this.changing || this.closing || this.phase === 'starting') return Promise.resolve(false)
    this.changing = true
    const transition = this.replaceOnce(id, resume)
    this.replacement = transition
    return transition.finally(() => { if (this.replacement === transition) this.replacement = undefined })
  }

  private async replaceOnce(id?: string, resume = false): Promise<boolean> {
    // An unknown or corrupted saved-run id is refused before anything changes: the current writer stays ready.
    if (id !== undefined) {
      try { this.sessions.get(id) } catch (error) { this.changing = false; throw error }
    }
    try {
      if (this.writer && !await this.writer.quiesce()) return false
      if (this.closing) return false
      this.phase = 'starting'
      for (const response of this.responses) response.destroy()
      for (const socket of this.proxySockets) socket.destroy()
      if (this.writer) await this.writer.stop()
      else await this.launch.cancel?.() // failed startup may still own a live child
      this.writer = undefined
      if (this.closing) { this.changing = false; return false }
      this.session = id ? this.sessions.activate(id) : this.sessions.create()
      // Existing sessions never seed again; only recorded checkpoints may resume.
      this.pending = this.open(this.session, !!id, resume).finally(() => { this.changing = false })
      return true
    } catch (error) { this.error = (error as Error).message; this.phase = 'failed'; this.changing = false; throw error }
    finally { if (this.phase !== 'starting') this.changing = false }
  }

  close(): Promise<void> {
    return this.closeRequest ??= this.closeOnce().catch((error) => { this.closeRequest = undefined; throw error })
  }

  private async closeOnce(): Promise<void> {
    this.closing = true
    this.phase = 'stopping'
    for (const response of this.responses) response.destroy()
    for (const socket of this.proxySockets) socket.destroy()
    try {
      await this.replacement
      if (this.writer) await this.writer.stop()
      else { await this.launch.cancel?.(); await this.pending; await this.stopWriter() }
    }
    catch (error) {
      this.error = (error as Error).message
      // Keep the live owner's lock when a writer has not confirmed exit.
      throw error
    }
    await new Promise<void>((resolveClosed) => { this.server.close(() => resolveClosed()); this.server.closeAllConnections() })
    this.sessions.releaseLock()
  }

  private async stopWriter(): Promise<void> { await this.writer?.stop() }

  private snapshot() {
    const current = this.session ? this.sessions.get(this.session.id) : null
    return { phase: this.phase, error: this.error, token: this.token, generation: this.generation, inspection: this.inspecting, current, runs: this.sessions.list().map((run) => {
      let can_resume = false
      try { const journal = JSON.parse(readFileSync(join(dirname(run.paths.state), 'checkpoint.json'), 'utf8')) as { completed?: boolean; pending?: unknown }; can_resume = journal.completed === false && !journal.pending } catch { /* legacy/partial runs stay inspectable */ }
      return { ...run, can_resume }
    }), changing: this.changing }
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/showcase/session' && req.method === 'GET') return this.json(res, 200, this.snapshot())
      if (url.pathname === '/showcase/session.js' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(readFileSync(join(ROOT, 'web/showcase.js'))); return
      }
      if (url.pathname === '/showcase/restart' && req.method === 'POST') {
        const origin = req.headers.origin
        if (origin && origin !== `http://${req.headers.host}`) return this.json(res, 403, { error: 'Use the local dashboard to change runs.' })
        if (!req.headers['content-type']?.startsWith('application/json')) return this.json(res, 415, { error: 'JSON request required' })
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return this.json(res, 413, { error: 'Request too large' }) }
        const body = JSON.parse(raw) as { token?: string; current?: string; generation?: string; inspect?: string; resume?: string }
        if (body.token !== this.token || body.current !== this.session?.id || body.generation !== this.generation) return this.json(res, 409, { error: 'This tab refers to an old run. Reload before changing sessions.' })
        if (body.resume !== undefined && (typeof body.resume !== 'string' || !body.resume || body.inspect !== undefined)) return this.json(res, 400, { error: 'Select one saved run action.' })
        if (body.inspect !== undefined && (typeof body.inspect !== 'string' || !body.inspect)) return this.json(res, 400, { error: 'Invalid run ID' })
        const accepted = await this.replace(body.inspect ?? body.resume, body.resume !== undefined)
        return this.json(res, accepted ? 202 : 409, accepted ? { ok: true } : { error: 'An operation is still running. Wait for the next approval or step before starting another demo.' })
      }
      if (url.pathname.startsWith('/showcase/')) return this.json(res, 404, { error: 'Unknown showcase action' })
      if (req.method === 'GET' && url.pathname === '/' && (this.phase !== 'ready' || !this.writer)) {
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(this.landing()); return
      }
      if (!this.writer || this.phase !== 'ready' || this.changing || this.closing) return this.json(res, 503, { error: 'Demo is preparing a new run. See /showcase/session.' })
      const mutating = !['GET', 'HEAD'].includes(req.method ?? 'GET')
      const run = req.headers['x-passbook-demo-run'] ?? url.searchParams.get('showcase_run')
      const generation = req.headers['x-passbook-demo-generation'] ?? url.searchParams.get('showcase_generation')
      if ((mutating || url.pathname === '/events' || run || generation) && (run !== this.session?.id || generation !== this.generation)) {
        if (url.pathname === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.end('event: showcase-replaced\ndata: {}\n\n'); return }
        return this.json(res, 409, { error: 'This page belongs to a previous demo. Reload before continuing.' })
      }
      if (mutating && this.inspecting) return this.json(res, 409, { error: 'Saved run inspection is read-only. Use New demo for another story.' })
      this.responses.add(res); res.once('close', () => this.responses.delete(res))
      const upstream = request({ host: '127.0.0.1', port: this.writer.port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${this.writer.port}` } }, (response) => {
        if (req.method === 'GET' && url.pathname === '/' && response.statusCode === 200) {
          let html = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { html += chunk })
          response.on('end', () => { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(html.replace('<head>', '<head>' + this.bindingScript()).replace('</body>', '<script type="module" src="/showcase/session.js"></script></body>')) })
        } else { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); response.on('aborted', () => res.destroy()); response.on('error', () => res.destroy()) }
      })
      upstream.on('socket', (socket) => { this.proxySockets.add(socket); socket.once('close', () => this.proxySockets.delete(socket)) })
      upstream.on('error', () => { if (!res.headersSent) this.json(res, 503, { error: 'Demo writer is unavailable; its saved run is retained.' }); else res.destroy() })
      res.on('close', () => upstream.destroy())
      req.pipe(upstream)
    } catch (error) { if (!res.headersSent) this.json(res, 400, { error: (error as Error).message }); else res.destroy() }
  }

  private bindingScript(): string {
    const binding = JSON.stringify({ run: this.session?.id, generation: this.generation }).replaceAll('<', '\\u003c')
    return `<script>(()=>{const b=${binding};window.passbookDemoSession=b;const original=window.fetch;window.fetch=(input,init={})=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);if(url.origin!==location.origin)return original(input,init);const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init.headers).forEach((v,k)=>headers.set(k,v));headers.set('x-passbook-demo-run',b.run);headers.set('x-passbook-demo-generation',b.generation);return original(input,{...init,headers})};const Source=window.EventSource;window.EventSource=class extends Source{constructor(input,options){const url=new URL(input,location.href);if(url.origin===location.origin){url.searchParams.set('showcase_run',b.run);url.searchParams.set('showcase_generation',b.generation)}super(url,options);this.addEventListener('showcase-replaced',()=>{this.close();location.replace('/')})}}})();</script>`
  }

  private landing(): string {
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Passbook — preparing demo</title><body data-showcase-loading style="font:16px/1.6 system-ui;margin:0;background:#f3f5f0;color:#163c31"><main style="max-width:760px;margin:10vh auto;padding:24px"><h1>Passbook demo</h1><p id="showcase-loading">Preparing this run’s wallets and local services…</p><p>Your previous runs are kept. Refreshing this page does not restart the story.</p></main>' + this.bindingScript() + '<script type="module" src="/showcase/session.js"></script></body></html>'
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log('Usage: npm run showcase -- [--fresh | --list | --inspect RUN_ID] [--legacy] [demo options]'); return }
  const home = resolve(process.env.PASSBOOK_SHOWCASE_DIR ?? join(ROOT, 'infra/showcase'))
  const legacy: SessionPaths = { wallets: resolve(process.env.PASSBOOK_WALLETS ?? join(home, 'wallets')), state: resolve(process.env.PASSBOOK_STATE ?? join(home, 'state.json')), db: resolve(process.env.PASSBOOK_DB ?? join(home, 'passbook.sqlite')), runDir: resolve(process.env.PASSBOOK_RUN_DIR ?? join(home, 'sandbox-runs')) }
  const sessions = new DemoSessions(home, legacy)
  if (args.includes('--list')) { console.log(JSON.stringify(sessions.list(), null, 2)); return }
  const inspectAt = args.indexOf('--inspect')
  const inspectId = inspectAt >= 0 ? args[inspectAt + 1] : undefined
  if (inspectAt >= 0 && (!inspectId || inspectId.startsWith('--'))) throw new Error('--inspect requires a run ID; use --list')
  const flags = args.filter((arg, index) => !['--fresh', '--legacy', '--inspect'].includes(arg) && (inspectAt < 0 || index !== inspectAt + 1))
  const demoArgs = args.includes('--legacy') ? flags : ['--persona', 'fatima', '--atomic', '--platform-off', ...flags]
  // Demo writers refuse unsigned writes (src/server/auth.ts). Every writer gets this one operator
  // session, so the link below keeps working across New demo, resume and inspection. It is passed
  // in the environment only; launch.json never stores it.
  const dashboardSession = process.env.PASSBOOK_DASHBOARD_SESSION ? parseDashboardSession(process.env.PASSBOOK_DASHBOARD_SESSION) : newDashboardSession()
  const showcase = new Showcase(sessions, localLauncher(demoArgs, { ...process.env, PASSBOOK_DASHBOARD_SESSION: sessionToken(dashboardSession) }, sessions))
  const port = await showcase.listen(Number(process.env.PORT ?? 4170))
  console.log(`Showcase (operator link, keep it private): http://127.0.0.1:${port}/#session=${sessionToken(dashboardSession)} — New demo keeps previous wallets and receipts.`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    console.log('Closing the demo writer at its next safe checkpoint…')
    void showcase.close().then(() => process.exit(0), (error: Error) => { console.error(error.message + ' Supervisor remains running to retain ownership; retry shutdown after the operation finishes.') })
  })
  await showcase.start(args.includes('--fresh'), inspectId)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error: Error) => { console.error(error.message); process.exit(1) })
