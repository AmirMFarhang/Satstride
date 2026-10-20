// Idempotent provider keys and local scorer configuration. No payment-node funding or channels.
// Existing wallet and retired-node state is preserved.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bytesToHex, keyPairFromLabel, randomKeyPair, type Hex } from '../src/core/crypto.js'
import { providerConfig } from '../src/checknode/provider.js'
import { readState } from '../src/wallet/state.js'

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set (run through infra/service-provider.sh)`); return v }
const STATE = resolve(env('PASSBOOK_SP_STATE'))

function secretFile(name: string, make: () => Uint8Array, label: string): string {
  const dir = join(STATE, 'keys')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${name}.secret`)
  if (!existsSync(file)) {
    writeFileSync(file, `${bytesToHex(make())}\n`, { mode: 0o600 })
    writeFileSync(join(dir, `${name}.label`), `${label}\n`)
  }
  chmodSync(file, 0o600)
  return file
}

async function main() {
  const operatorFile = secretFile('operator', () => randomKeyPair().secretKey, 'check node operator key (fresh, kept on this laptop; regtest)')
  const chainCheckFile = secretFile('chain-check', () => keyPairFromLabel('passbook-chain-observer').secretKey, 'passbook-chain-observer: publicly derivable DEMO observation key (regtest only)')
  const state = readState()
  const assetId = state.asset.id
  const config = join(STATE, 'scorer.config.yaml')
  writeFileSync(config, providerConfig({ approvedBuilds: resolve('infra/scorer-releases.json'), seedState: resolve(process.env.PASSBOOK_STATE ?? join(STATE, 'state.json')) }))
  const out = { v: 1, asset_id: assetId, check_rail: 'bill-at-close', operator_secret_file: operatorFile, chain_check_secret_file: chainCheckFile, scorer_config: config, lender_pk: state.parties.lender1.pubkey as Hex }
  writeFileSync(join(STATE, 'provider-setup.json'), `${JSON.stringify(out, null, 2)}\n`)
  console.log(JSON.stringify(out))
}

main().catch((err) => { console.error(`service-provider setup: ${(err as Error).message}`); process.exit(1) })
