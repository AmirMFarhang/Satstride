// Explicit opt-in Bitcoin script probe. No RGB assets, live check service or
// wallet journals are exercised here. Never falls back to an existing stack.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { schnorr } from '@noble/curves/secp256k1.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { bytesToHex, hexToBytes, randomHex, randomKeyPair, sha256Hex } from '../core/crypto.js'
import { CHECK_REGTEST_GENESIS } from './onchain-check-contract.js'
import { checkHtlcFor } from './onchain-check-template.js'

const endpoint = process.env.PASSBOOK_CHECK_PROTOCOL_RPC
if (endpoint !== 'http://127.0.0.1:18753') throw new Error('Explicit isolated PASSBOOK_CHECK_PROTOCOL_RPC=http://127.0.0.1:18753 required')
const chain = new BitcoindChain({ url: endpoint, user: 'user', password: 'password' })

test('exact bounded check HTLC enforces claim/refund signatures and permits late claims', { timeout: 120000 }, async () => {
  assert.equal((await chain.rpc<{ chain: string }>('getblockchaininfo')).chain, 'regtest')
  assert.equal(await chain.rpc('getblockhash', [0]), CHECK_REGTEST_GENESIS)
  const wallet = 'check-script-' + Date.now()
  await chain.rpc('createwallet', [wallet])
  const mineTo = await chain.rpc<string>('getnewaddress', [], wallet)
  const mine = (n: number) => chain.rpc('generatetoaddress', [n, mineTo], wallet)
  await mine(111)
  const payer = randomKeyPair(), operator = randomKeyPair()
  const key = randomHex(32)
  const params = { quote_hash: randomHex(32), key_hash: sha256Hex(hexToBytes(key)), payer_pk: payer.pubkey, operator_pk: operator.pubkey, refund_height: await chain.getHeight() + 12 }
  const tree = checkHtlcFor(params), qScript = hexToBytes(tree.script_pubkey)
  const address = bitcoin.address.fromOutputScript(qScript, bitcoin.networks.regtest)
  const coins: { txid: string; vout: number }[] = []
  for (let i = 0; i < 2; i++) {
    const txid = await chain.rpc<string>('sendtoaddress', [address, 0.001], wallet)
    await mine(1)
    const tx = bitcoin.Transaction.fromHex(await chain.rpc<string>('getrawtransaction', [txid]))
    const vout = tx.outs.findIndex((o) => bytesToHex(o.script) === tree.script_pubkey && o.value === 100000n)
    assert.ok(vout >= 0)
    coins.push({ txid, vout })
  }
  const payout = (pk: string) => bitcoin.payments.p2tr({ internalPubkey: hexToBytes(pk), network: bitcoin.networks.regtest }).output!
  const build = (coin: typeof coins[number], kind: 'claim' | 'refund', sequence = 0xfffffffe) => {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    tx.locktime = kind === 'refund' ? params.refund_height : 0
    tx.addInput(Uint8Array.from(hexToBytes(coin.txid)).reverse(), coin.vout, sequence)
    // Script-only fixture: fees come from this uncolored Q, unlike the future
    // RGB policy's full-output value plus separate RGB-free fee inputs.
    tx.addOutput(payout(kind === 'claim' ? operator.pubkey : payer.pubkey), 99500n)
    const leaf = tree[kind]
    const digest = tx.hashForWitnessV1(0, [qScript], [100000n], bitcoin.Transaction.SIGHASH_DEFAULT, hexToBytes(leaf.leaf_hash))
    const sig = schnorr.sign(digest, kind === 'claim' ? operator.secretKey : payer.secretKey)
    tx.setWitness(0, [...(kind === 'claim' ? [sig, hexToBytes(key)] : [sig]), hexToBytes(leaf.script), hexToBytes(leaf.control_block)])
    return tx
  }
  const copy = (tx: bitcoin.Transaction) => bitcoin.Transaction.fromHex(tx.toHex())
  const verdicts: Record<string, unknown> = {}
  const verdict = async (name: string, tx: bitcoin.Transaction, allowed: boolean) => {
    const result = (await chain.rpc<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[tx.toHex()]]))[0]
    assert.equal(result.allowed, allowed, `${name}: ${JSON.stringify(result)}`)
    // Only node verdicts are retained; no witness/key/raw transaction is emitted.
    verdicts[name] = result
  }
  const claim = build(coins[0], 'claim')
  await verdict('valid-claim-before-refund', claim, true)
  const missing = copy(claim); missing.ins[0].witness[0] = new Uint8Array()
  await verdict('claim-missing-operator-signature', missing, false)
  const wrongKey = copy(claim); wrongKey.ins[0].witness[1] = new Uint8Array(32)
  await verdict('claim-wrong-key', wrongKey, false)
  const shortKey = copy(claim); shortKey.ins[0].witness[1] = new Uint8Array(31)
  await verdict('claim-short-key', shortKey, false)
  const changedOutput = copy(claim); changedOutput.outs[0].value--
  await verdict('claim-output-mutated-after-signature', changedOutput, false)
  const changedQuote = copy(claim)
  changedQuote.ins[0].witness[2] = hexToBytes(checkHtlcFor({ ...params, quote_hash: randomHex(32) }).claim.script)
  await verdict('claim-wrong-quote-script', changedQuote, false)
  const keyPath = copy(claim); keyPath.setWitness(0, [new Uint8Array(64).fill(1)])
  await verdict('known-keypath-signature-attempt', keyPath, false)
  await verdict('refund-before-height', build(coins[1], 'refund'), false)
  const claimed = await chain.rpc<string>('sendrawtransaction', [claim.toHex()])
  await mine(1)
  await mine(Math.max(0, params.refund_height - await chain.getHeight()))
  const refund = build(coins[1], 'refund'), lateClaim = build(coins[1], 'claim')
  await verdict('refund-at-height', refund, true)
  await verdict('claim-still-valid-after-refund-height', lateClaim, true)
  await verdict('refund-final-sequence-disables-cltv', build(coins[1], 'refund', 0xffffffff), false)
  const wrongPayer = copy(refund)
  wrongPayer.ins[0].witness[0] = schnorr.sign(refund.hashForWitnessV1(0, [qScript], [100000n], bitcoin.Transaction.SIGHASH_DEFAULT, hexToBytes(tree.refund.leaf_hash)), operator.secretKey)
  await verdict('refund-wrong-payer-signature', wrongPayer, false)
  const refunded = await chain.rpc<string>('sendrawtransaction', [refund.toHex()])
  await mine(1)
  await verdict('claim-loses-to-confirmed-refund', lateClaim, false)
  for (const txid of [claimed, refunded]) assert.ok((await chain.rpc<{ confirmations: number }>('getrawtransaction', [txid, true])).confirmations >= 1)
  mkdirSync('data/check-protocol-run', { recursive: true })
  writeFileSync('data/check-protocol-run/report.json', JSON.stringify({
    status: 'passed', source_commit: process.env.PASSBOOK_CHECK_PROTOCOL_SOURCE_COMMIT ?? null,
    scope: 'Bitcoin-only exact check HTLC scripts; no RGB coloring, fee/layout policy, native journal or live paid-check acceptance',
    project: 'passbook-onchain-check-protocol', rpc_port: 18753, refund_height: params.refund_height,
    script_pubkey: tree.script_pubkey, verdicts, confirmed_claim: claimed, confirmed_refund: refunded,
  }, null, 2) + '\n', { mode: 0o600 })
})
