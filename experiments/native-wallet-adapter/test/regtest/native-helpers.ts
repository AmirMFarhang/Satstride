import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { NativeWalletOwner } from '../../src/rgb/native-owner.js'
import { canonicalJson, hashObject, randomHex, randomKeyPair, sha256Hex, signObject, type KeyPair } from '../../src/core/crypto.js'

export const nativeBinary = resolve('native/rgb-core/target/debug/passbook-rgb-native')
const rpcUrl = process.env.PASSBOOK_NATIVE_BITCOIND_URL ?? 'http://127.0.0.1:18843'
export async function nativeRpc<T>(method: string, params: unknown[] = [], miner = false): Promise<T> {
  const r = await fetch(rpcUrl + (miner ? '/wallet/miner' : ''), { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('user:password').toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'native-integration', method, params }) })
  const v = await r.json() as { result: T; error: unknown }
  if (v.error) throw new Error('isolated Bitcoin RPC refused ' + method)
  return v.result
}
export async function nativeMine() {
  await nativeRpc('generatetoaddress', [1, await nativeRpc('getnewaddress', [], true)], true)
  await new Promise(r => setTimeout(r, 1000))
}
export interface NativeTestActor { owner: NativeWalletOwner; walletId: string; gate: KeyPair; dir: string }
/** Explicit test fixture approval, not application governance acceptance. */
export async function testExport(actor: NativeTestActor, psbt: string, purpose: string, slot = hashObject({ fixture: purpose, nonce: randomHex() })) {
  const stage = sha256Hex(purpose), at = Math.floor(Date.now() / 1000)
  await actor.owner.call('slot_reserve', { slot, intent_hash: sha256Hex(psbt), intent: { purpose, psbt_hash: sha256Hex(psbt) } })
  // In a real adapter these are the full independently verified proposal/summary.
  const summary = { test_fixture: purpose, psbt_hash: sha256Hex(psbt) }
  await actor.owner.call('artifact_put', { hex: Buffer.from(psbt).toString('hex') })
  await actor.owner.call('artifact_put', { hex: Buffer.from(canonicalJson(summary)).toString('hex') })
  const permit = signObject({ domain: 'passbook-native-signing-permit/v1', wallet_id: actor.walletId, gate_pk: actor.gate.pubkey, slot, stage, unsigned_psbt_sha256: sha256Hex(psbt), proposal_hash: sha256Hex(psbt), decoded_summary_hash: hashObject(summary), decision_id: 'explicit-native-test-fixture-approval', issued_at: at, expires_at: at + 120 }, actor.gate.secretKey)
  const signed = await actor.owner.call<{ psbt: string }>('sign_export', { slot, stage, psbt, permit }).catch(e => { throw new Error(`${purpose}: ${e.message}`) })
  return { ...signed, slot, stage }
}
export async function nativeActor(label: string): Promise<NativeTestActor> {
  const dir = await mkdtemp(resolve(`data/native-${label}-`)), gate = randomKeyPair()
  const owner = await NativeWalletOwner.start(nativeBinary, dir)
  try {
    const opened = await owner.call<{ wallet_id: string }>('open', { mnemonic: generateMnemonic(wordlist), gate_pk: gate.pubkey, indexer_url: process.env.PASSBOOK_NATIVE_INDEXER_URL ?? '127.0.0.1:50411' })
    const actor = { owner, walletId: opened.wallet_id, gate, dir }
    const address = await owner.call<{ address: string }>('address', {})
    await nativeRpc('sendtoaddress', [address.address, 0.1], true); await nativeMine()
    const prepared = await owner.call<{ psbt: string }>('prepare_utxos', { count: 8, size_sats: '5000', fee_rate: 2 })
    const signed = await testExport(actor, prepared.psbt, 'fresh-utxo-setup')
    await owner.call('complete_utxos', { slot: signed.slot, stage: signed.stage }); await nativeMine()
    return actor
  } catch (e) { await owner.close(); throw e }
}
export async function nativeSettled(actor: NativeTestActor, asset: string, expected: string) {
  for (let tries = 0; tries < 40; tries++) {
    await actor.owner.call('refresh', {})
    const b = await actor.owner.call<{ settled: string; spendable: string }>('balance', { asset_id: asset })
    if (b.settled === expected && b.spendable === expected) return b
    await new Promise(r => setTimeout(r, 250))
  }
  assert.fail('native RGB balance did not become settled and spendable')
}
export const nativeProxy = process.env.PASSBOOK_NATIVE_PROXY_URL ?? 'rpc://127.0.0.1:3410/json-rpc'
export async function nativeTransfer(sender: NativeTestActor, receiver: NativeTestActor, asset: string, kind: 'nia' | 'uda', amount = '1', blinding?: string) {
  const receive = await receiver.owner.call<{ recipient_id: string }>('receive', { asset_id: null, kind, amount, transport_endpoints: [nativeProxy], confirmations: 1 })
  const prepared = await sender.owner.call<{ psbt: string; consignment: { sha256: string; byte_length: number }; output_history: { sha256: string; byte_length: number } | null }>('prepare_send', { asset_id: asset, kind, amount, recipient_id: receive.recipient_id, output_sats: '1000', transport_endpoints: [nativeProxy], confirmations: 1, fee_rate: 2, blinding: blinding ?? null })
  const signed = await testExport(sender, prepared.psbt, `send-${kind}`)
  const result = await sender.owner.call<{ txid: string }>('complete_send', { slot: signed.slot, stage: signed.stage })
  // Donation sends post the complete proof; a fresh receiver independently validates it.
  await nativeMine()
  await nativeSettled(receiver, asset, amount)
  await sender.owner.call('refresh', {})
  return { ...result, ...prepared, recipient_id: receive.recipient_id }
}
