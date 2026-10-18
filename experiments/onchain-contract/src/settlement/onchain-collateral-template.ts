// Pure derivation only. These leaves are not registered in the live escrow path.
import * as bitcoin from 'bitcoinjs-lib'
import type { Taptree } from 'bitcoinjs-lib/src/types'
import { tapleafHash } from 'bitcoinjs-lib/src/payments/bip341'
import * as ecc from 'tiny-secp256k1'
import { bytesToHex, hexToBytes, type Hex } from '../core/crypto.js'
import { ONCHAIN_NUMS_KEY } from './onchain-v3-contract.js'
bitcoin.initEccLib(ecc)

export interface OnchainCollateralParameters { loan_id: Hex; borrower_pk: Hex; lender_pk: Hex; platform_pk: Hex; recovery_height: number }
export function onchainCollateralFor(p: OnchainCollateralParameters) {
  if (!/^[0-9a-f]{64}$/.test(p.loan_id)) throw new TypeError('loan_id: 32-byte hex required')
  for (const key of [p.borrower_pk, p.lender_pk, p.platform_pk]) {
    if (!/^[0-9a-f]{64}$/.test(key) || !ecc.isXOnlyPoint(hexToBytes(key))) throw new TypeError('valid x-only party point required')
  }
  if (new Set([p.borrower_pk, p.lender_pk, p.platform_pk]).size !== 3) throw new TypeError('distinct party keys required')
  if (!Number.isInteger(p.recovery_height) || p.recovery_height < 1 || p.recovery_height >= 500_000_000) throw new TypeError('recovery block height required')
  const o = bitcoin.opcodes, b = hexToBytes(p.borrower_pk), l = hexToBytes(p.lender_pk), platform = hexToBytes(p.platform_pk)
  const scripts = {
    A: bitcoin.script.compile([hexToBytes(p.loan_id), o.OP_DROP, b, o.OP_CHECKSIG, l, o.OP_CHECKSIGADD, o.OP_2, o.OP_NUMEQUAL]),
    F: bitcoin.script.compile([b, o.OP_CHECKSIG, l, o.OP_CHECKSIGADD, platform, o.OP_CHECKSIGADD, o.OP_3, o.OP_NUMEQUAL]),
    D: bitcoin.script.compile([bitcoin.script.number.encode(p.recovery_height), o.OP_CHECKLOCKTIMEVERIFY, o.OP_DROP, b, o.OP_CHECKSIG]),
  }
  const scriptTree: Taptree = [{ output: scripts.A, version: 0xc0 }, [{ output: scripts.F, version: 0xc0 }, { output: scripts.D, version: 0xc0 }]]
  const internalPubkey = hexToBytes(ONCHAIN_NUMS_KEY)
  const base = bitcoin.payments.p2tr({ internalPubkey, scriptTree, network: bitcoin.networks.regtest })
  const leaves = {} as Record<keyof typeof scripts, { script: Hex; leaf_hash: Hex; control_block: Hex }>
  for (const name of ['A', 'F', 'D'] as const) {
    const pay = bitcoin.payments.p2tr({ internalPubkey, scriptTree, redeem: { output: scripts[name], redeemVersion: 0xc0 }, network: bitcoin.networks.regtest })
    leaves[name] = { script: bytesToHex(scripts[name]), leaf_hash: bytesToHex(tapleafHash({ output: scripts[name], version: 0xc0 })), control_block: bytesToHex(pay.witness!.at(-1)!) }
  }
  return { template: 'joint-afd-terms/v1' as const, leaf_version: 0xc0, internal_key: ONCHAIN_NUMS_KEY, script_pubkey: bytesToHex(base.output!), merkle_root: bytesToHex(base.hash!), leaves }
}
