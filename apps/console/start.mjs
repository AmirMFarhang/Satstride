#!/usr/bin/env node
// Attach a new console frontend to an existing provider. Never starts, stops,
// seeds or changes the provider, wallets, chain, model or operator session.
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const IDENTITY = '/__passbook_console__'

export async function portIsOpen(port) {
  return new Promise(resolvePort => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = open => { socket.destroy(); resolvePort(open) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(true)) // uncertain ownership is never a free port
  })
}

export async function providerReady(platform) {
  const page = await fetch(new URL('console/', platform), { signal: AbortSignal.timeout(2500) })
  if (!page.ok || !/<title>(?:Satstride|Passbook) Provider Console<\/title>/.test(await page.text())) throw new Error('the target does not serve the Satstride provider console')
  const probe = await fetch(new URL('console/api/overview', platform), { signal: AbortSignal.timeout(2500) })
  if (probe.status === 401) return // operator authentication is required, as expected
  if (!probe.ok) throw new Error(`the console API answered HTTP ${probe.status}`)
  const overview = await probe.json()
  if (overview.v !== 1 || !overview.platform?.pubkey || !overview.network) throw new Error('the console API did not identify a Satstride provider')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: infra/demo-console.sh [--platform http://127.0.0.1:4391] [--port 4381] [--status]')
    console.log('Attaches to an existing provider; starts only the console frontend when absent. Ctrl+C stops only that frontend.')
    return
  }
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index < 0 ? fallback : args[index + 1]
  }
  const known = new Set(['--platform', '--port', '--status'])
  for (let index = 0; index < args.length; index++) {
    if (!known.has(args[index])) throw new Error(`unknown option ${args[index]}`)
    if (args[index] !== '--status') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${args[index]} needs a value`)
      index++
    }
  }
  const port = Number(option('port', process.env.PASSBOOK_CONSOLE_PORT ?? '4381'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1–65535')
  const platform = new URL(option('platform', process.env.PASSBOOK_CONSOLE_PLATFORM_URL ?? process.env.PASSBOOK_PLATFORM_URL ?? `http://127.0.0.1:${process.env.PASSBOOK_SP_PLATFORM_PORT ?? '4391'}`))
  if (!['http:', 'https:'].includes(platform.protocol) || platform.username || platform.password || platform.search || platform.hash) throw new Error('--platform needs an http(s) base URL without credentials, query or fragment')
  if (!platform.pathname.endsWith('/')) platform.pathname += '/'
  const consoleUrl = `http://127.0.0.1:${port}/`
  if (await portIsOpen(port)) {
    let existing
    try { existing = await (await fetch(new URL(IDENTITY, consoleUrl), { signal: AbortSignal.timeout(1500) })).json() } catch { /* refuse a service we cannot identify */ }
    if (existing?.service !== 'passbook-operator-console' || existing.v !== 1 || existing.platform !== platform.href) throw new Error(`port ${port} belongs to another service or console target; choose --port. Nothing was stopped.`)
    await providerReady(platform)
    console.log(`Console already running: ${consoleUrl}\nProvider: ${platform.origin}${platform.pathname}\nUse your existing private operator link in the browser.`)
    return
  }
  await providerReady(platform)
  if (args.includes('--status')) {
    console.log(`Provider is answering at ${platform.origin}${platform.pathname}; console is not started. Run infra/demo-console.sh to open it.`)
    process.exitCode = 1
    return
  }
  console.log(`Provider is answering at ${platform.origin}${platform.pathname}. Starting only the console frontend.`)
  const child = spawn(process.execPath, [join(HERE, 'server.mjs'), '--port', String(port), '--platform', platform.href], { stdio: 'inherit' })
  child.on('error', error => { console.error(`console: ${error.message}`); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = signal ? 0 : code ?? 1 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Demo console: ${error.message}\nThe provider and all wallet, chain and model state were left unchanged.`)
    process.exitCode = 1
  })
}
