// Smoke test of the platform API over Nostr from the phone's client, on the laptop:
// the phone's NostrPlatformCall over real relays (WebSocket) to a running platform
// started with PASSBOOK_PLATFORM_RELAYS (src/server/nostr-api.ts). A labelled test
// key signs; nothing here moves money.
//   npx tsx scripts/platform-nostr-smoke.ts <platform_pk> ws://127.0.0.1:7977[,wss://…]
import { SimplePool } from 'nostr-tools'
import { NostrPlatformCall, readPlatformInfo } from '../src/agent/platform-nostr.ts'
import { keyPairSigner, poolTransport } from '../../../src/market/negotiate-nostr.ts'
import { keyPairFromLabel, sha256Hex, signHash, signObject } from '../../../src/core/crypto.ts'

const platformPk = process.argv[2]
const relays = (process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
if (!/^[0-9a-f]{64}$/.test(platformPk ?? '') || !relays.length) { console.error('usage: platform-nostr-smoke.ts <platform_pk> <relay,…>'); process.exit(2) }
const key = keyPairFromLabel('e5-smoke-borrower')
const signer = { ...keyPairSigner(key), signRequest: async (r: { method: string; pathAndQuery: string; timestampMs: number; nonce: string; bodySha256: string }) => signHash(sha256Hex(['passbook-request-v1', r.method.toUpperCase(), r.pathAndQuery, String(r.timestampMs), r.nonce, r.bodySha256].join('\n')), key.secretKey) }
const pool = new SimplePool()
const transport = poolTransport(pool, relays)
const out: Record<string, unknown> = {}
const t = Date.now()
const info = await readPlatformInfo(transport, platformPk, 10_000)
out.info = { network: info.network, relays: info.relays, routes: info.routes.length, test_data: info.test_data }
const call = new NostrPlatformCall({ transport, signer, platformPk })
let t0 = Date.now()
const state = await call.call<{ platform_pk: string; height: number; chain: string }>('GET', '/state')
out.state = { platform_pk_matches: state.platform_pk === platformPk, chain: state.chain, height: state.height, ms: Date.now() - t0 }
t0 = Date.now()
out.wire = { ...(await call.call<{ ok: boolean }>('POST', '/wire', signObject({ actor_pk: key.pubkey, role: 'borrower', title: 'E5 smoke over a real relay', detail: null }, key.secretKey))), ms: Date.now() - t0 }
t0 = Date.now()
out.wire_multichunk = { ...(await call.call<{ ok: boolean }>('POST', '/wire', signObject({ actor_pk: key.pubkey, role: 'borrower', title: 'E5 smoke, 70 kB note', detail: 'z'.repeat(70_000) }, key.secretKey))), ms: Date.now() - t0 }
try { await call.call('POST', '/oracle/set', { price_cents: 1 }); out.operator_route = 'NOT REFUSED' } catch (err) { out.operator_route = (err as Error).message }
try { await call.call('POST', '/loans', { terms: {} }); out.party_write = 'NOT REFUSED' } catch (err) { out.party_write = (err as Error).message }
out.total_ms = Date.now() - t
console.log(JSON.stringify(out, null, 2))
pool.close(relays)
process.exit(0)
