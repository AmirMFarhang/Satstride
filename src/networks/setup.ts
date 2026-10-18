// Wiring shared by the CLI and the dashboard panel: sources from the credit
// config, and what the platform registry already knows about liabilities.

import type { CreditConfig } from '../core/config.js'
import { DEFAULT_CREDIT } from '../core/config.js'
import type { Hex } from '../core/crypto.js'
import { escrowFor, partiesOf } from '../escrow/escrow.js'
import type { LoanTerms } from '../core/terms.js'
import { ElectrumSource, EsploraSource, FallbackSource, SnapshotSource, type BitcoinSource } from './bitcoin-source.js'
import type { KnownEscrow, Liabilities } from './features.js'
import type { ChainId } from './types.js'

export function sourceFor(url: string, chain: ChainId): BitcoinSource {
  return url.startsWith('tcp://') ? new ElectrumSource(url, chain) : new EsploraSource(url, chain)
}

/**
 * The device's source and the lender's own, each with the recorded snapshot as
 * offline fallback. `offline` uses the recording directly (labelled as such).
 */
export function creditSources(credit: CreditConfig | null, chain: ChainId, opts: { offline?: boolean } = {}): { device: BitcoinSource; lender: BitcoinSource } {
  const c = credit ?? DEFAULT_CREDIT
  const snapshot = () => (c.snapshot ? SnapshotSource.fromFile(c.snapshot) : null)
  const pick = (url: string | undefined, role: string): BitcoinSource => {
    const rec = snapshot()
    if (opts.offline) { if (!rec) throw new Error('offline needs credit.snapshot'); return rec }
    if (!url) throw new Error(`credit config has no ${role} source for ${chain}`)
    return rec && rec.chain === chain ? new FallbackSource(sourceFor(url, chain), rec) : sourceFor(url, chain)
  }
  return { device: pick(c.sources[chain], 'device'), lender: pick(c.lender_sources[chain], 'lender') }
}

interface LoanView { id: string; status: string; terms: LoanTerms }

/** Escrow outputs of every loan the registry knows: BTC found there is a liability whether or not it was disclosed. */
export function knownEscrows(loans: LoanView[]): KnownEscrow[] {
  const out: KnownEscrow[] = []
  for (const l of loans) {
    try { out.push({ loan_id: l.id, script: escrowFor(partiesOf(l.terms)).script }) } catch { /* malformed terms: not an escrow we can name */ }
  }
  return out
}

/** The borrower's open Passbook loans, as the registry (its public passbook) shows them. */
export function registryLiabilities(loans: LoanView[], borrowerPk: Hex): Liabilities {
  // LoanStatus (src/registry/store.ts): pending | locked | open | repaid | defaulted | liquidated | refunded
  const open = loans.filter((l) => l.terms.borrower_pk === borrowerPk && ['pending', 'locked', 'open', 'defaulted'].includes(l.status))
  return { open_loans: open.map((l) => ({ loan_id: l.id, principal: l.terms.principal })), ious_held_by_others: [] }
}
