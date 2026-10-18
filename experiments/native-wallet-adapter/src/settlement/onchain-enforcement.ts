import * as bitcoin from 'bitcoinjs-lib'
import { tapleafHash } from 'bitcoinjs-lib/src/payments/bip341'
import * as ecc from 'tiny-secp256k1'
import { bytesToHex, hexToBytes } from '../core/crypto.js'
import { enforcementTransactions } from './onchain-transaction-policy.js'
import type { OnchainLoanTermsV3, OnchainSignedEnforcement } from './onchain-v3-contract.js'

/** The lender verifies Bitcoin signatures itself. A borrower gate token or
 * caller-provided accepted flag cannot authorize origination funding. */
export function verifyBorrowerEnforcement(terms: OnchainLoanTermsV3, finalFundingTxid: string, received: OnchainSignedEnforcement[]): void {
  const expected = enforcementTransactions(terms, finalFundingTxid)
  if (!Array.isArray(received) || received.length !== expected.length) throw new Error('ENFORCEMENT_COMPLETE_SET_REQUIRED')
  const identity = (e: Pick<OnchainSignedEnforcement, 'kind' | 'template_id'>) => `${e.kind}:${e.template_id ?? '-'}`
  const seen = new Set<string>()
  for (const spend of received) {
    const id = identity(spend), match = expected.find(e => identity(e) === id)
    if (!match || seen.has(id)) throw new Error('ENFORCEMENT_WRONG_OR_DUPLICATE_TEMPLATE')
    seen.add(id)
    const canonical = bitcoin.Psbt.fromBase64(match.unsigned_psbt_base64, { network: bitcoin.networks.regtest })
    const signed = bitcoin.Psbt.fromBase64(spend.signed_psbt_base64, { network: bitcoin.networks.regtest })
    if (bytesToHex(canonical.data.globalMap.unsignedTx.toBuffer()) !== bytesToHex(signed.data.globalMap.unsignedTx.toBuffer())) throw new Error('ENFORCEMENT_TRANSACTION_CHANGED')
    const a = signed.data.inputs[0], b = canonical.data.inputs[0]
    if (!a.witnessUtxo || !b.witnessUtxo || a.witnessUtxo.value !== b.witnessUtxo.value || bytesToHex(a.witnessUtxo.script) !== bytesToHex(b.witnessUtxo.script) || a.tapLeafScript?.length !== 1 || bytesToHex(a.tapLeafScript[0].script) !== bytesToHex(b.tapLeafScript![0].script) || bytesToHex(a.tapLeafScript[0].controlBlock) !== bytesToHex(b.tapLeafScript![0].controlBlock) || a.tapLeafScript[0].leafVersion !== 0xc0 || a.finalScriptWitness || a.finalScriptSig || a.tapKeySig || a.partialSig?.length) throw new Error('ENFORCEMENT_NOT_CANONICAL_AFD_PSBT')
    if (a.sighashType !== undefined && a.sighashType !== 0 && a.sighashType !== 1) throw new Error('ENFORCEMENT_WEAK_SIGHASH')
    const leaf = tapleafHash({ output: b.tapLeafScript![0].script, version: 0xc0 })
    const signatures = a.tapScriptSig?.filter(s => bytesToHex(s.pubkey) === terms.borrower_pk && bytesToHex(s.leafHash) === bytesToHex(leaf)) ?? []
    if (signatures.length !== 1 || ![64, 65].includes(signatures[0].signature.length) || (signatures[0].signature.length === 65 && signatures[0].signature[64] !== 1)) throw new Error('ENFORCEMENT_BORROWER_WHOLE_TRANSACTION_SIGNATURE_REQUIRED')
    if (!signed.validateSignaturesOfInput(0, (pk, hash, sig) => ecc.verifySchnorr(hash, pk, sig), hexToBytes(terms.borrower_pk))) throw new Error('ENFORCEMENT_BORROWER_SIGNATURE_INVALID')
  }
}
