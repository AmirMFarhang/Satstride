import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'
import { keyPairFromLabel } from '../src/core/crypto.js'
import { verifyBorrowerEnforcement } from '../src/settlement/onchain-enforcement.js'
import { enforcementTransactions } from '../src/settlement/onchain-transaction-policy.js'
import { jointTerms } from './onchain-fixtures.js'

const key = keyPairFromLabel('g0-borrower')
const signer = { publicKey: ecc.pointFromScalar(key.secretKey)!, sign: (hash: Uint8Array) => ecc.sign(hash, key.secretKey), signSchnorr: (hash: Uint8Array) => ecc.signSchnorr(hash, key.secretKey) }
test('lender verifies the entire exact pre-signed default/liquidation set before funding', () => {
  const t = jointTerms(), txid = 'dd'.repeat(32)
  const set = enforcementTransactions(t, txid).map(e => {
    const psbt = bitcoin.Psbt.fromBase64(e.unsigned_psbt_base64, { network: bitcoin.networks.regtest })
    psbt.signTaprootInput(0, signer)
    return { kind: e.kind, template_id: e.template_id, signed_psbt_base64: psbt.toBase64() }
  })
  verifyBorrowerEnforcement(t, txid, set)
  assert.throws(() => verifyBorrowerEnforcement(t, txid, set.slice(0, 1)), /COMPLETE_SET/)
  assert.throws(() => verifyBorrowerEnforcement(t, 'ee'.repeat(32), set), /TRANSACTION_CHANGED/)
  assert.throws(() => verifyBorrowerEnforcement(t, txid, [set[0], set[0]]), /DUPLICATE/)
  const broken = structuredClone(set), psbt = bitcoin.Psbt.fromBase64(broken[1].signed_psbt_base64, { network: bitcoin.networks.regtest })
  psbt.data.inputs[0].tapScriptSig![0].signature[4] ^= 1
  broken[1].signed_psbt_base64 = psbt.toBase64()
  assert.throws(() => verifyBorrowerEnforcement(t, txid, broken), /SIGNATURE_INVALID/)
})
