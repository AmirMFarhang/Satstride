// M7 polish: a connection failure says which service the phone could not reach (the raw text kept
// as a detail), anything else keeps its own words; and the app's screens carry no demo or mock
// wording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isConnectionError, plainError } from '../src/ui/errors.ts'

test('connection failures are named by service; other errors keep their words', () => {
  assert.equal(plainError('TypeError: Network request failed').kind, 'platform')
  assert.equal(plainError('GET /state (502): bad gateway').kind, 'platform')
  assert.equal(plainError('no relay accepted event 1a2b3c4d').kind, 'relay')
  assert.equal(plainError('timed out waiting for kind 7471 from 9f3a1b2c').kind, 'lender')
  assert.equal(plainError('electrum tcp://127.0.0.1:50171: connection refused').kind, 'chain')
  const other = plainError('terms rejected: LTV above the earned ladder')
  assert.deepEqual(other, { kind: 'other', text: 'terms rejected: LTV above the earned ladder', detail: null })
  assert.equal(plainError('fetch failed').detail, 'fetch failed', 'the raw text stays visible')
  assert.ok(isConnectionError('fetch failed'))
  assert.ok(!isConnectionError('approve the term sheet before locking collateral'))
  assert.ok(!isConnectionError(null))
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|json)$/.test(f) ? [p] : []
  })
}

test('no demo or mock wording in what the app shows', () => {
  const root = join(import.meta.dirname, '..')
  const shown: string[] = []
  for (const f of [...files(join(root, 'src/ui')), ...files(join(root, 'src/app')), join(root, 'app.json')]) {
    const text = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    // quoted strings and JSX text only
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1|>([^<>{}\n]+)</g)) {
      const s = (m[2] ?? m[3] ?? '').trim()
      if (/\b(demo|mock(ed)?|fake|dummy|lorem|placeholder text|coming soon)\b/i.test(s)) shown.push(`${f.replace(root, '')}: ${s.slice(0, 80)}`)
    }
  }
  assert.deepEqual(shown, [])
})
