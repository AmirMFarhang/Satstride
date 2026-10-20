// The phone borrower's whole loan against the laptop service provider, run as its own laptop process
// for the funded regtest proof (test/regtest/service-provider-loan.test.ts). It opens ONLY the
// borrower's wallet: it negotiates over Nostr with the provider's lender peer (P1's
// negotiateAsBorrower), gets the lender-paid local signed credit check through the browser-safe borrower
// half (src/checknode/borrower-check.ts), applies naming the KEY the lender forwarded, checks the
// term sheet against the result it opened itself, approves, locks, and waits for the funding; then
// repays and releases. No Lightning on the borrower's side.
//
//   npx tsx infra/service-provider-loan-borrower.ts --persona fatima --history-proof <file> --lender-pk <hex>
//       --operator-pk <hex> --principal <USDT> --max-apr-bps <n> --evidence-keys <file> --out <record.json>

import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { SimplePool, type Event, type Filter } from 'nostr-tools'
import { BorrowerAgent } from '../src/agents/borrower.js'
import { PlatformClient } from '../src/agents/platform-client.js'
import { Relay, relaysFromEnv } from '../src/agents/relay.js'
import { RuleReasoner } from '../src/ai/rule-reasoner.js'
import { BitcoindChain } from '../src/chain/bitcoind.js'
import { Regtest } from '../src/chain/regtest.js'
import { hashObject, signHash } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { listOffers } from '../src/checknode/client.js'
import { runBorrowerCheck, type CheckTransport } from '../src/checknode/borrower-check.js'
import { keyPairSigner } from '../src/checknode/signer.js'
import { KIND } from '../src/market/kinds.js'
import { readJson, type ApplicationPayload, type OfferPayload } from '../src/market/messages.js'
import { DEFAULT_TOLERANCE, type EngineParams, type Position } from '../src/market/negotiate.js'
import { negotiateAsBorrower, negotiationTermsProblems, poolTransport } from '../src/market/negotiate-nostr.js'
import { signBorrowerPolicy } from '../src/market/policy.js'
import { evidenceKeysFromJson } from '../src/scorer/portable-evidence.js'
import { bundleCategories } from '../src/scorer/consent.js'
import { openParty } from '../src/wallet/party.js'
import { LocalKeySigner } from '../src/wallet/signer.js'
import { readState } from '../src/wallet/state.js'

// The provider's lender peer negotiates with these (src/cli/peer.ts NEGOTIATION_PARAMS).
const NEGOTIATION_PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: ['cosign-rgb'] }
const { values: a } = parseArgs({ options: { persona: { type: 'string' }, 'history-proof': { type: 'string' }, 'lender-pk': { type: 'string' }, 'operator-pk': { type: 'string' }, principal: { type: 'string' }, 'max-apr-bps': { type: 'string' }, 'evidence-keys': { type: 'string' }, out: { type: 'string' } } })
const log = (line: string) => console.log(`[borrower] ${line}`)
const record: Record<string, unknown> = { started_at: new Date().toISOString() }
const save = () => writeFileSync(a.out!, `${JSON.stringify(record, null, 2)}\n`)

async function main() {
  const persona = (a.persona ?? 'fatima') as 'fatima' | 'walter' | 'borrower'
  const party = await openParty(persona)
  const chain = BitcoindChain.fromEnv()
  const regtest = new Regtest(chain)
  const relay = new Relay(party.key)
  const state = readState()
  const lenderPk = a['lender-pk']!
  const borrower = new BorrowerAgent({
    party, chain, relay, platform: new PlatformClient(undefined, party.key), reasoner: new RuleReasoner(), mine: (n = 1) => regtest.mine(n), log: (actor, title) => log(`${actor}: ${title}`),
    assetId: state.asset.id, inflows: persona === 'borrower' ? state.borrower_inflows : state.personas![persona].inflows,
    // The trusted observer's signed proof, carried as data: this process holds only the borrower's key.
    ...(a['history-proof'] ? { historyProof: async () => JSON.parse(readFileSync(a['history-proof']!, 'utf8')) } : {}),
  })
  const pool = new SimplePool()
  const relays = relaysFromEnv()
  const transport: CheckTransport = {
    publish: async (e: Event) => { await relay.publish(e) },
    subscribe: (filter: Filter, onEvent: (e: Event) => void) => { const sub = pool.subscribeMany(relays, filter, { onevent: onEvent }); return () => sub.close() },
  }
  try {
    record.borrower_pk = party.key.pubkey
    const principal = Number(a.principal) * MICRO_PER_USDT
    const offer = await borrower.findOffer({ lenderPk, principal, timeoutMs: 120_000 })
    const ask = await borrower.ask(principal, offer.payload.apr_bps, offer.payload.term_blocks)
    // 1. Negotiate over Nostr with only this key (P1).
    const events = (await relay.publicEvents(KIND.OFFER)).filter((e) => e.pubkey === lenderPk && e.tags.some((t) => t[0] === 'd' && `${e.pubkey}:${t[1]}` === offer.id)).sort((x, y) => y.created_at - x.created_at)
    const terms = events.length ? readJson<OfferPayload>(events[0]).negotiation : undefined
    if (!terms || negotiationTermsProblems(terms).length || terms.lender_pk !== lenderPk) throw new Error('the lender advertises no valid negotiation terms on the relay')
    const policy = await signBorrowerPolicy(new LocalKeySigner(party.key), { asset_id: state.asset.id, principal: { min: principal, max: principal }, max_apr_bps: Number(a['max-apr-bps'] ?? 1200), max_ltv_bps: ask.allowed_ltv_bps, term_blocks: { min: offer.payload.term_blocks, max: offer.payload.term_blocks }, min_scorer_trust: 'software-evidence', accepted_settlements: ['cosign-rgb'], issued_at: Math.floor(Date.now() / 1000) })
    const deal = await negotiateAsBorrower({ transport: poolTransport(pool, relays, (e) => relay.publish(e)), signer: keyPairSigner(party.key), policy, terms, params: NEGOTIATION_PARAMS, timeoutMs: 120_000, onMessage: (m, d) => log(`negotiation ${d} ${m.type}`) })
    if (!('agreed' in deal.outcome) || !deal.verified.ok) throw new Error(`no deal: ${'no_deal' in deal.outcome ? deal.outcome.no_deal : 'transcript does not verify'}`)
    const agreed: Position = deal.outcome.agreed
    record.negotiation = { negotiation_id: deal.negotiation_id, messages: deal.messages.length, agreed, transcript_hash: hashObject(deal.messages) }
    log(`agreed ${agreed.principal} at ${agreed.apr_bps / 100}% APR, LTV ${agreed.ltv_bps / 100}%`)
    // 2. The lender-paid local signed credit check, borrower half (browser-safe; the phone runs the same module).
    const bundle = await borrower.buildSandboxBundle(offer, principal, agreed.apr_bps)
    const checkOffer = (await listOffers(relay, Math.floor(Date.now() / 1000))).valid.find((o) => o.operator_pk === a['operator-pk'])
    if (!checkOffer) throw new Error('the check node\'s offer is not on the relay')
    const { part, view } = await runBorrowerCheck({
      transport, signer: keyPairSigner(party.key), offer: checkOffer, lenderPk, negotiationId: deal.negotiation_id, bundle,
      dataCategories: bundleCategories(bundle), evidenceKeys: evidenceKeysFromJson(JSON.parse(readFileSync(a['evidence-keys']!, 'utf8'))),
      timeoutMs: 900_000, onStage: (stage, detail) => log(`check ${stage}: ${detail}`),
    })
    record.check = { ok: view.ok, recommendation: view.outputs?.recommendation ?? null, outputs_v: view.outputs?.v ?? null, commitment: view.commitment, execution_id: view.execution_id, key_message_hash: view.key_message_hash, rail_label: view.rail_label, key_source: view.key_source, consent: { payer: part.consent.payer, operator_pk: part.consent.operator_pk, release_hash: part.consent.release_hash }, failing: view.ticks.filter((t) => !t.ok).map((t) => t.id) }
    save()
    if (!view.ok || !view.outcome || !view.commitment || !view.key_message_hash) throw new Error(`the check does not verify on this device: ${view.ticks.filter((t) => !t.ok).map((t) => t.id).join(', ')}`)
    if (view.outputs?.recommendation !== 'QUALIFY') throw new Error(`the check says ${view.outputs?.recommendation}: only QUALIFY is funded`)
    // 3. Apply: the application names the KEY the lender forwarded and the consent the operator signed in. Nothing disclosed.
    const outstanding = [...borrower.loans.values()].filter((l) => !l.release_txid && !l.settlement_txid).reduce((s, l) => s + l.terms.principal + l.terms.fee, 0)
    const app: ApplicationPayload = {
      offer_id: offer.id, principal, term_blocks: offer.payload.term_blocks, sandbox_result: null, attestation: null, check_key: view.key_message_hash,
      disclosed_inflows: [], passbook: borrower.passbookDocument(), outstanding_statement: { outstanding_micro: outstanding, sig: signHash(hashObject({ outstanding_micro: outstanding }), party.key.secretKey) },
      negotiation: deal.messages, consent: part.consent,
    }
    await relay.send(KIND.APPLICATION, app, lenderPk)
    log('application sent naming the lender-paid check')
    // 4. The term sheet must name the evidence this borrower opened, the scored loan, this check's commitment and operator.
    const accepted = await borrower.awaitAcceptance(offer, principal, { agreed, accept_hash: deal.verified.accept_hash!, messages: deal.messages, maker_checker_above_micro: offer.payload.max, scored: view.outcome, check: { commitment: view.commitment, operator_pk: view.operator_pk, receipt_contract_id: null } })
    borrower.approveTermSheet(accepted.loan_id)
    record.loan_id = accepted.loan_id
    log(`term sheet ${accepted.loan_id.slice(0, 12)}… checked against the opened result and approved`)
    // 5. Lock, wait for the funding, repay, release.
    const lock = await borrower.lockAndSplit(accepted.loan_id)
    record.lock_txid = lock.lock_txid
    save()
    record.disbursement_txid = await borrower.awaitFunding(accepted.loan_id)
    log(`funded: ${String(record.disbursement_txid).slice(0, 12)}…`)
    save()
    record.repayment_txid = await borrower.repay(accepted.loan_id)
    record.iou_return_txid = await borrower.awaitIouReturn(accepted.loan_id)
    record.release_txid = await borrower.release(accepted.loan_id)
    record.completed_at = new Date().toISOString()
    save()
    log('repaid and released')
  } finally {
    pool.close(relays)
    borrower.close()
    party.close()
  }
}

main().catch((err) => { record.error = (err as Error).message; save(); console.error(`[borrower] ${(err as Error).message}`); process.exitCode = 1 })
