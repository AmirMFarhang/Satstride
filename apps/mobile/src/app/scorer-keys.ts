import type { PortableScorerKey } from '../../../../src/scorer/portable-evidence.js'
import configured from './scorer-keys.json'

/** Public signer pins configured by the wallet owner before a build; relay offers cannot add keys. */
export function scorerKeysFromJson(value: unknown): PortableScorerKey[] {
  const rows = value && typeof value === 'object' && !Array.isArray(value) ? (value as { keys?: unknown }).keys : null
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is PortableScorerKey => !!row && typeof row === 'object'
    && typeof row.public_key_hex === 'string' && /^[0-9a-f]{64}$/.test(row.public_key_hex)
    && (row.development === undefined || typeof row.development === 'boolean'))
    .map((row) => ({ public_key_hex: row.public_key_hex, ...(row.development ? { development: true } : {}) }))
}

export async function pinnedScorerKeys(): Promise<PortableScorerKey[]> { return scorerKeysFromJson(configured) }
