// `passbook why <action-id>`: every rule the gate evaluated for one action,
// its result, the approvals, the linked sanctions and scorer entries, the
// signatures it allowed, and whether the log around it is intact.

import type { CheckResult, RuleResult } from './gate.js'
import { verifyLog, type LogEntry } from './log.js'

const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL')

/** `nodePk`: the node's gate key, so the chain is checked against it rather than the entries' own keys. */
export function whyLines(entries: LogEntry[], actionId: string, nodePk?: string): string[] {
  const mine = entries.filter((e) => e.action_id === actionId)
  if (!mine.length) return [`No decision-log entry for ${actionId}.`]
  const out: string[] = []
  const problems = verifyLog(entries, nodePk)
  for (const e of mine) {
    const when = new Date(e.at * 1000).toISOString()
    if (e.kind === 'gate-decision') {
      const d = e.detail as { dry_run: boolean; action: string; initiator: string; asset: string | null; amount: number; destinations: { id: string; address: string | null; value: number; owner: string }[]; counterparty: string | null; reason: string | null; gate_checks: CheckResult[]; rules: RuleResult[]; allowed_by: string | null; tokens: { signer: string; decoded_hash: string }[] }
      out.push(`${d.dry_run ? 'Dry run' : 'Decision'} ${actionId}: ${d.action} by ${d.initiator} -> ${e.result.toUpperCase()} under policy version ${e.policy_version ?? 'none'} (${when})`)
      out.push(`  amount ${d.amount ?? '?'} of ${d.asset ?? '?'}${d.counterparty ? `; counterparty ${d.counterparty.slice(0, 16)}…` : ''}${d.reason ? `; reason: ${d.reason}` : ''}`)
      for (const x of d.destinations ?? []) out.push(`  destination ${(x.address ?? x.id).slice(0, 48)} ${x.value} (${x.owner})`)
      out.push('  gate checks:')
      for (const c of d.gate_checks ?? []) out.push(`    ${mark(c.ok)} ${c.check.padEnd(14)} ${c.detail}`)
      out.push('  rules:')
      for (const r of d.rules ?? []) {
        if (!r.applies) { out.push(`    --   ${r.rule_id}: not applicable (${r.checks[0]?.detail ?? ''})`); continue }
        out.push(`    ${mark(r.ok)} ${r.rule_id}: ${r.description}`)
        for (const c of r.checks) out.push(`           ${mark(c.ok)} ${c.check.padEnd(18)} ${c.detail}`)
      }
      out.push(`  result: ${d.allowed_by ? `allowed by rule ${d.allowed_by}` : 'refused'}${d.tokens?.length ? `; ${d.tokens.length} gate token(s) bound to decoded hash(es) ${d.tokens.map((t) => t.decoded_hash.slice(0, 12)).join(', ')}` : ''}`)
    } else if (e.kind === 'policy-change') {
      const d = e.detail as { action?: string; change?: string; effective_at?: number; checks?: CheckResult[]; problems?: string[] }
      out.push(`Policy ${d.action ?? 'change'} ${actionId}: ${e.result.toUpperCase()} (version ${e.policy_version ?? '?'}, ${when})${d.effective_at ? `, effective ${new Date(d.effective_at * 1000).toISOString()}` : ''}`)
      for (const c of d.checks ?? []) out.push(`    ${mark(c.ok)} ${c.check.padEnd(14)} ${c.detail}`)
      for (const p of d.problems ?? []) out.push(`    FAIL ${p}`)
    } else if (e.kind === 'kill-switch') {
      const d = e.detail as { agents: string[]; revoked_sessions: string[]; reason: string; funds: string }
      out.push(`Kill switch ${actionId}: agents ${d.agents.join(', ')} stopped by ${e.decided_by.id ?? 'operator'} (${when}); ${d.revoked_sessions.length} session key(s) revoked; ${d.funds}`)
    } else if (e.kind === 'sanctions-result') {
      const d = e.detail as { list_version: string; screened: { proven: number; counterparties: number }; hits: { address: string; hop: number; via?: string; list_id: string }[] }
      out.push(`  sanctions: ${e.result.toUpperCase()} on ${d.list_version}; ${d.screened.proven} proven address(es), ${d.screened.counterparties} direct counterparties${d.hits.length ? `; hits: ${d.hits.map((h) => `${h.address} (${h.hop === 0 ? 'proven' : `1 hop via ${h.via}`}, ${h.list_id})`).join('; ')}` : ''}`)
    } else if (e.kind === 'scorer-result') {
      const d = e.detail as { provider: string; trust: string; fallback: boolean; result_hash: string }
      out.push(`  scorer: ${e.result} from ${d.provider} (${d.trust}${d.fallback ? ', FALLBACK' : ''}), result ${d.result_hash.slice(0, 12)}…`)
    } else if (e.kind === 'approval') {
      const d = e.detail as { role: string | null }
      out.push(`  approval: ${e.result} by ${e.decided_by.pk?.slice(0, 16)}… (${d.role ?? 'unlisted'})`)
    } else if (e.kind === 'signature') {
      const d = e.detail as { signer: string }
      out.push(`  signed: ${d.signer.slice(0, 28)}… over decoded hash ${e.input_hashes.decoded?.slice(0, 12)}… (${when})`)
    }
  }
  const last = mine.at(-1)!
  out.push(`  log: entries ${mine.map((e) => `#${e.seq}`).join(', ')} of ${entries.length}; ${problems.length ? `CHAIN BROKEN: ${problems.slice(0, 3).join('; ')}` : `hash chain intact${nodePk ? ` and signed by node key ${nodePk.slice(0, 12)}…` : ' (no node key given: checked for one consistent key only)'}, head ${entries.at(-1)!.hash.slice(0, 16)}…`}; last entry ${last.hash.slice(0, 16)}…`)
  return out
}
