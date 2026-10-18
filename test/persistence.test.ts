import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { assertRegistryMatches, serveInspection, unfinishedLoans } from '../src/cli/recovery.js'
import { FakeChain } from '../src/chain/fake.js'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { Oracle } from '../src/oracle/oracle.js'
import { Store } from '../src/registry/store.js'
import { createApp } from '../src/server/app.js'

const platformKey = keyPairFromLabel('platform')
const borrower = keyPairFromLabel('borrower')
const lender = keyPairFromLabel('lender')
const terms: LoanTerms = {
  v: 1, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platformKey.pubkey,
  asset_id: 'rgb:persisted-test', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000,
  oracle_quote: new Oracle(platformKey, 10_000_000).quote(100),
  open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 140,
  ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: 'ab'.repeat(32),
}

describe('saved dashboard recovery', () => {
  it('reopens real SQLite loans and wire while refusing to replay unfinished agent actions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-persistence-'))
    const path = join(dir, 'nested', 'passbook.sqlite')
    let store = new Store(path)
    const id = termsHash(terms)
    store.insertLoan({ id, terms, status: 'pending', created_at: 1, updated_at: 1 })
    store.appendEvent({ type: 'step', n: 6, title: 'Underwrite', at: 1 })
    store.close()
    store = new Store(path)
    const app = createApp({ platformKey, store, chain: new FakeChain(100), initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [] })
    try {
      assert.equal(store.listEvents()[0].title, 'Underwrite')
      assert.equal(unfinishedLoans(store)[0].id, id)
      assertRegistryMatches(store, terms.asset_id, platformKey.pubkey)
      assert.throws(() => assertRegistryMatches(store, 'another-seed', platformKey.pubkey), /another seed/)
      serveInspection(app, { borrower_pk: borrower.pubkey, asset_id: terms.asset_id, lenders: {}, scenario: 'standard' })
      const port = await app.api.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}`
      const demo = await fetch(base + '/demo').then((r) => r.json())
      assert.equal(demo.mode, 'inspection')
      assert.equal(demo.unfinished_loans[0].status, 'pending')
      for (const action of ['next', 'approve', 'confirm']) {
        const response = await fetch(base + `/demo/${action}`, { method: 'POST' }).then((r) => r.json())
        assert.equal(response.ok, false)
        assert.match(response.error, /cannot resume automatically/)
      }
      assert.equal(store.allLoans().length, 1)
      for (const status of ['locked', 'open', 'repaid'] as const) {
        store.updateLoan(id, { status })
        assert.equal(unfinishedLoans(store).length, 1)
      }
      store.updateLoan(id, { release_txid: 'cd'.repeat(32) })
      assert.equal(unfinishedLoans(store).length, 0)
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
