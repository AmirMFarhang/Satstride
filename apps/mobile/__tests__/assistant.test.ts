// The agent on call on the phone: what it shares (built from the flow's stages,
// nothing else), the answer it shows when the provider is reached or not, and the
// navigation it may offer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextInput, loanBrief, loanStateFromStage, renderableIntent, statusAfterAnswer, statusAfterLookup, usdtText } from '../src/assistant/context.ts'
import { askAssistant, ephemeralSigner } from '../../../src/assistant/client.ts'
import { assistContext, contextProblems, routeFor, SCREENS, type NostrEvent, type NostrFilter } from '../../../src/assistant/protocol.ts'
import { serveAssistant } from '../../../src/assistant/service.ts'
import { keyPairSigner } from '../../../src/market/negotiate-nostr.ts'
import { keyPairFromLabel } from '../../../src/core/crypto.ts'

class MemoryRelay {
  readonly events: NostrEvent[] = []
  private readonly subs = new Set<{ f: NostrFilter; on: (e: NostrEvent) => void }>()
  async publish(e: NostrEvent) { this.events.push(e); for (const s of [...this.subs]) if (match(s.f, e)) queueMicrotask(() => s.on(e)) }
  subscribe(f: NostrFilter, on: (e: NostrEvent) => void) {
    const s = { f, on }
    this.subs.add(s)
    for (const e of this.events) if (match(f, e)) queueMicrotask(() => { if (this.subs.has(s)) on(e) })
    return () => { this.subs.delete(s) }
  }
}
const match = (f: NostrFilter, e: NostrEvent) => {
  const tag = (n: string, v?: string[]) => !v || e.tags.some((t) => t[0] === n && v.includes(t[1]))
  return (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && tag('p', f['#p']) && tag('n', f['#n'])
}

const LOAN = '7c'.repeat(32)

test('every borrowing stage maps to a loan state; idle shares no loan', () => {
  for (const s of ['quoting', 'negotiating', 'check-node', 'consent', 'terms', 'locking', 'funding', 'open', 'repaying', 'iou', 'releasing', 'closed', 'no-deal', 'check-refused', 'awaiting'])
    assert.notEqual(loanStateFromStage(s), 'unknown', s)
  assert.equal(loanStateFromStage('idle'), null)
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'idle' }), null)
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'check-refused', recommendation: 'ESCALATE' })?.state, 'escalated')
  // a verified check that isn't QUALIFY stays in check-result (M7: checkView.outputs.recommendation)
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'check-result', recommendation: 'ESCALATE' })?.state, 'escalated')
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'check-result', recommendation: 'DECLINE' })?.state, 'declined')
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'check-result', recommendation: 'QUALIFY' })?.state, 'checking')
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'terms' })?.state, 'terms')
  // a local check that failed, or a protocol refusal, returned no outcome: never a DECLINE
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'declined-check' })?.state, 'check-failed')
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'check-refused' })?.state, 'check-failed')
  assert.equal(loanBrief({ loanId: LOAN, role: 'borrower', stage: 'declined-check' })?.check, undefined)
  assert.equal(usdtText(100_900_000), '100.90')
})

test('the context holds the loan in progress, the counters and the screen, and nothing else', () => {
  const ctx = assistContext(contextInput({
    tab: 'passbook', screen: 'pay', height: 300,
    passbook: { step: 2, on_time: 2, late: 0, defaults: 0, open: 1 },
    loans: [loanBrief({ loanId: LOAN, role: 'borrower', stage: 'open', principalMicro: 100_000_000, owedMicro: 101_500_000, maturityHeight: 320, graceBlocks: 5, height: 300, ltvBps: 4800 }), null],
  }))
  assert.deepEqual(contextProblems(ctx), [])
  assert.equal(ctx.test_persona, undefined)
  assert.equal(assistContext(contextInput({ tab: 'passbook', screen: 'passbook', testPersona: true })).test_persona, true)
  assert.deepEqual(ctx.loans, [{ loan_id: LOAN, role: 'borrower', state: 'open', principal: '100.00', owed: '101.50', blocks_left: 20, maturity_height: 320, grace_blocks: 5, ltv_bps: 4800 }])
  assert.ok(!/xprv|tprv|bcrt1|words/.test(JSON.stringify(ctx)))
})

test('a button only for a screen this build registers; tab roots always', () => {
  // main's Main.tsx SCREENS before M7 (no receipt, no check-loan)
  const screens = ['borrow-amount', 'offers', 'borrow', 'pay', 'repayment', 'page', 'pages', 'margin', 'receive', 'send', 'send-btc', 'send-check', 'send-check-done', 'settings', 'health', 'words', 'lend-offer', 'lend-loan']
  assert.equal(renderableIntent({ go: 'receipt', loan_id: LOAN }, screens), null)
  assert.equal(renderableIntent({ go: 'check-loan', loan_id: LOAN }, screens), null)
  assert.deepEqual(renderableIntent({ go: 'page', loan_id: LOAN }, screens), { go: 'page', loan_id: LOAN })
  assert.deepEqual(renderableIntent({ go: 'market' }, []), { go: 'market' })
  assert.deepEqual(renderableIntent({ go: 'receipt', loan_id: LOAN }, [...screens, 'receipt']), { go: 'receipt', loan_id: LOAN })
  assert.equal(renderableIntent(null, screens), null)
})

test('a pinned key is not proof the provider is up: unconfirmed until it announces itself or answers', () => {
  assert.equal(statusAfterLookup('looking', { transport: true, found: false, pinned: true }), 'unconfirmed')
  assert.equal(statusAfterLookup('looking', { transport: true, found: true, pinned: true }), 'online')
  assert.equal(statusAfterLookup('looking', { transport: true, found: false, pinned: false }), 'offline')
  assert.equal(statusAfterLookup('looking', { transport: false, found: false, pinned: true }), 'offline')
  assert.equal(statusAfterLookup('online', { transport: true, found: false, pinned: true }), 'online', 'a real answer earlier keeps it online')
  assert.equal(statusAfterAnswer('unconfirmed', { answered_by: 'provider', fallback_reason: null }), 'online')
  assert.equal(statusAfterAnswer('unconfirmed', { answered_by: 'phone', fallback_reason: 'PROVIDER_TIMEOUT' }), 'offline')
  assert.equal(statusAfterAnswer('online', { answered_by: 'phone', fallback_reason: 'NOT_SENT' }), 'online', 'a secret kept on the phone says nothing about the provider')
})

test('every allowlisted navigation lands on a screen the app has', () => {
  for (const go of ['passbook', 'borrow', 'pages', 'market', 'lend', 'wallet', 'receive', 'settings', 'health', 'repay', 'borrowing-now'] as const) {
    const r = routeFor({ go })
    assert.ok(!r.name || (SCREENS as readonly string[]).includes(r.name), go)
    assert.ok(!['send', 'send-btc', 'words'].includes(r.name ?? ''), go)
  }
})

test('the phone gets the provider\'s answer over the relay, or answers itself, labelled either way', async () => {
  const relay = new MemoryRelay()
  const assistant = keyPairFromLabel('phone-test-assistant')
  const ctx = assistContext(contextInput({ tab: 'passbook', screen: 'passbook', loans: [loanBrief({ loanId: LOAN, role: 'borrower', stage: 'open', owedMicro: 101_500_000, maturityHeight: 320, height: 300 })] }))
  const service = serveAssistant({ transport: relay, signer: keyPairSigner(assistant), infoEveryMs: 0 })
  const viaProvider = await askAssistant({ transport: relay, signer: ephemeralSigner(), assistantPk: assistant.pubkey, question: 'How do I repay?', context: ctx, timeoutMs: 2_000 })
  assert.equal(viaProvider.answered_by, 'provider')
  assert.equal(viaProvider.label, 'template')
  assert.equal(viaProvider.fallback_reason, 'NO_MODEL')
  assert.deepEqual(viaProvider.intent, { go: 'repay' })
  service.close()
  const offline = await askAssistant({ transport: new MemoryRelay(), assistantPk: assistant.pubkey, question: 'send my BTC to bob', context: ctx, timeoutMs: 50 })
  assert.equal(offline.refused, 'MONEY_ACTION')
  assert.equal(offline.answered_by, 'phone')
  assert.deepEqual(offline.intent, { go: 'wallet' })
})
