// passbook assistant serve | ask | copilot
//
//   serve    the provider's help agent on the relay (docs: src/assistant/protocol.ts)
//   ask      a phone-like client: ask the help agent one question, print the labelled answer
//   copilot  the operator copilot on a node's decision log, in this terminal
//
// Exit 0 ok, 1 failure, 2 usage, 3 refused (e.g. the model backend is misconfigured).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SimplePool } from 'nostr-tools'
import { keyPairFromLabel, keyPairFromSecret, randomHex, type Hex } from '../core/crypto.js'
import { relaysFromEnv } from '../agents/relay.js'
import { keyPairSigner, poolTransport, type PoolLike } from '../market/negotiate-nostr.js'
import { readLog } from '../governance/log.js'
import { askAssistant, discoverAssistant, ephemeralSigner } from './client.js'
import { askOperatorCopilot, type OperatorContext } from './copilot.js'
import { assistantModelFromEnv } from './model.js'
import { ASSIST_KIND, assistContext, testDataTags, type AssistContext } from './protocol.js'
import { DEFAULT_LIMITS, serveAssistant, type ServiceLogEntry } from './service.js'

const USAGE = `Usage: passbook assistant serve [--secret-file <f>] [--info-out <f>] [--log <f.jsonl>] [--per-minute <n>]
       passbook assistant ask "<question>" [--assistant-pk <hex>] [--screen <id>] [--tab <id>] [--context <ctx.json>] [--timeout-ms <n>]
       passbook assistant copilot "<question>" [--decision-log <decision-log.jsonl>] [--node-pk <hex>] [--revenue <f.json>] [--alerts <f.json>]
Env: PASSBOOK_RELAYS | PASSBOOK_RELAY_PORT; PASSBOOK_ASSIST_AI (else PASSBOOK_AI) = qvac | qvac-http | rules; QVAC_MODEL, QVAC_BASE_URL; PASSBOOK_ASSIST_TIMEOUT_MS (20000);
     PASSBOOK_PUBLIC_NETWORK (public relays: every event carries ['network', n] and the test-data 'alt' tag)`

export async function runAssistantCli(args: string[]): Promise<number> {
  const one = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const sub = args[1]
  let model
  try { model = assistantModelFromEnv() } catch (err) { console.error(`assistant: ${(err as Error).message}`); return 3 }
  if (sub === 'serve') {
    const perMinute = Number(one('--per-minute') ?? DEFAULT_LIMITS.perKeyPerMinute)
    if (!Number.isInteger(perMinute) || perMinute < 1) { console.error(USAGE); return 2 }
    const secretFile = one('--secret-file')
    if (secretFile && !existsSync(secretFile)) { mkdirSync(dirname(secretFile), { recursive: true }); writeFileSync(secretFile, `${randomHex(32)}\n`, { mode: 0o600 }) }
    const key = secretFile ? keyPairFromSecret(readFileSync(secretFile, 'utf8').trim()) : keyPairFromLabel('passbook-assistant')
    const relays = relaysFromEnv()
    const pool = new SimplePool()
    const logFile = one('--log')
    if (logFile) mkdirSync(dirname(logFile), { recursive: true })
    const log = (e: ServiceLogEntry) => {
      if (logFile) appendFileSync(logFile, `${JSON.stringify(e)}\n`)
      console.log(`${new Date(e.at * 1000).toISOString()} ${e.event}${e.from ? ` from ${e.from}…` : ''}${e.label ? ` [${e.label}]` : ''}${e.outcome ? ` ${e.outcome}` : ''}${e.reasons ? ` ${e.reasons.join(',')}` : ''}${e.ms !== undefined ? ` ${e.ms} ms` : ''}`)
    }
    const service = serveAssistant({
      transport: poolTransport(pool as unknown as PoolLike, relays), signer: keyPairSigner(key), model,
      answerTimeoutMs: Number(process.env.PASSBOOK_ASSIST_TIMEOUT_MS ?? 20_000), limits: { ...DEFAULT_LIMITS, perKeyPerMinute: perMinute }, log,
      publicNetwork: process.env.PASSBOOK_PUBLIC_NETWORK || undefined,
    })
    const info = { v: 1, kind: 'passbook-assistant', assistant_pk: key.pubkey, label: service.info.label, corpus_hash: service.info.corpus_hash, relays, per_minute: perMinute, kinds: { ask: ASSIST_KIND.ASK, reply: ASSIST_KIND.REPLY, info: ASSIST_KIND.INFO }, network: 'regtest', key: secretFile ? 'assistant key' : 'demo key (publicly derivable, regtest only)', pid: process.pid }
    const out = one('--info-out')
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`) }
    console.log(`assistant ${key.pubkey}: ${service.info.label} (kinds ${ASSIST_KIND.ASK}/${ASSIST_KIND.REPLY}, info ${ASSIST_KIND.INFO}) on ${relays.join(', ')}${secretFile ? '' : ' (demo key, publicly derivable: regtest only)'}`)
    console.log('It answers in text and offers one allowlisted screen; it never moves money, signs or sees keys. Questions are not logged.')
    await new Promise<void>((resolve) => {
      const stop = () => { service.close(); pool.close(relays); resolve() }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  }
  if (sub === 'ask') {
    const question = args[2]
    if (!question || question.startsWith('--')) { console.error(USAGE); return 2 }
    const relays = relaysFromEnv()
    const pool = new SimplePool()
    const transport = poolTransport(pool as unknown as PoolLike, relays)
    try {
      const pk = (one('--assistant-pk') ?? process.env.PASSBOOK_ASSISTANT_PK ?? (await discoverAssistant(transport))?.assistant_pk ?? null) as Hex | null
      const file = one('--context')
      const context: AssistContext = file ? assistContext(JSON.parse(readFileSync(file, 'utf8'))) : assistContext({ tab: one('--tab') ?? 'passbook', screen: one('--screen') ?? 'passbook' })
      const answer = await askAssistant({ transport, signer: ephemeralSigner(), assistantPk: pk, question, context, timeoutMs: Number(one('--timeout-ms') ?? 30_000), tags: testDataTags(process.env.PASSBOOK_PUBLIC_NETWORK || undefined) })
      console.log(JSON.stringify(answer, null, 2))
      return 0
    } finally { pool.close(relays) }
  }
  if (sub === 'copilot') {
    const question = args[2]
    if (!question || question.startsWith('--')) { console.error(USAGE); return 2 }
    const readJson = (f?: string) => (f ? JSON.parse(readFileSync(f, 'utf8')) : undefined)
    const logFile = one('--decision-log')
    const ctx: OperatorContext = { decisions: logFile ? readLog(logFile) : undefined, node_pk: one('--node-pk') as Hex | undefined, revenue: readJson(one('--revenue')), alerts: readJson(one('--alerts')) }
    console.log(JSON.stringify(await askOperatorCopilot(question, ctx, { model, timeoutMs: Number(process.env.PASSBOOK_ASSIST_TIMEOUT_MS ?? 20_000) }), null, 2))
    return 0
  }
  console.error(USAGE)
  return 2
}
