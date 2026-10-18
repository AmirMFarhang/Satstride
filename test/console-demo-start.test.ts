import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))
const exit = (child: ChildProcess) => new Promise<number | null>(resolve => child.once('exit', resolve))

test('demo console: boots only its frontend, reuses it, and preserves operator authentication', async () => {
  const seen: string[] = []
  let providerTitle = 'Passbook Provider Console'
  const provider = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.url === '/console/') { res.end(`<title>${providerTitle}</title>`); return }
    res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"operator required"}')
  })
  const providerPort = await listen(provider)
  const reserve = createServer(); const port = await listen(reserve); await close(reserve)
  const args = ['apps/console/start.mjs', '--platform', `http://127.0.0.1:${providerPort}`, '--port', String(port)]
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const childExit = exit(child)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('console did not start')), 5000)
      child.stdout!.on('data', chunk => { if (String(chunk).includes('Satstride operator console:')) { clearTimeout(timer); resolve() } })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`console exited ${code}`)) })
    })
    const base = `http://127.0.0.1:${port}`
    const identity = await (await fetch(`${base}/__passbook_console__`)).json() as { service: string }
    assert.equal(identity.service, 'passbook-operator-console')
    assert.match(await (await fetch(base)).text(), /<title>Satstride Provider Console<\/title>/)
    assert.equal((await fetch(`${base}/console/api/overview`)).status, 401, 'frontend never adds an operator credential')
    assert.equal((await fetch(`${base}/fonts/sans-regular.ttf`)).headers.get('content-type'), 'font/ttf')
    assert.equal((await fetch(`${base}/start.mjs`)).status, 404)
    providerTitle = 'Satstride Provider Console'
    const second = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; second.stdout!.on('data', chunk => { output += chunk })
    assert.equal(await exit(second), 0)
    assert.match(output, /already running/)
    assert.ok(seen.every(request => request.startsWith('GET ')), 'no provider mutation or reset request')
  } finally {
    child.kill('SIGTERM'); await childExit
    await close(provider)
  }
})

test('demo console: refuses an occupied foreign port and leaves its service running', async () => {
  const foreign = createServer((_req, res) => { res.writeHead(404); res.end('another service') })
  const port = await listen(foreign)
  try {
    const child = spawn(process.execPath, ['apps/console/start.mjs', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let error = ''; child.stderr!.on('data', chunk => { error += chunk })
    assert.equal(await exit(child), 1)
    assert.match(error, /another service/)
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 404)
  } finally { await close(foreign) }
})

test('demo console: refuses credentials in a platform URL without echoing them', async () => {
  const child = spawn(process.execPath, ['apps/console/server.mjs', '--platform', 'http://user:private-auth@127.0.0.1:9/?token=private-query#private-fragment'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let error = ''; child.stderr!.on('data', chunk => { error += chunk })
  assert.equal(await exit(child), 2)
  assert.doesNotMatch(error, /private-auth|private-query|private-fragment/)
  assert.match(error, /without credentials/)
})
