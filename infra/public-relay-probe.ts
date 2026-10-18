// Which public Nostr relays carry Passbook's kinds? One small, throwaway, test-labelled
// event per relay and kind, then read back by id. Never assume: relays refuse kinds,
// require payment or proof of work, or rate-limit.
//
//   npx tsx infra/public-relay-probe.ts [--relays wss://a,wss://b] [--kinds 38388,38401,7491,7533] [--out file.json]
//
// Every probe event is signed by a fresh throwaway key (never a lender's or an operator's),
// carries t=passbook-probe (not the order book's t=passbook, so no client reads it as an
// offer), a network tag, "test USDT" in its content and a NIP-40 expiration 10 minutes out.
// Encrypted kinds (kinds.ts, plus the agent on call's 7540/7541) carry a NIP-44 payload addressed to the throwaway key itself.

import './public-ws-guard.mjs'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { finalizeEvent, nip44, Relay, type Event } from 'nostr-tools'
import { keyPairFromSecret, randomHex } from '../src/core/crypto.js'
import { ENCRYPTED_KINDS } from '../src/market/kinds.js'

/** Relays to try by default: free, general-purpose relays plus one paid relay, to record the refusal too. */
export const CANDIDATE_RELAYS = [
  'wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.wine', 'wss://relay.nostr.band',
  'wss://nostr.mom', 'wss://relay.snort.social', 'wss://offchain.pub',
]
const DEFAULT_KINDS = [38388, 38401, 7490, 7491, 7533, 7541, 38540]
/** The agent on call's encrypted kinds (lane D2, passbook-assist/v1), probed before they reach kinds.ts. */
const ENCRYPTED = new Set([...ENCRYPTED_KINDS, 7540, 7541])

export interface ProbeRow { relay: string; kind: number; event_id: string | null; accepted: boolean; stored: boolean; message: string; ms: number }

/** The probe event: test-labelled, expiring, from a throwaway key. Exported for the unit test. */
export function probeEvent(secret: string, kind: number, network: string, nowSec = Math.floor(Date.now() / 1000)): Event {
  const key = keyPairFromSecret(secret)
  const note = `Passbook relay probe: test data only (${network}, test USDT, no value). Expires in 10 minutes.`
  const content = ENCRYPTED.has(kind) ? nip44.encrypt(note, nip44.getConversationKey(key.secretKey, key.pubkey)) : JSON.stringify({ probe: true, note })
  const tags = [['t', 'passbook-probe'], ['network', network], ['expiration', String(nowSec + 600)], ['alt', note]]
  if (kind >= 30000 && kind < 40000) tags.unshift(['d', `probe-${randomHex(4)}`])
  if (ENCRYPTED.has(kind)) tags.push(['p', key.pubkey])
  return finalizeEvent({ kind, created_at: nowSec, tags, content }, key.secretKey)
}

async function probeOne(url: string, event: Event, timeoutMs: number): Promise<ProbeRow> {
  const t0 = Date.now()
  const row: ProbeRow = { relay: url, kind: event.kind, event_id: event.id, accepted: false, stored: false, message: '', ms: 0 }
  let relay: Relay | undefined
  const timeout = <T>(p: Promise<T>, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), timeoutMs))])
  try {
    relay = await timeout(Relay.connect(url), 'connect')
    row.message = await timeout(relay.publish(event), 'publish')
    row.accepted = true
    // read it back by id: accepted is not always stored (some relays answer OK and drop unknown kinds)
    row.stored = await timeout(new Promise<boolean>((resolve) => {
      let found = false
      const sub = relay!.subscribe([{ ids: [event.id] }], { onevent: () => { found = true }, oneose: () => { sub.close(); resolve(found) } })
    }), 'read back')
  } catch (err) {
    row.message = (err as Error).message ?? String(err)
  } finally {
    row.ms = Date.now() - t0
    try { relay?.close() } catch { /* already closed */ }
  }
  return row
}

export async function probeRelays(relays: string[], kinds: number[], network = 'regtest', timeoutMs = 8000): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = []
  for (const url of relays) {
    // one throwaway key per relay; one event per kind, sequential and spaced, so no relay sees a burst
    const secret = randomHex(32)
    for (const kind of kinds) {
      rows.push(await probeOne(url, probeEvent(secret, kind, network), timeoutMs))
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  return rows
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { relays: { type: 'string' }, kinds: { type: 'string' }, network: { type: 'string' }, out: { type: 'string' } } })
  const relays = values.relays ? values.relays.split(',').map((s) => s.trim()).filter(Boolean) : CANDIDATE_RELAYS
  const kinds = values.kinds ? values.kinds.split(',').map(Number) : DEFAULT_KINDS
  const rows = await probeRelays(relays, kinds, values.network ?? 'regtest')
  for (const r of rows) console.log(`${r.accepted && r.stored ? 'ok  ' : r.accepted ? 'OK? ' : 'NO  '} ${r.relay.padEnd(28)} ${String(r.kind).padEnd(6)} ${r.ms}ms ${r.message.slice(0, 100)}`)
  if (values.out) writeFileSync(values.out, `${JSON.stringify({ at: new Date().toISOString(), network: values.network ?? 'regtest', rows }, null, 2)}\n`)
  process.exit(0)
}
