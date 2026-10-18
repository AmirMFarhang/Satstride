#!/usr/bin/env node
// A plain-JS entrypoint lets npm expose `passbook` while TypeScript stays in
// the source tree. Resolve tsx here so callers can run it from another cwd.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli/passbook.ts', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' })
child.once('error', () => { console.error('passbook could not start its TypeScript entrypoint'); process.exitCode = 1 })
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
