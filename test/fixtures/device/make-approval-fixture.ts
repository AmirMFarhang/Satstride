// Writes approval.json, the shared fixture for the phone and the dashboard
// approving the same term sheet (test/device-approval.test.ts and
// apps/android/__tests__/approval.test.tsx). Labelled demo keys, a fixed salt and
// a fixed price; the oracle's Schnorr signature is randomised, so a rerun gives a
// new term-sheet hash. Run: npx tsx test/fixtures/device/make-approval-fixture.ts

import { writeFileSync } from 'node:fs'
import { hashObject, keyPairFromLabel } from '../../../src/core/crypto.js'
import { MICRO_PER_USDT } from '../../../src/core/money.js'
import { approve } from '../../../src/market/approvals.js'
import type { Position } from '../../../src/market/negotiate.js'
import { borrowerCostLines, buildTermSheet, renderTermSheet, termSheetHash } from '../../../src/market/termsheet.js'
import { signObject } from '../../../src/core/crypto.js'
import { splitOutputs } from '../../../src/escrow/escrow.js'

const U = MICRO_PER_USDT
const borrower = keyPairFromLabel('device-fixture-borrower'), lender = keyPairFromLabel('device-fixture-lender'), platform = keyPairFromLabel('device-fixture-platform'), oracle = keyPairFromLabel('device-fixture-oracle')
const quote = signObject({ price_cents: 10_000_000, height: 500, oracle_pk: oracle.pubkey }, oracle.secretKey)
const agreed: Position = { principal: 600 * U, apr_bps: 1200, ltv_bps: 5000, term_blocks: 30, settlement: 'cosign-rgb' }
const sheet = buildTermSheet({
  agreed, negotiation: { id: 'aa'.repeat(32), accept_hash: 'bb'.repeat(32) }, borrower_pk: borrower.pubkey, lender_pk: lender.pubkey, platform_pk: platform.pubkey,
  asset_id: 'rgb:usdt-test', oracle_quote: quote, grace_blocks: 5, ladder_step: 0, prev_passbook_txid: null, settlement: { kind: 'cosign-rgb' },
  scorer: { provider: 'in-process', scorer_id: 'passbook-sandbox', code_measurement: `source:${'cd'.repeat(32)}`, contract_hash: 'ef'.repeat(32), trust: 'dev-inprocess', result_hash: '34'.repeat(32), fallback: false, recommendation: 'QUALIFY', evidence: { kind: 'passbook-run-record', run_record_sha256: '56'.repeat(32) } },
  consent_hash: '12'.repeat(32), salt: '78'.repeat(32),
})
const hash = termSheetHash(sheet)
const t = sheet.terms
const approved_at = 1_760_700_000
const split = splitOutputs(t)
const { sig: _sig, ...payload } = approve(borrower, sheet, 'borrower', approved_at)
// What demo.ts acceptInfo puts in the stop-2 wait, for this sheet.
const waiting = {
  waiting: 'confirm', stop: 'accept', loan_id: hash, lender_pk: lender.pubkey,
  principal: t.principal, fee: t.fee, collateral_sats: t.collateral_sats, maturity_height: t.maturity_height, grace_blocks: t.grace_blocks,
  price_cents: t.oracle_quote.price_cents, refund_blocks: 10, cost_lines: borrowerCostLines(t),
  termsheet: { hash, render: renderTermSheet(sheet, { audience: 'borrower' }) },
  // explainTerms: the default split from code; the sentence is the rule reasoner's kind of wording
  explanation: 'If you do not repay by the due block plus grace, the lender takes what is owed in bitcoin and the rest comes back to you.',
  lender_sats_on_default: split[0].value, borrower_sats_on_default: split[1]?.value ?? 0,
}
const fixture = {
  about: 'Stop 2 for one term sheet. The phone and the dashboard post the same request; the borrower agent on the node then signs the same approval payload.',
  borrower_label: 'device-fixture-borrower',
  lender_name: 'Lender 1',
  termsheet: sheet,
  waiting,
  request: { stop: 'accept', accept: true, loan_id: hash },
  approved_at,
  approval_payload: payload,
  approval_payload_hash: hashObject(payload),
}
writeFileSync(new URL('./approval.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n')
console.log('wrote approval.json for term sheet', hash)
