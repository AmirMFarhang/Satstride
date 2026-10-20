// passbook-check/v1 Offer (docs/CHECK-MARKET.md). A check node announces what
// it runs and what it charges; it never announces how far it should be
// trusted. The schema is closed, so an offer with a `trust` field is malformed.
// The verifier derives trust from evidence: the release manifest for the
// scorer, attestation for the execution (tee.ts). No valid attestation means
// software evidence, whatever `execution` says.

import { hashObject, isHex, signObject, verifyObject, type Hex, type KeyPair } from '../core/crypto.js'
import { HEX32_PATTERN, HEX64_PATTERN, schemaErrors, type JsonSchema } from '../core/schema.js'
import { declarationValid, selfSignatureValid } from '../scorer/descriptor.js'
import { PROVIDER_TRUST, type ScorerProviderKind } from '../scorer/trust.js'
import type { ScorerDescriptor } from '../scorer/types.js'

export const CHECK_SERVICE = 'passbook-credit-check' as const
export const CHECK_PROTOCOL = 'passbook-check/v1' as const

/** What exactly runs: the hash of this object is the release hash a lender may pin. */
export interface CheckRelease {
  provider: Extract<ScorerProviderKind, 'in-process' | 'container'>
  /** `sha256:<image digest>` (container image) or `source:<hash>` (the sandbox code). */
  image_digest: string
  /** The Passbook scoring contract the outputs satisfy. */
  scoring_contract_hash: Hex
  /** sha256 of the model file the scorer may run, or null for the rules engine only. */
  model_hash: Hex | null
}

export const TEE_VENDORS = ['aws-nitro', 'intel-tdx', 'amd-sev-snp', 'test-vendor'] as const
export type TeeVendor = (typeof TEE_VENDORS)[number]

/** A declaration. tee.ts decides what it is worth. */
export type CheckExecution =
  | { tee: 'none' }
  | { tee: TeeVendor; attestation: string; result_key: Hex }

// bill-at-close: no payment before delivery; the fee is added to the lender's platform fee at close (bill.ts).
export const CHECK_RAILS = ['rgb-ln-hodl', 'rgb-ln-pay-then-deliver', 'rgb-onchain', 'bill-at-close'] as const
export type CheckRail = (typeof CHECK_RAILS)[number]
/** The rails a REQUEST may name: Lightning (HODL, pay-then-deliver) or bill-at-close; on-chain is not built. */
export type DeliveryRail = Exclude<CheckRail, 'rgb-onchain'>

export interface CheckAsset {
  asset_id: string
  ticker: string
  /** Base units charged for one check in this asset (a voucher is 1). */
  amount: number
  kind: 'payment' | 'voucher'
}

export interface CheckOffer {
  v: 1
  kind: 'passbook-check-offer'
  protocol: typeof CHECK_PROTOCOL
  service: typeof CHECK_SERVICE
  operator_pk: Hex
  release: CheckRelease
  /**
   * The scorer the bundle is encrypted to. Its descriptor is rebuilt from the
   * offer (scorerDescriptor): the enclave key's self-signature and, for a
   * container scorer, the operator's declaration of that key.
   */
  scorer: { scorer_id: string; enclave_pubkey?: Hex; descriptor_sig?: Hex; declaration_sig?: Hex }
  execution: CheckExecution
  /** The headline price: the first payment asset. */
  price: { asset_id: string; amount: number }
  accepted_assets: CheckAsset[]
  rails: CheckRail[]
  payer_modes: ('borrower' | 'lender')[]
  /** The operator bond is designed (docs/CHECK-BOND.md), not live. */
  bond: { status: 'designed-not-live' }
  p50_seconds: number
  max_bundle_bytes: number
  /** Seconds the operator keeps the bundle or result after answering: always 0. */
  retention: 0
  /** The operator's RGB Lightning node, for routing hints on regtest. */
  ln_node_pubkey?: string
  issued_at: number
  /** Unix seconds; an expired offer is never picked. */
  expires: number
  sig: Hex
}

const hex32: JsonSchema = { type: 'string', pattern: HEX32_PATTERN }
const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'integer', minimum, maximum })
const str = (maxLength = 200, minLength = 1): JsonSchema => ({ type: 'string', minLength, maxLength })
const obj = (properties: Record<string, JsonSchema>, optional: string[] = []): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) })
const enumOf = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] })

export const CHECK_OFFER_SCHEMA: JsonSchema = obj({
  v: { type: 'integer', const: 1 },
  kind: { type: 'string', const: 'passbook-check-offer' },
  protocol: { type: 'string', const: CHECK_PROTOCOL },
  service: { type: 'string', const: CHECK_SERVICE },
  operator_pk: hex32,
  release: obj({ provider: enumOf(['in-process', 'container']), image_digest: { type: 'string', pattern: '^(sha256|source):[0-9a-f]{64}$' }, scoring_contract_hash: hex32, model_hash: { oneOf: [hex32, { type: 'null' }] } }),
  scorer: obj({ scorer_id: str(100), enclave_pubkey: hex32, descriptor_sig: { type: 'string', pattern: HEX64_PATTERN }, declaration_sig: { type: 'string', pattern: HEX64_PATTERN } }, ['enclave_pubkey', 'descriptor_sig', 'declaration_sig']),
  execution: { oneOf: [obj({ tee: { type: 'string', const: 'none' } }), obj({ tee: enumOf(TEE_VENDORS), attestation: str(20_000), result_key: hex32 })] },
  price: obj({ asset_id: str(), amount: int(1) }),
  accepted_assets: { type: 'array', minItems: 1, maxItems: 8, items: obj({ asset_id: str(), ticker: str(16), amount: int(1), kind: enumOf(['payment', 'voucher']) }) },
  rails: { type: 'array', minItems: 1, maxItems: 4, items: enumOf(CHECK_RAILS) },
  payer_modes: { type: 'array', minItems: 1, maxItems: 2, items: enumOf(['borrower', 'lender']) },
  bond: obj({ status: { type: 'string', const: 'designed-not-live' } }),
  p50_seconds: int(1, 86_400),
  max_bundle_bytes: int(1, 60_000),
  retention: { type: 'integer', const: 0 },
  ln_node_pubkey: { type: 'string', pattern: '^0[23][0-9a-f]{64}$' },
  issued_at: int(),
  expires: int(),
  sig: { type: 'string', pattern: HEX64_PATTERN },
}, ['ln_node_pubkey'])

export type UnsignedOffer = Omit<CheckOffer, 'v' | 'kind' | 'protocol' | 'service' | 'operator_pk' | 'retention' | 'bond' | 'sig'>

export function signOffer(operator: KeyPair, input: UnsignedOffer): CheckOffer {
  const offer = signObject({ v: 1 as const, kind: 'passbook-check-offer' as const, protocol: CHECK_PROTOCOL, service: CHECK_SERVICE, operator_pk: operator.pubkey, retention: 0 as const, bond: { status: 'designed-not-live' as const }, ...input }, operator.secretKey)
  const problems = offerProblems(offer, offer.issued_at)
  if (problems.length) throw new Error(`invalid check offer: ${problems.join(', ')}`)
  return offer
}

/** Empty when the offer is well formed, signed by its operator and unexpired at `now`. */
export function offerProblems(offer: unknown, now: number): string[] {
  const errors = schemaErrors(offer, CHECK_OFFER_SCHEMA)
  if (errors.length) return errors.slice(0, 5).map((e) => `OFFER_SCHEMA ${e}`)
  const o = offer as CheckOffer
  const problems: string[] = []
  if (!verifyObject(o, o.operator_pk)) problems.push('OFFER_SIGNATURE')
  if (o.expires <= now) problems.push('OFFER_EXPIRED')
  if (o.issued_at > now + 300) problems.push('OFFER_FROM_THE_FUTURE')
  const payment = o.accepted_assets.find((a) => a.kind === 'payment')
  if (!payment || payment.asset_id !== o.price.asset_id || payment.amount !== o.price.amount) problems.push('OFFER_PRICE_NOT_FIRST_PAYMENT_ASSET')
  if (o.accepted_assets.some((a) => a.kind === 'voucher' && a.amount !== 1)) problems.push('OFFER_VOUCHER_NOT_ONE_UNIT')
  if (new Set(o.accepted_assets.map((a) => a.asset_id)).size !== o.accepted_assets.length) problems.push('OFFER_DUPLICATE_ASSET')
  const sandbox = true
  if (sandbox && (!o.scorer.enclave_pubkey || !o.scorer.descriptor_sig)) problems.push('OFFER_SCORER_KEY')
  if (sandbox && o.scorer.enclave_pubkey && o.scorer.descriptor_sig && !selfSignatureValid(scorerDescriptor(o))) problems.push('OFFER_SCORER_SIGNATURE')
  if (o.release.provider === 'container' && !(o.scorer.declaration_sig && declarationValid(scorerDescriptor(o)))) problems.push('OFFER_OPERATOR_DECLARATION')
  // A bill is the lender's: only a lender pays at close, through the platform fee it already owes.
  if (o.rails.includes('bill-at-close') && !o.payer_modes.includes('lender')) problems.push('OFFER_BILL_NEEDS_LENDER_PAYER')
  return problems
}

/** The hash a lender pins in `accepted_releases`. */
export function releaseHash(r: CheckRelease): Hex {
  return hashObject({ domain: 'passbook-check-release-v1', ...r })
}

export function offerHash(o: CheckOffer): Hex {
  return hashObject(o)
}

/**
 * The scorer descriptor the offer stands for. `trust` is the provider kind's
 * ceiling (trust.ts), not a claim from the offer; verify.ts caps it further by
 * the release manifest.
 */
export function scorerDescriptor(o: Pick<CheckOffer, 'release' | 'scorer' | 'operator_pk'>): ScorerDescriptor {
  const core: ScorerDescriptor = { v: 1, provider: o.release.provider, scorer_id: o.scorer.scorer_id, trust: PROVIDER_TRUST[o.release.provider], code_measurement: o.release.image_digest, contract_hash: o.release.scoring_contract_hash }
  if (o.scorer.enclave_pubkey) core.enclave_pubkey = o.scorer.enclave_pubkey
  if (o.scorer.descriptor_sig) core.sig = o.scorer.descriptor_sig
  if (o.scorer.declaration_sig) core.operator_declaration = { operator_pk: o.operator_pk, sig: o.scorer.declaration_sig }
  return core
}

/** From the engine's own self-signed descriptor to the offer's scorer field; refuses a descriptor whose trust is not the provider ceiling. */
export function scorerFromDescriptor(d: ScorerDescriptor): CheckOffer['scorer'] {
  if (d.trust !== PROVIDER_TRUST[d.provider]) throw new Error('the scorer descriptor claims a trust other than its provider ceiling')
  return { scorer_id: d.scorer_id, ...(d.enclave_pubkey ? { enclave_pubkey: d.enclave_pubkey } : {}), ...(d.sig ? { descriptor_sig: d.sig } : {}), ...(d.operator_declaration ? { declaration_sig: d.operator_declaration.sig } : {}) }
}

/** The latest valid offer per operator; relays may return replaced versions. */
export function latestOffers(offers: { offer: unknown; created_at: number; pubkey: Hex }[], now: number): { valid: CheckOffer[]; rejected: { operator_pk: string; problems: string[] }[] } {
  const latest = new Map<string, { offer: unknown; created_at: number; pubkey: Hex }>()
  for (const o of offers) {
    const prev = latest.get(o.pubkey)
    if (!prev || o.created_at > prev.created_at) latest.set(o.pubkey, o)
  }
  const valid: CheckOffer[] = []
  const rejected: { operator_pk: string; problems: string[] }[] = []
  for (const { offer, pubkey } of latest.values()) {
    const problems = offerProblems(offer, now)
    if (!problems.length && (offer as CheckOffer).operator_pk !== pubkey) problems.push('OFFER_NOT_FROM_EVENT_AUTHOR')
    if (problems.length) rejected.push({ operator_pk: isHex(pubkey, 32) ? pubkey : '?', problems })
    else valid.push(offer as CheckOffer)
  }
  return { valid, rejected }
}
