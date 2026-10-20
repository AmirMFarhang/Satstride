// The phone's half of the lender-paid credit check over Nostr (docs/CHECK-MARKET.md, payer mode
// lender): the check node is picked from its public offer (kind 38401), the bundle is sealed to
// its operator with a consent receipt naming the operator, the release, the data and who pays,
// the sealed history is shared after the phone's lock, and the forwarded result is opened and
// verified on the phone (signed local scorer, selected operator and v2 binding to this loan).
// The protocol is the borrower half in src/checknode/borrower-check.ts, driven step by step here
// so the approval is a human stop. There is no Lightning
// on the phone: the lender pays on its own laptop rail.
import type { Hex } from '../../../../src/core/crypto.js'
import { verifyObject } from '../../../../src/core/crypto.js'
import { KIND } from '../../../../src/market/kinds.js'
import { latestOffers, releaseHash, type CheckOffer } from '../../../../src/checknode/offer.js'
import type { CheckMessage } from '../../../../src/checknode/messages.js'
import type { PartySigner } from '../agent/ports'
import type { PhoneRelay } from '../agent/relay'
import { CHECK_RELAY_DOMAIN, CheckRefused, readRelayEvent, relayMessageAuthentic, type CheckApprovalRequest, type CheckRelayMessage, type CheckTransport } from '../../../../src/checknode/borrower-check.js'
import type { CheckSigner } from '../../../../src/checknode/signer.js'
import { WireReassembler } from '../../../../src/checknode/wire.js'

export { CheckRefused }

/** The party key as the check protocol's signer (src/checknode/signer.ts CheckSigner): the same worklet key, never exported. */
export function checkSigner(key: PartySigner): CheckSigner {
  return {
    pubkey: key.pubkey,
    signHash: (h) => key.signPassbookHash(h),
    nip44Encrypt: (peer, text) => key.nip44Encrypt(peer, text),
    nip44Decrypt: (peer, payload) => key.nip44Decrypt(peer, payload),
  }
}

export interface CheckNodeRow { offer: CheckOffer; release_hash: Hex; usable: boolean; why: string | null }

/**
 * The check nodes' current offers from the relay: signature-verified events, the latest valid
 * offer per operator (src/checknode/offer.ts latestOffers checks the schema, expiry and the
 * operator's own signature). Usable here: a scorer release the lender can pay for.
 */
export async function readCheckNodes(relay: PhoneRelay, nowS = Math.floor(Date.now() / 1000)): Promise<{ rows: CheckNodeRow[]; rejected: number }> {
  const events = await relay.list<unknown>(KIND.CHECK_OFFER)
  const { valid, rejected } = latestOffers(events.map((e) => ({ offer: e.payload, created_at: e.event.created_at, pubkey: e.event.pubkey as Hex })), nowS)
  const rows = valid.map((offer): CheckNodeRow => {
    const why = offer.release.provider !== 'in-process' ? `runs ${offer.release.provider}, unsupported scorer`
      : !offer.payer_modes.includes('lender') ? 'only the borrower can pay this node'
      : null
    return { offer, release_hash: releaseHash(offer.release), usable: why === null, why }
  })
  rows.sort((a, b) => Number(b.usable) - Number(a.usable) || a.offer.p50_seconds - b.offer.p50_seconds)
  return { rows, rejected: rejected.length }
}

/**
 * The next check message for this negotiation from the lender (as src/checknode/borrower-check.ts runBorrowerCheck reads
 * them): an authentic APPROVAL_REQUEST, or the lender-signed KEY. A REFUSED ends the wait with
 * its coded reason.
 */
export function awaitCheckMessage<T extends CheckApprovalRequest | CheckMessage>(transport: CheckTransport, signer: CheckSigner, o: { from: Hex; negotiationId: Hex; type: 'APPROVAL_REQUEST' | 'KEY'; sinceS: number; timeoutMs: number }): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false
    const seen = new Set<string>()
    // A large message (the KEY chain) arrives as hash-checked chunks under the public relays' size limit (src/checknode/wire.ts).
    const assembler = new WireReassembler()
    const finish = (f: () => void) => { if (done) return; done = true; clearTimeout(timer); stop(); f() }
    const timer = setTimeout(() => finish(() => reject(new CheckRefused('TIMEOUT: no answer from the lender'))), o.timeoutMs)
    const stop = transport.subscribe({ kinds: [KIND.CHECK_KEY], authors: [o.from], '#p': [signer.pubkey], since: o.sinceS }, (e) => {
      if (seen.has(e.id)) return
      seen.add(e.id)
      void readRelayEvent(signer, e).then((payload) => {
        const whole = assembler.feed(e.pubkey as Hex, payload)
        if (!whole) return
        const m = whole.payload as CheckRelayMessage | CheckMessage
        if (!m || m.negotiation_id !== o.negotiationId) return
        if (m.domain === CHECK_RELAY_DOMAIN) {
          const r = m as CheckRelayMessage
          if (!relayMessageAuthentic(r) || r.type === 'PART' || r.from_pk !== o.from) return
          if (r.type === 'REFUSED') finish(() => reject(new CheckRefused(`lender: ${r.reason}`)))
          else if (r.type === o.type) finish(() => resolve(r as T))
          return
        }
        const key = m as CheckMessage
        if (o.type === 'KEY' && key.type === 'KEY' && key.domain === 'passbook-check-v1' && verifyObject(key, o.from)) finish(() => resolve(key as T))
      }).catch(() => { /* not for this phone, or not readable */ })
    })
  })
}

/** The code of a refusal (borrower-check.ts reasons are "CODE: words" or "lender: CODE"). */
export function refusalCode(reason: string): string {
  const r = reason.replace(/^lender:\s*/, '')
  return (r.match(/^[A-Z][A-Z0-9_]*/)?.[0]) ?? 'REFUSED'
}

/** Words for a coded refusal, for the screen; the code is shown too. */
export function refusalWords(reason: string): string {
  const code = refusalCode(reason)
  const byLender = reason.startsWith('lender:')
  if (code === 'NOT_IN_THIS_BUILD') return 'This build of the app does not have the credit check yet.'
  if (code === 'TIMEOUT') return 'The lender did not answer in time. Nothing was paid, and your data was not opened.'
  if (code.startsWith('DRAFT') || code.startsWith('APPROVAL_REQUEST')) return "The check node's scorer contract did not match the agreed loan, so the phone did not approve it."
  if (code.startsWith('CONSENT')) return byLender ? 'The lender refused the consent receipt.' : 'The consent could not be made for this check node.'
  if (code.startsWith('OFFER') || code.startsWith('RULES') || code.startsWith('CHECK_NODE')) return "This check node does not meet the lender's rules. Pick another one."
  return byLender ? 'The lender refused the check.' : 'The check was refused.'
}
