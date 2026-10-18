// Explicit opt-in Bitcoin-only protocol test, never connects to a default stack.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { it } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes, keyPairFromLabel } from '../core/crypto.js'
import { onchainCollateralFor } from './onchain-collateral-template.js'
import { ONCHAIN_REGTEST_GENESIS } from './onchain-v3-contract.js'
const endpoint = process.env.PASSBOOK_G0_RPC
if (endpoint !== 'http://127.0.0.1:18733') throw new Error('Explicit isolated PASSBOOK_G0_RPC=http://127.0.0.1:18733 required; no default-chain fallback')
async function rpc<T = any>(method: string, params: unknown[] = [], wallet = ''): Promise<T> {
  const response = await fetch(`${endpoint}${wallet ? '/wallet/' + wallet : ''}`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('user:password').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'g0-protocol', method, params }) })
  const body = await response.json() as { result: T; error?: unknown }
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}
it('enforces the exact terms-bound A/F/D tree on isolated regtest', { timeout: 120_000 }, async () => {
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest')
  assert.equal(await rpc('getblockhash', [0]), ONCHAIN_REGTEST_GENESIS)
  const runId = Date.now().toString(), wallet = 'g0-protocol-' + runId
  await rpc('createwallet', [wallet])
  const miner = await rpc<string>('getnewaddress', [], wallet)
  const mine = (n: number) => rpc('generatetoaddress', [n, miner], wallet)
  await mine(111)
  const tip = await rpc<number>('getblockcount'), recoveryHeight = tip + 12, defaultHeight = tip + 8
  const B = keyPairFromLabel('g0-script-b-' + runId), L = keyPairFromLabel('g0-script-l-' + runId), P = keyPairFromLabel('g0-script-p-' + runId)
  const params = { loan_id: '11'.repeat(32), borrower_pk: B.pubkey, lender_pk: L.pubkey, platform_pk: P.pubkey, recovery_height: recoveryHeight }
  const tree = onchainCollateralFor(params), script = hexToBytes(tree.script_pubkey)
  const destination = bitcoin.payments.p2tr({ internalPubkey: hexToBytes(B.pubkey), network: bitcoin.networks.regtest }).output!
  const address = bitcoin.address.fromOutputScript(script, bitcoin.networks.regtest)
  const coins: { txid: string; vout: number }[] = []
  for (let i = 0; i < 3; i++) {
    const txid = await rpc<string>('sendtoaddress', [address, 0.001], wallet)
    await mine(1)
    const tx = bitcoin.Transaction.fromHex(await rpc<string>('getrawtransaction', [txid]))
    const vout = tx.outs.findIndex((o) => bytesToHex(o.script) === tree.script_pubkey && o.value === 100_000n)
    assert.ok(vout >= 0); coins.push({ txid, vout })
  }
  const build = (coin: typeof coins[number], leaf: 'A' | 'F' | 'D', locktime = 0) => {
    const tx = new bitcoin.Transaction(); tx.version = 2; tx.locktime = locktime
    tx.addInput(Uint8Array.from(hexToBytes(coin.txid)).reverse(), coin.vout, 0xfffffffe)
    tx.addOutput(destination, 99_500n)
    const path = tree.leaves[leaf]
    const hash = tx.hashForWitnessV1(0, [script], [100_000n], bitcoin.Transaction.SIGHASH_DEFAULT, hexToBytes(path.leaf_hash))
    const b = schnorr.sign(hash, B.secretKey), l = schnorr.sign(hash, L.secretKey), p = schnorr.sign(hash, P.secretKey)
    tx.setWitness(0, [...(leaf === 'A' ? [l, b] : leaf === 'F' ? [p, l, b] : [b]), hexToBytes(path.script), hexToBytes(path.control_block)])
    return tx
  }
  // Transaction.clone shares witness arrays; mutation tests need independent bytes.
  const copy = (tx: bitcoin.Transaction) => bitcoin.Transaction.fromHex(tx.toHex())
  const verdicts: Record<string, unknown> = {}
  const check = async (name: string, tx: bitcoin.Transaction, allowed: boolean) => {
    const verdict = (await rpc('testmempoolaccept', [[tx.toHex()]]))[0]
    verdicts[name] = verdict
    assert.equal(verdict.allowed, allowed, `${name}: ${JSON.stringify(verdict)}`)
  }
  const a = build(coins[0], 'A'), f = build(coins[1], 'F'), d = build(coins[2], 'D', recoveryHeight)
  await check('A-valid', a, true)
  const missingL = copy(a); missingL.ins[0].witness[0] = new Uint8Array(); await check('A-missing-lender', missingL, false)
  const changedReturn = copy(a); changedReturn.outs[0].value -= 1n; await check('A-changed-return-after-signing', changedReturn, false)
  const knownKeyAttempt = copy(a); knownKeyAttempt.setWitness(0, [new Uint8Array(64).fill(1)]); await check('keypath-attempt', knownKeyAttempt, false)
  const wrongTerms = copy(a); wrongTerms.ins[0].witness[2] = hexToBytes(onchainCollateralFor({ ...params, loan_id: '22'.repeat(32) }).leaves.A.script); await check('wrong-terms-control', wrongTerms, false)
  await check('F-valid', f, true)
  const missingP = copy(f); missingP.ins[0].witness[0] = new Uint8Array(); await check('F-missing-platform', missingP, false)
  await check('D-before-height', d, false)
  const def = build(coins[0], 'A', defaultHeight); await check('default-before-height', def, false)
  const txids: Record<string, string> = {}
  txids.A = await rpc('sendrawtransaction', [a.toHex()]); await mine(1)
  txids.F = await rpc('sendrawtransaction', [f.toHex()]); await mine(1)
  await mine(Math.max(0, recoveryHeight - await rpc<number>('getblockcount')))
  await check('default-conflicts-with-confirmed-A', def, false)
  await check('D-at-height', d, true)
  const finalSequence = build(coins[2], 'D', recoveryHeight); finalSequence.ins[0].sequence = 0xffffffff; await check('D-final-sequence-invalidates-CLTV', finalSequence, false)
  txids.D = await rpc('sendrawtransaction', [d.toHex()]); await mine(1)
  for (const [leaf, txid] of Object.entries(txids)) assert.ok((await rpc('getrawtransaction', [txid, true])).confirmations > 0, leaf)
  mkdirSync('data/g0-script-run', { recursive: true })
  writeFileSync('data/g0-script-run/report.json', JSON.stringify({ status: 'passed', scope: 'Bitcoin-only exact G0 A/F/D script enforcement; no native RGB/application acceptance', source_commit: process.env.PASSBOOK_G0_SOURCE_COMMIT ?? null, network: 'regtest', project: 'passbook-onchain-g0', rpc_port: 18733, recovery_height: recoveryHeight, default_height: defaultHeight, script_pubkey: tree.script_pubkey, verdicts, confirmed_spends: txids }, null, 2) + '\n')
})
