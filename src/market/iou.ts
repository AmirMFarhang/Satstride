// RGB bearer note with authenticated assignment messages. A sale is two real
// RGB transfers, sequential and non-atomic; escrow signing keys stay unchanged.
import { hashObject, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { debtOf, termsHash, type LoanTerms } from '../core/terms.js'
import { escrowFor, partiesOf } from '../escrow/escrow.js'
import { opReturnPayload, type ChainClient } from '../chain/types.js'

export interface IouCertificate {
  domain: 'passbook-iou-v1'
  loan_id: Hex
  asset_id: string
  amount: number
  issuer_pk: Hex
  initial_holder_pk: Hex
  issuance_transfer_txid: Hex
  lock_txid: Hex
  lock_vout: number
  sig: Hex
}
export interface IouAssignment {
  domain: 'passbook-iou-assignment-v1'
  loan_id: Hex
  asset_id: string
  from_pk: Hex
  to_pk: Hex
  previous: Hex
  note_txid: Hex
  payment_txid: Hex
  repayment_invoice: string
  sig: Hex
}
export interface IouOwnership {
  certificate: IouCertificate
  assignments: IouAssignment[]
  holder_pk: Hex
  /** Current holder confirms it received the note and controls the repayment invoice. */
  sig: Hex
}
export interface NoteSale {
  sale_id: Hex
  terms: LoanTerms
  ownership: IouOwnership
  price: number
  expires_height: number
}
export function assertAssignable(terms: LoanTerms): void {
  if (terms.v !== 1 || (terms as LoanTerms & { atomic_repayment?: unknown }).atomic_repayment) throw new Error('atomic invoice assignment requires a same-payment-hash mechanism; sale unavailable')
}
export function signOwnership(key: KeyPair, certificate: IouCertificate, assignments: IouAssignment[]): IouOwnership {
  return signObject({ certificate, assignments, holder_pk: key.pubkey }, key.secretKey)
}
export async function verifyOwnership(ownership: IouOwnership, terms: LoanTerms, chain: ChainClient): Promise<boolean> {
  try {
    const c = ownership.certificate
    if (c.domain !== 'passbook-iou-v1' || c.loan_id !== termsHash(terms) || c.amount !== debtOf(terms) || c.issuer_pk !== terms.borrower_pk || c.initial_holder_pk !== terms.lender_pk || !verifyObject(c, c.issuer_pk) || !Array.isArray(ownership.assignments) || ownership.assignments.length > 32) return false
    const lock = await chain.getTx(c.lock_txid)
    if (!lock?.height || lock.outputs[c.lock_vout]?.value !== terms.collateral_sats || lock.outputs[c.lock_vout]?.script !== escrowFor(partiesOf(terms)).script || !lock.outputs.some((o) => opReturnPayload(o.script) === c.loan_id)) return false
    let holder = c.initial_holder_pk
    let previous = hashObject(c)
    if (!(await chain.getTx(c.issuance_transfer_txid))?.height) return false
    for (const a of ownership.assignments) {
      assertAssignable(terms)
      if (a.domain !== 'passbook-iou-assignment-v1' || a.loan_id !== c.loan_id || a.asset_id !== c.asset_id || a.from_pk !== holder || a.previous !== previous || !a.repayment_invoice || !verifyObject(a, holder)) return false
      if (!(await chain.getTx(a.note_txid))?.height || !(await chain.getTx(a.payment_txid))?.height) return false
      holder = a.to_pk
      previous = hashObject(a)
    }
    return holder === ownership.holder_pk && verifyObject(ownership, holder)
  } catch { return false }
}
