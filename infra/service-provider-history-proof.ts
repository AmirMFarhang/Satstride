// The trusted history observer's signed proof for a seeded persona, written to a file the borrower then
// carries in its bundle (docs/SERVICE-PROVIDER.md). Platform side: it signs with the platform key, which
// observed the persona's wallet from zero while infra/seed.ts --personas seeded it. REGTEST SHORTCUT, as in
// src/cli/demo.ts: to take the observer's watch-only backup this helper opens the seeded persona wallet,
// before and apart from the borrower's own process (which holds only its key and gets the signed proof).
//
//   npx tsx infra/service-provider-history-proof.ts --persona fatima --out <file>

import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { BitcoindChain } from '../src/chain/bitcoind.js'
import { historyObserverDir, RgbHistoryObserver } from '../src/rgb/history-observer.js'
import { openParty } from '../src/wallet/party.js'
import { loadPlatformKey } from '../src/wallet/platform-key.js'
import { readState } from '../src/wallet/state.js'

const { values: a } = parseArgs({ options: { persona: { type: 'string' }, out: { type: 'string' } } })
if (a.persona !== 'fatima' && a.persona !== 'walter') throw new Error('--persona fatima|walter')
const state = readState()
if (!state.personas) throw new Error('no personas: seed with infra/seed.ts --fresh --personas')
const signer = loadPlatformKey()
if (!signer || signer.pubkey !== state.platform_pk) throw new Error('the history observer signs with the platform key')
const observer = new RgbHistoryObserver({ rootDir: historyObserverDir(), signer, chain: BitcoindChain.fromEnv() })
const party = await openParty(a.persona)
try {
  // Reattach to the signed journal the observer kept since the persona's wallet was empty (as src/cli/demo.ts does).
  observer.attachWallet(party.key.pubkey, party.rgb)
  const proof = await observer.proof(party.key.pubkey)
  writeFileSync(a.out!, `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify({ persona: a.persona, borrower_pk: party.key.pubkey, observer_pk: signer.pubkey, out: a.out }))
} finally {
  observer.close()
  party.close()
}
