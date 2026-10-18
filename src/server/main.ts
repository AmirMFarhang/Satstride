// Platform server entrypoint.
//   npm run server                      fake chain, rules engine, in-process sandbox
//   PASSBOOK_CHAIN=bitcoind BITCOIND_URL=http://127.0.0.1:18443 SANDBOX_URL=http://127.0.0.1:4180 PASSBOOK_AI=qvac npm run server

import { describeConfig } from '../core/config.js'
import { configFromEnv, createApp, feeWalletFromEnv, repaymentWatchFromEnv } from './app.js'
import { authFromEnv, newDashboardSession, parseDashboardSession, sessionToken } from './auth.js'
import { probeNetwork } from '../core/network.js'
import { startNostrApiFromEnv } from './nostr-api.js'

const cfg = configFromEnv()
// Before serving: every chain endpoint must serve the profile's network (src/core/network.ts); a mixed network refuses to start.
if (cfg.deployment && (cfg.deployment.network.public || cfg.chain.kind !== 'fake')) {
  try {
    for (const row of await probeNetwork(cfg.deployment.network)) console.log(`network ${cfg.deployment.network.label}: ${row.endpoint} ${row.url} ${row.saw}`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
// Writes must be signed: agents with their party keys, the dashboard with this operator session.
const dashboardSession = process.env.PASSBOOK_DASHBOARD_SESSION ? parseDashboardSession(process.env.PASSBOOK_DASHBOARD_SESSION) : newDashboardSession()
cfg.auth = authFromEnv(cfg.platformKey.pubkey, process.env, [dashboardSession])
// on bitcoind the platform validates RGB repayments with its own watch-only wallets,
// and invoices lenders' platform fees from its own RGB wallet
// a public test network (Mutinynet) has no bitcoind of ours, but the platform still watches repayments and invoices fees over RGB
if (cfg.chain.kind === 'bitcoind' || cfg.deployment?.network.public) {
  cfg.repayments = await repaymentWatchFromEnv()
  cfg.feeWallet = await feeWalletFromEnv(cfg.platformKey)
}
const app = createApp(cfg)
const port = Number(process.env.PORT ?? 4170)
const host = process.env.HOST ?? '127.0.0.1'
const bound = await app.api.listen(port, host)
console.log(
  `passbook platform on http://${host}:${bound}  chain=${cfg.chain.kind} ai=${cfg.reasoner?.engine ?? 'rules'} sandbox=${cfg.sandbox ? 'remote' : 'in-process'} platform_pk=${cfg.platformKey.pubkey.slice(0, 12)}…`,
)
console.log(`dashboard (operator link, keep it private): http://${host}:${bound}/#session=${sessionToken(dashboardSession)}`)
// PASSBOOK_PLATFORM_RELAYS: the same API, party routes only, over Nostr (src/server/nostr-api.ts)
await startNostrApiFromEnv(app.api, cfg.platformKey, process.env, cfg.deployment?.network.name)
console.log(cfg.deployment ? `deployment ${cfg.deployment.source}: ${describeConfig(cfg.deployment)}; api auth ${cfg.auth?.mode ?? 'off'}` : `no passbook.config.yaml: built-in demo defaults; api auth ${cfg.auth?.mode ?? 'off'}`)

const interval = setInterval(() => void app.platform.monitor().catch((err) => console.error('monitor:', (err as Error).message)), Number(process.env.MONITOR_MS ?? 15_000))
interval.unref()

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(interval)
    void app.close().then(() => process.exit(0))
  })
}
