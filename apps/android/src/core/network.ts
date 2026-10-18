// The network badge on every screen, and the test asset's name. Test coins never
// look like real ones: on any network but mainnet the asset is "test USDT (<network>)",
// never plain "USDT", and the badge says the coins are for testing. Same words as
// the web wallet panel (web/wallet-strings.js on work/addon4-wallet: badge
// "<network> · test coins", asset "test USDT (regtest)"), read from the node's
// GET /wallet/api/network when it has one.

export type NetworkId = 'regtest' | 'mutinynet' | 'signet' | 'testnet' | 'testnet4' | 'mainnet' | 'fake' | 'unknown'

export interface Network {
  id: NetworkId | string
  /** The badge text, e.g. "REGTEST · test coins". */
  badge: string
  test: boolean
  /** What the phone calls the dollar asset on this network, e.g. "test USDT (regtest)". */
  asset: string
}

/** GET /wallet/api/network's `network` (src/server/wallet-routes.ts on work/addon4-wallet). */
export interface NetworkProfile { name: string; label: string; asset: string; coin?: string; public?: boolean }

const KNOWN: NetworkId[] = ['regtest', 'mutinynet', 'signet', 'testnet', 'testnet4', 'mainnet', 'fake']
const TEST_COINS = 'test coins'

export const NOT_PAIRED_BADGE = 'NOT PAIRED · no network yet'

/**
 * The node's own profile when it publishes one; else GET /state's `network` or
 * `chain` (this demo's node runs bitcoind on regtest, or a fake chain in tests).
 * Anything unrecognised counts as a test network, and so does any asset label
 * that is plain "USDT" off mainnet.
 */
export function networkOf(state: Record<string, unknown> | null | undefined, profile?: NetworkProfile | null): Network {
  if (profile && typeof profile.name === 'string' && typeof profile.label === 'string') {
    const test = profile.name !== 'mainnet'
    const asset = test && !/test/i.test(profile.asset ?? '') ? `test USDT (${profile.name})` : profile.asset
    return { id: profile.name, badge: test ? `${profile.label.toUpperCase()} · ${TEST_COINS}` : profile.label.toUpperCase(), test, asset }
  }
  const raw = state && typeof state.network === 'object' && state.network !== null ? (state.network as Record<string, unknown>).name ?? (state.network as Record<string, unknown>).id : state?.network
  const named = typeof raw === 'string' ? raw.toLowerCase() : null
  const id: NetworkId = named ? (KNOWN.includes(named as NetworkId) ? (named as NetworkId) : 'unknown') : state?.chain === 'bitcoind' ? 'regtest' : state?.chain === 'fake' ? 'fake' : 'unknown'
  const label = id === 'fake' ? 'FAKE CHAIN' : id === 'unknown' ? 'UNKNOWN NETWORK' : id.toUpperCase()
  const test = id !== 'mainnet'
  return { id, badge: test ? `${label} · ${TEST_COINS}` : label, test, asset: test ? `test USDT (${id === 'fake' || id === 'unknown' ? 'test' : id})` : 'USDT' }
}

/**
 * The node's sentences name amounts "600.00 USDT"; on a test network the phone
 * shows "600.00 test USDT (regtest)" and drops the node's own "(test USDT on
 * regtest)" note, which then says it twice. Only the asset name changes; every
 * number is the node's.
 */
export function labelAsset(text: string, net: Network): string {
  if (!net.test) return text
  return text.replace(/ \(test USDT on [a-z0-9]+\)/g, '').replace(/(\d) USDT\b/g, `$1 ${net.asset}`)
}
