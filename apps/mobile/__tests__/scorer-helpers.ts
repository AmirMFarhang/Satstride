// Unit-test signed local result. Full scorer/contract verification is exercised by lender-e2e.
import { hashObject, keyPairFromLabel, signObject } from '../../../src/core/crypto.ts'
import type { PassbookCheckOutputs, ScorerOutcome } from '../../../src/scorer/types.ts'

const scorer = keyPairFromLabel('mobile-unit-scorer')
export function unitOutcome(outputs: PassbookCheckOutputs, fallback = false): ScorerOutcome {
  const descriptor = signObject({ v: 1 as const, provider: 'in-process' as const, scorer_id: 'passbook-sandbox:mobile-unit', trust: 'dev-inprocess' as const, code_measurement: 'source:' + 'ab'.repeat(32), contract_hash: 'cd'.repeat(32), enclave_pubkey: scorer.pubkey }, scorer.secretKey)
  const record = signObject({ v: 1, kind: 'passbook-signed-run', sandbox_pk: scorer.pubkey, bundle_hash: outputs.bundle_hash, assurance: 'software-signature-only', status: 'done', duration_ms: 1, public_result_sha256: hashObject(outputs) }, scorer.secretKey)
  const result = signObject({ v: 1, kind: 'passbook-check-result', scorer: { provider: descriptor.provider, scorer_id: descriptor.scorer_id, trust: descriptor.trust, code_measurement: descriptor.code_measurement, contract_hash: descriptor.contract_hash, enclave_pubkey: scorer.pubkey }, request_hash: '11'.repeat(32), consent_hash: '12'.repeat(32), height: 100, outputs, evidence: { investigation: {}, run_record: record } }, scorer.secretKey)
  return { kind: 'passbook-signed', descriptor, result, fallback } as ScorerOutcome
}
