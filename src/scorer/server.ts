// The container scorer (the fallback provider): today's sandbox behind the
// scoring contract. Two routes:
//   GET  /descriptor  -> self-signed ScorerDescriptor
//   POST /check       -> { request: EncryptedCheckRequest, consent } => SignedCheckResult
// The key lives only in memory. Nothing is written to disk (retention: none).
// Build with infra/Dockerfile.scorer; SANDBOX_IMAGE_DIGEST names the measured
// image, otherwise the descriptor carries a source measurement of the code.

import { createServer } from 'node:http'
import { primaryReasonerFromEnv } from '../ai/engine.js'
import { BitcoindChain } from '../chain/bitcoind.js'
import { FakeChain } from '../chain/fake.js'
import { randomKeyPair, type Hex } from '../core/crypto.js'
import type { ConsentReceipt } from './consent.js'
import { SandboxScorerEngine } from './providers.js'
import { measureSource } from './releases.js'
import type { EncryptedCheckRequest } from './types.js'

const digest = process.env.SANDBOX_IMAGE_DIGEST ?? ''
const measurement = /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : measureSource()
const engine = new SandboxScorerEngine({
  provider: 'container',
  key: randomKeyPair(),
  chain: process.env.PASSBOOK_CHAIN === 'fake' ? new FakeChain(100) : BitcoindChain.fromEnv(),
  reasoner: primaryReasonerFromEnv(),
  blocksPerMonth: Number(process.env.BLOCKS_PER_MONTH ?? 30),
  measurement,
  oraclePk: process.env.ORACLE_PK as Hex | undefined,
  runEnvironment: { image_digest: measurement.startsWith('sha256:') ? measurement : 'in-process', network_mode: measurement.startsWith('sha256:') ? 'bridge' : 'in-process-host' },
})

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && req.url === '/descriptor') return send(200, engine.descriptor())
  if (req.method === 'POST' && req.url === '/check') {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 2_000_000) return send(413, { error: 'request too large' })
    }
    try {
      const { request, consent } = JSON.parse(raw) as { request: EncryptedCheckRequest; consent: ConsentReceipt }
      return send(200, await engine.handle(request, consent))
    } catch (err) {
      // Only coded reasons leave the box; bundle contents never appear in errors.
      const message = (err as Error).message
      return send(400, { error: /^[A-Z_]+(:[A-Z_,]+)?$/.test(message.split(':').slice(0, 2).join(':')) ? message.slice(0, 200) : 'CHECK_FAILED' })
    }
  }
  send(404, { error: 'not found' })
})

const port = Number(process.env.SCORER_PORT ?? 4181)
server.listen(port, process.env.SCORER_HOST ?? '127.0.0.1', () => {
  const d = engine.descriptor()
  console.log(`container scorer ${d.scorer_id} on :${port}; measurement ${d.code_measurement}; trust ${d.trust}; contract ${d.contract_hash.slice(0, 12)}…`)
})
