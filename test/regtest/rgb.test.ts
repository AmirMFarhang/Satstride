// Real RGB on regtest: needs `infra/regtest.sh start` and Node 22 (see .nvmrc).
// Two fresh wallets; the issuer issues USDT (precision 6) and pays a witness invoice
// with donation=true; one block settles it on both sides.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import WalletManager from '@tetherto/wdk-wallet'
import { Regtest } from '../../src/chain/regtest.js'
import { RgbWallet, settle } from '../../src/rgb/wallet.js'

describe('rgb on regtest', () => {
  const regtest = new Regtest()
  const dir = mkdtempSync(join(tmpdir(), 'passbook-rgb-'))
  let issuer: RgbWallet
  let receiver: RgbWallet

  before(async () => {
    await regtest.ensureMiner()
    issuer = await RgbWallet.open(WalletManager.getRandomSeedPhrase(), join(dir, 'issuer'))
    receiver = await RgbWallet.open(WalletManager.getRandomSeedPhrase(), join(dir, 'receiver'))
    await regtest.send(issuer.address(), 0.1)
    await regtest.mine(1)
  })

  after(() => {
    issuer?.close()
    receiver?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('issues USDT and settles a witness transfer to a wallet with no UTXOs', async () => {
    assert.equal(issuer.btcBalance().vanilla.settled, 10_000_000)
    assert.ok((await issuer.createUtxos(3)) >= 1)
    await regtest.mine(1)

    const assetId = issuer.issueNia({ ticker: 'USDT', name: 'Tether USD (regtest stand-in)', precision: 6, amount: 1_000_000_000_000 })
    assert.match(assetId, /^rgb:/)
    assert.equal(issuer.balance(assetId).settled, 1_000_000_000_000)
    assert.equal(receiver.knowsAsset(assetId), false)

    const inv = receiver.invoice(600_000_000, assetId)
    assert.match(inv.recipientId, /:wvout:/)
    const { txid } = await issuer.send({ invoice: inv.invoice, assetId, amount: 600_000_000 })
    assert.ok(await regtest.chain.getTx(txid), 'sender broadcast without waiting for an ack')

    const { sent, received } = await settle({ sender: issuer, receiver, assetId, txid, mine: () => regtest.mine(1) })
    assert.equal(sent.amount, 600_000_000)
    assert.equal(received.kind, 'ReceiveWitness')
    assert.equal(received.amount, 600_000_000)
    assert.equal(received.receiveUtxo?.startsWith(txid), true)
    const tx = await regtest.chain.getTx(txid)
    assert.ok(tx?.height, 'transfer transaction confirmed on chain')

    assert.equal(receiver.balance(assetId).settled, 600_000_000)
    assert.equal(issuer.balance(assetId).settled, 1_000_000_000_000 - 600_000_000)

    // and back: a sender pays the witness output and fees from free colored UTXOs,
    // so the receiver creates some first
    await regtest.send(receiver.address(), 0.01)
    await regtest.mine(1)
    assert.ok((await receiver.createUtxos(2)) >= 1)
    await regtest.mine(1)
    const back = issuer.invoice(100_000_000, assetId)
    const ret = await receiver.send({ invoice: back.invoice, assetId, amount: 100_000_000 })
    await settle({ sender: receiver, receiver: issuer, assetId, txid: ret.txid, mine: () => regtest.mine(1) })
    assert.equal(receiver.balance(assetId).settled, 500_000_000)
  })
})
