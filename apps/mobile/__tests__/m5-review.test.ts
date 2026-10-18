// M5 review: a signed approval is never dropped when the platform's wire is down (it waits
// in the persisted outbox and goes first when the wire is back), and the provider script's
// stop returns only after the process has exited.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mnemonicToSeedSync } from '@scure/bip39'
import { verifyObject } from '../../../src/core/crypto.ts'
import { PhoneBorrower, type PhoneAgentState } from '../src/agent/borrower.ts'
import type { PartySigner } from '../src/agent/ports.ts'

const require = createRequire(import.meta.url)
const { rootFromSeed } = require('../worklet/keys.js')
const { PartyKey } = require('../worklet/party.js')
const party = new PartyKey(rootFromSeed(mnemonicToSeedSync('legal winner thank year wave sausage worth useful legal winner thank yellow')))
const key = { pubkey: party.pubkey, btc: party.btcOutput(), signObject: async (v: object) => party.signObject(v) } as unknown as PartySigner

test('an approval the wire did not take waits in the persisted outbox and is delivered first, in order', async () => {
  const delivered: { title: string; detail?: { approval?: { action: string } } }[] = []
  let up = false
  let saves = 0
  const platform = { note: async (n: { title: string }) => { if (!up) throw new Error('platform down'); delivered.push(n as never) } }
  const state: PhoneAgentState = { loans: {}, labels: {} }
  const agent = new PhoneBorrower(key, platform as never, {} as never, {} as never, {} as never, 'rgb:a', state, () => {}, async () => { saves++ })
  const consent = await agent.recordApproval('consent', { offer_id: 'o' })
  assert.equal(consent.waiting, 1)
  const lock = await agent.recordApproval('lock', { loan_id: 'l' })
  assert.equal(lock.waiting, 2)
  assert.equal(state.outbox!.length, 2, 'kept, not dropped')
  assert.ok(saves >= 2, 'persisted')
  up = true
  await agent.say('Terms checked and accepted')
  assert.deepEqual(delivered.map((n) => n.detail?.approval?.action ?? n.title), ['consent', 'lock', 'Terms checked and accepted'])
  assert.equal(state.outbox!.length, 0)
  for (const n of delivered.slice(0, 2)) assert.ok(verifyObject(n as never, party.pubkey))
})

test('stop waits for the process to exit before it returns (the platform closes its database first)', () => {
  const D = mkdtempSync(join(tmpdir(), 'proc-'))
  const script = `
    set -euo pipefail
    D='${D}'
    . '${join(import.meta.dirname, '../infra/proc.sh')}'
    start slow bash -c 'trap "sleep 1; exit 0" TERM; while :; do sleep 0.1; done'
    sleep 0.3
    p=$(cat "$D/slow.pid")
    t0=$(date +%s%N)
    stop slow
    t1=$(date +%s%N)
    if kill -0 "$p" 2>/dev/null; then echo STILL_RUNNING; fi
    echo "$(( (t1 - t0) / 1000000 ))"
  `
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /STILL_RUNNING/)
  assert.ok(Number(r.stdout.trim().split('\n').at(-1)) >= 800, `stop returned after ${r.stdout.trim()} ms`)
  assert.equal(existsSync(join(D, 'slow.pid')), false)
})
