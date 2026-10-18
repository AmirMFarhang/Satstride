// The collateral escrow: a Taproot output with an unspendable (NUMS) internal
// key and four legacy script leaves (v2 adds repayment leaf E) (handoff section 6), and the PSBT flows that spend
// it. B, L, P are the x-only keys of borrower, lender and platform from the
// loan terms. Each party's same key also controls its plain BTC through a
// BIP-86 key-path output, so a release pays the borrower's own address and the
// next lock spends that output: the passbook chain.
//
//   A  <B> CHECKSIG <L> CHECKSIGADD 2 NUMEQUAL   release on repayment; pre-signed default split
//   B  <L> CHECKSIG <P> CHECKSIGADD 2 NUMEQUAL   liquidation, or default when the borrower is gone
//   C  <B> CHECKSIG <P> CHECKSIGADD 2 NUMEQUAL   refund if never funded; release on proven repayment
//   E  SHA256 <H> EQUALVERIFY <B> CHECKSIG   atomic release with Lightning preimage (v2 only)
//   D  <recovery> CHECKLOCKTIMEVERIFY DROP <B> CHECKSIG   borrower alone after everyone is gone

import { schnorr } from '@noble/curves/secp256k1.js'
import * as bitcoin from 'bitcoinjs-lib'
import type { Taptree } from 'bitcoinjs-lib/src/types'
import { tapleafHash, tapTweakHash } from 'bitcoinjs-lib/src/payments/bip341'
import { witnessStackToScriptWitness } from 'bitcoinjs-lib/src/psbt/psbtutils'
import * as ecc from 'tiny-secp256k1'
import { opReturnScript } from '../chain/types.js'
import { bytesToHex, hexToBytes, sha256Hex, isHex, type Hex } from '../core/crypto.js'
import { microToSats, type Micro, type PriceCents, type Sats } from '../core/money.js'
import { debtOf, termsHash, type LoanTerms } from '../core/terms.js'
import { authorizeSignature, keySignerId, signerGate, type GateToken } from '../wallet/signer.js'

bitcoin.initEccLib(ecc)

const { opcodes } = bitcoin
const LEAF_VERSION = 0xc0
/** BIP-341 NUMS point: no one knows its discrete log, so the key path is unspendable. */
export const NUMS_KEY = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0')
export const NETWORK = bitcoin.networks.regtest
/** Absolute fee per escrow transaction. Regtest relays at 1 sat/vB; these transactions are under 250 vB. */
export const TX_FEE_SATS = 500
/** Sequence that enables nLockTime without signalling RBF. */
const SEQUENCE_LOCKTIME = 0xfffffffe
/** Outputs below this are dropped to fees rather than created. */
const DUST_SATS = 330

export type LegacyLeaf = 'A' | 'B' | 'C' | 'D'
export type Leaf = LegacyLeaf | 'E'
export type Party = 'borrower' | 'lender' | 'platform'

export interface EscrowParties {
  borrower_pk: Hex
  lender_pk: Hex
  platform_pk: Hex
  recovery_height: number
  payment_hash?: Hex
}

export interface TxOut {
  /** scriptPubKey hex */
  script: Hex
  value: Sats
}

export interface Outpoint {
  txid: Hex
  vout: number
  value: Sats
}

/** Who signs each leaf, in script order. */
export const LEAF_SIGNERS: Record<Leaf, Party[]> = {
  A: ['borrower', 'lender'],
  B: ['lender', 'platform'],
  C: ['borrower', 'platform'],
  D: ['borrower'],
  E: ['borrower'],
}

export function partiesOf(terms: LoanTerms): EscrowParties {
  if (terms.v === 2 && !isHex(terms.atomic_repayment?.payment_hash, 32)) throw new Error('v2 terms need an atomic payment hash')
  return { borrower_pk: terms.borrower_pk, lender_pk: terms.lender_pk, platform_pk: terms.platform_pk, recovery_height: terms.recovery_height, ...(terms.v === 2 ? { payment_hash: terms.atomic_repayment?.payment_hash } : {}) }
}

function pk(p: EscrowParties, party: Party): Uint8Array {
  return hexToBytes(party === 'borrower' ? p.borrower_pk : party === 'lender' ? p.lender_pk : p.platform_pk)
}

export function leafScripts(p: EscrowParties): Record<LegacyLeaf, Uint8Array> & { E?: Uint8Array } {
  if (p.payment_hash !== undefined && !isHex(p.payment_hash, 32)) throw new Error('payment_hash must be 32 bytes')
  const twoOfTwo = (a: Party, b: Party) => bitcoin.script.compile([pk(p, a), opcodes.OP_CHECKSIG, pk(p, b), opcodes.OP_CHECKSIGADD, opcodes.OP_2, opcodes.OP_NUMEQUAL])
  return {
    A: twoOfTwo('borrower', 'lender'),
    B: twoOfTwo('lender', 'platform'),
    C: twoOfTwo('borrower', 'platform'),
    D: bitcoin.script.compile([bitcoin.script.number.encode(p.recovery_height), opcodes.OP_CHECKLOCKTIMEVERIFY, opcodes.OP_DROP, pk(p, 'borrower'), opcodes.OP_CHECKSIG]),
    ...(p.payment_hash ? { E: bitcoin.script.compile([opcodes.OP_SHA256, hexToBytes(p.payment_hash), opcodes.OP_EQUALVERIFY, pk(p, 'borrower'), opcodes.OP_CHECKSIG]) } : {}),
  }
}

export interface EscrowLeaf { script: Uint8Array; controlBlock: Uint8Array; leafHash: Uint8Array }

export interface Escrow {
  /** P2TR scriptPubKey hex */
  script: Hex
  address: string
  leaves: Record<LegacyLeaf, EscrowLeaf> & { E?: EscrowLeaf }
}

export function escrowFor(p: EscrowParties): Escrow {
  const scripts = leafScripts(p)
  const legacyTree: Taptree = [[{ output: scripts.A }, { output: scripts.B }], [{ output: scripts.C }, { output: scripts.D }]]
  const scriptTree: Taptree = scripts.E ? [legacyTree, { output: scripts.E }] : legacyTree
  const base = bitcoin.payments.p2tr({ internalPubkey: NUMS_KEY, scriptTree, network: NETWORK })
  const leaves = {} as Escrow['leaves']
  for (const leaf of Object.keys(scripts) as Leaf[]) {
    const pay = bitcoin.payments.p2tr({ internalPubkey: NUMS_KEY, scriptTree, redeem: { output: scripts[leaf]!, redeemVersion: LEAF_VERSION }, network: NETWORK })
    const witness = pay.witness!
    leaves[leaf] = { script: scripts[leaf]!, controlBlock: witness[witness.length - 1], leafHash: tapleafHash({ output: scripts[leaf]!, version: LEAF_VERSION }) }
  }
  return { script: bytesToHex(base.output!), address: base.address!, leaves }
}

// ---- key-path wallet outputs (each party's plain BTC) ----

export function keyPathOutput(xonlyPk: Hex): { script: Hex; address: string } {
  const pay = bitcoin.payments.p2tr({ internalPubkey: hexToBytes(xonlyPk), network: NETWORK })
  return { script: bytesToHex(pay.output!), address: pay.address! }
}

/** Signs BIP-86 key-path spends: the secret tweaked by the BIP-341 tap tweak with no script tree. Refused for a governed key. */
export function keyPathSigner(secretKey: Uint8Array): bitcoin.Signer {
  ungovernedOnly(secretKey)
  return tweakedSigner(secretKey)
}

function tweakedSigner(secretKey: Uint8Array): bitcoin.Signer {
  const tweak = tapTweakHash(schnorr.getPublicKey(secretKey), undefined)
  // tiny-secp256k1 negates the secret when its point has odd Y, as BIP-341 requires
  const evenSecret = ecc.pointFromScalar(secretKey)![0] === 3 ? ecc.privateNegate(secretKey) : secretKey
  const tweaked = ecc.privateAdd(evenSecret, tweak)
  if (!tweaked) throw new Error('invalid tweak')
  return signerFor(tweaked)
}

/** Signs script-path spends with the untweaked key. Refused for a governed key: use signLeaf with a gate token. */
export function leafSigner(secretKey: Uint8Array): bitcoin.Signer {
  ungovernedOnly(secretKey)
  return signerFor(secretKey)
}

/** A raw signer would sign any sighash; a key under a policy gate signs only through signLeaf / signKeyPath. */
function ungovernedOnly(secretKey: Uint8Array): void {
  if (signerGate(keySignerId(bytesToHex(schnorr.getPublicKey(secretKey))))) throw new Error('this key is governed by a policy gate: sign through signLeaf or signKeyPath with a gate token')
}

function signerFor(secret: Uint8Array): bitcoin.Signer {
  return {
    publicKey: schnorr.getPublicKey(secret),
    sign: () => {
      throw new Error('ECDSA not used')
    },
    signSchnorr: (hash: Uint8Array) => schnorr.sign(hash, secret),
  }
}

// ---- what you see is what you sign ----

export interface PsbtSummary {
  kind: 'bitcoin-psbt'
  network: 'regtest'
  /** The unsigned txid: commits to version, inputs, sequences, outputs and locktime. */
  txid: Hex
  version: number
  locktime: number
  inputs: { txid: Hex; vout: number; sequence: number; value: Sats | null; script: Hex | null; spend: 'key-path' | 'script-path' | 'unknown' }[]
  outputs: { script: Hex; value: Sats; address: string | null; op_return: Hex | null }[]
  /** Inputs minus outputs, when every input carries its value. */
  fee: Sats | null
  /** What this signature commits to: a key-path spend of the signer's own outputs, or one escrow leaf. */
  signing: { mode: 'key-path' } | { mode: 'escrow-leaf'; leaf: Leaf; escrow_script: Hex; leaf_hash: Hex }
}

/**
 * Decode a PSBT into the summary a human approves and a gate token binds.
 * Signatures already on the PSBT are left out, so a co-signer approves the
 * same summary the first signer did.
 */
export function psbtSummary(psbt: bitcoin.Psbt, signing?: { parties: EscrowParties; leaf: Leaf }): PsbtSummary {
  const inputs = psbt.txInputs.map((i, n) => {
    const data = psbt.data.inputs[n]
    const spend: PsbtSummary['inputs'][number]['spend'] = data.tapLeafScript?.length ? 'script-path' : data.tapInternalKey ? 'key-path' : 'unknown'
    return { txid: bytesToHex(Uint8Array.from(i.hash).reverse()), vout: i.index, sequence: i.sequence ?? 0xffffffff, value: data.witnessUtxo ? Number(data.witnessUtxo.value) : null, script: data.witnessUtxo ? bytesToHex(data.witnessUtxo.script) : null, spend }
  })
  const outputs = psbt.txOutputs.map((o) => {
    const script = bytesToHex(o.script)
    let address: string | null = null
    try { address = bitcoin.address.fromOutputScript(o.script, NETWORK) } catch { /* OP_RETURN and non-standard scripts have no address */ }
    return { script, value: Number(o.value), address, op_return: opReturnData(script) }
  })
  const inSum = inputs.every((i) => i.value !== null) ? inputs.reduce((s, i) => s + (i.value ?? 0), 0) : null
  let mode: PsbtSummary['signing'] = { mode: 'key-path' }
  if (signing) {
    const escrow = escrowFor(signing.parties)
    const leaf = escrow.leaves[signing.leaf]
    if (!leaf) throw new Error(`leaf ${signing.leaf} is not enabled for this escrow`)
    mode = { mode: 'escrow-leaf', leaf: signing.leaf, escrow_script: escrow.script, leaf_hash: bytesToHex(leaf.leafHash) }
  }
  return { kind: 'bitcoin-psbt', network: 'regtest', txid: unsignedTxid(psbt), version: psbt.version, locktime: psbt.locktime, inputs, outputs, fee: inSum === null ? null : inSum - outputs.reduce((s, o) => s + o.value, 0), signing: mode }
}

function opReturnData(script: Hex): Hex | null {
  // OP_RETURN, push of 1..75 bytes
  if (!script.startsWith('6a') || script.length < 6) return null
  const len = parseInt(script.slice(2, 4), 16)
  return len >= 1 && len <= 75 && script.length === 4 + len * 2 ? script.slice(4) : null
}

// ---- lock ----

export interface KeyPathUtxo extends Outpoint {
  /** x-only internal key of the BIP-86 output being spent */
  internal_pk: Hex
}

/**
 * Lock: spend the borrower's key-path outputs (the previous release for a later
 * loan) into [escrow collateral, OP_RETURN termsHash, change]. Unsigned.
 */
export function buildLock(opts: { inputs: KeyPathUtxo[]; terms: LoanTerms; changeScript: Hex; fee?: Sats }): bitcoin.Psbt {
  const { inputs, terms } = opts
  const fee = opts.fee ?? TX_FEE_SATS
  const total = inputs.reduce((s, u) => s + u.value, 0)
  const change = total - terms.collateral_sats - fee
  if (change < 0) throw new Error(`inputs carry ${total} sats, lock needs ${terms.collateral_sats + fee}`)
  const psbt = new bitcoin.Psbt({ network: NETWORK })
  for (const u of inputs) {
    const internal = hexToBytes(u.internal_pk)
    psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: hexToBytes(keyPathOutput(u.internal_pk).script), value: BigInt(u.value) }, tapInternalKey: internal })
  }
  psbt.addOutput({ script: hexToBytes(escrowFor(partiesOf(terms)).script), value: BigInt(terms.collateral_sats) })
  psbt.addOutput({ script: hexToBytes(opReturnScript(termsHash(terms))), value: 0n })
  if (change >= DUST_SATS) psbt.addOutput({ script: hexToBytes(opts.changeScript), value: BigInt(change) })
  return psbt
}

/**
 * Sign every input of a PSBT that is a key-path output of this key. A key under
 * a policy gate needs the gate's token for exactly this decoded transaction.
 */
export function signKeyPath(psbt: bitcoin.Psbt, secretKey: Uint8Array, token?: GateToken): bitcoin.Psbt {
  const xonly = bytesToHex(schnorr.getPublicKey(secretKey))
  const ticket = authorizeSignature(keySignerId(xonly), psbtSummary(psbt), token)
  const signer = tweakedSigner(secretKey)
  try {
    psbt.data.inputs.forEach((input, i) => {
      if (input.tapInternalKey && bytesToHex(input.tapInternalKey) === xonly) psbt.signTaprootInput(i, signer)
    })
  } catch (err) { ticket.failed(err); throw err }
  ticket.signed()
  return psbt
}

// ---- escrow spends ----

/**
 * A spend of the escrow output through one leaf. `locktime` is nLockTime (the
 * split's maturity + grace, leaf D's recovery height); the input then signals it.
 */
export function buildEscrowSpend(opts: { escrow: Outpoint; parties: EscrowParties; leaf: Leaf; outputs: TxOut[]; locktime?: number }): bitcoin.Psbt {
  const e = escrowFor(opts.parties)
  const leaf = e.leaves[opts.leaf]
  if (!leaf) throw new Error(`leaf ${opts.leaf} is not enabled for this escrow`)
  const locktime = opts.leaf === 'D' ? Math.max(opts.locktime ?? 0, opts.parties.recovery_height) : (opts.locktime ?? 0)
  const psbt = new bitcoin.Psbt({ network: NETWORK })
  psbt.setLocktime(locktime)
  psbt.addInput({
    hash: opts.escrow.txid,
    index: opts.escrow.vout,
    sequence: SEQUENCE_LOCKTIME,
    witnessUtxo: { script: hexToBytes(e.script), value: BigInt(opts.escrow.value) },
    tapLeafScript: [{ leafVersion: LEAF_VERSION, script: leaf.script, controlBlock: leaf.controlBlock }],
  })
  for (const o of opts.outputs) psbt.addOutput({ script: hexToBytes(o.script), value: BigInt(o.value) })
  return psbt
}

/**
 * Add one party's signature for a leaf. Throws if the key is not in that leaf,
 * and, for a key under a policy gate, without the gate's token for exactly this
 * decoded transaction and leaf.
 */
export function signLeaf(psbt: bitcoin.Psbt, parties: EscrowParties, leaf: Leaf, secretKey: Uint8Array, token?: GateToken): bitcoin.Psbt {
  const xonly = bytesToHex(schnorr.getPublicKey(secretKey))
  if (!LEAF_SIGNERS[leaf].some((party) => bytesToHex(pk(parties, party)) === xonly)) throw new Error(`key ${xonly.slice(0, 12)} is not a signer of leaf ${leaf}`)
  const ticket = authorizeSignature(keySignerId(xonly), psbtSummary(psbt, { parties, leaf }), token)
  try { psbt.signTaprootInput(0, signerFor(secretKey), requiredLeaf(parties, leaf).leafHash) } catch (err) { ticket.failed(err); throw err }
  ticket.signed()
  return psbt
}

/** The signature a party added for a leaf, as hex, or null. */
export function leafSignature(psbt: bitcoin.Psbt, parties: EscrowParties, leaf: Leaf, party: Party): Hex | null {
  const leafHash = requiredLeaf(parties, leaf).leafHash
  const key = pk(parties, party)
  const sig = psbt.data.inputs[0].tapScriptSig?.find((s) => bytesToHex(s.pubkey) === bytesToHex(key) && bytesToHex(s.leafHash) === bytesToHex(leafHash))
  return sig ? bytesToHex(sig.signature) : null
}

/** Finalize the escrow input for a leaf; every signer of that leaf must have signed. */
export function finalizeEscrowSpend(psbt: bitcoin.Psbt, parties: EscrowParties, leaf: Leaf, preimage?: Hex): bitcoin.Psbt {
  if (leaf === 'E' && (!preimage || !isHex(preimage, 32) || sha256Hex(hexToBytes(preimage)) !== parties.payment_hash)) throw new Error('leaf E needs the matching 32-byte preimage')
  const sigs = LEAF_SIGNERS[leaf].map((party) => {
    const sig = leafSignature(psbt, parties, leaf, party)
    if (!sig) throw new Error(`leaf ${leaf} is missing the ${party} signature`)
    return hexToBytes(sig)
  })
  const l = requiredLeaf(parties, leaf)
  psbt.finalizeInput(0, () => ({
    // the script consumes the first key's signature first, so it sits on top of the stack
    finalScriptWitness: witnessStackToScriptWitness([...sigs.reverse(), ...(leaf === 'E' ? [hexToBytes(preimage!)] : []), l.script, l.controlBlock]),
  }))
  return psbt
}

function requiredLeaf(parties: EscrowParties, leaf: Leaf): EscrowLeaf {
  const l = escrowFor(parties).leaves[leaf]
  if (!l) throw new Error(`leaf ${leaf} is not enabled for this escrow`)
  return l
}

/** The txid a PSBT will have once signed: segwit txids do not cover witnesses. */
export function unsignedTxid(psbt: bitcoin.Psbt): Hex {
  const tx = new bitcoin.Transaction()
  tx.version = psbt.version
  tx.locktime = psbt.locktime
  for (const i of psbt.txInputs) tx.addInput(i.hash, i.index, i.sequence)
  for (const o of psbt.txOutputs) tx.addOutput(o.script, o.value)
  return tx.getId()
}

export function extractHex(psbt: bitcoin.Psbt): Hex {
  return psbt.extractTransaction().toHex()
}

export function psbtFromBase64(b64: string): bitcoin.Psbt {
  return bitcoin.Psbt.fromBase64(b64, { network: NETWORK })
}

/** Inputs and outputs of an unsigned PSBT, for a counterparty to check before signing. */
export function describe(psbt: bitcoin.Psbt): { txid: Hex; locktime: number; inputs: { txid: Hex; vout: number }[]; outputs: TxOut[] } {
  return {
    txid: unsignedTxid(psbt),
    locktime: psbt.locktime,
    inputs: psbt.txInputs.map((i) => ({ txid: bytesToHex(Uint8Array.from(i.hash).reverse()), vout: i.index })),
    outputs: psbt.txOutputs.map((o) => ({ script: bytesToHex(o.script), value: Number(o.value) })),
  }
}

// ---- the outputs each path pays ----

function twoWay(collateral: Sats, toLender: Sats, lenderScript: Hex, borrowerScript: Hex, fee: Sats): TxOut[] {
  const available = collateral - fee
  const lender = Math.min(toLender, available)
  const borrower = available - lender
  const outs: TxOut[] = [{ script: lenderScript, value: lender }]
  if (borrower >= DUST_SATS) outs.push({ script: borrowerScript, value: borrower })
  return outs
}

/** Release (leaf A) or a refund (leaf C): everything back to the borrower minus the fee. */
export function releaseOutputs(terms: LoanTerms, fee = TX_FEE_SATS): TxOut[] {
  return [{ script: keyPathOutput(terms.borrower_pk).script, value: terms.collateral_sats - fee }]
}

/** Pre-signed default split (leaf A, nLockTime maturity + grace): the debt at the opening price to the lender, the rest back. */
export function splitOutputs(terms: LoanTerms, fee = TX_FEE_SATS): TxOut[] {
  const owed = microToSats(debtOf(terms), terms.oracle_quote.price_cents)
  return twoWay(terms.collateral_sats, owed, keyPathOutput(terms.lender_pk).script, keyPathOutput(terms.borrower_pk).script, fee)
}

export function splitLocktime(terms: LoanTerms): number {
  return terms.maturity_height + terms.grace_blocks
}

/**
 * Liquidation (leaf B): exactly the debt at the current price to the lender, the rest
 * to the borrower, on every terms version. No penalty: the only cost is the mining fee.
 * The platform's share of the interest is invoiced to the lender after close, never paid here.
 */
export function liquidationOutputs(terms: LoanTerms, priceCents: PriceCents, fee = TX_FEE_SATS): TxOut[] {
  const debt: Micro = debtOf(terms)
  const owed = microToSats(debt, priceCents)
  return twoWay(terms.collateral_sats, owed, keyPathOutput(terms.lender_pk).script, keyPathOutput(terms.borrower_pk).script, fee)
}

/** Check a party's leaf signature on input 0 against the BIP-341 sighash; true only if present and valid. */
export function verifyLeafSignature(psbt: bitcoin.Psbt, parties: EscrowParties, leaf: Leaf, party: Party): boolean {
  if (!leafSignature(psbt, parties, leaf, party)) return false
  const key = pk(parties, party)
  try {
    return psbt.validateSignaturesOfInput(0, (pubkey, msghash, signature) => schnorr.verify(signature, msghash, pubkey), key)
  } catch {
    return false
  }
}

/** Add a counterparty's leaf signature that arrived as hex (a 7473 message). */
export function addLeafSignature(psbt: bitcoin.Psbt, parties: EscrowParties, leaf: Leaf, party: Party, signatureHex: Hex): bitcoin.Psbt {
  psbt.updateInput(0, { tapScriptSig: [{ pubkey: pk(parties, party), leafHash: requiredLeaf(parties, leaf).leafHash, signature: hexToBytes(signatureHex) }] })
  if (!verifyLeafSignature(psbt, parties, leaf, party)) throw new Error(`the ${party} signature for leaf ${leaf} does not verify`)
  return psbt
}
