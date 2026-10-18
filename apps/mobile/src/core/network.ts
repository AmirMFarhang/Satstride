// The test networks this build talks to, and nothing else. Regtest: the laptop's regtest stack,
// reached over USB with `adb reverse` (127.0.0.1 on the phone). Mutinynet: a public signet,
// reached over the internet with no cable (an Electrum server, KaleidoSwap's RGB proxy, public
// Nostr relays) and the platform where the provider says it is. The wallet refuses to start on
// anything else, mainnet above all, and every amount it shows names its test network, so nothing
// on screen can pass for real money.

export type NetworkName = 'regtest' | 'mutinynet'
export const NETWORK_NAMES: readonly NetworkName[] = ['regtest', 'mutinynet']

export interface NetworkProfile {
  name: NetworkName
  /** WDK's BTC chain mode: bcrt1 addresses on regtest, tb1 on the signets. */
  btcNetwork: 'regtest' | 'testnet'
  /** WDK's network key for this chain (wdk.config.js): WDK keeps addresses per key, so each network has its own. */
  btcKey: 'bitcoin' | 'bitcoin-mutinynet'
  /** rgb-lib's BitcoinNetwork. */
  rgbNetwork: 'Regtest' | 'Signet'
  /** Shown on every screen. */
  badge: string
  /** Bech32 human-readable part of this network's addresses. */
  hrp: 'bcrt' | 'tb'
  /** The Electrum server for the BTC wallet and the agent's chain reads. */
  electrum: { host: string; port: number; protocol: 'tcp' | 'ssl' }
  /** rgb-lib's indexer: an electrs with verbose transactions (tcp://…) or an Esplora (https://…). */
  rgbIndexer: string
  /** The RGB proxy (consignment transport): rpc:// or rpcs:// … /json-rpc. */
  proxy: string
  /** The Passbook platform API (signed requests) over HTTP: on Mutinynet the fallback when platformPk is set. */
  platform: string
  /** The platform's key, from the provider's link: its API over Nostr (src/agent/platform-nostr.ts), no route to the laptop needed. */
  platformPk: string | null
  /** Nostr relays: offers, negotiation, the credit check. The first one must keep large events. */
  relays: string[]
  /** Units as the UI writes them: never plain "BTC" or "USDT". */
  btcUnit: string
  usdUnit: string
  /** Public networks get the test-data labels on every event they publish. */
  public: boolean
  /** Block explorer for links, when there is one. */
  explorer?: string
}

const port = (v: string | undefined, d: number): number => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : d
}

export const REGTEST: NetworkProfile = {
  name: 'regtest',
  btcNetwork: 'regtest',
  btcKey: 'bitcoin',
  rgbNetwork: 'Regtest',
  badge: 'REGTEST · test coins',
  hrp: 'bcrt',
  // Literal EXPO_PUBLIC_* reads: babel-preset-expo inlines only literal keys.
  electrum: { host: '127.0.0.1', port: port(process.env.EXPO_PUBLIC_PASSBOOK_ELECTRUM_PORT, 50171), protocol: 'tcp' },
  rgbIndexer: `tcp://127.0.0.1:${port(process.env.EXPO_PUBLIC_PASSBOOK_ELECTRUM_PORT, 50171)}`,
  proxy: `rpc://127.0.0.1:${port(process.env.EXPO_PUBLIC_PASSBOOK_PROXY_PORT, 3260)}/json-rpc`,
  platform: `http://127.0.0.1:${port(process.env.EXPO_PUBLIC_PASSBOOK_PLATFORM_PORT, 4301)}`,
  platformPk: null,
  relays: [`ws://127.0.0.1:${port(process.env.EXPO_PUBLIC_PASSBOOK_RELAY_PORT, 7937)}`],
  btcUnit: 'test BTC',
  usdUnit: 'test USDT',
  public: false,
}

/** Mutinynet's block 1 (src/core/network.ts MUTINYNET_BLOCK_1): all signets share a genesis, block 1 tells them apart. */
export const MUTINYNET_BLOCK_1 = '000002855893a0a9b24eaffc5efc770558a326fee4fc10c9da22fc19cd2954f9'

export const MUTINYNET: NetworkProfile = {
  name: 'mutinynet',
  btcNetwork: 'testnet',
  btcKey: 'bitcoin-mutinynet',
  rgbNetwork: 'Signet',
  badge: 'MUTINYNET · test coins',
  hrp: 'tb',
  // verified 18 Oct 2026: its block 1 is MUTINYNET_BLOCK_1
  electrum: { host: 'electrum.mutinynet.com', port: 50001, protocol: 'tcp' },
  // rgb-lib refuses mempool-electrs ("verbose transactions are currently unsupported"): it reads
  // Mutinynet through KaleidoSwap's Esplora, as the laptop's Mutinynet profile does
  rgbIndexer: 'https://esplora.signet.kaleidoswap.com',
  proxy: 'rpcs://proxy.kaleidoswap.com/json-rpc',
  // the provider tells the phone where its platform is (Settings or its link); none by default
  platform: '',
  platformPk: null,
  // relay.primal.net keeps the credit check's large events (>64 KiB); the others cap them
  relays: ['wss://relay.primal.net', 'wss://nos.lol', 'wss://nostr.mom'],
  btcUnit: 'test BTC (mutinynet)',
  usdUnit: 'test USDT (mutinynet)',
  public: true,
  explorer: 'https://mutinynet.com',
}

export interface NetworkOverrides { platform?: string; platformPk?: string | null; relays?: string[]; electrum?: NetworkProfile['electrum']; proxy?: string }

const LOCAL = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|\[?::1\]?$)/

const isUrl = (s: string, protocols: string[]): boolean => {
  try { return protocols.includes(new URL(s).protocol) } catch { return false }
}
const hostOf = (u: string): string => { try { return new URL(u).hostname } catch { return '' } }

/** Every reason the overrides do not fit the network; none means they may be saved. */
export function overrideProblems(name: NetworkName, o: NetworkOverrides): string[] {
  const problems: string[] = []
  if (o.platform !== undefined && o.platform !== '' && !isUrl(o.platform, ['http:', 'https:'])) problems.push('the platform address must be an http(s) URL')
  if (o.relays !== undefined) {
    if (!o.relays.length) problems.push('at least one relay')
    for (const r of o.relays) if (!isUrl(r, ['ws:', 'wss:'])) problems.push(`not a relay address: ${r}`)
    if (name === 'mutinynet' && o.relays.some((r) => r.startsWith('ws:') && !LOCAL.test(hostOf(r)))) problems.push('public relays must use wss://')
  }
  if (o.proxy !== undefined && !/^rpcs?:\/\/[^/]+\/json-rpc$/.test(o.proxy)) problems.push('the RGB proxy must be rpc(s)://host/json-rpc')
  if (o.platformPk && !/^[0-9a-f]{64}$/.test(o.platformPk)) problems.push('the platform key must be 64 hex characters')
  if (name === 'regtest') {
    if (o.platform && !LOCAL.test(hostOf(o.platform))) problems.push('a regtest platform must be on a local or private address')
    for (const r of o.relays ?? []) if (!LOCAL.test(hostOf(r))) problems.push(`a regtest relay must be local: ${r}`)
  }
  return problems
}

/** The profile for a network with the person's (or the provider's) endpoints; refuses anything that is not a test network. */
export function profileFor(name: string, o: NetworkOverrides = {}): NetworkProfile {
  if (name !== 'regtest' && name !== 'mutinynet') throw new Error(`Passbook Wallet runs on regtest or Mutinynet only; refusing "${name}"`)
  const base = name === 'regtest' ? REGTEST : MUTINYNET
  const problems = overrideProblems(name, o)
  if (problems.length) throw new Error(`network settings refused: ${problems.join('; ')}`)
  return {
    ...base,
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
    ...(o.platformPk ? { platformPk: o.platformPk } : {}),
    ...(o.relays?.length ? { relays: [...o.relays] } : {}),
    ...(o.electrum ? { electrum: o.electrum } : {}),
    ...(o.proxy ? { proxy: o.proxy } : {}),
  }
}

/** Throws unless the profile is one of the test networks (so never mainnet). Called before the worklet starts. */
export function assertTestNetwork(p: Pick<NetworkProfile, 'name' | 'btcNetwork' | 'rgbNetwork'>): void {
  const ok = (p.name === 'regtest' && p.btcNetwork === 'regtest' && p.rgbNetwork === 'Regtest') || (p.name === 'mutinynet' && p.btcNetwork === 'testnet' && p.rgbNetwork === 'Signet')
  if (!ok) throw new Error(`Passbook Wallet runs on test networks only; refusing "${p.name}/${p.btcNetwork}/${p.rgbNetwork}"`)
}

/**
 * The provider's link (its QR, opened by the phone's own camera app, or pasted):
 * passbookwallet://provider?network=mutinynet&platform=<url>&relays=<wss,…>&platform_pk=<hex>.
 * Returns what it would set; the person confirms before anything is saved.
 */
export function parseProviderLink(link: string): { name: NetworkName; overrides: NetworkOverrides; platformPk: string | null } | { error: string } {
  let u: URL
  try { u = new URL(link.trim()) } catch { return { error: 'not a provider link' } }
  if (u.protocol !== 'passbookwallet:' || (u.hostname !== 'provider' && u.pathname.replace(/^\/+/, '') !== 'provider')) return { error: 'not a Passbook provider link' }
  const name = u.searchParams.get('network') ?? ''
  if (name !== 'regtest' && name !== 'mutinynet') return { error: `refused: "${name || 'no network'}" is not a test network this wallet runs on` }
  const overrides: NetworkOverrides = {}
  const platform = u.searchParams.get('platform')
  if (platform) overrides.platform = platform
  const relays = u.searchParams.get('relays')
  if (relays) overrides.relays = relays.split(',').map((r) => r.trim()).filter(Boolean)
  const proxy = u.searchParams.get('proxy')
  if (proxy) overrides.proxy = proxy
  const problems = overrideProblems(name, overrides)
  if (problems.length) return { error: problems.join('; ') }
  const pk = u.searchParams.get('platform_pk')
  if (pk !== null && !/^[0-9a-f]{64}$/.test(pk)) return { error: 'the platform key must be 64 hex characters' }
  if (pk) overrides.platformPk = pk
  return { name, overrides, platformPk: pk || null }
}

const BECH32 = /^[02-9ac-hj-np-z]+$/

/** A recipient check before anything is quoted or signed: right network, plausible bech32. */
export function checkRecipient(address: string, p: Pick<NetworkProfile, 'hrp' | 'name'>): { ok: true; address: string } | { ok: false; reason: string } {
  const a = address.trim()
  if (!a) return { ok: false, reason: 'Enter an address.' }
  const lower = a.toLowerCase()
  if (a !== lower && a !== a.toUpperCase()) return { ok: false, reason: 'Mixed-case address.' }
  if (/^(bc1|[13])/i.test(a)) return { ok: false, reason: `That is a mainnet address. This wallet only sends test coins on ${p.name}.` }
  if (p.hrp === 'bcrt' && /^(tb1|[mn2])/i.test(a)) return { ok: false, reason: 'That is a testnet/signet address, not regtest.' }
  if (p.hrp === 'tb' && /^bcrt1/i.test(a)) return { ok: false, reason: `That is a regtest address, not ${p.name}.` }
  if (!lower.startsWith(`${p.hrp}1`)) return { ok: false, reason: `Not a ${p.name} address (they start with ${p.hrp}1).` }
  const data = lower.slice(p.hrp.length + 1)
  if (data.length < 39 || data.length > 90 || !BECH32.test(data)) return { ok: false, reason: 'Not a valid bech32 address.' }
  return { ok: true, address: lower }
}

/**
 * Bitcoin Core's dust threshold for an output to this (already checked) address at the
 * default dust relay fee: 294 sats for P2WPKH, 330 for P2WSH and P2TR (v1).
 */
export function dustFor(address: string, p: Pick<NetworkProfile, 'hrp'>): bigint {
  const a = address.trim().toLowerCase()
  const version = a.charAt(p.hrp.length + 1)
  if (version === 'q') return a.length - p.hrp.length - 1 > 45 ? 330n : 294n
  return 330n
}

/**
 * The tags every event this phone signs carries on a public network (D4's labels): the network,
 * and a NIP-31 alt text that says it is test data. None on regtest (a local relay).
 */
export function testLabelTags(p: { name: string; public: boolean }): string[][] {
  return p.public ? [['network', p.name], ['alt', `Passbook test data: test USDT on ${p.name}, no value. Not real USDT.`]] : []
}

/** On a public network an event is ours only if it names this network; a local relay carries only ours. */
export function eventOnNetwork(tags: string[][], p: { name: string; public: boolean }): boolean {
  if (!p.public) return true
  return tags.some((t) => t[0] === 'network' && t[1] === p.name)
}

// The profile this app run uses, set once at start (src/wallet/config.ts); regtest until then
// (and in the laptop tests), so labels are always a test network's.
let active: NetworkProfile = REGTEST
export function activeNetwork(): NetworkProfile { return active }
export function setActiveNetwork(p: NetworkProfile): void { assertTestNetwork(p); active = p }
