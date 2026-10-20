// What the phone needs from the service provider (docs/SERVICE-PROVIDER.md):
// printed by `infra/service-provider.sh up` and `status --json`, and written to
// $PASSBOOK_SP_STATE/provider.json. Public data only: URLs, public keys,
// release hashes and local scorer metadata. Never a secret.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { loadConfig } from '../src/core/config.js'

const env = (k: string) => process.env[k] ?? ''
const STATE = env('STATE')
const read = <T>(file: string): T | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null } }
const alive = (name: string): boolean => {
  const f = join(STATE, 'pids', `${name}.pid`)
  if (!existsSync(f)) return false
  try { process.kill(Number(readFileSync(f, 'utf8').trim()), 0); return true } catch { return false }
}
const host = env('PUBLIC_HOST') || '127.0.0.1'
const seed = read<{ asset: { id: string; ticker: string }; parties: Record<string, { pubkey: string }> }>(join(STATE, 'state.json'))
const savedNode = read<{ name: string; operator_pk: string; operator_key: string; release: unknown; release_hash: string; payer_modes: string[]; scorer_label: string; status_url: string; price: unknown; rail_names?: string[] }>(join(STATE, 'check-node.json'))
const node = savedNode?.rail_names?.includes('bill-at-close') ? savedNode : null
const assistant = read<{ assistant_pk: string; label: string; corpus_hash: string; kinds?: Record<string, number> }>(join(STATE, 'assistant.json'))
// Public relays carry only events with the test labels (src/agents/relay.ts): the lender peer's, the check node's, the help agent's.
const publicRelays = env('PUBLIC_RELAYS').split(',').map((r) => r.trim()).filter(Boolean)
const evidence_keys: {public_key_hex:string;development?:boolean}[] = []

const out = {
  v: 1,
  kind: 'passbook-service-provider',
  project: env('PROJECT'),
  network: 'regtest',
  test_coins_only: true,
  relay_url: `ws://${host}:${env('RELAY_PORT')}`,
  public_relays: publicRelays,
  public_relay_note: publicRelays.length
    ? 'Test data only. On these relays, as well as relay_url: the lender offer (38388, NIP-40 expiry) and negotiation (7490-7496), the check offer (38401) and check messages (7530-7533), and the help agent (38540, 7540/7541). Each carries a network tag and a NIP-31 alt "test USDT ... no value"; the same event id is on every relay. The platform stays on relay_url.'
    : 'local relay only',
  platform_url: `http://${host}:${env('PLATFORM_PORT')}`,
  asset: seed ? { asset_id: seed.asset.id, ticker: seed.asset.ticker, note: 'regtest test USDT stand-in, not real USDT' } : null,
  lenders: env('LENDERS').split(',').filter((n) => n && n !== 'none').map((name) => ({ name, pubkey: seed?.parties[name]?.pubkey ?? null, status: alive(`peer-${name}`) ? 'running' : 'stopped' })),
  check_nodes: node ? [{ name: node.name, operator_pk: node.operator_pk, operator_key: node.operator_key, status_url: node.status_url.replace('127.0.0.1', host), release: node.release, release_hash: node.release_hash, payer_modes: node.payer_modes, scorer_label: node.scorer_label, price: node.price, status: alive('check-node') ? 'running' : 'stopped' }] : [],
  scorer: { provider: 'in-process', trust: 'dev-inprocess', evidence_keys, note: 'the explicitly accepted check operator declares the local scorer signer; no hardware attestation' },
  assistant: assistant ? { pubkey: assistant.assistant_pk, label: assistant.label, corpus_hash: assistant.corpus_hash, kinds: assistant.kinds ?? null, status: alive('assistant') ? 'running' : 'stopped' } : null,
  rails: { lender_to_check_node: node && node.payer_modes.includes('lender') ? { kind: 'bill-at-close', due: 'at-close', paid_up_front: false } : null },
  services: { platform: alive('platform') ? 'running' : 'stopped', check_node: alive('check-node') ? 'running' : 'stopped', ...(assistant ? { assistant: alive('assistant') ? 'running' : 'stopped' } : {}) },
}
if (env('NETWORK') !== 'mutinynet') {
  console.log(JSON.stringify(out, null, 2))
} else {
  // The provider for two phones on Mutinynet: public endpoints only, plus the platform (over Nostr with P1's bridge,
  // on the LAN as the fallback). No relay, chain or lender of ours; the lender is a phone.
  const m = read<{ platform_pk: string; asset: { id: string; ticker: string; name: string; label: string }; config: string }>(join(STATE, 'mutinynet.json'))
  const profile = m ? loadConfig(m.config, { checkFiles: false }).network : null
  const bridge = existsSync(join(process.cwd(), 'src/server/nostr-api.ts'))
  const platformUrl = `http://${host}:${env('PLATFORM_PORT')}`
  const mutinynet = {
    v: 1, kind: 'passbook-service-provider', project: env('PROJECT'), network: 'mutinynet', test_coins_only: true,
    labels: { btc: 'test BTC (mutinynet)', usdt: 'test USDT (mutinynet)', note: 'Mutinynet is a public signet: test coins only, nothing here has value' },
    public_relays: publicRelays,
    public_relay_note: 'The only relays: the check node (38401, 7530-7533), the help agent (38540, 7540/7541) and, with the bridge, the platform API, each event labelled ["network","mutinynet"] + NIP-31 alt "test USDT ... no value". relay.primal.net also stores events over 64 KiB.',
    endpoints: profile ? { esplora: profile.endpoints.esplora, rgb_indexer: profile.endpoints.rgb_indexer, rgb_proxy: profile.endpoints.rgb_proxy, explorer: profile.explorer, rgb_network: profile.rgbNetwork } : null,
    platform: { pubkey: m?.platform_pk ?? null, relays: bridge ? publicRelays : [], api_over_nostr: bridge ? 'P1 bridge (src/server/nostr-api.ts)' : 'not in this checkout: use lan_url', lan_url: platformUrl, api_auth: 'enforce', status: alive('platform') ? 'running' : 'stopped' },
    platform_url: platformUrl,
    asset: m ? { asset_id: m.asset.id, ticker: m.asset.ticker, name: m.asset.name, label: m.asset.label, issuer: 'Add-on 4\'s Mutinynet run lender wallet (data/mutinynet, on this laptop)' } : null,
    lenders: [],
    lender_note: 'no laptop lender on Mutinynet: the lender is a phone',
    check_nodes: out.check_nodes,
    scorer: out.scorer,
    assistant: out.assistant,
    rails: { check: node ? 'bill-at-close (lane E2): the check fee is added to the lender\'s platform fee at close' : 'check node not running' },
    services: out.services,
  }
  // The phone's deep link (mobile E4; the app has no camera permission, so the QR carries this link and the phone
  // keeps it until the person confirms it in Settings, Network). relay.primal.net first: it alone stores the check
  // messages over 64 KiB on the public relays.
  const linkRelays = [...publicRelays.filter((r) => r.includes('relay.primal.net')), ...publicRelays.filter((r) => !r.includes('relay.primal.net'))]
  const link = `passbookwallet://provider?${new URLSearchParams({ network: 'mutinynet', platform: platformUrl, relays: linkRelays.join(','), ...(m?.platform_pk ? { platform_pk: m.platform_pk } : {}), ...(profile?.endpoints.rgb_proxy ? { proxy: profile.endpoints.rgb_proxy } : {}) }).toString()}`
  // The full public picture, as data next to provider.json (not the QR).
  const qr = {
    v: 1, kind: 'passbook-provider', network: 'mutinynet', relays: publicRelays,
    platform: { pk: mutinynet.platform.pubkey, relays: mutinynet.platform.relays, url: platformUrl }, link_relays: linkRelays,
    esplora: mutinynet.endpoints?.esplora ?? null, rgb_indexer: mutinynet.endpoints?.rgb_indexer ?? null, rgb_proxy: mutinynet.endpoints?.rgb_proxy ?? null,
    asset_id: mutinynet.asset?.asset_id ?? null, check_node_pks: mutinynet.check_nodes.map((c) => c.operator_pk), assistant_pk: mutinynet.assistant?.pubkey ?? null,
    scorer_keys: evidence_keys,
  }
  const qrText = link
  writeFileSync(join(STATE, 'provider-qr.json'), `${JSON.stringify(qr)}\n`)
  writeFileSync(join(STATE, 'provider-link.txt'), `${link}\n`)
  // Rendered with the phone app's own qrcode package (apps/mobile), when it is installed in this checkout.
  const lib = [join(process.cwd(), 'apps/mobile/node_modules/qrcode'), join(process.cwd(), 'node_modules/qrcode')].find((d) => existsSync(d))
  if (lib) {
    const QR = createRequire(import.meta.url)(lib) as { toString(text: string, o: Record<string, unknown>): Promise<string> }
    writeFileSync(join(STATE, 'provider-qr.svg'), await QR.toString(qrText, { type: 'svg', errorCorrectionLevel: 'L', margin: 2 }))
    if (process.env.QR_TERMINAL === '1') process.stderr.write(await QR.toString(qrText, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }))
  }
  console.log(JSON.stringify({ ...mutinynet, phone_link: link, qr: { encodes: 'phone_link', link_file: join(STATE, 'provider-link.txt'), data_file: join(STATE, 'provider-qr.json'), svg: lib ? join(STATE, 'provider-qr.svg') : null, bytes: link.length } }, null, 2))
}
