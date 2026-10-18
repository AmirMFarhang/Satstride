// Dashboard panel "Check nodes" (Add-on 5, docs/CHECK-MARKET.md). Self-contained:
// mounted by the demo next to its other /demo routes. Read-only: it shows the
// running check nodes' public status (PASSBOOK_CHECK_NODE_STATUS, comma-separated
// status URLs) and the last recorded market run (data/check-market/last-run.json):
// operator key, release hash, the derived execution tier, price, accepted
// assets, bond status, and which node was picked and why. No outputs, no
// personal data: the status endpoints and the record carry hashes only.

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Api } from './api.js'

export const DEFAULT_RECORD = join(process.cwd(), 'data', 'check-market', 'last-run.json')
/** The committed evidence of the regtest run; shown, labelled as recorded, when no local run exists. */
export const RECORDED_EVIDENCE = new URL('../../docs/CHECK-MARKET-REGTEST.json', import.meta.url)

export function mountCheckNodesPanel(api: Api, deps: { statusUrls?: string[]; recordPath?: string } = {}): void {
  const urls = deps.statusUrls ?? (process.env.PASSBOOK_CHECK_NODE_STATUS ?? '').split(',').map((s) => s.trim()).filter((s) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/status$/.test(s))
  const recordPath = deps.recordPath ?? process.env.PASSBOOK_CHECK_MARKET_RECORD ?? DEFAULT_RECORD

  api.on('GET', '/demo/checknodes.js', async ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(await readFile(new URL('../../web/checknodes.js', import.meta.url)))
  })

  api.on('GET', '/demo/checknodes', async () => {
    const live = await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
        return res.ok ? { url, status: await res.json() } : { url, error: `HTTP ${res.status}` }
      } catch (err) {
        return { url, error: (err as Error).message.slice(0, 120) }
      }
    }))
    let record: unknown = null
    let source: 'local-run' | 'recorded-evidence' | null = null
    for (const [path, kind] of [[recordPath, 'local-run'], [RECORDED_EVIDENCE, 'recorded-evidence']] as const) {
      if (record || !existsSync(path)) continue
      try { record = JSON.parse(readFileSync(path, 'utf8')); source = kind } catch { record = null }
    }
    return { live, record, record_source: source, platform_cut: 0 }
  })
}
