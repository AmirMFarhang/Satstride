// Party wallets from a WDK seed: bitcoind derives the same BIP-86 address from
// the seed's tr() descriptor, and the RGB wallet opens through WDK core.
// Needs `infra/regtest.sh start`.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { BitcoindChain } from '../../src/chain/bitcoind.js'
import { openParty, partyKey } from '../../src/wallet/party.js'

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf }

describe('party wallets', () => {
  it('derives the party key at m/86h/1h/0h/0/0 exactly as bitcoind does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-wallet-'))
    try {
      const party = await openParty('borrower', { dir, create: true })
      const seed = readFileSync(join(dir, 'borrower', 'seed'), 'utf8').trim()
      assert.equal(seed.split(' ').length, 12)
      assert.equal(statSync(join(dir, 'borrower', 'seed')).mode & 0o777, 0o600)
      assert.equal(partyKey(seed).pubkey, party.key.pubkey)

      const tprv = HDKey.fromMasterSeed(mnemonicToSeedSync(seed), TESTNET_VERSIONS).privateExtendedKey
      const chain = BitcoindChain.fromEnv()
      const desc = `tr(${tprv}/86h/1h/0h/0/0)`
      const { checksum } = await chain.rpc<{ checksum: string }>('getdescriptorinfo', [desc])
      const [address] = await chain.rpc<string[]>('deriveaddresses', [`${desc}#${checksum}`])
      assert.equal(party.btcAddress, address)

      assert.match(party.rgb.address(), /^bcrt1p/)
      assert.notEqual(party.rgb.address(), party.btcAddress, 'RGB vanilla keychain is separate from the party key')
      party.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
