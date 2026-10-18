import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { MemoryBus, MemoryHub } from '../src/checknode/bus.js'
import { marketRecord, nodeView, writeRecord } from '../src/checknode/market.js'
import { CheckNode } from '../src/checknode/node.js'
import { pickCheckNode } from '../src/checknode/select.js'
import { noTeeVerifier } from '../src/checknode/tee.js'
import type { Handler } from '../src/server/api.js'
import { mountCheckNodesPanel } from '../src/server/checknodes.js'
import { MemoryLightning, NOW, sandboxEngine, trustPolicy, USDT } from './checknode-helpers.js'

function nodeFor(label: string, price: number, execution?: CheckNode['currentOffer'] extends () => infer O ? O extends { execution: infer E } ? E : never : never) {
  const op = keyPairFromLabel(label)
  const { engine } = sandboxEngine()
  return { op, node: new CheckNode({ operator: op, engine, bus: new MemoryBus(new MemoryHub(), op), rails: { 'rgb-ln-hodl': new MemoryLightning().operatorRail('rgb-ln-hodl') }, assets: [{ asset_id: USDT, ticker: 'USDT', amount: price, kind: 'payment' }], execution, now: () => NOW }) }
}

describe('dashboard panel: Check nodes', () => {
  it('shows the derived tier, not the declared one, and the bond as designed', () => {
    const plain = nodeFor('panel-A', 800_000)
    const claimsNitro = nodeFor('panel-B', 500_000, { tee: 'aws-nitro', attestation: 'eA==', result_key: 'aa'.repeat(32) })
    const a = nodeView(plain.node, { name: 'A', demoKey: true })
    const b = nodeView(claimsNitro.node, { name: 'B', demoKey: true })
    assert.equal(a.execution.label, 'no TEE: software evidence')
    assert.equal(b.execution.declared, 'aws-nitro')
    assert.equal(b.execution.label, 'no TEE: software evidence', 'a declared TEE without a verified attestation is software evidence')
    assert.equal(a.bond, 'designed, not live')
    assert.match(a.operator_key, /demo key/)
    assert.match(a.scorer_label, /FALLBACK/)
    assert.ok(a.rails.every((r) => r.label.length > 0))
  })

  it('serves the last market run with the pick and why, and no outputs or personal data', async () => {
    const A = nodeFor('panel-A', 800_000), B = nodeFor('panel-B', 500_000)
    const pick = pickCheckNode([A.node.currentOffer(), B.node.currentOffer()], {}, { payer: 'borrower', payment_asset_id: USDT, rails: ['rgb-ln-hodl'] }, { trust: trustPolicy(), tee: noTeeVerifier(NOW) })
    const record = marketRecord([nodeView(A.node, { name: 'A', demoKey: true }), nodeView(B.node, { name: 'B', demoKey: true })], pick, null, null)
    assert.equal(record.pick.operator_pk, B.op.pubkey)
    assert.equal(record.platform_cut, 0)
    const dir = mkdtempSync(join(tmpdir(), 'passbook-checknodes-'))
    try {
      const path = join(dir, 'last-run.json')
      writeRecord(path, record)
      const routes = new Map<string, Handler>()
      mountCheckNodesPanel({ on: (method: string, p: string, h: Handler) => routes.set(`${method} ${p}`, h) } as never, { statusUrls: [], recordPath: path })
      const body = await routes.get('GET /demo/checknodes')!({} as never) as { record: typeof record; platform_cut: number }
      assert.equal(body.record.pick.operator_pk, B.op.pubkey)
      assert.ok(body.record.pick.why.some((w) => w.includes('Cheapest')))
      assert.equal(body.platform_cut, 0)
      assert.ok(routes.has('GET /demo/checknodes.js'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const page = readFileSync(new URL('../web/checknodes.js', import.meta.url), 'utf8')
    for (const text of ['Execution tier (derived)', 'Bond', 'Picked by policy', 'FALLBACK: pay, then deliver', 'Designed, not built']) assert.ok(page.includes(text), text)
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
    assert.ok(html.includes('id="checknodes"') && html.includes("import('/demo/checknodes.js')"))
  })
})
