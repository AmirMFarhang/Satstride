export const TRUST_LEVELS = ['dev-inprocess', 'software-evidence', 'hardware-attested'] as const
export type TrustLevel = (typeof TRUST_LEVELS)[number]

export const SCORER_PROVIDERS = ['in-process', 'container', 'external'] as const
export type ScorerProviderKind = (typeof SCORER_PROVIDERS)[number]

/** The most a provider of this kind can ever be granted. */
export const PROVIDER_TRUST: Record<ScorerProviderKind, TrustLevel> = {
  'in-process': 'dev-inprocess',
  container: 'dev-inprocess',
  external: 'software-evidence',
}

export const UNAVAILABLE_PROVIDERS: ReadonlyMap<ScorerProviderKind, string> = new Map()

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === 'string' && (TRUST_LEVELS as readonly string[]).includes(value)
}

export function trustAtLeast(actual: TrustLevel, minimum: TrustLevel): boolean {
  return TRUST_LEVELS.indexOf(actual) >= TRUST_LEVELS.indexOf(minimum)
}

export function weakerTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return trustAtLeast(a, b) ? b : a
}

export function strongerTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return trustAtLeast(a, b) ? a : b
}
