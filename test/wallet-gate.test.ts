// The wallet panel's send gate wired to the node's policy gate (#38's interim
// adapter replaced): the panel's own checks first, then the policy gate with the
// confirmed preview as the decoded summary, its daily limits and its log.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { randomHex } from '../src/core/crypto.js'
import { readLog } from '../src/governance/log.js'
import { whyLines } from '../src/governance/why.js'
import { DEFAULT_LIMITS, GovernedSendGate, InterimSendGate, intentHash, sendGateFromEnv, type SendIntent } from '../src/wallet/send-gate.js'

const intent = (over: Partial<SendIntent> = {}): SendIntent => ({ action: 'wallet.send.btc', network: 'regtest', preview_id: randomHex(12), preview_hash: randomHex(32), amount: 50_000, unit: 'sats', to: 'bcrt1qexampleexampleexampleexampleexample0', fee_sats: 141, confirmed: true, ...over })

describe('wallet panel sends through the policy gate', () => {
  it('allows a confirmed send, logs it with an action id, and refuses an unconfirmed one before the gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-wallet-gate-'))
    try {
      const gate = new GovernedSendGate(dir, 'regtest')
      assert.equal(existsSync(join(dir, 'governance')), false, 'nothing is written before the first send')
      const refused = await gate.decide(intent({ confirmed: false }))
      assert.equal(refused.allow, false)
      assert.equal(existsSync(join(dir, 'governance')), false, 'an unconfirmed preview never reaches the policy gate')
      const i = intent()
      const ok = await gate.decide(i)
      assert.equal(ok.allow, true, ok.reason)
      assert.equal(ok.adapter, false)
      assert.equal(ok.intent_hash, intentHash(i))
      assert.match(ok.reason, /allowed by rule panel-btc \(passbook why act_/)
      const log = readLog(join(dir, 'governance', 'decision-log.jsonl'))
      assert.match(whyLines(log, ok.action_id!).join('\n'), /wallet-send by service wallet-panel -> ALLOW/)
      const rgb = await gate.decide(intent({ action: 'wallet.send.rgb', unit: 'micro', amount: 1_000_000, asset_id: 'rgb:test-asset' }))
      assert.match(rgb.reason, /allowed by rule panel-rgb/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('holds a daily limit across sends that each pass the per-send cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-wallet-gate-'))
    try {
      const gate = new GovernedSendGate(dir, 'mutinynet')
      const cap = DEFAULT_LIMITS.mutinynet.maxSats
      for (let n = 0; n < 10; n++) assert.equal((await gate.decide(intent({ network: 'mutinynet', amount: cap }))).allow, true)
      const over = await gate.decide(intent({ network: 'mutinynet', amount: cap }))
      assert.equal(over.allow, false)
      assert.ok(over.checks.some((c) => c.id === 'panel-btc:daily-limit' && !c.ok))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('is the default from the environment; interim and off stay available', () => {
    assert.ok(sendGateFromEnv({ PASSBOOK_WALLET_DIR: '/nonexistent/panel' }, { name: 'regtest' }) instanceof GovernedSendGate)
    assert.ok(sendGateFromEnv({ PASSBOOK_WALLET_GATE: 'interim' }, { name: 'regtest' }) instanceof InterimSendGate)
    assert.equal(sendGateFromEnv({ PASSBOOK_WALLET_GATE: 'off' }, { name: 'regtest' }), undefined)
  })
})
