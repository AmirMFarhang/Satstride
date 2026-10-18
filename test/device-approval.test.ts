// Approving on the phone produces the same signed approval as approving on the
// dashboard. Shared fixture: test/fixtures/device/approval.json (stop 2 for one
// term sheet). The dashboard answers with its operator session (web/session-auth.js,
// the body web/app.js builds); the phone with its device key (apps/android/src/core).
// Either way the node's borrower agent then signs the approval, bound to the
// term-sheet hash, as BorrowerAgent.approveTermSheet does.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { hashObject, keyPairFromLabel, verifyObject } from '../src/core/crypto.js'
import { DemoGate } from '../src/cli/demo-gate.js'
import { approvalStatus, approve, type Approval } from '../src/market/approvals.js'
import type { LenderPolicy } from '../src/market/policy.js'
import { termSheetHash, termSheetProblems, type TermSheet } from '../src/market/termsheet.js'
import { Store } from '../src/registry/store.js'
import { createApp, type App } from '../src/server/app.js'
import { authFromEnv, newDashboardSession, type DashboardSession } from '../src/server/auth.js'
import { signedPost } from '../web/session-auth.js'
import { NodeClient, pair, stopRequests } from '../apps/android/src/core/client.js'
import { borrowerStop, screenName } from '../apps/android/src/core/model.js'
import { parsePairingLink } from '../apps/android/src/core/pairing.js'
import { newDeviceKey } from '../apps/android/src/core/signing.js'

/** fetch against this node, for web/session-auth.js signedPost (which takes a path). */
const at = (base: string) => ((input: RequestInfo | URL, init?: RequestInit) => fetch(base + String(input), init)) as typeof fetch

interface Fixture {
  borrower_label: string
  termsheet: TermSheet
  waiting: { waiting: 'confirm'; stop: 'accept'; loan_id: string; lender_pk: string; [k: string]: unknown }
  request: { stop: 'accept'; accept: true; loan_id: string }
  approved_at: number
  approval_payload: Omit<Approval, 'sig'>
  approval_payload_hash: string
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/device/approval.json', import.meta.url), 'utf8')) as Fixture
const borrower = keyPairFromLabel(fx.borrower_label)
const platformKey = keyPairFromLabel('device-approval-platform')

/** demo.ts: the stop-2 wait, then on "accept" the borrower agent's approveTermSheet. */
async function stop2(gate: DemoGate): Promise<Approval | null> {
  const { waiting: _confirm, ...info } = fx.waiting
  const ok = await gate.wait<boolean>('confirm', info)
  return ok === true ? approve(borrower, fx.termsheet, 'borrower', fx.approved_at) : null
}

describe('the phone approves the same term sheet the same way the dashboard does', () => {
  let app: App, base: string, session: DashboardSession, gate: DemoGate
  before(async () => {
    session = newDashboardSession()
    app = createApp({ platformKey, store: new Store(), chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], auth: authFromEnv(platformKey.pubkey, {}, [session]) })
    gate = new DemoGate(app, 'standard')
    app.api.on('GET', '/demo', () => ({ borrower_pk: borrower.pubkey, waiting: gate.waiting, lenders: {} }))
    // demo.ts announces its borrower when the gate opens; the phone's key is bound to it
    app.api.emit({ type: 'demo', waiting: null, borrower_pk: borrower.pubkey, scenario: 'standard' })
    app.api.on('POST', '/demo/confirm', async ({ body }) => {
      const b = await body()
      return { ok: gate.answer('confirm', b.accept === true, typeof b.stop === 'string' ? b.stop : '', typeof b.loan_id === 'string' ? b.loan_id : '') }
    })
    base = `http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`
  })
  after(() => app.close())

  it('the fixture is one valid, bound term sheet whose hash is the loan id the stop names', () => {
    assert.deepEqual(termSheetProblems(fx.termsheet, {}), [])
    assert.equal(termSheetHash(fx.termsheet), fx.waiting.loan_id)
    assert.equal(fx.request.loan_id, fx.waiting.loan_id)
    assert.equal(fx.termsheet.terms.borrower_pk, borrower.pubkey)
    assert.equal(hashObject(fx.approval_payload), fx.approval_payload_hash)
  })

  it('both clients send the same request for stop 2', () => {
    // web/app.js: const confirmStop = (stop, accept) => post('/demo/confirm', { stop, accept, loan_id: view.waiting?.loan_id })
    const web = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
    assert.match(web, /const confirmStop = \(stop, accept\) => post\('\/demo\/confirm', \{ stop, accept, loan_id: view\.waiting\?\.loan_id \}\)/, 'the dashboard still builds the fixture request; update the fixture and the phone together if it changes')
    const dashboardBody = { stop: 'accept', accept: true, loan_id: fx.waiting.loan_id }
    assert.deepEqual(dashboardBody, fx.request)
    assert.deepEqual(stopRequests.confirm('accept', true, fx.waiting.loan_id), fx.request)
    assert.equal(screenName(true, { demo: { waiting: fx.waiting } } as never, { tab: 'passbook', page: null, termsheet: false }), 'stop2')
  })

  it('dashboard and phone each produce the same approval payload, signed by the borrower and bound to the term-sheet hash', async () => {
    // the dashboard's phone answers with the operator session
    const fromWeb = stop2(gate)
    const res = await signedPost(session, '/demo/confirm', fx.request, at(base))
    assert.equal(res.status, 200)
    const web = await fromWeb
    assert.ok(web)

    // the Android phone answers with its device key
    const offer = await signedPost(session, '/devices/pairing', { node: base, scope: 'borrower', borrower_pk: borrower.pubkey }, at(base))
    const key = newDeviceKey()
    await pair(parsePairingLink(((await offer.json()) as { link: string }).link), key, 'Pixel 9', (u, i) => fetch(u, i))
    const fromPhone = stop2(gate)
    const out = await new NodeClient(base, key, (u, i) => fetch(u, i)).confirm('accept', true, fx.waiting.loan_id)
    assert.equal(out.ok, true)
    const phone = await fromPhone
    assert.ok(phone)

    for (const a of [web, phone]) {
      const { sig: _sig, ...payload } = a
      assert.deepEqual(payload, fx.approval_payload)
      assert.equal(hashObject(payload), fx.approval_payload_hash)
      assert.equal(a.termsheet_hash, fx.waiting.loan_id)
      assert.ok(verifyObject(a, borrower.pubkey), 'signed by the borrower key on the node, not the device key')
    }
    const policy = { owner_pk: fx.termsheet.terms.lender_pk, approval_rules: { approvers: [], maker_checker_above: 10_000_000_000 } } as unknown as LenderPolicy
    for (const a of [web, phone]) assert.equal(approvalStatus(fx.termsheet, [a], policy, 10_000_000_000).borrower, true)
  })

  it('the phone never answers another term sheet, or someone else’s stop', async () => {
    const waiting = stop2(gate)
    const key = newDeviceKey()
    const offer = await signedPost(session, '/devices/pairing', { node: base, scope: 'borrower', borrower_pk: borrower.pubkey }, at(base))
    await pair(parsePairingLink(((await offer.json()) as { link: string }).link), key, 'Pixel 9', (u, i) => fetch(u, i))
    const other = await new NodeClient(base, key, (u, i) => fetch(u, i)).confirm('accept', true, 'ab'.repeat(32))
    assert.equal(other.ok, false, 'a different hash does not answer this stop')
    assert.equal(borrowerStop({ waiting: 'confirm', stop: 'lender-approve', loan_id: fx.waiting.loan_id }), null, 'lender approvals never reach the phone screen')
    assert.ok(gate.answer('confirm', false, 'accept', fx.waiting.loan_id))
    assert.equal(await waiting, null)
  })
})
