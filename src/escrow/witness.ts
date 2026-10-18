// Reading escrow spends from Bitcoin witnesses. Shared by passbook
// verification and the settlement adapters (which registry/passbook-doc.ts
// dispatches to), so it lives below both.
import type { ChainInput } from '../chain/types.js'
import { bytesToHex, hexToBytes, isHex, sha256Hex, type Hex } from '../core/crypto.js'
import type { LoanTerms } from '../core/terms.js'
import { escrowFor, partiesOf } from './escrow.js'

/** Exact script and control block, not an arbitrary close plus a claimed secret. */
export function spentLeaf(input: ChainInput, terms: LoanTerms): string | null {
  const witness = input.witness
  if (!witness || witness.length < 3) return null
  const escrow = escrowFor(partiesOf(terms))
  for (const [name, leaf] of Object.entries(escrow.leaves)) {
    if (!leaf) continue
    if (witness.at(-2) === bytesToHex(leaf.script) && witness.at(-1) === bytesToHex(leaf.controlBlock)) return name
  }
  return null
}

/** Consensus-confirmed E spend proves the committed secret was revealed. */
export function atomicWitnessPreimage(input: ChainInput, terms: LoanTerms): Hex | null {
  const atomic = (terms as LoanTerms & { atomic_repayment?: { payment_hash: Hex } }).atomic_repayment
  const witness = input.witness
  if (!atomic || !witness || witness.length !== 4 || spentLeaf(input, terms) !== 'E') return null
  const preimage = witness[1]
  return isHex(preimage, 32) && sha256Hex(hexToBytes(preimage)) === atomic.payment_hash ? preimage : null
}
