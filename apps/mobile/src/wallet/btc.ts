// The borrower's bitcoin account (BIP-84, m/84'/1'/0'/0/0 on regtest), driven
// through the worklet. Sending is two steps on purpose: sign (the worklet builds
// and signs; nothing leaves the phone), check the signed fee against the quote,
// then broadcast.
import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '@tetherto/wdk-react-native-core'
import { NETWORK } from './config'
import { FEE_RATE_SAT_VB } from './config'

export interface Transfer { txid: string; height: number; sats: bigint; direction: 'in' | 'out'; fee: bigint | null }

interface BtcMethods {
  getBalance(): Promise<string>
  getTransfers(o: { direction: 'all'; limit: number }): Promise<{ txid: string; height: number; value: string | number; direction: 'incoming' | 'outgoing'; fee?: string | number }[]>
  quoteSendTransaction(tx: { to: string; value: string; feeRate: number } | string): Promise<{ fee: string | number }>
  signTransaction(tx: { to: string; value: string; feeRate: number }): Promise<string>
  sendTransaction(hex: string, timeoutMs?: number): Promise<{ hash: string; fee: string | number }>
}

export function useBtcAccount() {
  const acc = useAccount<BtcMethods>({ network: NETWORK.btcKey, accountIndex: 0 })
  const { address, extension } = acc
  const [balance, setBalance] = useState<bigint | null>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    if (!address) return
    setRefreshing(true)
    try {
      const x = extension()
      const [b, t] = await Promise.all([x.getBalance(), x.getTransfers({ direction: 'all', limit: 20 })])
      setBalance(BigInt(b))
      setTransfers((t ?? []).map((r) => ({ txid: r.txid, height: r.height, sats: BigInt(r.value), direction: r.direction === 'incoming' ? 'in' : 'out', fee: r.fee === undefined ? null : BigInt(r.fee) })))
      setError(null)
    } catch (e) {
      setError(`Can't reach the Bitcoin server: ${(e as Error).message}`)
    } finally {
      setRefreshing(false)
    }
  }, [address, extension])

  useEffect(() => { void refresh() }, [refresh])

  const quote = useCallback(async (to: string, sats: bigint) => {
    const q = await extension().quoteSendTransaction({ to, value: sats.toString(), feeRate: FEE_RATE_SAT_VB })
    return BigInt(q.fee)
  }, [extension])

  /** Signs on the phone and checks the signed transaction pays the quoted fee; returns the hex, not broadcast. */
  const sign = useCallback(async (to: string, sats: bigint, quotedFee: bigint) => {
    const x = extension()
    const hex = await x.signTransaction({ to, value: sats.toString(), feeRate: FEE_RATE_SAT_VB })
    const signedFee = BigInt((await x.quoteSendTransaction(hex)).fee)
    if (signedFee !== quotedFee) throw new Error(`The signed transaction pays ${signedFee} sats in fees, not the ${quotedFee} you approved. Not sent.`)
    return hex
  }, [extension])

  const broadcast = useCallback(async (hex: string) => {
    const r = await extension().sendTransaction(hex, 3000)
    return { txid: r.hash, fee: BigInt(r.fee) }
  }, [extension])

  return { address, loading: acc.isLoading, balance, transfers, error, refreshing, refresh, quote, sign, broadcast }
}
