// Execution tier, derived from evidence (docs/CHECK-ATTESTATION.md). An offer
// may declare a TEE; the verifier grants `tee-attested` only when all five
// checks pass for a vendor whose root this verifier pins:
//
//   1 enclave-key       the result_key was born in the enclave: the attestation binds it
//   2 vendor-chain      the attestation chains to the pinned vendor root
//   3 measurement       the measured code equals the pinned release
//   4 fresh-report      report data = sha256(commitment ‖ request nonce), so it is this result
//   5 result-signature  the commitment is signed by result_key
//
// Anything else (no attestation, an unpinned or unbuilt vendor, any failed
// check) is `software-evidence`, whatever the offer says. Passbook never
// fabricates an attestation. Real AWS Nitro verification (COSE_Sign1, CBOR,
// the AWS root) is after the hackathon: the `aws-nitro` vendor is listed and
// always refused with that reason. `test-vendor` exists only so the five
// checks have a positive path in tests; no shipped config pins its root.

import { hashObject, isHex, verifyHash, type Hex } from '../core/crypto.js'
import type { CheckExecution, CheckRelease, TeeVendor } from './offer.js'

export type ExecutionTier = 'software-evidence' | 'tee-attested'
export type MinExecution = 'software' | 'tee'

export const EXECUTION_TIER_LABEL: Record<ExecutionTier, string> = {
  'software-evidence': 'no TEE: software evidence',
  'tee-attested': 'TEE: attested',
}

export interface Tick { id: string; ok: boolean; detail: string }

/** What a vendor's parser extracts after checking the document's signature chain. */
export interface ParsedAttestation {
  measurement: string
  public_key: Hex
  report_data: Hex
  timestamp: number
  chain: { ok: boolean; detail: string }
}

export interface TeeVendorVerifier {
  vendor: TeeVendor
  parse(attestation: string): ParsedAttestation
}

export interface TeeVerifierConfig {
  /** Only vendors listed here can grant tee-attested; each pins its own root. */
  vendors: Partial<Record<TeeVendor, TeeVendorVerifier>>
  /** The enclave measurement a release must have, from the signed release manifest; undefined when not pinned. */
  measurementFor(release: CheckRelease): string | undefined
  maxAgeSeconds: number
  now: number
}

/** The default: no vendor pinned, so every claim derives to software evidence. */
export function noTeeVerifier(now: number): TeeVerifierConfig {
  return { vendors: {}, measurementFor: () => undefined, maxAgeSeconds: 600, now }
}

export interface ResultEvidence {
  /** A fresh attestation produced for this result. */
  attestation: string
  /** result_key's BIP-340 signature over the commitment hash. */
  result_sig: Hex
  commitment_hash: Hex
  report_data: Hex
}

export interface DerivedExecution { tier: ExecutionTier; claimed: CheckExecution['tee']; ticks: Tick[] }

const software = (claimed: CheckExecution['tee'], ticks: Tick[]): DerivedExecution => ({ tier: 'software-evidence', claimed, ticks })

/**
 * The tier a verifier grants. Without `result` (choosing among offers) the
 * fresh-report and result-signature checks cannot pass yet, so an offer's TEE
 * claim is at most "attestable"; the tier is granted per result.
 */
export function deriveExecution(execution: CheckExecution, release: CheckRelease, cfg: TeeVerifierConfig, result?: ResultEvidence): DerivedExecution & { attestable: boolean } {
  const ticks: Tick[] = []
  const tick = (id: string, ok: boolean, detail: string) => ticks.push({ id, ok, detail })
  if (execution.tee === 'none') {
    tick('tee-claim', true, 'the node declares no TEE')
    return { ...software('none', ticks), attestable: false }
  }
  const vendor = cfg.vendors[execution.tee]
  if (!vendor) {
    tick('vendor-pinned', false, execution.tee === 'aws-nitro' ? 'AWS Nitro verification is not built yet (after the hackathon); the claim counts as software evidence' : `no pinned root for ${execution.tee}; the claim counts as software evidence`)
    return { ...software(execution.tee, ticks), attestable: false }
  }
  const verify = (attestation: string, label: string): ParsedAttestation | null => {
    try { return vendor.parse(attestation) } catch (err) {
      tick(`${label}-parse`, false, `attestation does not parse: ${(err as Error).message.slice(0, 120)}`)
      return null
    }
  }
  const doc = verify(result?.attestation ?? execution.attestation, result ? 'result' : 'offer')
  if (!doc) return { ...software(execution.tee, ticks), attestable: false }
  tick('enclave-key', isHex(execution.result_key, 32) && doc.public_key === execution.result_key, 'the attestation binds the offer\'s result_key')
  tick('vendor-chain', doc.chain.ok, doc.chain.detail)
  const pinned = cfg.measurementFor(release)
  tick('measurement', !!pinned && doc.measurement === pinned, pinned ? (doc.measurement === pinned ? 'measurement equals the pinned release' : `measurement ${doc.measurement.slice(0, 20)}… is not the pinned release`) : 'the release manifest pins no enclave measurement for this release')
  const attestable = ticks.every((t) => t.ok)
  if (!result) {
    tick('fresh-report', false, 'checked per result: no result yet')
    return { ...software(execution.tee, ticks), attestable }
  }
  const fresh = doc.report_data === result.report_data && cfg.now - doc.timestamp <= cfg.maxAgeSeconds && doc.timestamp <= cfg.now + 60
  tick('fresh-report', fresh, doc.report_data !== result.report_data ? 'report data is not sha256(commitment ‖ request nonce): a stale or reused attestation' : fresh ? 'report data binds this commitment and request nonce' : 'attestation is too old')
  tick('result-signature', verifyHash(result.result_sig, result.commitment_hash, execution.result_key), 'the commitment is signed by result_key')
  const ok = ticks.every((t) => t.ok)
  return { tier: ok ? 'tee-attested' : 'software-evidence', claimed: execution.tee, ticks, attestable }
}

export function executionAtLeast(tier: ExecutionTier, min: MinExecution): boolean {
  return min === 'software' || tier === 'tee-attested'
}

// ---- test vendor: a stand-in document format with a test root, for the refusal fixtures ----

export interface TestVendorDocument {
  vendor: 'test-vendor'
  measurement: string
  public_key: Hex
  report_data: Hex
  timestamp: number
  /** root -> leaf: the root signs the leaf key, the leaf signs the document */
  leaf_pk: Hex
  leaf_sig: Hex
  sig: Hex
}

export function testVendorDocumentHash(d: Omit<TestVendorDocument, 'sig'>): Hex {
  return hashObject({ domain: 'passbook-test-vendor-attestation-v1', ...d })
}

/** Verifies a test-vendor document against a root this verifier pins. Never pinned outside tests. */
export function testVendorVerifier(rootPk: Hex): TeeVendorVerifier {
  return {
    vendor: 'test-vendor',
    parse(attestation: string): ParsedAttestation {
      const d = JSON.parse(Buffer.from(attestation, 'base64').toString('utf8')) as TestVendorDocument
      if (d?.vendor !== 'test-vendor' || typeof d.measurement !== 'string' || !isHex(d.public_key, 32) || !isHex(d.report_data, 32) || !Number.isSafeInteger(d.timestamp) || !isHex(d.leaf_pk, 32)) throw new Error('not a test-vendor document')
      const { sig, ...unsigned } = d
      const leafOk = verifyHash(d.leaf_sig, hashObject({ domain: 'passbook-test-vendor-leaf-v1', leaf_pk: d.leaf_pk }), rootPk)
      const docOk = verifyHash(sig, testVendorDocumentHash(unsigned), d.leaf_pk)
      return { measurement: d.measurement, public_key: d.public_key, report_data: d.report_data, timestamp: d.timestamp, chain: { ok: leafOk && docOk, detail: leafOk ? (docOk ? 'chains to the pinned test-vendor root' : 'document not signed by its leaf') : 'leaf not signed by the pinned root' } }
    },
  }
}
