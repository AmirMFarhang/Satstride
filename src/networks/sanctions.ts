// The credit agent's sanctions screen is the governance screen
// (src/compliance/sanctions.ts: pinned OFAC SDN XBT + OpenSanctions snapshots).
// This file keeps the two test doubles the layer tests use: a screen with no
// list (reported as not_screened, never clear) and a fixed in-memory list.

export type { AddressScreeningResult, SanctionsHit, SanctionsListInfo, SanctionsScreen, ScreeningSubject } from '../compliance/sanctions.js'
import type { AddressScreeningResult, SanctionsHit, SanctionsScreen, ScreeningSubject } from '../compliance/sanctions.js'

const normalize = (a: string) => (/^(bc|tb|bcrt)1/i.test(a.trim()) ? a.trim().toLowerCase() : a.trim())

/** Checks against no list (tests). Its result has no lists, which the credit agent reports as not_screened. */
export class StubSanctionsScreen implements SanctionsScreen {
  readonly name = 'stub: not screened'
  readonly listVersion = 'none'
  async screen(subject: ScreeningSubject): Promise<AddressScreeningResult> {
    return { status: 'clear', screen: this.name, list_version: this.listVersion, lists: [], screened: { proven: subject.proven_addresses.length, counterparties: subject.counterparties?.length ?? 0 }, hits: [], screened_at: Math.floor(Date.now() / 1000) }
  }
}

/** A fixed in-memory list, for tests: hop 0 and hop 1 hits as the governance screen reports them. */
export class FixedListSanctionsScreen implements SanctionsScreen {
  readonly name = 'fixed list'
  readonly listVersion: string
  private readonly listed: Set<string>
  constructor(listed: string[], readonly listId = 'test-list', asOf = '2026-10-17') {
    this.listed = new Set(listed.map(normalize))
    this.listVersion = `${listId}@${asOf}`
  }
  async screen(subject: ScreeningSubject): Promise<AddressScreeningResult> {
    const hits: SanctionsHit[] = []
    for (const a of subject.proven_addresses) if (this.listed.has(normalize(a))) hits.push({ address: normalize(a), hop: 0, list_id: this.listId, entry: {} })
    for (const c of subject.counterparties ?? []) if (this.listed.has(normalize(c.address))) hits.push({ address: normalize(c.address), hop: 1, via: c.of, ...(c.txid ? { txid: c.txid } : {}), list_id: this.listId, entry: {} })
    return { status: hits.length ? 'hit' : 'clear', screen: this.name, list_version: this.listVersion, lists: [{ list_id: this.listId, title: 'fixed test list', as_of: '2026-10-17', retrieved_at: '2026-10-17', source_url: 'test', sha256: '00'.repeat(32), entries: this.listed.size }], screened: { proven: subject.proven_addresses.length, counterparties: subject.counterparties?.length ?? 0 }, hits, screened_at: Math.floor(Date.now() / 1000) }
  }
}
