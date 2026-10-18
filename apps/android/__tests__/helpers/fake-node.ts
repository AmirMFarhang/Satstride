// A borrower's Passbook node in memory, for the phone's UI tests. It checks
// every request's Schnorr signature the way src/server/auth.ts does.

import { schnorr } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { requestDigest } from '../../src/core/signing'
import type { Fetch, Paired } from '../../src/core/client'
import { newDeviceKey } from '../../src/core/signing'

// Same fixture as test/device-approval.test.ts (root): stop 2 for one term sheet.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const fixture = require('../../../../test/fixtures/device/approval.json') as {
  waiting: Record<string, unknown> & { loan_id: string; lender_pk: string }
  request: { stop: string; accept: boolean; loan_id: string }
  termsheet: { terms: { borrower_pk: string } }
}

export const BORROWER = fixture.termsheet.terms.borrower_pk
export const LENDER = fixture.waiting.lender_pk
const NOW = Date.now()

export interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }

export class FakeNode {
  calls: Call[] = []
  waiting: Record<string, unknown> = { waiting: null }
  refusal: string | null = null
  answers: unknown[] = []
  closedPage = true
  openLoan = false

  fetch: Fetch = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const headers = init.headers
    const body = init.body ? JSON.parse(init.body) : undefined
    this.calls.push({ method: init.method, path, body, headers })
    const ok = (json: unknown, status = 200) => ({ status, json: async () => json })
    const digest = requestDigest(init.method, path, Number(headers['x-passbook-ts']), headers['x-passbook-nonce'] ?? '', init.body ?? '')
    if (!headers['x-passbook-sig'] || !schnorr.verify(hexToBytes(headers['x-passbook-sig']), hexToBytes(digest), hexToBytes(headers['x-passbook-key']))) return ok({ error: 'bad request signature' }, 401)
    if (this.refusal) return ok({ error: this.refusal }, 401)
    if (path === '/devices/claim') return ok({ id: 'dev1', pubkey: (body as { device_pk: string }).device_pk, scope: 'borrower', borrower_pk: BORROWER, label: 'test', paired_at: NOW, expires_at: NOW + 3_600_000, state: 'active' })
    if (path === '/devices/me') return ok({ id: 'dev1', pubkey: headers['x-passbook-key'], scope: 'borrower', borrower_pk: BORROWER, label: 'test', paired_at: NOW, expires_at: NOW + 3_600_000, state: 'active' })
    if (path === '/demo') return ok({ borrower_pk: BORROWER, step: 7, waiting: this.waiting, lenders: { [LENDER]: 'Lender 1' } })
    if (path === '/state') return ok({ chain: 'bitcoind', height: 512, price_cents: 10_000_000, loans: [...(this.closedPage ? [{ id: 'c1'.repeat(32), status: 'repaid', borrower_pk: BORROWER, lender_pk: LENDER, principal: 600_000_000 }] : []), ...(this.openLoan ? [{ id: 'o1'.repeat(32), status: 'open', borrower_pk: BORROWER, lender_pk: LENDER, principal: 600_000_000 }] : [])] })
    if (path === `/passbook/${BORROWER}`) return ok({ borrower_pk: BORROWER, price_cents: 10_000_000, ladder_bps: [5000, 5500, 6000, 6500], ladder: { step: this.closedPage ? 1 : 0, allowed_ltv_bps: this.closedPage ? 5500 : 5000, on_time: 1 }, pages: [
      ...(this.closedPage ? [{ loan_id: 'c1'.repeat(32), open_height: 400, maturity_height: 430, principal: 600_000_000, fee: 5_920_000, collateral_sats: 1_211_840, ltv_bps: 5000, status: 'repaid', outcome: 'on_time', verified: { lock: true, close: true }, lock_txid: 'aa'.repeat(32), close_txid: 'bb'.repeat(32), returned_sats: 1_210_000, repayment_txid: 'cc'.repeat(32) }] : []),
      ...(this.openLoan ? [{ loan_id: 'o1'.repeat(32), open_height: 500, maturity_height: 530, principal: 600_000_000, fee: 5_920_000, collateral_sats: 1_211_840, ltv_bps: 5000, status: 'open', outcome: 'open', verified: { lock: true, close: false }, lock_txid: 'dd'.repeat(32), headroom: { state: 'healthy', margin_call_price_cents: 7_142_900, liquidation_price_cents: 6_250_000, drop_to_margin_call_bps: 2857, drop_to_liquidation_bps: 3750 } }] : []),
    ] })
    if (path === '/demo/wallet') return ok({ usdt_settled: 600_000_000, usdt_future: 650_000_000, btc_free_sats: 2_000_000, fee_btc_sats: 50_000, reserve_sats: 3_000, transfers: [{ kind: 'Send', status: 'Settled', amount: 605_920_000, txid: 'ee'.repeat(32) }, { kind: 'ReceiveBlind', status: 'Settled', amount: 600_000_000, txid: 'ff'.repeat(32) }] })
    if (path === '/orderbook') return ok({ offers: [{ id: 'offer1', lender_pk: LENDER, payload: { apr_bps: 1200, max: 1_000_000_000, term_blocks: 30, ltv_ladder_bps: [5000, 5500, 6000, 6500] } }] })
    if (path === '/demo/confirm' || path === '/demo/approve') {
      this.answers.push(body)
      this.waiting = { waiting: null }
      return ok({ ok: true })
    }
    return ok({ error: 'not found' }, 404)
  }
}

export const pairedTo = (node = 'http://127.0.0.1:4271'): Paired => ({ node, key: newDeviceKey(), device_id: 'dev1', scope: 'borrower', borrower_pk: BORROWER, expires_at: Date.now() + 3_600_000 })

export function memoryStore(initial: Paired | null) {
  let value = initial
  return {
    saved: [] as Paired[],
    forgotten: 0,
    async load() { return value },
    async save(p: Paired) { value = p; this.saved.push(p) },
    async forget() { value = null; this.forgotten += 1 },
  }
}
