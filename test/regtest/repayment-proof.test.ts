// The lender takes the USDT and never signs: the platform validates the RGB
// repayment itself and co-signs the release through leaf C. Real bitcoind, real
// rgb-lib transfers, the platform over HTTP with its own watch-only RGB wallet,
// and the borrower agent's leaf C path. Needs `infra/regtest.sh start` and Node 22.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BorrowerAgent } from '../../src/agents/borrower.js'
import { PlatformClient } from '../../src/agents/platform-client.js'
import { Regtest } from '../../src/chain/regtest.js'
import { randomHex, randomKeyPair } from '../../src/core/crypto.js'
import { collateralFor } from '../../src/core/money.js'
import { debtOf, type LoanTerms } from '../../src/core/terms.js'
import { buildEscrowSpend, buildLock, extractHex, partiesOf, releaseOutputs, signKeyPath } from '../../src/escrow/escrow.js'
import { Store } from '../../src/registry/store.js'
import { openRepaymentAccount, repaymentMnemonic, RgbRepaymentWatch, watchKeys } from '../../src/rgb/watch.js'
import { settle, type RgbWallet } from '../../src/rgb/wallet.js'
import { createApp, type App } from '../../src/server/app.js'
import { fundingNotice, repaymentWatchRequest } from '../../src/server/platform.js'
import { openParty, type Party } from '../../src/wallet/party.js'

describe('repayment proof without the lender, on regtest', () => {
  const regtest = new Regtest()
  const chain = regtest.chain
  const dir = mkdtempSync(join(tmpdir(), 'passbook-proof-'))
  const mine = (n = 1) => regtest.mine(n)
  let app: App
  let client: PlatformClient
  let borrower: Party
  let lender: Party
  let account: RgbWallet | undefined
  let agent: BorrowerAgent | undefined

  before(async () => {
    await regtest.ensureMiner()
    app = createApp({ platformKey: randomKeyPair(), store: new Store(), chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], repayments: new RgbRepaymentWatch(join(dir, 'platform-watch')) })
    client = new PlatformClient(`http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`)
    borrower = await openParty('borrower', { dir, create: true })
    lender = await openParty('lender1', { dir, create: true })
  })

  after(async () => {
    agent?.close()
    account?.close()
    borrower?.close()
    lender?.close()
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('validates the consignment for its own invoice and co-signs leaf C when the lender stays silent', async () => {
    // wallets: BTC for the borrower's collateral, colored UTXOs for both RGB senders, USDT issued by the lender
    const collateralFunding = await regtest.send(borrower.btcAddress, 0.05)
    await regtest.send(borrower.rgb.address(), 0.01)
    await regtest.send(lender.rgb.address(), 0.1)
    await mine()
    assert.ok((await lender.rgb.createUtxos(3)) >= 1)
    assert.ok((await borrower.rgb.createUtxos(2)) >= 1)
    await mine()
    const assetId = lender.rgb.issueNia({ ticker: 'USDT', name: 'Tether USD (regtest stand-in)', precision: 6, amount: 1_000_000_000_000 })

    const state = await client.state()
    const quote = await client.quote()
    const principal = 600_000_000
    const fee = 6_000_000
    const terms: LoanTerms = {
      v: 1,
      borrower_pk: borrower.key.pubkey,
      lender_pk: lender.key.pubkey,
      platform_pk: state.platform_pk,
      asset_id: assetId,
      principal,
      fee,
      collateral_sats: collateralFor(principal + fee, 5000, quote.price_cents),
      oracle_quote: quote,
      open_height: quote.height,
      maturity_height: quote.height + 30,
      grace_blocks: 5,
      recovery_height: quote.height + 55,
      ladder_step: 0,
      ltv_bps: 5000,
      prev_passbook_txid: null,
      nonce: randomHex(32),
    }
    const { loan } = await client.registerLoan(terms)

    // lock
    const fundTx = (await chain.getTx(collateralFunding))!
    const vout = fundTx.outputs.findIndex((o) => o.script === borrower.btcScript)
    const lock = buildLock({ inputs: [{ txid: collateralFunding, vout, value: fundTx.outputs[vout].value, internal_pk: borrower.key.pubkey }], terms, changeScript: borrower.btcScript })
    signKeyPath(lock, borrower.key.secretKey).finalizeAllInputs()
    const lockTxid = await chain.rpc<string>('sendrawtransaction', [extractHex(lock)])
    await mine()
    await client.recordLock(loan.id, lockTxid)

    // disbursement over RGB; the borrower also holds the fee from before
    const disb = await lender.rgb.send({ invoice: borrower.rgb.invoice(principal, assetId).invoice, assetId, amount: principal })
    await settle({ sender: lender.rgb, receiver: borrower.rgb, assetId, txid: disb.txid, mine })
    await client.recordFunded(loan.id, disb.txid, fundingNotice(lender.key, loan.id, disb.txid))
    const own = await lender.rgb.send({ invoice: borrower.rgb.invoice(fee, assetId).invoice, assetId, amount: fee })
    await settle({ sender: lender.rgb, receiver: borrower.rgb, assetId, txid: own.txid, mine })

    // the lender's repayment account: the platform issues the invoice from a watch-only copy
    const mnemonic = repaymentMnemonic(lender.key.secretKey, loan.id)
    const keys = await watchKeys(mnemonic)
    const issued = await client.repaymentWatch(loan.id, keys, repaymentWatchRequest(lender.key, loan.id, keys))
    assert.match(issued.recipient_id, /:wvout:/)
    await assert.rejects(client.repaymentWatch(loan.id, keys, repaymentWatchRequest(lender.key, loan.id, keys)), /refused/, 'one invoice per loan')
    account = await openRepaymentAccount(mnemonic, join(dir, 'lender-repayment'), issued)
    const record = await client.loan(loan.id)
    assert.equal(record.repayment_watch?.invoice, issued.invoice)
    assert.equal(record.repayment_watch && 'account_xpub_colored' in record.repayment_watch, false, 'xpubs stay with the platform')

    // nothing paid yet: no proof, no signature
    const parties = partiesOf(terms)
    const leafC = buildEscrowSpend({ escrow: { txid: lockTxid, vout: 0, value: terms.collateral_sats }, parties, leaf: 'C', outputs: releaseOutputs(terms) })
    const early = await client.cosign({ loan_id: loan.id, purpose: 'release', psbt: leafC.toBase64() })
    assert.ok(!early.ok && !early.psbt)
    assert.ok(early.checks.some((c) => c.id === 'proof' && !c.ok))
    assert.ok((await client.verifyRepayment(loan.id)).checks.some((c) => c.id === 'consignment' && !c.ok))

    // the borrower repays to the platform-issued invoice; the lender's account settles it and the lender stays silent
    const debt = debtOf(terms)
    const repay = await borrower.rgb.send({ invoice: issued.invoice, assetId, amount: debt })
    const { received } = await settle({ sender: borrower.rgb, receiver: account, assetId, txid: repay.txid, mine })
    assert.equal(received.amount, debt)
    assert.equal(account.balance(assetId).settled, debt, 'the USDT is in the lender\'s own account')
    assert.equal((await client.loan(loan.id)).repayment_proof, undefined)

    // the borrower agent's path: validate, leaf C with the platform, broadcast, record. This is the
    // platform wallet's first refresh since the witness confirmed: validation and settlement in one call
    agent = new BorrowerAgent({ party: borrower, platform: client, chain, mine, assetId, inflows: [] })
    agent.loans.set(loan.id, { terms, lender_pk: lender.key.pubkey, lock: { txid: lockTxid, vout: 0 }, repayment_txid: repay.txid })
    // Exercise the automatic path when the lender disappears, rather than calling the fallback directly.
    agent.relay.send = async (_kind, _payload) => ({}) as never
    agent.relay.receive = async () => { throw new Error('timed out waiting for lender') }
    const releaseTxid = await agent.release(loan.id)

    const closed = await client.loan(loan.id)
    assert.equal(closed.status, 'repaid')
    assert.equal(closed.repayment_proof, 'rgb_consignment')
    assert.equal(closed.repayment_txid, repay.txid)
    const tx = await chain.getTx(releaseTxid)
    assert.ok(tx?.height, 'release confirmed')
    assert.deepEqual(tx!.inputs.map((i) => `${i.txid}:${i.vout}`), [`${lockTxid}:0`])
    assert.equal(tx!.outputs[0].script, borrower.btcScript)
    assert.equal(tx!.outputs[0].value, releaseOutputs(terms)[0].value)
    const raw = await chain.rpc<{ vin: { txinwitness: string[] }[] }>('getrawtransaction', [releaseTxid, true])
    assert.equal(raw.vin[0].txinwitness[2], Buffer.from(leafC.data.inputs[0].tapLeafScript![0].script).toString('hex'), 'spent through leaf C')
    // a wrong claim does not pass
    assert.ok((await client.verifyRepayment(loan.id, disb.txid)).checks.some((c) => c.id === 'claimed' && !c.ok))
    const pb = await client.passbook(borrower.key.pubkey)
    assert.equal(pb.pages[0].outcome, 'on_time')
    assert.equal(pb.unverified, 0)
  })
})
