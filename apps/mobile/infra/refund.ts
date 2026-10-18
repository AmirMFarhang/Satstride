// Laptop side only (M6 walk): the laptop's seeded borrower takes its collateral back through
// escrow leaf C with the platform when a lender never paid out (FUND_TIMEOUT_BLOCKS after the
// lock; the platform checks it). Needed when the borrower peer gave up waiting for a payout:
// its saved passbook then holds an open page and the peer refuses to borrow again.
//   npx tsx apps/mobile/infra/refund.ts <loan_id>     (with eval "$(apps/mobile/infra/provider.sh env)")
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { termsHash } from '../../../src/core/terms.ts'
import { buildEscrowSpend, extractHex, finalizeEscrowSpend, partiesOf, psbtFromBase64, releaseOutputs, signLeaf, unsignedTxid } from '../../../src/escrow/escrow.ts'
import { FUND_TIMEOUT_BLOCKS } from '../../../src/registry/ladder.ts'
import { signPassbook, type PassbookDocument } from '../../../src/registry/passbook-doc.ts'
import { PlatformClient } from '../../../src/agents/platform-client.ts'
import { openParty } from '../../../src/wallet/party.ts'

const RPC = process.env.BITCOIND_URL ?? 'http://127.0.0.1:18603'
async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const r = await fetch(wallet ? `${RPC}/wallet/${wallet}` : RPC, { method: 'POST', headers: { authorization: `Basic ${Buffer.from('user:password').toString('base64')}` }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) })
  const j = (await r.json()) as { result: T; error: { message: string } | null }
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

void (async () => {
  const loanId = process.argv[2]
  if (!/^[0-9a-f]{64}$/.test(loanId ?? '')) throw new Error('usage: refund.ts <loan_id>')
  const party = await openParty('borrower')
  try {
    const file = join(dirname(party.rgb.dataDir), 'passbook.json')
    const doc = JSON.parse(readFileSync(file, 'utf8')) as PassbookDocument
    const page = doc.pages.find((p) => termsHash(p.terms) === loanId)
    if (!page) throw new Error('no page for that loan in the borrower\'s passbook')
    if (page.outcome) throw new Error(`that page is already closed (${page.outcome})`)
    const platform = new PlatformClient(process.env.PASSBOOK_URL).as(party.key)
    const record = await platform.loan(loanId)
    if (record.status !== 'locked') throw new Error(`the platform has the loan as ${record.status}; a refund is only for a locked, never funded loan`)
    const due = (record.locked_height ?? 0) + FUND_TIMEOUT_BLOCKS
    const height = await rpc<number>('getblockcount')
    if (height < due) {
      // regtest: the laptop's miner moves the chain past the funding window
      const a = await rpc<string>('getnewaddress', [], 'miner')
      await rpc('generatetoaddress', [due - height, a], 'miner')
      console.log(`mined ${due - height} block(s) to height ${due}: the funding window has passed`)
    }
    const t = page.terms
    const parties = partiesOf(t)
    const psbt = buildEscrowSpend({ escrow: { txid: page.lock_txid, vout: page.lock_vout, value: t.collateral_sats }, parties, leaf: 'C', outputs: releaseOutputs(t) })
    const decision = await platform.cosign({ loan_id: loanId, purpose: 'refund', psbt: psbt.toBase64() })
    if (!decision.ok || !decision.psbt) throw new Error(`the platform refused the refund: ${decision.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`)
    const signed = psbtFromBase64(decision.psbt)
    if (unsignedTxid(signed) !== unsignedTxid(psbt)) throw new Error('the platform returned another transaction')
    signLeaf(signed, parties, 'C', party.key.secretKey)
    finalizeEscrowSpend(signed, parties, 'C')
    const txid = await rpc<string>('sendrawtransaction', [extractHex(signed)])
    await rpc('generatetoaddress', [1, await rpc<string>('getnewaddress', [], 'miner')], 'miner')
    await platform.settle(loanId, txid, 'refunded')
    const pages = doc.pages.map((p) => (termsHash(p.terms) === loanId ? { ...p, outcome: 'refunded' as const, outcome_txid: txid } : p))
    writeFileSync(file, `${JSON.stringify(signPassbook(party.key, pages), null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ event: 'refunded', loan_id: loanId, refund_txid: txid }))
  } finally { party.close() }
})().catch((e) => { console.error(`refund failed: ${(e as Error).message}`); process.exit(1) })
