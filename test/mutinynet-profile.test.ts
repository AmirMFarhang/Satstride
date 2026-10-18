// The provider on Mutinynet (§8, the two-phone end game): the check node's chain
// checks read the profile's Esplora instead of a bitcoind of ours, and the
// platform's fee wallet (which invoices the platform fee and any check billed at
// close) opens on the profile's RGB network, proxy and indexer. Regtest is
// unchanged; mainnet is refused.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { EsploraChain } from '../src/chain/esplora.js'
import { loadConfig } from '../src/core/config.js'
import { chainForProfile } from '../src/checknode/provider.js'
import { rgbConfigFromEnv, rgbNetworkFromEnv } from '../src/rgb/wallet.js'
import { feeWalletRgbConfig } from '../src/server/fees.js'

const mutinynet = loadConfig(join(process.cwd(), 'infra/passbook.config.mutinynet.yaml'), { checkFiles: false })
const regtest = loadConfig(join(process.cwd(), 'passbook.config.yaml'), { checkFiles: false })

describe('provider on Mutinynet', () => {
  it('the check node reads Mutinynet through the profile\'s Esplora; regtest keeps the local bitcoind', () => {
    const chain = chainForProfile(mutinynet.network, {})
    assert.equal(chain.kind, 'esplora')
    assert.equal((chain as EsploraChain).base, 'https://esplora.signet.kaleidoswap.com')
    assert.equal(chainForProfile(regtest.network, {}).kind, 'bitcoind')
    assert.equal(chainForProfile(undefined, {}).kind, 'bitcoind')
  })

  it('the platform fee wallet opens on the profile\'s RGB network, proxy and indexer; regtest is byte-identical', () => {
    assert.deepEqual(feeWalletRgbConfig(mutinynet), { network: 'signet', indexerUrl: 'https://esplora.signet.kaleidoswap.com', transportEndpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc' })
    assert.equal(feeWalletRgbConfig(regtest), undefined, 'regtest: the wallet keeps rgbConfigFromEnv()')
    assert.equal(feeWalletRgbConfig(null), undefined)
    // rgbConfigFromEnv without PASSBOOK_RGB_NETWORK: exactly as before.
    const before = process.env.PASSBOOK_RGB_NETWORK
    delete process.env.PASSBOOK_RGB_NETWORK
    try { assert.equal(rgbConfigFromEnv().network, 'regtest') } finally { if (before !== undefined) process.env.PASSBOOK_RGB_NETWORK = before }
    assert.equal(rgbNetworkFromEnv({}), 'regtest')
    assert.equal(rgbNetworkFromEnv({ PASSBOOK_RGB_NETWORK: 'signet' }), 'signet', 'Mutinynet is a signet')
    assert.equal(rgbNetworkFromEnv({ PASSBOOK_RGB_NETWORK: 'testnet4' }), 'testnet4')
  })

  it('mainnet is refused everywhere', () => {
    for (const n of ['mainnet', 'bitcoin', 'testnet']) assert.throws(() => rgbNetworkFromEnv({ PASSBOOK_RGB_NETWORK: n }), /never mainnet/)
    const dir = mkdtempSync(join(tmpdir(), 'passbook-mainnet-'))
    try {
      const yaml = readFileSync(join(process.cwd(), 'infra/passbook.config.mutinynet.yaml'), 'utf8').replace(/^network: mutinynet$/m, 'network: mainnet').replace(/approved_builds: .*/, `approved_builds: ${join(process.cwd(), 'infra/scorer-releases.json')}`)
      writeFileSync(join(dir, 'c.yaml'), yaml)
      assert.throws(() => loadConfig(join(dir, 'c.yaml'), { checkFiles: false }), /mainnet|network/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
