// Resume must never let an SDK initialize a replacement wallet for missing
// native files. This is an existence/identity preflight, not RGB validation.
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { keyPathOutput } from '../escrow/escrow.js'
import { watchKeys } from '../rgb/watch.js'
import { loadSeed, partyKey, ROLES, walletsDir, type Role, type WalletRole } from '../wallet/party.js'
import type { PartyState, SeedState } from '../wallet/state.js'

function directory(path: string): void {
  let stat
  try { stat = lstatSync(path) } catch { throw new Error('Existing demo wallet directory required; resume will not create a replacement') }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe demo wallet directory; symlinks are not accepted for resume')
}
function file(path: string): void {
  let stat
  try { stat = lstatSync(path) } catch { throw new Error('Existing demo wallet files required; resume will not create a replacement') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Existing nonempty demo wallet files required; symlinks are not accepted for resume')
}
function expectedParty(state: SeedState, role: WalletRole): PartyState {
  // Other seeded helper roles have no identity entry in SeedState. Do not
  // infer their identity from a directory or let a role escape the namespace.
  const expected = ROLES.includes(role as Role) ? state.parties?.[role as Role] : role === 'fatima' || role === 'walter' ? state.personas?.[role]?.party : undefined
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.pubkey) || typeof expected.btc_address !== 'string' || !expected.btc_address) throw new Error('Missing or invalid seeded identity for demo wallet role')
  return expected
}

/** Read existing seeds and derive public keys only. Never opens a wallet,
 * contacts a service, creates a file, or repairs a missing native database. */
export async function assertDemoWallets(state: SeedState, roles: WalletRole[], dir = walletsDir()): Promise<void> {
  if (!state || state.v !== 1 || state.network !== 'regtest' || !Array.isArray(roles)) throw new Error('Invalid seeded demo wallet state')
  const root = resolve(dir)
  // Reject symlinks in the configured root's ancestors as well as below it.
  for (let path = root; ; path = dirname(path)) { directory(path); if (dirname(path) === path) break }
  for (const role of roles) {
    const expected = expectedParty(state, role)
    const base = join(root, role), rgb = join(base, 'rgb')
    directory(base); file(join(base, 'seed'))
    let fingerprint: string
    try {
      const seed = loadSeed(role, { dir: root, create: false }), key = partyKey(seed)
      if (key.pubkey !== expected.pubkey || keyPathOutput(key.pubkey).address !== expected.btc_address) throw new Error('identity mismatch')
      fingerprint = (await watchKeys(seed)).master_fingerprint
    } catch { throw new Error(`Existing ${role} wallet seed does not match its seeded identity or cannot derive native keys`) }
    if (!/^[a-f0-9]{8}$/i.test(fingerprint)) throw new Error('Invalid native wallet fingerprint')
    const native = join(rgb, fingerprint)
    for (const path of [rgb, native, join(native, 'rgb')]) directory(path)
    for (const name of ['rgb_lib_db', 'bdk_db_watch_only', 'rgb/state.dat', 'rgb/stash.dat', 'rgb/index.dat']) file(join(native, name))
  }
}
