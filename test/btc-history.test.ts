import assert from 'node:assert/strict'
import { HDKey } from '@scure/bip32'
import { describe, it } from 'node:test'
import { FakeChain } from '../src/chain/fake.js'
import { bytesToHex, hexToBytes, randomHex, sha256Hex } from '../src/core/crypto.js'
import { readBtcHistory, xpubScript, type ElectrumReader } from '../src/wallet/btc-history.js'
const xpub = HDKey.fromMasterSeed(hexToBytes('12'.repeat(32))).publicExtendedKey
const script = xpubScript(xpub, 0, 0)
const scriptHash = bytesToHex(hexToBytes(sha256Hex(hexToBytes(script))).reverse())
describe('BTC history from declared xpubs and the chain', () => {
  it('discovers incoming and outgoing anchors through Electrum and computes actual Bitcoin prevouts', async () => {
    const chain = new FakeChain(), first = chain.addTx([{ script, value: 10000 }]); chain.mine()
    const second = chain.addTx([{ script: '5120' + randomHex(), value: 6000 }, { script, value: 3500 }], [{ txid: first, vout: 0 }]); chain.mine()
    const reader: ElectrumReader = { request: async <T>(_m: string, p: unknown[]) => (p[0] === scriptHash ? [{ tx_hash: first, height: 101 }, { tx_hash: second, height: 102 }] : []) as T }
    const result = await readBtcHistory([{ xpub, branches: [0, 1] }], reader, chain, { gapLimit: 2 })
    assert.equal(result.status, 'verified'); assert.equal(result.current_sats, 3500); assert.equal(result.rows[1].spent_sats, 10000); assert.equal(result.rows[1].net_sats, -6500)
    assert.equal(result.scope, 'declared_xpub_branches'); assert.equal(result.first_height, 101); assert.ok(result.scanned_scripts >= 5)
  })
  it('fails closed on pending transactions, false indexer heights or an exhausted scan bound', async () => {
    const chain = new FakeChain(), first = chain.addTx([{ script, value: 10000 }]); chain.mine()
    for (const height of [0, 123]) {
      const reader: ElectrumReader = { request: async <T>(_m: string, p: unknown[]) => (p[0] === scriptHash ? [{ tx_hash: first, height }] : []) as T }
      assert.equal((await readBtcHistory([{ xpub, branches: [0] }], reader, chain, { gapLimit: 2 })).status, 'unknown')
    }
    const every: ElectrumReader = { request: async <T>() => [{ tx_hash: first, height: 101 }] as T }
    assert.equal((await readBtcHistory([{ xpub, branches: [0] }], every, chain, { gapLimit: 2, maxAddressesPerBranch: 2 })).status, 'unknown')
  })
})
