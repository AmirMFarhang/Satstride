// A LABELLED TEST PERSONA on Mutinynet for the borrower phone (the user's decision for the 12:00 run: "fresh phone
// wallets keep showing ESCALATE honestly"). The provider's trusted history observer (the platform key of the Mutinynet
// provider state) watches the persona's RGB wallet from zero, two test clients pay it three demo months of income, and
// the observer signs its history proof, which the phone carries with the persona through the existing persona path.
// Test coins only, never mainnet; "TEST PERSONA (mutinynet)" everywhere.
//
//   PASSBOOK_SP_STATE=<the Mutinynet provider state> npx tsx infra/public-mutinynet-persona.ts plan     wallets + the faucet list
//   PASSBOOK_SP_STATE=...                            npx tsx infra/public-mutinynet-persona.ts fund     BTC from test sats already held
//   PASSBOOK_SP_STATE=...                            npx tsx infra/public-mutinynet-persona.ts run      resumable seeding
//   PASSBOOK_SP_STATE=...                            npx tsx infra/public-mutinynet-persona.ts proof    the observer's signed proof
//   PASSBOOK_SP_STATE=...                            npx tsx infra/public-mutinynet-persona.ts package  the phone's persona package
//   PASSBOOK_SP_STATE=...                            npx tsx infra/public-mutinynet-persona.ts status
//
// The asset: a fresh "Passbook test USDT (mutinynet, no value)" (TUSDT, 6 decimals) issued by the 17 Oct run's issuer
// wallet (data/mutinynet), with room for regtest-like persona income and the lender phone; written to $STATE/asset.json,
// which the Mutinynet provider profile then uses for the platform and the check node (the loan's asset = the check's).

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as bitcoin from 'bitcoinjs-lib'
import { EsploraChain } from '../src/chain/esplora.js'
import { extractHex, keyPathOutput, signKeyPath } from '../src/escrow/escrow.js'
import { loadConfig } from '../src/core/config.js'
import { hashObject, randomHex, signHash, type Hex } from '../src/core/crypto.js'
import { MICRO_PER_USDT } from '../src/core/money.js'
import { explorerTx, type NetworkProfile } from '../src/core/network.js'
import { historyObserverDir, RgbHistoryObserver } from '../src/rgb/history-observer.js'
import { watchKeys } from '../src/rgb/watch.js'
import { RgbWallet, type RgbConfig } from '../src/rgb/wallet.js'
import { loadSeed, openParty, partyKey, type Party, type PersonaRole } from '../src/wallet/party.js'
import { loadPlatformKey } from '../src/wallet/platform-key.js'

const LABEL = 'TEST PERSONA (mutinynet): a seeded test wallet, not a real person'
const ISSUER_ROOT = resolve(process.env.MUTINYNET_DIR ?? 'data/mutinynet')
const CONFIG = process.env.PASSBOOK_CONFIG ?? 'infra/passbook.config.mutinynet.yaml'
const PERSONA: PersonaRole = 'fatima'
/** One employer: a single-employer salary profile (the Mutinynet faucet was exhausted; the smallest honest history). */
const CLIENTS: PersonaRole[] = ['client1']
/** Three demo months of income from two clients (test USDT): regtest Fatima's shape, scaled. */
const INCOME = [[150], [150], [150]]
const CLIENT_FLOAT = 500 // the employer's working capital from the issuer (it pays 450 over the three months)
const SUPPLY = 100_000
/** Faucet sats per address: colored outputs (n x 3,000) plus fees; the persona's collateral key for one 100 TUSDT loan. */
/** Sats per address, from test sats already held (the old 17 Oct borrower key): one 10 TUSDT loan at 50% LTV. */
export const FAUCET = { persona_rgb: 12_000, persona_collateral: 25_000, client_rgb: 18_000, issuer_topup: 0, lender_phone: 15_000 } as const

interface PersonaState {
  v: 1; asset_id?: string; registered_at?: string; utxos?: Record<string, number>; funding?: Record<string, Hex>
  income: { month: number; client: string; txid: Hex; height: number; amount: number; payer_pk: Hex; payer_sig: Hex; memo: string }[]
  month_start_height?: number; proof_file?: string
}

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set (the Mutinynet provider state, e.g. data/service-provider/passbook-provider-mutinynet)`); return v }
const log = (m: string) => console.log(`[persona ${new Date().toISOString().slice(11, 19)}] ${m}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function profile(): NetworkProfile {
  const p = loadConfig(CONFIG, { checkFiles: false }).network
  if (p.name !== 'mutinynet') throw new Error(`${CONFIG} is a ${p.name} profile; the persona is Mutinynet only`)
  return p
}
/** The party key's BIP-86 key-path address on this network (openParty's btcAddress uses regtest parameters). */
const keyAddress = (pk: Hex, p: NetworkProfile) => bitcoin.address.fromOutputScript(Buffer.from(keyPathOutput(pk).script, 'hex'), bitcoin.networks[p.addressNetwork])
const rgbCfg = (p: NetworkProfile): RgbConfig => ({ network: p.rgbNetwork, indexerUrl: p.endpoints.rgb_indexer!, transportEndpoint: p.endpoints.rgb_proxy! })

function readState(file: string): PersonaState { return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PersonaState) : { v: 1, income: [] } }
function writeState(file: string, s: PersonaState): void { writeFileSync(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 }); renameSync(`${file}.tmp`, file) }

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status'
  const { values } = parseArgs({ args: process.argv.slice(3), options: { out: { type: 'string' } } })
  const STATE = resolve(env('PASSBOOK_SP_STATE'))
  const WALLETS = join(STATE, 'wallets')
  const stateFile = join(STATE, 'persona.json')
  const p = profile()
  const cfg = rgbCfg(p)
  const platform = loadPlatformKey({ dir: WALLETS, create: false })
  if (!platform) throw new Error(`no platform key in ${WALLETS}: run PASSBOOK_SP_NETWORK=mutinynet infra/service-provider.sh up once (it writes the key), then plan`)
  process.env.PASSBOOK_WALLETS = WALLETS // the observer's journal lives next to the platform key
  const s = readState(stateFile)
  let issuerOpen = true
  const issuer = await RgbWallet.open(loadSeed('lender1', { dir: join(ISSUER_ROOT, 'wallets'), create: false }), join(ISSUER_ROOT, 'wallets', 'lender1', 'rgb'), cfg)
  const parties = {} as Record<PersonaRole, Party>
  for (const role of [PERSONA, ...CLIENTS]) parties[role] = await openParty(role, { dir: WALLETS, create: true, rgb: cfg })
  // The observer reads Mutinynet through Esplora, and the BTC history from Mutinynet's Electrum server (checked against
  // the chain's blocks 0 and 1 by the observer before it is trusted): rgb-lib keeps the Esplora indexer.
  const observer = new RgbHistoryObserver({ rootDir: historyObserverDir(), signer: platform, chain: new EsploraChain(p.endpoints.esplora!), cfg, btcHistoryElectrum: process.env.PASSBOOK_BTC_HISTORY_ELECTRUM ?? 'tcp://electrum.mutinynet.com:50001' })
  try {
    // the asset (no transaction: NIA issuance commits to a colored output the issuer already holds)
    if (!s.asset_id) {
      issuer.refresh()
      s.asset_id = issuer.issueNia({ ticker: 'TUSDT', name: 'Passbook test USDT (mutinynet, no value)', precision: 6, amount: SUPPLY * MICRO_PER_USDT })
      writeState(stateFile, s)
      writeFileSync(join(STATE, 'asset.json'), `${JSON.stringify({ network: 'mutinynet', asset: { id: s.asset_id, ticker: 'TUSDT', name: 'Passbook test USDT (mutinynet, no value)', precision: 6, label: 'test USDT (mutinynet)' }, issuer: 'the 17 Oct Mutinynet run\'s issuer wallet (data/mutinynet)' }, null, 2)}\n`)
      log(`issued ${SUPPLY} TUSDT: ${s.asset_id}`)
    }
    const asset = s.asset_id
    observer.identifyWallet(partyKey(loadSeed('lender1', { dir: join(ISSUER_ROOT, 'wallets'), create: false })).pubkey, issuer)
    for (const c of CLIENTS) observer.identifyWallet(parties[c].key.pubkey, parties[c].rgb)
    if (!observer.hasWallet(parties[PERSONA].key.pubkey)) {
      observer.registerFreshWallet({ borrowerPk: parties[PERSONA].key.pubkey, wallet: parties[PERSONA].rgb, watchKeys: await watchKeys(loadSeed(PERSONA, { dir: WALLETS }), cfg.network), assetId: asset })
      s.registered_at = new Date().toISOString()
      writeState(stateFile, s)
      log(`the observer ${platform.pubkey.slice(0, 12)}… watches the persona ${parties[PERSONA].key.pubkey.slice(0, 12)}… from zero`)
    } else observer.attachWallet(parties[PERSONA].key.pubkey, parties[PERSONA].rgb)

    if (cmd === 'plan' || cmd === 'status') {
      const chain = new EsploraChain(p.endpoints.esplora!)
      const have = async (a: string) => { const x = await chain.addressStats(a); return `${x.confirmed} confirmed, ${x.unconfirmed} pending` }
      const rows = [
        { address: parties[PERSONA].rgb.address(), for: 'TEST PERSONA RGB wallet (colored outputs, receives the test income)', sats: FAUCET.persona_rgb },
        { address: keyAddress(parties[PERSONA].key.pubkey, p), for: 'TEST PERSONA collateral key (locks BTC for one ~100 TUSDT loan)', sats: FAUCET.persona_collateral },
        ...CLIENTS.map((c) => ({ address: parties[c].rgb.address(), for: `test client ${c} RGB wallet (pays the persona three demo months)`, sats: FAUCET.client_rgb })),
        { address: issuer.address(), for: 'issuer top-up (sends to the two clients and the lender phone)', sats: FAUCET.issuer_topup },
      ]
      const out = { network: 'mutinynet', faucet: 'https://faucet.mutinynet.com', label: LABEL, asset_id: asset, persona_pk: parties[PERSONA].key.pubkey, observer_pk: platform.pubkey, rows, phones: { lender_phone: `${FAUCET.lender_phone} sats to the address the lender phone shows`, borrower_phone: 'none needed: it borrows as the test persona' }, total_sats: rows.reduce((a, r) => a + r.sats, 0) + FAUCET.lender_phone }
      writeFileSync(join(STATE, 'faucet-plan.json'), `${JSON.stringify(out, null, 2)}\n`)
      for (const r of rows) console.log(`${r.address}  ${String(r.sats).padStart(7)} sats  ${r.for}  [${await have(r.address)}]`)
      console.log(`lender phone: ${FAUCET.lender_phone} sats to its own address; total ${out.total_sats} sats. Plan: ${join(STATE, 'faucet-plan.json')}`)
      if (cmd === 'status') console.log(JSON.stringify({ income: s.income.length, proof: s.proof_file ?? null }))
      return
    }

    if (cmd === 'fund') {
      // One transaction from the old 17 Oct borrower key (test sats already held): the persona's collateral key and
      // RGB wallet, and the employer's RGB wallet. The change stays on the old key (the lender phone's share).
      const chain = new EsploraChain(p.endpoints.esplora!)
      if (s.funding?.btc) { log(`already funded: ${explorerTx(p, s.funding.btc)}`); return }
      const old = partyKey(loadSeed('borrower', { dir: join(ISSUER_ROOT, 'wallets'), create: false }))
      const oldScript = keyPathOutput(old.pubkey).script
      const utxo = (await chain.utxos(keyAddress(old.pubkey, p))).filter((u) => u.status.confirmed).sort((a, b) => b.value - a.value)[0]
      const outs: [string, number][] = [[keyAddress(parties[PERSONA].key.pubkey, p), FAUCET.persona_collateral], [parties[PERSONA].rgb.address(), FAUCET.persona_rgb], ...CLIENTS.map((c) => [parties[c].rgb.address(), FAUCET.client_rgb] as [string, number])]
      const fee = 600
      const need = outs.reduce((a, [, v]) => a + v, 0) + fee
      if (!utxo || utxo.value < need + 546) throw new Error(`the old borrower key has no confirmed output of ${need + 546} sats`)
      const psbt = new bitcoin.Psbt({ network: bitcoin.networks[p.addressNetwork] })
      psbt.addInput({ hash: utxo.txid, index: utxo.vout, witnessUtxo: { script: Buffer.from(oldScript, 'hex'), value: BigInt(utxo.value) }, tapInternalKey: Buffer.from(old.pubkey, 'hex') })
      for (const [address, value] of outs) psbt.addOutput({ script: Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks[p.addressNetwork])), value: BigInt(value) })
      psbt.addOutput({ script: Buffer.from(oldScript, 'hex'), value: BigInt(utxo.value - need) })
      signKeyPath(psbt, old.secretKey).finalizeAllInputs()
      const txid = await chain.broadcast(extractHex(psbt))
      s.funding = { ...(s.funding ?? {}), btc: txid }
      writeState(stateFile, s)
      for (const [address, value] of outs) log(`  ${value} sats → ${address}`)
      log(`funded from the old borrower key: ${explorerTx(p, txid)}`)
      return
    }

    if (cmd === 'run') {
      const chain = new EsploraChain(p.endpoints.esplora!)
      const wait = async (what: string, ok: () => Promise<boolean>, minutes = 30) => { for (let i = 0; i < minutes * 6; i++) { if (await ok()) return; await sleep(10_000) } throw new Error(`${what}: not after ${minutes} min`) }
      const settled = async (from: RgbWallet, to: RgbWallet, txid: Hex, label: string) => wait(`${label} settled`, async () => {
        for (const w of [to, from]) { try { w.refresh() } catch { /* retry */ } }
        const a = from.transferByTxid(asset, txid, 'Send'), b = to.transferByTxid(asset, txid)
        if (a?.status === 'Failed' || b?.status === 'Failed') throw new Error(`${label}: transfer failed`)
        return a?.status === 'Settled' && b?.status === 'Settled'
      })
      // 1. BTC on every wallet (the faucet), then colored outputs
      const wallets: [string, RgbWallet][] = [[PERSONA, parties[PERSONA].rgb], ...CLIENTS.map((c) => [c, parties[c].rgb] as [string, RgbWallet]), ['issuer', issuer]]
      s.utxos ??= {}
      for (const [name, w] of wallets) {
        if (s.utxos[name]) continue
        if (name === 'issuer') { try { w.refresh() } catch { /* retry */ } if (w.btcBalance().colored.settled >= 9_000) { s.utxos[name] = -1; writeState(stateFile, s); continue } }
        await wait(`${name} BTC`, async () => { try { w.refresh() } catch { /* retry */ } return w.btcBalance().vanilla.settled >= 9_000 }, 150)
        s.utxos[name] = await w.createUtxos(name === PERSONA ? 3 : 4, 3000)
        writeState(stateFile, s)
        log(`${name}: ${s.utxos[name]} colored outputs`)
      }
      for (const [name, w] of wallets) await wait(`${name} colored outputs confirmed`, async () => { try { w.refresh() } catch { /* retry */ } return w.btcBalance().colored.settled > 0 })
      // 2. the clients' working capital from the issuer (not the persona's income)
      s.funding ??= {}
      for (const c of CLIENTS) {
        if (!s.funding[c]) {
          const inv = parties[c].rgb.invoice(CLIENT_FLOAT * MICRO_PER_USDT, asset)
          s.funding[c] = (await issuer.send({ invoice: inv.invoice, assetId: asset, amount: CLIENT_FLOAT * MICRO_PER_USDT, feeRate: 1 })).txid
          writeState(stateFile, s)
        }
        await settled(issuer, parties[c].rgb, s.funding[c], `${c} working capital`)
        log(`${c}: ${CLIENT_FLOAT} TUSDT working capital, ${explorerTx(p, s.funding[c])}`)
      }
      // the issuer is free again: infra/public-mutinynet-fund.ts may now fund the lender phone (one process per wallet)
      issuer.close(); issuerOpen = false
      log('issuer wallet released')
      // 3. three demo months of income (30 Mutinynet blocks a month, the profile's 1 block = 1 day), payer-signed
      s.month_start_height ??= await chain.getHeight()
      writeState(stateFile, s)
      for (let month = 0; month < INCOME.length; month++) {
        const target = s.month_start_height + month * 30
        await wait(`month ${month + 1} (height ${target})`, async () => (await chain.getHeight()) >= target, 45)
        for (let i = 0; i < CLIENTS.length; i++) {
          const c = CLIENTS[i]
          if (s.income.some((x) => x.month === month && x.client === c)) continue
          const amount = INCOME[month][i] * MICRO_PER_USDT
          const memo = `salary, month ${month + 1}`
          const inv = parties[PERSONA].rgb.invoice(amount, asset)
          const { txid } = await parties[c].rgb.send({ invoice: inv.invoice, assetId: asset, amount, feeRate: 1 })
          await settled(parties[c].rgb, parties[PERSONA].rgb, txid, `month ${month + 1} from ${c}`)
          const height = (await chain.getTx(txid))?.height ?? 0
          const payer_sig = signHash(hashObject({ txid, amount, borrower_pk: parties[PERSONA].key.pubkey }), parties[c].key.secretKey)
          s.income.push({ month, client: c, txid, height, amount, payer_pk: parties[c].key.pubkey, payer_sig, memo })
          writeState(stateFile, s)
          log(`month ${month + 1}: ${INCOME[month][i]} TUSDT from ${c} (${memo}) ${explorerTx(p, txid)}`)
        }
      }
      log('seeded: run `proof` (needs the Mutinynet-capable history observer on main)')
      return
    }

    if (cmd === 'proof') {
      const proof = await observer.proof(parties[PERSONA].key.pubkey)
      const file = values.out ?? join(STATE, 'persona-history-proof.json')
      writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
      s.proof_file = file
      writeState(stateFile, s)
      log(`observer ${platform.pubkey.slice(0, 12)}… signed the persona's history proof: ${proof.transfers.length} transfers, balance ${proof.current_balance / MICRO_PER_USDT} TUSDT → ${file}`)
      return
    }
    if (cmd === 'package') {
      // The phone's existing persona package (apps/mobile/src/app/persona.ts PersonaPackage), network mutinynet: the
      // persona's words, an rgb-lib watch backup, the payer-signed income it was seeded with and the observer's proof
      // exactly as issued, plus `synthetic_history`: what the history is, in plain words, with every transaction.
      if (!s.proof_file || !existsSync(s.proof_file)) throw new Error('no history proof yet: run `proof` first (on main, with the Mutinynet-capable observer)')
      const proof = JSON.parse(readFileSync(s.proof_file, 'utf8')) as { observer_pk: string; borrower_pk: string; asset_id: string; observed_from_zero: boolean }
      if (proof.observer_pk !== platform.pubkey || proof.borrower_pk !== parties[PERSONA].key.pubkey || proof.asset_id !== asset || !proof.observed_from_zero) throw new Error('the proof is not this observer\'s proof of this persona from zero')
      const rgbDir = join(WALLETS, PERSONA, 'rgb')
      const fingerprint = readdirSync(rgbDir).find((d) => /^[0-9a-f]{8}$/.test(d))
      if (!fingerprint) throw new Error(`no rgb-lib wallet under ${rgbDir}`)
      const tmp = mkdtempSync(join(tmpdir(), 'passbook-persona-'))
      try {
        const password = randomHex(16)
        const backup = parties[PERSONA].rgb.createWatchBackup(tmp, password)
        const synthetic = {
          note: 'SYNTHETIC TEST DATA on Mutinynet (a public signet): a seeded test persona, not a real person. One test employer (client1) paid it a "salary" of 150 test USDT in each of three demo months (30 Mutinynet blocks = one month under the profile\'s 1 block = 1 day). The employer\'s 500 test USDT came from the issuer. The provider\'s trusted history observer watched the persona\'s RGB wallet from zero.',
          employer_pk: parties[CLIENTS[0]].key.pubkey, employer_funding: s.funding?.[CLIENTS[0]] ? explorerTx(p, s.funding[CLIENTS[0]]) : null,
          btc_funding: s.funding?.btc ? explorerTx(p, s.funding.btc) : null,
          income: s.income.map((x) => ({ month: x.month + 1, amount_usdt: x.amount / MICRO_PER_USDT, memo: x.memo, height: x.height, explorer: explorerTx(p, x.txid) })),
        }
        const pkg = {
          v: 1, kind: 'passbook-test-persona', label: LABEL, network: 'mutinynet', persona: PERSONA,
          words: loadSeed(PERSONA, { dir: WALLETS }), rgb_fingerprint: fingerprint, rgb_backup_b64: readFileSync(backup).toString('base64'), rgb_backup_password: password,
          asset_id: asset, observer_pk: platform.pubkey,
          inflows: s.income.map(({ txid, height, amount, payer_pk, payer_sig, memo }) => ({ txid, height, amount, payer_pk, payer_sig, memo })),
          history_proof: proof, synthetic_history: synthetic, issued_at: Math.floor(Date.now() / 1000),
        }
        const out = values.out ?? join(STATE, 'persona-package.json')
        writeFileSync(out, `${JSON.stringify(pkg)}\n`, { mode: 0o600 })
        writeFileSync(join(STATE, 'persona-record.json'), `${JSON.stringify({ label: LABEL, persona_pk: parties[PERSONA].key.pubkey, observer_pk: platform.pubkey, asset_id: asset, synthetic_history: synthetic }, null, 2)}\n`)
        log(`package for the phone (words + backup: keep private, serve once): ${out}; public record: ${join(STATE, 'persona-record.json')}`)
      } finally { rmSync(tmp, { recursive: true, force: true }) }
      return
    }
    if (cmd === 'serve') {
      // Once, on the laptop's loopback, for the phone's adb reverse (apps/mobile's Persona screen fetches
      // http://127.0.0.1:4309/persona.json): one successful fetch, then the server closes. 15 minutes at most.
      const file = values.out ?? join(STATE, 'persona-package.json')
      if (!existsSync(file)) throw new Error(`no package at ${file}: run \`package\` first`)
      const body = readFileSync(file)
      await new Promise<void>((resolve, reject) => {
        const server = createServer((req, res) => {
          if (req.url !== '/persona.json') { res.writeHead(404).end(); return }
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) }).end(body, () => { log('served the persona package once; closing'); server.close(); resolve() })
        })
        server.on('error', reject)
        server.listen(4309, '127.0.0.1', () => log('serving the TEST PERSONA package once on http://127.0.0.1:4309/persona.json (run: adb reverse tcp:4309 tcp:4309)'))
        setTimeout(() => { server.close(); reject(new Error('not fetched within 15 minutes')) }, 15 * 60_000).unref()
      })
      return
    }
    throw new Error(`unknown command ${cmd}; use plan | fund | run | proof | package | serve | status`)
  } finally {
    observer.close()
    if (issuerOpen) issuer.close()
    for (const party of Object.values(parties)) party.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main().then(() => process.exit(0), (err) => { console.error((err as Error).stack ?? (err as Error).message); process.exit(1) })
