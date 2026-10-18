import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { hashObject, keyPairFromLabel, randomHex, signObject } from '../src/core/crypto.js'
import { debtOf, termsHash, type LoanTerms } from '../src/core/terms.js'
import { escrowFor, partiesOf } from '../src/escrow/escrow.js'
import { assertAssignable, signOwnership, verifyOwnership, type IouAssignment, type IouCertificate } from '../src/market/iou.js'

const b = keyPairFromLabel('iou-borrower'), l = keyPairFromLabel('iou-lender'), buyer = keyPairFromLabel('iou-buyer')
const t: LoanTerms = { v: 1, borrower_pk: b.pubkey, lender_pk: l.pubkey, platform_pk: keyPairFromLabel('iou-platform').pubkey, asset_id: 'rgb:usdt', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000, oracle_quote: { price_cents: 10_000_000, height: 100, oracle_pk: l.pubkey, sig: '00'.repeat(64) }, open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex() }
function world() {
  const chain = new FakeChain()
  const lock = chain.addTx([{ value: t.collateral_sats, script: escrowFor(partiesOf(t)).script }, { value: 0, script: opReturnScript(termsHash(t)) }])
  const issuance = chain.addTx([{ value: 1000, script: '00' }])
  const payment = chain.addTx([{ value: 1000, script: '00' }])
  const transfer = chain.addTx([{ value: 1000, script: '00' }])
  chain.mine()
  const c: IouCertificate = signObject({ domain: 'passbook-iou-v1', loan_id: termsHash(t), asset_id: 'rgb:note', amount: debtOf(t), issuer_pk: b.pubkey, initial_holder_pk: l.pubkey, issuance_transfer_txid: issuance, lock_txid: lock, lock_vout: 0 }, b.secretKey)
  const a: IouAssignment = signObject({ domain: 'passbook-iou-assignment-v1', loan_id: c.loan_id, asset_id: c.asset_id, from_pk: l.pubkey, to_pk: buyer.pubkey, previous: hashObject(c), note_txid: transfer, payment_txid: payment, repayment_invoice: 'buyer-rgb-invoice-fixture' }, l.secretKey)
  return { chain, c, a }
}
describe('authenticated IOU assignments', () => {
  it('binds debt, actual collateral lock, original holder, new holder, payment and invoice', async () => {
    const { chain, c, a } = world()
    assert.equal(await verifyOwnership(signOwnership(l, c, []), t, chain), true)
    assert.equal(await verifyOwnership(signOwnership(buyer, c, [a]), t, chain), true)
    assert.equal(await verifyOwnership(signOwnership(b, c, [a]), t, chain), false)
    a.repayment_invoice = 'attacker-invoice'
    assert.equal(await verifyOwnership(signOwnership(buyer, c, [a]), t, chain), false)
  })
  it('rejects forged issuers, false supply, broken assignment chains and unsupported atomic sales', async () => {
    const { chain, c, a } = world()
    assert.equal(await verifyOwnership(signOwnership(l, { ...c, amount: c.amount + 1 }, []), t, chain), false)
    assert.equal(await verifyOwnership(signOwnership(l, signObject({ ...c, issuer_pk: buyer.pubkey }, buyer.secretKey), []), t, chain), false)
    const wrong = signObject({ ...a, previous: randomHex() }, l.secretKey)
    assert.equal(await verifyOwnership(signOwnership(buyer, c, [wrong]), t, chain), false)
    assert.throws(() => assertAssignable({ ...t, v: 2 }), /same-payment-hash/)
  })
})
