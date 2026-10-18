// The borrower's income on regtest: the payer pays USDT over RGB and signs
// { txid, amount, borrower_pk } so the sandbox and the lender can verify it.
// Used by the seed script, and by the demo to keep the salary current when the
// chain has moved on since seeding (income evidence ages month by month).

import { hashObject, signHash } from '../core/crypto.js'
import { MICRO_PER_USDT, type Micro } from '../core/money.js'
import { settle } from '../rgb/wallet.js'
import type { Party } from './party.js'
import type { SeededInflow } from './state.js'

export const SALARY: Micro = 2_500 * MICRO_PER_USDT

export async function payInflow(opts: { payer: Party; borrower: Party; assetId: string; amount: Micro; memo: string; mine: () => Promise<unknown>; heightOf: (txid: string) => Promise<number> }): Promise<SeededInflow> {
  const { payer, borrower, assetId, amount } = opts
  const inv = borrower.rgb.invoice(amount, assetId)
  const { txid } = await payer.rgb.send({ invoice: inv.invoice, assetId, amount })
  await settle({ sender: payer.rgb, receiver: borrower.rgb, assetId, txid, mine: opts.mine })
  const payer_sig = signHash(hashObject({ txid, amount, borrower_pk: borrower.key.pubkey }), payer.key.secretKey)
  return { txid, height: await opts.heightOf(txid), amount, payer_pk: payer.key.pubkey, payer_sig, memo: opts.memo }
}

/** Month indices (0 = the current month) that hold at least one salary, looking back `window` months. */
export function salaryMonths(inflows: SeededInflow[], height: number, blocksPerMonth: number, window = 3): Set<number> {
  return new Set(inflows.filter((i) => i.memo === 'salary').map((i) => Math.floor((height - i.height) / blocksPerMonth)).filter((m) => m < window))
}

/**
 * Pay the salary for every recent month that has none: pay now when the current
 * month is empty, otherwise mine to the next month. Returns the new inflows.
 */
export async function keepSalaryCurrent(opts: {
  payer: Party
  borrower: Party
  assetId: string
  inflows: SeededInflow[]
  blocksPerMonth: number
  window?: number
  getHeight: () => Promise<number>
  mine: (blocks?: number) => Promise<unknown>
  heightOf: (txid: string) => Promise<number>
  onPaid?: (i: SeededInflow) => void
}): Promise<SeededInflow[]> {
  const window = opts.window ?? 3
  const added: SeededInflow[] = []
  for (let guard = 0; guard < 2 * window; guard++) {
    const all = [...opts.inflows, ...added]
    const height = await opts.getHeight()
    const months = salaryMonths(all, height, opts.blocksPerMonth, window)
    if (months.size >= window) break
    if (!months.has(0)) {
      const i = await payInflow({ ...opts, amount: SALARY, memo: 'salary', mine: () => opts.mine(1) })
      added.push(i)
      opts.onPaid?.(i)
    } else {
      const newest = Math.max(...all.filter((i) => i.memo === 'salary').map((i) => i.height))
      await opts.mine(opts.blocksPerMonth - (height - newest))
    }
  }
  return added
}
