#!/usr/bin/env node
// Standalone static server for the Satstride operator console.
//
//   node apps/console/server.mjs --port 4381 --platform http://127.0.0.1:4371 [--host 127.0.0.1]
//
// Serves a fixed allowlist of files from this directory (no directory
// traversal) and proxies every /console/api/* request to the platform
// unchanged: method, path and query, the x-passbook-* signature headers,
// content-type and body. The response streams back with its status code.
// No dependencies.

import http from 'node:http'
import https from 'node:https'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : fallback
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node apps/console/server.mjs [--port 4381] [--platform http://127.0.0.1:4371] [--host 127.0.0.1]')
  process.exit(0)
}

const port = Number(arg('port', process.env.PASSBOOK_CONSOLE_PORT ?? '4381'))
const host = arg('host', '127.0.0.1')
const platformArg = arg('platform', process.env.PASSBOOK_PLATFORM_URL ?? 'http://127.0.0.1:4371')
let platform
try {
  platform = new URL(platformArg)
  if ((platform.protocol !== 'http:' && platform.protocol !== 'https:') || platform.username || platform.password || platform.search || platform.hash) throw new Error('not a public base URL')
} catch {
  console.error('console: --platform must be an http(s) base URL without credentials, query or fragment')
  process.exit(2)
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`console: --port must be 1-65535, got ${JSON.stringify(arg('port'))}`)
  process.exit(2)
}

const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
}

// Fixed allowlist. /js/<name>.js is allowed only by this exact pattern.
const FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/console.css': 'console.css',
  '/console.js': 'console.js',
  '/session-auth.js': 'session-auth.js',
  '/brand.svg': 'brand.svg',
  '/fonts/sans-regular.ttf': 'fonts/sans-regular.ttf',
  '/fonts/sans-medium.ttf': 'fonts/sans-medium.ttf',
  '/fonts/sans-semibold.ttf': 'fonts/sans-semibold.ttf',
  '/fonts/mono-regular.ttf': 'fonts/mono-regular.ttf',
}
const JS_MODULE = /^\/js\/[a-z0-9-]+\.js$/

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

function send(res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type })
  res.end(body)
}

async function serveFile(req, res, pathname) {
  // Mounted-style paths also work: /console/ and /console/<file>.
  let p = pathname
  if (p === '/console') { res.writeHead(308, { ...SECURITY_HEADERS, location: '/console/' }); return res.end() }
  if (p.startsWith('/console/')) p = p.slice('/console'.length)
  const file = FILES[p] ?? (JS_MODULE.test(p) ? p.slice(1) : null)
  if (!file) return send(res, 404, 'text/plain; charset=utf-8', 'not found\n')
  try {
    const body = await readFile(join(HERE, file))
    const ext = file.slice(file.lastIndexOf('.') + 1)
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[ext] ?? 'application/octet-stream' })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'not found\n')
  }
}

const FORWARD_REQUEST = ['content-type', 'content-length', 'accept', 'x-passbook-session', 'x-passbook-ts', 'x-passbook-nonce', 'x-passbook-hmac']
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'])

function proxy(req, res) {
  const headers = {}
  for (const h of FORWARD_REQUEST) if (req.headers[h] !== undefined) headers[h] = req.headers[h]
  for (const h of Object.keys(req.headers)) if (h.startsWith('x-passbook-')) headers[h] = req.headers[h]
  const basePath = platform.pathname.replace(/\/$/, '')
  const lib = platform.protocol === 'https:' ? https : http
  const upstream = lib.request({
    protocol: platform.protocol,
    hostname: platform.hostname,
    port: platform.port || (platform.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: `${basePath}${req.url}`,
    headers,
  }, (up) => {
    const out = { ...SECURITY_HEADERS }
    for (const [k, v] of Object.entries(up.headers)) if (!DROP_RESPONSE.has(k) && k !== 'cache-control') out[k] = v
    res.writeHead(up.statusCode ?? 502, out)
    up.pipe(res)
  })
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('platform did not answer within 30 s')))
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy()
    send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: `platform unreachable at ${platform.origin}: ${err.message}` }))
  })
  req.pipe(upstream)
}

const server = http.createServer((req, res) => {
  let pathname
  try { pathname = new URL(req.url ?? '/', 'http://x').pathname } catch { return send(res, 400, 'text/plain; charset=utf-8', 'bad request\n') }
  if (pathname === '/__passbook_console__' && req.method === 'GET') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ service: 'passbook-operator-console', v: 1, platform: platform.href }))
  if (pathname === '/console/api' || pathname.startsWith('/console/api/')) return proxy(req, res)
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n')
  serveFile(req, res, pathname).catch(() => send(res, 500, 'text/plain; charset=utf-8', 'error\n'))
})

server.on('error', (err) => {
  console.error(`console: cannot listen on ${host}:${port}: ${err.message}`)
  process.exit(1)
})

server.listen(port, host, () => {
  const shown = host.includes(':') ? `[${host}]` : host
  console.log(`Satstride operator console: http://${shown}:${port}/`)
  console.log(`  proxying /console/api/* to ${platform.origin}${platform.pathname.replace(/\/$/, '')}`)
  console.log('  open it with the #session=… part of the platform\'s operator link appended')
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    server.closeAllConnections?.()
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
