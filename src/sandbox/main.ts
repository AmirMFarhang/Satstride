// The sandbox container's entrypoint. A tiny HTTP server with two routes:
//   GET  /pubkey   -> { sandbox_pk }
//   POST /run      -> { sender_pk, ciphertext }  => signed SandboxResult
// The keypair is generated at start and lives only in memory. The container
// is on an internal network that can reach the platform and the QVAC host only.
// Private redacted replay files live in the configured temporary directory; no raw model text is stored.

import { createServer } from 'node:http'
import { primaryReasonerFromEnv } from '../ai/engine.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { FakeChain } from '../chain/fake.js'
import { randomKeyPair, type Hex } from '../core/crypto.js'
import { decryptFrom } from '../market/messages.js'
import { runSandbox } from './run.js'
import { validateBundle } from './types.js'

const key = randomKeyPair()
const chain = process.env.PASSBOOK_CHAIN === 'fake' ? new FakeChain(100) : BitcoindChain.fromEnv()
const primary = primaryReasonerFromEnv()
const blocksPerMonth = Number(process.env.BLOCKS_PER_MONTH ?? 30)
const oraclePk = process.env.ORACLE_PK as Hex | undefined

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && req.url === '/pubkey') return send(200, { sandbox_pk: key.pubkey, engine: primary.engine, chain: chain.kind })
  if (req.method === 'POST' && req.url === '/run') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const { sender_pk, ciphertext } = JSON.parse(raw) as { sender_pk: Hex; ciphertext: string }
      const bundle: unknown = JSON.parse(decryptFrom(key, sender_pk, ciphertext))
      validateBundle(bundle)
      if (bundle.borrower_pk !== sender_pk) return send(400, { error: 'bundle must be sent by its borrower' })
      const result = await runSandbox(bundle, { key, chain, reasoner: primary, blocksPerMonth, oraclePk, runEnvironment: { image_digest: process.env.SANDBOX_IMAGE_DIGEST ?? 'unavailable', network_mode: 'bridge' } })
      return send(200, result)
    } catch (err) {
      return send(400, { error: (err as Error).message })
    }
  }
  send(404, { error: 'not found' })
})

const port = Number(process.env.SANDBOX_PORT ?? 4180)
server.listen(port, '0.0.0.0', () => {
  console.log(`sandbox ${key.pubkey.slice(0, 12)}… listening on :${port} (engine ${primary.engine}, chain ${chain.kind})`)
})
