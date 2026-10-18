// A process that used an RGB wallet exits cleanly even when node tears the
// isolate down in the middle of an incremental marking cycle. rgb-lib's SWIG
// finalizers used to run there with no current isolate and end the process with
// SIGSEGV after its work was done (src/rgb/native-exit.ts). No chain: the wallet
// is opened offline in a child process.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('RGB native handles at process exit', () => {
  it('a process that closed an RGB wallet exits 0 when it ends mid-marking', () => {
    // how much to allocate at exit to end inside a marking cycle depends on the heap; try a spread
    for (const objects of [80_000, 120_000, 160_000, 200_000]) {
      const run = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'test/fixtures/rgb-exit.ts')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, EXIT_ALLOCATION: String(objects) } })
      assert.equal(run.signal, null, `exit allocation ${objects}: killed by ${run.signal}`)
      assert.equal(run.status, 0, `exit allocation ${objects}: ${run.stderr}`)
    }
  })
})
