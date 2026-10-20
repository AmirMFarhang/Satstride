// `passbook check-node`: the credit check as a role any laptop can run
// (docs/CHECK-MARKET.md, passbook-check/v1).
//
//   passbook check-node serve --name <A> --price <USDT> --ln <rln url> [--rails hodl,pay-then-deliver]
//                             [--asset <USDT asset id>] [--voucher <asset id>] [--p50 <s>] [--status-port <port>]
//                             [--operator-secret-file <file>]
//     Wraps the scorer as a check node: publishes an Offer on the relay
//     (PASSBOOK_RELAYS) and answers requests. external provider if scorer.external is in
//     the deployment config and its API answers, else the container scorer,
//     labelled FALLBACK with the reason. --chain-check-secret-file names the
//     key that signs the chain checks external provider trusts (default: the operator key).
//
//   passbook check-node offers [--json]
//     Lists the offers on the relay and the tier the verifier derives for each.
//
// Without --operator-secret-file the operator key is a publicly derivable demo
// key, labelled as such; use it on regtest only.

import { readFileSync } from 'node:fs'
import { Relay } from '../agents/relay.js'
import { keyPairFromLabel, keyPairFromSecret, randomKeyPair } from '../core/crypto.js'
import { MICRO_PER_USDT } from '../core/money.js'
import { listOffers } from '../checknode/client.js'
import { buildNode, engineFromConfig, serveStatus, type NodeSpec } from '../checknode/market.js'
import { releaseHash } from '../checknode/offer.js'
import { RAIL_LABEL, type LightningCheckRail } from '../checknode/rail.js'
import { deriveExecution, EXECUTION_TIER_LABEL, noTeeVerifier } from '../checknode/tee.js'

const USAGE = `Usage: passbook check-node serve --name <A> --price <USDT> --ln <rgb lightning url> --asset <asset id> [--rails hodl,pay-then-deliver] [--voucher <asset id>] [--p50 <s>] [--status-port <port>] [--operator-secret-file <file>] [--chain-check-secret-file <file>]
       passbook check-node offers [--json]`

const RAILS: Record<string, LightningCheckRail> = { hodl: 'rgb-ln-hodl', 'pay-then-deliver': 'rgb-ln-pay-then-deliver' }

export function demoOperator(name: string) {
  return keyPairFromLabel(`check-node-operator-${name}`)
}

export async function runCheckNodeCli(args: string[]): Promise<number> {
  const one = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const now = () => Math.floor(Date.now() / 1000)
  if (args[1] === 'offers') {
    const relay = new Relay(randomKeyPair())
    try {
      const { valid, rejected } = await listOffers(relay, now())
      const rows = valid.map((o) => {
        const execution = deriveExecution(o.execution, o.release, noTeeVerifier(now()))
        return { operator_pk: o.operator_pk, release_hash: releaseHash(o.release), provider: o.release.provider, price: o.price, rails: o.rails.map((r) => RAIL_LABEL[r]), execution: EXECUTION_TIER_LABEL[execution.tier], declared_tee: o.execution.tee, bond: 'designed, not live', p50_seconds: o.p50_seconds, expires: o.expires }
      })
      if (args.includes('--json')) console.log(JSON.stringify({ offers: rows, rejected }, null, 2))
      else {
        for (const r of rows) console.log(`${r.operator_pk.slice(0, 12)}…  ${r.price.amount / MICRO_PER_USDT} USDT  ${r.execution}  ${r.provider}  release ${r.release_hash.slice(0, 12)}…  p50 ${r.p50_seconds}s  bond designed, not live`)
        for (const r of rejected) console.log(`REJECTED ${r.operator_pk.slice(0, 12)}…: ${r.problems.join(', ')}`)
        if (!rows.length && !rejected.length) console.log('no check-node offers on the relay')
      }
      return 0
    } finally {
      relay.close()
    }
  }
  if (args[1] !== 'serve') { console.error(USAGE); return 2 }
  const name = one('--name') ?? 'A'
  const price = Number(one('--price') ?? '0.5')
  const ln = one('--ln')
  const asset = one('--asset') ?? process.env.PASSBOOK_CHECK_ASSET_ID
  if (!ln || !asset || !Number.isFinite(price) || price <= 0) { console.error(USAGE); return 2 }
  const secretFile = one('--operator-secret-file')
  const operator = secretFile ? keyPairFromSecret(readFileSync(secretFile, 'utf8').trim()) : demoOperator(name)
  const rails = (one('--rails') ?? 'hodl').split(',').map((r) => RAILS[r.trim()])
  if (rails.some((r) => !r)) { console.error(`--rails takes ${Object.keys(RAILS).join(', ')}`); return 2 }
  const chainCheckFile = one('--chain-check-secret-file')
  const spec: NodeSpec = { name, operator, demoKey: !secretFile, priceMicro: Math.round(price * MICRO_PER_USDT), p50Seconds: Number(one('--p50') ?? 30), lnUrl: ln, rails, paymentAssetId: asset, ...(one('--voucher') ? { voucher: { asset_id: one('--voucher')!, ticker: 'PBCHK' } } : {}) }
  const relay = new Relay(operator)
  // external provider if configured and reachable, else the container scorer, labelled with why.
  const engine = await engineFromConfig({ chainCheckSigner: chainCheckFile ? keyPairFromSecret(readFileSync(chainCheckFile, 'utf8').trim()) : operator, log: (l) => console.log(`[check-node ${name}] ${l}`) })
  const node = await buildNode(spec, relay, engine)
  console.log(`check node ${name}: operator ${operator.pubkey}${spec.demoKey ? ' (demo key, publicly derivable: regtest only)' : ''}`)
  console.log(`scorer: ${engine.label}`)
  console.log(`rails: ${rails.map((r) => RAIL_LABEL[r]).join('; ')}`)
  console.log('execution: no TEE: software evidence. Bond: designed, not live. Retention: 0. The platform takes no cut of check fees.')
  const port = one('--status-port')
  const status = port ? serveStatus(node, spec, Number(port)) : null
  const stop = () => { node.stop(); status?.close(); relay.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await node.serve()
  return 0
}
