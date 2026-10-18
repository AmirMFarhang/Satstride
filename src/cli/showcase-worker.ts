// The writer owns a separate process lock before opening native wallets or
// touching money. Killing its supervisor cannot authorize another live writer.
import { DemoSessions } from './demo-sessions.js'
import { ensureShowcaseFunds } from './showcase-bootstrap.js'
import { Regtest } from '../chain/regtest.js'

const kind = process.argv.splice(2, 1)[0]
if (kind !== 'seed' && kind !== 'demo') throw new Error('Unknown showcase worker')
const directory = process.env.PASSBOOK_DEMO_WRITER_LOCK
if (!directory) throw new Error('Showcase writer lock is required')
const lease = new DemoSessions(directory)
lease.acquireLock()
process.once('exit', () => lease.releaseLock())
if (kind === 'seed') {
  const funding = await ensureShowcaseFunds(new Regtest())
  console.log(`Showcase miner ready (${funding.balanceBtc} BTC; ${funding.minedBlocks} bootstrap blocks).`)
  await import('../../infra/seed.js')
} else await import('./demo.js')
