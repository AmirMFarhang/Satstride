import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BitcoindChain } from '../src/chain/bitcoind.js'
import { randomKeyPair } from '../src/core/crypto.js'
import { RgbHistoryObserver } from '../src/rgb/history-observer.js'
import type { RgbWallet } from '../src/rgb/wallet.js'

describe('observer coverage and journal integrity without a chain mock result', () => {
  it('persists ambiguous-send failure across restart and refuses to reset the history origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-journal-')), signer = randomKeyPair(), borrower = randomKeyPair()
    const wallet = { dataDir: join(dir, 'wallet'), refresh: () => {}, transfers: () => [], balance: () => ({ settled: 0, future: 0 }) } as unknown as RgbWallet
    const cfg = { rootDir: join(dir, 'journal'), signer, chain: BitcoindChain.fromEnv() }
    let observer = new RgbHistoryObserver(cfg)
    try {
      observer.registerFreshWallet({ borrowerPk: borrower.pubkey, wallet, assetId: 'rgb:test', watchKeys: { account_xpub_vanilla: 'public', account_xpub_colored: 'public', master_fingerprint: '12345678' } })
      observer.ambiguous(wallet.dataDir, 'recipient', 'rgb:test')
      await assert.rejects(observer.proof(borrower.pubkey), /incomplete coverage/)
      observer.close(); observer = new RgbHistoryObserver(cfg); observer.attachWallet(borrower.pubkey, wallet)
      await assert.rejects(observer.proof(borrower.pubkey), /incomplete coverage/)
      assert.throws(() => observer.registerFreshWallet({ borrowerPk: borrower.pubkey, wallet, assetId: 'rgb:test', watchKeys: {} as never }), /already registered/)
    } finally { observer.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('rejects tampered journal contents and relabelled wallet identities before native verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-journal-')), signer = randomKeyPair(), borrower = randomKeyPair()
    const wallet = { dataDir: join(dir, 'wallet'), refresh: () => {}, transfers: () => [], balance: () => ({ settled: 0, future: 0 }) } as unknown as RgbWallet
    const observer = new RgbHistoryObserver({ rootDir: dir, signer, chain: BitcoindChain.fromEnv() })
    try {
      observer.registerFreshWallet({ borrowerPk: borrower.pubkey, wallet, assetId: 'rgb:test', watchKeys: { account_xpub_vanilla: 'public', account_xpub_colored: 'public', master_fingerprint: '12345678' } })
      assert.throws(() => observer.identifyWallet(randomKeyPair().pubkey, wallet), /cannot be relabelled/)
      const file = join(dir, `${borrower.pubkey}.json`), j = JSON.parse(readFileSync(file, 'utf8')); j.incomplete = false; j.asset_id = 'rgb:other'; writeFileSync(file, JSON.stringify(j))
      assert.throws(() => observer.attachWallet(borrower.pubkey, wallet), /signature invalid/)
    } finally { observer.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
