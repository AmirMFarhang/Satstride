import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { witnessStackToScriptWitness } from 'bitcoinjs-lib/src/psbt/psbtutils'
import { bytesToHex, hexToBytes, keyPairFromLabel } from '../../src/core/crypto.js'
import { NativeJointPreparation, type NativeJointChain } from '../../src/settlement/native-joint-preparation.js'
import { collateralForTerms, enforcementTransactions } from '../../src/settlement/onchain-transaction-policy.js'
import { verifyBorrowerEnforcement } from '../../src/settlement/onchain-enforcement.js'
import { onchainLoanId, type OnchainJointIntent, type OnchainPrevout } from '../../src/settlement/onchain-v3-contract.js'
import { jointTerms } from '../onchain-fixtures.js'
import { nativeActor, nativeMine, nativeRpc, nativeSettled, nativeTransfer, testExport, type NativeTestActor } from './native-helpers.js'

const enabled = process.env.PASSBOOK_NATIVE_ACCEPTANCE === '1'
const network = bitcoin.networks.regtest
const psbt = (p: string) => bitcoin.Psbt.fromBase64(p, { network })
async function realPrevout(txid: string, vout: number): Promise<OnchainPrevout> {
  const raw = bitcoin.Transaction.fromHex(await nativeRpc<string>('getrawtransaction', [txid]))
  return { txid, vout, value_sats: raw.outs[vout].value.toString(), script_pubkey: bytesToHex(raw.outs[vout].script) }
}
const chain: NativeJointChain = {
  prevouts: points => Promise.all(points.map(p => realPrevout(p.txid, p.vout))),
  async assertUnspent(points) { for (const p of points) assert.ok(await nativeRpc('gettxout', [p.txid, p.vout, true]), 'real input must still be unspent') },
}
async function receive(actor: NativeTestActor, asset: string | null, amount: string) {
  const r = await actor.owner.call<{ recipient_id: string }>('receive', { asset_id: asset, kind: 'nia', amount, transport_endpoints: [], confirmations: 1 })
  const script = await actor.owner.call<{ script_pubkey: string }>('recipient_script', r)
  return { ...r, ...script }
}
async function copyArtifact(from: NativeTestActor, to: NativeTestActor, digest: string) {
  const a = await from.owner.call<{ hex: string }>('artifact_get', { sha256: digest })
  const b = await to.owner.call<{ sha256: string }>('artifact_put', a)
  assert.equal(b.sha256, digest)
}
const borrowerKey = keyPairFromLabel('g0-borrower'), lenderKey = keyPairFromLabel('g0-lender')
const partySigner = (key: typeof borrowerKey) => ({ publicKey: ecc.pointFromScalar(key.secretKey)!, sign: (hash: Uint8Array) => ecc.sign(hash, key.secretKey), signSchnorr: (hash: Uint8Array) => ecc.signSchnorr(hash, key.secretKey) })

test('native joint preparation: separate owners retain real proofs, exact A/F/D enforcement, joint funding and full-collateral repayment', { skip: !enabled, timeout: 180_000 }, async () => {
  const issuer = await nativeActor('joint-issuer'), borrower = await nativeActor('joint-borrower'), lender = await nativeActor('joint-lender')
  try {
    const terms = jointTerms(); terms.fee = '0'; terms.settlement.debt = terms.principal
    const asset = await issuer.owner.call<{ asset_id: string }>('issue_nia', { ticker: 'JOINT', name: 'Joint native preparation fixture', precision: 6, amount: terms.principal })
    const principal = await nativeTransfer(issuer, lender, asset.asset_id, 'nia', terms.principal, '4242')
    const metadata = await lender.owner.call<{ schema_id: string }>('asset_metadata', { asset_id: asset.asset_id })
    terms.settlement.asset = { kind: 'NIA', contract_id: asset.asset_id, schema_id: metadata.schema_id, precision: 6 }
    const tip = await nativeRpc<number>('getblockcount')
    terms.open_height = tip; terms.maturity_height = tip + 30; terms.recovery_height = tip + 55; terms.oracle_quote.height = tip
    terms.settlement.liquidation.templates[0].lock_height = tip
    const bRecv = await receive(borrower, null, terms.principal)
    const lRecv = await receive(lender, asset.asset_id, terms.settlement.debt)
    const bAddress = await borrower.owner.call<{ address: string }>('address', {}), lAddress = await lender.owner.call<{ address: string }>('address', {})
    terms.settlement.destinations = { borrower_rgb_script_pubkey: bRecv.script_pubkey, lender_rgb_script_pubkey: lRecv.script_pubkey, borrower_btc_script_pubkey: bytesToHex(bitcoin.address.toOutputScript(bAddress.address, network)), lender_btc_script_pubkey: bytesToHex(bitcoin.address.toOutputScript(lAddress.address, network)), borrower_change_script_pubkey: bytesToHex(bitcoin.address.toOutputScript(bAddress.address, network)) }
    const collateral = collateralForTerms(terms)
    const original = psbt((await borrower.owner.call<{ psbt: string }>('prepare_btc', { script_pubkey: collateral.script_pubkey, amount_sats: (BigInt(terms.collateral_sats) + 1000n).toString(), fee_rate: 2 })).psbt)
    const sourceTx = bitcoin.Transaction.fromHex(await nativeRpc<string>('getrawtransaction', [principal.txid]))
    const sourceVout = sourceTx.outs.findIndex(o => o.value === 1000n && !o.script.includes(0x6a))
    // Select the actual allocation outpoint from the settled native wallet, not a script heuristic.
    const unspents = await lender.owner.call<{ utxo: { outpoint: { txid: string; vout: number }; btc_amount: string }; rgb_allocations: { asset_id: string | null; settled: boolean }[] }[]>('unspents', {})
    const source = unspents.find(u => u.rgb_allocations.some(a => a.asset_id === asset.asset_id && a.settled))
    assert.ok(source); assert.ok(sourceVout >= 0)
    const rgb = await realPrevout(source.utxo.outpoint.txid, source.utxo.outpoint.vout)
    const btc = await chain.prevouts(original.txInputs.map(i => ({ txid: bytesToHex(Uint8Array.from(i.hash).reverse()), vout: i.index })))
    const funding = new bitcoin.Psbt({ network }).setVersion(2)
    funding.addInput({ hash: rgb.txid, index: rgb.vout, sequence: 0xfffffffd, witnessUtxo: { script: hexToBytes(rgb.script_pubkey), value: BigInt(rgb.value_sats) } })
    original.txInputs.forEach((input, i) => funding.addInput({ ...original.data.inputs[i], hash: input.hash, index: input.index, sequence: 0xfffffffd }))
    funding.addOutput({ script: hexToBytes('6a'), value: 0n })
    funding.addOutput({ script: hexToBytes(collateral.script_pubkey), value: BigInt(terms.collateral_sats) })
    funding.addOutput({ script: hexToBytes(bRecv.script_pubkey), value: 1000n })
    funding.addOutput({ script: hexToBytes(terms.settlement.destinations.lender_btc_script_pubkey), value: BigInt(rgb.value_sats) })
    funding.addOutput({ script: hexToBytes(terms.settlement.destinations.borrower_change_script_pubkey), value: btc.reduce((n, p) => n + BigInt(p.value_sats), 0n) - BigInt(terms.collateral_sats) - 2500n })
    const intent: OnchainJointIntent = { domain: 'passbook-rgb-joint-intent/v1', action: 'origination', loan_id: onchainLoanId(terms), network: terms.settlement.network, asset: terms.settlement.asset, amount: terms.principal, rgb_input: rgb, borrower_btc_inputs: btc, rgb_output_vout: 2, collateral_output_vout: 1, lender_btc_return_vout: 3, borrower_change_vout: 4 }
    await copyArtifact(issuer, lender, principal.output_history!.sha256); await copyArtifact(issuer, borrower, principal.output_history!.sha256)
    const lPrepare = new NativeJointPreparation(lender.walletId, lender.owner, chain), bPrepare = new NativeJointPreparation(borrower.walletId, borrower.owner, chain)
    const prepared = await lPrepare.prepare({ terms, intent, unsigned_psbt_base64: funding.toBase64(), recipient_id: bRecv.recipient_id, input_history: [principal.output_history!] })
    await copyArtifact(lender, borrower, prepared.proposal.transfer_consignment.sha256)
    await copyArtifact(lender, borrower, prepared.output_history.sha256)
    const independentlyVerified = await bPrepare.verifyProposal(prepared.proposal)
    assert.equal(independentlyVerified.proposal_hash, prepared.proposal_hash)
    // Exact final txid fixes all enforcement before either funding signature leaves.
    const enforcement = enforcementTransactions(terms, prepared.unsigned_txid).map(e => ({ ...e, signed_psbt_base64: psbt(e.unsigned_psbt_base64).signTaprootInput(0, partySigner(borrowerKey)).toBase64() }))
    verifyBorrowerEnforcement(terms, prepared.unsigned_txid, enforcement)
    const signedL = await testExport(lender, prepared.proposal.colored_psbt_base64, 'joint-origination-lender')
    const signedB = await testExport(borrower, signedL.psbt, 'joint-origination-borrower')
    const funded = psbt(signedB.psbt).extractTransaction()
    assert.equal(funded.getId(), prepared.unsigned_txid)
    await lender.owner.call('mark_broadcast', { operation_id: prepared.native_operation_id })
    await nativeRpc('sendrawtransaction', [funded.toHex()]); await nativeMine()
    await lender.owner.call('apply', { operation_id: prepared.native_operation_id })
    await borrower.owner.call('receive_consignment', { sha256: prepared.proposal.transfer_consignment.sha256 })
    await nativeSettled(borrower, asset.asset_id, terms.principal); await nativeSettled(lender, asset.asset_id, '0')

    const repaymentSource = await realPrevout(funded.getId(), 2), c = await realPrevout(funded.getId(), 1)
    const fees = psbt((await borrower.owner.call<{ psbt: string }>('prepare_btc', { script_pubkey: lRecv.script_pubkey, amount_sats: '1000', fee_rate: 2 })).psbt)
    const feeInputs = await chain.prevouts(fees.txInputs.map(i => ({ txid: bytesToHex(Uint8Array.from(i.hash).reverse()), vout: i.index })))
    const repayment = new bitcoin.Psbt({ network }).setVersion(2)
    repayment.addInput({ hash: repaymentSource.txid, index: repaymentSource.vout, sequence: 0xfffffffd, witnessUtxo: { script: hexToBytes(repaymentSource.script_pubkey), value: BigInt(repaymentSource.value_sats) } })
    fees.txInputs.forEach((input, i) => repayment.addInput({ ...fees.data.inputs[i], hash: input.hash, index: input.index, sequence: 0xfffffffd }))
    const cIndex = repayment.inputCount
    repayment.addInput({ hash: c.txid, index: c.vout, sequence: 0xfffffffd, witnessUtxo: { script: hexToBytes(c.script_pubkey), value: BigInt(c.value_sats) }, tapInternalKey: hexToBytes(collateral.internal_key), tapLeafScript: [{ leafVersion: 0xc0, script: hexToBytes(collateral.leaves.A.script), controlBlock: hexToBytes(collateral.leaves.A.control_block) }] })
    repayment.addOutput({ script: hexToBytes('6a'), value: 0n })
    repayment.addOutput({ script: hexToBytes(lRecv.script_pubkey), value: 1000n })
    repayment.addOutput({ script: hexToBytes(terms.settlement.destinations.borrower_btc_script_pubkey), value: BigInt(terms.collateral_sats) })
    repayment.addOutput({ script: hexToBytes(terms.settlement.destinations.borrower_change_script_pubkey), value: feeInputs.reduce((n, p) => n + BigInt(p.value_sats), 0n) + BigInt(repaymentSource.value_sats) - 2500n })
    const repayIntent: OnchainJointIntent = { domain: 'passbook-rgb-joint-intent/v1', action: 'repayment', loan_id: onchainLoanId(terms), network: terms.settlement.network, asset: terms.settlement.asset, amount: terms.settlement.debt, rgb_input: repaymentSource, borrower_btc_inputs: feeInputs, collateral: c, rgb_output_vout: 1, collateral_return_vout: 2, borrower_change_vout: 3 }
    const r = await bPrepare.prepare({ terms, intent: repayIntent, unsigned_psbt_base64: repayment.toBase64(), recipient_id: lRecv.recipient_id, input_history: [prepared.output_history] })
    await copyArtifact(borrower, lender, r.proposal.transfer_consignment.sha256)
    assert.equal((await lPrepare.verifyProposal(r.proposal)).proposal_hash, r.proposal_hash)
    const nativeSigned = await testExport(borrower, r.proposal.colored_psbt_base64, 'joint-repayment-borrower')
    const close = psbt(nativeSigned.psbt).signTaprootInput(cIndex, partySigner(borrowerKey)).signTaprootInput(cIndex, partySigner(lenderKey))
    const sigs = close.data.inputs[cIndex].tapScriptSig!
    close.finalizeInput(cIndex, () => ({ finalScriptWitness: witnessStackToScriptWitness([sigs.find(s => bytesToHex(s.pubkey) === lenderKey.pubkey)!.signature, sigs.find(s => bytesToHex(s.pubkey) === borrowerKey.pubkey)!.signature, hexToBytes(collateral.leaves.A.script), hexToBytes(collateral.leaves.A.control_block)]) }))
    const transaction = close.extractTransaction()
    const [verdict] = await nativeRpc<{ allowed: boolean }[]>('testmempoolaccept', [[transaction.toHex()]])
    assert.equal(verdict.allowed, true)
    await borrower.owner.call('mark_broadcast', { operation_id: r.native_operation_id })
    await nativeRpc('sendrawtransaction', [transaction.toHex()]); await nativeMine()
    await borrower.owner.call('apply', { operation_id: r.native_operation_id })
    await lender.owner.call('receive_consignment', { sha256: r.proposal.transfer_consignment.sha256 })
    await nativeSettled(lender, asset.asset_id, terms.settlement.debt); await nativeSettled(borrower, asset.asset_id, '0')
    assert.equal((await realPrevout(transaction.getId(), 2)).value_sats, terms.collateral_sats)
    assert.equal(await nativeRpc('gettxout', [funded.getId(), 1, true]), null)
  } finally { await issuer.owner.close(); await borrower.owner.close(); await lender.owner.close() }
})
