// Optional demo step (off by default; `npm run demo -- --governance`): after
// the second loan is funded, the second lender's owner tightens its agent's
// policy to a daily funding limit (a tightening applies at once), the agent
// tries a second same-day disbursement over it and the gate refuses before
// anything is signed, `passbook why` explains, and the kill switch stops the
// agent. Its next message is refused; the open loan keeps its exits.

import { hashObject, type Hex } from '../core/crypto.js'
import type { LoanTerms } from '../core/terms.js'
import { escrowFor, partiesOf } from '../escrow/escrow.js'
import type { BorrowerAgent } from '../agents/borrower.js'
import type { LenderAgent } from '../agents/lender.js'
import { KIND } from '../market/kinds.js'
import { runGovernanceCli } from '../governance/cli.js'
import { GateRefused } from '../governance/gate.js'
import { approvePolicy, type GovernancePolicy } from '../governance/policy.js'
import { AgentStopped } from '../governance/sessions.js'
import { utcDay } from '../governance/store.js'
import { whyLines } from '../governance/why.js'
import { walletsDir } from '../wallet/platform-key.js'

export interface GovernanceDemoResult { policy_version: number; refused_action: string; stop_action: string; limit: number; used: number }

export async function governanceDemoStep(o: {
  step: (title: string) => Promise<unknown>
  lender: LenderAgent
  borrower: BorrowerAgent
  /** The open loan between them. */
  terms: LoanTerms
  assetId: string
  /** The asset's display label (deployment config): "test USDT" in the demo. */
  label?: string
  /** PASSBOOK_WALLETS (default infra/wallets). */
  wallets?: string
  print?: (line: string) => void
}): Promise<GovernanceDemoResult> {
  const print = o.print ?? ((l: string) => console.log(`  ${l}`))
  const label = o.label ?? 'test USDT'
  const amount = (micro: number) => `${(micro / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${label}`
  const gate = o.lender.governance.gate
  const role = o.lender.role

  await o.step(`Governance: ${role}'s agent tries to fund above its daily limit`)
  const current = gate.activePolicy()!
  const today = utcDay(Math.floor(Date.now() / 1000))
  const used = gate.store.read().reservations.filter((r) => r.action === 'fund' && r.asset === o.assetId && r.day === today && r.status !== 'released').reduce((n, r) => n + r.amount, 0)
  const limit = used + Math.floor(o.terms.principal / 2)
  // The owner narrows the agent's grant: funding gets its own daily limit. Narrower than what it replaces, so it applies at once.
  const money = current.policy.rules.find((r) => r.id === 'agent-loan-money')
  if (!money) throw new Error('the demo step expects the demo default policy')
  const next: GovernancePolicy = {
    ...current.policy, version: current.policy.version + 1, prev_hash: current.policy_hash, created_at: Math.floor(Date.now() / 1000),
    rules: [
      ...current.policy.rules.filter((r) => r.id !== 'agent-loan-money'),
      { ...money, actions: money.actions.filter((a) => a !== 'fund') },
      { ...money, id: 'agent-fund-daily', description: `the agent may fund at most ${amount(limit)} a day, to the term sheet's counterparty only`, actions: ['fund'], assets: [o.assetId], limits: { per_day: limit } },
    ],
  }
  const change = gate.changePolicy(next, [approvePolicy(o.lender.party.key, next)])
  if (!change.record) throw new Error(`policy change refused: ${change.problems.join('; ')}`)
  print(`${role}'s owner signs policy v${next.version}: funding capped at ${amount(limit)} today (${amount(used)} already funded); ${change.record.change}, so it applies ${change.record.effective_at <= Math.floor(Date.now() / 1000) ? 'at once' : `at ${new Date(change.record.effective_at * 1000).toISOString()}`} (${change.action_id})`)

  // The agent asks to disburse the same principal again today, to a fresh invoice of the borrower: the real send path.
  const invoice = o.borrower.party.rgb.invoice(o.terms.principal, o.assetId).invoice
  const transfer = { invoice, assetId: o.assetId, amount: o.terms.principal }
  const ctx = { action: 'fund' as const, counterparty: o.borrower.pubkey, recipientOwner: o.borrower.pubkey, reason: 'demo: a second disbursement the same day' }
  // The demo must never move money: check with a dry run before taking the real send path.
  const preview = await gate.dryRun(await o.lender.governance.request([{ signer: o.lender.party.rgb.signerId, kind: 'rgb-transfer', summary: o.lender.party.rgb.transferSummary(transfer), recipient_owner: o.borrower.pubkey }], { ...ctx, initiator: { agent: role } }))
  if (preview.allowed) throw new Error(`the demo policy would allow this disbursement (${preview.action_id}); not sending`)
  let refused: GateRefused
  try {
    await o.lender.sendRgb(transfer, ctx)
    throw new Error('the gate allowed a disbursement over the daily limit')
  } catch (err) {
    if (!(err instanceof GateRefused)) throw err
    refused = err
  }
  print(`refused before anything was signed: ${refused.decision.reason}`)
  print(`$ passbook why ${refused.decision.action_id}`)
  for (const line of whyLines(gate.log.entries(), refused.decision.action_id, gate.pubkey)) print(`  ${line}`)

  await o.step(`Kill switch: passbook agent stop ${role}`)
  const lines: string[] = []
  const code = await runGovernanceCli(['agent', 'stop', role, '--wallets', o.wallets ?? walletsDir(), '--node', nodeDirName(o.lender), '--by', 'demo operator'], (l) => lines.push(l))
  let stopAction = lines.join(' ').match(/act_[0-9a-f]+/)?.[0]
  if (code !== 0 || !stopAction) stopAction = gate.stopAgent(role, 'demo operator', 'kill switch (demo)').action_id
  for (const l of lines) print(l)
  try {
    await o.lender.relay.send(KIND.OFFER, { note: 'next message after the stop' }, o.borrower.pubkey)
    throw new Error('a stopped agent sent a message')
  } catch (err) {
    if (!(err instanceof AgentStopped)) throw err
    print(`its next message is refused: ${err.message}`)
  }
  const leaves = Object.keys(escrowFor(partiesOf(o.terms)).leaves)
  print(`funds stay where they are: the open loan's escrow keeps leaves ${leaves.join(', ')}; the borrower repays and releases with the platform (C) or the lender's owner by hand (A), or alone after height ${o.terms.recovery_height} (D)`)
  print(`policy v${next.version} ${hashObject(next).slice(0, 12)}…; decision log ${gate.log.file ?? 'in memory'}`)
  print(`${role} stays stopped in these wallets (there is no resume command yet: designed, with quorum); run npm run seed -- --fresh before the next demo`)
  return { policy_version: next.version, refused_action: refused.decision.action_id, stop_action: stopAction, limit, used }
}

/** <wallets>/<dir>/governance: the party's wallet directory name (a persona's directory differs from its role). */
function nodeDirName(agent: LenderAgent): string {
  const dir = agent.party.rgb.dataDir.replace(/[\\/]rgb[\\/]?$/, '')
  return dir.split(/[\\/]/).at(-1) as Hex
}
