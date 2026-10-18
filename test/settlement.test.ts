import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { bytesToHex, hexToBytes, keyPairFromLabel, randomHex, sha256Hex, type Hex } from '../src/core/crypto.js'
import { debtOf, termsHash, type LoanTerms } from '../src/core/terms.js'
import { escrowFor, partiesOf, releaseOutputs } from '../src/escrow/escrow.js'
import { rgbRepaymentReceipt } from '../src/registry/passbook-doc.js'
import type { RgbLightningClient } from '../src/rgb/lightning.js'
import { applySettlement, CosignRgbAdapter, lnRlnExecutor, LnRlnAdapter, OnchainSwapAdapter, repaymentProven, settlementAdapter, settlementKindsFor, settlementOf } from '../src/settlement/adapters.js'
import type { CloseRef, DraftTerms, RepaymentEvidence, SettlementAdapter } from '../src/settlement/types.js'

const borrower = keyPairFromLabel('settle-borrower')
const lender = keyPairFromLabel('settle-lender')
const platform = keyPairFromLabel('settle-platform')
const PREIMAGE = '42'.repeat(32)

function draft(over: Partial<DraftTerms> = {}): DraftTerms {
  return { borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:demo-usdt', principal: 600_000_000, fee: 6_000_000, collateral_sats: 1_212_000, oracle_quote: { price_cents: 10_000_000, height: 100, oracle_pk: platform.pubkey, sig: '00'.repeat(64) }, open_height: 100, maturity_height: 130, grace_blocks: 5, recovery_height: 155, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex(), ...over }
}

function atomicTerms(over: Partial<DraftTerms> = {}, preimage = PREIMAGE): LoanTerms {
  return applySettlement(draft(over), { kind: 'ln-rln', atomic: { invoice: 'lnbcrt1fakeinvoice', btc_amount_msat: 3_000_000, payment_hash: sha256Hex(hexToBytes(preimage)), expires_at: 1_800_000_000, payee_pubkey: '02' + 'ab'.repeat(32) } })
}

/** Locks the collateral for `t` and closes it through `leaf` with the given witness middle. */
function world(t: LoanTerms, leaf: 'A' | 'C' | 'D' | 'E', preimage = PREIMAGE) {
  const chain = new FakeChain(100)
  const e = escrowFor(partiesOf(t))
  const lock = chain.addTx([{ value: t.collateral_sats, script: e.script }, { value: 0, script: opReturnScript(termsHash(t)) }])
  chain.mine()
  const repayment = chain.addTx([{ value: 1000, script: '00' }])
  chain.mine()
  const middle = leaf === 'E' ? ['00'.repeat(64), preimage] : leaf === 'D' ? ['00'.repeat(64)] : ['00'.repeat(64), '00'.repeat(64)]
  const close = chain.addTx(releaseOutputs(t), [{ txid: lock, vout: 0, witness: [...middle, bytesToHex(e.leaves[leaf]!.script), bytesToHex(e.leaves[leaf]!.controlBlock)] }])
  chain.mine()
  const ref: CloseRef = { lock_txid: lock, lock_vout: 0, outcome_txid: close }
  return { chain, ref, repayment }
}

interface Fixture { adapter: SettlementAdapter; terms: LoanTerms; chain: FakeChain; ref: CloseRef; ev: RepaymentEvidence }

const SUITE: { name: string; make: () => Fixture; wrongAmount: (f: Fixture) => Fixture; wrongAsset: (f: Fixture) => Fixture }[] = [
  {
    name: 'cosign-rgb',
    make: () => {
      const terms = applySettlement(draft(), { kind: 'cosign-rgb' })
      const w = world(terms, 'A')
      return { adapter: new CosignRgbAdapter(), terms, ...w, ev: { kind: 'cosign-rgb', receipt: rgbRepaymentReceipt(lender, terms, w.repayment, debtOf(terms)) } }
    },
    wrongAmount: (f) => ({ ...f, ev: { kind: 'cosign-rgb', receipt: rgbRepaymentReceipt(lender, f.terms, (f.ev as { receipt: { repayment_txid: Hex } }).receipt.repayment_txid, debtOf(f.terms) - 1) } }),
    wrongAsset: (f) => ({ ...f, ev: { kind: 'cosign-rgb', receipt: rgbRepaymentReceipt(lender, { ...f.terms, asset_id: 'rgb:other' }, (f.ev as { receipt: { repayment_txid: Hex } }).receipt.repayment_txid, debtOf(f.terms)) } }),
  },
  {
    name: 'ln-rln',
    make: () => {
      const preimage = randomHex()
      const terms = atomicTerms({}, preimage)
      return { adapter: new LnRlnAdapter(), terms, ...world(terms, 'E', preimage), ev: { kind: 'ln-rln', preimage } }
    },
    // The invoice fixed amount and asset at origination; a different debt or asset is different terms.
    wrongAmount: (f) => ({ ...f, terms: { ...f.terms, principal: f.terms.principal - 1 } }),
    wrongAsset: (f) => ({ ...f, terms: { ...f.terms, asset_id: 'rgb:other' } }),
  },
]

describe('settlement adapters: shared contract suite', () => {
  for (const s of SUITE) {
    describe(s.name, () => {
      it('verifies the happy path', async () => {
        const f = s.make()
        const r = await f.adapter.verify(f.ev, f.terms, f.chain, f.ref)
        assert.equal(r.ok, true, r.ok ? '' : r.reason)
        assert.deepEqual(await repaymentProven(f.terms, f.ev, f.chain, f.ref), r)
      })
      it('rejects evidence for another loan', async () => {
        const f = s.make(), other = s.make()
        assert.equal((await f.adapter.verify(other.ev, f.terms, f.chain, f.ref)).ok, false)
        assert.equal((await f.adapter.verify(f.ev, other.terms, f.chain, f.ref)).ok, false)
      })
      it('rejects the wrong amount', async () => {
        const f = s.wrongAmount(s.make())
        assert.equal((await f.adapter.verify(f.ev, f.terms, f.chain, f.ref)).ok, false)
      })
      it('rejects the wrong asset', async () => {
        const f = s.wrongAsset(s.make())
        assert.equal((await f.adapter.verify(f.ev, f.terms, f.chain, f.ref)).ok, false)
      })
    })
  }
})

describe('settlement dispatch and adapters', () => {
  it('binds the kind in the terms and dispatches only to a kind they commit to', async () => {
    const v1 = applySettlement(draft(), { kind: 'cosign-rgb' })
    const v2 = atomicTerms()
    assert.equal(v1.v, 1)
    assert.deepEqual(settlementKindsFor(v1), ['cosign-rgb'])
    assert.deepEqual(settlementKindsFor(v2), ['ln-rln', 'cosign-rgb'], 'cosign-rgb stays the leaf C fallback')
    assert.deepEqual(settlementOf(v2), { kind: 'ln-rln', atomic: v2.atomic_repayment })
    assert.notEqual(termsHash(v1), termsHash({ ...v2, nonce: v1.nonce }), 'the kind changes the committed terms hash')
    const w = world(v1, 'A')
    const atomicOnV1 = await repaymentProven(v1, { kind: 'ln-rln', preimage: PREIMAGE }, w.chain, w.ref)
    assert.equal(atomicOnV1.ok, false)
    assert.match(atomicOnV1.ok ? '' : atomicOnV1.reason, /do not commit to ln-rln/)
    assert.equal((await repaymentProven(v1, undefined, w.chain, w.ref)).ok, false)
  })

  it('accepts the co-signed fallback on atomic terms only through leaf A or C, never the recovery leaf', async () => {
    const v2 = atomicTerms()
    const viaC = world(v2, 'C')
    assert.equal((await repaymentProven(v2, { kind: 'cosign-rgb', receipt: rgbRepaymentReceipt(platform, v2, viaC.repayment, debtOf(v2)) }, viaC.chain, viaC.ref)).ok, true)
    const viaD = world(v2, 'D')
    assert.equal((await repaymentProven(v2, { kind: 'cosign-rgb', receipt: rgbRepaymentReceipt(lender, v2, viaD.repayment, debtOf(v2)) }, viaD.chain, viaD.ref)).ok, false)
  })

  it('declares leaf E for ln-rln, nothing extra for cosign-rgb, and refuses the unbuilt on-chain swap', async () => {
    assert.deepEqual(settlementAdapter('cosign-rgb').escrowLeaves({ kind: 'cosign-rgb' }), [])
    assert.deepEqual(settlementAdapter('ln-rln').escrowLeaves({ kind: 'cosign-rgb' }), ['E'])
    const swap = new OnchainSwapAdapter()
    await assert.rejects(swap.originate(), /onchain-swap is not built/)
    assert.equal((await swap.verify()).ok, false)
    await assert.rejects(new CosignRgbAdapter().repay({ terms: applySettlement(draft(), { kind: 'cosign-rgb' }), lock: { txid: '00'.repeat(32), vout: 0 } }), /executor not wired/)
  })

  it('originates ln-rln from the lender node and pays before releasing, never into a spent escrow', async () => {
    const d = draft()
    const debt = d.principal + d.fee
    const now = 1_790_000_000
    const node: RgbLightningClient = {
      createInvoice: async () => 'lnbcrt1fakeinvoice',
      decodeInvoice: async () => ({ amt_msat: 3_000_000, payment_hash: sha256Hex(hexToBytes(PREIMAGE)), payee_pubkey: '02' + 'ab'.repeat(32), asset_id: d.asset_id, asset_amount: debt, timestamp: now, expiry_sec: 40 * 24 * 3600, network: 'Regtest' }),
      payInvoice: async () => ({ payment_id: sha256Hex(hexToBytes(PREIMAGE)), status: 'Pending' }),
      getPayment: async (hash) => ({ payment_hash: hash, inbound: false, status: 'Succeeded', asset_id: d.asset_id, asset_amount: debt, preimage: PREIMAGE }),
    }
    const params = await new LnRlnAdapter({ node, now: () => now }).originate(d)
    assert.equal(params.kind, 'ln-rln')
    const terms = applySettlement(d, params)
    const released: Hex[] = []
    const execute = lnRlnExecutor(node, async (_loan, preimage) => { released.push(preimage) }, { escrowUnspent: async () => true })
    const ev = await new LnRlnAdapter({ node, execute }).repay({ terms, lock: { txid: '00'.repeat(32), vout: 0 } })
    assert.deepEqual(ev, { kind: 'ln-rln', preimage: PREIMAGE })
    assert.deepEqual(released, [PREIMAGE])
    const spent = lnRlnExecutor(node, async () => { throw new Error('must not release') }, { escrowUnspent: async () => false })
    await assert.rejects(spent({ terms, lock: { txid: '00'.repeat(32), vout: 0 } }), /already spent; not paying/)
  })
})
