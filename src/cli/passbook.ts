import { checkRunDirectory } from '../sandbox/check-run.js'
import { publishedRunMaterials } from '../sandbox/published-materials.js'
import { modelFileHash, readRunArtifact, type RunBudgets } from '../sandbox/run-record.js'

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
if (args[0] === 'agent' && ['check', 'snapshot'].includes(args[1])) {
  // Add-on 4 Part A: the multi-layer credit agent (src/cli/agent.ts, docs/LAYERS.md)
  const { runAgentCli } = await import('./agent.js')
  process.exitCode = await runAgentCli(args)
} else if (['why', 'policy', 'log'].includes(args[0]) || (args[0] === 'agent' && args[1] === 'stop')) {
  // governance: passbook why | agent stop | policy show | log verify (src/governance/cli.ts)
  const { runGovernanceCli } = await import('../governance/cli.js')
  process.exitCode = await runGovernanceCli(args)
} else if (args[0] === 'check-node' && args[1] === 'provide') {
  // The check node in service-provider mode: external provider or nothing, lender-paid checks (src/checknode/provider.ts, docs/SERVICE-PROVIDER.md)
  const { runProvideCli } = await import('../checknode/provider.js')
  process.exitCode = await runProvideCli(args)
} else if (args[0] === 'check-node') {
  // Add-on 5: check nodes as a market (src/cli/check-node.ts, docs/CHECK-MARKET.md)
  const { runCheckNodeCli } = await import('./check-node.js')
  process.exitCode = await runCheckNodeCli(args)
} else if (args[0] === 'assistant') {
  process.exitCode = await (await import('../assistant/cli.js')).runAssistantCli(args) // the agent on call (src/assistant)
} else if (['scorer-release', 'audit', 'check-loan'].includes(args[0])) {
  const { runThreeTracksCli } = await import('./three-tracks.js')
  process.exitCode = await runThreeTracksCli(args)
} else if (args[0] !== 'check-run' || !args[1]) {
  console.error('Usage: passbook check-run <dir> [--sandbox-pk <trusted-key>] [--observer-pk <trusted-key>] [--model-file <GGUF>] [--model-id <id>]\n       passbook check-node serve|offers|provide\n       passbook scorer-release --help\n       passbook audit export <loan-dir>\n       passbook check-loan <receipts/<loan_id>.json>')
  process.exitCode = 2
} else {
  try {
    const dir = args[1]
    const artifact = await readRunArtifact(dir)
    const modulePath = '../sandbox/investigate.js'
    const published = await import(modulePath) as { INVESTIGATION_SYSTEM_PROMPT?: string; INVESTIGATION_TOOL_DEFINITIONS?: unknown; INVESTIGATION_BUDGETS?: RunBudgets }
    if (!published.INVESTIGATION_SYSTEM_PROMPT || !published.INVESTIGATION_TOOL_DEFINITIONS || !published.INVESTIGATION_BUDGETS) throw new Error('published investigator materials are unavailable')
    const modelId = option('--model-id') ?? process.env.PASSBOOK_RUN_MODEL_ID ?? `qvac-sdk:${process.env.QVAC_MODEL ?? 'qwen3-1.7b'}`
    const modelFile = option('--model-file') ?? process.env.PASSBOOK_RUN_MODEL_FILE
    const materials = await publishedRunMaterials(modelId, { systemPrompt: published.INVESTIGATION_SYSTEM_PROMPT, toolDefinitions: published.INVESTIGATION_TOOL_DEFINITIONS })
    if (modelFile && await modelFileHash(modelFile) !== materials.model_file_sha256) throw new Error('local model bytes do not match the published material')
    const trustedPk = option('--sandbox-pk') ?? process.env.PASSBOOK_SANDBOX_PK
    const trustedObserverPk = option('--observer-pk') ?? process.env.PASSBOOK_HISTORY_OBSERVER_PK
    const result = await checkRunDirectory(dir, { materials, budgets: published.INVESTIGATION_BUDGETS, sandboxPk: trustedPk ?? artifact.record.sandbox_pk, trustedObserverPk })
    console.log(JSON.stringify({ ...result, signer_trust: trustedPk ? 'provided-key' : 'self-declared-key', assurance: 'signed-record-not-hardware-attestation' }, null, 2))
    process.exitCode = result.ok ? 0 : 1
  } catch {
    console.log(JSON.stringify({ ok: false, errors: ['RUN_CHECK_SETUP_ERROR'] }, null, 2))
    process.exitCode = 1
  }
}
