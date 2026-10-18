import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { keyPairFromLabel, randomHex, type Hex } from '../src/core/crypto.js'
import { collateralFor } from '../src/core/money.js'
import { termsHash, type LoanTerms } from '../src/core/terms.js'
import { buildEscrowSpend, escrowFor, finalizeEscrowSpend, keyPathOutput, leafSignature, liquidationOutputs, partiesOf, psbtFromBase64, releaseOutputs, signLeaf, unsignedTxid, verifyLeafSignature } from '../src/escrow/escrow.js'
import { Oracle } from '../src/oracle/oracle.js'
import { Store, type WireEvent } from '../src/registry/store.js'
import { InProcessSandbox } from '../src/sandbox/broker.js'
import { fundingNotice, Platform, PolicyError, repaymentAck } from '../src/server/platform.js'
import { market, venues } from './oracle-venues.js'

const platformKey = keyPairFromLabel('platform')
const borrower = keyPairFromLabel('borrower')
const lender = keyPairFromLabel('lender')
const lender2 = keyPairFromLabel('lender2')

function world(oracleOptions: ConstructorParameters<typeof Oracle>[2] = {}) {
  const chain = new FakeChain(100)
  const store = new Store()
  const oracle = new Oracle(platformKey, 10_000_000, oracleOptions)
  const events: WireEvent[] = []
  const sandbox = new InProcessSandbox(keyPairFromLabel('sandbox'), chain, new RuleReasoner(), 30, oracle.pubkey)
  const platform = new Platform(platformKey, store, chain, oracle, sandbox, (e) => events.push({ ...e, at: e.at ?? Date.now() }))
  return { chain, store, oracle, platform, events }
}

async function terms(w: ReturnType<typeof world>, lenderPk: Hex, step: number, prev: Hex | null, principal = 600_000_000): Promise<LoanTerms> {
  const height = await w.chain.getHeight()
  const quote = w.oracle.quote(height)
  const fee = Math.ceil(principal / 100)
  const ltv = [5000, 5500, 6000, 6500][step]
  return {
    v: 1,
    borrower_pk: borrower.pubkey,
    lender_pk: lenderPk,
    platform_pk: platformKey.pubkey,
    asset_id: 'rgb:usdt',
    principal,
    fee,
    collateral_sats: collateralFor(principal + fee, ltv, quote.price_cents),
    oracle_quote: quote,
    open_height: height,
    maturity_height: height + 30,
    grace_blocks: 5,
    recovery_height: height + 55,
    ladder_step: step,
    ltv_bps: ltv,
    prev_passbook_txid: prev,
    nonce: randomHex(),
  }
}

/** The borrower's lock transaction: collateral at vout 0, OP_RETURN terms hash at vout 1. */
function lock(chain: FakeChain, t: LoanTerms, prevRelease: Hex | null): Hex {
  const inputs = prevRelease ? [{ txid: prevRelease, vout: 0 }] : [{ txid: randomHex(), vout: 0 }]
  const txid = chain.addTx([{ value: t.collateral_sats, script: escrowFor(partiesOf(t)).script }, { value: 0, script: opReturnScript(termsHash(t)) }], inputs)
  chain.mine()
  return txid
}

async function fullLoop(w: ReturnType<typeof world>, lenderKey = lender, step = 0, prev: Hex | null = null, repayLate = false) {
  const t = await terms(w, lenderKey.pubkey, step, prev)
  const { loan } = await w.platform.registerLoan(t)
  const lockTxid = lock(w.chain, t, prev)
  await w.platform.recordLock(loan.id, lockTxid)
  const disb = w.chain.addTx([{ value: 1000, script: '00' }])
  w.chain.mine()
  await w.platform.recordFunded(loan.id, disb, fundingNotice(lenderKey, loan.id, disb))
  if (repayLate) w.chain.mine(31)
  const repay = w.chain.addTx([{ value: 1000, script: '00' }])
  w.chain.mine()
  await w.platform.recordRepaid(loan.id, repay, repaymentAck(lenderKey, loan.id, repay))
  const release = w.chain.addTx(releaseOutputs(t), [{ txid: lockTxid, vout: 0 }])
  w.chain.mine()
  const closed = await w.platform.recordRelease(loan.id, release)
  return { loan: closed, release, t }
}

describe('platform', () => {
  it('runs a loan from registration to release and climbs the ladder, then a second lender reads the chain', async () => {
    const w = world()
    const first = await fullLoop(w)
    assert.equal(first.loan.status, 'repaid')
    let pb = await w.platform.passbook(borrower.pubkey)
    assert.equal(pb.pages.length, 1)
    assert.deepEqual(pb.pages[0].verified, { lock: true, terms_commitment: true, collateral_amount: true, collateral_script: true, close: true, chain_link: true })
    assert.equal(pb.pages[0].outcome, 'on_time')
    assert.equal(pb.ladder.step, 1)
    assert.equal(pb.ladder.allowed_ltv_bps, 5500)

    // A different lender, who has never seen this borrower, registers at the earned LTV.
    const second = await fullLoop(w, lender2, 1, first.release)
    assert.equal(second.t.ltv_bps, 5500)
    pb = await w.platform.passbook(borrower.pubkey)
    assert.equal(pb.pages.length, 2)
    assert.ok(pb.pages[1].verified.chain_link, 'second lock spends the first release')
    assert.equal(pb.ladder.step, 2)
    assert.equal(pb.unverified, 0)
    const view = await w.platform.passbookView(borrower.pubkey)
    assert.equal(view.pages[0].returned_sats, first.t.collateral_sats - 500)
    assert.equal(view.pages[0].repayment_txid, first.loan.repayment_txid)
  })

  it('shows the borrower the margin prices on a funded loan, and the cure window during a call', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    await w.platform.recordLock(loan.id, lock(w.chain, t, null))
    let view = await w.platform.passbookView(borrower.pubkey)
    assert.equal(view.price_cents, 10_000_000)
    assert.deepEqual([...view.ladder_bps], [5000, 5500, 6000, 6500])
    assert.equal(view.pages[0].headroom, undefined, 'no headroom before the lender funds')
    const disb = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
    view = await w.platform.passbookView(borrower.pubkey)
    const h = view.pages[0].headroom!
    assert.equal(h.state, 'healthy')
    assert.ok(h.liquidation_price_cents < h.margin_call_price_cents && h.margin_call_price_cents < 10_000_000)
    assert.equal(view.pages[0].cure_until_height, undefined)
    w.oracle.setPrice(7_000_000)
    await w.platform.monitor()
    view = await w.platform.passbookView(borrower.pubkey)
    assert.equal(view.pages[0].headroom!.state, 'margin_call')
    assert.equal(view.pages[0].cure_until_height, (await w.chain.getHeight()) + 10)
  })

  it('refuses terms above the earned ladder, with the wrong platform key, or not chained', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 1, null)
    await assert.rejects(w.platform.registerLoan(t), (err: PolicyError) => err.verdict.checks.some((c) => c.id === 'ladder' && !c.ok))
    const t2 = await terms(w, lender.pubkey, 0, null)
    await assert.rejects(w.platform.registerLoan({ ...t2, platform_pk: borrower.pubkey }), (err: PolicyError) => err.verdict.checks.some((c) => c.id === 'platform' && !c.ok))
    await assert.rejects(w.platform.registerLoan({ ...t2, prev_passbook_txid: randomHex() }), (err: PolicyError) => err.verdict.checks.some((c) => c.id === 'chain' && !c.ok))
  })

  it('rejects a lock that does not commit to the terms, and a funding notice not signed by the lender', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    const bad = w.chain.addTx([{ value: t.collateral_sats, script: escrowFor(partiesOf(t)).script }, { value: 0, script: opReturnScript(randomHex()) }])
    w.chain.mine()
    await assert.rejects(w.platform.recordLock(loan.id, bad), /lock rejected/)
    const good = lock(w.chain, t, null)
    await w.platform.recordLock(loan.id, good)
    const disb = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    await assert.rejects(w.platform.recordFunded(loan.id, disb, fundingNotice(borrower, loan.id, disb)), /not signed by the lender/)
  })

  it('counts a late repayment as late and does not climb', async () => {
    const w = world()
    const r = await fullLoop(w, lender, 0, null, true)
    assert.equal(r.loan.status, 'repaid')
    const pb = await w.platform.passbook(borrower.pubkey)
    assert.equal(pb.pages[0].outcome, 'late')
    assert.equal(pb.ladder.step, 0)
  })

  it('co-signs a refund only after the funding window, and a liquidation only after a margin call cures out', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    const lockTxid = lock(w.chain, t, null)
    await w.platform.recordLock(loan.id, lockTxid)
    let d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'refund', txid: randomHex() })
    assert.ok(!d.ok)
    w.chain.mine(10)
    d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'refund', txid: randomHex() })
    assert.ok(d.ok && d.approval && d.approval.purpose === 'refund')

    // fund it, then crash the price
    const disb = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
    assert.equal((await w.platform.monitor())[0].state, 'healthy')
    w.oracle.setPrice(6_500_000) // -35%: LTV about 77%
    const m = await w.platform.monitor()
    assert.equal(m[0].state, 'margin_call')
    assert.ok(w.events.some((e) => e.type === 'margin_call'))
    d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', txid: randomHex() })
    assert.ok(!d.ok, 'not yet liquidatable')
    w.oracle.setPrice(6_000_000) // LTV about 83%
    d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', txid: randomHex() })
    assert.ok(!d.ok, 'cure window still open')
    w.chain.mine(10)
    d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', txid: randomHex() })
    assert.ok(d.ok && d.approval?.purpose === 'liquidate')
    const liq = w.chain.addTx([{ value: 1000, script: '00' }], [{ txid: lockTxid, vout: 0 }])
    w.chain.mine()
    await w.platform.recordSettlement(loan.id, liq, 'liquidated')
    const pb = await w.platform.passbook(borrower.pubkey)
    assert.equal(pb.pages[0].outcome, 'liquidated')
    assert.equal(pb.ladder.step, 0)
    assert.equal(pb.ladder.defaults, 1)
  })

  it('adds its leaf C signature to a refund PSBT only when it pays the policy outputs from this escrow', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    const lockTxid = lock(w.chain, t, null)
    await w.platform.recordLock(loan.id, lockTxid)
    w.chain.mine(10)
    const parties = partiesOf(t)
    const escrow = { txid: lockTxid, vout: 0, value: t.collateral_sats }
    const refund = buildEscrowSpend({ escrow, parties, leaf: 'C', outputs: releaseOutputs(t) })

    const d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'refund', psbt: refund.toBase64() })
    assert.ok(d.ok, JSON.stringify(d.checks))
    assert.equal(d.leaf, 'C')
    assert.equal(d.approval?.txid, unsignedTxid(refund))
    const signed = psbtFromBase64(d.psbt!)
    assert.equal(leafSignature(signed, parties, 'C', 'platform'), d.leaf_sig)
    signLeaf(signed, parties, 'C', borrower.secretKey)
    finalizeEscrowSpend(signed, parties, 'C')
    assert.equal(signed.extractTransaction().getId(), d.approval?.txid)

    // pays the borrower's collateral elsewhere: refused, nothing signed
    const theft = buildEscrowSpend({ escrow, parties, leaf: 'C', outputs: [{ script: keyPathOutput(lender.pubkey).script, value: t.collateral_sats - 500 }] })
    const bad = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'refund', psbt: theft.toBase64() })
    assert.ok(!bad.ok && bad.psbt === undefined && bad.leaf_sig === undefined)
    assert.ok(bad.checks.some((x) => x.id === 'outputs' && !x.ok))

    // asks for leaf A (borrower + lender): refused
    const leafA = buildEscrowSpend({ escrow, parties, leaf: 'A', outputs: releaseOutputs(t) })
    const a = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'refund', psbt: leafA.toBase64() })
    assert.ok(!a.ok && a.checks.some((x) => x.id === 'leaf' && !x.ok))

    // spends some other output, or states a different txid: refused
    const other = buildEscrowSpend({ escrow: { ...escrow, txid: randomHex() }, parties, leaf: 'C', outputs: releaseOutputs(t) })
    assert.ok(!(await w.platform.decideCosign({ loan_id: loan.id, purpose: 'refund', psbt: other.toBase64() })).ok)
    assert.ok(!(await w.platform.decideCosign({ loan_id: loan.id, purpose: 'refund', psbt: refund.toBase64(), txid: randomHex() })).ok)
  })

  it('adds its leaf B signature to a liquidation PSBT only at the current price, and only after the cure window', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    const lockTxid = lock(w.chain, t, null)
    await w.platform.recordLock(loan.id, lockTxid)
    const disb = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
    w.oracle.setPrice(6_100_000) // about 82%
    await w.platform.monitor()
    const parties = partiesOf(t)
    const escrow = { txid: lockTxid, vout: 0, value: t.collateral_sats }
    const at = (price: number) => buildEscrowSpend({ escrow, parties, leaf: 'B', outputs: liquidationOutputs(t, price) })

    const early = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt: at(6_100_000).toBase64() })
    assert.ok(!early.ok && early.psbt === undefined && early.checks.some((x) => x.id === 'cure' && !x.ok))
    w.chain.mine(10)

    // priced at a lower, stale price (more of the borrower's sats to the lender): refused
    const stale = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt: at(5_000_000).toBase64() })
    assert.ok(!stale.ok && stale.checks.some((x) => x.id === 'outputs' && !x.ok))
    // through leaf C (borrower + platform) instead of B: refused
    const leafC = buildEscrowSpend({ escrow, parties, leaf: 'C', outputs: liquidationOutputs(t, 6_100_000) })
    assert.ok(!(await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt: leafC.toBase64() })).ok)

    const psbt = at(6_100_000)
    const d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt: psbt.toBase64() })
    assert.ok(d.ok, JSON.stringify(d.checks))
    assert.equal(d.leaf, 'B')
    const signed = psbtFromBase64(d.psbt!)
    assert.ok(verifyLeafSignature(signed, parties, 'B', 'platform'))
    signLeaf(signed, parties, 'B', lender.secretKey)
    finalizeEscrowSpend(signed, parties, 'B')
    const tx = signed.extractTransaction()
    assert.equal(tx.getId(), unsignedTxid(psbt))
    assert.equal(Buffer.from(tx.outs[0].script).toString('hex'), keyPathOutput(lender.pubkey).script)
    assert.equal(Buffer.from(tx.outs[1].script).toString('hex'), keyPathOutput(borrower.pubkey).script)
  })

  it('never adds a liquidation signature using a stale last-good live price', async () => {
    let now = Date.UTC(2026, 9, 17, 9)
    let dollars = 100_000
    const fetcher = (async (...args: Parameters<typeof fetch>) => venues(now, market(dollars, 1))(...args)) as typeof fetch
    const w = world({ live: true, now: () => now, fetcher })
    try {
      await w.oracle.refresh()
      const t = await terms(w, lender.pubkey, 0, null)
      const { loan } = await w.platform.registerLoan(t)
      const lockTxid = lock(w.chain, t, null)
      await w.platform.recordLock(loan.id, lockTxid)
      const disb = w.chain.addTx([{ value: 1000, script: '00' }])
      w.chain.mine()
      await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
      dollars = 61_000
      await w.oracle.refresh()
      await w.platform.monitor()
      w.chain.mine(10)
      const psbt = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: t.collateral_sats }, parties: partiesOf(t), leaf: 'B', outputs: liquidationOutputs(t, 6_100_000) }).toBase64()
      const early = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt })
      assert.equal(early.ok, false, 'one fresh print cannot liquidate')
      assert.ok(early.checks.some((c) => c.id === 'average' && !c.ok && /not yet available/.test(c.detail)))
      for (let i = 0; i < 181; i++) { now += 10_000; await w.oracle.refresh() }
      assert.equal((await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt })).ok, true, 'thirty minutes of fresh observations can authorize the policy-correct liquidation')
      now += 90_001
      const stale = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt })
      assert.equal(stale.ok, false)
      assert.equal(stale.psbt, undefined)
      assert.equal(stale.leaf_sig, undefined)
      assert.equal(stale.approval, undefined)
      assert.ok(stale.checks.some((c) => c.id === 'oracle' && !c.ok && /stale/.test(c.detail)))
      assert.equal(w.oracle.currentPrice(), 6_100_000, 'last good price remains visible')
    } finally { w.store.close() }
  })

  it("decides a liquidation from the lender's recent quote, so a refresh in between can't change its price", async () => {
    let now = Date.UTC(2026, 9, 17, 9)
    let books = market(100_000, 1)
    const fetcher = (async (...args: Parameters<typeof fetch>) => venues(now, books)(...args)) as typeof fetch
    const w = world({ live: true, now: () => now, fetcher })
    try {
      await w.oracle.refresh()
      const t = await terms(w, lender.pubkey, 0, null)
      const { loan } = await w.platform.registerLoan(t)
      const lockTxid = lock(w.chain, t, null)
      await w.platform.recordLock(loan.id, lockTxid)
      const disb = w.chain.addTx([{ value: 1000, script: '00' }])
      w.chain.mine()
      await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
      books = market(61_000, 1)
      for (let i = 0; i < 181; i++) { now += 10_000; await w.oracle.refresh(); if (i === 0) await w.platform.monitor() }
      w.chain.mine(10)
      const q = w.oracle.quote(await w.chain.getHeight())
      assert.equal(q.averages!.slow!.price_cents, 6_100_000)
      const psbt = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: t.collateral_sats }, parties: partiesOf(t), leaf: 'B', outputs: liquidationOutputs(t, 6_100_000) }).toBase64()
      books = market(60_000, 1)
      for (let i = 0; i < 2; i++) { now += 10_000; await w.oracle.refresh() }
      assert.notEqual(w.oracle.quote(await w.chain.getHeight()).averages!.slow!.price_cents, 6_100_000, 'the average has moved since the lender priced')
      assert.equal((await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt })).ok, false, "on the platform's newer average the outputs no longer match")
      const decided = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt, oracle_quote: q })
      assert.equal(decided.ok, true, "on the lender's quote they do")
      assert.ok(decided.checks.some((c) => c.id === 'average' && /lender's quote/.test(c.detail)))
      assert.equal((await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt, oracle_quote: { ...q, averages: { ...q.averages!, slow: { ...q.averages!.slow!, price_cents: 5_000_000 } } } })).ok, false, 'a tampered quote is ignored')
      now += 31_000
      assert.equal((await w.platform.decideCosign({ loan_id: loan.id, purpose: 'liquidate', psbt, oracle_quote: q })).ok, false, 'an old quote is ignored')
    } finally { w.store.close() }
  })

  it('starts no cure window while the oracle cannot sign a quote, as when USDT is off its peg', async () => {
    const now = Date.UTC(2026, 9, 17, 9)
    let books = market(100_000, 1)
    const fetcher = (async (...args: Parameters<typeof fetch>) => venues(now, books)(...args)) as typeof fetch
    const w = world({ live: true, now: () => now, fetcher })
    try {
      await w.oracle.refresh()
      const t = await terms(w, lender.pubkey, 0, null)
      const { loan } = await w.platform.registerLoan(t)
      await w.platform.recordLock(loan.id, lock(w.chain, t, null))
      const disb = w.chain.addTx([{ value: 1000, script: '00' }])
      w.chain.mine()
      await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
      books = market(61_000, 0.97)
      await w.oracle.refresh()
      const [row] = await w.platform.monitor()
      assert.ok(row.ltv_bps >= 7000, `LTV ${row.ltv_bps} is in margin-call territory`)
      assert.equal(w.store.loansByStatus('open')[0].margin_call_height, undefined)
      assert.ok(!w.events.some((e) => e.type === 'margin_call'))
      books = market(61_000, 1)
      await w.oracle.refresh()
      await w.platform.monitor()
      assert.equal(w.store.loansByStatus('open')[0].margin_call_height, await w.chain.getHeight())
      assert.ok(w.events.some((e) => e.type === 'margin_call'))
    } finally { w.store.close() }
  })

  it('accepts a release proof only from the lender or a validated consignment, never from the borrower alone', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    const lockTxid = lock(w.chain, t, null)
    await w.platform.recordLock(loan.id, lockTxid)
    const disb = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
    // this platform runs no RGB watcher: no invoice can be issued, nothing can be validated
    await assert.rejects(w.platform.registerRepaymentWatch(loan.id, { account_xpub_vanilla: 'x', account_xpub_colored: 'y', master_fingerprint: 'z' }, randomHex(64)), /no RGB watcher/)
    assert.ok((await w.platform.verifyRepayment(loan.id)).checks.some((x) => x.id === 'watch' && !x.ok))

    const repay = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    const release = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: t.collateral_sats }, parties: partiesOf(t), leaf: 'C', outputs: releaseOutputs(t) })
    await w.platform.recordRepaid(loan.id, repay)
    let d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'release', psbt: release.toBase64(), repayment_txid: repay })
    assert.ok(!d.ok && d.psbt === undefined, 'the borrower saying so is not proof')
    assert.ok(d.checks.some((x) => x.id === 'proof' && !x.ok))
    await w.platform.recordRepaid(loan.id, repay, repaymentAck(borrower, loan.id, repay))
    assert.ok(!(await w.platform.decideCosign({ loan_id: loan.id, purpose: 'release', psbt: release.toBase64(), repayment_txid: repay })).ok, 'an acknowledgement not signed by the lender')

    await w.platform.recordRepaid(loan.id, repay, repaymentAck(lender, loan.id, repay))
    d = await w.platform.decideCosign({ loan_id: loan.id, purpose: 'release', psbt: release.toBase64(), repayment_txid: repay })
    assert.ok(d.ok && d.leaf === 'C', JSON.stringify(d.checks))
    // a later unproven report does not replace the acknowledged repayment
    const other = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    assert.equal((await w.platform.recordRepaid(loan.id, other)).repayment_txid, repay)
  })

  it('rejects an equal-value lock sent to a different escrow, including in an imported registry row', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    const wrongScript = keyPathOutput(borrower.pubkey).script
    const lockTxid = w.chain.addTx([{ value: t.collateral_sats, script: wrongScript }, { value: 0, script: opReturnScript(termsHash(t)) }])
    w.chain.mine()
    await assert.rejects(w.platform.recordLock(loan.id, lockTxid), (err: PolicyError) => err.verdict.checks.some((c) => c.id === 'script' && !c.ok))
    // Persistence may contain pre-fix data: the independent registry reader must reject it too.
    const close = w.chain.addTx(releaseOutputs(t), [{ txid: lockTxid, vout: 0 }])
    w.chain.mine()
    w.store.updateLoan(loan.id, { status: 'repaid', lock_txid: lockTxid, lock_vout: 0, release_txid: close, repaid_height: 102 })
    const pb = await w.platform.passbook(borrower.pubkey)
    assert.equal(pb.pages[0].verified.collateral_amount, true)
    assert.equal(pb.pages[0].verified.collateral_script, false)
    assert.equal(pb.ladder.step, 0)
    assert.equal(pb.unverified, 1)
  })

  it('does not stamp a page when a borrower reports an arbitrary payment transaction', async () => {
    const w = world()
    const t = await terms(w, lender.pubkey, 0, null)
    const { loan } = await w.platform.registerLoan(t)
    const locked = lock(w.chain, t, null)
    await w.platform.recordLock(loan.id, locked)
    const disb = w.chain.addTx([{ value: 1000, script: '00' }])
    w.chain.mine()
    await w.platform.recordFunded(loan.id, disb, fundingNotice(lender, loan.id, disb))
    await w.platform.recordRepaid(loan.id, disb)
    const close = w.chain.addTx(releaseOutputs(t), [{ txid: locked, vout: 0 }])
    w.chain.mine()
    await assert.rejects(w.platform.recordRelease(loan.id, close), /no validated repayment/)
  })

  it('records sandbox runs by hash only', async () => {
    const w = world()
    const { encryptTo } = await import('../src/market/messages.js')
    const sandboxPk = (await w.platform.sandboxPubkey()).sandbox_pk
    const bundle = {
      v: 1,
      borrower_pk: borrower.pubkey,
      own_pks: [],
      offer_id: 'x',
      loan_request: { principal: 600_000_000, fee: 6_000_000, term_blocks: 30, grace_blocks: 5 },
      lender_requirements: { affordability: true, inflow_months: 0, inflow_multiple_bps: 0 },
      balance: 2_000_000_000,
      history: [{ txid: 'h1', height: 90, direction: 'in', amount: 100, counterparty_pk: 'cc'.repeat(32), memo: 'very private note' }],
      candidate_inflows: [],
      scheduled_outflows: [],
      collateral: { sats: 1_212_000, oracle_quote: w.oracle.quote(100), allowed_ltv_bps: 5000 },
    }
    const r = await w.platform.submitToSandbox(borrower.pubkey, encryptTo(borrower, sandboxPk, JSON.stringify(bundle)))
    assert.equal(r.sandbox_pk, sandboxPk)
    const run = w.store.getSandboxRun(r.bundle_hash === undefined ? '' : (await import('../src/sandbox/run.js')).resultHash(r))
    assert.ok(run)
    assert.ok(!JSON.stringify(w.events).includes('very private note'))
  })
})
