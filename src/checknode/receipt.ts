// The check receipt: after a paid check the operator sends the borrower a
// unique RGB token (UDA) whose data holds the commitment hash, the evidence
// digest, the release hash, the operator key, the derived tier and the date:
// the receipt JSON is the token's media file and its sha256 is the token's
// details (RGB caps details at 255 characters). It holds NO result and NO
// personal data: the schema is closed and checked before issuing. The term
// sheet names its contract id next to the evidence digest
// (TermSheetScorer.check_receipt).

import { canonicalJson, hashObject, isHex, sha256Hex, type Hex } from '../core/crypto.js'
import type { RgbLightningNode } from '../rgb/lightning.js'
import type { ScorerOutcome } from '../scorer/types.js'
import type { ExecutionTier } from './tee.js'

export interface CheckReceiptData {
  v: 1
  kind: 'passbook-check-receipt'
  /** sha256(plaintext) the operator signed before payment */
  commitment: Hex
  /** hash of the evidence: the sandbox run record or the DSSE envelope */
  evidence_digest: Hex
  release_hash: Hex
  operator_pk: Hex
  tier: ExecutionTier
  /** YYYY-MM-DD, UTC */
  date: string
}

const KEYS = ['commitment', 'date', 'evidence_digest', 'kind', 'operator_pk', 'release_hash', 'tier', 'v'].join()

export function receiptDataProblems(d: unknown): string[] {
  const r = d as CheckReceiptData
  if (!r || typeof r !== 'object' || Object.keys(r).sort().join() !== KEYS) return ['RECEIPT_FIELDS: exactly v, kind, commitment, evidence_digest, release_hash, operator_pk, tier, date']
  const problems: string[] = []
  if (r.v !== 1 || r.kind !== 'passbook-check-receipt') problems.push('RECEIPT_KIND')
  for (const k of ['commitment', 'evidence_digest', 'release_hash', 'operator_pk'] as const) if (!isHex(r[k], 32)) problems.push(`RECEIPT_${k.toUpperCase()}`)
  if (r.tier !== 'software-evidence' && r.tier !== 'tee-attested') problems.push('RECEIPT_TIER')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) problems.push('RECEIPT_DATE')
  return problems
}

export function receiptDetails(d: CheckReceiptData): string {
  const problems = receiptDataProblems(d)
  if (problems.length) throw new Error(problems.join(','))
  return canonicalJson(d)
}

export const RECEIPT_TICKER = 'PBRCPT'

/** The receipt's evidence digest: the hash of the sandbox's signed run record, or of the external provider DSSE envelope. */
export function receiptEvidenceDigest(outcome: ScorerOutcome): Hex {
  return hashObject(outcome.kind === 'passbook-signed' ? outcome.result.evidence.run_record : outcome.evidence)
}

/**
 * Why a held receipt does not name this check; empty when it does. The payer compares every field with
 * what it paid for and opened (commitment, operator, release, the evidence digest of the result), and
 * the token's details with the hash of the receipt JSON, so a node cannot hand over a well-formed
 * receipt for other evidence.
 */
export function receiptProblemsFor(d: CheckReceiptData, details: string | null | undefined, expect: { commitment: Hex; operator_pk: Hex; release_hash: Hex; evidence_digest: Hex }): string[] {
  const problems = receiptDataProblems(d)
  if (problems.length) return problems
  if (d.commitment !== expect.commitment) problems.push('RECEIPT_OTHER_COMMITMENT')
  if (d.operator_pk !== expect.operator_pk) problems.push('RECEIPT_OTHER_OPERATOR')
  if (d.release_hash !== expect.release_hash) problems.push('RECEIPT_OTHER_RELEASE')
  if (d.evidence_digest !== expect.evidence_digest) problems.push('RECEIPT_OTHER_EVIDENCE')
  if (details !== receiptDetailsLine(d)) problems.push('RECEIPT_DETAILS_NOT_ITS_HASH')
  return problems
}

/** RGB caps a token's details at 255 characters: the details carry the receipt's hash, the token's media file carries the receipt. */
export function receiptDetailsLine(d: CheckReceiptData): string {
  return `passbook-check-receipt/v1 sha256:${sha256Hex(receiptDetails(d))}`
}

/**
 * Issues the UDA on the operator's RGB Lightning node and sends it on chain to
 * the borrower's RGB invoice (blinded, any asset). The receipt JSON is the
 * token's media file; its sha256 is in the token's details. Returns the
 * contract id and the transfer txid; settling needs blocks and both sides refreshing.
 */
export async function issueAndSendReceipt(operatorLn: RgbLightningNode, borrowerInvoice: string, data: CheckReceiptData): Promise<{ contract_id: string; txid: string; media_digest: string; details: string }> {
  const json = receiptDetails(data)
  const form = new FormData()
  form.append('file', new Blob([json], { type: 'application/json' }), 'passbook-check-receipt.json')
  const res = await fetch(`${operatorLn.url.replace(/\/$/, '')}/postassetmedia`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`RGB Lightning /postassetmedia: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const { digest } = await res.json() as { digest: string }
  const details = receiptDetailsLine(data)
  const { asset } = await operatorLn.request<{ asset: { asset_id: string } }>('/issueassetuda', { ticker: RECEIPT_TICKER, name: 'Passbook check receipt', details, precision: 0, media_file_digest: digest, attachments_file_digests: [] })
  const decoded = await operatorLn.request<{ recipient_id: string; transport_endpoints: string[] }>('/decodergbinvoice', { invoice: borrowerInvoice })
  const { txid } = await operatorLn.request<{ txid: string }>('/sendrgb', { donation: false, fee_rate: 1, min_confirmations: 1, skip_sync: false, recipient_map: { [asset.asset_id]: [{ recipient_id: decoded.recipient_id, assignment: { type: 'NonFungible' }, transport_endpoints: decoded.transport_endpoints }] } })
  return { contract_id: asset.asset_id, txid, media_digest: digest, details }
}

/** A UDA as an RGB Lightning node's /listassets returns it (the fields read here). */
export interface HeldUda { asset_id: string; ticker: string; details?: string | null; balance: { settled: number }; media?: { digest: string } | null; token?: { media?: { digest: string } | null } | null }

export async function heldUdas(ln: RgbLightningNode): Promise<HeldUda[]> {
  const { uda } = await ln.request<{ uda?: HeldUda[] | null }>('/listassets', { filter_asset_schemas: ['Uda'] })
  return uda ?? []
}

/** The receipt JSON in a held UDA's media file; the holder then checks what it names (receiptDataProblems and its own commitment). */
export async function readReceipt(ln: RgbLightningNode, held: HeldUda): Promise<{ data: CheckReceiptData | null; error?: string }> {
  const digest = held.token?.media?.digest ?? held.media?.digest
  if (!digest) return { data: null, error: 'the token has no media file' }
  try {
    const { bytes_hex } = await ln.request<{ bytes_hex: string }>('/getassetmedia', { digest })
    return { data: JSON.parse(Buffer.from(bytes_hex, 'hex').toString('utf8')) as CheckReceiptData }
  } catch (err) {
    return { data: null, error: (err as Error).message.slice(0, 120) }
  }
}
