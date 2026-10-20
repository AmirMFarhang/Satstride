import assert from 'node:assert/strict'
import { test } from 'node:test'

const modelUrl = new URL('../apps/console/js/live-model.js', import.meta.url).href
const pageUrl = new URL('../apps/console/js/page-live.js', import.meta.url).href
const { liveTasks, liveServices, liveWorkflows } = await import(modelUrl)
const { default: livePage } = await import(pageUrl)

test('console live: missing task data stays unknown, and terminal checks never look like running work', () => {
  assert.equal(liveTasks(null), null)
  assert.deepEqual(liveTasks({ checks: { items: [{ status: 'billed' }, { status: 'paid' }, { status: 'refused' }] } }), [])
  assert.deepEqual(liveTasks({}), [])
})

test('console live: tasks come from recorded obligations and fresh relay observations', () => {
  const now = 1_800_000_000_000
  const tasks = liveTasks({
    loans: { items: [{ id: 'open', status: 'open', maturity_height: 101, updated_at: now }, { id: 'closed', status: 'repaid' }] },
    agenda: [{ kind: 'maturity', title: 'same open loan' }, { kind: 'fee-due', title: 'Fee due', detail: 'Past grace', severity: 'alert' }],
    negotiations: [{ id: 'recent', state: 'negotiating', last_at: now - 1000 }, { id: 'old', state: 'negotiating', last_at: now - 121_000 }, { id: 'ended', state: 'agreed', last_at: now }],
  }, now)
  assert.equal(tasks.length, 3)
  assert.equal(tasks[0].state, 'waiting')
  assert.match(tasks[0].detail, /101/)
  assert.equal(tasks[1].state, 'attention')
  assert.equal(tasks[2].state, 'observed')
  assert.match(tasks[2].detail, /not visible/)
  assert.ok(tasks.every((task: { state: string }) => task.state !== 'running'))
})

test('console live: unavailable sources and relay announcements keep their actual meaning', () => {
  const services = liveServices({ check_nodes: [{ status: 'unreachable' }], scorer: { status: 'unreachable', qvac: { status: 'loading', models: [] } }, assistant: { status: 'running' }, relays: [{ connected: true }, { connected: false }] })
  assert.equal(services.find((service: { id: string }) => service.id === 'check').status, 'Unavailable')
  assert.equal(services.find((service: { id: string }) => service.id === 'model').status, 'Loading')
  assert.equal(services.find((service: { id: string }) => service.id === 'assistant').status, 'Announced')
  assert.equal(services.find((service: { id: string }) => service.id === 'relays').status, '1 / 2 connected')
})

test('console live: labels are escaped and unavailable task data never claims an empty queue', () => {
  const html = livePage.render({ now: Date.now(), data: { overview: { generated_at: Date.now(), network: { label: '<img src=x onerror=alert(1)>' } }, market: null, activity: [], feedAvailable: false } })
  assert.match(html, /Task status unavailable/)
  assert.doesNotMatch(html, /No open tasks reported/)
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;img src=x/)
})

test('console live: workflow uses the latest signed agent stage, with explicit stale and unknown progress', () => {
  const now = 1_800_000_000_000
  const note = (actor: string, label: string, at: number, extra = {}) => ({ id: `${actor}-${at}`, source: 'platform', kind: 'agent', from: actor, detail: 'borrower', label, at, ...extra })
  const rows = liveWorkflows([
    note('borrower', 'Negotiation agreed over Nostr', now - 10_000),
    note('borrower', 'Approved on the phone: share my sealed history for one credit check', now - 1000),
    note('lender', 'Approved on the phone: this term sheet, and lending once the collateral is locked', now - 301_000),
    note('untrusted', 'Collateral locked with the terms hash in OP_RETURN', now, { source: 'nostr' }),
  ], now)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].stage, 'consent')
  assert.match(rows[0].detail, /private check phase is unknown/)
  assert.equal(rows[0].stale, false)
  assert.equal(rows[1].stage, 'terms')
  assert.equal(rows[1].stale, true)
  assert.match(rows[1].detail, /progress.*unknown/)
  assert.deepEqual(liveWorkflows([note('actor', 'A model is loaded', now)]), [])
})

test('console live: a later signed refusal replaces a prior successful stage report', () => {
  const now = Date.now()
  const notes = ['Negotiation agreed over Nostr', 'Credit check refused before it ran'].map((label, index) => ({ source: 'platform', kind: 'agent', from: 'lender', detail: 'lender', label, at: now - 1000 + index }))
  const [flow] = liveWorkflows(notes, now)
  assert.equal(flow.stage, 'check')
  assert.equal(flow.title, 'Credit check refused')
  assert.equal(flow.stopped, true)
})
