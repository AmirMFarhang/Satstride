// Decode actual Bitcoin bytes. Caller claims and UI summaries are never inputs to policy.
import * as bitcoin from 'bitcoinjs-lib'
import { bytesToHex, hexToBytes } from '../core/crypto.js'
import { onchainCollateralFor } from './onchain-collateral-template.js'
import { assertOnchainWholeTransactionSighash, nativeAmount, onchainLoanId, validateOnchainIntent, validateOnchainTermsV3, type OnchainDecodedSummary, type OnchainJointIntent, type OnchainLoanTermsV3, type OnchainPrevout } from './onchain-v3-contract.js'

function refuse(message: string): never { throw new Error(`JOINT_POLICY: ${message}`) }
const outpointId = (p: { txid: string; vout: number }) => `${p.txid}:${p.vout}`
export function collateralForTerms(terms: OnchainLoanTermsV3) {
  validateOnchainTermsV3(terms)
  return onchainCollateralFor({ ...terms, loan_id: onchainLoanId(terms) })
}

/** Actual prevouts must be fetched independently from Bitcoin, including spent ones
 * when verifying historical evidence. Liveness is checked separately before signing. */
export function decodeJointTransaction(terms: OnchainLoanTermsV3, intent: OnchainJointIntent, psbtBase64: string, actual: OnchainPrevout[], walletId: string, phase: 'uncolored' | 'finalized' = 'finalized'): OnchainDecodedSummary {
  validateOnchainIntent(intent, terms)
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.regtest })
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  if (tx.version !== 2 || tx.locktime !== 0) refuse('version 2 and zero joint locktime required')
  const expectedInputs = [intent.rgb_input, ...intent.borrower_btc_inputs, ...(intent.action === 'repayment' ? [intent.collateral] : [])]
  if (tx.ins.length !== expectedInputs.length || actual.length !== expectedInputs.length) refuse('unexpected input count')
  const expected = new Map(expectedInputs.map(p => [outpointId(p), p]))
  const independent = new Map(actual.map(p => [outpointId(p), p]))
  if (independent.size !== actual.length) refuse('duplicate independently fetched prevout')
  let totalIn = 0n
  const seen = new Set<string>()
  const inputs = tx.ins.map((input, i) => {
    const id = `${bytesToHex(Uint8Array.from(input.hash).reverse())}:${input.index}`
    const committed = expected.get(id), real = independent.get(id), witness = psbt.data.inputs[i].witnessUtxo
    if (!committed || !real || !witness || seen.has(id)) refuse('wrong or duplicated input')
    seen.add(id)
    if (real.value_sats !== committed.value_sats || real.script_pubkey !== committed.script_pubkey || witness.value !== nativeAmount(real.value_sats) || bytesToHex(witness.script) !== real.script_pubkey) refuse('forged Bitcoin prevout')
    if (!/^5120[0-9a-f]{64}$/.test(real.script_pubkey) || input.script.length || input.witness.length) refuse('native unsigned P2TR inputs required')
    if (input.sequence !== 0xfffffffd) refuse('joint input sequence must be 0xfffffffd')
    const info = psbt.data.inputs[i]
    assertOnchainWholeTransactionSighash(info.sighashType ?? 0)
    // No signatures can precede proof verification and local approval.
    if (info.tapKeySig || info.tapScriptSig?.length || info.partialSig?.length || info.finalScriptWitness || info.finalScriptSig) refuse('proposal already contains signatures')
    totalIn += nativeAmount(real.value_sats)
    return { outpoint: { txid: real.txid, vout: real.vout }, value_sats: real.value_sats, script_pubkey: real.script_pubkey, sequence: input.sequence, sighash: info.sighashType === 1 ? 'ALL' as const : 'DEFAULT' as const }
  })
  const { bitcoin_policy: bp, destinations: d } = terms.settlement
  const c = collateralForTerms(terms)
  if (intent.action === 'repayment' && intent.collateral.script_pubkey !== c.script_pubkey) refuse('collateral is not the signed A/F/D tree')
  // First input is the one exact NIA source. The native owner verifies its full allocation.
  if (outpointId(inputs[0].outpoint) !== outpointId(intent.rgb_input)) refuse('RGB source must be first input')
  const hasChange = intent.borrower_change_vout !== null
  if (tx.outs.length !== (intent.action === 'origination' ? 4 : 3) + Number(hasChange)) refuse('unexpected outputs')
  if (tx.outs[0].value !== 0n || !(phase === 'uncolored' ? /^6a(?:00)?$/ : /^6a20[0-9a-f]{64}$/).test(bytesToHex(tx.outs[0].script))) refuse('one exact RGB OP_RETURN commitment required')
  const requireOutput = (vout: number, script: string, amount: string) => {
    const out = tx.outs[vout]
    if (!out || bytesToHex(out.script) !== script || out.value !== nativeAmount(amount)) refuse(`wrong output ${vout}`)
  }
  if (intent.action === 'origination') {
    requireOutput(1, c.script_pubkey, terms.collateral_sats)
    requireOutput(2, d.borrower_rgb_script_pubkey, bp.rgb_output_sats)
    requireOutput(3, d.lender_btc_script_pubkey, intent.rgb_input.value_sats)
  } else {
    requireOutput(1, d.lender_rgb_script_pubkey, bp.rgb_output_sats)
    requireOutput(2, d.borrower_btc_script_pubkey, terms.collateral_sats)
  }
  if (hasChange && bytesToHex(tx.outs[intent.borrower_change_vout!].script) !== d.borrower_change_script_pubkey) refuse('unauthorized change destination')
  let totalOut = 0n
  const outputs = tx.outs.map((o, vout) => {
    totalOut += o.value
    if (vout !== 0 && o.value < nativeAmount(bp.min_output_sats)) refuse('dust output')
    return { vout, value_sats: o.value.toString(), script_pubkey: bytesToHex(o.script), allocations: vout === intent.rgb_output_vout ? [{ asset: terms.settlement.asset, amount: intent.amount }] : [] }
  })
  const fee = totalIn - totalOut
  if (fee <= 0n || fee > nativeAmount(intent.action === 'origination' ? bp.origination_fee_cap_sats : bp.repayment_fee_cap_sats)) refuse('miner fee exceeds approved cap or is nonpositive')
  return { kind: 'rgb-onchain-joint', action: intent.action, wallet_id: walletId, network: intent.network, obligation_id: intent.loan_id, inputs, outputs, transaction_version: tx.version, locktime: tx.locktime, fee_sats: fee.toString(), unsigned_txid: tx.getId() }
}

/** Canonical pre-signed enforcement; generated from the finalized colored funding txid. */
export function enforcementTransactions(terms: OnchainLoanTermsV3, fundingTxid: string) {
  const c = collateralForTerms(terms)
  const payouts = [{ kind: 'default' as const, template_id: null as string | null, lock_height: terms.maturity_height + terms.grace_blocks, ...terms.settlement.default_payout }, ...terms.settlement.liquidation.templates.map(t => ({ ...t, kind: 'liquidation' as const, template_id: t.id }))]
  return payouts.map(p => {
    const leaf = c.leaves[p.kind === 'default' ? 'A' : 'F']
    const tx = new bitcoin.Psbt({ network: bitcoin.networks.regtest }).setVersion(2).setLocktime(p.lock_height)
    tx.addInput({ hash: fundingTxid, index: 1, sequence: 0xfffffffe, witnessUtxo: { value: nativeAmount(terms.collateral_sats), script: hexToBytes(c.script_pubkey) }, tapInternalKey: hexToBytes(c.internal_key), tapLeafScript: [{ leafVersion: 0xc0, script: hexToBytes(leaf.script), controlBlock: hexToBytes(leaf.control_block) }] })
    tx.addOutput({ script: hexToBytes(terms.settlement.destinations.lender_btc_script_pubkey), value: nativeAmount(p.lender_sats) })
    if (nativeAmount(p.borrower_sats)) tx.addOutput({ script: hexToBytes(terms.settlement.destinations.borrower_btc_script_pubkey), value: nativeAmount(p.borrower_sats) })
    return { kind: p.kind, template_id: p.template_id, unsigned_psbt_base64: tx.toBase64() }
  })
}
