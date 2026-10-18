// The platform's fee: 15% of each loan's term interest, invoiced to the lender
// over RGB when the loan closes, the same on every outcome, enforced through
// the order book and registration (src/server/fees.ts). Fake chain and an
// in-memory fee wallet; the RGB wallet itself is exercised on regtest.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { keyPairFromLabel, randomHex, type Hex, type KeyPair } from '../src/core/crypto.js'
import { DEFAULT_ECONOMICS, platformShare, termInterest } from '../src/core/economics.js'
import { collateralFor, MICRO_PER_USDT, usdt } from '../src/core/money.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { escrowFor, partiesOf, releaseOutputs } from '../src/escrow/escrow.js'
import { KIND } from '../src/market/kinds.js'
import { publicJson } from '../src/market/messages.js'
import type { Position } from '../src/market/negotiate.js'
import { buildTermSheet, renderTermSheet } from '../src/market/termsheet.js'
import { Store } from '../src/registry/store.js'
import { createApp, type App } from '../src/server/app.js'
import { INVOICE_SECONDS, MemoryFeeWallet, OUTSTANDING_FEE_MESSAGE, type FeeRecord } from '../src/server/fees.js'
import { fundingNotice, Platform, PolicyError, repaymentAck } from '../src/server/platform.js'

const U = MICRO_PER_USDT
const platformKey = keyPairFromLabel('fees-platform')
const lender = keyPairFromLabel('fees-lender')
const ASSET = 'rgb:fees-usdt'

describe('platform fees', () => {
  let app: App
  let chain: FakeChain
  let wallet: MemoryFeeWallet
  let base: string
  let borrowers = 0

  before(async () => {
    chain = new FakeChain(100)
    wallet = new MemoryFeeWallet()
    app = createApp({ platformKey, store: new Store(), chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], feeWallet: wallet })
    base = `http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`
  })
  after(() => app.close())

  const get = async <T>(path: string): Promise<T> => (await fetch(base + path)).json() as Promise<T>
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  /** Fresh terms from a new borrower (step 0, first page) at the current quote. */
  async function newTerms(lenderKey: KeyPair = lender, principal = 600 * U): Promise<LoanTerms> {
    const height = await chain.getHeight()
    const quote = app.oracle.quote(height)
    const fee = termInterest({ principal, apr_bps: 1200, term_blocks: 30 })
    return {
      v: 1, borrower_pk: keyPairFromLabel(`fees-borrower-${++borrowers}`).pubkey, lender_pk: lenderKey.pubkey, platform_pk: platformKey.pubkey, asset_id: ASSET,
      principal, fee, collateral_sats: collateralFor(principal + fee, 5000, quote.price_cents), oracle_quote: quote,
      open_height: height, maturity_height: height + 30, grace_blocks: 5, recovery_height: height + 55, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex(),
    }
  }

  /** Register, lock and (unless `fund` is false) fund a loan; returns its id and lock. */
  async function open(t: LoanTerms, lenderKey: KeyPair = lender, fund = true): Promise<{ id: Hex; lockTxid: Hex }> {
    const { loan } = await app.platform.registerLoan(t)
    const lockTxid = chain.addTx([{ value: t.collateral_sats, script: escrowFor(partiesOf(t)).script }, { value: 0, script: opReturnScript(termsHash(t)) }], [{ txid: randomHex(), vout: 0 }])
    chain.mine()
    await app.platform.recordLock(loan.id, lockTxid)
    if (fund) {
      const disb = chain.addTx([{ value: 1000, script: '00' }])
      chain.mine()
      await app.platform.recordFunded(loan.id, disb, fundingNotice(lenderKey, loan.id, disb))
    }
    return { id: loan.id, lockTxid }
  }

  async function close(t: LoanTerms, how: 'repaid' | 'liquidated' | 'defaulted' | 'refunded', lenderKey: KeyPair = lender): Promise<Hex> {
    const { id, lockTxid } = await open(t, lenderKey, how !== 'refunded')
    if (how === 'repaid') {
      const repay = chain.addTx([{ value: 1000, script: '00' }])
      chain.mine()
      await app.platform.recordRepaid(id, repay, repaymentAck(lenderKey, id, repay))
      const release = chain.addTx(releaseOutputs(t), [{ txid: lockTxid, vout: 0 }])
      chain.mine()
      await app.platform.recordRelease(id, release)
    } else {
      const tx = chain.addTx([{ value: t.collateral_sats - 500, script: '00' }], [{ txid: lockTxid, vout: 0 }])
      chain.mine()
      await app.platform.recordSettlement(id, tx, how)
    }
    return id
  }

  /** The lender's payment as the platform's wallet would see it once settled on chain. */
  function pay(fee: FeeRecord, over: { amount?: number; asset?: string; confirm?: boolean } = {}): Hex {
    const txid = chain.addTx([{ value: 1000, script: '00' }])
    if (over.confirm !== false) chain.mine()
    wallet.settle(fee.recipient_id!, over.asset ?? fee.asset_id, over.amount ?? fee.amount, txid)
    return txid
  }

  it('invoices the same amount on a repaid, a liquidated and a split loan, and nothing on a refund', async () => {
    const t = await newTerms()
    const expected = platformShare(t.fee)
    const fees: FeeRecord[] = []
    for (const how of ['repaid', 'liquidated', 'defaulted'] as const) {
      const id = await close(how === 'repaid' ? t : await newTerms(), how)
      const fee = app.store.getFee(id)!
      assert.equal(fee.status, 'fee_due')
      assert.equal(fee.lender_pk, lender.pubkey)
      assert.ok(fee.invoice && fee.recipient_id, 'an RGB invoice from the platform wallet')
      fees.push(fee)
      // settle each so later tests start clean
      assert.equal((await post(`/fees/${id}/verify`, { txid: pay(fee) })).body.ok, true)
    }
    assert.deepEqual(fees.map((f) => f.outcome), ['repaid_on_time', 'liquidated', 'split'])
    assert.deepEqual(fees.map((f) => f.amount), [expected, expected, expected], 'the platform never earns more from a liquidation than from a repayment')
    assert.deepEqual(wallet.issued.slice(-3).map((i) => i.amount), [expected, expected, expected])
    assert.equal(expected, 890_000)
    const refunded = await close(await newTerms(), 'refunded')
    assert.equal(app.store.getFee(refunded), undefined, 'a loan the lender never funded owes no fee')
  })

  it('blocks offers and registration past the grace period, and unblocks them once paid', async () => {
    const offer = (d: string, at: number) => publicJson(lender, KIND.OFFER, { asset_id: ASSET, min: 100 * U, max: 5_000 * U, apr_bps: 1200, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: [5000, 5500, 6000, 6500], requirements: { affordability: true, inflow_months: 0, inflow_multiple_bps: 0 }, expires_height: 10_000 }, [['d', d]], at)
    const id = await close(await newTerms(), 'repaid')
    const fee = app.store.getFee(id)!
    assert.equal(fee.grace_until_height, fee.closed_height + 6)

    // inside the grace period nothing is blocked
    assert.equal((await post('/orderbook', { event: offer('usdt-30', Date.now()) })).status, 200)
    await open(await newTerms())
    assert.equal((await get<{ blocked: string | null }>(`/fees?lender=${lender.pubkey}`)).blocked, null)

    chain.mine(7)
    const owed = await get<{ blocked: string | null; fees: FeeRecord[] }>(`/fees?lender=${lender.pubkey}`)
    assert.equal(owed.blocked, OUTSTANDING_FEE_MESSAGE)
    const refused = await post('/orderbook', { event: offer('usdt-60', Date.now() + 1000) })
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error, 'Pay your outstanding platform fee to publish offers.')
    const book = await get<{ offers: { lender_pk: Hex }[] }>('/orderbook')
    assert.equal(book.offers.filter((o) => o.lender_pk === lender.pubkey).length, 0, 'listed offers are dropped while the fee is overdue')
    await assert.rejects(app.platform.registerLoan(await newTerms()), (err: unknown) => err instanceof PolicyError && err.message === OUTSTANDING_FEE_MESSAGE && err.verdict.checks.some((c) => c.id === 'fees' && !c.ok))
    // another lender is unaffected
    await open(await newTerms(keyPairFromLabel('fees-other-lender')), keyPairFromLabel('fees-other-lender'))

    const paid = await post(`/fees/${id}/verify`, { txid: pay(fee) })
    assert.equal(paid.body.ok, true, JSON.stringify(paid.body))
    assert.equal(app.store.getFee(id)!.status, 'fee_paid')
    assert.equal((await post('/orderbook', { event: offer('usdt-60', Date.now() + 2000) })).status, 200)
    assert.equal((await get<{ offers: { lender_pk: Hex }[] }>('/orderbook')).offers.filter((o) => o.lender_pk === lender.pubkey).length, 2)
    await open(await newTerms())
  })

  it('takes a refund only for a loan never funded, so a funded close cannot dodge the fee', async () => {
    const funded = await newTerms()
    const { id, lockTxid } = await open(funded)
    const tx = chain.addTx([{ value: funded.collateral_sats - 500, script: '00' }], [{ txid: lockTxid, vout: 0 }])
    chain.mine()
    await assert.rejects(app.platform.recordSettlement(id, tx, 'refunded'), /an open loan cannot be refunded/)
    await app.platform.recordSettlement(id, tx, 'liquidated')
    assert.equal(app.store.getFee(id)!.amount, platformShare(funded.fee))
    const unfunded = await newTerms()
    const never = await open(unfunded, lender, false)
    const refund = chain.addTx([{ value: unfunded.collateral_sats - 500, script: '00' }], [{ txid: never.lockTxid, vout: 0 }])
    chain.mine()
    await assert.rejects(app.platform.recordSettlement(never.id, refund, 'liquidated'), /a locked loan cannot be liquidated/)
    await app.platform.recordSettlement(never.id, refund, 'refunded')
    assert.equal(app.store.getFee(never.id), undefined)
    assert.equal((await post(`/fees/${id}/verify`, { txid: pay(app.store.getFee(id)!) })).body.ok, true)
  })

  it('runs the grace period from the invoice when a close is learned late', async () => {
    const t = await newTerms()
    const late = app.platform.fees.onClose({ id: randomHex(), terms: t, status: 'repaid', repaid_height: 110, closed_height: 110, created_at: 0, updated_at: 0 }, 150)!
    assert.deepEqual([late.closed_height, late.grace_until_height], [110, 156])
    assert.equal(app.platform.fees.blockedAt(lender.pubkey, 156), null, 'not overdue the moment it is issued')
    app.store.updateFee(late.loan_id, { status: 'fee_paid' })
  })

  it('charges the share published when the loan was registered, not the one current at close', async () => {
    const lenderB = keyPairFromLabel('fees-lender-snapshot')
    // the same registry after a restart that publishes a 20% share
    const restarted = new Platform(platformKey, app.store, chain, app.oracle, app.platform.sandbox, () => {}, undefined, undefined, { feeWallet: wallet, economics: { ...DEFAULT_ECONOMICS, platform_share_bps: 2000 } })
    const closeOn = async (p: Platform, t: LoanTerms, id: Hex, lockTxid: Hex) => {
      const repay = chain.addTx([{ value: 1000, script: '00' }])
      chain.mine()
      await p.recordRepaid(id, repay, repaymentAck(lenderB, id, repay))
      const release = chain.addTx(releaseOutputs(t), [{ txid: lockTxid, vout: 0 }])
      chain.mine()
      await p.recordRelease(id, release)
    }
    const t = await newTerms(lenderB)
    const loan = await open(t, lenderB)
    assert.equal(app.store.getLoan(loan.id)!.platform_share_bps, 1500, 'snapshotted at registration')
    await closeOn(restarted, t, loan.id, loan.lockTxid)
    const fee = app.store.getFee(loan.id)!
    assert.deepEqual([fee.share_bps, fee.share_basis, fee.amount], [1500, 'registered', platformShare(t.fee)])
    // a loan registered before snapshots existed is charged at the share current at close, and says so
    const legacyTerms = await newTerms(lenderB)
    const legacy = await open(legacyTerms, lenderB)
    app.store.updateLoan(legacy.id, { platform_share_bps: undefined })
    await closeOn(restarted, legacyTerms, legacy.id, legacy.lockTxid)
    const legacyFee = app.store.getFee(legacy.id)!
    assert.deepEqual([legacyFee.share_bps, legacyFee.share_basis, legacyFee.amount], [2000, 'current', platformShare(legacyTerms.fee, { platform_share_bps: 2000 })])
    for (const f of [fee, legacyFee]) app.store.updateFee(f.loan_id, { status: 'fee_paid' })
  })

  it('issues a payable invoice after a failed one, and keeps such a fee due without enforcing it until then', async () => {
    const lenderC = keyPairFromLabel('fees-lender-reissue')
    wallet.failing = 'indexer unreachable'
    const id = await close(await newTerms(lenderC), 'repaid', lenderC)
    const failed = app.store.getFee(id)!
    assert.deepEqual([failed.status, failed.invoice], ['fee_due', null])
    chain.mine(10)
    const listed = await get<{ fees: FeeRecord[]; blocked: string | null; height: number }>(`/fees?lender=${lenderC.pubkey}`)
    assert.equal(listed.fees.find((f) => f.loan_id === id)!.status, 'fee_due', 'still visible as due')
    assert.equal(listed.blocked, null, 'not enforced while there is no invoice to pay')
    assert.equal((await post(`/fees/${id}/invoice`, {})).status, 503)
    wallet.failing = null
    const issuedBefore = wallet.issued.length
    assert.equal((await get<{ fees: FeeRecord[] }>(`/fees?lender=${lenderC.pubkey}`)).fees.find((f) => f.loan_id === id)!.invoice, null, 'a polled listing retries a failure at most once a minute')
    assert.equal(wallet.issued.length, issuedBefore)
    assert.equal((await post(`/fees/${id}/invoice`, {})).status, 200, 'an explicit request retries now')
    const fresh = await get<{ fees: FeeRecord[]; blocked: string | null; height: number }>(`/fees?lender=${lenderC.pubkey}`)
    const issued = fresh.fees.find((f) => f.loan_id === id)!
    assert.ok(issued.invoice && issued.recipient_id, 'a payable invoice now')
    assert.equal(issued.grace_until_height, fresh.height + 6, 'the grace period runs from the first payable invoice')
    assert.equal(fresh.blocked, null)
    assert.equal((await post(`/fees/${id}/verify`, { txid: pay(issued) })).body.ok, true)
  })

  it('replaces an expiring invoice, and still accepts a payment into the old one', async () => {
    const lenderD = keyPairFromLabel('fees-lender-expiry')
    const id = await close(await newTerms(lenderD), 'liquidated', lenderD)
    const first = app.store.getFee(id)!
    assert.ok(first.invoice_expires_at && first.invoice_expires_at > Date.now() / 1000 + INVOICE_SECONDS - 60)
    assert.equal((await post(`/fees/${id}/invoice`, {})).body.recipient_id, first.recipient_id, 'a usable invoice is kept')
    const later = Date.now() + (INVOICE_SECONDS - 3600) * 1000
    assert.equal(app.platform.fees.invoiceUsable(first, later), false, 'less than a day left')
    const rotated = app.platform.fees.ensureInvoice(first, await chain.getHeight(), later)
    assert.notEqual(rotated.recipient_id, first.recipient_id)
    assert.deepEqual(rotated.previous_recipient_ids, [first.recipient_id])
    assert.equal(rotated.grace_until_height, first.grace_until_height, 'an expiry does not extend the grace period')
    const v = await post(`/fees/${id}/verify`, { txid: pay(first) })
    assert.equal(v.body.ok, true, JSON.stringify(v.body))
    assert.ok((v.body.checks as { id: string; detail: string }[]).some((c) => c.id === 'receiver' && c.detail.includes('earlier invoice')))
  })

  it('validates the receive itself: amount, asset, confirmation and the claimed payment', async () => {
    const id = await close(await newTerms(), 'liquidated')
    const fee = app.store.getFee(id)!
    const failed = async (txid: Hex, check: string) => {
      const v = await post(`/fees/${id}/verify`, { txid })
      assert.equal(v.body.ok, false)
      assert.ok((v.body.checks as { id: string; ok: boolean }[]).some((c) => c.id === check && !c.ok), check)
      assert.equal(app.store.getFee(id)!.status, 'fee_due')
    }
    await failed(pay(fee, { amount: fee.amount - 10_000 }), 'amount')
    await failed(pay(fee, { asset: 'rgb:some-other-asset' }), 'asset')
    await failed(pay(fee, { confirm: false }), 'witness')
    chain.mine()
    const real = pay(fee)
    await failed(randomHex(), 'claimed')
    assert.equal((await post(`/fees/${id}/verify`, { txid: real })).body.ok, true)
  })

  it('shows the same termInterest figure on the term sheet, the invoice and the dashboard', async () => {
    const borrower = keyPairFromLabel('fees-sheet-borrower')
    const agreed: Position = { principal: 600 * U, apr_bps: 1200, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' }
    const interest = termInterest(agreed)
    const sheet = buildTermSheet({
      agreed, negotiation: { id: randomHex(), accept_hash: randomHex() }, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platformKey.pubkey,
      asset_id: ASSET, oracle_quote: app.oracle.quote(await chain.getHeight()), grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
      scorer: { provider: 'container', scorer_id: 'passbook-sandbox:container:abc', code_measurement: 'sha256:' + 'ab'.repeat(32), contract_hash: 'cd'.repeat(32), trust: 'dev-inprocess', result_hash: 'ef'.repeat(32), fallback: false, recommendation: 'QUALIFY', evidence: { kind: 'passbook-run-record', run_record_sha256: '9a'.repeat(32) } },
      consent_hash: '12'.repeat(32), salt: randomHex(),
    })
    assert.equal(sheet.fees.interest, interest)
    assert.equal(sheet.terms.fee, interest)
    const forBorrower = renderTermSheet(sheet, { audience: 'borrower' }).lines.join('\n')
    assert.ok(forBorrower.includes(`You repay ${usdt(600 * U + interest)} by day 30. No other fees.`), forBorrower)
    assert.ok(forBorrower.includes("If BTC falls and the loan is liquidated early, the lender still receives the full term's interest; on this 30-day loan that is 5.92 USDT, about 0.99% of the amount borrowed."), forBorrower)
    const forLender = renderTermSheet(sheet, { audience: 'lender' }).lines.join('\n')
    assert.ok(forLender.includes('Interest: 5.92 USDT gross, 0.89 USDT platform fee after close (15.00% of the interest, paid by you), 5.03 USDT net (10.19% a year).'), forLender)
    assert.ok(!/penalty/i.test(JSON.stringify(renderTermSheet(sheet, { audience: 'borrower' })).replace('No penalty', '')), 'no penalty anywhere but its denial')

    const id = await close({ ...sheet.terms, borrower_pk: borrower.pubkey }, 'repaid')
    const invoice = app.store.getFee(id)!
    assert.equal(invoice.interest, interest)
    assert.equal(invoice.amount, platformShare(interest))
    assert.equal(wallet.issued.at(-1)!.amount, platformShare(interest))
    const dashboard = await get<{ fees: FeeRecord[]; economics: { platform_share_bps: number } }>(`/fees?lender=${lender.pubkey}`)
    const row = dashboard.fees.find((f) => f.loan_id === id)!
    assert.deepEqual([row.interest, row.amount], [interest, platformShare(interest)])
    assert.equal(dashboard.economics.platform_share_bps, 1500)
    const state = await get<{ economics: { max_apr_bps: number; max_ltv_bps_by_term: Record<string, number>; day_count: string } }>('/state')
    assert.deepEqual([state.economics.max_apr_bps, state.economics.max_ltv_bps_by_term, state.economics.day_count], [1900, { 30: 6500, 60: 6000, 90: 5500 }, 'ACT/365'])
  })
})
