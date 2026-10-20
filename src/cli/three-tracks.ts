// `passbook` subcommands for the three tracks.
//
//   passbook scorer-release [--out <file>] [--image-digest sha256:…] [--external-workload sha256:…]…
//                           [--operator <pk>]…
//     Writes the approved-builds manifest, signed with PASSBOOK_RELEASE_SECRET
//     or, without it, the publicly derivable development key (marked development).
//
//   passbook audit export <loan-dir> [--out <file>] [--blocks-per-month 30] [--max-rounds 3] [--maker-checker-usdt 5000] [--no-chain]
//     Bundles <loan-dir>/{negotiation,termsheet,approvals,scorer,lender-policy,receipt}.json
//     into one hash-chained audit file and re-runs the checks. The loan receipt is verified
//     against bitcoind (BITCOIND_URL); --no-chain attaches it unverified, which fails its check.
//     Exit 1 if any check fails.
//
//   passbook check-loan <receipts/<loan_id>.json> [--lender-policy <file>] [--maker-checker-usdt 5000] [--config <file>]
//     Re-checks a loan receipt against bitcoind (BITCOIND_URL). Exit 0 only when every check passes.
//
// Both verify under the deployment the loan was originated in: --config, else
// PASSBOOK_CONFIG, else ./passbook.config.yaml; built-in defaults only when
// there is none. Its economics, maker-checker threshold and round limit apply
// unless a flag overrides them.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { auditBundleProblems, buildAuditBundle, readAuditInputs } from '../audit/export.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import type { LenderPolicy } from '../market/policy.js'
import { checkLoanReceipt, readLoanReceipt } from '../registry/receipt.js'
import { readLog } from '../governance/log.js'
import { DEFAULT_CONFIG_PATH, loadConfig, type PassbookConfig } from '../core/config.js'
import { keyPairFromSecret } from '../core/crypto.js'
import { DEFAULT_ECONOMICS, type Economics } from '../core/economics.js'
import { MICRO_PER_USDT } from '../core/money.js'
import { contractHash, loadScoringContract } from '../scorer/contract.js'
import { devReleaseSigner, measureSource, signReleaseManifest, type ApprovedBuild } from '../scorer/releases.js'

function options(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []))
}

/** The deployment to verify under, and what the verification uses from it. Files it names (tokens, keys) need not exist here. */
function verificationContext(one: (name: string) => string | undefined): { economics: Economics; makerCheckerMicro: number; maxRounds: number } {
  const path = one('--config') ?? (process.env.PASSBOOK_CONFIG || undefined) ?? (existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : undefined)
  const cfg: PassbookConfig | null = path ? loadConfig(path, { checkFiles: false }) : null
  const usdt = one('--maker-checker-usdt')
  const ctx = {
    economics: cfg?.economics ?? DEFAULT_ECONOMICS,
    makerCheckerMicro: usdt !== undefined ? Number(usdt) * MICRO_PER_USDT : cfg?.compliance.approvals.maker_checker_above_micro ?? 5000 * MICRO_PER_USDT,
    maxRounds: Number(one('--max-rounds') ?? cfg?.negotiation.max_rounds ?? 3),
  }
  console.error(`verifying under ${path ?? 'built-in defaults (no deployment config)'}: platform ${ctx.economics.platform_share_bps / 100}% of interest, APR cap ${ctx.economics.max_apr_bps / 100}%, maker-checker above ${ctx.makerCheckerMicro / MICRO_PER_USDT} USDT`)
  return ctx
}

export async function runThreeTracksCli(args: string[]): Promise<number> {
  if (args[0] === 'scorer-release') {
    const one = (name: string) => options(args, name)[0]
    const contract = contractHash(loadScoringContract())
    const builds: ApprovedBuild[] = [{ label: 'in-process sandbox (this source tree)', provider: 'in-process', code_measurement: measureSource(), contract_hash: contract, max_trust: 'dev-inprocess' }]
    builds.push({ label: 'container scorer (this source tree, unmeasured image)', provider: 'container', code_measurement: measureSource(), contract_hash: contract, max_trust: 'dev-inprocess' })
    const image = one('--image-digest')
    if (image) {
      if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('--image-digest must be sha256:<64 hex>')
      builds.push({ label: 'container scorer image', provider: 'container', code_measurement: image, contract_hash: contract, max_trust: 'dev-inprocess' })
    }
    const secret = process.env.PASSBOOK_RELEASE_SECRET
    const signer = secret ? keyPairFromSecret(secret) : devReleaseSigner()
    const manifest = signReleaseManifest(signer, { builds, operators: options(args, '--operator') })
    const out = one('--out') ?? 'infra/scorer-releases.json'
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`wrote ${out}: ${builds.length} builds, signer ${signer.pubkey.slice(0, 16)}…${manifest.development ? ' (DEVELOPMENT key: not a production trust anchor)' : ''}`)
    return 0
  }
  if (args[0] === 'audit' && args[1] === 'export' && args[2]) {
    const one = (name: string) => options(args, name)[0]
    const inputs = readAuditInputs(args[2])
    const logFile = one('--decision-log')
    if (logFile) inputs.decision_log = readLog(logFile)
    const nodePk = one('--node-pk')
    if (nodePk) inputs.decision_log_node_pk = nodePk
    const v = verificationContext(one)
    if (inputs.receipt && !args.includes('--no-chain')) inputs.receipt_check = await checkLoanReceipt(inputs.receipt, BitcoindChain.fromEnv(), { lenderPolicy: inputs.lender_policy, deploymentMakerCheckerMicro: v.makerCheckerMicro, economics: v.economics })
    const bundle = buildAuditBundle(inputs, { blocksPerMonth: Number(one('--blocks-per-month') ?? 30), maxRounds: v.maxRounds, deploymentMakerCheckerMicro: v.makerCheckerMicro, economics: v.economics })
    const integrity = auditBundleProblems(bundle)
    const text = `${JSON.stringify(bundle, null, 2)}\n`
    const out = one('--out')
    if (out) writeFileSync(out, text)
    else process.stdout.write(text)
    for (const c of bundle.checks) console.error(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`)
    console.error(`${bundle.entries.length} entries, root ${bundle.root_hash ?? 'none'}${integrity.length ? `; integrity: ${integrity.join(', ')}` : ''}`)
    return bundle.entries.length > 0 && integrity.length === 0 && bundle.checks.every((c) => c.ok) ? 0 : 1
  }
  if (args[0] === 'check-loan' && args[1]) {
    const one = (name: string) => options(args, name)[0]
    const policyFile = one('--lender-policy')
    const v = verificationContext(one)
    const result = await checkLoanReceipt(readLoanReceipt(args[1]), BitcoindChain.fromEnv(), { lenderPolicy: policyFile ? JSON.parse(readFileSync(policyFile, 'utf8')) as LenderPolicy : undefined, deploymentMakerCheckerMicro: v.makerCheckerMicro, economics: v.economics, ...(one('--decision-log') ? { decisionLog: readLog(one('--decision-log')!) } : {}) })
    for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`)
    console.log(result.ok ? 'PASS' : 'FAIL')
    return result.ok ? 0 : 1
  }
  console.error('Usage: passbook check-loan <receipt.json> [--lender-policy <file>] [--decision-log <decision-log.jsonl>] [--maker-checker-usdt 5000] [--config <file>]')
  console.error('Usage: passbook audit export <loan-dir> [--out <file>] [--decision-log <decision-log.jsonl> [--node-pk <gate key>]] [--blocks-per-month 30] [--max-rounds 3] [--maker-checker-usdt 5000] [--config <file>] [--no-chain]')
  console.error('Usage: passbook scorer-release [--out <file>] [--image-digest sha256:…] [--operator <pk>]…')
  return 2
}
