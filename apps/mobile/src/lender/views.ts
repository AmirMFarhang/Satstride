// What the Lend screens show of the negotiated desk, computed without React Native so the
// tests read the same words: the live transcript from this lender's side (D1's negotiation
// model, with "you" the lender), where each negotiation stands, and the check nodes that
// offer a check billed at close in the loan's asset.
import type { Hex } from '../../../../src/core/crypto.js'
import type { NegotiationMessage } from '../../../../src/market/negotiate-engine.js'
import type { CheckOffer } from '../../../../src/checknode/offer.js'
import { releaseHash } from '../../../../src/checknode/offer.js'
import { aprText, negotiationPicture } from '../motion/negotiation-model'
import type { NegotiationRecord, SheetProposal } from './review'
import { usdt } from '../../../../src/core/money.js'

export interface TranscriptLine { key: string; seq: number; who: 'You' | 'Borrower'; text: string; sig: string }

/** The signed messages as this lender reads them: its own are "You". */
export function lenderTranscript(messages: readonly NegotiationMessage[], borrowerPk: string): { lines: TranscriptLine[]; end: string | null; problems: string[] } {
  const pic = negotiationPicture(messages, borrowerPk)
  const lines = pic.cards.map((c): TranscriptLine => {
    const who = c.from === 'you' ? 'Borrower' : 'You'
    const p = c.position
    const text = c.type === 'ASK' ? (p ? `asks for ${aprText(p.apr_bps)} a year at ${aprText(p.ltv_bps)} LTV` : 'asks')
      : c.type === 'OFFER' ? (p ? `${who === 'You' ? 'offer' : 'offers'} ${aprText(p.apr_bps)} at ${aprText(p.ltv_bps)} LTV` : 'offer')
      : c.type === 'COUNTER' ? (p ? `${who === 'You' ? 'counter' : 'counters'} at ${aprText(p.apr_bps)}, ${aprText(p.ltv_bps)} LTV` : 'counter')
      : c.type === 'ACCEPT' ? (p ? `${who === 'You' ? 'accept' : 'accepts'} ${aprText(p.apr_bps)} at ${aprText(p.ltv_bps)} LTV` : 'accept')
      : c.type === 'NO_DEAL' ? `${who === 'You' ? 'end' : 'ends'} it (${c.reason || 'no deal'})`
      : c.type === 'TERMSHEET' ? 'term sheet' : 'approved'
    return { key: c.key, seq: c.seq, who, text, sig: c.sig }
  })
  const e = pic.end
  const end = e.kind === 'accept' ? `Agreed at ${aprText(e.position.apr_bps)} a year` : e.kind === 'no_deal' ? `No deal (${e.reason || 'no reason given'})` : null
  return { lines, end, problems: pic.problems }
}

export type DeskPhase = 'negotiating' | 'no-deal' | 'checking' | 'check-refused' | 'not-qualified' | 'waiting-application' | 'sheet' | 'sent'

const STAGE_WORDS: Record<string, string> = {
  'waiting-part': 'Waiting for their sealed history',
  part: 'Their sealed history arrived',
  requested: 'Asked the check node',
  approval: 'They approve the check node\'s contract',
  running: 'The check node runs the check',
  result: 'Opening the result on this phone',
  forwarded: 'Result opened; key sent to them',
  refused: 'The check was refused',
}

/** Where one negotiation stands, in words. */
export function deskPhase(r: NegotiationRecord, proposals: Record<Hex, SheetProposal> = {}, loans: Record<Hex, { negotiation_id?: Hex }> = {}): { phase: DeskPhase; words: string } {
  if (Object.values(loans).some((l) => l.negotiation_id === r.negotiation_id)) return { phase: 'sent', words: 'Term sheet approved and sent' }
  if (Object.values(proposals).some((p) => p.negotiation_id === r.negotiation_id)) return { phase: 'sheet', words: 'Term sheet waiting for your approval' }
  if (r.outcome === 'open') return { phase: 'negotiating', words: `Negotiating · ${r.messages.length} signed message${r.messages.length === 1 ? '' : 's'}` }
  if ('no_deal' in r.outcome) return { phase: 'no-deal', words: `No deal (${r.outcome.no_deal})` }
  if (r.check_error) return { phase: 'check-refused', words: `Check refused: ${r.check_error.replace(/^check refused: /, '').slice(0, 80)}` }
  if (r.check) {
    if (r.check.refusals.length) return { phase: 'not-qualified', words: `${r.check.recommendation ?? 'Not verified'} · not funded` }
    return { phase: 'waiting-application', words: 'QUALIFY · waiting for their application' }
  }
  return { phase: 'checking', words: STAGE_WORDS[r.check_stage ?? 'waiting-part'] ?? 'Credit check' }
}

export interface CheckNodeRow { operator_pk: Hex; release_hash: Hex; price: number; usable: boolean; why: string | null; label: string }

/** The check nodes' offers that can run a check billed at close for this lender, in this asset. */
export function billedCheckNodes(offers: CheckOffer[], assetId: string, unit: string): CheckNodeRow[] {
  return offers.map((o): CheckNodeRow => {
    const why = !o.rails.includes('bill-at-close' as never) ? 'does not bill at close'
      : !o.payer_modes.includes('lender') ? 'only the borrower can pay it'
      : o.price.asset_id !== assetId ? 'prices the check in another asset'
      : o.release.provider !== 'in-process' ? `runs ${o.release.provider}, unsupported scorer`
      : null
    return { operator_pk: o.operator_pk, release_hash: releaseHash(o.release), price: o.price.amount, usable: why === null, why, label: `Check node ${o.operator_pk.slice(0, 6)} · ${usdt(o.price.amount).replace(/ ?USDT$/, '')} ${unit} billed at close` }
  }).sort((a, b) => Number(b.usable) - Number(a.usable) || a.price - b.price)
}
