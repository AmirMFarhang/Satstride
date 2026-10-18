// The history observer on a public test network (Mutinynet): the allocation check reads Esplora when the chain is not
// bitcoind, the BTC history can come from its own Electrum server, bitcoind/regtest is unchanged, mainnet is refused.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { blockHashOfHeader, btcHistoryEndpoint, confirmedUnspent, electrumChainProblems, RgbHistoryObserver, type ObserverChain } from '../src/rgb/history-observer.js'
import { keyPairFromLabel } from '../src/core/crypto.js'

const txid = 'ab'.repeat(32)
const script = '5120' + 'cd'.repeat(32)

describe('confirmedUnspent', () => {
  it('bitcoind: gettxout, exactly as before (BTC to sats, scriptPubKey hex)', async () => {
    const calls: unknown[] = []
    const bitcoind = { rpc: async (method: string, params: unknown[]) => { calls.push([method, params]); return { value: 0.0003, confirmations: 4, scriptPubKey: { hex: script } } } } as unknown as ObserverChain
    assert.deepEqual(await confirmedUnspent(bitcoind, txid, 1), { sats: 30_000, confirmations: 4, script })
    assert.deepEqual(calls, [['gettxout', [txid, 1, true]]])
    const spent = { rpc: async () => null } as unknown as ObserverChain
    assert.equal(await confirmedUnspent(spent, txid, 1), null)
  })

  it('Esplora: unspent per /outspend, value and script from the transaction, confirmations from the tip', async () => {
    const esplora = (o: { spent?: boolean | undefined; height?: number | null; outputs?: { value: number; script: string }[] }) => ({
      outspends: async () => (o.spent === undefined ? [] : [{ spent: false }, { spent: o.spent }]),
      getTx: async () => ({ txid, height: o.height === undefined ? 100 : o.height, inputs: [], outputs: o.outputs ?? [{ value: 1, script: '00' }, { value: 3000, script }] }),
      getHeight: async () => 104,
    }) as ObserverChain
    assert.deepEqual(await confirmedUnspent(esplora({ spent: false }), txid, 1), { sats: 3000, confirmations: 5, script })
    assert.equal(await confirmedUnspent(esplora({ spent: true }), txid, 1), null, 'spent')
    assert.equal(await confirmedUnspent(esplora({ spent: false, height: null }), txid, 1), null, 'unconfirmed')
    assert.equal(await confirmedUnspent(esplora({ spent: false, outputs: [{ value: 1, script: '00' }] }), txid, 1), null, 'no such output')
    assert.equal(await confirmedUnspent(esplora({ spent: undefined }), txid, 1), null, 'unknown spent status is not unspent')
  })
})

describe('btcHistoryEndpoint', () => {
  const cfg = { network: 'signet' as const, indexerUrl: 'https://esplora.signet.kaleidoswap.com', transportEndpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc' }
  it('is the RGB indexer by default (regtest unchanged), the env or the config when set', () => {
    assert.equal(btcHistoryEndpoint({ ...cfg, network: 'regtest', indexerUrl: 'tcp://127.0.0.1:50011' }, undefined, {}), 'tcp://127.0.0.1:50011')
    assert.equal(btcHistoryEndpoint(cfg, undefined, { PASSBOOK_BTC_HISTORY_ELECTRUM: 'tcp://electrum.mutinynet.com:50001' }), 'tcp://electrum.mutinynet.com:50001')
    assert.equal(btcHistoryEndpoint(cfg, 'tcp://other:50001', { PASSBOOK_BTC_HISTORY_ELECTRUM: 'tcp://electrum.mutinynet.com:50001' }), 'tcp://other:50001')
  })
  it('refuses mainnet', () => {
    assert.throws(() => btcHistoryEndpoint({ ...cfg, network: 'mainnet' }), /refuses mainnet/)
  })
})

// Real Mutinynet headers (electrum.mutinynet.com, blockchain.block.header 0 and 1) and their Esplora block hashes.
const MUTINYNET = {
  0: { header: '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a008f4d5fae77031e8ad22203', hash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6' },
  1: { header: '00000020f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000011ba17baed1cacfb3793ba391383c305e401b3c54b3ce611c05d8b29927ad9e023d2f64ae77031ec0db7a01', hash: '000002855893a0a9b24eaffc5efc770558a326fee4fc10c9da22fc19cd2954f9' },
} as Record<number, { header: string; hash: string }>

describe('the separate BTC-history Electrum server is checked against the chain', () => {
  const electrum = (headers: Record<number, string | null>) => ({ request: async <T>(_m: string, params: unknown[]) => headers[params[0] as number] as T })
  const chain = async (h: number) => MUTINYNET[h]?.hash ?? null
  it('hashes real Mutinynet headers to their block hashes', () => {
    assert.equal(blockHashOfHeader(MUTINYNET[0].header), MUTINYNET[0].hash)
    assert.equal(blockHashOfHeader(MUTINYNET[1].header), MUTINYNET[1].hash)
  })
  it('accepts a server whose blocks 0 and 1 are the chain\'s', async () => {
    assert.deepEqual(await electrumChainProblems(electrum({ 0: MUTINYNET[0].header, 1: MUTINYNET[1].header }), chain), [])
  })
  it('refuses a server on another network (the default signet shares block 0, not block 1)', async () => {
    const otherBlock1 = MUTINYNET[1].header.slice(0, 150) + '00000000ff'
    const problems = await electrumChainProblems(electrum({ 0: MUTINYNET[0].header, 1: otherBlock1 }), chain)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /block 1: the Electrum server has/)
  })
  it('refuses when it cannot compare (no header, a malformed one, or no chain hash)', async () => {
    assert.equal((await electrumChainProblems(electrum({ 0: null, 1: MUTINYNET[1].header }), chain)).length, 1)
    assert.equal((await electrumChainProblems(electrum({ 0: 'zz', 1: MUTINYNET[1].header }), chain)).length, 1)
    assert.equal((await electrumChainProblems(electrum({ 0: MUTINYNET[0].header, 1: MUTINYNET[1].header }), async () => null)).length, 2)
  })
})

describe('RgbHistoryObserver', () => {
  it('refuses a mainnet RGB config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-observer-'))
    try {
      assert.throws(() => new RgbHistoryObserver({ rootDir: dir, signer: keyPairFromLabel('observer-test'), chain: { rpc: async () => null } as unknown as ObserverChain, cfg: { network: 'mainnet', indexerUrl: 'tcp://x:1', transportEndpoint: 'rpc://x/json-rpc' } }), /refuses mainnet/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
