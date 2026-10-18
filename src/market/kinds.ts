// Nostr event kinds. Addressable kinds (30000-39999) for the order book, where
// a lender replaces its own offer by republishing with the same `d` tag;
// regular kinds with NIP-44 content for anything between two parties.

export const KIND = {
  /** lender, public, addressable: a standing loan offer */
  OFFER: 38388,
  NOTE_SALE: 38390,
  NOTE_ISSUED: 7480,
  NOTE_BUY: 7481,
  NOTE_PRICE: 7482,
  NOTE_PAID: 7483,
  NOTE_ASSIGNED: 7484,
  NOTE_OWNER: 7485,
  NOTE_RETURNED: 7486,
  REPAYMENT_RECEIPT: 7487,
  ATOMIC_REPAID: 7488,
  /** borrower, public, addressable: a standing loan request (optional) */
  REQUEST: 38389,
  /** borrower -> lender, encrypted: sandbox result + approved disclosure */
  APPLICATION: 7470,
  /** lender -> borrower, encrypted: final terms + lender escrow pubkey */
  ACCEPTANCE: 7471,
  /** either -> counterparty, encrypted: a PSBT to co-sign */
  SIGN_REQUEST: 7472,
  /** counterparty -> requester, encrypted: a signature or a refusal */
  SIGNATURE: 7473,
  /** lender -> borrower, encrypted: disbursement txid */
  FUNDED: 7474,
  /** borrower -> lender, encrypted: repayment txid */
  REPAID: 7475,
  /** platform, public: margin call on a loan */
  MARGIN_CALL: 7476,
  /** Negotiation (src/market/negotiate.ts): a hash-chained, signed message each. ASK is public; the rest are encrypted to the counterparty. */
  NEG_ASK: 7490,
  NEG_OFFER: 7491,
  NEG_COUNTER: 7492,
  NEG_ACCEPT: 7493,
  NEG_NO_DEAL: 7494,
  NEG_TERMSHEET: 7495,
  NEG_APPROVED: 7496,
  /** Check market, passbook-check/v1 (src/checknode, docs/CHECK-MARKET.md). OFFER is public and addressable per operator; the rest are encrypted to the counterparty. */
  CHECK_OFFER: 38401,
  CHECK_REQUEST: 7530,
  CHECK_FEEDBACK: 7531,
  CHECK_RESULT: 7532,
  CHECK_KEY: 7533,
  /** The agent on call, passbook-assist/v1 (src/assistant/protocol.ts): help text and an allowlisted navigation, never money. ASK and REPLY are encrypted to the counterparty; INFO is public and addressable per assistant key. */
  ASSIST_ASK: 7540,
  ASSIST_REPLY: 7541,
  ASSIST_INFO: 38540,
  /** The platform API over Nostr, passbook-platform-nostr/v1 (src/server/nostr-api.ts): a party's signed HTTP request and the platform's answer, encrypted between the two; INFO is public and addressable per platform key. */
  PLATFORM_REQUEST: 7550,
  PLATFORM_RESPONSE: 7551,
  PLATFORM_INFO: 38550,
} as const

export const ENCRYPTED_KINDS: ReadonlySet<number> = new Set([
  KIND.NOTE_ISSUED, KIND.NOTE_BUY, KIND.NOTE_PRICE, KIND.NOTE_PAID, KIND.NOTE_ASSIGNED, KIND.NOTE_OWNER, KIND.NOTE_RETURNED, KIND.REPAYMENT_RECEIPT,
  KIND.APPLICATION,
  KIND.ACCEPTANCE,
  KIND.SIGN_REQUEST,
  KIND.SIGNATURE,
  KIND.FUNDED,
  KIND.REPAID,
  KIND.ATOMIC_REPAID,
  KIND.NEG_OFFER,
  KIND.NEG_COUNTER,
  KIND.NEG_ACCEPT,
  KIND.NEG_NO_DEAL,
  KIND.NEG_TERMSHEET,
  KIND.NEG_APPROVED,
  KIND.CHECK_REQUEST,
  KIND.CHECK_FEEDBACK,
  KIND.CHECK_RESULT,
  KIND.CHECK_KEY,
  KIND.ASSIST_ASK,
  KIND.ASSIST_REPLY,
  KIND.PLATFORM_REQUEST,
  KIND.PLATFORM_RESPONSE,
])

export const TOPIC = 'passbook'

export function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000
}
