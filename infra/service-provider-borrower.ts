// The phone's half of a lender-paid credit check, run as its own laptop process
// for the regtest proof (test/regtest/service-provider-check.test.ts): it opens
// ONLY the borrower's wallet (its wallets directory holds nothing else), builds
// the bundle for the lender's offer, and runs the browser-safe borrower half
// (src/checknode/borrower-check.ts) over the relay with a CheckSigner around its
// key. No Lightning: the lender pays. The phone runs the same module through Metro.
//
//   npx tsx infra/service-provider-borrower.ts [--persona fatima --history-proof <file>] --negotiation <hex> --lender-pk <hex> --operator-pk <hex>
//       --principal <USDT> --apr-bps <n> --evidence-keys <scorer-keys.json> --out <view.json>

import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { SimplePool, type Event, type Filter } from 'nostr-tools'
import { BorrowerAgent } from '../src/agents/borrower.js'
import { PlatformClient } from '../src/agents/platform-client.js'
import { Relay, relaysFromEnv } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { BitcoindChain } from '../src/chain/bitcoind.js'
import { Regtest } from '../src/chain/regtest.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { listOffers } from '../src/checknode/client.js'
import { runBorrowerCheck, type CheckTransport } from '../src/checknode/borrower-check.js'
import { keyPairSigner } from '../src/checknode/signer.js'
import { evidenceKeysFromJson } from '../src/scorer/portable-evidence.js'
import { bundleCategories } from '../src/scorer/consent.js'
import { bundleLoan } from '../src/scorer/bundle-terms.js'
import { hashObject } from '../src/core/crypto.js'
import { readFileSync } from 'node:fs'
import { openParty } from '../src/wallet/party.js'
import { readState } from '../src/wallet/state.js'

const { values: a } = parseArgs({ options: { persona: { type: 'string' }, 'history-proof': { type: 'string' }, negotiation: { type: 'string' }, 'lender-pk': { type: 'string' }, 'operator-pk': { type: 'string' }, principal: { type: 'string' }, 'apr-bps': { type: 'string' }, 'evidence-keys': { type: 'string' }, out: { type: 'string' } } })
const log = (line: string) => console.log(`[borrower] ${line}`)

async function main() {
  // The seeded default borrower, or a persona whose history the platform's trusted observer saw from zero.
  const persona = (a.persona ?? 'borrower') as 'borrower' | 'fatima' | 'walter'
  const party = await openParty(persona)
  const chain = BitcoindChain.fromEnv()
  const regtest = new Regtest(chain)
  const relay = new Relay(party.key)
  const state = readState()
  const borrower = new BorrowerAgent({ party, chain, relay, platform: new PlatformClient(undefined, party.key), reasoner: new RuleReasoner(), mine: (n = 1) => regtest.mine(n), log: () => undefined, assetId: state.asset.id, inflows: persona === 'borrower' ? state.borrower_inflows : state.personas![persona].inflows,
    // The observer's signed proof, carried as data: this process holds only the borrower's key.
    ...(a['history-proof'] ? { historyProof: async () => JSON.parse(readFileSync(a['history-proof']!, 'utf8')) } : {}) })
  const pool = new SimplePool()
  const relays = relaysFromEnv()
  const transport: CheckTransport = {
    publish: async (e: Event) => { const r = await Promise.allSettled(pool.publish(relays, e)); if (!r.some((x) => x.status === 'fulfilled')) throw new Error('no relay accepted the event') },
    subscribe: (filter: Filter, onEvent: (e: Event) => void) => { const sub = pool.subscribeMany(relays, filter, { onevent: onEvent }); return () => sub.close() },
  }
  try {
    const principal = Number(a.principal) * MICRO_PER_USDT
    const offer = await borrower.findOffer({ lenderPk: a['lender-pk'], principal, timeoutMs: 60_000 })
    const bundle = await borrower.buildSandboxBundle(offer, principal, Number(a['apr-bps']))
    const loan = bundleLoan(bundle)
    log(`bundle for offer ${offer.id.slice(0, 12)}…: ${bundle.history.length} history rows, loan ${loan.loan_request.principal} + fee ${loan.loan_request.fee} over ${loan.loan_request.term_blocks} blocks (requirements ${hashObject(bundle.lender_requirements).slice(0, 12)}…)`)
    const checkOffer = (await listOffers(relay, Math.floor(Date.now() / 1000))).valid.find((o) => o.operator_pk === a['operator-pk'])
    if (!checkOffer) throw new Error('the check node\'s offer is not on the relay')
    const { part, view } = await runBorrowerCheck({
      transport, signer: keyPairSigner(party.key), offer: checkOffer, lenderPk: a['lender-pk']!, negotiationId: a.negotiation!, bundle,
      dataCategories: bundleCategories(bundle), evidenceKeys: evidenceKeysFromJson(JSON.parse(readFileSync(a['evidence-keys']!, 'utf8'))),
      timeoutMs: 900_000, onStage: (stage, detail) => log(`${stage}: ${detail}`),
    })
    writeFileSync(a.out!, `${JSON.stringify({ borrower_pk: party.key.pubkey, part_hash: hashObject(part), consent: { operator_pk: part.consent.operator_pk, payer: part.consent.payer, release_hash: part.consent.release_hash, purpose_id: part.consent.purpose_id, data_categories: part.consent.data_categories }, loan, view: { ...view, outcome: view.outcome ? { kind: view.outcome.kind } : null, outputs: view.outputs ? { v: view.outputs.v, recommendation: view.outputs.recommendation, checks: view.outputs.checks } : null } }, null, 2)}\n`)
    log(view.ok ? `opened and verified on this device: ${view.outputs?.recommendation}` : `does NOT verify: ${view.ticks.filter((t) => !t.ok).map((t) => t.id).join(', ')}`)
    process.exitCode = view.ok ? 0 : 1
  } finally {
    pool.close(relays)
    relay.close()
    party.close()
  }
}

main().catch((err) => { console.error(`[borrower] ${(err as Error).message}`); process.exitCode = 1 })
