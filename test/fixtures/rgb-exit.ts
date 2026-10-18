// Child process for test/rgb-native-exit.test.ts. Opens an RGB wallet offline,
// lets its native handles age into V8's old generation, closes it, and on exit
// allocates enough to start an incremental marking cycle, so node tears the
// isolate down mid-cycle with the closed wallet's handles still to finalize.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WalletManager from '@tetherto/wdk-wallet'
import { RgbWallet } from '../../src/rgb/wallet.js'

const dir = mkdtempSync(join(tmpdir(), 'passbook-rgb-exit-'))
const wallet = await RgbWallet.open(WalletManager.getRandomSeedPhrase(), join(dir, 'rgb'))
for (let i = 0; i < 50; i++) wallet.knowsAsset('none')
for (let round = 0; round < 20; round++) Array.from({ length: 100_000 }, (_, i) => ({ i }))
wallet.close()
rmSync(dir, { recursive: true, force: true })

const kept: unknown[] = []
process.on('exit', () => {
  for (let i = 0; i < Number(process.env.EXIT_ALLOCATION ?? 150_000); i++) kept.push({ i, s: `retained-${i}` })
})
