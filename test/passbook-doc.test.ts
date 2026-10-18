import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { bytesToHex, hexToBytes, sha256Hex, keyPairFromLabel, randomHex, signObject } from '../src/core/crypto.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { escrowFor, partiesOf, releaseOutputs } from '../src/escrow/escrow.js'
import { rgbRepaymentReceipt, signPassbook, verifyPassbook, type PortablePage } from '../src/registry/passbook-doc.js'

const borrower = keyPairFromLabel('portable-borrower')
const lender = keyPairFromLabel('portable-lender')
const platform = keyPairFromLabel('portable-platform')
function terms(): LoanTerms {
  return { v: 1, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:demo', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000, oracle_quote: { price_cents: 10_000_000, height: 100, oracle_pk: platform.pubkey, sig: '00'.repeat(64) }, open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex() }
}
function world(leaf: 'A' | 'C' | 'D' = 'A', wrongScript = false) {
  const chain = new FakeChain(100)
  const t = terms()
  const e = escrowFor(partiesOf(t))
  const lock = chain.addTx([{ value: t.collateral_sats, script: wrongScript ? '5120' + 'aa'.repeat(32) : e.script }, { value: 0, script: opReturnScript(termsHash(t)) }])
  chain.mine()
  const repayment = chain.addTx([{ value: 1000, script: '00' }])
  chain.mine()
  const close = chain.addTx(releaseOutputs(t), [{ txid: lock, vout: 0, witness: ['00'.repeat(64), ...(leaf === 'D' ? [] : ['00'.repeat(64)]), bytesToHex(e.leaves[leaf].script), bytesToHex(e.leaves[leaf].controlBlock)] }])
  chain.mine()
  const page: PortablePage = { terms: t, lock_txid: lock, lock_vout: 0, outcome_txid: close, outcome: 'repaid', repayment: { kind: 'rgb_receipt', receipt: rgbRepaymentReceipt(lender, t, repayment, 606_000_000) } }
  return { chain, t, page }
}
describe('borrower-carried passbook', () => {
  it('verifies locally, labels signed RGB assurance, and computes step 1 without a platform', async () => {
    const { chain, page } = world()
    const pb = await verifyPassbook(signPassbook(borrower, [page]), chain)
    assert.equal(pb.unverified, 0)
    assert.equal(pb.ladder.allowed_ltv_bps, 5500)
    assert.equal(pb.assurance[0], 'signed_rgb_receipt')
  })
  it('rejects an arbitrary equal-value lock even with the right OP_RETURN and receipt', async () => {
    const { chain, page } = world('A', true)
    const pb = await verifyPassbook(signPassbook(borrower, [page]), chain)
    assert.equal(pb.ladder.step, 0)
    assert.equal(pb.unverified, 1)
    assert.equal(pb.pages[0].verified.collateral_script, false)
  })
  it('does not count a borrower assertion, fabricated consignment reference, or recovery leaf as repayment', async () => {
    const { chain, page, t } = world()
    page.repayment = { kind: 'rgb_receipt', receipt: rgbRepaymentReceipt(borrower, t, randomHex(), 606_000_000) }
    assert.equal((await verifyPassbook(signPassbook(borrower, [page]), chain)).ladder.step, 0)
    delete page.repayment
    assert.equal((await verifyPassbook(signPassbook(borrower, [page]), chain)).unverified, 1)
    const recovery = world('D')
    assert.equal((await verifyPassbook(signPassbook(borrower, [recovery.page]), recovery.chain)).ladder.step, 0)
  })
  it('accepts a platform receipt only as signed RGB assurance and rejects a forged one', async () => {
    const { chain, page, t } = world('C')
    const txid = page.repayment!.kind === 'rgb_receipt' ? page.repayment!.receipt.repayment_txid : ''
    page.repayment = { kind: 'rgb_receipt', receipt: rgbRepaymentReceipt(platform, t, txid, 606_000_000) }
    assert.equal((await verifyPassbook(signPassbook(borrower, [page]), chain)).ladder.step, 1)
    page.repayment.receipt.amount++
    assert.equal((await verifyPassbook(signPassbook(borrower, [page]), chain)).unverified, 1)
  })
  it('requires the actual committed leaf-E witness, not an arbitrary close plus a supplied secret', async () => {
    const chain = new FakeChain(100)
    const preimage = '42'.repeat(32)
    const t: LoanTerms = { ...terms(), v: 2, atomic_repayment: { invoice: 'lnbcrt-script-fixture', payment_hash: sha256Hex(hexToBytes(preimage)), btc_amount_msat: 3_000_000, expires_at: 2_000_000_000, payee_pubkey: '02' + lender.pubkey } }
    const e = escrowFor(partiesOf(t))
    const lock = chain.addTx([{ value: t.collateral_sats, script: e.script }, { value: 0, script: opReturnScript(termsHash(t)) }])
    chain.mine()
    const close = (leaf: 'A' | 'E', secret: string) => chain.addTx(releaseOutputs(t), [{ txid: lock, vout: 0, witness: ['00'.repeat(64), secret, bytesToHex(e.leaves[leaf]!.script), bytesToHex(e.leaves[leaf]!.controlBlock)] }])
    const page: PortablePage = { terms: t, lock_txid: lock, lock_vout: 0, outcome: 'repaid', outcome_txid: close('A', preimage), repayment: { kind: 'atomic', preimage } }
    chain.mine()
    assert.equal((await verifyPassbook(signPassbook(borrower, [page]), chain)).ladder.step, 0)
    page.outcome_txid = close('E', '43'.repeat(32))
    chain.mine()
    assert.equal((await verifyPassbook(signPassbook(borrower, [page]), chain)).ladder.step, 0)
    page.outcome_txid = close('E', preimage)
    chain.mine()
    const pb = await verifyPassbook(signPassbook(borrower, [page]), chain)
    assert.equal(pb.ladder.step, 1)
    assert.equal(pb.assurance[0], 'bitcoin_hashlock')
  })

  it('rejects altered document signatures, duplicate pages, and malformed signed documents', async () => {
    const { chain, page } = world()
    const doc = signPassbook(borrower, [page])
    doc.pages[0].terms.fee++
    assert.equal((await verifyPassbook(doc, chain)).document_valid, false)
    const duplicate = world()
    assert.equal((await verifyPassbook(signPassbook(borrower, [duplicate.page, duplicate.page]), duplicate.chain)).ladder.step, 0)
    const malformed = signObject({ v: 1, borrower_pk: borrower.pubkey, pages: [{}] }, borrower.secretKey)
    assert.equal((await verifyPassbook(malformed as never, chain)).document_valid, false)
  })
})
