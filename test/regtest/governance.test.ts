// The policy gate on a real RGB wallet (regtest): once a wallet is enrolled,
// a send without the gate's token is refused before anything is built or
// signed, WDK's own policy engine (registerPolicy) refuses to sign a PSBT that
// did not come through a verified token, a token for another transfer is
// refused, and the governed send settles with its signature in the log.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import WalletManager from '@tetherto/wdk-wallet'
import { Regtest } from '../../src/chain/regtest.js'
import { randomKeyPair } from '../../src/core/crypto.js'
import { NodeGovernance } from '../../src/governance/node.js'
import { verifyLog } from '../../src/governance/log.js'
import { RgbWallet, settle } from '../../src/rgb/wallet.js'
import { partyKeyFromSeed, SigningRefused } from '../../src/wallet/signer.js'

describe('policy gate on a real RGB wallet', () => {
  const regtest = new Regtest()
  const dir = mkdtempSync(join(tmpdir(), 'passbook-gov-rgb-'))
  const seed = WalletManager.getRandomSeedPhrase()
  let lender: RgbWallet
  let borrower: RgbWallet
  let gov: NodeGovernance

  before(async () => {
    await regtest.ensureMiner()
    lender = await RgbWallet.open(seed, join(dir, 'lender', 'rgb'))
    borrower = await RgbWallet.open(WalletManager.getRandomSeedPhrase(), join(dir, 'borrower', 'rgb'))
    await regtest.send(lender.address(), 0.1)
    await regtest.mine(1)
  })

  after(() => {
    lender?.close()
    borrower?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses an ungoverned send and an unauthorised PSBT, then settles the governed one', async () => {
    assert.ok((await lender.createUtxos(3)) >= 1)
    await regtest.mine(1)
    const assetId = lender.issueNia({ ticker: 'USDT', name: 'test USDT (regtest)', precision: 6, amount: 1_000_000_000 })
    gov = new NodeGovernance({ ownerKey: partyKeyFromSeed(seed), dir: join(dir, 'lender', 'governance') })
    await gov.enrollWallet(lender)
    const borrowerPk = randomKeyPair().pubkey
    const inv = borrower.invoice(600_000_000, assetId)
    const opts = { invoice: inv.invoice, assetId, amount: 600_000_000 }
    const sendsBefore = lender.transfers(assetId).filter((t) => t.kind === 'Send').length

    await assert.rejects(lender.send(opts), (e: unknown) => e instanceof SigningRefused && e.code === 'NO_GATE_TOKEN')
    // WDK's own policy engine: the governed account will not sign a PSBT the gate did not authorise
    const governed = (lender as unknown as { governedAccount: { signPsbt(p: string): Promise<string> } }).governedAccount
    await assert.rejects(governed.signPsbt('cHNidP8BAAoCAAAAAAAAAAAAAAAA'), /no verified Passbook gate token/)
    // a token for another amount does not pay this one
    const other = await gov.decide([{ signer: lender.signerId, kind: 'rgb-transfer', summary: lender.transferSummary({ ...opts, amount: 1 }), recipient_owner: borrowerPk }], { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrowerPk })
    await assert.rejects(lender.send({ ...opts, token: other.tokens[0] }), (e: unknown) => e instanceof SigningRefused && e.code === 'DECODED_HASH_MISMATCH')
    assert.equal(lender.transfers(assetId).filter((t) => t.kind === 'Send').length, sendsBefore, 'nothing was sent')

    const { txid } = await gov.sendRgb(lender, opts, { action: 'fund', initiator: { agent: 'lender1' }, counterparty: borrowerPk, recipientOwner: borrowerPk })
    const { received } = await settle({ sender: lender, receiver: borrower, assetId, txid, mine: () => regtest.mine(1) })
    assert.equal(received.amount, 600_000_000)
    const log = gov.gate.log.entries()
    assert.deepEqual(verifyLog(log), [])
    assert.ok(log.some((e) => e.kind === 'signature' && (e.detail as { signer: string }).signer === lender.signerId))
    const reservation = gov.gate.store.read().reservations.find((r) => r.txids?.includes(txid))
    assert.equal(reservation?.status, 'committed')
  })
})
