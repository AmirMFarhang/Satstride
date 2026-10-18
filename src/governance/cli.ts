// Operator commands for a node's governance, reading the same store and log the
// running agents use (so a stop from here reaches a running agent at once):
//
//   passbook why <action-id> [--wallets <dir>] [--node <role>]
//   passbook agent stop (<agent-id> | --all) [--wallets <dir>] [--node <role>] [--by <name>] [--reason <text>]
//   passbook policy show [--wallets <dir>] [--node <role>]
//   passbook log verify [--wallets <dir>] [--node <role>]
//
// Nodes are <wallets>/<role>/governance (PASSBOOK_WALLETS, default infra/wallets).
// Stopping needs the node's key (its seed, or the platform secret) to sign the
// kill-switch entry; reading needs nothing secret.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { keyPairFromSecret, type KeyPair } from '../core/crypto.js'
import { partyKeyFromSeed } from '../wallet/signer.js'
import { readLog, verifyLog } from './log.js'
import { gateKeyFor, NodeGovernance } from './node.js'
import { activeRecord, recordProblems } from './policy.js'
import { FileGateStore } from './store.js'
import { whyLines } from './why.js'

export const GOVERNANCE_COMMANDS = ['why', 'agent', 'policy', 'log']

interface NodeDir { role: string; dir: string }

function nodes(wallets: string, only?: string): NodeDir[] {
  if (!existsSync(wallets)) return []
  return readdirSync(wallets, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!only || d.name === only) && existsSync(join(wallets, d.name, 'governance', 'gate-store.json')))
    .map((d) => ({ role: d.name, dir: join(wallets, d.name, 'governance') }))
}

/**
 * The key a node's log must be signed with: its gate key, derived from the node's own seed (or the platform secret)
 * when this operator can read it, else the gate key named by the quorum-verified policy in force. Never the
 * entries' own keys. Null when neither is available: verification then fails.
 */
function expectedGateKey(wallets: string, n: NodeDir): { pk: string; anchor: string } | null {
  try { return { pk: gateKeyFor(ownerKey(wallets, n.role)).pubkey, anchor: 'gate key derived from the node key' } } catch { /* no seed here */ }
  const s = new FileGateStore(n.dir).read()
  const active = activeRecord(s.policies, Math.floor(Date.now() / 1000))
  if (active && recordProblems(s.policies, active, active.policy.node_pk).length === 0) return { pk: active.policy.node_pk, anchor: `gate key of the quorum-signed policy v${active.policy.version} (no node key here)` }
  return null
}

function ownerKey(wallets: string, role: string): KeyPair {
  if (role === 'platform') {
    const secret = process.env.PLATFORM_SECRET ?? readFileSync(join(wallets, 'platform', 'secret'), 'utf8').trim()
    return keyPairFromSecret(secret)
  }
  return partyKeyFromSeed(readFileSync(join(wallets, role, 'seed'), 'utf8').trim())
}

export async function runGovernanceCli(args: string[], print: (line: string) => void = console.log): Promise<number> {
  const opt = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const wallets = resolve(opt('--wallets') ?? process.env.PASSBOOK_WALLETS ?? 'infra/wallets')
  const only = opt('--node')
  const found = nodes(wallets, only)
  const [cmd, sub] = args

  if (cmd === 'why' && sub && !sub.startsWith('--')) {
    for (const n of found) {
      const entries = readLog(join(n.dir, 'decision-log.jsonl'))
      if (!entries.some((e) => e.action_id === sub)) continue
      print(`node ${n.role} (${n.dir})`)
      const key = expectedGateKey(wallets, n)
      if (!key) print('  no node key or verified policy to check the log against: the chain status below is NOT verified')
      for (const line of whyLines(entries, sub, key?.pk)) print(line)
      return 0
    }
    print(`No node under ${wallets} logged ${sub}.`)
    return 1
  }

  if (cmd === 'agent' && sub === 'stop') {
    const all = args.includes('--all')
    const agent = args[2] && !args[2].startsWith('--') ? args[2] : undefined
    if (!all && !agent) { print('Usage: passbook agent stop (<agent-id> | --all) [--wallets <dir>] [--node <role>] [--by <name>] [--reason <text>]'); return 2 }
    if (!found.length) { print(`No governed node under ${wallets}.`); return 1 }
    const by = opt('--by') ?? process.env.USER ?? 'operator'
    for (const n of found) {
      const gov = new NodeGovernance({ ownerKey: ownerKey(wallets, n.role), dir: n.dir })
      const r = gov.gate.stopAgent(all ? '*' : agent!, by, opt('--reason') ?? 'kill switch (passbook agent stop)')
      print(`node ${n.role}: stopped ${r.agents.join(', ')}; revoked ${r.revoked.length} session key(s); ${r.action_id}. Open loans keep their on-chain exits (A with the lender's owner, C with the platform, D after recovery, E on atomic loans); people can still act with their own keys.`)
    }
    return 0
  }

  if (cmd === 'policy' && sub === 'show') {
    for (const n of found) {
      const s = new FileGateStore(n.dir).read()
      const now = Math.floor(Date.now() / 1000)
      const active = activeRecord(s.policies, now)
      print(`node ${n.role}: policy version ${active?.policy.version ?? 'none'} in force; ${s.policies.length} version(s) recorded${Object.keys(s.frozen).length ? `; STOPPED: ${Object.keys(s.frozen).join(', ')}` : ''}`)
      for (const r of s.policies) print(`  v${r.policy.version} ${r.change} ${r.effective_at > now ? `pending until ${new Date(r.effective_at * 1000).toISOString()}` : `effective ${new Date(r.effective_at * 1000).toISOString()}`} (${r.reasons.join('; ')})`)
      for (const rule of active?.policy.rules ?? []) print(`  rule ${rule.id}: ${rule.description}${rule.limits ? `; limits ${JSON.stringify(rule.limits)}` : ''}${rule.approvals ? `; approvals ${JSON.stringify(rule.approvals)}` : ''}`)
    }
    return found.length ? 0 : 1
  }

  if (cmd === 'log' && sub === 'verify') {
    let ok = found.length > 0
    for (const n of found) {
      const entries = readLog(join(n.dir, 'decision-log.jsonl'))
      const key = expectedGateKey(wallets, n)
      const problems = key ? verifyLog(entries, key.pk) : ['no node key or quorum-verified policy to verify against']
      ok &&= problems.length === 0
      print(`node ${n.role}: ${entries.length} entries; ${problems.length ? `BROKEN: ${problems.slice(0, 5).join('; ')}` : `chain intact, every entry signed by ${key!.pk.slice(0, 16)}… (${key!.anchor}), head ${entries.at(-1)?.hash ?? 'none'}`}`)
    }
    return ok ? 0 : 1
  }

  print('Usage: passbook why <action-id> | passbook agent stop (<agent-id> | --all) | passbook policy show | passbook log verify   [--wallets <dir>] [--node <role>]')
  return 2
}
