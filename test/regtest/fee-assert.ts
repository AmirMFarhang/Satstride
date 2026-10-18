// Shared regtest assertion: the platform's fee on a closed loan was invoiced, paid over RGB and validated.

import assert from 'node:assert/strict'

/**
 * When the loan closes the platform invoices lender1 15% of the loan's interest from its own RGB
 * wallet; the lender pays over RGB and the platform validates the receive before marking it paid.
 */
export function assertFeePaid(out: string, outcome: string): void {
  const invoiced = out.match(new RegExp(`platform invoices lender1 (\\d+\\.\\d{2}) USDT: 15% of the (\\d+\\.\\d{2}) USDT interest, ${outcome}`))
  assert.ok(invoiced, `fee invoiced on ${outcome}`)
  const [fee, interest] = [Math.round(Number(invoiced![1]) * 100), Math.round(Number(invoiced![2]) * 100)]
  assert.equal(fee, Math.floor((interest * 15 + 50) / 100), '15% of the interest, half-up to the cent')
  assert.match(out, new RegExp(`platform fee ${invoiced![1]} USDT paid by lender1 over RGB in [0-9a-f]{64}; the platform validated the receive: fee_paid`))
}
