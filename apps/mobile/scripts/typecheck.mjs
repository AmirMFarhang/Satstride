// TypeScript for the app. The agent imports the shared protocol code from ../../src, whose
// type-only imports reach Node-only modules (scorer, server) that this React Native type
// environment (its own URL and process.env types) reads differently from @types/node. The
// root CI typechecks src/ under its own tsconfig, so here an error in ../../src is reported
// as shared-code noise and does not fail; any error in apps/mobile itself fails.
import { spawnSync } from 'node:child_process'

const r = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], { encoding: 'utf8' })
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
const errors = []
for (const line of out.split('\n')) {
  if (/^\S.*\(\d+,\d+\): error TS\d+/.test(line)) errors.push([line])
  else if (line.trim() && errors.length) errors.at(-1).push(line)
}
const shared = errors.filter(([head]) => head.startsWith('../../src/'))
const own = errors.filter(([head]) => !head.startsWith('../../src/'))
if (shared.length) console.log(`typecheck: ${shared.length} error(s) in ../../src under the app's type environment (checked by the root CI instead):\n${shared.map(([h]) => `  ${h}`).join('\n')}`)
if (own.length) { console.error(own.map((e) => e.join('\n')).join('\n')); process.exit(1) }
if (r.status !== 0 && !errors.length) { console.error(out); process.exit(r.status ?? 1) }
console.log('typecheck: apps/mobile ok')
