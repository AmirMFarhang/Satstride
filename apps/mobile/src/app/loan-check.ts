// Check a loan from the phone, without trusting the platform or the lender: the terms hash, the
// signed term sheet and every approval, the lock on Bitcoin committing to that hash, the escrow
// output (still locked, or spent by the release), the lender-signed repayment receipt, and what
// the platform's record says. Every tick is computed here from the shared code and the chain.
import { hashObject, verifyHash, verifyObject, type Hex } from '../../../../src/core/crypto.js'
import { termsHash } from '../../../../src/core/terms.js'
import { escrowFor, partiesOf } from '../../../../src/escrow/escrow.js'
import { isConfirmed, opReturnPayload } from '../../../../src/chain/types.js'
import { termSheetHash } from '../../../../src/market/termsheet.js'
import type { PhoneBorrower, PhoneLoan } from '../agent/borrower'

export interface LoanTick { id: string; ok: boolean | null; label: string; detail: string }

export async function checkLoan(agent: PhoneBorrower, id: Hex, l: PhoneLoan): Promise<{ ticks: LoanTick[]; height: number }> {
  const t = l.terms
  const ticks: LoanTick[] = []
  const tick = (id: string, ok: boolean | null, label: string, detail: string) => ticks.push({ id, ok, label, detail })
  const height = await agent.chain.getHeight()

  tick('terms-hash', termsHash(t) === id, 'Terms hash', termsHash(t) === id ? 'the loan id is the hash of these terms' : 'the terms do not hash to this loan id')
  if (l.termsheet) {
    let bound = false
    try { bound = termSheetHash(l.termsheet) === id } catch { bound = false }
    tick('sheet-bound', bound, 'Term sheet', bound ? 'the sheet is bound to these terms' : 'the sheet is not bound to these terms')
    const lenderSig = !!l.termsheet.signatures.lender && verifyHash(l.termsheet.signatures.lender, id, t.lender_pk)
    const ownSig = !!l.termsheet.signatures.borrower && verifyHash(l.termsheet.signatures.borrower, id, t.borrower_pk)
    tick('sheet-signed', lenderSig && ownSig, 'Signatures', `lender ${lenderSig ? 'signed' : 'signature missing'}, you ${ownSig ? 'countersigned' : 'have not countersigned'}`)
    const approvals = l.lender_approvals ?? []
    const valid = approvals.filter((a) => a.termsheet_hash === id && a.role === 'lender' && verifyObject(a, a.approver_pk))
    tick('approvals', valid.length > 0 && valid.length === approvals.length, 'Lender approvals', `${valid.length} of ${approvals.length} verify for this sheet`)
    const e = l.termsheet.scorer.evidence
    tick('evidence', !!e, 'Evidence digest', e ? `reference ${hashObject(e).slice(0, 12)}…` : 'none in this sheet')
  }

  if (!l.lock) {
    tick('lock', null, 'Lock on Bitcoin', 'not locked yet')
  } else {
    const tx = await agent.chain.getTx(l.lock.txid)
    const escrow = escrowFor(partiesOf(t))
    const out = tx?.outputs[l.lock.vout]
    const commits = !!tx && tx.outputs.some((o) => opReturnPayload(o.script) === id)
    tick('lock', isConfirmed(tx), 'Lock on Bitcoin', isConfirmed(tx) ? `confirmed at block ${tx.height}` : tx ? 'in the mempool' : 'not found by the chain server')
    tick('lock-commits', commits, 'Lock commits the terms', commits ? 'its OP_RETURN is this loan id' : 'no OP_RETURN with this loan id')
    tick('escrow', !!out && out.script === escrow.script && out.value === t.collateral_sats, 'Escrow output', out ? `${out.value} sats to the three-key escrow${out.script === escrow.script ? '' : ' (another script)'}` : 'missing')
    if (!l.release_txid) {
      const unspent = (await agent.chain.utxos(escrow.script)).some((u) => u.txid === l.lock!.txid && u.vout === l.lock!.vout)
      tick('escrow-unspent', unspent, 'Collateral still locked', unspent ? 'nobody has moved it' : 'the escrow output has been spent')
    } else {
      const rel = await agent.chain.getTx(l.release_txid)
      const spends = !!rel && rel.inputs.some((i) => i.txid === l.lock!.txid && i.vout === l.lock!.vout)
      tick('released', isConfirmed(rel) && spends, 'Released', rel ? `${isConfirmed(rel) ? `confirmed at block ${rel.height}` : 'in the mempool'}${spends ? ', spending the escrow' : ', not spending the escrow'}` : 'release not found')
    }
  }

  if (l.repayment_receipt) {
    const r = l.repayment_receipt
    const ok = r.loan_id === id && r.validator_pk === t.lender_pk && r.repayment_txid === l.repayment_txid && verifyObject(r, r.validator_pk)
    tick('receipt', ok, 'Repayment receipt', ok ? `signed by the lender after rgb-lib saw ${r.amount} base units settle` : 'does not verify for this loan')
  }

  const due = t.maturity_height - height
  tick('maturity', l.release_txid ? true : null, 'Due', l.release_txid ? 'closed' : due >= 0 ? `in ${due} blocks (block ${t.maturity_height})` : `${-due} blocks past due; recovery at block ${t.recovery_height}`)

  try {
    const rec = await agent.platform.loan(id)
    tick('platform', null, "Platform's record", `${rec.status} (shown, not trusted)`)
  } catch (e) {
    tick('platform', null, "Platform's record", `not reachable: ${(e as Error).message}`)
  }
  return { ticks, height }
}

/** A short fingerprint of everything checked, for the receipt screen. */
export const checkFingerprint = (ticks: LoanTick[]): string => hashObject(ticks.map((x) => [x.id, x.ok])).slice(0, 12)
