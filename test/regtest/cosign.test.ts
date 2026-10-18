// The platform on bitcoind: it records a real lock, refuses to co-sign a refund
// inside the funding window, then adds its leaf C signature after it; the
// borrower finalizes and broadcasts, and the platform records the settlement.
// Needs `infra/regtest.sh start`.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { RuleReasoner } from '../../src/ai/rule-reasoner.js'
import { Regtest } from '../../src/chain/regtest.js'
import { randomHex, randomKeyPair } from '../../src/core/crypto.js'
import { collateralFor } from '../../src/core/money.js'
import type { LoanTerms } from '../../src/core/terms.js'
import { buildEscrowSpend, buildLock, extractHex, finalizeEscrowSpend, keyPathOutput, partiesOf, psbtFromBase64, releaseOutputs, signKeyPath, signLeaf } from '../../src/escrow/escrow.js'
import { Oracle } from '../../src/oracle/oracle.js'
import { FUND_TIMEOUT_BLOCKS } from '../../src/registry/ladder.js'
import { Store } from '../../src/registry/store.js'
import { InProcessSandbox } from '../../src/sandbox/broker.js'
import { Platform } from '../../src/server/platform.js'

describe('platform co-signing on regtest', () => {
  const regtest = new Regtest()
  const chain = regtest.chain
  before(() => regtest.ensureMiner())

  it('co-signs a real refund through leaf C after the funding window', async () => {
    const platformKey = randomKeyPair()
    const oracle = new Oracle(platformKey, 10_000_000)
    const store = new Store()
    const platform = new Platform(platformKey, store, chain, oracle, new InProcessSandbox(randomKeyPair(), chain, new RuleReasoner(), 30, oracle.pubkey), () => {})
    const borrower = randomKeyPair()
    const lender = randomKeyPair()

    const fundTxid = await regtest.send(keyPathOutput(borrower.pubkey).address, 0.02)
    await regtest.mine(1)
    const fundTx = await chain.getTx(fundTxid)
    const vout = fundTx!.outputs.findIndex((o) => o.script === keyPathOutput(borrower.pubkey).script)

    const height = await chain.getHeight()
    const quote = oracle.quote(height)
    const principal = 600_000_000
    const fee = 6_000_000
    const terms: LoanTerms = {
      v: 1,
      borrower_pk: borrower.pubkey,
      lender_pk: lender.pubkey,
      platform_pk: platformKey.pubkey,
      asset_id: 'rgb:test',
      principal,
      fee,
      collateral_sats: collateralFor(principal + fee, 5000, quote.price_cents),
      oracle_quote: quote,
      open_height: height,
      maturity_height: height + 30,
      grace_blocks: 5,
      recovery_height: height + 55,
      ladder_step: 0,
      ltv_bps: 5000,
      prev_passbook_txid: null,
      nonce: randomHex(32),
    }
    const { loan } = await platform.registerLoan(terms)

    const lock = buildLock({ inputs: [{ txid: fundTxid, vout, value: fundTx!.outputs[vout].value, internal_pk: borrower.pubkey }], terms, changeScript: keyPathOutput(borrower.pubkey).script })
    signKeyPath(lock, borrower.secretKey).finalizeAllInputs()
    const lockTxid = await chain.rpc<string>('sendrawtransaction', [extractHex(lock)])
    await regtest.mine(1)
    const locked = await platform.recordLock(loan.id, lockTxid)
    assert.equal(locked.lock_vout, 0)

    const parties = partiesOf(terms)
    const refund = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: terms.collateral_sats }, parties, leaf: 'C', outputs: releaseOutputs(terms) })
    const early = await platform.decideCosign({ loan_id: loan.id, purpose: 'refund', psbt: refund.toBase64() })
    assert.ok(!early.ok && !early.psbt, 'inside the funding window')

    await regtest.mine(FUND_TIMEOUT_BLOCKS)
    const d = await platform.decideCosign({ loan_id: loan.id, purpose: 'refund', psbt: refund.toBase64() })
    assert.ok(d.ok, JSON.stringify(d.checks))
    const signed = psbtFromBase64(d.psbt!)
    signLeaf(signed, parties, 'C', borrower.secretKey)
    finalizeEscrowSpend(signed, parties, 'C')
    const refundTxid = await chain.rpc<string>('sendrawtransaction', [extractHex(signed)])
    assert.equal(refundTxid, d.approval!.txid)
    await regtest.mine(1)

    const settled = await platform.recordSettlement(loan.id, refundTxid, 'refunded')
    assert.equal(settled.status, 'refunded')
    const back = await chain.getTx(refundTxid)
    assert.equal(back!.outputs[0].script, keyPathOutput(borrower.pubkey).script)
  })
})
