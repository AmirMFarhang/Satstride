import type { Hex, KeyPair } from '../core/crypto.js'
import { type ConsentReceipt } from '../scorer/consent.js'
import type { SandboxScorerEngine } from '../scorer/providers.js'
import type { EncryptedCheckRequest, ScorerDescriptor, ScorerOutcome, SignedCheckResult } from '../scorer/types.js'
import type { CheckRelease } from './offer.js'

/** What the node lends an engine for one request. */
export interface EngineContext {
  /** Generic engine request context. */
  operator: KeyPair
  /** Generic engine request context. */
  approve?: (draft: unknown) => Promise<Hex>
}

export interface CheckEngine {
  /** Shown on every screen that names the node's scorer. */
  readonly label: string
  readonly fallback: boolean
  descriptor(): ScorerDescriptor
  release(): CheckRelease
  run(req: EncryptedCheckRequest, consent: ConsentReceipt, ctx: EngineContext): Promise<ScorerOutcome>
}

export const CONTAINER_FALLBACK_LABEL = 'container scorer (explicit fallback)'

/** The Passbook sandbox behind the scoring contract, in the node's own process. */
export class SandboxCheckEngine implements CheckEngine {
  constructor(private readonly engine: SandboxScorerEngine, private readonly opts: { label: string; fallback: boolean; modelHash: Hex | null }) {}
  get label() { return this.opts.label }
  get fallback() { return this.opts.fallback }
  descriptor(): ScorerDescriptor { return this.engine.descriptor() }
  release(): CheckRelease {
    const d = this.engine.descriptor()
    return { provider: d.provider as CheckRelease['provider'], image_digest: d.code_measurement, scoring_contract_hash: d.contract_hash, model_hash: this.opts.modelHash }
  }
  async run(req: EncryptedCheckRequest, consent: ConsentReceipt, _ctx: EngineContext): Promise<ScorerOutcome> {
    return { kind: 'passbook-signed', descriptor: this.engine.descriptor(), result: await this.engine.handle(req, consent), fallback: this.opts.fallback }
  }
}

/** The container scorer over HTTP (src/scorer/server.ts, infra/Dockerfile.scorer). */
export class ContainerCheckEngine implements CheckEngine {
  readonly label = CONTAINER_FALLBACK_LABEL
  readonly fallback = true
  private constructor(private readonly url: string, private readonly d: ScorerDescriptor, private readonly modelHash: Hex | null) {}

  static async connect(url: string, modelHash: Hex | null = null): Promise<ContainerCheckEngine> {
    const res = await fetch(`${url.replace(/\/$/, '')}/descriptor`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`container scorer ${url}: HTTP ${res.status}`)
    return new ContainerCheckEngine(url.replace(/\/$/, ''), await res.json() as ScorerDescriptor, modelHash)
  }

  descriptor(): ScorerDescriptor { return this.d }
  release(): CheckRelease {
    return { provider: 'container', image_digest: this.d.code_measurement, scoring_contract_hash: this.d.contract_hash, model_hash: this.modelHash }
  }
  async run(req: EncryptedCheckRequest, consent: ConsentReceipt, _ctx: EngineContext): Promise<ScorerOutcome> {
    const res = await fetch(`${this.url}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: req, consent }), signal: AbortSignal.timeout(300_000) })
    const body = await res.json() as SignedCheckResult | { error: string }
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `container scorer HTTP ${res.status}`)
    return { kind: 'passbook-signed', descriptor: this.d, result: body as SignedCheckResult, fallback: true }
  }
}

