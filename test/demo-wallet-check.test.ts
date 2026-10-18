// Public deterministic mnemonic + fake marker files only. Key derivation is
// real; native-wallet opening and network access must never occur here.
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, mock } from 'node:test'
import { assertDemoWallets } from '../src/cli/demo-wallet-check.js'
import { keyPathOutput } from '../src/escrow/escrow.js'
import { RgbWallet } from '../src/rgb/wallet.js'
import { watchKeys } from '../src/rgb/watch.js'
import { partyKey, ROLES, type WalletRole } from '../src/wallet/party.js'
import type { PartyState, SeedState } from '../src/wallet/state.js'

const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const otherSeed = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const files = ['rgb_lib_db', 'bdk_db_watch_only', 'rgb/state.dat', 'rgb/stash.dat', 'rgb/index.dat']
function party(mnemonic = seed): PartyState { const key = partyKey(mnemonic); return { pubkey: key.pubkey, btc_address: keyPathOutput(key.pubkey).address, rgb_address: 'synthetic-unit-address' } }
function state(): SeedState {
  return { v: 1, created_at: '2026-10-17T00:00:00Z', network: 'regtest', asset: { id: 'rgb:unit-marker-only', ticker: 'UNIT', name: 'Synthetic fixture', precision: 6, supply: 1, issuer: 'payer' }, platform_pk: '12'.repeat(32), parties: Object.fromEntries(ROLES.map((role) => [role, party()])) as SeedState['parties'], funding_txids: [], lender_funding: [], borrower_inflows: [], seeded_height: 0, personas: { fatima: { party: party(), inflows: [], seeded_height: 0 }, walter: { party: party(), inflows: [], seeded_height: 0 }, off_history: [] } }
}
function tree(dir: string): unknown {
  return readdirSync(dir).sort().map((name) => { const path = join(dir, name), stat = lstatSync(path); return [name, stat.isSymbolicLink() ? { symlink: readlinkSync(path) } : stat.isDirectory() ? tree(path) : readFileSync(path).toString('base64')] })
}
async function fixture(roles: WalletRole[] = ['borrower']) {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-wallet-preflight-')), fingerprint = (await watchKeys(seed)).master_fingerprint
  for (const role of roles) {
    const base = join(dir, role)
    mkdirSync(base); writeFileSync(join(base, 'seed'), seed + '\n', { mode: 0o600 })
    for (const file of files) { const path = join(base, 'rgb', fingerprint, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `synthetic native-file marker: ${role}/${file}`, { mode: 0o600 }) }
  }
  return { dir, state: state(), native: (role = 'borrower') => join(dir, role, 'rgb', fingerprint), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('existing demo wallet preflight', () => {
  it('checks every requested party/persona using real key derivation without opening wallets, contacting services or changing bytes', async () => {
    const roles: WalletRole[] = ['borrower', 'lender1', 'lender2', 'payer', 'fatima', 'walter'], f = await fixture(roles)
    const open = mock.method(RgbWallet, 'open', async () => { throw new Error('wallet must not open') }), network = mock.method(globalThis, 'fetch', async () => { throw new Error('network must not run') })
    try {
      const before = tree(f.dir)
      await assertDemoWallets(f.state, roles, f.dir)
      assert.deepEqual(tree(f.dir), before); assert.equal(open.mock.callCount(), 0); assert.equal(network.mock.callCount(), 0)
    } finally { open.mock.restore(); network.mock.restore(); f.dispose() }
  })
  it('refuses missing or wrong seeds, mismatched public keys and mismatched collateral addresses without writes', async () => {
    const f = await fixture()
    try {
      const file = join(f.dir, 'borrower', 'seed')
      for (const attack of ['missing', 'empty', 'wrong', 'pubkey', 'address'] as const) {
        const current = structuredClone(f.state)
        writeFileSync(file, seed + '\n')
        if (attack === 'missing') rmSync(file)
        if (attack === 'empty') writeFileSync(file, '')
        if (attack === 'wrong') writeFileSync(file, otherSeed + '\n')
        if (attack === 'pubkey') current.parties.borrower.pubkey = party(otherSeed).pubkey
        if (attack === 'address') current.parties.borrower.btc_address = party(otherSeed).btc_address
        const before = tree(f.dir)
        await assert.rejects(assertDemoWallets(current, ['borrower'], f.dir), /Existing|match/)
        assert.deepEqual(tree(f.dir), before)
      }
    } finally { f.dispose() }
  })
  it('refuses unknown/unregistered roles, absent persona identities and unsupported seeded state', async () => {
    const f = await fixture(['borrower', 'fatima'])
    try {
      const before = tree(f.dir)
      for (const role of ['../borrower', 'client1', 'platform', 'off_history', '__proto__']) await assert.rejects(assertDemoWallets(f.state, [role as WalletRole], f.dir), /seeded identity/)
      const missing = structuredClone(f.state); delete missing.personas
      await assert.rejects(assertDemoWallets(missing, ['fatima'], f.dir), /seeded identity/)
      await assert.rejects(assertDemoWallets({ ...f.state, network: 'mainnet' } as unknown as SeedState, ['borrower'], f.dir), /Invalid seeded/)
      assert.deepEqual(tree(f.dir), before)
    } finally { f.dispose() }
  })
  it('requires every native file to be existing and nonempty and never manufactures a replacement', async () => {
    const f = await fixture(), open = mock.method(RgbWallet, 'open', async () => { throw new Error('wallet must not open') })
    try {
      for (const name of files) {
        const file = join(f.native(), name), original = readFileSync(file)
        for (const empty of [false, true]) {
          if (empty) writeFileSync(file, ''); else rmSync(file)
          const before = tree(f.dir)
          await assert.rejects(assertDemoWallets(f.state, ['borrower'], f.dir), /Existing/)
          assert.deepEqual(tree(f.dir), before)
          writeFileSync(file, original)
        }
      }
      rmSync(join(f.dir, 'borrower', 'rgb'), { recursive: true })
      const before = tree(f.dir)
      await assert.rejects(assertDemoWallets(f.state, ['borrower'], f.dir), /Existing/)
      assert.deepEqual(tree(f.dir), before); assert.equal(open.mock.callCount(), 0)
    } finally { open.mock.restore(); f.dispose() }
  })
  it('rejects symlinked seeds, files, directories and configured roots even when their targets are valid', async () => {
    const f = await fixture(), other = await fixture()
    try {
      const seedFile = join(f.dir, 'borrower', 'seed')
      rmSync(seedFile); symlinkSync(join(other.dir, 'borrower', 'seed'), seedFile)
      await assert.rejects(assertDemoWallets(f.state, ['borrower'], f.dir), /symlinks/)
      rmSync(seedFile); writeFileSync(seedFile, seed + '\n')
      const nativeFile = join(f.native(), files[0]); rmSync(nativeFile); symlinkSync(join(other.native(), files[0]), nativeFile)
      await assert.rejects(assertDemoWallets(f.state, ['borrower'], f.dir), /symlinks/)
      rmSync(nativeFile); writeFileSync(nativeFile, 'synthetic marker')
      const nativeRgb = join(f.native(), 'rgb'); rmSync(nativeRgb, { recursive: true }); symlinkSync(join(other.native(), 'rgb'), nativeRgb)
      await assert.rejects(assertDemoWallets(f.state, ['borrower'], f.dir), /symlinks/)
      const link = join(f.dir, 'linked-wallets'); symlinkSync(other.dir, link)
      await assert.rejects(assertDemoWallets(other.state, ['borrower'], link), /symlinks/)
      assert.equal(readFileSync(join(other.native(), files[0]), 'utf8'), 'synthetic native-file marker: borrower/rgb_lib_db')
    } finally { f.dispose(); other.dispose() }
  })
})
