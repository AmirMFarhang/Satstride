// REGTEST TEST DATA ONLY. The seeded test persona's package for the phone (option A of the M7
// acceptance, chosen by the user): the persona's words, an rgb-lib backup of its wallet, the income
// records it was seeded with, and the trusted history observer's proof exactly as the observer
// issued it (infra/service-provider-history-proof.ts; never re-signed or edited here). The phone
// labels everything it shows from this as a seeded test persona. Opening the wallet to back it up
// does not transact: the persona must not move before its check.
//
//   npx tsx apps/mobile/infra/persona-package.ts --persona fatima --proof <proof.json> --out <package.json>
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { randomHex, verifyObject } from '../../../src/core/crypto.js'
import { RgbWallet } from '../../../src/rgb/wallet.js'
import { readState } from '../../../src/wallet/state.js'

const { values: a } = parseArgs({ options: { persona: { type: 'string' }, proof: { type: 'string' }, out: { type: 'string' } } })
const persona = a.persona as 'fatima' | 'walter'
if (persona !== 'fatima' && persona !== 'walter') throw new Error('--persona fatima|walter')
if (!a.proof || !a.out) throw new Error('--proof <file> --out <file>')
if (!/regtest/i.test(process.env.RGB_NETWORK ?? 'regtest')) throw new Error('regtest only')

async function main() {
  const state = readState()
  if (state.network !== 'regtest') throw new Error('regtest only')
  const seeded = state.personas?.[persona]
  if (!seeded) throw new Error(`no seeded persona ${persona}: up the provider with infra/seed.ts --fresh --personas`)
  const proof = JSON.parse(readFileSync(a.proof!, 'utf8')) as { observer_pk: string; borrower_pk: string; asset_id: string; observed_from_zero: boolean; sig: string }
  // the proof as issued: signed by the platform key that observed the persona from zero
  if (proof.observer_pk !== state.platform_pk || !verifyObject(proof as never, proof.observer_pk as never)) throw new Error('the history proof is not signed by this provider\'s observer')
  if (proof.asset_id !== state.asset.id || !proof.observed_from_zero) throw new Error('the history proof is not about this asset from zero')
  const wallets = process.env.PASSBOOK_WALLETS!
  const words = readFileSync(join(wallets, persona, 'seed'), 'utf8').trim()
  const rgbDir = join(wallets, persona, 'rgb')
  const fingerprint = readdirSync(rgbDir).find((d) => /^[0-9a-f]{8}$/.test(d))
  if (!fingerprint) throw new Error(`no rgb-lib wallet under ${rgbDir}`)
  const wallet = await RgbWallet.open(words, rgbDir, { network: 'regtest', indexerUrl: process.env.RGB_INDEXER_URL!, transportEndpoint: process.env.RGB_TRANSPORT_URL! } as never)
  const tmp = mkdtempSync(join(tmpdir(), 'passbook-persona-'))
  try {
    const password = randomHex(16)
    const backupPath = (wallet as unknown as { createWatchBackup(p: string, pw: string): string }).createWatchBackup(tmp, password)
    const pkg = {
      v: 1,
      kind: 'passbook-test-persona',
      label: 'Seeded regtest test persona (test data, not a real person)',
      network: 'regtest',
      persona,
      words,
      rgb_fingerprint: fingerprint,
      rgb_backup_b64: readFileSync(backupPath).toString('base64'),
      rgb_backup_password: password,
      asset_id: state.asset.id,
      observer_pk: state.platform_pk,
      inflows: seeded.inflows,
      history_proof: proof,
      issued_at: Math.floor(Date.now() / 1000),
    }
    writeFileSync(a.out!, `${JSON.stringify(pkg)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ persona, borrower_pk: proof.borrower_pk, fingerprint, inflows: seeded.inflows.length, transfers: (proof as unknown as { transfers: unknown[] }).transfers.length, out: a.out }))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    ;(wallet as unknown as { close?: () => void }).close?.()
  }
}
main().then(() => process.exit(0), (e) => { console.error((e as Error).message); process.exit(1) })
