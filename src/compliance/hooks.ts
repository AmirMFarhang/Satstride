// Compliance hooks. Both are `none` in the demo: the result says plainly that
// nothing was checked, and a lender policy decides what that means. Real
// providers plug in behind the same interfaces; none is bundled here.

import type { Hex } from '../core/crypto.js'
import type { PassbookConfig } from '../core/config.js'

export interface IdentityResult {
  status: 'not_checked' | 'verified' | 'rejected'
  provider: string
  /** Hash of the provider's evidence, never the evidence itself. */
  evidence_hash?: Hex
}

export interface IdentityProvider {
  readonly name: string
  check(subjectPk: Hex): Promise<IdentityResult>
}

export interface ScreeningResult {
  status: 'not_screened' | 'clear' | 'hit'
  list: string
  /** When the list was last refreshed, Unix seconds; absent when not screened. */
  list_as_of?: number
}

export interface SanctionsScreen {
  readonly name: string
  screen(subject: { pk: Hex; name?: string; country?: string }): Promise<ScreeningResult>
}

export class NoIdentityProvider implements IdentityProvider {
  readonly name = 'none'
  async check(_subjectPk: Hex): Promise<IdentityResult> {
    return { status: 'not_checked', provider: 'none' }
  }
}

export class NoSanctionsScreen implements SanctionsScreen {
  readonly name = 'none'
  async screen(_subject: { pk: Hex }): Promise<ScreeningResult> {
    return { status: 'not_screened', list: 'none' }
  }
}

/** Placeholder for the documented OpenSanctions option; refuses until configured. */
export class OpenSanctionsScreen implements SanctionsScreen {
  readonly name = 'opensanctions'
  async screen(): Promise<ScreeningResult> {
    throw new Error('opensanctions screening is not configured in this release (see docs/COMPLIANCE.md)')
  }
}

export interface ComplianceHooks {
  identity: IdentityProvider
  sanctions: SanctionsScreen
}

export function complianceFromConfig(cfg: Pick<PassbookConfig, 'compliance'>): ComplianceHooks {
  if (cfg.compliance.identity !== 'none') throw new Error(`identity provider ${cfg.compliance.identity} is not implemented`)
  return { identity: new NoIdentityProvider(), sanctions: cfg.compliance.sanctions === 'opensanctions' ? new OpenSanctionsScreen() : new NoSanctionsScreen() }
}

/** A sanctions hit or an identity rejection blocks; `not_checked` is reported, never upgraded to clear. */
export function complianceGate(identity: IdentityResult, screening: ScreeningResult): { ok: boolean; detail: string } {
  if (identity.status === 'rejected') return { ok: false, detail: `identity rejected by ${identity.provider}` }
  if (screening.status === 'hit') return { ok: false, detail: `sanctions hit on ${screening.list}` }
  return { ok: true, detail: `identity ${identity.status} (${identity.provider}); sanctions ${screening.status} (${screening.list})` }
}
