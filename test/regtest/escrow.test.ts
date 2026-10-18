// The four-leaf escrow on regtest: every leaf is spent for real, the default
// split and the recovery leaf are refused before their locktime and accepted
// after it. Needs `infra/regtest.sh start`.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import type { Psbt } from 'bitcoinjs-lib'
import { Regtest } from '../../src/chain/regtest.js'
import { opReturnScript } from '../../src/chain/types.js'
import { randomHex, randomKeyPair, type Hex, type KeyPair } from '../../src/core/crypto.js'
import { microToSats } from '../../src/core/money.js'
import { termsHash, type LoanTerms } from '../../src/core/terms.js'
import {
  buildEscrowSpend,
  buildLock,
  escrowFor,
  extractHex,
  finalizeEscrowSpend,
  keyPathOutput,
  liquidationOutputs,
  partiesOf,
  releaseOutputs,
  signKeyPath,
  signLeaf,
  splitLocktime,
  splitOutputs,
  TX_FEE_SATS,
  unsignedTxid,
  type Outpoint,
} from '../../src/escrow/escrow.js'
import { Oracle } from '../../src/oracle/oracle.js'

const regtest = new Regtest()
const chain = regtest.chain
const platform = randomKeyPair()
const oracle = new Oracle(platform, 10_000_000)
const COLLATERAL = 2_000_000

interface World {
  borrower: KeyPair
  lender: KeyPair
  terms: LoanTerms
  escrow: Outpoint
  lockTxid: Hex
}

async function broadcast(hex: Hex): Promise<Hex> {
  return chain.rpc<Hex>('sendrawtransaction', [hex])
}

async function mempoolVerdict(hex: Hex): Promise<{ allowed: boolean; 'reject-reason'?: string }> {
  const [r] = await chain.rpc<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[hex]])
  return r
}

async function fundKeyPath(pk: Hex, btc: number): Promise<Outpoint> {
  const { script } = keyPathOutput(pk)
  const txid = await regtest.send(keyPathOutput(pk).address, btc)
  await regtest.mine(1)
  const tx = await chain.getTx(txid)
  const vout = tx!.outputs.findIndex((o) => o.script === script)
  return { txid, vout, value: tx!.outputs[vout].value }
}

/** Fresh borrower and lender, a funded borrower output, terms, and a confirmed lock. */
async function world(opts: { maturityIn?: number; grace?: number; recoveryIn?: number; prev?: Outpoint } = {}): Promise<World> {
  const borrower = randomKeyPair()
  const lender = randomKeyPair()
  const funding = opts.prev ?? (await fundKeyPath(borrower.pubkey, 0.05))
  const height = await chain.getHeight()
  const maturity = height + (opts.maturityIn ?? 30)
  const grace = opts.grace ?? 5
  const terms: LoanTerms = {
    v: 1,
    borrower_pk: borrower.pubkey,
    lender_pk: lender.pubkey,
    platform_pk: platform.pubkey,
    asset_id: 'rgb:test',
    principal: 600_000_000,
    fee: 6_000_000,
    collateral_sats: COLLATERAL,
    oracle_quote: oracle.quote(height),
    open_height: height,
    maturity_height: maturity,
    grace_blocks: grace,
    recovery_height: opts.recoveryIn !== undefined ? height + opts.recoveryIn : maturity + grace + 20,
    ladder_step: 0,
    ltv_bps: 5000,
    prev_passbook_txid: null,
    nonce: randomHex(32),
  }
  const psbt = buildLock({ inputs: [{ ...funding, internal_pk: borrower.pubkey }], terms, changeScript: keyPathOutput(borrower.pubkey).script })
  signKeyPath(psbt, borrower.secretKey).finalizeAllInputs()
  const lockTxid = await broadcast(extractHex(psbt))
  await regtest.mine(1)
  return { borrower, lender, terms, escrow: { txid: lockTxid, vout: 0, value: COLLATERAL }, lockTxid }
}

async function confirm(psbt: Psbt): Promise<Hex> {
  const hex = extractHex(psbt)
  const txid = await broadcast(hex)
  assert.equal(txid, unsignedTxid(psbt))
  await regtest.mine(1)
  const tx = await chain.getTx(txid)
  assert.ok(tx?.height, 'confirmed')
  return txid
}

describe('escrow on regtest', () => {
  before(() => regtest.ensureMiner())

  it('lock carries the collateral to the escrow and commits to the terms hash', async () => {
    const w = await world()
    const tx = await chain.getTx(w.lockTxid)
    assert.ok(tx?.height)
    assert.equal(tx.outputs[0].script, escrowFor(partiesOf(w.terms)).script)
    assert.equal(tx.outputs[0].value, COLLATERAL)
    assert.equal(tx.outputs[1].script, opReturnScript(termsHash(w.terms)))
  })

  it('leaf A: borrower and lender release; the release output funds the next lock', async () => {
    const w = await world()
    const parties = partiesOf(w.terms)
    const psbt = buildEscrowSpend({ escrow: w.escrow, parties, leaf: 'A', outputs: releaseOutputs(w.terms) })
    assert.throws(() => signLeaf(psbt, parties, 'A', platform.secretKey), /not a signer of leaf A/)
    signLeaf(psbt, parties, 'A', w.borrower.secretKey)
    assert.throws(() => finalizeEscrowSpend(psbt, parties, 'A'), /missing the lender signature/)
    signLeaf(psbt, parties, 'A', w.lender.secretKey)
    const releaseTxid = await confirm(finalizeEscrowSpend(psbt, parties, 'A'))
    const release = await chain.getTx(releaseTxid)
    assert.equal(release!.outputs[0].script, keyPathOutput(w.borrower.pubkey).script)
    assert.equal(release!.outputs[0].value, COLLATERAL - TX_FEE_SATS)

    // passbook chain: lock again from the release output with the same borrower key
    const prev = { txid: releaseTxid, vout: 0, value: COLLATERAL - TX_FEE_SATS }
    const borrower = w.borrower
    const height = await chain.getHeight()
    const terms2: LoanTerms = { ...w.terms, collateral_sats: COLLATERAL - 2 * TX_FEE_SATS, open_height: height, prev_passbook_txid: releaseTxid, nonce: randomHex(32) }
    const lock2 = buildLock({ inputs: [{ ...prev, internal_pk: borrower.pubkey }], terms: terms2, changeScript: keyPathOutput(borrower.pubkey).script })
    signKeyPath(lock2, borrower.secretKey).finalizeAllInputs()
    const lock2Txid = await confirm(lock2)
    const tx2 = await chain.getTx(lock2Txid)
    assert.deepEqual(tx2!.inputs.map(({ txid, vout }) => ({ txid, vout })), [{ txid: releaseTxid, vout: 0 }])
    assert.ok(tx2!.inputs[0].witness?.length, 'bitcoind exposes the real input witness')
  })

  it('leaf A: the pre-signed default split is refused before maturity + grace and accepted after', async () => {
    const w = await world({ maturityIn: 3, grace: 2 })
    const parties = partiesOf(w.terms)
    const locktime = splitLocktime(w.terms)
    // the borrower signs at open and hands the signature over; the lender adds its own later
    const psbt = buildEscrowSpend({ escrow: w.escrow, parties, leaf: 'A', outputs: splitOutputs(w.terms), locktime })
    signLeaf(psbt, parties, 'A', w.borrower.secretKey)
    signLeaf(psbt, parties, 'A', w.lender.secretKey)
    finalizeEscrowSpend(psbt, parties, 'A')
    const hex = extractHex(psbt)

    assert.ok((await chain.getHeight()) < locktime)
    const early = await mempoolVerdict(hex)
    assert.equal(early.allowed, false)
    assert.equal(early['reject-reason'], 'non-final')

    await regtest.mine(locktime - (await chain.getHeight()))
    const txid = await confirm(psbt)
    const tx = await chain.getTx(txid)
    const owed = microToSats(w.terms.principal + w.terms.fee, w.terms.oracle_quote.price_cents)
    assert.equal(tx!.outputs[0].script, keyPathOutput(w.lender.pubkey).script)
    assert.equal(tx!.outputs[0].value, owed)
    assert.equal(tx!.outputs[1].script, keyPathOutput(w.borrower.pubkey).script)
    assert.equal(tx!.outputs[1].value, COLLATERAL - TX_FEE_SATS - owed)
  })

  it('leaf B: lender and platform liquidate at the current price for exactly the debt, no penalty', async () => {
    const w = await world()
    const parties = partiesOf(w.terms)
    const outputs = liquidationOutputs(w.terms, 5_000_000)
    const psbt = buildEscrowSpend({ escrow: w.escrow, parties, leaf: 'B', outputs })
    assert.throws(() => signLeaf(psbt, parties, 'B', w.borrower.secretKey), /not a signer of leaf B/)
    signLeaf(psbt, parties, 'B', w.lender.secretKey)
    signLeaf(psbt, parties, 'B', platform.secretKey)
    const txid = await confirm(finalizeEscrowSpend(psbt, parties, 'B'))
    const tx = await chain.getTx(txid)
    assert.equal(tx!.outputs[0].value, microToSats(w.terms.principal + w.terms.fee, 5_000_000))
    assert.equal(tx!.outputs[1].value, COLLATERAL - TX_FEE_SATS - tx!.outputs[0].value)
    assert.ok(tx!.outputs.every((o) => o.script !== keyPathOutput(platform.pubkey).script), 'nothing to the platform')
  })

  it('leaf C: borrower and platform refund an unfunded loan', async () => {
    const w = await world()
    const parties = partiesOf(w.terms)
    const psbt = buildEscrowSpend({ escrow: w.escrow, parties, leaf: 'C', outputs: releaseOutputs(w.terms) })
    assert.throws(() => signLeaf(psbt, parties, 'C', w.lender.secretKey), /not a signer of leaf C/)
    signLeaf(psbt, parties, 'C', w.borrower.secretKey)
    signLeaf(psbt, parties, 'C', platform.secretKey)
    await confirm(finalizeEscrowSpend(psbt, parties, 'C'))
  })

  it('leaf D: the borrower alone recovers after the recovery height, not before', async () => {
    const w = await world({ maturityIn: 2, grace: 1, recoveryIn: 6 })
    const parties = partiesOf(w.terms)
    const psbt = buildEscrowSpend({ escrow: w.escrow, parties, leaf: 'D', outputs: releaseOutputs(w.terms) })
    assert.equal(psbt.locktime, w.terms.recovery_height)
    signLeaf(psbt, parties, 'D', w.borrower.secretKey)
    finalizeEscrowSpend(psbt, parties, 'D')
    const early = await mempoolVerdict(extractHex(psbt))
    assert.equal(early.allowed, false)
    assert.equal(early['reject-reason'], 'non-final')

    await regtest.mine(w.terms.recovery_height - (await chain.getHeight()))
    await confirm(psbt)
  })
})
