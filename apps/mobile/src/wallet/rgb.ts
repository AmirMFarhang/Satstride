// The borrower's RGB wallet (test USDT) as the UI sees it: calls into the
// Passbook module in the worklet (worklet/index.js). Every call that signs
// (create UTXOs, send) is behind the phone's lock in the screen that makes it.
import { useCallback, useEffect, useState } from 'react'
import { useModule } from '@tetherto/wdk-react-native-core'

export interface RgbAsset { assetId: string; ticker: string; name: string; precision: number; balance: { settled: number; future: number; spendable: number } }
export interface RgbTransfer { idx: number; batchTransferIdx?: number; kind: string; status: string; txid: string | null; recipientId: string | null; amount: number }
export interface RgbInvoice { invoice: string; recipientId: string; expirationTimestamp?: number | null; batchTransferIdx?: number }
export interface DecodedInvoice { recipientId: string; assetId?: string | null; assignment?: Record<string, unknown> | string; network?: string; expirationTimestamp?: number | null; transportEndpoints: string[] }
interface BtcSide { settled: number; future: number; spendable: number }

interface PassbookModule {
  info(): Promise<{ fingerprint: string; rgb: { accountXpubVanilla: string; accountXpubColored: string; masterFingerprint: string } }>
  rgbAddress(): Promise<string>
  rgbBtcBalance(o?: { skipSync?: boolean }): Promise<{ vanilla: BtcSide; colored: BtcSide }>
  rgbCreateUtxos(o: { num?: number; size?: number; feeRate?: number }): Promise<number>
  rgbBlindReceive(o: { assetId?: string | null; amount: number; durationSeconds?: number }): Promise<RgbInvoice>
  rgbRefresh(o?: { assetId?: string | null }): Promise<unknown>
  rgbAssets(): Promise<RgbAsset[]>
  rgbTransfers(o?: { assetId?: string }): Promise<RgbTransfer[]>
  rgbDecodeInvoice(invoice: string): Promise<DecodedInvoice>
  rgbSend(o: { invoice: string; assetId: string; amount: number; feeRate?: number }): Promise<{ txid: string; batchTransferIdx: number; feeSats: string }>
  rgbFailPending(o: { batchTransferIdx?: number | null }): Promise<{ batchTransferIdx: number; transfersChanged?: boolean; cannotFail?: boolean; refused?: string; txid?: string | null }[]>
  rgbSendStatus(o: { txid: string }): Promise<{ txid: string; state: 'broadcast' | 'not-seen' | 'unknown'; rgbStatus: string | null; batchTransferIdx: number | null }>
}

export function useRgb() {
  const m = useModule<PassbookModule>('passbook')
  const [address, setAddress] = useState<string | null>(null)
  const [btc, setBtc] = useState<{ vanilla: BtcSide; colored: BtcSide } | null>(null)
  const [assets, setAssets] = useState<RgbAsset[]>([])
  const [transfers, setTransfers] = useState<RgbTransfer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (sync: boolean) => {
    setBusy(true)
    try {
      if (sync) await m.rgbRefresh({})
      const [a, b, list] = await Promise.all([m.rgbAddress(), m.rgbBtcBalance({}), m.rgbAssets()])
      const rows = (await Promise.all([m.rgbTransfers({}), ...list.map((x) => m.rgbTransfers({ assetId: x.assetId }))])).flat()
      setAddress(a); setBtc(b); setAssets(list); setTransfers(rows)
      setError(null)
    } catch (e) {
      setError(`RGB wallet: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [m])

  useEffect(() => { void load(false) }, [load])

  return { module: m, address, btc, assets, transfers, error, busy, refresh: () => load(true), reload: () => load(false) }
}
