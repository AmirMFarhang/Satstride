import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { bytesToHex, hexToBytes } from '../src/core/crypto.js'
import { collateralForTerms, decodeJointTransaction, enforcementTransactions } from '../src/settlement/onchain-transaction-policy.js'
import { onchainLoanId, type OnchainJointIntent } from '../src/settlement/onchain-v3-contract.js'
import { jointTerms } from './onchain-fixtures.js'
function proposal(action: 'origination' | 'repayment') {
  const t = jointTerms(), c = collateralForTerms(t), d = t.settlement.destinations
  const rgb = { txid: 'aa'.repeat(32), vout: 0, value_sats: '1000', script_pubkey: action === 'origination' ? d.lender_rgb_script_pubkey : d.borrower_rgb_script_pubkey }
  const btc = { txid: 'bb'.repeat(32), vout: 0, value_sats: '2000000', script_pubkey: d.borrower_change_script_pubkey }
  const collateral = { txid: 'cc'.repeat(32), vout: 1, value_sats: t.collateral_sats, script_pubkey: c.script_pubkey }
  const common = { domain: 'passbook-rgb-joint-intent/v1' as const, loan_id: onchainLoanId(t), network: t.settlement.network, asset: t.settlement.asset, amount: action === 'origination' ? t.principal : t.settlement.debt, rgb_input: rgb, borrower_btc_inputs: [btc] }
  const intent: OnchainJointIntent = action === 'origination' ? { ...common, action, collateral_output_vout: 1, rgb_output_vout: 2, lender_btc_return_vout: 3, borrower_change_vout: 4 } : { ...common, action, collateral, rgb_output_vout: 1, collateral_return_vout: 2, borrower_change_vout: 3 }
  const actual = [rgb, btc, ...(action === 'repayment' ? [collateral] : [])]
  const psbt = new bitcoin.Psbt().setVersion(2)
  for (const p of actual) psbt.addInput({ hash: p.txid, index: p.vout, sequence: 0xfffffffd, witnessUtxo: { script: hexToBytes(p.script_pubkey), value: BigInt(p.value_sats) } })
  psbt.addOutput({ script: hexToBytes('6a20' + 'dd'.repeat(32)), value: 0n })
  if (action === 'origination') {
    psbt.addOutput({ script: hexToBytes(c.script_pubkey), value: BigInt(t.collateral_sats) })
    psbt.addOutput({ script: hexToBytes(d.borrower_rgb_script_pubkey), value: 1000n })
    psbt.addOutput({ script: hexToBytes(d.lender_btc_script_pubkey), value: 1000n })
    psbt.addOutput({ script: hexToBytes(d.borrower_change_script_pubkey), value: 785500n })
  } else {
    psbt.addOutput({ script: hexToBytes(d.lender_rgb_script_pubkey), value: 1000n })
    psbt.addOutput({ script: hexToBytes(d.borrower_btc_script_pubkey), value: BigInt(t.collateral_sats) })
    psbt.addOutput({ script: hexToBytes(d.borrower_change_script_pubkey), value: 1999500n })
  }
  return { t, intent, actual, psbt }
}
for (const action of ['origination', 'repayment'] as const) {
  test(`${action}: independent prevouts and complete exact output/fee policy`, () => {
    const { t, intent, actual, psbt } = proposal(action)
    const decoded = decodeJointTransaction(t, intent, psbt.toBase64(), actual, 'local-wallet')
    assert.equal(decoded.fee_sats, action === 'origination' ? '1500' : '500')
    assert.equal(decoded.outputs[intent.rgb_output_vout].allocations[0].amount, intent.amount)
    for (const field of ['value_sats', 'script_pubkey'] as const) {
      const forged = structuredClone(actual); forged[0][field] = field === 'value_sats' ? '999' : t.settlement.destinations.lender_btc_script_pubkey === actual[0].script_pubkey ? t.settlement.destinations.borrower_btc_script_pubkey : t.settlement.destinations.lender_btc_script_pubkey
      assert.throws(() => decodeJointTransaction(t, intent, psbt.toBase64(), forged, 'local-wallet'), /prevout/)
    }
    const wrongSighash = psbt.clone(); wrongSighash.updateInput(0, { sighashType: 0x81 })
    assert.throws(() => decodeJointTransaction(t, intent, wrongSighash.toBase64(), actual, 'local-wallet'), /SIGHASH/)
    const signed = psbt.clone(); signed.updateInput(0, { tapKeySig: new Uint8Array(64).fill(1) })
    assert.throws(() => decodeJointTransaction(t, intent, signed.toBase64(), actual, 'local-wallet'), /signatures/)
    const extra = psbt.clone().addOutput({ script: hexToBytes(actual[0].script_pubkey), value: 330n })
    assert.throws(() => decodeJointTransaction(t, intent, extra.toBase64(), actual, 'local-wallet'), /outputs/)
    const locktime = psbt.clone().setLocktime(100)
    assert.throws(() => decodeJointTransaction(t, intent, locktime.toBase64(), actual, 'local-wallet'), /locktime/)
    // Serializing a malicious transaction defeats no policy: policy reads actual bytes again.
    const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
    tx.outs[intent.rgb_output_vout].value += 1n
    const bad = new bitcoin.Psbt(); bad.setVersion(2)
    for (let n = 0; n < tx.ins.length; n++) bad.addInput({ hash: tx.ins[n].hash, index: tx.ins[n].index, sequence: tx.ins[n].sequence, witnessUtxo: psbt.data.inputs[n].witnessUtxo })
    for (const o of tx.outs) bad.addOutput(o)
    assert.throws(() => decodeJointTransaction(t, intent, bad.toBase64(), actual, 'local-wallet'), /wrong output/)
  })
}
test('all default/liquidation templates bind the finalized C, exact payouts and leaves', () => {
  const t = jointTerms(), funding = 'ab'.repeat(32), c = collateralForTerms(t)
  const spends = enforcementTransactions(t, funding)
  assert.equal(spends.length, 1 + t.settlement.liquidation.templates.length)
  spends.forEach((s, i) => {
    const p = bitcoin.Psbt.fromBase64(s.unsigned_psbt_base64)
    const tx = bitcoin.Transaction.fromBuffer(p.data.globalMap.unsignedTx.toBuffer())
    assert.equal(bytesToHex(Uint8Array.from(tx.ins[0].hash).reverse()), funding)
    assert.equal(tx.ins[0].index, 1); assert.equal(tx.ins[0].sequence, 0xfffffffe)
    assert.equal(tx.locktime, i ? t.settlement.liquidation.templates[i - 1].lock_height : t.maturity_height + t.grace_blocks)
    assert.equal(bytesToHex(p.data.inputs[0].tapLeafScript![0].script), c.leaves[i ? 'F' : 'A'].script)
    assert.equal(tx.outs.reduce((sum, out) => sum + out.value, 0n), BigInt(t.collateral_sats) - 500n)
  })
})
