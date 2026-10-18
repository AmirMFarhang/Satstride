// The regtest service provider on public relays: after test/regtest/service-provider-loan.test.ts ran against an
// `infra/service-provider.sh up` with PASSBOOK_SP_PUBLIC_RELAYS, and with the borrower on the public relays only,
// read back from each public relay every event the provider's keys and the borrower signed during the run, check
// that each is labelled test data and validly signed, and record it as `regtest_provider` in docs/PUBLIC-NETWORK-RUN.json.
//
//   npx tsx infra/public-regtest-proof.ts --state <PASSBOOK_SP_STATE> --since <unix seconds> [--borrower-relays <list>]

import './public-ws-guard.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { SimplePool, verifyEvent, type Event } from 'nostr-tools'
import { isLabelled } from '../src/agents/relay.js'
import { TOPIC } from '../src/market/kinds.js'

const { values } = parseArgs({ options: { state: { type: 'string' }, since: { type: 'string' }, 'borrower-relays': { type: 'string' }, record: { type: 'string' } } })
if (!values.state || !values.since) throw new Error('usage: --state <dir> --since <unix seconds>')
const state = resolve(values.state)
const recordFile = resolve(values.record ?? 'docs/PUBLIC-NETWORK-RUN.json')
const provider = JSON.parse(readFileSync(join(state, 'provider.json'), 'utf8')) as { project: string; relay_url: string; public_relays: string[]; lenders: { pubkey: string }[]; check_nodes: { operator_pk: string }[] }
const proof = JSON.parse(readFileSync(join(state, 'loan-proof', 'record.json'), 'utf8')) as {
  at: string; seconds: number; borrower: { pk?: string; borrower_pk?: string; loan_id: string; negotiation?: unknown; check: { ok: boolean; recommendation: string }; lock_txid: string; disbursement_txid: string; repayment_txid?: string; release_txid: string; [k: string]: unknown }
  lender: { check?: { verified: boolean; paid?: unknown }; negotiation?: { negotiation_id: string; agreed: unknown; messages: number }; fee?: unknown } | null
  chain: unknown; check_node: unknown
}
const lender = provider.lenders[0].pubkey
const operator = provider.check_nodes[0].operator_pk
const borrower = (proof.borrower.borrower_pk ?? proof.borrower.pk) as string | undefined
const role = (pk: string) => (pk === lender ? 'lender peer' : pk === operator ? 'check node' : pk === borrower ? 'borrower' : 'other')
const relays = provider.public_relays
const since = Number(values.since)

const pool = new SimplePool()
const perRelay: Record<string, { events: number; labelled_and_valid: number }> = {}
const seen = new Map<string, { id: string; kind: number; by: string; created_at: number; relays: string[]; labelled: boolean }>()
try {
  for (const r of relays) {
    const got = (await pool.querySync([r], { authors: [lender, operator, ...(borrower ? [borrower] : [])], since, '#t': [TOPIC] }, { maxWait: 8000 })) as Event[]
    const ok = got.filter((e) => verifyEvent(e) && isLabelled(e, 'regtest'))
    perRelay[r] = { events: got.length, labelled_and_valid: ok.length }
    for (const e of got) {
      const row = seen.get(e.id) ?? { id: e.id, kind: e.kind, by: role(e.pubkey), created_at: e.created_at, relays: [], labelled: verifyEvent(e) && isLabelled(e, 'regtest') }
      row.relays.push(r)
      seen.set(e.id, row)
    }
  }
} finally { pool.close(relays) }
const events = [...seen.values()].sort((a, b) => a.created_at - b.created_at).map((e) => ({ ...e, view: `https://njump.me/${e.id}` }))

const section = {
  title: 'The regtest service provider on public relays: a borrower on the public relays only borrows from it',
  recorded_at: new Date().toISOString(),
  project: provider.project, network: 'regtest', test_coins_only: true,
  setup: 'infra/service-provider.sh up with PASSBOOK_SP_PUBLIC_RELAYS=default: the lender peer, the check node and their Relays (src/agents/relay.ts) on the local relay and the public ones, labelling every event; the platform local. The borrower process (infra/service-provider-loan-borrower.ts, only Fatima\'s key) had ONLY the public relays.',
  relays: { provider: [provider.relay_url, ...relays], borrower: (values['borrower-relays'] ?? relays.join(',')).split(',') },
  loan: {
    seconds: proof.seconds, loan_id: proof.borrower.loan_id, check: { recommendation: proof.borrower.check.recommendation, borrower_verified: proof.borrower.check.ok, lender_verified: proof.lender?.check?.verified ?? null, paid: 'over the lender\'s RGB Lightning HODL rail (regtest)' },
    negotiation: proof.lender?.negotiation ?? null, lock_txid: proof.borrower.lock_txid, disbursement_txid: proof.borrower.disbursement_txid, release_txid: proof.borrower.release_txid, chain: proof.chain,
  },
  public_events: { per_relay: perRelay, all_labelled_and_valid: events.length > 0 && events.every((e) => e.labelled), by_role: Object.fromEntries(['lender peer', 'check node', 'borrower'].map((r) => [r, events.filter((e) => e.by === r).length])), events },
  not_covered: ['regtest chain (local); the public relays carried the market and check messages only', 'the borrower is a laptop process standing in for the phone (the phone adds the public relays in M8)'],
}
const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) as Record<string, unknown> : {}
writeFileSync(recordFile, `${JSON.stringify({ ...record, regtest_provider: section }, null, 2)}\n`)
console.log(JSON.stringify({ per_relay: perRelay, events: events.length, by_role: section.public_events.by_role, all_labelled_and_valid: section.public_events.all_labelled_and_valid }, null, 2))
process.exit(0)
