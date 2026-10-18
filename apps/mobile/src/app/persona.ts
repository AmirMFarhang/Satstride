// REGTEST TEST DATA ONLY: the seeded test persona (the user's option A for the M7 acceptance run).
// A fresh phone wallet has no history the platform's trusted observer saw from zero, so its Compex
// check honestly comes back ESCALATE. For the acceptance run the person may switch this phone to a
// persona the service provider seeded and observed from zero (Fatima or Walter): its words, an
// rgb-lib backup of its wallet, the income records it was seeded with, and the observer's history
// proof exactly as the observer issued it. The phone checks the proof against the platform's own
// key before using it, keeps the persona under its own wallet id (the person's own wallet stays as
// it is, one tap away), and labels every screen while it is active. Never mainnet, never a real
// person's wallet.
import type { Hex } from '../../../../src/core/crypto.js'
import { verifyObject } from '../../../../src/core/crypto.js'
import type { HistoryProof } from '../../../../src/sandbox/reconcile.js'
import type { SeededInflow } from '../../../../src/wallet/state.js'

export const PERSONA_WALLET_ID = 'passbook-test-persona'
/** Where provider.sh service persona serves the package once (adb reverse on the phone's loopback). */
export const PERSONA_URL = 'http://127.0.0.1:4309/persona.json'

export interface PersonaPackage {
  v: 1
  kind: 'passbook-test-persona'
  label: string
  network: string
  persona: 'fatima' | 'walter'
  words: string
  rgb_fingerprint: string
  rgb_backup_b64: string
  rgb_backup_password: string
  asset_id: string
  observer_pk: Hex
  inflows: SeededInflow[]
  history_proof: HistoryProof
  issued_at: number
  /** The persona's own declared recurring outflows (test data), if its seed gave it any; none otherwise. */
  declared_outflows?: DeclaredOutflow[]
}

/** A recurring outflow the borrower declares in the check bundle (src/sandbox/types.ts ScheduledOutflow, without its height). */
export interface DeclaredOutflow { label: string; every_blocks: number; amount: number }

/** What the persona's agent state keeps: no words, no backup. */
export interface PersonaRecord {
  name: 'fatima' | 'walter'
  label: string
  observer_pk: Hex
  asset_id: string
  inflows: SeededInflow[]
  history_proof: HistoryProof
  declared_outflows?: DeclaredOutflow[]
  installed_at: number
}

export const personaTitle = (name: string): string => `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`

/**
 * Every reason not to use a package: not a regtest test persona, words that are not words, or a
 * history proof that is not exactly as the platform's trusted observer signed it. `platformPk`
 * comes from the platform's own /state, not from the package.
 */
export function personaProblems(pkg: unknown, platformPk: Hex, validWords: (w: string) => boolean, network = 'regtest'): string[] {
  const p = pkg as PersonaPackage
  if (!p || p.v !== 1 || p.kind !== 'passbook-test-persona' || (p.network !== 'regtest' && p.network !== 'mutinynet')) return ['not a test persona package']
  if (p.network !== network) return [`a ${p.network} test persona, and this phone runs ${network}`]
  const problems: string[] = []
  if (p.persona !== 'fatima' && p.persona !== 'walter') problems.push('unknown persona')
  if (typeof p.words !== 'string' || !validWords(p.words)) problems.push('the words are not a valid recovery phrase')
  if (!/^[0-9a-f]{8}$/.test(String(p.rgb_fingerprint)) || typeof p.rgb_backup_b64 !== 'string' || !p.rgb_backup_b64 || typeof p.rgb_backup_password !== 'string') problems.push('no wallet backup')
  if (!Array.isArray(p.inflows)) problems.push('no income records')
  if (p.declared_outflows !== undefined && !(Array.isArray(p.declared_outflows) && p.declared_outflows.length <= 8 && p.declared_outflows.every((o) => typeof o?.label === 'string' && o.label.length <= 40 && Number.isSafeInteger(o.every_blocks) && o.every_blocks > 0 && Number.isSafeInteger(o.amount) && o.amount >= 0)))
    problems.push('the declared outflows are malformed')
  const h = p.history_proof
  if (p.observer_pk !== platformPk) problems.push("the observer is not this platform's key")
  if (!h || h.observer_pk !== platformPk) problems.push("the history proof is not from this platform's observer")
  else {
    if (!verifyObject(h, h.observer_pk)) problems.push("the history proof's signature does not verify")
    if (h.v !== 1 || h.assurance !== 'trusted_wallet_snapshot') problems.push('the history proof is not a trusted wallet snapshot')
    if (!h.observed_from_zero || h.opening_balance !== 0) problems.push('the history was not observed from zero')
    if (h.asset_id !== p.asset_id) problems.push('the history proof is about another asset')
  }
  return problems
}

/**
 * The persona record a borrower may use: only when its proof is about this wallet's key and this asset.
 * PhoneBorrower builds the bundle from it, and the screens say what the bundle carries from it.
 */
export const eligiblePersona = (p: PersonaRecord | null | undefined, borrowerPk: string, assetId: string | null | undefined): PersonaRecord | null =>
  p && assetId && p.history_proof.borrower_pk === borrowerPk && p.history_proof.asset_id === assetId ? p : null

export const personaRecord = (p: PersonaPackage, nowS = Math.floor(Date.now() / 1000)): PersonaRecord => ({
  name: p.persona, label: p.label, observer_pk: p.observer_pk, asset_id: p.asset_id, inflows: p.inflows, history_proof: p.history_proof,
  ...(p.declared_outflows?.length ? { declared_outflows: p.declared_outflows.map(({ label, every_blocks, amount }) => ({ label, every_blocks, amount })) } : {}),
  installed_at: nowS,
})

export async function fetchPersona(url = PERSONA_URL, timeoutMs = 10_000): Promise<unknown> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`the service provider answered ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}
