// Errors in words. A connection failure says which service the phone could not reach and what to
// check; anything else keeps its own message. The raw text stays available as a detail line, so
// nothing is hidden.
import { activeNetwork } from '../core/network'

export type ErrorKind = 'platform' | 'relay' | 'chain' | 'lender' | 'other'

export interface PlainError { kind: ErrorKind; text: string; detail: string | null }

const CONNECT = /network request failed|fetch failed|failed to fetch|econnrefused|econnreset|enotfound|etimedout|socket hang up|connection (refused|reset|closed)|could not connect|unable to connect|aborted/i

/** The worklet's errors arrive as JSON ({"code","message"}); the words are in `message`. */
function unwrap(message: string): string {
  const m = message.trim()
  if (!m.startsWith('{')) return m
  try { const j = JSON.parse(m) as { message?: unknown; error?: unknown }; return String(j.message ?? j.error ?? m) } catch { return m }
}

export function plainError(message: string): PlainError {
  const m = unwrap(message)
  if (/InvalidIndexer|not a valid electrum nor esplora server|IndexerError|Indexer\(/i.test(m)) {
    const regtest = activeNetwork().name === 'regtest'
    return { kind: 'chain', text: regtest ? "This phone can't reach the regtest test servers; they run on the laptop over USB. For the internet test network, switch to Mutinynet in Settings, Network." : "Can't reach the RGB indexer for Mutinynet. Your keys and coins are safe; try again in a moment.", detail: m }
  }
  if (/no platform address/i.test(m)) return { kind: 'platform', text: "No service provider is set. Open the provider's link (its QR) and confirm it in Settings, Network.", detail: m }
  if (/no answer from the platform over Nostr/i.test(m)) return { kind: 'platform', text: "The service provider did not answer over Nostr. Check that it is running; your keys and coins are safe.", detail: m }
  if (/timed out waiting for kind/i.test(m)) return { kind: 'lender', text: 'No answer came over Nostr in time. The other side may be offline or may have declined.', detail: m }
  if (/no relay accepted|relay|websocket|wss?:\/\//i.test(m) && (CONNECT.test(m) || /no relay accepted|closed|websocket/i.test(m))) return { kind: 'relay', text: activeNetwork().public ? "Can't reach the Nostr relays. Check the phone's internet connection." : "Can't reach the Nostr relay. Check that the phone is connected to the service provider.", detail: m }
  if (/electrum|indexer|tcp:\/\/|50171/i.test(m) && CONNECT.test(m)) return { kind: 'chain', text: "Can't reach the Bitcoin server. Your keys and coins are safe; balances update when it is back.", detail: m }
  if (CONNECT.test(m) || /^(GET|POST) \/[^ ]* \(5\d\d\)/.test(m)) return { kind: 'platform', text: activeNetwork().name === 'regtest' ? "Can't reach the service provider. Check that the phone is connected to it (USB) and that it is running." : "Can't reach the service provider. Check its address in Settings, Network, and that it is running.", detail: m }
  return { kind: 'other', text: m, detail: null }
}

export const isConnectionError = (message: string | null | undefined): boolean => !!message && plainError(message).kind !== 'other'
