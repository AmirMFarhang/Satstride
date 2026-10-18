import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { schnorr } from '@noble/curves/secp256k1.js'
import { tapleafHash } from 'bitcoinjs-lib/src/payments/bip341'
import { bytesToHex, keyPairFromLabel, randomHex, sha256Hex, hexToBytes } from '../src/core/crypto.js'
import { microToSats } from '../src/core/money.js'
import type { LoanTerms } from '../src/core/terms.js'
import {
  addLeafSignature,
  buildEscrowSpend,
  describe as describePsbt,
  escrowFor,
  finalizeEscrowSpend,
  keyPathOutput,
  leafScripts,
  leafSignature,
  liquidationOutputs,
  partiesOf,
  releaseOutputs,
  signLeaf,
  splitLocktime,
  splitOutputs,
  TX_FEE_SATS,
  unsignedTxid,
  verifyLeafSignature,
} from '../src/escrow/escrow.js'
import { Oracle } from '../src/oracle/oracle.js'

const B = keyPairFromLabel('borrower')
const L = keyPairFromLabel('lender')
const P = keyPairFromLabel('platform')
const terms: LoanTerms = {
  v: 1,
  borrower_pk: B.pubkey,
  lender_pk: L.pubkey,
  platform_pk: P.pubkey,
  asset_id: 'rgb:test',
  principal: 600_000_000,
  fee: 6_000_000,
  collateral_sats: 2_000_000,
  oracle_quote: new Oracle(P, 10_000_000).quote(100),
  open_height: 100,
  maturity_height: 130,
  grace_blocks: 5,
  recovery_height: 155,
  ladder_step: 0,
  ltv_bps: 3030,
  prev_passbook_txid: null,
  nonce: randomHex(32),
}
const parties = partiesOf(terms)
const escrowOut = { txid: 'aa'.repeat(32), vout: 0, value: terms.collateral_sats }

describe('escrow scripts and spends', () => {
  it('builds the four leaves of the handoff', () => {
    const s = leafScripts(parties)
    assert.equal(bitcoin.script.toASM(s.A), `${B.pubkey} OP_CHECKSIG ${L.pubkey} OP_CHECKSIGADD OP_2 OP_NUMEQUAL`)
    assert.equal(bitcoin.script.toASM(s.B), `${L.pubkey} OP_CHECKSIG ${P.pubkey} OP_CHECKSIGADD OP_2 OP_NUMEQUAL`)
    assert.equal(bitcoin.script.toASM(s.C), `${B.pubkey} OP_CHECKSIG ${P.pubkey} OP_CHECKSIGADD OP_2 OP_NUMEQUAL`)
    // bitcoinjs prints OP_CHECKLOCKTIMEVERIFY (0xb1) by its old name
    assert.equal(s.D[3], bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY)
    assert.equal(bitcoin.script.toASM(s.D), `9b00 OP_NOP2 OP_DROP ${B.pubkey} OP_CHECKSIG`)
    assert.match(escrowFor(parties).address, /^bcrt1p/)
  })

  it('orders the witness so the first key in the script checks the first signature', () => {
    const psbt = buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'A', outputs: releaseOutputs(terms) })
    const txid = unsignedTxid(psbt)
    signLeaf(psbt, parties, 'A', L.secretKey)
    signLeaf(psbt, parties, 'A', B.secretKey)
    finalizeEscrowSpend(psbt, parties, 'A')
    const tx = psbt.extractTransaction()
    assert.equal(tx.getId(), txid)
    const [sigL, sigB, script] = tx.ins[0].witness
    assert.equal(bytesToHex(script), bytesToHex(leafScripts(parties).A))
    const e = escrowFor(parties)
    const hash = tx.hashForWitnessV1(0, [Uint8Array.from(Buffer.from(e.script, 'hex'))], [BigInt(escrowOut.value)], bitcoin.Transaction.SIGHASH_DEFAULT, tapleafHash({ output: script, version: 0xc0 }))
    assert.ok(schnorr.verify(sigB, hash, Buffer.from(B.pubkey, 'hex')), 'top of stack is the borrower signature')
    assert.ok(schnorr.verify(sigL, hash, Buffer.from(L.pubkey, 'hex')))
  })

  it('pays the default split at the opening price and signals its locktime', () => {
    const psbt = buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'A', outputs: splitOutputs(terms), locktime: splitLocktime(terms) })
    const d = describePsbt(psbt)
    assert.equal(d.locktime, 135)
    assert.equal(psbt.txInputs[0].sequence, 0xfffffffe)
    const owed = microToSats(606_000_000, 10_000_000)
    assert.deepEqual(d.outputs, [
      { script: keyPathOutput(L.pubkey).script, value: owed },
      { script: keyPathOutput(B.pubkey).script, value: 2_000_000 - TX_FEE_SATS - owed },
    ])
    assert.deepEqual(d.inputs, [{ txid: escrowOut.txid, vout: 0 }])
  })

  it('caps a liquidation at the collateral when the price has collapsed', () => {
    const outs = liquidationOutputs(terms, 1_000_000)
    assert.deepEqual(outs, [{ script: keyPathOutput(L.pubkey).script, value: 2_000_000 - TX_FEE_SATS }])
  })

  it('sets leaf D locktime to the recovery height', () => {
    const psbt = buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'D', outputs: releaseOutputs(terms) })
    assert.equal(psbt.locktime, 155)
  })

  it('verifies a counterparty leaf signature and rejects a forged one', () => {
    const mine = buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'A', outputs: releaseOutputs(terms) })
    signLeaf(mine, parties, 'A', B.secretKey)
    assert.ok(verifyLeafSignature(mine, parties, 'A', 'borrower'))
    assert.ok(!verifyLeafSignature(mine, parties, 'A', 'lender'), 'absent')
    const theirs = buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'A', outputs: releaseOutputs(terms) })
    signLeaf(theirs, parties, 'A', L.secretKey)
    addLeafSignature(mine, parties, 'A', 'lender', leafSignature(theirs, parties, 'A', 'lender')!)
    finalizeEscrowSpend(mine, parties, 'A')
    // a lender signature over a different transaction does not verify here
    const other = buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'A', outputs: splitOutputs(terms), locktime: splitLocktime(terms) })
    signLeaf(other, parties, 'A', L.secretKey)
    const fresh = buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'A', outputs: releaseOutputs(terms) })
    assert.throws(() => addLeafSignature(fresh, parties, 'A', 'lender', leafSignature(other, parties, 'A', 'lender')!), /does not verify/)
  })
})


describe('atomic escrow leaf E', () => {
  const preimage = '42'.repeat(32)
  const atomicParties = { ...parties, payment_hash: sha256Hex(hexToBytes(preimage)) }
  it('adds SHA256 hashlock plus borrower signature without changing legacy trees', () => {
    assert.equal(escrowFor(parties).leaves.E, undefined)
    assert.notEqual(escrowFor(parties).script, escrowFor(atomicParties).script)
    assert.equal(bitcoin.script.toASM(leafScripts(atomicParties).E!), `OP_SHA256 ${atomicParties.payment_hash} OP_EQUALVERIFY ${B.pubkey} OP_CHECKSIG`)
    assert.throws(() => buildEscrowSpend({ escrow: escrowOut, parties, leaf: 'E', outputs: releaseOutputs(terms) }), /not enabled/)
  })
  it('requires the matching preimage and borrower key and writes [sig,r] to the witness', () => {
    const psbt = buildEscrowSpend({ escrow: escrowOut, parties: atomicParties, leaf: 'E', outputs: releaseOutputs(terms) })
    assert.throws(() => signLeaf(psbt, atomicParties, 'E', L.secretKey), /not a signer/)
    assert.throws(() => finalizeEscrowSpend(psbt, atomicParties, 'E', '43'.repeat(32)), /matching 32-byte preimage/)
    assert.throws(() => finalizeEscrowSpend(psbt, atomicParties, 'E', preimage), /missing the borrower signature/)
    signLeaf(psbt, atomicParties, 'E', B.secretKey)
    finalizeEscrowSpend(psbt, atomicParties, 'E', preimage)
    const tx = psbt.extractTransaction()
    const [sig, r, script, control] = tx.ins[0].witness
    assert.equal(bytesToHex(r), preimage)
    assert.equal(bytesToHex(control), bytesToHex(escrowFor(atomicParties).leaves.E!.controlBlock))
    const sighash = tx.hashForWitnessV1(0, [hexToBytes(escrowFor(atomicParties).script)], [BigInt(escrowOut.value)], bitcoin.Transaction.SIGHASH_DEFAULT, tapleafHash({ output: script, version: 0xc0 }))
    assert.ok(schnorr.verify(sig, sighash, hexToBytes(B.pubkey)))
    assert.ok(!schnorr.verify(sig, sighash, hexToBytes(L.pubkey)))
  })
})
