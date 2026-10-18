// Real-chain/real-RGB funding: a same-amount historical or unrelated receive
// cannot be replayed as this loan's principal; only its exact post-lock invoice.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BorrowerAgent } from '../../src/agents/borrower.js'
import { LenderAgent, L2_POLICY } from '../../src/agents/lender.js'
import { PlatformClient } from '../../src/agents/platform-client.js'
import { Regtest } from '../../src/chain/regtest.js'
import { randomHex, randomKeyPair } from '../../src/core/crypto.js'
import { collateralFor } from '../../src/core/money.js'
import { debtOf, type LoanTerms } from '../../src/core/terms.js'
import { extractHex, finalizeEscrowSpend, partiesOf, psbtFromBase64, splitLocktime } from '../../src/escrow/escrow.js'
import { KIND } from '../../src/market/kinds.js'
import { Store } from '../../src/registry/store.js'
import { RgbRepaymentWatch } from '../../src/rgb/watch.js'
import { settle } from '../../src/rgb/wallet.js'
import { createApp, type App } from '../../src/server/app.js'
import { openParty, type Party } from '../../src/wallet/party.js'

describe('funding binds the actual collateral and the exact borrower invoice on regtest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-funding-'))
  const regtest = new Regtest()
  const chain = regtest.chain
  const mine = (n = 1) => regtest.mine(n)
  let app: App, client: PlatformClient
  let borrowerParty: Party, lenderParty: Party
  let borrower: BorrowerAgent, lender: LenderAgent
  before(async () => {
    await regtest.ensureMiner()
    app = createApp({ platformKey: randomKeyPair(), store: new Store(), chain, initialPriceCents: 10_000_000, blocksPerMonth: 30, relays: [], repayments: new RgbRepaymentWatch(join(dir, 'watch')) })
    client = new PlatformClient(`http://127.0.0.1:${await app.api.listen(0, '127.0.0.1')}`)
    borrowerParty = await openParty('borrower', { dir, create: true })
    lenderParty = await openParty('lender1', { dir, create: true })
  })
  after(async () => {
    borrower?.close(); lender?.close()
    borrowerParty?.close(); lenderParty?.close()
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  it('rejects both replay classes before IOU issuance, then accepts a real lock→specific-invoice transfer', async () => {
    await regtest.send(borrowerParty.btcAddress, 0.05)
    await regtest.send(borrowerParty.rgb.address(), 0.02)
    await regtest.send(lenderParty.rgb.address(), 0.1)
    await mine()
    await borrowerParty.rgb.createUtxos(5)
    await lenderParty.rgb.createUtxos(5)
    await mine()
    const assetId = lenderParty.rgb.issueNia({ ticker: 'USDT', name: 'Funding test dollars (regtest)', precision: 6, amount: 10_000_000_000 })
    const principal = 600_000_000
    // A genuine earlier receive of exactly the principal, before this loan lock.
    const old = await lenderParty.rgb.send({ invoice: borrowerParty.rgb.invoice(principal, assetId).invoice, assetId, amount: principal })
    await settle({ sender: lenderParty.rgb, receiver: borrowerParty.rgb, assetId, txid: old.txid, mine })
    const quote = await client.quote()
    const terms: LoanTerms = { v: 1, borrower_pk: borrowerParty.key.pubkey, lender_pk: lenderParty.key.pubkey, platform_pk: app.platform.pubkey, asset_id: assetId, principal, fee: 6_000_000, collateral_sats: collateralFor(606_000_000, 5000, quote.price_cents), oracle_quote: quote, open_height: quote.height, maturity_height: quote.height + 30, grace_blocks: 5, recovery_height: quote.height + 55, ladder_step: 0, ltv_bps: 5000, prev_passbook_txid: null, nonce: randomHex() }
    const { loan } = await client.registerLoan(terms)
    borrower = new BorrowerAgent({ party: borrowerParty, platform: client, chain, mine, assetId, inflows: [] })
    lender = new LenderAgent({ party: lenderParty, platform: client, chain, mine, assetId, policy: L2_POLICY })
    borrower.loans.set(loan.id, { terms, lender_pk: lender.pubkey })
    ;(lender as unknown as { loans: Map<string, unknown> }).loans.set(loan.id, { terms, borrower_pk: borrower.pubkey })
    const locked = await borrower.lockAndSplit(loan.id)
    const local = borrower.loans.get(loan.id)!
    assert.ok(local.disbursement_invoice && local.disbursement_recipient_id)
    let iousIssued = 0
    const issue = borrower.iou.issue.bind(borrower.iou)
    borrower.iou.issue = async (...args) => { iousIssued++; return issue(...args) }
    await lender.relay.send(KIND.FUNDED, { loan_id: loan.id, disbursement_txid: old.txid }, borrower.pubkey)
    await assert.rejects(borrower.awaitFunding(loan.id), /confirm after this loan collateral lock/)
    assert.equal(local.disbursement_txid, undefined)
    assert.equal(iousIssued, 0)
    // A genuine new receive after the lock, but to a different invoice.
    // The lender's wallet is under its policy gate once the agent exists: even this test transfer goes through it.
    const unrelated = await lender.sendRgb({ invoice: borrowerParty.rgb.invoice(principal, assetId).invoice, assetId, amount: principal }, { action: 'fund', counterparty: borrower.pubkey, recipientOwner: borrower.pubkey, reason: 'test: a payment to another invoice' })
    const other = await settle({ sender: lenderParty.rgb, receiver: borrowerParty.rgb, assetId, txid: unrelated.txid, mine })
    assert.notEqual(other.received.recipientId, local.disbursement_recipient_id)
    assert.ok((await chain.getTx(unrelated.txid))!.height! > (await chain.getTx(locked.lock_txid))!.height!)
    await lender.relay.send(KIND.FUNDED, { loan_id: loan.id, disbursement_txid: unrelated.txid }, borrower.pubkey)
    await assert.rejects(borrower.awaitFunding(loan.id), /does not settle this loan disbursement invoice/)
    assert.equal(local.disbursement_txid, undefined)
    assert.equal(iousIssued, 0)
    // The real lender consumes the canonical borrower-signed split and pays
    // the exact invoice saved after this lock. No monetary result is mocked.
    const funded = await lender.fund(loan.id)
    await assert.rejects(lender.fund(loan.id), /already attempted/)
    assert.equal(await borrower.awaitFunding(loan.id), funded.disbursement_txid)
    await lender.awaitIou(loan.id)
    const received = borrowerParty.rgb.transferByTxid(assetId, funded.disbursement_txid, 'ReceiveWitness')!
    assert.equal(received.status, 'Settled')
    assert.equal(received.amount, principal)
    assert.equal(received.recipientId, local.disbursement_recipient_id)
    assert.equal(iousIssued, 1)
    assert.equal(lenderParty.rgb.balance(local.iou!.asset_id).settled, debtOf(terms))
    await assert.rejects(borrower.awaitFunding(loan.id), /already verified/)
    assert.equal(iousIssued, 1, 'a repeated funding acknowledgement cannot issue a second note')
    // The canonical PSBT kept by the creditor really spends the collateral,
    // proving its imported borrower signature is usable by Bitcoin consensus.
    const saved = psbtFromBase64(readFileSync(join(dir, 'lender1', 'loans', `${loan.id}.split.psbt`), 'utf8'))
    // the default split settles at the agreed price: the lender signs it through its gate like a liquidation
    await lender.signLeaf(saved, partiesOf(terms), 'A', { action: 'liquidate', terms, counterparty: borrower.pubkey })
    finalizeEscrowSpend(saved, partiesOf(terms), 'A')
    await mine(Math.max(0, splitLocktime(terms) + 1 - await chain.getHeight()))
    const defaultTxid = await chain.rpc<string>('sendrawtransaction', [extractHex(saved)])
    await mine()
    const closed = await chain.getTx(defaultTxid)
    assert.ok(closed?.height)
    assert.ok(closed.inputs.some((i) => i.txid === locked.lock_txid && i.vout === 0))
    assert.equal(closed.outputs[0].script, lenderParty.btcScript)
    await client.settle(loan.id, defaultTxid, 'defaulted')
  })
})
