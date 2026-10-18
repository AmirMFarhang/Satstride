// Optional isolated native integration. No existing wallet or shared chain is used.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { NativeOperationJournal, NativeReconciliationRequired } from '../../src/rgb/native-journal.js'
import { NativeWalletOwner } from '../../src/rgb/native-owner.js'
import { canonicalJson, hashObject, randomKeyPair, sha256Hex, signObject } from '../../src/core/crypto.js'

const enabled = process.env.PASSBOOK_NATIVE_ACCEPTANCE === '1'
const rpcUrl = process.env.PASSBOOK_NATIVE_BITCOIND_URL ?? 'http://127.0.0.1:18843'
const binary = resolve('native/rgb-core/target/debug/passbook-rgb-native')
async function rpc<T>(method: string, params: unknown[] = [], miner = false): Promise<T> {
  const r = await fetch(rpcUrl + (miner ? '/wallet/miner' : ''), { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('user:password').toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'native-owner-test', method, params }) })
  const v = await r.json() as { result: T; error: unknown }
  if (v.error) throw new Error('isolated Bitcoin RPC refused ' + method)
  return v.result
}
async function mine() { await rpc('generatetoaddress', [1, await rpc('getnewaddress', [], true)], true); await new Promise(r => setTimeout(r, 1000)) }

test('native owner: real Taproot wallet, gate-bound export, process crash, immutable retry and exact u64', { skip: !enabled, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(resolve('data/native-owner-'))
  const gate = randomKeyPair(), wrongGate = randomKeyPair(), mnemonic = generateMnemonic(wordlist)
  let owner = await NativeWalletOwner.start(binary, dir)
  const open = () => owner.call<{ wallet_id: string }>('open', { mnemonic, gate_pk: gate.pubkey, indexer_url: process.env.PASSBOOK_NATIVE_INDEXER_URL ?? '127.0.0.1:50411' })
  try {
    const { wallet_id } = await open()
    await assert.rejects(() => NativeWalletOwner.start(binary, dir, 5000), /UNAVAILABLE/)
    const address = await owner.call<{ address: string }>('address', {})
    await rpc('sendtoaddress', [address.address, 0.01], true); await mine()
    const slot = hashObject({ wallet_id, obligation: 'test-native-preparation' }), stage = sha256Hex('wallet-utxos')
    await owner.call('slot_reserve', { slot, intent_hash: sha256Hex('approved setup'), intent: { amount: '9007199254740993' } })
    const journal = new NativeOperationJournal(owner)
    let effects = 0
    const concurrent = await Promise.allSettled([0, 1, 2].map(() => journal.effect(slot, 'concurrent-native-prepare', { fixed: true }, async () => { effects++; await new Promise(r => setTimeout(r, 25)); return { operation: 'one' } })))
    assert.equal(effects, 1)
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1)
    for (const result of concurrent) if (result.status === 'rejected') assert.ok(result.reason instanceof NativeReconciliationRequired)
    assert.deepEqual(await journal.effect(slot, 'concurrent-native-prepare', { fixed: true }, async () => { throw new Error('must not repeat') }), { operation: 'one' })
    const prepared = await owner.call<{ psbt: string }>('prepare_utxos', { count: 5, size_sats: '5000', fee_rate: 2 })
    const p = bitcoin.Psbt.fromBase64(prepared.psbt)
    assert.ok(p.txInputs.length)
    const summary = p.txOutputs.map(o => ({ script: Buffer.from(o.script).toString('hex'), value: o.value.toString() }))
    await owner.call('artifact_put', { hex: Buffer.from(prepared.psbt).toString('hex') })
    await owner.call('artifact_put', { hex: Buffer.from(canonicalJson(summary)).toString('hex') })
    const at = Math.floor(Date.now() / 1000)
    const permit = signObject({ domain: 'passbook-native-signing-permit/v1', wallet_id, gate_pk: gate.pubkey, slot, stage, unsigned_psbt_sha256: sha256Hex(prepared.psbt), proposal_hash: sha256Hex(prepared.psbt), decoded_summary_hash: hashObject(summary), decision_id: 'test-only-explicit-setup-approval', issued_at: at, expires_at: at + 120 }, gate.secretKey)
    const bad = signObject({ ...permit }, wrongGate.secretKey)
    await assert.rejects(() => owner.call('sign_export', { slot, stage, psbt: prepared.psbt, permit: bad }), /NATIVE_REFUSED/)
    const signed = await owner.call<{ psbt: string; export: { signatures_exported: boolean } }>('sign_export', { slot, stage, psbt: prepared.psbt, permit })
    assert.equal(signed.export.signatures_exported, true)
    // Kill after export, before broadcast; the actual signed bytes must survive.
    process.kill(owner.pid!, 'SIGKILL')
    await owner.close()
    owner = await NativeWalletOwner.start(binary, dir); await open()
    const replay = await owner.call<{ psbt: string }>('sign_export', { slot, stage, psbt: prepared.psbt, permit })
    assert.equal(replay.psbt, signed.psbt)
    await assert.rejects(() => owner.call('slot_reserve', { slot, intent_hash: sha256Hex('different operator/RPC retry'), intent: {} }), /NATIVE_REFUSED/)
    const saved = await owner.call<{ intent: { amount: string } }>('slot_get', { slot })
    assert.equal(saved.intent.amount, '9007199254740993')
    const completed = await owner.call<{ created: number }>('complete_utxos', { slot, stage })
    assert.equal(completed.created, 5); await mine()
    const asset = await owner.call<{ asset_id: string }>('issue_nia', { ticker: 'NATIVE', name: 'Native owner no-value test', precision: 0, amount: '9007199254740993' })
    const balance = await owner.call<{ settled: string; spendable: string }>('balance', { asset_id: asset.asset_id })
    assert.equal(balance.settled, '9007199254740993')
    assert.equal(balance.spendable, '9007199254740993')
    await owner.call('observe', { slot, observation: { confirmations: 6, block_hash: 'old' } })
    await owner.call('observe', { slot, observation: { confirmations: 0, block_hash: null } })
    const still = await owner.call<{ signatures_exported: boolean }>('export_get', { slot, stage })
    assert.equal(still.signatures_exported, true)
  } finally { await owner.close() }
})
