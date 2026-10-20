// External evidence is opaque to PassBook. An explicitly installed plugin owns its formats.
import type { ScorerOutcome, ScorerProvider } from './types.js'
import type { LenderExpectations, TrustPolicy, Tick } from './verify.js'
import { isTrustLevel, type TrustLevel } from './trust.js'
export type ExternalOutcome = Extract<ScorerOutcome, { kind: 'external-evidence' }>
export type ExternalOutcomeVerifier = (outcome: ExternalOutcome, policy: TrustPolicy, expect: LenderExpectations) => Promise<{ ticks: Tick[]; trust: TrustLevel | null }>
export interface ExternalProviderPlugin {
  apiVersion: 1
  provider: ScorerProvider
  verifyOutcome: ExternalOutcomeVerifier
}
export async function verifyExternalOutcome(outcome: ExternalOutcome, policy: TrustPolicy, expect: LenderExpectations) {
  if (!expect.externalVerifier) return { ticks: [{ id: 'external-verifier', ok: false, detail: 'no host-configured external verifier' }], trust: null }
  const result = await expect.externalVerifier(outcome, policy, expect)
  if (!result || !Array.isArray(result.ticks) || !result.ticks.length || !result.ticks.every(t => t && typeof t.id === 'string' && typeof t.ok === 'boolean' && typeof t.detail === 'string') || (result.trust !== null && !isTrustLevel(result.trust))) return {ticks:[{id:'external-verifier',ok:false,detail:'external verifier returned no valid evidence checks'}],trust:null}
  return result
}
/** Configured only by the host; never resolve package names sent by an offer or result. */
export async function loadExternalProvider(packageName: string, options: unknown): Promise<ExternalProviderPlugin> {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error('external provider must be an installed package name')
  const module = await import(packageName)
  const factory = module.createPassbookProvider ?? module.createProviderPlugin
  if (typeof factory !== 'function') throw new Error('external provider must export createPassbookProvider(options)')
  const plugin = await factory(options) as ExternalProviderPlugin
  if (plugin?.apiVersion !== 1 || plugin.provider?.kind !== 'external' || typeof plugin.provider.describe !== 'function' || typeof plugin.provider.check !== 'function' || typeof plugin.verifyOutcome !== 'function') throw new Error('unsupported external provider plugin')
  return plugin
}
