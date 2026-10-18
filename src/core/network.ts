// Network profiles: which Bitcoin network this Passbook node runs on and where
// its endpoints are. One profile per deployment (passbook.config.yaml `network`
// and `endpoints`). Regtest is the default, the CI network and the live demo.
//
// Two checks, both refusing to start:
// 1. Static, at config load (networkProblems): the name must be a profile that
//    exists (there is no mainnet profile), public networks need their endpoints
//    named, and an endpoint whose host is known to serve another network (a
//    testnet4 node with a Mutinynet indexer) is refused.
// 2. Live, before any wallet opens (probeNetwork): every chain endpoint is
//    asked for its genesis block, and on signets for a marker block (all
//    signets share one genesis), and must match the profile.
// The RGB proxy and Nostr relays are not bound to a chain; the probe only
// checks that the proxy answers.
//
// Test coins never look like real ones: every profile carries the label the
// wallet shows next to every amount and on the badge of every screen.

import { createConnection } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createHash } from 'node:crypto'

export const NETWORK_NAMES = ['regtest', 'mutinynet', 'testnet4'] as const
export type NetworkName = (typeof NETWORK_NAMES)[number]

/** Names people may try for mainnet. None of them has a profile in this release. */
const MAINNET_NAMES = new Set(['mainnet', 'main', 'bitcoin', 'livenet', 'prod', 'production'])

export interface Endpoints {
  /** bitcoind JSON-RPC, e.g. http://127.0.0.1:18443 (regtest) */
  bitcoin_rpc?: string
  /** Esplora REST base, e.g. https://esplora.signet.kaleidoswap.com (no trailing slash) */
  esplora?: string
  /** rgb-lib indexer: tcp:// or ssl:// Electrum, or http(s):// Esplora */
  rgb_indexer: string
  /** RGB consignment proxy: rpc:// or rpcs://…/json-rpc */
  rgb_proxy: string
  /** Nostr relays for the order book: ws:// or wss://; empty means no order book relay */
  nostr: string[]
}

export interface ChainIdentity {
  /** Block 0 hash. */
  genesis: string
  /** Signets share the genesis block; a later block tells them apart. */
  marker?: { height: number; hash: string }
}

export interface NetworkSpec {
  name: NetworkName
  /** What every screen and every amount is labelled with. */
  label: string
  /** The test dollar asset, never plain "USDT". */
  assetLabel: string
  /** The coin, never plain "BTC" on a test network. */
  coinLabel: string
  public: boolean
  /** bitcoinjs network for addresses: regtest is bcrt1, signet and testnet4 are tb1. */
  addressNetwork: 'regtest' | 'testnet'
  /** rgb-lib / WDK RGB network name. Mutinynet is a signet. */
  rgbNetwork: 'regtest' | 'signet' | 'testnet4'
  /** What bitcoind's getblockchaininfo reports as `chain`. */
  rpcChain: 'regtest' | 'signet' | 'testnet4'
  identity: ChainIdentity
  /** Public block explorer, if any. */
  explorer?: string
  /** Hosts known to serve this network (lower case; a leading dot matches subdomains). */
  knownHosts: string[]
}

const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
const SIGNET_GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6'
const TESTNET4_GENESIS = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043'
const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const TESTNET3_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
/** Mutinynet's block 1 (default signet's is 00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53). */
const MUTINYNET_BLOCK_1 = '000002855893a0a9b24eaffc5efc770558a326fee4fc10c9da22fc19cd2954f9'
const DEFAULT_SIGNET_BLOCK_1 = '00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53'

export const NETWORKS: Record<NetworkName, NetworkSpec> = {
  regtest: {
    name: 'regtest', label: 'regtest', assetLabel: 'test USDT (regtest)', coinLabel: 'regtest BTC', public: false,
    addressNetwork: 'regtest', rgbNetwork: 'regtest', rpcChain: 'regtest',
    identity: { genesis: REGTEST_GENESIS }, knownHosts: [],
  },
  mutinynet: {
    name: 'mutinynet', label: 'mutinynet', assetLabel: 'test USDT (mutinynet)', coinLabel: 'mutinynet BTC', public: true,
    addressNetwork: 'testnet', rgbNetwork: 'signet', rpcChain: 'signet',
    identity: { genesis: SIGNET_GENESIS, marker: { height: 1, hash: MUTINYNET_BLOCK_1 } },
    explorer: 'https://mutinynet.com',
    // KaleidoSwap's Esplora is the same chain as mutinynet.com, tip for tip (verified 17 Oct 2026)
    knownHosts: ['mutinynet.com', '.mutinynet.com', 'esplora.signet.kaleidoswap.com'],
  },
  testnet4: {
    name: 'testnet4', label: 'testnet4', assetLabel: 'test USDT (testnet4)', coinLabel: 'testnet4 BTC', public: true,
    addressNetwork: 'testnet', rgbNetwork: 'testnet4', rpcChain: 'testnet4',
    identity: { genesis: TESTNET4_GENESIS },
    explorer: 'https://mempool.space/testnet4',
    knownHosts: ['mempool.space/testnet4', '.testnet4.'],
  },
}

/** Endpoints that are known to serve a network we have no profile for. */
const FOREIGN_HOSTS: { pattern: string; network: string }[] = [
  { pattern: 'mempool.space/signet', network: 'default signet' },
  { pattern: 'mempool.space/testnet/', network: 'testnet3' },
  { pattern: 'blockstream.info/testnet', network: 'testnet3' },
  { pattern: 'blockstream.info/signet', network: 'default signet' },
  { pattern: 'electrum.blockstream.info', network: 'mainnet' },
  { pattern: 'blockstream.info/api', network: 'mainnet' },
  { pattern: 'mempool.space/api', network: 'mainnet' },
]

export interface NetworkProfile extends NetworkSpec {
  endpoints: Endpoints
}

/** Lower-case host + path of a URL, for matching against known hosts. */
function where(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

function matchesKnown(url: string, pattern: string): boolean {
  const w = where(url), host = hostOf(url)
  if (pattern.startsWith('.') && pattern.endsWith('.')) return host.includes(pattern) || host.startsWith(pattern.slice(1))
  if (pattern.startsWith('.')) return host.endsWith(pattern)
  if (pattern.includes('/')) return `${w}/`.startsWith(pattern) || w.startsWith(pattern)
  return host === pattern
}

/** Which profile (or foreign network) a URL's host is known to serve, if any. */
export function knownNetworkOf(url: string): string | null {
  for (const spec of Object.values(NETWORKS)) if (spec.knownHosts.some((p) => matchesKnown(url, p))) return spec.name
  for (const f of FOREIGN_HOSTS) if (matchesKnown(url, f.pattern)) return f.network
  return null
}

const LOCAL_HOSTS = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\]|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|host\.docker\.internal|[a-z0-9-]+)$/

const SCHEMES: Record<keyof Endpoints, RegExp> = {
  bitcoin_rpc: /^https?:\/\/[^\s]+$/,
  esplora: /^https?:\/\/[^\s]+[^/]$/,
  rgb_indexer: /^(tcp|ssl|https?):\/\/[^\s]+$/,
  rgb_proxy: /^rpcs?:\/\/[^\s]+$/,
  nostr: /^wss?:\/\/[^\s]+$/,
}

/** Regtest endpoints from the PASSBOOK_*_PORT variables the local stack uses (infra/compose.yaml). */
export function regtestEndpointsFromEnv(env: NodeJS.ProcessEnv = process.env): Endpoints {
  return {
    bitcoin_rpc: env.BITCOIND_URL ?? `http://127.0.0.1:${env.PASSBOOK_BITCOIND_PORT ?? 18443}`,
    rgb_indexer: env.RGB_INDEXER_URL ?? `tcp://127.0.0.1:${env.PASSBOOK_ELECTRS_PORT ?? 50011}`,
    rgb_proxy: env.RGB_TRANSPORT_URL ?? `rpc://127.0.0.1:${env.PASSBOOK_PROXY_PORT ?? 3010}/json-rpc`,
    nostr: (env.PASSBOOK_RELAYS ?? `ws://127.0.0.1:${env.PASSBOOK_RELAY_PORT ?? 7777}`).split(',').map((s) => s.trim()).filter(Boolean),
  }
}

/**
 * Every problem with a network name and its endpoints, as config problems
 * (`network: …`, `endpoints.<key>: …`). Empty means the combination may start;
 * probeNetwork still has to agree before a wallet opens.
 */
export function networkProblems(name: unknown, endpoints: Partial<Endpoints> | undefined): string[] {
  const out: string[] = []
  if (typeof name !== 'string' || !name) return ['network: must be one of regtest | mutinynet | testnet4']
  if (MAINNET_NAMES.has(name.toLowerCase())) return [`network: ${name} has no profile in this release; Passbook refuses to start on mainnet (test networks only: ${NETWORK_NAMES.join(' | ')})`]
  if (!(NETWORK_NAMES as readonly string[]).includes(name)) return [`network: must be one of ${NETWORK_NAMES.join(' | ')}, got ${JSON.stringify(name)}`]
  const spec = NETWORKS[name as NetworkName]
  const e = endpoints ?? {}
  for (const key of Object.keys(e)) if (!(key in SCHEMES)) out.push(`endpoints.${key}: unknown endpoint (allowed: ${Object.keys(SCHEMES).join(', ')})`)
  const urls: [string, string][] = []
  for (const key of ['bitcoin_rpc', 'esplora', 'rgb_indexer', 'rgb_proxy'] as const) {
    const v = e[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || !SCHEMES[key].test(v)) { out.push(`endpoints.${key}: ${key === 'rgb_proxy' ? 'must be an rpc:// or rpcs:// URL' : key === 'rgb_indexer' ? 'must be a tcp://, ssl:// or http(s):// URL' : key === 'esplora' ? 'must be an http(s) URL without a trailing slash' : 'must be an http(s) URL'}`); continue }
    urls.push([`endpoints.${key}`, v])
  }
  if (e.nostr !== undefined) {
    if (!Array.isArray(e.nostr) || e.nostr.some((r) => typeof r !== 'string' || !SCHEMES.nostr.test(r))) out.push('endpoints.nostr: must be a list of ws:// or wss:// relays')
    else for (const r of e.nostr) urls.push(['endpoints.nostr', r])
  }
  if (spec.public) {
    if (!e.bitcoin_rpc && !e.esplora) out.push(`endpoints: ${name} needs bitcoin_rpc or esplora`)
    for (const key of ['rgb_indexer', 'rgb_proxy'] as const) if (!e[key]) out.push(`endpoints.${key}: required on ${name}`)
  }
  for (const [at, url] of urls) {
    const known = knownNetworkOf(url)
    if (known && known !== name) out.push(`${at}: ${url} serves ${known}, not ${name}; refusing a mixed network`)
    if (!spec.public && !LOCAL_HOSTS.test(hostOf(url))) out.push(`${at}: regtest endpoints must be local or private hosts, got ${hostOf(url)}`)
  }
  return out
}

/** The profile for a validated name and endpoints; regtest fills missing endpoints from the environment. */
export function networkProfile(name: NetworkName = 'regtest', endpoints: Partial<Endpoints> = {}, env: NodeJS.ProcessEnv = process.env): NetworkProfile {
  const problems = networkProblems(name, endpoints)
  if (problems.length) throw new NetworkError(problems)
  const spec = NETWORKS[name]
  const filled: Endpoints = spec.public
    ? { ...(endpoints as Endpoints), nostr: endpoints.nostr ?? [] }
    : { ...regtestEndpointsFromEnv(env), ...Object.fromEntries(Object.entries(endpoints).filter(([, v]) => v !== undefined)) } as Endpoints
  return { ...spec, endpoints: filled }
}

export class NetworkError extends Error {
  constructor(readonly problems: string[]) {
    super(`network profile refused:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'NetworkError'
  }
}

// ---- live probe ----

export interface ProbeResult {
  endpoint: string
  url: string
  /** What the endpoint reported, e.g. "genesis 0f9188f1… (regtest)". */
  saw: string
  ok: boolean
}

export interface ProbeIo {
  fetch: typeof fetch
  /** One Electrum JSON-RPC call over tcp:// or ssl://. */
  electrum: (url: string, method: string, params: unknown[]) => Promise<unknown>
}

const KNOWN_GENESIS: Record<string, string> = {
  [REGTEST_GENESIS]: 'regtest', [SIGNET_GENESIS]: 'a signet', [TESTNET4_GENESIS]: 'testnet4', [MAINNET_GENESIS]: 'MAINNET', [TESTNET3_GENESIS]: 'testnet3',
}
const KNOWN_BLOCK_1: Record<string, string> = { [MUTINYNET_BLOCK_1]: 'mutinynet', [DEFAULT_SIGNET_BLOCK_1]: 'default signet' }

const short = (h: string) => `${h.slice(0, 12)}…`
function named(identity: { genesis: string; block1?: string }): string {
  const g = KNOWN_GENESIS[identity.genesis] ?? 'unknown chain'
  if (g === 'a signet' && identity.block1) return KNOWN_BLOCK_1[identity.block1] ?? 'a custom signet'
  return g
}

/** Block hash of an 80-byte header (hex), as Electrum's blockchain.block.header returns it. */
export function headerHash(headerHex: string): string {
  const h = createHash('sha256').update(createHash('sha256').update(Buffer.from(headerHex, 'hex')).digest()).digest()
  return Buffer.from(h).reverse().toString('hex')
}

async function esploraHash(io: ProbeIo, base: string, height: number): Promise<string> {
  const res = await io.fetch(`${base.replace(/\/$/, '')}/block-height/${height}`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.text()).trim()
}

async function rpcHash(io: ProbeIo, url: string, height: number): Promise<{ hash: string; chain: string }> {
  const call = async (method: string, params: unknown[]) => {
    const u = new URL(url)
    const auth = u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` : `Basic ${Buffer.from(`${process.env.BITCOIND_USER ?? 'user'}:${process.env.BITCOIND_PASSWORD ?? 'password'}`).toString('base64')}`
    u.username = ''; u.password = ''
    const res = await io.fetch(u.toString(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify({ jsonrpc: '1.0', id: 'probe', method, params }), signal: AbortSignal.timeout(10_000) })
    const body = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (body.error) throw new Error(body.error.message)
    return body.result
  }
  const info = (await call('getblockchaininfo', [])) as { chain: string }
  return { hash: (await call('getblockhash', [height])) as string, chain: info.chain }
}

/**
 * Ask every chain endpoint which chain it serves; all must match the profile.
 * Resolves with one row per endpoint; throws NetworkError when any row fails.
 */
export async function probeNetwork(profile: NetworkProfile, io: ProbeIo = defaultProbeIo()): Promise<ProbeResult[]> {
  const rows: ProbeResult[] = []
  const want = profile.identity
  const heights = want.marker ? [0, want.marker.height] : [0]
  const judge = (endpoint: string, url: string, hashes: string[], extra = '') => {
    const identity = { genesis: hashes[0], block1: hashes[1] }
    const ok = hashes[0] === want.genesis && (!want.marker || hashes[1] === want.marker.hash)
    rows.push({ endpoint, url, ok, saw: `genesis ${short(hashes[0])}${hashes[1] ? `, block ${heights[1]} ${short(hashes[1])}` : ''}: ${named(identity)}${extra}` })
  }
  const fail = (endpoint: string, url: string, err: unknown) => rows.push({ endpoint, url, ok: false, saw: `unreachable: ${(err as Error).message}` })
  const e = profile.endpoints
  if (e.bitcoin_rpc) {
    try {
      const got = await Promise.all(heights.map((h) => rpcHash(io, e.bitcoin_rpc!, h)))
      judge('bitcoin_rpc', redact(e.bitcoin_rpc), got.map((g) => g.hash), ` (chain=${got[0].chain})`)
      if (got[0].chain !== profile.rpcChain) rows[rows.length - 1].ok = false
    } catch (err) { fail('bitcoin_rpc', redact(e.bitcoin_rpc), err) }
  }
  if (e.esplora) {
    try { judge('esplora', e.esplora, await Promise.all(heights.map((h) => esploraHash(io, e.esplora!, h)))) } catch (err) { fail('esplora', e.esplora, err) }
  }
  try {
    const hashes = /^https?:/.test(e.rgb_indexer)
      ? await Promise.all(heights.map((h) => esploraHash(io, e.rgb_indexer, h)))
      : await Promise.all(heights.map(async (h) => headerHash((await io.electrum(e.rgb_indexer, 'blockchain.block.header', [h])) as string)))
    judge('rgb_indexer', e.rgb_indexer, hashes)
  } catch (err) { fail('rgb_indexer', e.rgb_indexer, err) }
  try {
    const url = e.rgb_proxy.replace(/^rpc(s?):/, 'http$1:')
    const res = await io.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'server.info', params: null }), signal: AbortSignal.timeout(10_000) })
    const body = (await res.json()) as { result?: { protocol_version?: string; version?: string } }
    const ok = !!body.result?.protocol_version
    rows.push({ endpoint: 'rgb_proxy', url: e.rgb_proxy, ok, saw: ok ? `rgb-proxy ${body.result!.version ?? '?'} (protocol ${body.result!.protocol_version}); not bound to a chain` : 'no server.info answer' })
  } catch (err) { fail('rgb_proxy', e.rgb_proxy, err) }
  const bad = rows.filter((r) => !r.ok)
  if (bad.length) throw new NetworkError(bad.map((r) => `${r.endpoint} ${r.url}: ${r.saw}; the ${profile.name} profile needs ${named({ genesis: want.genesis, block1: want.marker?.hash })}`))
  return rows
}

function redact(url: string): string {
  try { const u = new URL(url); u.username = ''; u.password = ''; return u.toString().replace(/\/$/, '') } catch { return url }
}

/** One Electrum call over tcp:// or ssl:// (newline-delimited JSON-RPC). */
export function electrumCall(url: string, method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
  const u = new URL(url)
  const port = Number(u.port || (u.protocol === 'ssl:' ? 50002 : 50001))
  return new Promise((resolve, reject) => {
    const socket = u.protocol === 'ssl:' ? tlsConnect({ host: u.hostname, port, servername: u.hostname }) : createConnection({ host: u.hostname, port })
    let buf = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')) }, timeoutMs)
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      socket.end()
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { result?: unknown; error?: { message?: string } }
        if (msg.error) reject(new Error(msg.error.message ?? 'electrum error'))
        else resolve(msg.result)
      } catch (err) { reject(err) }
    })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`)
  })
}

export function defaultProbeIo(): ProbeIo {
  return { fetch: globalThis.fetch, electrum: (url, method, params) => electrumCall(url, method, params) }
}

/** Explorer link for a txid on a public profile; null on regtest (no public explorer, never pretend). */
export function explorerTx(profile: Pick<NetworkSpec, 'explorer'>, txid: string): string | null {
  return profile.explorer ? `${profile.explorer}/tx/${txid}` : null
}

export function explorerAddress(profile: Pick<NetworkSpec, 'explorer'>, address: string): string | null {
  return profile.explorer ? `${profile.explorer}/address/${address}` : null
}
