// The lender's side of platform fees, without a chain: LenderAgent.payPlatformFees
// asks the platform for a payable invoice before paying, and the standalone peer
// CLI (src/cli/peer-fees.ts) pays with approval before publishing and after its
// loan closes, refusing with the way to pay when the lender stays blocked.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlatformClient } from '../src/agents/platform-client.js'
import { L2_POLICY, LenderAgent } from '../src/agents/lender.js'
import type { Relay } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import type { BitcoindChain } from '../src/chain/bitcoind.js'
import { keyPairFromLabel, randomHex, type Hex } from '../src/core/crypto.js'
import { payFeesCommand, settleBeforePublishing, settleClosedLoan, type FeePayer } from '../src/cli/peer-fees.js'
import { OUTSTANDING_FEE_MESSAGE, type FeeRecord } from '../src/server/fees.js'
import type { Party } from '../src/wallet/party.js'

const lenderKey = keyPairFromLabel('fees-lender-agent')
const ASSET = 'rgb:fees-lender'

function fee(over: Partial<FeeRecord> = {}): FeeRecord {
  return { loan_id: randomHex(), lender_pk: lenderKey.pubkey, asset_id: ASSET, outcome: 'repaid_on_time', interest: 5_920_000, share_bps: 1500, share_basis: 'registered', amount: 890_000, status: 'fee_due', invoice: 'rgb:invoice/old', recipient_id: 'old', closed_height: 100, grace_until_height: 106, created_at: 0, updated_at: 0, ...over }
}

/** A platform that knows `fees`; feeInvoice issues 'rgb:invoice/<loan>' unless the loan is in `unpayable`. */
function fakePlatform(fees: FeeRecord[], opts: { blocked?: string | null; unpayable?: Hex[] } = {}) {
  const calls: string[] = []
  const platform = {
    fees: async () => ({ height: 120, fees, blocked: opts.blocked ?? null, economics: {} }),
    feeInvoice: async (loanId: Hex) => {
      calls.push(`invoice ${loanId.slice(0, 6)}`)
      if (opts.unpayable?.includes(loanId)) throw new Error('POST /fees (503): the platform could not issue a fee invoice yet')
      const f = fees.find((x) => x.loan_id === loanId)!
      f.invoice = `rgb:invoice/${loanId.slice(0, 6)}`
      return f
    },
    verifyFee: async (loanId: Hex, txid: Hex) => {
      calls.push(`verify ${loanId.slice(0, 6)}`)
      const f = fees.find((x) => x.loan_id === loanId)!
      Object.assign(f, { status: 'fee_paid', paid_txid: txid })
      return { ok: true, checks: [], fee: f }
    },
    note: async () => ({ ok: true }),
  }
  return { platform, calls }
}

function agent(platform: unknown, sent: { invoice: string; amount: number }[]) {
  const rgb = {
    dataDir: '/nonexistent/rgb',
    send: async (o: { invoice: string; amount: number }) => { sent.push({ invoice: o.invoice, amount: o.amount }); return { txid: randomHex(), batchTransferIdx: 0 } },
    refresh: () => {},
    transferByTxid: () => ({ status: 'Settled', kind: 'Send' }),
    createUtxos: async () => 0,
    // what the policy gate decodes before a send (rgb/wallet.ts transferSummary)
    signerId: 'rgb:fees-lender-double',
    transferSummary: (o: { invoice: string; assetId: string; amount: number }) => ({ kind: 'rgb-transfer', network: 'regtest', asset_id: o.assetId, amount: o.amount, recipient_id: o.invoice, witness: true, witness_sats: 1000, transport_endpoints: [], invoice_sha256: '' }),
  }
  const party = { role: 'lender1', key: lenderKey, rgb } as unknown as Party
  const relay = { close: () => {} } as unknown as Relay
  const chain = { getHeight: async () => 120 } as unknown as BitcoindChain
  return new LenderAgent({ party, platform: platform as PlatformClient, relay, chain, reasoner: new RuleReasoner(), policy: L2_POLICY, assetId: ASSET, lightning: null, mine: async () => {} })
}

describe('the lender pays its platform fees', () => {
  it('asks for a payable invoice first, pays with it, and skips one the platform cannot invoice yet', async () => {
    const missing = fee({ invoice: null, recipient_id: null })
    const stale = fee()
    const unpayable = fee({ invoice: null, recipient_id: null })
    const { platform, calls } = fakePlatform([missing, stale, unpayable, fee({ status: 'fee_paid' })], { unpayable: [unpayable.loan_id] })
    const sent: { invoice: string; amount: number }[] = []
    const paid = await agent(platform, sent).payPlatformFees()
    assert.deepEqual(paid.map((f) => f.loan_id), [missing.loan_id, stale.loan_id])
    assert.deepEqual(sent.map((s) => s.invoice), [`rgb:invoice/${missing.loan_id.slice(0, 6)}`, `rgb:invoice/${stale.loan_id.slice(0, 6)}`], 'paid into the invoices the platform just handed out')
    assert.equal(unpayable.status, 'fee_due')
    assert.ok(calls.includes(`invoice ${unpayable.loan_id.slice(0, 6)}`) && !calls.includes(`verify ${unpayable.loan_id.slice(0, 6)}`))
  })

  it('refuses to publish while blocked, and says how to pay', async () => {
    const { platform } = fakePlatform([fee()], { blocked: OUTSTANDING_FEE_MESSAGE })
    await assert.rejects(agent(platform, []).publishOffer(), (err: Error) => err.message.startsWith(OUTSTANDING_FEE_MESSAGE) && err.message.includes('0.89 USDT') && err.message.includes(payFeesCommand('lender1', ASSET)))
  })
})

describe('the standalone peer CLI settles fees with approval', () => {
  /** A lender whose payment clears every due fee and the block. */
  function payer(fees: FeeRecord[], blocked: string | null): FeePayer & { paidWith: unknown[] } {
    let block = blocked
    const paidWith: unknown[] = []
    return {
      pubkey: lenderKey.pubkey,
      paidWith,
      platform: { fees: async () => ({ height: 120, fees, blocked: block }) },
      payPlatformFees: async (opts = {}) => {
        paidWith.push(opts)
        const paid = fees.filter((f) => f.status === 'fee_due' && (!opts.loanId || f.loan_id === opts.loanId))
        for (const f of paid) f.status = 'fee_paid'
        block = null
        return paid
      },
    }
  }

  it('pays overdue fees before publishing when the operator approves', async () => {
    const lender = payer([fee(), fee({ grace_until_height: 200 })], OUTSTANDING_FEE_MESSAGE)
    const asked: string[] = []
    const paid = await settleBeforePublishing(lender, async (m) => { asked.push(m); return true }, payFeesCommand('lender1', ASSET))
    assert.equal(paid.length, 2)
    assert.equal(asked.length, 1, 'one approval for all of them')
    assert.match(asked[0], /Pay the platform 1\.78 USDT in fees .* It can't be undone\./)
    assert.match(asked[0], /OVERDUE/)
    assert.match(asked[0], /due by block 200/)
  })

  it('refuses with the way to pay when declined while blocked, and goes on when not yet blocked', async () => {
    await assert.rejects(settleBeforePublishing(payer([fee()], OUTSTANDING_FEE_MESSAGE), async () => false, payFeesCommand('lender1', ASSET)), (err: Error) => err.message.startsWith(OUTSTANDING_FEE_MESSAGE) && err.message.includes('Payment was declined') && err.message.includes('--pay-fees'))
    const notYet = payer([fee({ grace_until_height: 200 })], null)
    assert.deepEqual(await settleBeforePublishing(notYet, async () => false, payFeesCommand('lender1', ASSET)), [])
    assert.deepEqual(notYet.paidWith, [])
    const nothing = payer([], null)
    assert.deepEqual(await settleBeforePublishing(nothing, async () => { throw new Error('no question when nothing is due') }, 'x'), [])
  })

  it("waits for this run's loan to be invoiced, then pays only that fee", async () => {
    const mine = fee({ grace_until_height: 200 })
    const other = fee({ grace_until_height: 200 })
    const fees: FeeRecord[] = [other]
    const lender = payer(fees, null)
    setTimeout(() => fees.push(mine), 30)
    const r = await settleClosedLoan(lender, async () => true, mine.loan_id, { timeoutMs: 2_000, pollMs: 10 })
    assert.deepEqual([r.invoiced, r.paid.map((f) => f.loan_id)], [true, [mine.loan_id]])
    assert.deepEqual(lender.paidWith, [{ loanId: mine.loan_id }])
    assert.equal(other.status, 'fee_due')
    assert.deepEqual(await settleClosedLoan(payer([], null), async () => true, randomHex(), { timeoutMs: 30, pollMs: 10 }), { paid: [], invoiced: false })
  })
})
