// passbook agent check --layers rgb,btc,ln --history-chain bitcoin --window 365d --for <lender_pk>
//
// The credit agent on the borrower's device, with the lender's checks run
// beside it. First run with --address: prints the BIP-322 challenge for the
// person to sign in their OWN wallet and exits 3. Second run with
// --negotiation <id> --signature <sig>: verifies, reads the shared layers,
// lets the lender recompute the on-chain rows from its own source, and prints
// the outcome. Proofs only: no option takes a key or a seed.
//
// passbook agent snapshot --address <addr> [--out <file>]
// records public chain data for the address from the live source, for offline use.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { deploymentConfigFromEnv, DEFAULT_CREDIT, type CreditConfig, type PassbookConfig } from '../core/config.js'
import { DEFAULT_ECONOMICS } from '../core/economics.js'
import { isHex, type Hex, type KeyPair } from '../core/crypto.js'
import { ChallengeBook, describeOutcome, runAgentCheck, standaloneNegotiationId, type AgentCheckResult } from '../networks/agent-check.js'
import { recordSnapshot, saveSnapshot } from '../networks/bitcoin-source.js'
import { loanChainFromEnv, refuseSecret } from '../networks/guard.js'
import { LightningAdapter, MempoolLightningFacts, RlnNodeApi } from '../networks/lightning.js'
import { DEFAULT_LENDER_LAYER_POLICY, layerPolicyProblems, type LenderLayerPolicy } from '../networks/policy.js'
import { RgbAdapter, rgbHistoryRows, type RgbRowLabel } from '../networks/rgb.js'
import { availableSanctionsScreen } from '../compliance/sanctions.js'
import { creditSources, sourceFor } from '../networks/setup.js'
import { isChainId, type ChainId, type LayerId } from '../networks/types.js'

const LAYER_ALIASES: Record<string, LayerId> = { rgb: 'rgb', btc: 'btc-onchain', 'btc-onchain': 'btc-onchain', ln: 'lightning', lightning: 'lightning' }

export const AGENT_USAGE = `Usage:
  passbook agent check --layers rgb,btc,ln --history-chain bitcoin --window 365d --for <lender_pk>
        [--address <bc1...>] [--negotiation <id>] [--signature <BIP-322 signature>] [--signature-file <file>]
        [--ln-url <RGB Lightning Node URL>] [--rgb-role borrower] [--offline] [--json]
  passbook agent snapshot --address <bc1...> [--history-chain bitcoin] [--out <file>]

  The first check with --address prints a challenge: sign it with that address in your own wallet
  (BIP-322; P2WPKH bc1q... or P2TR bc1p...), then run the printed command with --signature.
  Never paste a private key or a seed: only the signature.`

function opts(args: string[]): { get(name: string): string | undefined; all(name: string): string[]; has(name: string): boolean } {
  return {
    get: (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] },
    all: (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : [])),
    has: (name) => args.includes(name),
  }
}

export function parseWindow(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  const m = /^(\d{1,4})d?$/.exec(text)
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 3650) throw new Error('--window must be like 365d (1 to 3650 days)')
  return Number(m[1])
}

export function parseLayers(text: string | undefined): LayerId[] {
  const out = new Set<LayerId>()
  for (const part of (text ?? 'rgb,btc,ln').split(',').map((s) => s.trim()).filter(Boolean)) {
    const id = LAYER_ALIASES[part]
    if (!id) throw new Error(`unknown layer ${part} (rgb, btc, ln)`)
    out.add(id)
  }
  return [...out]
}

const layersDir = () => resolve(process.env.PASSBOOK_LAYERS_DIR ?? 'data/layers')
const sessionFile = (negotiation: Hex) => join(layersDir(), `session-${negotiation}.json`)

interface Session { negotiation_id: Hex; lender_pk: Hex; addresses: string[]; book: ReturnType<ChallengeBook['toJSON']> }

function loadSession(negotiation: Hex): Session | null {
  const f = sessionFile(negotiation)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Session) : null
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** The device's Passbook party key and, when present, its RGB wallet (regtest demo wallets from `npm run seed`). */
async function deviceWallet(role: string, wantRgb: boolean, blocksPerDay: number): Promise<{ key: KeyPair; rgb: RgbAdapter | null; close(): void; note: string | null }> {
  const { loadSeed, openParty, partyKey } = await import('../wallet/party.js')
  if (!wantRgb) return { key: partyKey(loadSeed(role as never)), rgb: null, close: () => {}, note: null }
  try {
    const party = await openParty(role as never)
    const { BitcoindChain } = await import('../chain/bitcoind.js')
    const { readState } = await import('../wallet/state.js')
    const chain = BitcoindChain.fromEnv()
    const state = readState()
    const persona = (state.personas as Record<string, { inflows: { txid: Hex; payer_pk: Hex; memo: string; height: number; amount: number; payer_sig: Hex }[] }> | undefined)?.[role]
    const inflows = role === 'borrower' ? state.borrower_inflows : persona?.inflows ?? []
    const labelsFile = join(dirname(party.rgb.dataDir), 'labels.json')
    const labels = existsSync(labelsFile) ? (JSON.parse(readFileSync(labelsFile, 'utf8')) as Record<Hex, RgbRowLabel>) : {}
    party.rgb.refresh()
    const rgb = new RgbAdapter(loanChainFromEnv(), {
      party: party.key, borrowerPk: party.key.pubkey, assetId: state.asset.id,
      rows: () => rgbHistoryRows({ wallet: party.rgb, assetId: state.asset.id, chain, inflows, labels }),
      signed: inflows.map(({ memo: _m, ...c }) => c), height: () => chain.getHeight(), blocksPerDay,
    })
    return { key: party.key, rgb, close: () => party.close(), note: null }
  } catch (e) {
    return { key: partyKey(loadSeed(role as never)), rgb: null, close: () => {}, note: `RGB wallet not opened: ${(e as Error).message.slice(0, 120)}` }
  }
}

function printResult(r: AgentCheckResult): void {
  console.log(`\nPassbook agent check  negotiation ${r.negotiation_id.slice(0, 16)}…  lender ${r.lender_pk.slice(0, 16)}…`)
  console.log(`history chain ${r.history_chain} (read only) · loan chain ${r.loan_chain} · window ${r.window.days} days`)
  for (const l of r.layers) {
    console.log(`\n  ${l.layer}${l.trust_mode ? `  [${l.trust_mode}]` : ''}`)
    for (const v of l.control) console.log(`    control ${v.ok ? 'proven' : 'FAILED'}  ${v.subject.slice(0, 66)}  (${v.format}${v.reasons.length ? `: ${v.reasons.join(', ')}` : ''})`)
    if (l.source) console.log(`    device source  ${l.source}${l.height !== null ? `  height ${l.height}` : ''}`)
    if (l.lender_source) console.log(`    lender source  ${l.lender_source}`)
    if (l.recompute) console.log(`    lender recompute  ${l.recompute.ok ? `all ${l.recompute.matched} rows match` : 'DIFFERS'}${l.recompute.tampered.map((t) => `\n      ${t.txid}  ${t.field}: borrower ${t.claimed}, lender ${t.recomputed}`).join('')}${l.recompute.missing.map((t) => `\n      ${t}  found by the lender, not sent`).join('')}${l.recompute.unknown.map((t) => `\n      ${t}  unknown to the lender's source`).join('')}`)
    if (l.limits.length) console.log(`    limits  ${l.limits.join('; ')}`)
  }
  if (r.lightning?.public_facts) console.log(`\n  lightning public facts (${r.lightning.public_facts.source}): first seen ${r.lightning.public_facts.first_seen ? new Date(r.lightning.public_facts.first_seen * 1000).toISOString().slice(0, 10) : 'unknown'}`)
  if (r.features) {
    console.log('\n  features (bands; each names its trust mode)')
    for (const f of r.features.features) console.log(`    ${f.layer.padEnd(12)} ${f.name.padEnd(30)} ${f.value.padEnd(28)} [${f.trust_mode}]`)
    for (const t of r.features.typologies) console.log(`    typology ${t.type.padEnd(17)} ${t.matched ? t.disposition.toUpperCase() : 'clear'}${t.matched ? `  ${t.support.map((s) => `${s.layer}:${s.txid ? s.txid.slice(0, 12) : 'private'}`).join(' ')}` : ''}`)
    const sx = r.features.sanctions
    console.log(`    sanctions ${sx.status} (${sx.screen}; lists ${sx.list_version}; ${sx.screened.proven} proven address(es), ${sx.screened.counterparties} counterparties)${sx.hits.map((h) => `\n      hit hop ${h.hop} ${h.address}${h.via ? ` via ${h.via}` : ''} on ${h.list_id}`).join('')}`)
  }
  console.log(`\n  ${r.negotiation.outcome}${r.negotiation.outcome === 'DEAL' ? `  LTV bonus ${r.negotiation.ltv_bonus_bps} bps (bounded, clamped by the platform limit for the term)` : ''}`)
  for (const reason of r.negotiation.reasons) console.log(`    ${reason}`)
  for (const l of r.negotiation.layers.filter((x) => x.status === 'failed')) console.log(`    ${l.layer} adds nothing: ${l.why.join('; ')}`)
  for (const line of describeOutcome(r)) console.log(`  · ${line}`)
  console.log(`\n  ${r.decided_by}`)
  console.log(`  ${r.source_calls.length} source calls logged; result ${r.result_hash.slice(0, 16)}…`)
}

export async function runAgentCli(args: string[]): Promise<number> {
  const o = opts(args)
  const sub = args[1]
  // An invalid or missing PASSBOOK_CONFIG is an error, never a silent switch to the public default sources.
  let deployment: PassbookConfig | null
  try { deployment = deploymentConfigFromEnv() } catch (e) { console.error(`agent: ${(e as Error).message}`); return 2 }
  const credit: CreditConfig = deployment?.credit ?? DEFAULT_CREDIT
  const blocksPerDay = deployment?.economics.blocks_per_day ?? DEFAULT_ECONOMICS.blocks_per_day
  const chainArg = o.get('--history-chain') ?? credit.history_chains[0]
  if (!isChainId(chainArg)) { console.error(`--history-chain must be bitcoin, signet or regtest\n${AGENT_USAGE}`); return 2 }
  const chain: ChainId = chainArg
  if (sub === 'snapshot') {
    const address = o.get('--address')
    if (!address) { console.error(AGENT_USAGE); return 2 }
    refuseSecret(address, 'address')
    const url = credit.sources[chain]
    if (!url) { console.error(`no credit source for ${chain}`); return 2 }
    const snap = await recordSnapshot(sourceFor(url, chain), [address])
    const out = resolve(o.get('--out') ?? join(layersDir(), `snapshot-${chain}-${address}.json`))
    mkdirSync(dirname(out), { recursive: true })
    saveSnapshot(out, snap)
    console.log(`recorded ${Object.keys(snap.txs).length} transactions for ${address} at block ${snap.tip_height} from ${snap.recorded_from} -> ${out}\nset credit.snapshot to this file for offline use (labelled "recorded ${chain === 'bitcoin' ? 'mainnet' : chain} data, block ${snap.tip_height}")`)
    return 0
  }
  if (sub !== 'check') { console.error(AGENT_USAGE); return 2 }
  try {
    const layers = parseLayers(o.get('--layers'))
    const windowDays = parseWindow(o.get('--window'), credit.window_days)
    let lenderPk = o.get('--for')
    if (!lenderPk) {
      try { lenderPk = (await import('../wallet/state.js')).readState().parties.lender1.pubkey } catch { /* no demo state */ }
    }
    if (!lenderPk || !isHex(lenderPk, 32)) { console.error(`--for <lender_pk> must be the lender's 32-byte x-only key\n${AGENT_USAGE}`); return 2 }
    const role = o.get('--rgb-role') ?? 'borrower'
    const device = await deviceWallet(role, layers.includes('rgb'), blocksPerDay)
    try {
      const negotiation = o.get('--negotiation') ?? standaloneNegotiationId(device.key.pubkey)
      if (!isHex(negotiation, 32)) { console.error('--negotiation must be a 32-byte hex id'); return 2 }
      const prior = loadSession(negotiation)
      if (prior && prior.lender_pk !== lenderPk) { console.error('this negotiation was started for another lender'); return 2 }
      const addresses = o.all('--address').length ? o.all('--address') : prior?.addresses ?? []
      for (const a of addresses) refuseSecret(a, 'address')
      if (layers.includes('btc-onchain') && !addresses.length) { console.error('--layers btc needs --address <a fresh address from your own wallet>'); return 2 }
      const book = prior ? ChallengeBook.fromJSON(prior.book) : new ChallengeBook(lenderPk, negotiation)
      const sigText = o.get('--signature') ?? (o.get('--signature-file') ? readFileSync(o.get('--signature-file')!, 'utf8').trim() : undefined)
      const btc_signatures: Record<string, string> = sigText && addresses.length === 1 ? { [addresses[0]]: sigText } : {}
      const lnUrl = o.get('--ln-url') ?? process.env.PASSBOOK_BORROWER_LIGHTNING_URL
      const lnChain = (o.get('--ln-chain') ?? loanChainFromEnv()) as ChainId
      let lightning: LightningAdapter | null = null, nodePk: Hex | null = null
      if (layers.includes('lightning') && lnUrl) {
        const node = new RlnNodeApi(lnUrl, process.env.PASSBOOK_BORROWER_LIGHTNING_TOKEN)
        try { nodePk = (await node.nodeInfo()).pubkey; lightning = new LightningAdapter(lnChain, node, lnChain === 'bitcoin' ? new MempoolLightningFacts() : null) } catch (e) { console.error(`Lightning node not reachable at ${lnUrl}: ${(e as Error).message}`) }
      }
      const { device: deviceSource, lender: lenderSource } = creditSources(credit, chain, { offline: o.has('--offline') })
      const policyFile = o.get('--policy')
      const policy: LenderLayerPolicy = policyFile ? JSON.parse(readFileSync(policyFile, 'utf8')) : { ...DEFAULT_LENDER_LAYER_POLICY }
      const problems = layerPolicyProblems(policy)
      if (problems.length) { console.error(`lender layer policy invalid: ${problems.join(', ')}`); return 2 }
      if (device.note) console.error(device.note)
      const result = await runAgentCheck({
        history_chain: chain, window_days: windowDays, borrower_source: deviceSource, lender_source: lenderSource, policy,
        price_cents: Number(o.get('--price-cents') ?? process.env.BTC_PRICE_CENTS ?? 10_000_000), sanctions: availableSanctionsScreen(),
        known_escrows: [], liabilities: { open_loans: [], ious_held_by_others: [] },
      }, { borrower: device.key, shareable: { shareable_layers: layers, subjects: { 'btc-onchain': addresses, ...(nodePk ? { lightning: [nodePk] } : {}) } }, rgb: device.rgb, lightning, btc_signatures }, book)
      saveJson(sessionFile(negotiation), { negotiation_id: negotiation, lender_pk: lenderPk, addresses, book: book.toJSON() } satisfies Session)
      saveJson(join(layersDir(), `check-${negotiation}.json`), result)
      if (result.awaiting_signature.length) {
        for (const c of result.awaiting_signature) {
          console.log(`\nSign this message with ${c.subject} in your own wallet, using its BIP-322 message signing (an Electrum-style or BIP-137 signature for a bc1 address is not BIP-322 and will be refused):\n\n${c.text}\n\nExpires ${new Date(c.expires_at * 1000).toISOString()}. Then run:\n\n  npm run passbook -- agent check --layers ${o.get('--layers') ?? 'rgb,btc,ln'} --history-chain ${chain} --window ${windowDays}d --for ${lenderPk} --negotiation ${negotiation} --signature '<paste the signature>'\n`)
        }
        return 3
      }
      if (o.has('--json')) console.log(JSON.stringify(result, null, 2))
      else printResult(result)
      return result.negotiation.outcome === 'DEAL' ? 0 : 1
    } finally {
      device.close()
    }
  } catch (e) {
    console.error(`agent check: ${(e as Error).message}`)
    return 1
  }
}
