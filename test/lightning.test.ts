// Scripted client unit tests exercise rejection boundaries only. They are not
// evidence of a Lightning payment; test/regtest/atomic.test.ts opts into RLN.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hexToBytes, keyPairFromLabel, sha256Hex } from '../src/core/crypto.js'
import { termsHash, validateTerms, type LoanTerms } from '../src/core/terms.js'
import { payAtomicInvoice, verifyAtomicInvoice, type DecodedLightningInvoice, type LightningPayment, type RgbLightningClient } from '../src/rgb/lightning.js'
import { Oracle } from '../src/oracle/oracle.js'

const k = keyPairFromLabel('atomic-test')
const preimage = '44'.repeat(32)
const hash = sha256Hex(hexToBytes(preimage))
const now = Math.floor(Date.now() / 1000)
const t: LoanTerms = { v: 2, borrower_pk: k.pubkey, lender_pk: k.pubkey, platform_pk: k.pubkey, principal: 600_000_000, fee: 6_000_000, collateral_sats: 2_000_000, asset_id: 'rgb:test', oracle_quote: new Oracle(k, 10_000_000).quote(100), open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 3030, prev_passbook_txid: null, nonce: '00'.repeat(32), atomic_repayment: { invoice: 'lnbcrt-unit-test-only', btc_amount_msat: 3_000_000, payment_hash: hash, expires_at: now + 1000, payee_pubkey: `02${k.pubkey}` } }
const decoded: DecodedLightningInvoice = { amt_msat: 3_000_000, payment_hash: hash, payee_pubkey: t.atomic_repayment!.payee_pubkey, asset_id: t.asset_id, asset_amount: 606_000_000, timestamp: now, expiry_sec: 1000, network: 'Regtest' }
function client(invoiceChanges: Partial<DecodedLightningInvoice> = {}, paymentChanges: Partial<LightningPayment> = {}): RgbLightningClient {
  return { createInvoice: async () => t.atomic_repayment!.invoice, decodeInvoice: async () => ({ ...decoded, ...invoiceChanges }), payInvoice: async () => ({ payment_id: hash, status: 'Pending' }), getPayment: async () => ({ payment_hash: hash, inbound: false, status: 'Succeeded', asset_id: t.asset_id, asset_amount: 606_000_000, preimage, ...paymentChanges }) }
}

describe('atomic repayment boundaries (scripted client)', () => {
  it('commits every atomic field and rejects malformed version combinations', () => {
    validateTerms(t)
    assert.throws(() => validateTerms({ ...t, v: 1 }), /v1/)
    assert.throws(() => validateTerms({ ...t, atomic_repayment: undefined }), /invoice/)
    assert.throws(() => validateTerms({ ...t, atomic_repayment: { ...t.atomic_repayment, payment_hash: 'gg' } }), /payment_hash/)
    for (const [field, value] of Object.entries({ invoice: 'lnbcrt-other', payment_hash: '11'.repeat(32), expires_at: now + 2000, payee_pubkey: `03${k.pubkey}`, btc_amount_msat: 6_000_000 })) assert.notEqual(termsHash({ ...t, atomic_repayment: { ...t.atomic_repayment!, [field]: value } }), termsHash(t))
  })
  it('refuses wrong asset, amount, BTC amount, hash, payee, network and expiry before paying', async () => {
    for (const changes of [{ asset_id: 'rgb:other' }, { asset_amount: 1 }, { amt_msat: 4_000_000 }, { payment_hash: '55'.repeat(32) }, { payee_pubkey: `03${k.pubkey}` }, { network: 'Bitcoin' }, { expiry_sec: 1 }]) {
      let paid = false
      const c = client(changes)
      c.payInvoice = async () => { paid = true; throw new Error('must not pay') }
      await assert.rejects(payAtomicInvoice(c, t), /mismatch|regtest|required interval/)
      assert.equal(paid, false)
    }
    await assert.rejects(verifyAtomicInvoice(client(), t, now, 1001), /expiry/)
  })
  it('requires actual succeeded outbound payment metadata and a matching preimage', async () => {
    for (const changes of [{ status: 'Failed' as const }, { inbound: true }, { asset_amount: 1 }, { preimage: '55'.repeat(32) }, { preimage: undefined }]) await assert.rejects(payAtomicInvoice(client({}, changes), t), /failed|match|preimage/)
    assert.equal(await payAtomicInvoice(client(), t), preimage)
    await assert.rejects(payAtomicInvoice(client({}, { status: 'Pending' }), t, { timeoutMs: 1, pollMs: 2 }), /timed out/)
  })
})
