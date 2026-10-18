// A borrower-carried, signed history. Bitcoin proves commitments and escrow
// spends; legacy dollar settlement is explicitly a signed RGB-validation receipt.
import { isConfirmed, opReturnPayload, type ChainClient } from '../chain/types.js'
import { isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { termsHash, validateTerms, type LoanTerms } from '../core/terms.js'
import { escrowFor, keyPathOutput, partiesOf } from '../escrow/escrow.js'
import { spentLeaf } from '../escrow/witness.js'
import type { IouOwnership } from '../market/iou.js'
import { repaymentProven } from '../settlement/adapters.js'
import type { RepaymentEvidence } from '../settlement/types.js'
import { ladderFromHistory, type LoanOutcome } from './ladder.js'
import type { Passbook, PassbookPage } from './passbook.js'

export interface RgbRepaymentReceipt {
  domain: 'passbook-rgb-repayment-v1'
  loan_id: Hex
  repayment_txid: Hex
  asset_id: string
  amount: number
  validator_pk: Hex
  /** The signer observed a Settled receive using rgb-lib, not merely a Bitcoin tx. */
  validation: 'rgb-lib-settled'
  sig: Hex
}
export type RepaymentProof = { kind: 'rgb_receipt'; receipt: RgbRepaymentReceipt; ownership?: IouOwnership } | { kind: 'atomic'; preimage: Hex }
export interface PortablePage {
  terms: LoanTerms
  lock_txid: Hex
  lock_vout: number
  outcome_txid?: Hex
  /** Non-repayment outcomes do not earn a ladder step. */
  outcome?: 'repaid' | 'liquidated' | 'defaulted' | 'refunded'
  repayment?: RepaymentProof
}
export interface PassbookDocument {
  v: 1
  borrower_pk: Hex
  pages: PortablePage[]
  sig: Hex
}
export interface VerifiedPassbook extends Passbook {
  document_valid: boolean
  assurance: ('bitcoin_hashlock' | 'signed_rgb_receipt' | 'none')[]
}
export function signPassbook(key: KeyPair, pages: PortablePage[]): PassbookDocument {
  return signObject({ v: 1 as const, borrower_pk: key.pubkey, pages }, key.secretKey)
}
export function rgbRepaymentReceipt(key: KeyPair, terms: LoanTerms, txid: Hex, amount: number): RgbRepaymentReceipt {
  return signObject({ domain: 'passbook-rgb-repayment-v1' as const, loan_id: termsHash(terms), repayment_txid: txid, asset_id: terms.asset_id, amount, validator_pk: key.pubkey, validation: 'rgb-lib-settled' as const }, key.secretKey)
}

// Moved below the settlement adapters; re-exported for existing callers.
export { atomicWitnessPreimage, spentLeaf } from '../escrow/witness.js'

/** The page's proof in the settlement adapters' common evidence shape. */
export function repaymentEvidence(proof: RepaymentProof | undefined): RepaymentEvidence | undefined {
  if (proof?.kind === 'atomic') return { kind: 'ln-rln', preimage: proof.preimage }
  if (proof?.kind === 'rgb_receipt') return { kind: 'cosign-rgb', receipt: proof.receipt, ...(proof.ownership ? { ownership: proof.ownership } : {}) }
  return undefined
}

/** No platform calls. The caller supplies its own Bitcoin client. */
export async function verifyPassbook(doc: PassbookDocument, chain: ChainClient): Promise<VerifiedPassbook> {
  const document_valid = !!doc && doc.v === 1 && isHex(doc.borrower_pk, 32) && Array.isArray(doc.pages) && doc.pages.length <= 100 && doc.pages.every((p) => p && typeof p.terms === 'object' && p.terms !== null) && verifyObject(doc, doc.borrower_pk)
  if (!document_valid) return { borrower_pk: doc?.borrower_pk ?? '', pages: [], ladder: ladderFromHistory([]), unverified: Math.max(1, doc?.pages?.length ?? 0), document_valid: false, assurance: [] }
  const pages: PassbookPage[] = []
  const assurance: VerifiedPassbook['assurance'] = []
  let previous: Hex | null = null
  const seen = new Set<Hex>()
  let previousHeight = -1
  for (const page of doc.pages) {
    const t = page.terms
    const problems: string[] = []
    const verified = { lock: false, terms_commitment: false, collateral_amount: false, collateral_script: false, close: false, chain_link: false }
    let outcome: LoanOutcome = 'open'
    let returnedSats: number | undefined
    let level: VerifiedPassbook['assurance'][number] = 'none'
    try {
      // structure only: a page priced under an earlier cap or LTV table stays verifiable
      validateTerms(t, null)
      const id = termsHash(t)
      if (t.borrower_pk !== doc.borrower_pk || seen.has(id) || t.open_height <= previousHeight) throw new Error('wrong borrower, duplicate or unordered page')
      seen.add(id)
      previousHeight = t.open_height
      const lock = await chain.getTx(page.lock_txid)
      verified.lock = isConfirmed(lock)
      if (!isConfirmed(lock)) throw new Error('lock is not confirmed')
      verified.terms_commitment = lock.outputs.some((o) => opReturnPayload(o.script) === id)
      verified.collateral_amount = Number.isInteger(page.lock_vout) && page.lock_vout >= 0 && lock.outputs[page.lock_vout]?.value === t.collateral_sats
      verified.collateral_script = lock.outputs[page.lock_vout]?.script === escrowFor(partiesOf(t)).script
      verified.chain_link = t.prev_passbook_txid === previous && (previous === null || lock.inputs.some((i) => i.txid === previous))
      if (!(verified.lock && verified.terms_commitment && verified.collateral_amount && verified.collateral_script && verified.chain_link)) throw new Error('lock amount, escrow script, commitment or previous-page link mismatch')
      if (page.outcome_txid) {
        const close = await chain.getTx(page.outcome_txid)
        const input = close?.inputs.find((i) => i.txid === page.lock_txid && i.vout === page.lock_vout)
        if (!isConfirmed(close) || !input) throw new Error('outcome is not a confirmed collateral spend')
        const leaf = spentLeaf(input, t)
        if (!leaf) throw new Error('outcome witness is not a derived escrow leaf')
        if (page.outcome === 'repaid') {
          // F2: one rule, dispatched to the settlement kind these terms commit to.
          const proven = await repaymentProven(t, repaymentEvidence(page.repayment), chain, { lock_txid: page.lock_txid, lock_vout: page.lock_vout, outcome_txid: page.outcome_txid })
          if (!proven.ok) throw new Error(proven.reason)
          const repaidHeight = proven.repaid_height
          level = proven.assurance
          outcome = repaidHeight <= t.maturity_height ? 'on_time' : 'late'
        } else {
          if (page.outcome === 'liquidated' && leaf === 'B') outcome = 'liquidated'
          else if (page.outcome === 'defaulted' && ['A', 'B'].includes(leaf)) outcome = 'defaulted'
          else if (page.outcome === 'refunded' && ['C', 'D'].includes(leaf)) outcome = 'refunded'
          else throw new Error('unsupported outcome or leaf')
        }
        verified.close = true
        returnedSats = close.outputs.filter((o) => o.script === keyPathOutput(t.borrower_pk).script).reduce((sum, o) => sum + o.value, 0)
        previous = page.outcome_txid
      }
    } catch (err) {
      problems.push((err as Error).message)
    }
    for (const [name, ok] of Object.entries(verified)) if (!ok && name !== 'close') problems.push(`${name} unverified`)
    pages.push({ loan_id: termsHash(t), open_height: t.open_height, maturity_height: t.maturity_height, principal: t.principal, fee: t.fee, collateral_sats: t.collateral_sats, ltv_bps: t.ltv_bps, ladder_step: t.ladder_step, status: page.outcome ?? 'open', outcome, verified, lock_txid: page.lock_txid, close_txid: page.outcome_txid, ...(returnedSats === undefined ? {} : { returned_sats: returnedSats }), problems })
    assurance.push(level)
  }
  const counted = pages.filter((p) => p.problems.length === 0 && (p.outcome === 'open' || p.verified.close))
  // An invalid page invalidates the history chain; partial histories cannot earn a higher limit.
  const unverified = pages.length - counted.length
  return { borrower_pk: doc.borrower_pk, pages, ladder: ladderFromHistory(unverified ? [] : counted.map((p) => ({ open_height: p.open_height, outcome: p.outcome }))), unverified, document_valid, assurance }
}
