// Reading a borrower's passbook from the chain. The registry says what it
// believes; this module checks each claim against Bitcoin before the ladder
// counts it: the lock is confirmed and commits to the terms hash, the
// collateral output has the right amount, the closing transaction spends that
// output, and each loan chains to the previous one's release.

import { isConfirmed, opReturnPayload, type ChainClient, type ChainTx } from '../chain/types.js'
import { escrowFor, partiesOf } from '../escrow/escrow.js'
import type { Hex } from '../core/crypto.js'
import { debtOf, termsHash, type LoanTerms } from '../core/terms.js'
import { atomicWitnessPreimage } from './passbook-doc.js'
import { ladderFromHistory, type LadderState, type LoanOutcome } from './ladder.js'
import type { LoanRecord, Store } from './store.js'

export interface PassbookPage {
  loan_id: Hex
  open_height: number
  maturity_height: number
  principal: number
  fee: number
  collateral_sats: number
  ltv_bps: number
  ladder_step: number
  status: LoanRecord['status']
  outcome: LoanOutcome
  /** Every claim the registry makes about this page that Bitcoin confirmed. */
  verified: { lock: boolean; terms_commitment: boolean; collateral_amount: boolean; collateral_script: boolean; close: boolean; chain_link: boolean }
  lock_txid?: Hex
  close_txid?: Hex
  /** Read from confirmed closing outputs, including portable offline views. */
  returned_sats?: number
  problems: string[]
}

export interface Passbook {
  borrower_pk: Hex
  pages: PassbookPage[]
  ladder: LadderState
  /** Loans the registry knows but Bitcoin could not confirm; they never count. */
  unverified: number
}

export async function buildPassbook(borrowerPk: Hex, store: Store, chain: ChainClient): Promise<Passbook> {
  const records = store.loansByBorrower(borrowerPk)
  const pages: PassbookPage[] = []
  let prevRelease: Hex | null = null
  for (const r of records) {
    const page = await verifyPage(r, chain, prevRelease)
    pages.push(page)
    if (page.verified.close && page.close_txid) prevRelease = page.close_txid
  }
  const counted = pages.filter((p) => p.verified.lock && p.verified.terms_commitment && p.verified.collateral_amount && p.verified.collateral_script && p.verified.chain_link && (p.outcome === 'open' || p.verified.close))
  const ladder = ladderFromHistory(counted.map((p) => ({ open_height: p.open_height, outcome: p.outcome })))
  return { borrower_pk: borrowerPk, pages, ladder, unverified: pages.length - counted.length }
}

export function outcomeOf(r: LoanRecord): LoanOutcome {
  switch (r.status) {
    case 'repaid':
      if (r.repaid_height === undefined) return 'open'
      return r.repaid_height <= r.terms.maturity_height ? 'on_time' : 'late'
    case 'defaulted':
      return 'defaulted'
    case 'liquidated':
      return 'liquidated'
    case 'refunded':
      return 'refunded'
    default:
      return 'open'
  }
}

async function verifyPage(r: LoanRecord, chain: ChainClient, prevRelease: Hex | null): Promise<PassbookPage> {
  const t: LoanTerms = r.terms
  const problems: string[] = []
  const verified = { lock: false, terms_commitment: false, collateral_amount: false, collateral_script: false, close: false, chain_link: false }
  let lock: ChainTx | null = null
  if (r.lock_txid) {
    lock = await chain.getTx(r.lock_txid)
    if (isConfirmed(lock)) {
      verified.lock = true
      const hash = termsHash(t)
      verified.terms_commitment = lock.outputs.some((o) => opReturnPayload(o.script) === hash)
      if (!verified.terms_commitment) problems.push('lock transaction does not commit to these terms')
      const script = escrowFor(partiesOf(t)).script
      const vout = r.lock_vout ?? lock.outputs.findIndex((o) => o.value === t.collateral_sats && o.script === script)
      verified.collateral_amount = vout >= 0 && lock.outputs[vout]?.value === t.collateral_sats
      if (!verified.collateral_amount) problems.push('no output carries the collateral amount')
      verified.collateral_script = vout >= 0 && lock.outputs[vout]?.script === script
      if (!verified.collateral_script) problems.push('collateral output does not pay the escrow derived from these terms')
      if (t.prev_passbook_txid === null) verified.chain_link = prevRelease === null
      else verified.chain_link = t.prev_passbook_txid === prevRelease && lock.inputs.some((i) => i.txid === t.prev_passbook_txid)
      if (!verified.chain_link) problems.push('lock does not spend the previous release output')
      const closeTxid = r.release_txid ?? r.settlement_txid
      if (closeTxid) {
        const close = await chain.getTx(closeTxid)
        verified.close = isConfirmed(close) && close.inputs.some((i) => i.txid === r.lock_txid && i.vout === vout)
        if (r.status === 'repaid') {
          const input = close?.inputs.find((i) => i.txid === r.lock_txid && i.vout === vout)
          verified.close &&= !!r.repayment_proof && (r.repayment_proof !== 'atomic_preimage' || (!!input && atomicWitnessPreimage(input, t) !== null))
        }
        if (!verified.close) problems.push('closing transaction does not spend the collateral output')
      }
    } else {
      problems.push(lock ? 'lock transaction unconfirmed' : 'lock transaction not found')
    }
  } else if (r.status !== 'pending') {
    problems.push('no lock transaction recorded')
  }
  const outcome = outcomeOf(r)
  return {
    loan_id: r.id,
    open_height: t.open_height,
    maturity_height: t.maturity_height,
    principal: t.principal,
    fee: t.fee,
    collateral_sats: t.collateral_sats,
    ltv_bps: t.ltv_bps,
    ladder_step: t.ladder_step,
    status: r.status,
    outcome,
    verified,
    lock_txid: r.lock_txid,
    close_txid: r.release_txid ?? r.settlement_txid,
    problems,
  }
}

export function debtOfLoan(r: LoanRecord): number {
  return debtOf(r.terms)
}
