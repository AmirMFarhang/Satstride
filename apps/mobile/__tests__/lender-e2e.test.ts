// E3 laptop rehearsal (docs/PHONE-LENDER-REHEARSAL.json): the phone lender's own code (PhoneLender +
// NegotiatedDesk, its signed policy, serveNegotiations, E2's browser-safe lender half, the review and the term sheet)
// against a separate borrower key holder (the shared borrower half and negotiateAsBorrower, as the
// borrower phone runs them) and the local billed check node, over one relay. The actual
// in-process scorer signs results from the deterministic investigator over the
// fatima fixture. Nothing here touches a chain: funding, release and the fee are M6's proven path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyEvent } from 'nostr-tools'
import { writeFileSync } from 'node:fs'
import { hashObject, keyPairFromLabel, signHash, signObject, type Hex } from '../../../src/core/crypto.ts'
import { termInterest } from '../../../src/core/economics.ts'
import { MICRO_PER_USDT } from '../../../src/core/money.ts'
import { termsHash } from '../../../src/core/terms.ts'
import { Oracle } from '../../../src/oracle/oracle.ts'
import { signPassbook } from '../../../src/registry/passbook-doc.ts'
import { KIND } from '../../../src/market/kinds.ts'
import { signBorrowerPolicy } from '../../../src/market/policy.ts'
import { negotiateAsBorrower, type NegotiationTerms } from '../../../src/market/negotiate-nostr.ts'
import { termSheetHash } from '../../../src/market/termsheet.ts'
import type { AcceptancePayload, ApplicationPayload } from '../../../src/market/messages.ts'
import { LocalKeySigner } from '../../../src/wallet/signer.ts'
import { investigationFixture } from '../../../src/sandbox/investigation-fixtures.ts'
import { PlaybookReasoner } from '../../../src/ai/playbook-reasoner.ts'
import { SandboxScorerEngine } from '../../../src/scorer/providers.ts'
import { bundleCategories } from '../../../src/scorer/consent.ts'
import { loadScoringContract } from '../../../src/scorer/contract.ts'
import { termSheetEvidenceProblems } from '../../../src/scorer/evidence-digest-core.ts'
import { MemoryBillLedger } from '../../../src/checknode/bill-ledger.ts'
import { runBorrowerCheck } from '../../../src/checknode/borrower-check.ts'
import { MemoryBus, MemoryHub } from '../../../src/checknode/bus.ts'
import { SandboxCheckEngine } from '../../../src/checknode/engine.ts'
import { CheckNode } from '../../../src/checknode/node.ts'
import { latestOffers } from '../../../src/checknode/offer.ts'
import { keyPairSigner } from '../../../src/checknode/signer.ts'
import type { CheckMessage } from '../../../src/checknode/messages.ts'
import type { CheckTransport } from '../../../src/checknode/borrower-check.ts'
import { PASSBOOK_ONLY, PhoneLender, countersignedSheetProblems, type PhoneLenderState } from '../src/agent/lender.ts'
import { PhoneBorrower } from '../src/agent/borrower.ts'
import { NegotiatedDesk } from '../src/lender/desk.ts'
import { closeFees } from '../src/lender/fees.ts'
import { engineParams, offerTerms, signMarketPolicy } from '../src/lender/market-policy.ts'
import { lenderTranscript } from '../src/lender/views.ts'
import { partyKey } from './lender-helpers.ts'

const U = MICRO_PER_USDT
const USDT = 'rgb:test-usdt-mutinynet'
const lenderKey = keyPairFromLabel('e3-rehearsal-lender'), borrowerKey = keyPairFromLabel('fatima'), operator = keyPairFromLabel('e3-rehearsal-operator')
const checker = keyPairFromLabel('e3-rehearsal-chain-checker'), platform = keyPairFromLabel('e3-rehearsal-platform'), oracleKey = keyPairFromLabel('e3-rehearsal-oracle')
const OFFER = { ...PASSBOOK_ONLY, apr_bps: 1100 }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Relay events retain signatures and encryption; this test keeps transport in memory. */
function memoryTransport(hub: MemoryHub): CheckTransport {
  return {
    publish: async (e) => { hub.publish(e) },
    subscribe: (filter, onEvent) => {
      const matches = (e: (typeof hub.events)[number]) => (!filter.kinds || filter.kinds.includes(e.kind)) && (!filter.authors || filter.authors.includes(e.pubkey)) && (!filter['#p'] || e.tags.some((t) => t[0] === 'p' && filter['#p']!.includes(t[1])))
      for (const e of [...hub.events]) if (matches(e)) onEvent(e)
      return hub.subscribe((e) => { if (matches(e)) onEvent(e) })
    },
  }
}

test('rehearsal: negotiate over Nostr, billed local check, review, term sheet, approval, acceptance the borrower accepts', { timeout: 60_000 }, async () => {
  const log: string[] = []
  const hub = new MemoryHub()
  const f = investigationFixture('fatima')
  const contract = loadScoringContract()
  // The actual in-process scorer: signed result and run record, deterministic local investigator.
  const scorer = new SandboxScorerEngine({ provider: 'in-process', key: checker, chain: f.chain, reasoner: new PlaybookReasoner(), blocksPerMonth: 30, oraclePk: f.oracle.pubkey, measurement: 'source:' + 'ab'.repeat(32), contract })
  const engine = new SandboxCheckEngine(scorer, { label: 'local in-process scorer (development assurance)', fallback: false, modelHash: null })
  let scorerError: Error | undefined
  const originalRun = engine.run.bind(engine)
  engine.run = async (...args) => { try { return await originalRun(...args) } catch (e) { scorerError = e as Error; throw e } }
  const ledger = new MemoryBillLedger()
  const node = new CheckNode({ operator, engine, bus: new MemoryBus(hub, operator), rails: {}, assets: [{ asset_id: USDT, ticker: 'USDT', amount: 500_000, kind: 'payment' }], approvalTimeoutMs: 10_000, billing: { maxPerDay: 3, ttlSeconds: 30 * 24 * 3600, ledger, feeGate: async () => null } } as never)
  await node.publishOffer()

  // the lender phone's agent: its own key, the platform and relay as ports
  const oracle = new Oracle(oracleKey, 6_000_000)
  const key = partyKey(lenderKey)
  const relay = {
    relays: [] as string[],
    publishPublic: async (kind: number, payload: unknown, tags: string[][] = []) => { const e = await key.signEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'passbook'], ...tags], content: JSON.stringify(payload) }); hub.publish(e as never); return e },
    send: async (kind: number, payload: unknown, to: Hex, tags: string[][] = []) => { const e = await key.signEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'passbook'], ['p', to], ...tags], content: await key.nip44Encrypt(to, JSON.stringify(payload)) }); hub.publish(e as never); return e },
    list: async (kind: number) => hub.events.filter((e) => e.kind === kind).map((e) => ({ payload: JSON.parse(e.content), event: e })),
    transport: () => memoryTransport(hub),
  }
  const registered: Hex[] = []
  const phonePlatform = {
    state: async () => ({ platform_pk: platform.pubkey, oracle_pk: oracleKey.pubkey, chain: 'regtest', height: 100, price_cents: 6_000_000, deployment: { negotiation: { enabled: true, max_rounds: 4, concession_bps: 2500 } } }),
    quote: async () => oracle.quote(100),
    fees: async () => ({ height: 100, fees: [], blocked: null }),
    note: async () => ({}),
    registerLoan: async (terms: never) => { const id = termsHash(terms); registered.push(id); return { loan: { id, status: 'pending' }, verdict: { ok: true, checks: [] } } },
  }
  const state: PhoneLenderState = { loans: {}, declined: [] }
  const lender = new PhoneLender(key as never, phonePlatform as never, relay as never, { getHeight: async () => 100, getTx: async () => null } as never, {} as never, {} as never, USDT, state, (s) => log.push(`lender: ${s.step}`))
  const desk = new NegotiatedDesk({ lender, state, transport: () => memoryTransport(hub) as never, evidenceKeys: async () => [], changed: () => {}, allowDevelopment: true, network: 'mutinynet' })
  lender.negotiated = (app, pk) => desk.review(app, pk)

  // stop 1 on the phone: post the negotiated offer (signed policy; the check node it accepts)
  const params = engineParams({ negotiation: { max_rounds: 4, concession_bps: 2500 } })
  const policy = await signMarketPolicy(key, USDT, OFFER, { floor_apr_bps: 900, check_operators: [operator.pubkey], max_check_price: { asset_id: USDT, amount: 1_000_000 } })
  state.market = { policy, params }
  await lender.publishOffer(OFFER, { negotiation: offerTerms(policy, params, OFFER.min, 0) })
  desk.start()

  // the check node answers one REQUEST
  const served = (async () => { const { payload, event } = await new MemoryBus(hub, operator).receive<CheckMessage>(KIND.CHECK_REQUEST, null, { timeoutMs: 30_000, match: (x) => x.type === 'REQUEST' }); return node.handle(payload, event.pubkey) })()

  // the borrower: reads the offer's terms from the relay, negotiates with its own key only
  const offerEvent = hub.events.find((e) => e.kind === KIND.OFFER && e.pubkey === lenderKey.pubkey)!
  const terms = JSON.parse(offerEvent.content).negotiation as NegotiationTerms
  assert.ok(offerEvent.tags.some((t) => t[0] === 'expiration') === false, 'no public labels set on this lender (publicTags empty in the harness)')
  const bp = await signBorrowerPolicy(new LocalKeySigner(borrowerKey), { asset_id: USDT, principal: { min: 100 * U, max: 100 * U }, max_apr_bps: 1050, max_ltv_bps: 5000, term_blocks: { min: 30, max: 30 }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: 1 })
  const t0 = Date.now()
  const neg = await negotiateAsBorrower({ transport: memoryTransport(hub) as never, signer: keyPairSigner(borrowerKey), policy: bp, terms, params, timeoutMs: 5_000 })
  assert.ok('agreed' in neg.outcome, JSON.stringify(neg.outcome))
  const agreed = neg.outcome.agreed
  log.push(`negotiation: ${neg.messages.map((m) => m.type).join(' -> ')} at ${agreed.apr_bps / 100}% / ${agreed.ltv_bps / 100}%`)

  // the borrower's check part, for exactly the agreed loan; the lender's desk runs its half on its own
  const offers = latestOffers(hub.events.filter((e) => e.kind === KIND.CHECK_OFFER).map((e) => ({ offer: JSON.parse(e.content), created_at: e.created_at, pubkey: e.pubkey as Hex })), Math.floor(Date.now() / 1000)).valid
  const checkOffer = offers.find((o) => o.operator_pk === operator.pubkey)!
  const bundle = { ...f.bundle, asset_id: USDT, loan_request: { ...f.bundle.loan_request, principal: agreed.principal, fee: termInterest({ principal: agreed.principal, apr_bps: agreed.apr_bps, term_blocks: OFFER.term_blocks }), term_blocks: OFFER.term_blocks, grace_blocks: OFFER.grace_blocks }, lender_requirements: OFFER.requirements }
  const b = await runBorrowerCheck({ transport: memoryTransport(hub), signer: keyPairSigner(borrowerKey), offer: checkOffer, lenderPk: lenderKey.pubkey, negotiationId: neg.negotiation_id, bundle: bundle as never, dataCategories: bundleCategories(bundle as never), evidenceKeys: [], allowDevelopment: true, timeoutMs: 20_000 }).catch((e) => { throw scorerError ?? e })
  const entry = await served
  assert.equal(entry.status, 'billed')
  assert.ok(b.view.ok, JSON.stringify(b.view.ticks.filter((t) => !t.ok)))
  for (let i = 0; i < 100 && !state.negotiations?.[neg.negotiation_id]?.check; i++) await wait(50)
  const rec = state.negotiations![neg.negotiation_id]
  assert.ok(rec.check, rec.check_error ?? `stage ${rec.check_stage}`)
  assert.deepEqual(rec.check!.refusals, [], 'a verified QUALIFY of exactly the agreed loan')
  const lenderCheckEvents = hub.events.filter((e) => e.pubkey === lenderKey.pubkey && (e.kind === KIND.CHECK_REQUEST || e.kind === KIND.CHECK_KEY))
  assert.ok(lenderCheckEvents.some((e) => e.kind === KIND.CHECK_REQUEST) && lenderCheckEvents.some((e) => e.kind === KIND.CHECK_KEY))
  for (const e of lenderCheckEvents) {
    assert.ok(e.tags.some((t) => t[0] === 'network' && t[1] === 'mutinynet'), 'every lender check request, approval and forwarded-key event names its network')
    assert.ok(e.tags.some((t) => t[0] === 'alt' && t[1].includes('test USDT on mutinynet, no value. Not real USDT.')), 'every lender check event is labelled test data')
    assert.ok(verifyEvent(e), 'the test-data labels are covered by the event signature')
  }
  assert.equal(rec.check!.recommendation, 'QUALIFY')
  assert.equal(rec.check!.key_hash, b.view.key_message_hash, 'the KEY the lender forwarded is the one the borrower opened')
  assert.ok(rec.check!.not_run.length > 0, 'the phone reports the local host assurance limits')
  assert.equal(state.bills?.[0]?.amount, 500_000)
  log.push(`check: ${rec.check!.recommendation}, ${rec.check!.ticks.filter((x) => x.ok).length}/${rec.check!.ticks.length} ticks on the lender phone, bill ${rec.check!.bill.amount} billed at close; not run: ${rec.check!.not_run.join('; ')}`)

  // the app restarts before the application arrives: the agent and the desk come back from app storage alone
  const stored = JSON.parse(JSON.stringify(state)) as PhoneLenderState
  const lender2 = new PhoneLender(key as never, phonePlatform as never, relay as never, { getHeight: async () => 100, getTx: async () => null } as never, {} as never, {} as never, USDT, stored, (s) => log.push(`lender (restarted): ${s.step}`))
  const desk2 = new NegotiatedDesk({ lender: lender2, state: stored, transport: () => memoryTransport(hub) as never, evidenceKeys: async () => [], changed: () => {}, allowDevelopment: true, network: 'mutinynet' })
  lender2.negotiated = (app, pk) => desk2.review(app, pk)
  assert.ok(stored.negotiations![neg.negotiation_id].check!.outcome, 'the verified outcome survives the restart')

  // the borrower's application names the forwarded KEY and the consent; the (restarted) lender reviews it
  const app: ApplicationPayload = {
    offer_id: lender.offerId(OFFER), principal: agreed.principal, term_blocks: OFFER.term_blocks, sandbox_result: null, attestation: null, check_key: b.view.key_message_hash!, disclosed_inflows: [],
    passbook: signPassbook(borrowerKey, []), outstanding_statement: { outstanding_micro: 0, sig: signHash(hashObject({ outstanding_micro: 0 }), borrowerKey.secretKey) }, negotiation: neg.messages, consent: b.part.consent,
  } as ApplicationPayload
  const reviewed = await lender2.review(OFFER, app, borrowerKey.pubkey)
  assert.ok('proposal' in reviewed, JSON.stringify(reviewed))
  const loanId = reviewed.proposal
  // stop 2 on the phone: approve the sheet (the lock is lend-flow's), register, send the acceptance
  await desk2.approveAndSend(loanId)
  assert.equal(stored.negotiations![neg.negotiation_id].check!.outcome, null, 'cleared once the sheet carries its digest')
  assert.deepEqual(registered, [loanId])
  const accEvent = hub.events.filter((e) => e.kind === KIND.ACCEPTANCE).at(-1)!
  const acceptance = JSON.parse(await partyKey(borrowerKey).nip44Decrypt(lenderKey.pubkey, accEvent.content)) as AcceptancePayload

  // the borrower phone's own checks of the sheet (M7 PhoneBorrower.sheetProblems), with the check it opened
  const problems = PhoneBorrower.prototype.sheetProblems.call(null, acceptance.terms, acceptance, { agreed, accept_hash: neg.verified.accept_hash!, messages: neg.messages, maker_checker_above_micro: Number.MAX_SAFE_INTEGER, check: { execution_id: b.view.execution_id, operator_pk: b.view.operator_pk, commitment: b.view.commitment, recommendation: b.view.outputs?.recommendation ?? null, outcome: b.view.outcome } })
  assert.deepEqual(problems, [], 'the borrower phone accepts the sheet')
  assert.deepEqual(termSheetEvidenceProblems(acceptance.termsheet!, b.view.outcome!), [])

  // the borrower countersigns; the lender's fund() requires exactly this before any money moves
  const hash = termSheetHash(acceptance.termsheet!)
  const countersigned = { ...acceptance.termsheet!, signatures: { ...acceptance.termsheet!.signatures, borrower: signHash(hash, borrowerKey.secretKey) } }
  const approval = signObject({ v: 1 as const, domain: 'passbook-approval-v1' as const, termsheet_hash: hash, approver_pk: borrowerKey.pubkey, role: 'borrower' as const, approved_at: 1 }, borrowerKey.secretKey)
  assert.deepEqual(countersignedSheetProblems(stored.loans[loanId], { termsheet: countersigned, borrower_approval: approval }, loanId, undefined, policy), [])
  assert.ok(countersignedSheetProblems(stored.loans[loanId], { termsheet: acceptance.termsheet, borrower_approval: approval }, loanId, undefined, policy).length > 0, 'not countersigned: refused')

  // at close: the platform share plus this bill, accounted for
  const bill = stored.loans[loanId].check_bill!
  assert.equal(bill.borrower_pk, borrowerKey.pubkey)
  const share = 13_500
  const fee = closeFees({ loan_id: loanId, lender_pk: lenderKey.pubkey, asset_id: USDT, outcome: 'repaid', interest: 90_000, share_bps: 1500, amount: share + bill.amount, share_amount: share, check_fees: [{ ...bill, commitment: rec.check!.bill.bill_hash, linked_by: 'lender-borrower-window' }], status: 'fee_due', invoice: 'rgb:fee', recipient_id: 'r', closed_height: 131, grace_until_height: 137 } as never, stored.bills ?? [], { borrower_pk: borrowerKey.pubkey, own: [bill] })
  assert.deepEqual(fee.problems, [])
  desk.stop()

  const transcript = lenderTranscript(state.negotiations![neg.negotiation_id].messages, borrowerKey.pubkey)
  const record = {
    v: 1, kind: 'passbook-e3-laptop-rehearsal', at: new Date().toISOString(), ms: Date.now() - t0,
    note: 'Laptop rehearsal, not a device run: the phone lender code under Node; E2 lender half (#71); scorer runs locally with a deterministic test investigator and signed results; no chain (funding/release/fee are M6\'s regtest-proven path).',
    lender_pk: lenderKey.pubkey, borrower_pk: borrowerKey.pubkey, operator_pk: operator.pubkey, negotiation_id: neg.negotiation_id,
    transcript: transcript.lines.map((l) => `#${l.seq} ${l.who === 'You' ? 'Lender' : 'Borrower'} ${l.text}`), agreed,
    check: { recommendation: rec.check!.recommendation, ticks_ok: rec.check!.ticks.filter((x) => x.ok).length, ticks: rec.check!.ticks.length, not_run: rec.check!.not_run, bill: rec.check!.bill, execution_id: rec.check!.execution_id, rail_label: rec.check!.rail_label },
    termsheet_hash: loanId, evidence: acceptance.termsheet!.scorer.evidence, borrower_sheet_problems: problems, fee_at_close: { share: fee.share, checks: fee.checks_total, total: fee.total }, log,
  }
  if (process.env.E3_RECORD) writeFileSync(process.env.E3_RECORD, JSON.stringify(record, null, 2))
})
