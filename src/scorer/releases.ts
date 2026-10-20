// The approved-builds allowlist (scorer.approved_builds): which scorer code
// measurements may run under which contract hash, up to which trust level, the
// external provider evidence.
// container scorer's key. Signed by the deployment's release key; a client
// pins that key in its config, never takes it from the manifest.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashObject, isHex, keyPairFromLabel, sha256Hex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { SCORER_PROVIDERS, TRUST_LEVELS, type ScorerProviderKind, type TrustLevel } from './trust.js'

export interface ApprovedBuild {
  label: string
  provider: ScorerProviderKind
  /** Code measurement approved by this host. */
  code_measurement: string
  /** Generic scoring contract hash. */
  contract_hash: Hex
  max_trust: TrustLevel
}

export interface ReleaseManifest {
  v: 1
  kind: 'passbook-scorer-releases'
  signer_pk: Hex
  /** true when signed with the publicly derivable development key */
  development: boolean
  issued_at: number
  builds: ApprovedBuild[]
  /** Optional external evidence signing key identifiers. */
  external_evidence_keyids: string[]
  /** Keys allowed to declare which enclave key a container scorer runs with. */
  operators: Hex[]
  sig: Hex
}

/** Publicly derivable, so any manifest it signs is a development manifest. */
export const DEV_RELEASE_SIGNER_LABEL = 'DEV-release-signer-NOT-FOR-PRODUCTION'
export function devReleaseSigner(): KeyPair {
  return keyPairFromLabel(DEV_RELEASE_SIGNER_LABEL)
}

export function signReleaseManifest(signer: KeyPair, input: { builds: ApprovedBuild[]; external_evidence_keyids?: string[]; operators?: Hex[]; issued_at?: number }): ReleaseManifest {
  return signObject({
    v: 1 as const, kind: 'passbook-scorer-releases' as const, signer_pk: signer.pubkey, development: signer.pubkey === devReleaseSigner().pubkey,
    issued_at: input.issued_at ?? Math.floor(Date.now() / 1000), builds: input.builds, external_evidence_keyids: input.external_evidence_keyids ?? [], operators: input.operators ?? [],
  }, signer.secretKey)
}

export function releaseManifestProblems(m: ReleaseManifest, pinnedSignerPk: Hex): string[] {
  if (!m || m.v !== 1 || m.kind !== 'passbook-scorer-releases' || !Array.isArray(m.builds) || !Array.isArray(m.operators) || !Array.isArray(m.external_evidence_keyids)) return ['RELEASES_MALFORMED']
  const problems: string[] = []
  if (m.signer_pk !== pinnedSignerPk) problems.push('RELEASES_UNPINNED_SIGNER')
  else if (!verifyObject(m, pinnedSignerPk)) problems.push('RELEASES_SIGNATURE')
  if (m.development !== (m.signer_pk === devReleaseSigner().pubkey)) problems.push('RELEASES_DEVELOPMENT_FLAG')
  for (const b of m.builds) {
    if (!b || typeof b.label !== 'string' || !(SCORER_PROVIDERS as readonly string[]).includes(b.provider) || !/^(sha256|source):[0-9a-f]{64}$/.test(b.code_measurement) || !isHex(b.contract_hash, 32) || !(TRUST_LEVELS as readonly string[]).includes(b.max_trust)) problems.push('RELEASES_BUILD_MALFORMED')
  }
  if (!m.operators.every((pk) => isHex(pk, 32)) || !m.external_evidence_keyids.every((id) => typeof id === 'string' && /^[A-Za-z0-9._-]{4,64}$/.test(id))) problems.push('RELEASES_KEYS_MALFORMED')
  return [...new Set(problems)]
}

export function loadReleaseManifest(path: string): ReleaseManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest
}

export function approvedBuild(m: ReleaseManifest, provider: ScorerProviderKind, measurement: string, contractHash: Hex): ApprovedBuild | undefined {
  return m.builds.find((b) => b.provider === provider && b.code_measurement === measurement && b.contract_hash === contractHash)
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/** In-process measurement: every source file plus the lockfile and the contract. Any edit changes it. */
/** The source tree's hash; the repository root is resolved when called, never at import. */
export function measureSource(root = fileURLToPath(new URL('../../', import.meta.url))): string {
  const files = [...walk(join(root, 'src')).filter((f) => f.endsWith('.ts')), join(root, 'package-lock.json'), join(root, 'contracts', 'scoring.contract.json')]
    .map((f) => [relative(root, f).split('\\').join('/'), sha256Hex(readFileSync(f))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `source:${hashObject(files)}`
}
