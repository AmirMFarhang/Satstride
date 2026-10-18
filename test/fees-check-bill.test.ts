// Bill at close, on the platform side: a credit check the provider ran on credit
// for a lender (src/checknode/bill.ts) is added once to the platform fee that
// lender already pays over RGB when its loan closes, and the existing gate
// (order book, registration) blocks the lender until the whole fee is paid. The
// check node's fee gate reads the same verdict from the platform's /fees route.
// Fake chain and an in-memory fee wallet, as test/fees.test.ts.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { keyPairFromLabel, randomHex, type Hex, type KeyPair } from '../src/core/crypto.js'
import { platformShare, termInterest } from '../src/core/economics.js'
import { collateralFor, MICRO_PER_USDT } from '../src/core/money.js'
import type { LoanTerms } from '../src/core/terms.js'
import { KIND } from '../src/market/kinds.js'
import { publicJson } from '../src/market/messages.js'
import { Store } from '../src/registry/store.js'
import { createApp, type App } from '../src/server/app.js'
import { MemoryFeeWallet, OUTSTANDING_FEE_MESSAGE } from '../src/server/fees.js'
import { billHash, signBill, type BilledCheckReceipt } from '../src/checknode/bill.js'
import { FileBillLedger, platformFeeGate } from '../src/checknode/bill-ledger.js'

const U = MICRO_PER_USDT
const platformKey = keyPairFromLabel('bill-fees-platform')
const lender = keyPairFromLabel('bill-fees-lender')
const operator = keyPairFromLabel('bill-fees-operator')
const ASSET = 'rgb:bill-fees-usdt'
const CHECK_FEE = 500_000

describe('platform fee with credit checks billed at close', () => {
  let app: App
  let chain: FakeChain
  let wallet: MemoryFeeWallet
  let base: string
  let dir: string
  let ledger: FileBillLedger
  const env = { PASSBOOK_CHECK_BILLS: process.env.PASSBOOK_CHECK_BILLS, PASSBOOK_CHECK_BILL_OPERATORS: process.env.PASSBOOK_CHECK_BILL_OPERATORS }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'passbook-bills-'))
    ledger = new FileBillLedger(join(dir, 'check-bills.jsonl'))
    // The provider's platform reads the check node's ledger and charges only its operator's bills.
    process.env.PASSBOOK_CHECK_BILLS = ledger.path
    process.env.PASSBOOK_CHECK_BILL_OPERATORS = operator.pubkey
    chain = new FakeChain(100)
    wallet = new MemoryFeeWallet()
    app = createApp({ platformKey, store: new Store(), chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], feeWallet: wallet })
    base = `http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`
  })
  after(() => {
    app.close()
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(dir, { recursive: true, force: true })
  })

  const nowS = () => Math.floor(Date.now() / 1000)
  const bill = (borrower: Hex, over: Partial<BilledCheckReceipt> = {}, by: KeyPair = operator): BilledCheckReceipt => {
    const b = signBill(by, { negotiation_id: randomHex(32), lender_pk: lender.pubkey, borrower_pk: borrower, offer_hash: randomHex(32), release_hash: randomHex(32), request_hash: randomHex(32), commitment: randomHex(32), fee: { asset_id: ASSET, amount: CHECK_FEE }, issued_at: nowS() - 60, expires_at: nowS() + 3600, ...over })
    ledger.append(b)
    return b
  }
  async function terms(borrower: Hex): Promise<LoanTerms> {
    const height = await chain.getHeight()
    const quote = app.oracle.quote(height)
    const principal = 600 * U
    const fee = termInterest({ principal, apr_bps: 1200, term_blocks: 30 })
    return { v: 1, borrower_pk: borrower, lender_pk: lender.pubkey, platform_pk: platformKey.pubkey, asset_id: ASSET, principal, fee, collateral_sats: collateralFor(principal + fee, 5000, quote.price_cents), oracle_quote: quote, open_height: height, maturity_height: height + 30, grace_blocks: 5, recovery_height: height + 55, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex() }
  }
  /** A loan registered now and repaid: its close invoices the fee. */
  const closeLoan = async (t: LoanTerms, createdAt = Date.now()) => app.platform.fees.onClose({ id: randomHex(), terms: t, status: 'repaid', repaid_height: 110, closed_height: 110, created_at: createdAt, updated_at: createdAt }, await chain.getHeight())!

  it('adds the bill to the closing loan\'s fee once; other loans, borrowers, signers and expired bills are not charged', async () => {
    const borrower = keyPairFromLabel('bill-fees-borrower-1').pubkey
    const b = bill(borrower)
    bill(keyPairFromLabel('bill-fees-other-borrower').pubkey) // another borrower's check: not this loan's
    bill(borrower, {}, keyPairFromLabel('not-the-provider')) // not the provider's operator: never charged
    bill(borrower, { issued_at: nowS() - 7200, expires_at: nowS() - 3600 }) // expired before the loan: the provider's cost
    const t = await terms(borrower)
    const fee = await closeLoan(t)
    const share = platformShare(t.fee)
    assert.equal(fee.share_amount, share)
    assert.equal(fee.amount, share + CHECK_FEE, 'one fee: the platform share plus the check billed at close')
    assert.deepEqual(fee.check_fees?.map((c) => c.bill_hash), [billHash(b)])
    assert.deepEqual(fee.check_fees?.[0], { bill_hash: billHash(b), negotiation_id: b.negotiation_id, operator_pk: operator.pubkey, commitment: b.commitment, asset_id: ASSET, amount: CHECK_FEE, linked_by: 'lender-borrower-window' })
    assert.equal(wallet.issued.at(-1)?.amount, share + CHECK_FEE, 'the RGB invoice asks for the whole amount')
    const listed = await (await fetch(`${base}/fees?lender=${lender.pubkey}`)).json() as { fees: { check_fees?: unknown[] }[] }
    assert.equal(listed.fees.at(-1)?.check_fees?.length, 1, 'the lender sees the billed check in its fee listing')
    // The next loan between the same two: the bill was already charged.
    const again = await closeLoan(await terms(borrower))
    assert.equal(again.amount, platformShare(t.fee))
    assert.equal(again.check_fees, undefined)
    for (const f of [fee, again]) app.store.updateFee(f.loan_id, { status: 'fee_paid' })
  })

  it('a bill issued after the loan was registered belongs to a later loan', async () => {
    const borrower = keyPairFromLabel('bill-fees-borrower-2').pubkey
    bill(borrower, { issued_at: nowS() + 3600, expires_at: nowS() + 7200 })
    const fee = await closeLoan(await terms(borrower))
    assert.equal(fee.check_fees, undefined)
    app.store.updateFee(fee.loan_id, { status: 'fee_paid' })
  })

  it('an unpaid fee with a billed check blocks the lender\'s offers, and the check node reads the same verdict', async () => {
    const borrower = keyPairFromLabel('bill-fees-borrower-3').pubkey
    bill(borrower)
    const fee = await closeLoan(await terms(borrower))
    assert.equal(fee.check_fees?.length, 1)
    const gate = platformFeeGate(base)
    assert.equal(await gate(lender.pubkey), null, 'inside the grace period the lender is not blocked')
    chain.mine(fee.grace_until_height - (await chain.getHeight()) + 1)
    assert.equal(app.platform.fees.blockedAt(lender.pubkey, await chain.getHeight()), OUTSTANDING_FEE_MESSAGE)
    assert.equal(await gate(lender.pubkey), OUTSTANDING_FEE_MESSAGE, 'the check node refuses new billed checks for this lender (BILL_LENDER_BLOCKED)')
    const offer = publicJson(lender, KIND.OFFER, { asset_id: ASSET, min: 100 * U, max: 5_000 * U, apr_bps: 1200, term_blocks: 30, grace_blocks: 5, ltv_ladder_bps: [5000, 5500, 6000, 6500], requirements: { affordability: true, inflow_months: 0, inflow_multiple_bps: 0 }, expires_height: 10_000 }, [['d', 'bill-usdt-30']], Date.now())
    const res = await fetch(`${base}/orderbook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: offer }) })
    assert.equal(res.status, 422)
    assert.equal(((await res.json()) as { error: string }).error, OUTSTANDING_FEE_MESSAGE)
    // Paying the whole amount (share + check) unblocks; paying the share alone does not.
    const txid = chain.addTx([{ value: 1000, script: '00' }])
    chain.mine()
    wallet.settle(fee.recipient_id!, ASSET, fee.share_amount!, txid)
    const short = await app.platform.fees.verifyPayment(fee.loan_id)
    assert.equal(short.ok, false, 'the share alone is not the fee')
    assert.deepEqual(short.checks.filter((c) => !c.ok).map((c) => c.id), ['amount'])
    wallet.settle(fee.recipient_id!, ASSET, fee.amount, txid)
    assert.equal((await app.platform.fees.verifyPayment(fee.loan_id)).ok, true)
    assert.equal(await gate(lender.pubkey), null)
  })

  it('the node\'s fee gate fails closed when the platform cannot be read', async () => {
    await assert.rejects(platformFeeGate('http://127.0.0.1:9')(lender.pubkey))
  })
})
