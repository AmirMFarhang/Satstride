// The phone lender's party key as the shared protocols take it: the session's check signer
// (src/app/credit-check.ts checkSigner, the same object the borrower flow uses) plus whole-event
// signing by the worklet, as borrow-flow.ts passes it to the negotiation. On a public network
// every event it signs whole carries the test-data labels (src/assistant/protocol.ts
// testDataTags: ['network', n], ['alt', 'Passbook test data …']), so nothing on a public relay
// can pass for real USDT. The key never leaves the worklet; this object only forwards.
import type { NegotiationSigner } from '../../../../src/market/negotiate-nostr.js'
import type { CheckSigner } from '../../../../src/checknode/signer.js'
import { testDataTags } from '../../../../src/assistant/protocol.js'
import { checkSigner } from '../app/credit-check'
import type { PartySigner } from '../agent/ports'

export type LenderSigner = NegotiationSigner & CheckSigner

/** Labels for a public network's events; none on regtest (a local relay). */
export function publicLabels(network: string | null | undefined): string[][] {
  return network && network !== 'regtest' ? testDataTags(network) : []
}

export function lenderSigner(key: Pick<PartySigner, 'pubkey' | 'signPassbookHash' | 'nip44Encrypt' | 'nip44Decrypt' | 'signEvent'>, network?: string | null): LenderSigner {
  const labels = publicLabels(network)
  return {
    ...checkSigner(key as PartySigner),
    signEvent: (t) => key.signEvent(labels.length ? { ...t, tags: [...t.tags, ...labels.filter((l) => !t.tags.some((x) => x[0] === l[0]))] } : t),
  }
}
