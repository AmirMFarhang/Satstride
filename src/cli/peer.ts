// Standalone legacy peers. Each process opens exactly one party wallet; the
// lender never reads the borrower's state file or wallet history.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { SimplePool } from 'nostr-tools'
import { BorrowerAgent } from '../agents/borrower.js'
import { L1_POLICY, L2_POLICY, LenderAgent } from '../agents/lender.js'
import { PlatformClient } from '../agents/platform-client.js'
import { Relay, relaysFromEnv } from '../agents/relay.js'
import { RuleReasoner } from '../ai/rule-reasoner.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { Regtest } from '../chain/regtest.js'
import { hashObject, isHex, type Hex, type KeyPair } from '../core/crypto.js'
import { btc, usdt, type Micro } from '../core/money.js'
import { debtOf } from '../core/terms.js'
import { approve as approveSheet } from '../market/approvals.js'
import { KIND } from '../market/kinds.js'
import { readJson, type AcceptancePayload, type OfferPayload } from '../market/messages.js'
import { DEFAULT_TOLERANCE, type EngineParams, type NegotiationMessage, type Position } from '../market/negotiate.js'
import { keyPairSigner, negotiateAsBorrower, negotiationTermsProblems, poolTransport } from '../market/negotiate-nostr.js'
import { signBorrowerPolicy, signLenderPolicy } from '../market/policy.js'
import { LocalKeySigner } from '../wallet/signer.js'
import { verifyPassbook } from '../registry/passbook-doc.js'
import { openParty, type Role } from '../wallet/party.js'
import { readState } from '../wallet/state.js'
import { noTeeVerifier } from '../checknode/tee.js'
import { deploymentConfigFromEnv } from '../core/config.js'
import { loadScoringContract } from '../scorer/contract.js'
import { devReleaseSigner, loadReleaseManifest } from '../scorer/releases.js'
import { payFeesCommand, settleBeforePublishing, settleClosedLoan, settlePlatformFees, type Confirm } from './peer-fees.js'

const HELP = `Standalone Passbook peers (regtest test USDT; legacy RGB repayment + cooperative release).
  npm run peer -- --role lender --wallet lender1 --asset-id rgb:... [--policy legacy|history]
  npm run peer -- --role lender --wallet lender1 --asset-id rgb:... --pay-fees   pay platform fees due, then exit
  npm run peer -- --role borrower [--lender-wallet lender1|lender2] [--principal 600]
  npm run peer -- --role lender ... --negotiate [--min-apr-bps 1000]   negotiate over Nostr before underwriting
  npm run peer -- --role borrower ... --negotiate [--max-apr-bps 1200]
  --provider (lender) is --negotiate: provider mode, as infra/service-provider.sh runs it.
  npm run peer -- --role lender ... --lender-pays-check [--check-operators <pk,pk>]
      negotiate, then pay for the borrower's credit check on a check node (lane P2's runLenderCheck)
      billed at close, and underwrite only a verified QUALIFY. Needs
      PASSBOOK_CONFIG with a local scorer and the accepted
      operators (--check-operators or PASSBOOK_CHECK_NODE_PKS). The borrower's PART and KEY travel
      on kind 7533; its application names the KEY this lender forwarded (check_key).

Negotiated (--negotiate): the lender signs a market policy (asset, this offer's term, at most
its max per loan, its min APR, ladder step-0 LTV, cosign-rgb, maker-checker above the
offer's max) and advertises its structural terms in the 38388 offer. The borrower reads them
from the relay, signs its own policy and negotiates over Nostr (kinds 7490-7494), each side
with only its own key (src/market/negotiate-nostr.ts). The lender answers through its
governance gate (session key, kill switch) after its offline sanctions screen; then the
existing sandbox credit check, term sheet, both approvals, lock, fund, repay and release.
Without --negotiate the fixed-offer flow is unchanged.

Shared env: BITCOIND_URL, RGB_INDEXER_URL, RGB_TRANSPORT_URL, PASSBOOK_RELAYS,
PASSBOOK_URL, PASSBOOK_WALLETS. Only the borrower reads PASSBOOK_STATE.
The lender requires --asset-id or PASSBOOK_ASSET_ID; never give it private state.
Approvals are interactive by default. --auto-approve is explicitly for rehearsals.
The lender pays the platform's share of each closed loan's interest from its own
USDT, with approval: before publishing (an overdue fee blocks the offer) and after
its loan closes. --pay-fees does only that.
--timeout-ms defaults to 300000. --output writes a local completion report.
No Lightning rail, note sale, interrupted-workflow resume or local model is started.
`

function micro(value: string): number {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('--principal must be positive USDT with at most six decimal places')
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('--principal is outside the safe range')
  return Number(amount)
}

class PeerRelay extends Relay {
  /** The last payload received per kind, for the completion report (e.g. the lender's decision-log entries in ACCEPTANCE). */
  readonly last = new Map<number, unknown>()
  constructor(key: KeyPair, private readonly waitMs: number) { super(key, relaysFromEnv()) }
  override async receive<T>(kind: number, from: Hex | null, opts: { timeoutMs?: number; since?: number; match?: (payload: T) => boolean } = {}) {
    const r = await super.receive<T>(kind, from, { timeoutMs: this.waitMs, ...opts })
    this.last.set(kind, r.payload)
    return r
  }
}

/** Both peers negotiate with the same round limit and settlement; each concedes a quarter of the gap per move. */
const NEGOTIATION_PARAMS: EngineParams = { max_rounds: 3, concession_bps: 2500, tolerance: { ...DEFAULT_TOLERANCE }, enabled_settlements: ['cosign-rgb'] }

function bps(name: string, value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback)
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000) throw new Error(`--${name} must be an integer number of basis points`)
  return n
}

function transcriptLine(m: NegotiationMessage, direction: string): string {
  const pos = m.body.position as Position | undefined
  return JSON.stringify({ event: 'negotiation', direction, seq: m.seq, type: m.type, ...(pos ? { apr_bps: pos.apr_bps, ltv_bps: pos.ltv_bps, principal: pos.principal, term_blocks: pos.term_blocks } : { reason: m.body.reason ?? null }), from: m.from_pk.slice(0, 12) })
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: {
    role: { type: 'string' }, wallet: { type: 'string' }, 'asset-id': { type: 'string' },
    'lender-wallet': { type: 'string' }, 'lender-pk': { type: 'string' }, principal: { type: 'string' },
    policy: { type: 'string' }, 'auto-approve': { type: 'boolean' }, 'timeout-ms': { type: 'string' },
    output: { type: 'string' }, 'pay-fees': { type: 'boolean' }, help: { type: 'boolean' },
    negotiate: { type: 'boolean' }, provider: { type: 'boolean' }, 'min-apr-bps': { type: 'string' }, 'max-apr-bps': { type: 'string' },
    'lender-pays-check': { type: 'boolean' }, 'check-operators': { type: 'string' },
  } })
  if (args.help) { console.log(HELP); return }
  if (args.role !== 'borrower' && args.role !== 'lender') throw new Error('--role must be borrower or lender; use --help')
  const role = args.role
  const wallet = args.wallet ?? (role === 'borrower' ? 'borrower' : 'lender1')
  if (role === 'borrower' ? wallet !== 'borrower' : !['lender1', 'lender2'].includes(wallet)) throw new Error('borrower uses wallet borrower; lender uses lender1 or lender2')
  const policyName = args.policy ?? 'legacy'
  if (!['legacy', 'history'].includes(policyName)) throw new Error('--policy must be legacy or history')
  const timeoutMs = Number(args['timeout-ms'] ?? 300_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error('--timeout-ms must be 1000..3600000')
  const auto = args['auto-approve'] === true
  if (!auto && !process.stdin.isTTY) throw new Error('interactive approvals require a terminal; use --auto-approve only for a labelled rehearsal')
  let rl: ReturnType<typeof createInterface> | undefined
  const approve = async (message: string) => {
    if (auto) { console.log(`[REHEARSAL AUTO-APPROVE] ${message}`); return }
    if ((await rl!.question(`${message}\nType yes to continue: `)).trim().toLowerCase() !== 'yes') throw new Error('operator declined; existing loan actions are not automatically undone')
  }
  /** The same approval, answering instead of throwing: a declined fee payment is reported, not a crash. */
  const confirm: Confirm = async (message) => {
    try { await approve(message); return true } catch (err) { if (/operator declined/.test((err as Error).message)) return false; throw err }
  }
  if (args['pay-fees'] && role !== 'lender') throw new Error('--pay-fees is for the lender')
  if ((args.provider || args['lender-pays-check']) && role !== 'lender') throw new Error('--provider and --lender-pays-check are for the lender')
  const lenderPays = args['lender-pays-check'] === true
  const negotiate = args.negotiate === true || args.provider === true || lenderPays
  // Lender-billed check: the external provider verifier and accepted operators, with no payment node.
  const checkSetup = lenderPays ? (() => {
    const cfg = deploymentConfigFromEnv()
    if (!cfg) throw new Error('--lender-pays-check needs PASSBOOK_CONFIG with a local scorer')
    const operators = (args['check-operators'] ?? process.env.PASSBOOK_CHECK_NODE_PKS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    if (!operators.length || !operators.every((k) => isHex(k, 32))) throw new Error('--lender-pays-check needs the accepted check-node operator keys (--check-operators or PASSBOOK_CHECK_NODE_PKS)')
    const s = cfg.scorer
    return {
      minTrust: s.min_trust_for_lenders, operators, rail: 'bill-at-close' as const,
      trust: { minTrust: s.min_trust_for_lenders, releases: loadReleaseManifest(s.approved_builds), releaseSignerPk: s.release_signer_pk ?? devReleaseSigner().pubkey, contract: loadScoringContract() },
    }
  })() : undefined

  // The lender does not call readState: it receives only public configuration.
  const state = role === 'borrower' ? readState() : undefined
  const assetId = args['asset-id'] ?? process.env.PASSBOOK_ASSET_ID ?? state?.asset.id
  if (!assetId) throw new Error('lender requires the public --asset-id or PASSBOOK_ASSET_ID')
  if (state && assetId !== state.asset.id) throw new Error('asset id differs from borrower state')
  const chain = BitcoindChain.fromEnv()
  const regtest = new Regtest(chain)
  if ((await chain.rpc<{ chain: string }>('getblockchaininfo')).chain !== 'regtest') throw new Error('standalone peer CLI supports regtest only')
  await regtest.ensureMiner()
  const party = await openParty(wallet as Role)
  const relay = new PeerRelay(party.key, timeoutMs)
  const platform = new PlatformClient()
  const common = {
    party, chain, relay, platform, reasoner: new RuleReasoner(), mine: (n = 1) => regtest.mine(n),
    log: (actor: string, title: string, detail?: unknown) => console.log(`[${actor}] ${title}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`),
  }
  let agent: BorrowerAgent | LenderAgent | undefined
  const report: Record<string, unknown> = { role, wallet, pid: process.pid, actor_pk: party.key.pubkey, asset_id: assetId, auto_approve: auto, rail: 'onchain_rgb_cooperative', started_at: new Date().toISOString() }
  console.log('Regtest demo: locally issued test USDT; seeded wallets are ours; sandbox attestation is a stub.')
  console.log(JSON.stringify({ event: 'peer_started', ...report, platform: platform.base, relays: relaysFromEnv(), narration: 'rules; sandbox engine belongs to platform' }))
  try {
    if ((await platform.state()).chain !== 'bitcoind') throw new Error('standalone peer rehearsal requires the real bitcoind platform')
    rl = auto ? undefined : createInterface({ input: process.stdin, output: process.stdout })
    if (role === 'lender') {
      const policy = policyName === 'history' ? L2_POLICY : { ...L1_POLICY, d: 'peer-legacy-30', requirements: { ...L1_POLICY.requirements, investigation: 'optional' as const, reconciliation: 'optional' as const, income_evidence: 'payer_signatures' as const } }
      const lender = agent = new LenderAgent({ ...common, assetId, policy, lightning: null })
      // platform fees from earlier loans: pay them (with approval) before an overdue one blocks the offer
      const howToPay = payFeesCommand(wallet, assetId)
      if (args['pay-fees']) {
        const r = await settlePlatformFees(lender, confirm)
        report.fees_paid = r.paid.map((f) => ({ loan_id: f.loan_id, amount: f.amount, txid: f.paid_txid }))
        console.log(JSON.stringify({ event: 'platform_fees', paid: report.fees_paid, declined: r.declined, blocked: r.blocked }))
        if (r.blocked) throw new Error(`${r.blocked} Some fees are still unpaid; rerun ${howToPay}`)
        report.completed_at = new Date().toISOString()
        console.log(JSON.stringify({ event: 'peer_complete', ...report }))
        return
      }
      report.fees_paid_before = (await settleBeforePublishing(lender, confirm, howToPay)).map((f) => ({ loan_id: f.loan_id, amount: f.amount, txid: f.paid_txid }))
      const investigationPolicy = 'investigation' in policy.requirements ? policy.requirements.investigation : 'optional'
      console.log(`Offer: ${usdt(policy.min)} to ${usdt(policy.max)}; ${policy.apr_bps / 100}% APR; ${policy.term_blocks} blocks plus ${policy.grace_blocks} grace blocks; investigation ${investigationPolicy}.`)
      // Negotiated: a market policy signed by this lender's key, advertised in the offer, answered over Nostr.
      const makerCheckerAbove: Micro = policy.max
      const marketPolicy = negotiate ? await signLenderPolicy(new LocalKeySigner(party.key), {
        asset_id: assetId, max_per_loan: policy.max, max_outstanding: policy.max * 10, min_apr_bps: bps('min-apr-bps', args['min-apr-bps'], 1000), max_ltv_bps: policy.ltv_ladder_bps[0],
        term_blocks: { min: policy.term_blocks, max: policy.term_blocks }, required_checks: ['inflows'], min_scorer_trust: checkSetup?.minTrust ?? 'dev-inprocess', accepted_settlements: ['cosign-rgb'],
        approval_rules: { approvers: [party.key.pubkey], maker_checker_above: makerCheckerAbove }, issued_at: Math.floor(Date.now() / 1000),
        ...(checkSetup ? { check_nodes: { accepted_check_operators: checkSetup.operators, min_trust: checkSetup.minTrust } } : {}),
      }) : undefined
      if (marketPolicy) lender.negotiateWith(marketPolicy, { ...NEGOTIATION_PARAMS, economics: lender.economics })
      await approve(`Publish ${policyName} offer${negotiate ? `, negotiate over Nostr down to ${marketPolicy!.min_apr_bps / 100}% APR,` : ''} and accept one matching application under this deterministic policy?`)
      await lender.publishOffer()
      console.log(JSON.stringify({ event: 'offer_ready', lender_pk: lender.pubkey, offer_id: lender.offerId, policy: policyName, negotiate, ...(marketPolicy ? { market_policy_hash: hashObject(marketPolicy) } : {}) }))
      let accepted
      if (marketPolicy) {
        const deal = await lender.negotiateOverNostr({ waitMs: timeoutMs, timeoutMs: 60_000, onMessage: (m, d) => console.log(transcriptLine(m, d)) })
        const agreed = (deal.outcome as { agreed: Position }).agreed
        report.negotiation = { negotiation_id: deal.negotiation_id, borrower_pk: deal.counterparty_pk, messages: deal.messages.length, verified: deal.verified.ok, agreed, transcript_hash: hashObject(deal.messages) }
        console.log(JSON.stringify({ event: 'negotiated', ...report.negotiation as object }))
        // Lender-paid: the check is bought and verified here, before the application; only a verified result is underwritten.
        const lenderCheck = checkSetup ? await lender.payForCheck(deal, {
          rail: checkSetup.rail, trust: checkSetup.trust, tee: noTeeVerifier(Math.floor(Date.now() / 1000)), timeoutMs, partTimeoutMs: timeoutMs,
          beforeBill: (offer) => approve(`Accept ${usdt(offer.price.amount)} (${offer.price.asset_id.slice(0, 16)}…) billed at loan close by check node ${offer.operator_pk.slice(0, 12)}… for this borrower's credit check?`),
          log: (line) => console.log(JSON.stringify({ event: 'check', line })),
        }) : undefined
        if (lenderCheck) {
          report.check = { verified: lenderCheck.verification.ok, billed: lenderCheck.bill ?? null, paid_up_front: false, fee: lenderCheck.fee, consent_hash: lenderCheck.consent_hash, operator_pk: lenderCheck.offer.operator_pk }
          console.log(JSON.stringify({ event: 'check_billed', ...report.check as object }))
          if (!lenderCheck.verification.ok) throw new Error('the paid credit check did not verify (K was forwarded to the borrower); not underwriting')
        }
        accepted = await lender.underwrite({
          timeoutMs, negotiation: { policy: marketPolicy, maxRounds: NEGOTIATION_PARAMS.max_rounds, makerCheckerAboveMicro: makerCheckerAbove }, ...(lenderCheck ? { lenderCheck } : {}),
          approve: async (sheet) => {
            await approve(`Approve term sheet: ${usdt(sheet.terms.principal)} at ${sheet.apr_bps / 100}% APR (negotiated), fee ${usdt(sheet.terms.fee)}, LTV ${sheet.terms.ltv_bps / 100}%?`)
            return [approveSheet(party.key, sheet, 'lender')]
          },
        })
        const decisions = lender.governance.gate.log.entries().filter((e) => e.loan_id === accepted!.loan_id || (e.detail as { negotiation_id?: string } | null)?.negotiation_id === deal.negotiation_id)
        report.lender_decisions = decisions.map((e) => ({ seq: e.seq, kind: e.kind, result: e.result, hash: e.hash }))
      } else accepted = await lender.underwrite({ timeoutMs })
      report.loan_id = accepted.loan_id
      await approve(`Fund ${usdt(accepted.terms.principal)}; repayment ${usdt(debtOf(accepted.terms))}; collateral ${btc(accepted.terms.collateral_sats)}?`)
      const funded = await lender.fund(accepted.loan_id)
      report.disbursement_txid = funded.disbursement_txid
      await lender.awaitIou(accepted.loan_id)
      report.repayment_txid = await lender.confirmRepayment(accepted.loan_id)
      const release = await lender.signRelease(accepted.loan_id)
      if (!release) throw new Error('release was not signed')
      const deadline = Date.now() + timeoutMs
      while (!(await chain.getTx(release))?.height) {
        if (Date.now() > deadline) throw new Error(`release signature sent but confirmation not observed: ${release}`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      report.release_txid = release
      // this loan's fee is invoiced once the borrower reports the release; pay it now so the next run is not blocked
      const settled = await settleClosedLoan(lender, confirm, accepted.loan_id, { timeoutMs: Math.min(timeoutMs, 60_000) })
      report.fee = settled.invoiced ? settled.paid.map((f) => ({ loan_id: f.loan_id, amount: f.amount, txid: f.paid_txid })) : 'not invoiced yet'
      if (!settled.invoiced || !settled.paid.length) console.log(`Platform fee for this loan not paid in this run; pay it with: ${howToPay}`)
    } else {
      const lenderWallet = args['lender-wallet'] ?? 'lender1'
      if (!['lender1', 'lender2'].includes(lenderWallet)) throw new Error('--lender-wallet must be lender1 or lender2')
      const lenderPk = args['lender-pk'] ?? state!.parties[lenderWallet as 'lender1' | 'lender2'].pubkey
      if (!isHex(lenderPk, 32)) throw new Error('--lender-pk must be a 32-byte hex key')
      const borrower = agent = new BorrowerAgent({ ...common, assetId, inflows: state!.borrower_inflows })
      const principal = micro(args.principal ?? '600')
      const offer = await borrower.findOffer({ lenderPk, principal, timeoutMs })
      const ask = await borrower.ask(principal, offer.payload.apr_bps, offer.payload.term_blocks)
      if (ask.passbook.ladder.open > 0) throw new Error('saved passbook contains an open loan; automatic workflow resume is unavailable')
      // Negotiated: the lender's terms straight from its signed offer on the relay, then the negotiation over Nostr.
      let deal: Awaited<ReturnType<typeof negotiateAsBorrower>> | undefined
      if (negotiate) {
        const offers = (await relay.publicEvents(KIND.OFFER)).filter((e) => e.pubkey === lenderPk && e.tags.some((t) => t[0] === 'd' && `${e.pubkey}:${t[1]}` === offer.id)).sort((a, b) => b.created_at - a.created_at)
        const terms = offers.length ? readJson<OfferPayload>(offers[0]).negotiation : undefined
        if (!terms || negotiationTermsProblems(terms).length || terms.lender_pk !== lenderPk) throw new Error(`lender ${lenderPk.slice(0, 12)}… advertises no valid negotiation terms in its signed offer on the relay`)
        const bp = await signBorrowerPolicy(new LocalKeySigner(party.key), { asset_id: assetId, principal: { min: principal, max: principal }, max_apr_bps: bps('max-apr-bps', args['max-apr-bps'], 1200), max_ltv_bps: ask.allowed_ltv_bps, term_blocks: { min: offer.payload.term_blocks, max: offer.payload.term_blocks }, min_scorer_trust: 'dev-inprocess', accepted_settlements: ['cosign-rgb'], issued_at: Math.floor(Date.now() / 1000) })
        await approve(`Negotiate ${usdt(principal)} with ${lenderPk.slice(0, 12)}… over Nostr, never above ${bp.max_apr_bps / 100}% APR or ${bp.max_ltv_bps / 100}% LTV?`)
        const pool = new SimplePool()
        try {
          deal = await negotiateAsBorrower({ transport: poolTransport(pool, relay.relays, (e) => relay.publish(e)), signer: keyPairSigner(party.key), policy: bp, terms, params: NEGOTIATION_PARAMS, timeoutMs: 60_000, onMessage: (m, d) => console.log(transcriptLine(m, d)) })
        } finally { pool.close(relay.relays) }
        report.negotiation = { negotiation_id: deal.negotiation_id, messages: deal.messages.length, verified: deal.verified.ok, outcome: deal.outcome, transcript_hash: hashObject(deal.messages), problems: deal.problems }
        console.log(JSON.stringify({ event: 'negotiated', ...report.negotiation as object }))
        if (!('agreed' in deal.outcome) || !deal.verified.ok) throw new Error(`negotiation ended without a deal: ${'no_deal' in deal.outcome ? deal.outcome.no_deal : 'transcript does not verify'}`)
      }
      const agreed = deal && 'agreed' in deal.outcome ? deal.outcome.agreed : undefined
      await approve(`Submit encrypted wallet evidence to the sandbox for ${usdt(principal)} from ${lenderPk}?`)
      const sandbox = await borrower.runSandbox(offer, principal, deal && agreed ? { apr_bps: agreed.apr_bps, negotiation_id: deal.negotiation_id } : undefined)
      if (sandbox.result.checks.some((check) => !check.ok)) throw new Error(`sandbox declined: ${sandbox.result.checks.filter((check) => !check.ok).map((check) => check.id).join(', ')}`)
      const approved = await borrower.approve(sandbox.result, async (items) => {
        console.log(JSON.stringify({ disclosure_proposal: items }))
        await approve(`Share these ${items.length} payment proofs and your signed portable passbook with the lender?`)
        return items.map((item) => item.txid)
      })
      await borrower.apply(offer, principal, sandbox, approved, deal?.messages)
      const accepted = await borrower.awaitAcceptance(offer, principal, deal && agreed ? { agreed, accept_hash: deal.verified.accept_hash!, messages: deal.messages, maker_checker_above_micro: offer.payload.max, ...(sandbox.result.run_record ? { run_record: sandbox.result.run_record } : {}) } : undefined)
      report.loan_id = accepted.loan_id
      if (deal) {
        // the lender node's signed decision-log entries, as the phone shows them next to the approvals
        const decisions = (relay.last.get(KIND.ACCEPTANCE) as AcceptancePayload | undefined)?.lender_decisions ?? []
        report.lender_decisions = decisions.map((e) => ({ seq: e.seq, kind: e.kind, result: e.result, hash: e.hash, node_pk: e.node_pk }))
        await approve(`Approve the lender-signed term sheet ${accepted.loan_id.slice(0, 12)}… (${report.lender_decisions ? (report.lender_decisions as unknown[]).length : 0} lender decision-log entries)?`)
        await borrower.approveTermSheet(accepted.loan_id)
      }
      await approve(`Lock ${btc(accepted.terms.collateral_sats)} for ${usdt(principal)}; owe ${usdt(debtOf(accepted.terms))} by block ${accepted.terms.maturity_height}, grace ${accepted.terms.grace_blocks} blocks?`)
      const lock = await borrower.lockAndSplit(accepted.loan_id)
      report.lock_txid = lock.lock_txid
      report.disbursement_txid = await borrower.awaitFunding(accepted.loan_id)
      await approve(`Repay ${usdt(debtOf(accepted.terms))} over RGB and request cooperative collateral release?`)
      report.repayment_txid = await borrower.repay(accepted.loan_id)
      report.iou_return_txid = await borrower.awaitIouReturn(accepted.loan_id)
      report.release_txid = await borrower.release(accepted.loan_id)
      const verified = await verifyPassbook(borrower.passbookDocument(), chain)
      if (!verified.document_valid || verified.unverified) throw new Error('saved portable passbook did not verify locally')
      report.passbook = { pages: verified.pages.length, ladder: verified.ladder, assurance: verified.assurance }
    }
    report.completed_at = new Date().toISOString()
    if (args.output) {
      mkdirSync(dirname(args.output), { recursive: true, mode: 0o700 })
      writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    }
    console.log(JSON.stringify({ event: 'peer_complete', ...report }))
  } finally { agent?.close(); if (!agent) relay.close(); party.close(); rl?.close() }
}

main().catch((error) => { console.error(`peer failed: ${(error as Error).message}`); process.exitCode = 1 })
