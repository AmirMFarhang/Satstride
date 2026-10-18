// Mainnet is read, never spent: no code path builds or signs a mainnet
// transaction while the loan chain is regtest or signet, and the credit agent
// never takes a mainnet key or seed.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as bitcoin from 'bitcoinjs-lib'
import { NETWORK } from '../src/escrow/escrow.js'
import { rgbConfigFromEnv } from '../src/rgb/wallet.js'
import { assertTxNetwork, assertTxNetworks, loanChainFromEnv, MainnetTransactionRefused, refuseSecret, txNetworkProblems } from '../src/networks/guard.js'
import { BIP322_TEST_KEYS, testSignBip322 } from './networks-signer.js'

const SRC = new URL('../src/', import.meta.url).pathname
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [] })
}
const rel = (p: string) => p.slice(SRC.length)

describe('mainnet transaction guard', () => {
  it('refuses mainnet transaction parameters while the loan chain is regtest or signet', () => {
    for (const loan of ['regtest', 'signet'] as const) {
      assert.throws(() => assertTxNetwork(bitcoin.networks.bitcoin, loan), MainnetTransactionRefused)
      assert.doesNotThrow(() => assertTxNetwork(bitcoin.networks.regtest, loan))
      assert.doesNotThrow(() => assertTxNetwork(bitcoin.networks.testnet, loan))
      assert.equal(txNetworkProblems({ loanChain: loan, escrowBech32: 'bc', rgbNetwork: 'regtest' }).length, 1)
      assert.equal(txNetworkProblems({ loanChain: loan, escrowBech32: 'bcrt', rgbNetwork: 'mainnet' }).length, 1)
      assert.throws(() => assertTxNetworks({ loanChain: loan, escrowBech32: 'bc', rgbNetwork: 'mainnet' }), /refusing to build or sign a mainnet transaction/)
    }
  })

  it('holds for this build: the escrow and the RGB wallet sign for the loan chain only', () => {
    const loanChain = loanChainFromEnv({})
    assert.equal(loanChain, 'regtest')
    assert.notEqual(NETWORK.bech32, 'bc')
    assert.deepEqual(txNetworkProblems({ loanChain, escrowBech32: NETWORK.bech32, rgbNetwork: rgbConfigFromEnv().network }), [])
    assert.throws(() => loanChainFromEnv({ PASSBOOK_LOAN_CHAIN: 'mainnet' }), /must be regtest, signet or bitcoin/)
  })

  it('every transaction builder in src/ names its network (bitcoinjs defaults to mainnet otherwise)', () => {
    const offenders: string[] = []
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8')
      // each builder call sits on one line in this codebase; the network must be named on it
      for (const line of text.split('\n')) {
        if (/new (bitcoin\.)?Psbt\(|Psbt\.from(Base64|Hex|Buffer)\(|payments\.p2\w+\(/.test(line) && !/network/.test(line)) offenders.push(`${rel(f)}: ${line.trim().slice(0, 80)}`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  it('mainnet parameters appear only in the read-only address formatter', () => {
    const users = files(SRC).filter((f) => /networks\.bitcoin\b/.test(readFileSync(f, 'utf8'))).map(rel)
    assert.deepEqual(users, ['networks/bip322.ts'])
    const text = readFileSync(join(SRC, 'networks/bip322.ts'), 'utf8')
    assert.match(text, /export function scriptToAddress[\s\S]*?networks\.bitcoin/)
    assert.ok(!/Psbt|\.sign\(|signPsbt/.test(text))
  })

  it('the credit agent code (src/networks) builds and signs no transaction and touches no key material', () => {
    for (const f of files(join(SRC, 'networks'))) {
      const text = readFileSync(f, 'utf8')
      for (const banned of [/Psbt/, /signPsbt/, /secp256k1\.sign\(/, /schnorr\.sign\(/, /fromWIF|toWIF/, /mnemonic|bip39/i, /HDKey|fromMasterSeed/, /\.addOutput\([^)]*\)[\s\S]{0,200}\.sign/, /broadcast|sendrawtransaction/i]) {
        assert.ok(!banned.test(text), `${rel(f)} matches ${banned}`)
      }
    }
    // the only signatures made there are the borrower's Passbook key over its own consent and an RGB challenge text
    const signers = files(join(SRC, 'networks')).filter((f) => /signHash\(/.test(readFileSync(f, 'utf8'))).map(rel).sort()
    assert.deepEqual(signers, ['networks/policy.ts', 'networks/rgb.ts'])
  })

  it('the BIP-322 virtual transactions cannot be mined: to_spend spends the null outpoint', async () => {
    const { toSpendTx, toSignTx } = await import('../src/networks/bip322.js')
    const t = toSpendTx(new Uint8Array(32), Uint8Array.of(0x51, 0x20, ...new Uint8Array(32)))
    assert.deepEqual([...t.ins[0].hash], new Array(32).fill(0))
    assert.equal(t.ins[0].index, 0xffffffff)
    assert.equal(t.outs[0].value, 0n)
    const s = toSignTx(t)
    assert.equal(s.outs[0].value, 0n)
    assert.deepEqual([...s.outs[0].script], [0x6a])
  })
})

describe('proofs only: no mainnet key or seed is ever taken', () => {
  it('refuses a WIF, an extended private key, a hex secret and a seed phrase, without echoing them', () => {
    const secrets = [
      BIP322_TEST_KEYS.p2wpkh.wif,
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
      `0x${'1f'.repeat(32)}`,
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ]
    for (const s of secrets) {
      assert.throws(() => refuseSecret(s, 'signature'), (e: Error) => /Never paste/.test(e.message) && !e.message.includes(s))
    }
  })

  it('accepts what a person actually pastes: a BIP-322 signature and an address', () => {
    const { address, wif } = BIP322_TEST_KEYS.p2wpkh
    for (let i = 0; i < 20; i++) assert.doesNotThrow(() => refuseSecret(testSignBip322(address, `challenge ${i}`, wif), 'signature'))
    assert.doesNotThrow(() => refuseSecret(address, 'address'))
    assert.doesNotThrow(() => refuseSecret(BIP322_TEST_KEYS.p2tr.address, 'address'))
  })

  it('the agent CLI and server panel have no option that takes a key or seed', () => {
    for (const f of ['cli/agent.ts', 'server/layers.ts']) {
      const text = readFileSync(join(SRC, f), 'utf8')
      assert.ok(!/--(seed|mnemonic|wif|xprv|private-key|privkey|secret)\b/.test(text), f)
      assert.ok(!/body\.(seed|mnemonic|wif|xprv|private_key|secret)\b/.test(text), f)
    }
  })
})
