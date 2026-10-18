// Pure script derivation, never registered in the live escrow or check service.
import * as bitcoin from 'bitcoinjs-lib'
import type { Taptree } from 'bitcoinjs-lib/src/types'
import { tapleafHash } from 'bitcoinjs-lib/src/payments/bip341'
import * as ecc from 'tiny-secp256k1'
import { bytesToHex, hexToBytes, isHex, type Hex } from '../core/crypto.js'
import { CHECK_NUMS_KEY } from './onchain-check-contract.js'
bitcoin.initEccLib(ecc)

export interface CheckHtlcParameters {
  quote_hash: Hex
  key_hash: Hex
  payer_pk: Hex
  operator_pk: Hex
  refund_height: number
}

/** CLTV enables refund but does not expire claim. The cutoff is local policy. */
export function checkHtlcFor(p: CheckHtlcParameters) {
  for (const hash of [p.quote_hash, p.key_hash]) if (!isHex(hash, 32)) throw new TypeError('CHECK_HTLC_HASH32_REQUIRED')
  for (const key of [p.payer_pk, p.operator_pk]) {
    if (!isHex(key, 32) || !ecc.isXOnlyPoint(hexToBytes(key))) throw new TypeError('CHECK_HTLC_PARTY_POINT_REQUIRED')
  }
  if (p.payer_pk === p.operator_pk) throw new TypeError('CHECK_HTLC_DISTINCT_PARTIES_REQUIRED')
  if (!Number.isInteger(p.refund_height) || p.refund_height < 1 || p.refund_height >= 500_000_000) throw new TypeError('CHECK_HTLC_BLOCK_HEIGHT_REQUIRED')
  const op = bitcoin.opcodes
  const claim = bitcoin.script.compile([
    hexToBytes(p.quote_hash), op.OP_DROP,
    op.OP_SIZE, bitcoin.script.number.encode(32), op.OP_EQUALVERIFY,
    op.OP_SHA256, hexToBytes(p.key_hash), op.OP_EQUALVERIFY,
    hexToBytes(p.operator_pk), op.OP_CHECKSIG,
  ])
  const refund = bitcoin.script.compile([
    hexToBytes(p.quote_hash), op.OP_DROP,
    bitcoin.script.number.encode(p.refund_height), op.OP_CHECKLOCKTIMEVERIFY, op.OP_DROP,
    hexToBytes(p.payer_pk), op.OP_CHECKSIG,
  ])
  const scriptTree: Taptree = [{ output: claim, version: 0xc0 }, { output: refund, version: 0xc0 }]
  const internalPubkey = hexToBytes(CHECK_NUMS_KEY)
  const base = bitcoin.payments.p2tr({ internalPubkey, scriptTree, network: bitcoin.networks.regtest })
  function leaf(script: Uint8Array) {
    const pay = bitcoin.payments.p2tr({ internalPubkey, scriptTree, redeem: { output: script, redeemVersion: 0xc0 }, network: bitcoin.networks.regtest })
    return { script: bytesToHex(script), leaf_hash: bytesToHex(tapleafHash({ output: script, version: 0xc0 })), control_block: bytesToHex(pay.witness!.at(-1)!) }
  }
  return {
    template: 'check-sha256-size32-quote/v1' as const,
    internal_key: CHECK_NUMS_KEY, leaf_version: 0xc0,
    script_pubkey: bytesToHex(base.output!), merkle_root: bytesToHex(base.hash!),
    claim: leaf(claim), refund: leaf(refund),
  }
}
