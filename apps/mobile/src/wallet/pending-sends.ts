// Sends that were signed but whose broadcast is unknown (sendEnd failed). Kept across app
// runs so the wallet never signs again for the same invoice until each one is resolved.
import { createMMKV } from 'react-native-mmkv'

export interface PendingSend { txid: string; batchTransferIdx: number | null; invoice: string; assetId: string; amount: number; at: number }

const store = createMMKV({ id: 'passbook-wallet-flags' })
const KEY = 'rgb.pending-sends.v1'

export const pendingSends = {
  list(): PendingSend[] {
    try { const v = JSON.parse(store.getString(KEY) ?? '[]') as PendingSend[]; return Array.isArray(v) ? v : [] } catch { return [] }
  },
  add(p: PendingSend): void { store.set(KEY, JSON.stringify([...pendingSends.list().filter((x) => x.txid !== p.txid), p])) },
  remove(txid: string): void { store.set(KEY, JSON.stringify(pendingSends.list().filter((x) => x.txid !== txid))) },
}
