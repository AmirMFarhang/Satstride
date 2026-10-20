// Local provider startup validates configuration and billing before serving.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/core/config.js'
import { providerConfig, runProvideCli } from '../src/checknode/provider.js'

const ARGS = ['check-node', 'provide', '--name', 't', '--price', '0.5', '--bill-at-close', '--asset', 'rgb:test', '--status-port', '4999']

async function withConfig<T>(yaml: string | null, run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'passbook-provide-'))
  const before = process.env.PASSBOOK_CONFIG
  const billingBefore = [process.env.PASSBOOK_CHECK_BILLS, process.env.PASSBOOK_URL]
  process.env.PASSBOOK_CHECK_BILLS = join(dir, 'bills.jsonl')
  process.env.PASSBOOK_URL = 'http://127.0.0.1:9'
  const errors: string[] = []
  const err = console.error
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
  try {
    if (yaml !== null) { writeFileSync(join(dir, 'c.yaml'), yaml); process.env.PASSBOOK_CONFIG = join(dir, 'c.yaml') } else process.env.PASSBOOK_CONFIG = join(dir, 'missing-but-unset.yaml')
    return await run()
  } finally {
    console.error = err
    if (billingBefore[0] === undefined) delete process.env.PASSBOOK_CHECK_BILLS; else process.env.PASSBOOK_CHECK_BILLS = billingBefore[0]
    if (billingBefore[1] === undefined) delete process.env.PASSBOOK_URL; else process.env.PASSBOOK_URL = billingBefore[1]
    if (before === undefined) delete process.env.PASSBOOK_CONFIG; else process.env.PASSBOOK_CONFIG = before
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('check node provider mode', () => {
  it('refuses usage errors with 2', async () => {
    assert.equal(await withConfig('scorer:\n  provider: in-process\n', () => runProvideCli(['check-node', 'provide'])), 2)
    assert.equal(await runProvideCli([...ARGS, '--ln', 'http://127.0.0.1:9']), 2)
    assert.equal(await withConfig('scorer:\n  provider: in-process\n', () => runProvideCli([...ARGS, '--payer-modes', 'platform'])), 2)
  })

  it('exits 3 without a valid billing configuration', async () => {
    assert.equal(await withConfig('scorer:\n  provider: in-process\n', () => runProvideCli(ARGS)), 3, 'an invalid config is refused too')
  })

  it('exits 3 without billing services; the generated local config is valid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passbook-provide-cfg-'))
    try {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ asset: { id: 'rgb:test' } }))
      const yaml = providerConfig({ approvedBuilds: join(process.cwd(), 'infra/scorer-releases.json'), seedState: join(dir, 'state.json') })
      writeFileSync(join(dir, 'c.yaml'), yaml)
      const cfg = loadConfig(join(dir, 'c.yaml'), { checkFiles: true })
      assert.equal(cfg.scorer.provider, 'in-process')
      assert.equal(cfg.scorer.fallback, 'none')
      assert.deepEqual(cfg.settlement.enabled, ['cosign-rgb'])
      assert.equal(cfg.scorer.min_trust_for_lenders, 'dev-inprocess')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--bill-at-close needs the bill ledger and the platform, and a lender payer', async () => {
    const BILL = ['check-node', 'provide', '--name', 't', '--price', '0.5', '--asset', 'rgb:test', '--status-port', '4999', '--bill-at-close']
    const before = { ...process.env }
    try {
      delete process.env.PASSBOOK_CHECK_BILLS
      process.env.PASSBOOK_URL = 'http://127.0.0.1:9'
      assert.equal(await withConfig(null, () => runProvideCli([...BILL, '--payer-modes', 'borrower'])), 2, 'billing is the lender\'s')
      process.env.PASSBOOK_CONFIG = join(process.cwd(), 'passbook.config.yaml')
      assert.equal(await runProvideCli(BILL), 3, 'no PASSBOOK_CHECK_BILLS: BILL_NO_LEDGER')
    } finally {
      for (const k of ['PASSBOOK_CHECK_BILLS', 'PASSBOOK_URL', 'PASSBOOK_CONFIG']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k] }
    }
  })
})
