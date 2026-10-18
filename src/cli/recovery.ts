// Registry persistence is not a durable agent workflow. After an interrupted
// demo, serve the stored passbook without replaying payments or origination.
import type { Hex } from '../core/crypto.js'
import type { LoanRecord, Store } from '../registry/store.js'
import type { App } from '../server/app.js'

export function unfinishedLoans(store: Store): LoanRecord[] {
  return store.allLoans().filter((loan) => ['pending', 'locked', 'open'].includes(loan.status) || (loan.status === 'repaid' && !loan.release_txid))
}

export function assertRegistryMatches(store: Store, assetId: string, platformPk: Hex): void {
  if (store.allLoans().some((loan) => loan.terms.asset_id !== assetId || loan.terms.platform_pk !== platformPk)) {
    throw new Error('PASSBOOK_DB belongs to another seed or platform key. Restore its original PASSBOOK_STATE and PASSBOOK_WALLETS; use a separate DB with separately seeded wallets for a fresh demo. Existing collateral may still be locked.')
  }
}

export function serveInspection(app: App, info: { borrower_pk: Hex; asset_id: string; lenders: Record<string, string>; scenario: string; recoveryError?: string }): void {
  const error = (info.recoveryError ? `Recovery paused: ${info.recoveryError}. ` : '') + 'Recovered saved history. Agent steps cannot resume automatically after restart; approvals and payments are paused. Keep the DB, state and wallets together. See docs/TWO-MACHINES.md for recovery limits.'
  app.api.on('GET', '/demo', () => ({ ...info, mode: 'inspection', step: 0, waiting: { waiting: null, error }, unfinished_loans: unfinishedLoans(app.store).map((loan) => ({ id: loan.id, status: loan.status })) }))
  app.api.on('GET', '/demo/wallet', () => ({ error: 'Wallet is closed in recovered history mode. Saved passbook receipts remain available.' }))
  for (const action of ['next', 'approve', 'confirm']) app.api.on('POST', `/demo/${action}`, () => ({ ok: false, error }))
  app.api.emit({ type: 'demo', ...info, mode: 'inspection', waiting: null, error })
}
