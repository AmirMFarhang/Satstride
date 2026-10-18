// The two surfaces of the credit agent: CLI argument parsing, and the
// dashboard panel's routes (served next to the demo's other /demo routes).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_CREDIT } from '../src/core/config.js'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { FakeChain } from '../src/chain/fake.js'
import { Store } from '../src/registry/store.js'
import { createApp } from '../src/server/app.js'
import { mountLayersPanel } from '../src/server/layers.js'
import { parseLayers, parseWindow, runAgentCli } from '../src/cli/agent.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SNAPSHOT = new URL('./fixtures/networks/mainnet-snapshot.json', import.meta.url).pathname
const RECORDED = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'

describe('agent CLI arguments', () => {
  it('reads --layers aliases and --window days', () => {
    assert.deepEqual(parseLayers('rgb,btc,ln'), ['rgb', 'btc-onchain', 'lightning'])
    assert.deepEqual(parseLayers(undefined), ['rgb', 'btc-onchain', 'lightning'])
    assert.throws(() => parseLayers('rgb,eth'), /unknown layer eth/)
    assert.equal(parseWindow('365d', 30), 365)
    assert.equal(parseWindow(undefined, 30), 30)
    assert.throws(() => parseWindow('0d', 30), /--window/)
  })
})

describe('agent CLI configuration', () => {
  it('an invalid PASSBOOK_CONFIG stops the check instead of falling back to the public sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-agent-cfg-'))
    const file = join(dir, 'bad.yaml')
    writeFileSync(file, 'credit:\n  history_chains: [ethereum]\n')
    const saved = process.env.PASSBOOK_CONFIG
    const errors: string[] = []
    const realError = console.error
    process.env.PASSBOOK_CONFIG = file
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
    try {
      assert.equal(await runAgentCli(['agent', 'check', '--layers', 'btc', '--address', 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l', '--for', 'cd'.repeat(32)]), 2)
      assert.match(errors.join('\n'), /invalid Passbook config/)
    } finally {
      console.error = realError
      if (saved === undefined) delete process.env.PASSBOOK_CONFIG; else process.env.PASSBOOK_CONFIG = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('dashboard panel routes', () => {
  it('serves its script and status, issues a challenge, waits for the signature and refuses a pasted key', async () => {
    const chain = new FakeChain(100)
    const app = createApp({ platformKey: keyPairFromLabel('panel-platform'), store: new Store(':memory:'), chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [] })
    const borrower = keyPairFromLabel('panel-borrower')
    mountLayersPanel(app.api, {
      party: { key: borrower, rgb: { dataDir: '/nonexistent/rgb', transfers: () => [] } },
      assetId: 'rgb:usdt', chain, inflows: [], lenderPk: keyPairFromLabel('panel-lender').pubkey, store: app.store, priceCents: () => 10_000_000,
      credit: { ...DEFAULT_CREDIT, snapshot: SNAPSHOT },
    })
    const port = await app.api.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}`
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const js = await fetch(`${base}/demo/layers.js`)
      assert.equal(js.status, 200)
      assert.match(await js.text(), /on-chain recomputed by the lender/)
      const status = await (await fetch(`${base}/demo/layers`)).json() as { title: string; history_chain: string; sources: { device: string; lender: string } }
      assert.equal(status.title, 'RGB + Bitcoin mainnet + Lightning: on-chain recomputed by the lender')
      assert.deepEqual([status.history_chain, status.sources.device, status.sources.lender], ['bitcoin', 'https://mempool.space/api', 'https://blockstream.info/api'])
      const c = await (await post('/demo/layers/challenge', { address: RECORDED })).json() as { challenge: { text: string; subject: string } }
      assert.equal(c.challenge.subject, RECORDED)
      const waiting = await (await post('/demo/layers/check', { offline: true })).json() as { awaiting_signature: { text: string }[]; negotiation: { outcome: string } }
      assert.equal(waiting.awaiting_signature[0].text, c.challenge.text)
      assert.equal(waiting.negotiation.outcome, 'NO_DEAL')
      const refused = await post('/demo/layers/check', { signature: 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k', offline: true })
      assert.equal(refused.status, 400)
      const text = await refused.text()
      assert.match(text, /Never paste a private key/)
      assert.ok(!text.includes('L3VFeEuj'))
      assert.equal((await post('/demo/layers/challenge', { address: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' })).status, 400)
    } finally {
      await app.close()
    }
  })
})
