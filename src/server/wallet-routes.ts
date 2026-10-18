// The wallet panel's HTTP surface on the user's own Passbook node.
//
// The page (/wallet) and the network badge (/wallet/api/network) are public:
// they hold no secrets. Everything else is `operator`: the browser signs each
// request with the session from the operator link (web/session-auth.js), the
// same HMAC the dashboard uses; agents and other keys get 403. Nothing here is
// a platform service: it is the user's node, run by the user, for the user.

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import type { NetworkProfile } from '../core/network.js'
import type { WalletPanel } from '../wallet/panel.js'
import { WalletError } from '../wallet/panel.js'
import { HttpError, type Api } from './api.js'

const FILES: Record<string, [string, string]> = {
  '/wallet': ['wallet.html', 'text/html; charset=utf-8'],
  '/wallet.js': ['wallet.js', 'text/javascript; charset=utf-8'],
  '/wallet-strings.js': ['wallet-strings.js', 'text/javascript; charset=utf-8'],
  '/wallet.css': ['wallet.css', 'text/css; charset=utf-8'],
}

/** Exact versions of the wallet modules this node runs, read from the installed packages. */
export function walletModuleVersions(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['@tetherto/wdk', '@tetherto/wdk-wallet-btc', '@utexo/wdk-wallet-rgb', '@utexo/rgb-sdk', '@utexo/rgb-lib']) {
    try {
      out[name] = (JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as { version: string }).version
    } catch {
      out[name] = 'not installed'
    }
  }
  return out
}

function num(v: unknown, name: string): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new HttpError(400, `${name} must be a whole number`)
  return n
}

function text(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${name} required`)
  return v
}

/** Mount the panel's routes. `panel` null means this node runs no wallet panel: the page says so, with the badge. */
export function mountWalletRoutes(api: Api, profile: NetworkProfile, panel: WalletPanel | null): void {
  for (const [route, [file, type]] of Object.entries(FILES)) {
    api.on('GET', route, async ({ res }) => {
      const body = await readFile(new URL(`../../web/${file}`, import.meta.url))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    })
  }

  const labels = () => ({ name: profile.name, label: profile.label, coin: profile.coinLabel, asset: profile.assetLabel, public: profile.public, explorer: profile.explorer ?? null })
  // the badge every screen shows; public, no secrets
  api.on('GET', '/wallet/api/network', () => ({ network: labels(), wallet_panel: !!panel }))
  api.on('GET', '/wallet/api/about', () => ({
    network: labels(),
    what: 'The web wallet is the screen over YOUR OWN Passbook node. It talks only to this node, through its signed API; the node holds your encrypted seed and signs. The Passbook platform never holds your keys.',
    endpoints: { esplora: profile.endpoints.esplora ?? null, bitcoin_rpc: profile.endpoints.bitcoin_rpc ? 'configured (local)' : null, rgb_indexer: profile.endpoints.rgb_indexer, rgb_proxy: profile.endpoints.rgb_proxy, nostr: profile.endpoints.nostr },
    modules: walletModuleVersions(),
    wallet_panel: !!panel,
    gate: panel?.gate ? { name: panel.gate.name, adapter: panel.gate.adapter } : null,
  }))

  const p = (): WalletPanel => {
    if (!panel) throw new HttpError(404, 'this node runs no wallet panel')
    return panel
  }
  const wrap = <T>(fn: () => Promise<T> | T) => async () => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof WalletError) throw new HttpError(err.status, err.message, err.detail)
      throw err
    }
  }

  api.on('GET', '/wallet/api/status', () => panel ? panel.status() : { network: labels(), has_wallet: false, unlocked: false, disabled: true }, 'operator')
  api.on('POST', '/wallet/api/create', async ({ body }) => wrap(async () => p().create(text((await body()).passphrase, 'passphrase')))(), 'operator')
  api.on('POST', '/wallet/api/restore', async ({ body }) => wrap(async () => {
    const b = await body()
    await p().restore(text(b.words, 'words'), text(b.passphrase, 'passphrase'))
    return p().status()
  })(), 'operator')
  api.on('POST', '/wallet/api/unlock', async ({ body }) => wrap(async () => { await p().unlock(text((await body()).passphrase, 'passphrase')); return p().status() })(), 'operator')
  api.on('POST', '/wallet/api/lock', () => { p().lock(); return p().status() }, 'operator')
  api.on('POST', '/wallet/api/backup/challenge', () => wrap(() => p().backupChallenge())(), 'operator')
  api.on('POST', '/wallet/api/backup/verify', async ({ body }) => wrap(async () => {
    const b = await body()
    const answers = b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? (b.answers as Record<string, string>) : {}
    return p().backupVerify(text(b.passphrase, 'passphrase'), answers)
  })(), 'operator')
  api.on('GET', '/wallet/api/balances', () => wrap(() => p().balances())(), 'operator')
  api.on('GET', '/wallet/api/receive/btc', () => wrap(() => p().receiveBtc())(), 'operator')
  api.on('POST', '/wallet/api/receive/rgb', async ({ body }) => wrap(async () => {
    const b = await body()
    return p().receiveRgb(b.amount_micro === undefined || b.amount_micro === '' ? undefined : num(b.amount_micro, 'amount_micro'))
  })(), 'operator')
  api.on('POST', '/wallet/api/send/preview', async ({ body }) => wrap(async () => {
    const b = await body()
    const kind = b.kind === 'btc' || b.kind === 'rgb' ? b.kind : (() => { throw new HttpError(400, 'kind must be btc or rgb') })()
    return p().previewSend({ kind, to: text(b.to, 'to'), amount: num(b.amount, 'amount') })
  })(), 'operator')
  api.on('POST', '/wallet/api/send/confirm', async ({ body }) => wrap(async () => {
    const b = await body()
    return p().confirmSend(text(b.preview_id, 'preview_id'), b.confirm === true)
  })(), 'operator')
  api.on('POST', '/wallet/api/prepare-rgb', async ({ body }) => wrap(async () => p().prepareRgb((await body()).confirm === true))(), 'operator')
  api.on('GET', '/wallet/api/history', () => wrap(() => p().history())(), 'operator')
  api.on('GET', '/wallet/api/ready-to-borrow', () => wrap(() => { p().assertReadyToBorrow(); return { ready: true } })(), 'operator')
}
