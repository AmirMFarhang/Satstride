// An offline release check: no model, network, database or original wallet.
import { hashObject, isHex, type Hex } from '../core/crypto.js'
import { investigationTools } from './investigation-tools.js'
import { assertCodedDecision, readRunArtifact, snapshotChain, toolArgumentsValid, verifyRunRecord, type CodedDecision, type OfflineReplayContext, type PrivateToolCall, type RunArtifact, type RunBudgets, type RunMaterials, type RunVerification } from './run-record.js'
import type { InvestigationEvidence } from './investigation-types.js'

export interface ReplayPolicy {
  verdict: 'clean' | 'concerns' | 'fraud' | 'failed'
  reason_codes: string[]
  hard_stops: string[]
  coverage_gaps: string[]
}
export interface ReplayResult { policy: ReplayPolicy; errors: string[] }
export type ReplayInvestigation = (report: CodedDecision | null, ledger: { id: string; tool: PrivateToolCall['name']; args: Record<string, unknown>; result: unknown; error?: string }[], evidence: InvestigationEvidence | undefined, failureCode?: string) => ReplayResult
export interface CheckRunOptions {
  /** Trust roots must come from the published release, never from this artifact. */
  materials: RunMaterials
  budgets: RunBudgets
  sandboxPk: Hex
  /** Optional external root for the private observer declaration. */
  trustedObserverPk?: Hex
  replayInvestigation?: ReplayInvestigation
}

async function publishedReplay(): Promise<ReplayInvestigation> {
  // Kept dynamically loaded so the recorder has no circular dependency on the
  // investigator. Absence is a failed replay, never signature-only success.
  const modulePath = './grounding.js'
  const grounding = await import(modulePath) as { replayInvestigation?: ReplayInvestigation }
  if (typeof grounding.replayInvestigation !== 'function') throw new Error('published grounding replay is unavailable')
  return grounding.replayInvestigation
}

export async function checkRunArtifact(artifact: RunArtifact, options: CheckRunOptions): Promise<RunVerification> {
  try { return await checkArtifact(artifact, options) }
  catch { return { ok: false, errors: ['RUN_ARTIFACT_MALFORMED'] } }
}
async function checkArtifact(artifact: RunArtifact, options: CheckRunOptions): Promise<RunVerification> {
  const record = artifact.record, privateEvidence = artifact.private_evidence
  const signature = verifyRunRecord(record, options.materials, options.sandboxPk, options.budgets, privateEvidence?.public_result)
  const errors = [...signature.errors]
  if (!privateEvidence || artifact.v !== 1) return { ok: false, errors: [...errors, 'RUN_PRIVATE_EVIDENCE_MISSING'] }
  const exact = (value: object, keys: string[]) => Object.keys(value).sort().join() === keys.sort().join()
  if (!exact(privateEvidence, ['tools', 'decisions', 'replay', 'policy_result', 'public_result', ...(Object.hasOwn(privateEvidence, 'failure_code') ? ['failure_code'] : [])])) errors.push('RUN_PRIVATE_UNEXPECTED_FIELDS')
  if (hashObject(privateEvidence) !== record.private_evidence_sha256) errors.push('RUN_PRIVATE_EVIDENCE_MISMATCH')
  if (hashObject(privateEvidence.public_result) !== record.public_result_sha256) errors.push('RUN_PUBLIC_RESULT_MISMATCH')
  if (hashObject(privateEvidence.policy_result) !== record.policy_sha256) errors.push('RUN_POLICY_COMMITMENT_MISMATCH')
  if (!Array.isArray(privateEvidence.tools) || privateEvidence.tools.length !== record.tool_calls.length || !Array.isArray(privateEvidence.decisions) || privateEvidence.decisions.length !== record.decision_attempts.length) return { ok: false, errors: [...errors, 'RUN_PRIVATE_CALLS_MISMATCH'] }
  for (const [index, call] of privateEvidence.tools.entries()) {
    const signed = record.tool_calls[index]
    const invalid = Object.keys(call.args).join() === 'invalid_sha256' && isHex(call.args.invalid_sha256, 32) && !!call.error && call.result === null
    const argumentHash = invalid ? call.args.invalid_sha256 : hashObject(call.args)
    if (!exact(call, ['name', 'args', 'evidence_id', 'result', ...(Object.hasOwn(call, 'error') ? ['error'] : [])]) || (call.error && !/^[A-Z][A-Z0-9_:]{0,79}$/.test(call.error)) || (!invalid && !toolArgumentsValid(call.name, call.args)) || !signed || signed.name !== call.name || signed.evidence_id !== call.evidence_id || signed.arguments_sha256 !== argumentHash || signed.result_sha256 !== hashObject(call.result)) errors.push('RUN_PRIVATE_TOOL_MISMATCH')
  }
  for (const [index, attempt] of privateEvidence.decisions.entries()) {
    try { assertCodedDecision(attempt.report) } catch { errors.push('RUN_DECISION_PROSE_OR_SCHEMA') }
    const signed = record.decision_attempts[index]
    if (!exact(attempt, ['report', 'accepted', 'reason_codes', 'evidence_count']) || !signed || signed.report_sha256 !== hashObject(attempt.report) || signed.accepted !== attempt.accepted || signed.evidence_count !== attempt.evidence_count || hashObject(signed.reason_codes) !== hashObject(attempt.reason_codes)) errors.push('RUN_PRIVATE_DECISION_MISMATCH')
  }
  if (privateEvidence.replay && !exact(privateEvidence.replay, ['bundle', 'chain', 'blocks_per_month', 'redacted_txids', 'profiles', ...(Object.hasOwn(privateEvidence.replay, 'native_history') ? ['native_history'] : [])])) errors.push('RUN_REPLAY_UNEXPECTED_FIELDS')
  // A material/signature failure is enough. Do not execute untrusted arguments.
  if (errors.length) return { ok: false, errors: [...new Set(errors)] }
  if (record.status === 'not_run') {
    if (privateEvidence.tools.length || privateEvidence.decisions.length || record.model_calls.length) errors.push('RUN_NOT_RUN_HAS_CALLS')
  }
  if (record.status !== 'done' && !/^[A-Z][A-Z0-9_:]{0,79}$/.test(privateEvidence.failure_code ?? '')) errors.push('RUN_FAILURE_CODE_INVALID')
  if (!privateEvidence.replay && (record.status === 'done' || privateEvidence.tools.length || privateEvidence.decisions.length)) return { ok: false, errors: [...errors, 'RUN_REPLAY_CONTEXT_MISSING'] }
  try {
    const context = privateEvidence.replay
    let nativeContext = { verifiedHistory: false, verifiedCounterparties: new Set<Hex>() }
    if (context?.native_history) {
      const native = context.native_history
      if (options.trustedObserverPk !== undefined && native.trusted_observer_pk !== options.trustedObserverPk) errors.push('RUN_HISTORY_OBSERVER_MISMATCH')
      const modulePath = './reconcile.js'
      const reconcile = await import(modulePath) as { reconcileHistory: (bundle: OfflineReplayContext['bundle'], chain: ReturnType<typeof snapshotChain>, options: { trustedSigners: Hex[]; assetId: string; currentHeight: number; getUnspent: (txid: Hex, vout: number) => Promise<{ value: number; script: Hex } | null> }) => Promise<{ status: string; verifiedCounterpartyPks?: Hex[] }> }
      const unspents = new Map(native.unspents.map((output) => [`${output.txid}:${output.vout}`, { value: output.value, script: output.script }]))
      if (unspents.size !== native.unspents.length) errors.push('RUN_DUPLICATE_UNSPENT_OBSERVATION')
      const verified = await reconcile.reconcileHistory(context.bundle, snapshotChain(context.chain), {
        trustedSigners: [options.trustedObserverPk ?? native.trusted_observer_pk], assetId: native.asset_id, currentHeight: context.chain.height,
        getUnspent: async (txid, vout) => unspents.get(`${txid}:${vout}`) ?? null,
      })
      if (verified.status === 'verified') nativeContext = { verifiedHistory: true, verifiedCounterparties: new Set(verified.verifiedCounterpartyPks ?? []) }
    }
    const profiles = new Map(context?.profiles.map((entry) => [entry.pk, entry.profile]))
    const prepared = context ? await investigationTools(context.bundle, snapshotChain(context.chain), context.blocks_per_month, new Set(context.redacted_txids), {
      payerProfile: async (pk) => {
        const profile = profiles.get(pk)
        if (!profile) throw new Error('public payer profile observation is missing')
        return profile
      },
      ...nativeContext,
    }) : undefined
    // Re-execute every read-only tool; signed hashes alone do not ground a claim.
    for (const call of privateEvidence.tools) {
      try {
        const replayed = await prepared!.tools.execute(call.name, call.args)
        const expectedFailure = record.status === 'failed' && ((call.error === 'TOOL_RETURNED_ERROR' && replayed !== null && typeof replayed === 'object' && 'error' in replayed) || (call.error === 'TOOL_CONTEXT_BUDGET_EXCEEDED' && JSON.stringify(replayed).length > 9000))
        if ((call.error && !expectedFailure) || hashObject(replayed) !== hashObject(call.result)) errors.push('RUN_TOOL_REPLAY_MISMATCH')
      } catch {
        if (!call.error || record.status !== 'failed') errors.push('RUN_TOOL_REPLAY_ERROR')
      }
    }
    const replay = options.replayInvestigation ?? await publishedReplay()
    let final: ReplayResult | undefined
    for (const attempt of privateEvidence.decisions) {
      const ledger = privateEvidence.tools.slice(0, attempt.evidence_count).map((call) => ({ id: call.evidence_id, tool: call.name, args: call.args, result: call.result, ...(call.error ? { error: call.error } : {}) }))
      const checked = replay(attempt.report, ledger, prepared!.evidence)
      if (attempt.accepted !== (checked.errors.length === 0) || hashObject([...attempt.reason_codes].sort()) !== hashObject([...checked.errors].sort())) errors.push('RUN_GROUNDING_REPLAY_MISMATCH')
      if (attempt.accepted) final = checked
    }
    if (record.status === 'done') {
      if (!final) errors.push('RUN_ACCEPTED_DECISION_MISSING')
      else if (hashObject(final.policy) !== record.policy_sha256) errors.push('RUN_POLICY_REPLAY_MISMATCH')
    } else {
      const failed = replay(null, [], prepared?.evidence, privateEvidence.failure_code)
      // A grounded report can itself produce a failed coverage policy. It is
      // also valid for a later explicit failure to replace it with fail-safe.
      const groundedFailure = final?.policy.verdict === 'failed' && hashObject(final.policy) === record.policy_sha256
      if (!groundedFailure && (failed.errors.length || hashObject(failed.policy) !== record.policy_sha256)) errors.push('RUN_FAILSAFE_POLICY_REPLAY_MISMATCH')
    }
  } catch {
    errors.push('RUN_REPLAY_UNAVAILABLE')
  }
  return { ok: !errors.length, errors: [...new Set(errors)] }
}

export async function checkRunDirectory(dir: string, options: CheckRunOptions): Promise<RunVerification> {
  try { return await checkRunArtifact(await readRunArtifact(dir), options) }
  catch { return { ok: false, errors: ['RUN_ARTIFACT_READ_ERROR'] } }
}
