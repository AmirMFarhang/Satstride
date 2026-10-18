// Installed only by a trusted orchestrator. A remote borrower cannot create an
// observer or supply these callbacks over the wire.
export interface HistoryObserverHooks {
  invoice(walletDir: string, recipientId: string): void
  sent(senderDir: string, recipientId: string, assetId: string, amount: number, txid: string): void
  ambiguous(senderDir: string, recipientId: string, assetId: string): void
}
const observers = new Set<HistoryObserverHooks>()
export function installHistoryObserver(hooks: HistoryObserverHooks): () => void { observers.add(hooks); return () => observers.delete(hooks) }
export function historyInvoice(walletDir: string, recipientId: string): void { for (const o of observers) o.invoice(walletDir, recipientId) }
export function historySent(senderDir: string, recipientId: string, assetId: string, amount: number, txid: string): void { for (const o of observers) o.sent(senderDir, recipientId, assetId, amount, txid) }
export function historyAmbiguous(senderDir: string, recipientId: string, assetId: string): void { for (const o of observers) o.ambiguous(senderDir, recipientId, assetId) }
