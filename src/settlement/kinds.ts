// Settlement kinds and what this release can actually run. Kept apart from the
// adapters so the config loader can validate without importing wallet code.

export const SETTLEMENT_KINDS = ['cosign-rgb', 'ln-rln', 'onchain-swap'] as const
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number]

/** cosign-rgb is the fallback and must always be enabled. */
export const FALLBACK_SETTLEMENT: SettlementKind = 'cosign-rgb'

export const SETTLEMENT_STATUS: Record<SettlementKind, { built: boolean; atomic: boolean; note: string }> = {
  'cosign-rgb': { built: true, atomic: false, note: 'RGB payment validated by the lender, then a co-signed leaf A release; leaf C covers a lender who refuses' },
  'ln-rln': { built: true, atomic: true, note: 'RGB Lightning invoice hash in the terms; paying returns the preimage that unlocks leaf E' },
  'onchain-swap': { built: false, atomic: true, note: 'roadmap only: the atomic route is Lightning (ln-rln); one Bitcoin transaction moving the USDT and spending the escrow would need an extra-input swap in rgb-lib' },
}

export function isSettlementKind(value: unknown): value is SettlementKind {
  return typeof value === 'string' && (SETTLEMENT_KINDS as readonly string[]).includes(value)
}

/** Preference when both parties accept several kinds: atomic before co-signed. */
export const SETTLEMENT_PREFERENCE: readonly SettlementKind[] = ['ln-rln', 'onchain-swap', 'cosign-rgb']
