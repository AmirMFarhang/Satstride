// What the tabs show, read live: the passbook verified on this phone against the chain,
// the oracle's signed price, the order book, the wallet's bitcoin in its three places and
// its assets. Every number comes from the agents' shared code in src/.
import { useCallback, useEffect, useState } from 'react'
import type { Hex } from '../../../../src/core/crypto.js'
import { satsToMicro, MICRO_PER_USDT } from '../../../../src/core/money.js'
import { ladderFromHistory, LADDER_BPS, type LadderState } from '../../../../src/registry/ladder.js'
import { verifyPassbook } from '../../../../src/registry/passbook-doc.js'
import { verifyQuote } from '../../../../src/oracle/oracle.js'
import type { Passbook } from '../../../../src/registry/passbook.js'
import type { Offer } from '../../../../src/market/orderbook.js'
import type { PhoneLoanRecord } from '../agent/platform'
import { reserveView, type ReserveView } from './reserve'
import { useApp } from './session'
import { useStore } from './store'

export type PassbookPage = Passbook['pages'][number]

/** Re-read whenever an agent's stored state changes. */
export function useVersion(): number { return useStore(useApp().version) }

function useLoad<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    setLoading(true)
    try { setData(await load()); setError(null) } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, deps)
  useEffect(() => {
    void run()
    if (!pollMs) return
    const t = setInterval(() => { void run() }, pollMs)
    return () => clearInterval(t)
  }, [run, pollMs])
  return { data, error, loading, reload: run }
}

export interface PassbookView {
  pages: PassbookPage[]
  ladder: LadderState
  ladderBps: readonly number[]
  priceCents: number
  height: number
  /** the person's bitcoin that can back a loan: the main account and the passbook key's free coins */
  btcSats: number
  /** what the earned limit lets the person borrow now, in whole test USDT (micro units) */
  borrowable: number
}

export function usePassbookView() {
  const s = useApp()
  const v = useVersion()
  const mainSats = s.btc.balance
  return useLoad<PassbookView>(async () => {
    const [state, quote, partyUtxos] = await Promise.all([s.platform.state(), s.platform.quote(), s.chain.utxos(s.key.btc.script)])
    if (!verifyQuote(quote, state.oracle_pk)) throw new Error("The platform's price is not signed by its oracle")
    const doc = s.borrowerState.passbook
    const verified = doc ? await verifyPassbook(doc, s.chain) : null
    if (verified && !verified.document_valid) throw new Error('The passbook saved on this phone does not verify')
    const ladder = verified?.ladder ?? ladderFromHistory([])
    const btcSats = Number(mainSats ?? 0n) + partyUtxos.filter((u) => u.height > 0).reduce((t, u) => t + u.value, 0)
    const value = satsToMicro(btcSats, quote.price_cents)
    const borrowable = Math.floor((value * ladder.allowed_ltv_bps) / 10_000 / MICRO_PER_USDT) * MICRO_PER_USDT
    return { pages: verified?.pages ?? [], ladder, ladderBps: LADDER_BPS, priceCents: quote.price_cents, height: state.height, btcSats, borrowable }
  }, [s, v, mainSats])
}

export { viewOffers, type OfferView } from './offers'

export function useOrderbook(pollMs = 15_000) {
  const s = useApp()
  return useLoad(async () => (await s.platform.orderbook()).offers, [s], pollMs)
}

export function useLoanRecord(loanId: Hex | undefined, pollMs = 15_000) {
  const s = useApp()
  return useLoad<PhoneLoanRecord | null>(async () => (loanId ? s.platform.loan(loanId) : null), [s, loanId], pollMs)
}

export interface AssetRow { assetId: string; ticker: string; name: string; precision: number; settled: number; future: number; spendable: number }
export interface RgbRow { idx: number; kind: string; status: string; txid: string | null; amount: number; assetId: string | null; ticker: string | null }

export interface WalletView {
  assets: AssetRow[]
  transfers: RgbRow[]
  reserve: ReserveView
  /** collateral locked in open loans */
  locked: number
}

export function useWalletView(sync = false) {
  const s = useApp()
  const v = useVersion()
  return useLoad<WalletView>(async () => {
    if (sync) await s.module.rgbRefresh({ assetId: null }).catch(() => {})
    const list = await s.module.rgbAssets()
    const rows = (await Promise.all([s.module.rgbTransfers({}), ...list.map((a) => s.module.rgbTransfers({ assetId: a.assetId }))])).map((t, i) => t.map((x) => ({ ...x, assetId: i === 0 ? null : list[i - 1].assetId, ticker: i === 0 ? null : list[i - 1].ticker }))).flat()
    const reserve = await reserveView(s.reserve(), !sync)
    const locked = Object.values(s.borrowerState.loans).filter((l) => l.lock && !l.release_txid).reduce((t, l) => t + l.terms.collateral_sats, 0)
    return {
      assets: list.map((a) => ({ assetId: a.assetId, ticker: a.ticker, name: a.name, precision: a.precision, ...a.balance })),
      transfers: rows.sort((a, b) => b.idx - a.idx),
      reserve,
      locked,
    }
  }, [s, v, sync])
}
