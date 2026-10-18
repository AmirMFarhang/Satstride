// The platform's side of the sandbox. It never sees a bundle in clear: it
// forwards the ciphertext to the sandbox and relays the signed result back.
// Two implementations: in-process (tests, single-laptop demo) and remote
// (the sandbox container).

import type { Reasoner } from '../ai/types.js'
import type { ChainClient } from '../chain/types.js'
import { signObject, type Hex, type KeyPair } from '../core/crypto.js'
import { decryptFrom } from '../market/messages.js'
import { runSandbox, type SandboxConfig } from './run.js'
import { validateBundle, type SandboxResult } from './types.js'

export interface Sandbox {
  pubkey(): Promise<Hex>
  run(senderPk: Hex, ciphertext: string): Promise<SandboxResult>
}

export class InProcessSandbox implements Sandbox {
  constructor(
    private readonly key: KeyPair,
    private readonly chain: ChainClient,
    private readonly reasoner: Reasoner,
    private readonly blocksPerMonth: number,
    private readonly oraclePk?: Hex,
    private readonly investigation: Pick<SandboxConfig, 'investigationContext' | 'onInvestigationStep'> = {},
  ) {}

  async pubkey(): Promise<Hex> {
    return this.key.pubkey
  }

  async run(senderPk: Hex, ciphertext: string): Promise<SandboxResult> {
    const bundle: unknown = JSON.parse(decryptFrom(this.key, senderPk, ciphertext))
    validateBundle(bundle)
    if (bundle.borrower_pk !== senderPk) throw new Error('bundle must be sent by its borrower')
    return runSandbox(bundle, { key: this.key, chain: this.chain, reasoner: this.reasoner, blocksPerMonth: this.blocksPerMonth, oraclePk: this.oraclePk, ...this.investigation })
  }
}

export class RemoteSandbox implements Sandbox {
  constructor(private readonly baseUrl: string) {}

  async pubkey(): Promise<Hex> {
    const res = await fetch(`${this.baseUrl}/pubkey`)
    if (!res.ok) throw new Error(`sandbox /pubkey: HTTP ${res.status}`)
    return ((await res.json()) as { sandbox_pk: Hex }).sandbox_pk
  }

  async run(senderPk: Hex, ciphertext: string): Promise<SandboxResult> {
    const res = await fetch(`${this.baseUrl}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender_pk: senderPk, ciphertext }),
    })
    const body = (await res.json()) as SandboxResult | { error: string }
    if (!res.ok) throw new Error(`sandbox /run: ${(body as { error: string }).error ?? res.status}`)
    return body as SandboxResult
  }
}

export const DEFAULT_SANDBOX_IMAGE_DIGEST = 'in-process'

/** Compatibility name for a platform-signed declaration of the sandbox key.
 * Per-run evidence is signed by the sandbox itself. Neither signature is a
 * hardware attestation or proof of isolation; production needs a TEE quote. */
export interface Attestation {
  sandbox_pk: Hex
  image_digest: string
  platform_pk: Hex
  issued_at: number
  assurance: 'platform-declaration-only'
  run_record: 'sandbox-signed-per-run'
  sig: Hex
}

export function attest(platform: KeyPair, sandboxPk: Hex, imageDigest: string): Attestation {
  return signObject({ sandbox_pk: sandboxPk, image_digest: imageDigest, platform_pk: platform.pubkey, issued_at: Date.now(), assurance: 'platform-declaration-only' as const, run_record: 'sandbox-signed-per-run' as const }, platform.secretKey)
}
