import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildAuditBundle } from '../src/audit/export.js'
import { FakeChain } from '../src/chain/fake.js'
import { opReturnScript } from '../src/chain/types.js'
import { bytesToHex, hexToBytes, keyPairFromLabel, randomHex, sha256Hex, signObject } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { termsHash } from '../src/core/terms.js'
import { escrowFor, partiesOf, releaseOutputs } from '../src/escrow/escrow.js'
import { approve } from '../src/market/approvals.js'
import type { Position } from '../src/market/negotiate.js'
import { signLenderPolicy } from '../src/market/policy.js'
import { buildTermSheet, signTermSheet, type TermSheet } from '../src/market/termsheet.js'
import { Oracle } from '../src/oracle/oracle.js'
import { assembleLoanReceipt, checkLoanReceipt, readLoanReceipt, receiptPath, writeLoanReceipt, type LoanReceipt } from '../src/registry/receipt.js'
import { platformFeeOf } from '../src/server/fees.js'
import { LocalKeySigner } from '../src/wallet/signer.js'

const U = MICRO_PER_USDT
const borrower = keyPairFromLabel('receipt-borrower'), lender = keyPairFromLabel('receipt-lender'), checker = keyPairFromLabel('receipt-checker'), platform = keyPairFromLabel('receipt-platform')
const oracle = new Oracle(keyPairFromLabel('receipt-oracle'), 10_000_000)
const NOW = 1_790_000_000

function sheetFor(principal = 600 * U, preimage = randomHex()): { sheet: TermSheet; preimage: string } {
  const agreed: Position = { principal, apr_bps: 1200, ltv_bps: 5000, term_blocks: 30, settlement: 'ln-rln' }
  const atomic = { invoice: 'lnbcrt1receiptinvoice', btc_amount_msat: 3_000_000 as const, payment_hash: sha256Hex(hexToBytes(preimage)), expires_at: NOW + 40 * 86400, payee_pubkey: '02' + 'ab'.repeat(32) }
  let sheet = buildTermSheet({
    agreed, negotiation: { id: randomHex(), accept_hash: randomHex() }, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey, asset_id: 'rgb:usdt',
    oracle_quote: oracle.quote(500), grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'ln-rln', atomic },
    scorer: { provider: 'compex', scorer_id: 'compex:passbook-credit', code_measurement: 'sha256:' + '37'.repeat(32), contract_hash: 'cd'.repeat(32), trust: 'software-evidence', result_hash: 'ef'.repeat(32), fallback: false, recommendation: 'QUALIFY', evidence: { kind: 'compex-dsse', envelope_sha256: '3b'.repeat(32), evidence_root_hash: 'b9'.repeat(32), execution_id: 'gov-1' } },
    consent_hash: '12'.repeat(32), salt: randomHex(),
  })
  sheet = signTermSheet(signTermSheet(sheet, 'lender', lender.secretKey), 'borrower', borrower.secretKey)
  return { sheet, preimage }
}

/** Lock, disbursement, leaf-E release and fee payment on a fake chain, then a borrower-signed receipt. */
function world(opts: { principal?: number } = {}) {
  const { sheet, preimage } = sheetFor(opts.principal)
  const t = sheet.terms
  const chain = new FakeChain(500)
  const e = escrowFor(partiesOf(t))
  const lock = chain.addTx([{ value: t.collateral_sats, script: e.script }, { value: 0, script: opReturnScript(termsHash(t)) }])
  chain.mine()
  const disbursement = chain.addTx([{ value: 1000, script: '00' }])
  chain.mine()
  const release = chain.addTx(releaseOutputs(t), [{ txid: lock, vout: 0, witness: ['00'.repeat(64), preimage, bytesToHex(e.leaves.E!.script), bytesToHex(e.leaves.E!.controlBlock)] }])
  chain.mine()
  const feeTx = chain.addTx([{ value: 1000, script: '00' }])
  chain.mine()
  const input = (over: Partial<Omit<LoanReceipt, 'v' | 'kind' | 'loan_id' | 'evidence' | 'issued_by' | 'sig'>> = {}) => ({
    termsheet: sheet, approvals: [approve(borrower, sheet, 'borrower', NOW), approve(lender, sheet, 'lender', NOW)], lock: { txid: lock, vout: 0 }, disbursement: { txid: disbursement },
    repayment: { kind: 'ln-rln' as const, payment_hash: t.atomic_repayment!.payment_hash, preimage, release_txid: release },
    fee: { amount: platformFeeOf(t), share_bps: 1500, invoice: 'rgb:fee-invoice', status: 'fee_paid' as const, paid_txid: feeTx },
    passbook_page: { terms: t, lock_txid: lock, lock_vout: 0, outcome_txid: release, outcome: 'repaid' as const, repayment: { kind: 'atomic' as const, preimage } },
    issued_at: NOW, ...over,
  })
  return { sheet, chain, preimage, input, receipt: assembleLoanReceipt(borrower, input()) }
}
const failed = (r: { checks: { id: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.id)
const CTX = { deploymentMakerCheckerMicro: 5_000 * U }

describe('loan receipts', () => {
  it('re-check every part of an atomic loan against Bitcoin and round-trip as receipts/<loan_id>.json', async () => {
    const w = world()
    const r = await checkLoanReceipt(w.receipt, w.chain, CTX)
    assert.deepEqual(failed(r), [])
    assert.deepEqual(r.checks.map((c) => c.id), ['receipt-signature', 'termsheet', 'evidence', 'approvals', 'lock', 'disbursement', 'repayment', 'platform-fee', 'passbook-page'])
    assert.equal(w.receipt.loan_id, termsHash(w.sheet.terms), 'the loan id is the terms hash in the lock')
    const dir = mkdtempSync(join(tmpdir(), 'passbook-receipts-'))
    try {
      const path = writeLoanReceipt(dir, w.receipt)
      assert.equal(path, receiptPath(dir, w.receipt.loan_id))
      assert.deepEqual(readLoanReceipt(path), w.receipt)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fail on a wrong preimage, a wrong fee, a missing approval, another loan’s lock or page, and a stranger’s signature', async () => {
    const w = world(), other = world()
    const resign = (r: LoanReceipt) => signObject(r, borrower.secretKey)
    assert.ok(failed(await checkLoanReceipt(assembleLoanReceipt(borrower, w.input({ repayment: { ...w.receipt.repayment!, preimage: randomHex() } as LoanReceipt['repayment'] })), w.chain, CTX)).includes('repayment'))
    assert.ok(failed(await checkLoanReceipt(assembleLoanReceipt(borrower, w.input({ fee: { ...w.receipt.fee!, amount: w.receipt.fee!.amount + 1 } })), w.chain, CTX)).includes('platform-fee'))
    assert.ok(failed(await checkLoanReceipt(assembleLoanReceipt(borrower, w.input({ approvals: w.receipt.approvals.slice(0, 1) })), w.chain, CTX)).includes('approvals'))
    assert.ok(failed(await checkLoanReceipt(assembleLoanReceipt(borrower, w.input({ lock: other.receipt.lock })), w.chain, CTX)).includes('lock'))
    assert.ok(failed(await checkLoanReceipt(assembleLoanReceipt(borrower, w.input({ passbook_page: other.receipt.passbook_page })), w.chain, CTX)).includes('passbook-page'))
    assert.ok(failed(await checkLoanReceipt(resign({ ...w.receipt, evidence: { kind: 'passbook-run-record', run_record_sha256: '00'.repeat(32) } }), w.chain, CTX)).includes('evidence'))
    assert.ok(failed(await checkLoanReceipt(signObject({ ...w.receipt, issued_by: keyPairFromLabel('stranger').pubkey }, keyPairFromLabel('stranger').secretKey), w.chain, CTX)).includes('receipt-signature'))
    assert.ok(failed(await checkLoanReceipt({ ...w.receipt, fee: { ...w.receipt.fee!, amount: 1 } }, w.chain, CTX)).includes('receipt-signature'), 'any edit after signing breaks the receipt signature')
  })

  it('need the lender’s signed policy for maker-checker above the threshold', async () => {
    const w = world({ principal: 6_000 * U })
    assert.match((await checkLoanReceipt(w.receipt, w.chain, CTX)).checks.find((c) => c.id === 'approvals')!.detail, /lender approvers 1\/2 \(no lender policy/)
    const policy = await signLenderPolicy(new LocalKeySigner(lender), { asset_id: 'rgb:usdt', max_per_loan: 10_000 * U, max_outstanding: 100_000 * U, min_apr_bps: 1000, max_ltv_bps: 5500, term_blocks: { min: 10, max: 60 }, required_checks: [], min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb', 'ln-rln'], approval_rules: { approvers: [checker.pubkey], maker_checker_above: 5_000 * U }, issued_at: 1 })
    const both = assembleLoanReceipt(borrower, w.input({ approvals: [...w.receipt.approvals, approve(checker, w.sheet, 'lender', NOW)] }))
    assert.deepEqual(failed(await checkLoanReceipt(both, w.chain, { ...CTX, lenderPolicy: policy })), [])
    const edited = { ...policy, approval_rules: { ...policy.approval_rules, maker_checker_above: 1_000_000 * U } }
    assert.ok(failed(await checkLoanReceipt(w.receipt, w.chain, { ...CTX, lenderPolicy: edited })).includes('approvals'), 'an edited policy is not trusted')
  })

  it('are attached to the audit export only as verified', async () => {
    const w = world()
    const rc = await checkLoanReceipt(w.receipt, w.chain, CTX)
    const verified = buildAuditBundle({ termsheet: w.sheet, receipt: w.receipt, receipt_check: rc }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 5_000 * U })
    assert.equal(verified.checks.find((c) => c.id === 'loan-receipt')?.ok, true)
    assert.equal(verified.entries.find((e) => e.kind === 'loan-receipt')?.ref, 'verified')
    const unverified = buildAuditBundle({ termsheet: w.sheet, receipt: w.receipt }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 5_000 * U })
    assert.deepEqual(unverified.checks.find((c) => c.id === 'loan-receipt'), { id: 'loan-receipt', ok: false, detail: 'not verified against Bitcoin' })
    const otherLoan = world()
    const mismatch = buildAuditBundle({ termsheet: w.sheet, receipt: otherLoan.receipt, receipt_check: await checkLoanReceipt(otherLoan.receipt, otherLoan.chain, CTX) }, { blocksPerMonth: 30, maxRounds: 3, deploymentMakerCheckerMicro: 5_000 * U })
    assert.match(mismatch.checks.find((c) => c.id === 'loan-receipt')!.detail, /another loan/)
  })
})
