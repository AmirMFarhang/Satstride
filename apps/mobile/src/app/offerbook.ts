// Lender offers read straight from the Nostr relay (kind 38388), not from the platform: each
// event's signature is verified (PhoneRelay.list), the newest per lender and offer kept, the
// payload checked as the platform's order book checks it (src/market/messages.ts
// isOfferPayload, the APR cap from src/core/economics), and expired ones dropped against this
// phone's own view of the chain. The platform's /orderbook is only a labelled cross-check:
// whether the platform lists the same offer (it hides lenders with an overdue fee).
import { useCallback, useEffect, useState } from 'react'
import { readRelayOffers, type RelayBook } from './relay-offers'
import { useApp } from './session'

export type { RelayOffer, RelayBook } from './relay-offers'

export function useRelayOffers(pollMs = 15_000) {
  const s = useApp()
  const [data, setData] = useState<RelayBook | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    setLoading(true)
    try { setData(await readRelayOffers(s)); setError(null) } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [s])
  useEffect(() => { void reload(); const t = setInterval(() => { void reload() }, pollMs); return () => clearInterval(t) }, [reload, pollMs])
  return { data: data?.offers ?? null, book: data, error, loading, reload }
}
