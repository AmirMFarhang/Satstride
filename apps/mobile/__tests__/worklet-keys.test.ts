// The worklet's key derivation (worklet/keys.js) gives rgb-lib's own account keys,
// so the same words open the same RGB wallet on the phone and on the laptop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mnemonicToSeedSync } from '@scure/bip39'

const require = createRequire(import.meta.url)
const { rootFromSeed, rgbKeys, fingerprintHex } = require('../worklet/keys.js')
const rgblib = require('@utexo/rgb-lib')

const WORDS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
]

test('rgb account keys from the seed equal rgb-lib restoreKeys from the words', () => {
  for (const words of WORDS) {
    const root = rootFromSeed(mnemonicToSeedSync(words))
    const mine = rgbKeys(root)
    const lib = rgblib.restoreKeys(rgblib.BitcoinNetwork.Regtest, words)
    assert.equal(mine.accountXpubVanilla, lib.accountXpubVanilla)
    assert.equal(mine.accountXpubColored, lib.accountXpubColored)
    assert.equal(mine.masterFingerprint, lib.masterFingerprint)
    assert.equal(fingerprintHex(root), lib.masterFingerprint)
    assert.match(mine.accountXpubVanilla, /^tpub/)
  }
})

test('the module refuses anything but a seed, and gives out no private key', () => {
  assert.throws(() => rootFromSeed(new Uint8Array(10)))
  assert.throws(() => rootFromSeed('abandon' as unknown as Uint8Array))
  const keys = rgbKeys(rootFromSeed(mnemonicToSeedSync(WORDS[0])))
  assert.deepEqual(Object.keys(keys).sort(), ['accountXpubColored', 'accountXpubVanilla', 'masterFingerprint', 'vanillaKeychain'])
  assert.ok(!JSON.stringify(keys).includes('tprv'))
})
