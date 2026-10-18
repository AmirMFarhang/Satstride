// What the on-device borrower agent needs from the device, as interfaces. On the
// phone each one is the worklet (keys, RGB, the Electrum chain source); in the
// laptop tests the same worklet JS files run under Node. The agent itself is plain
// TypeScript over the shared protocol code in src/ and never holds a key.

import type { ChainClient } from '../../../../src/chain/types.js'
import type { Hex } from '../../../../src/core/crypto.js'

export interface NostrEvent { id: Hex; pubkey: Hex; created_at: number; kind: number; tags: string[][]; content: string; sig: Hex }

/** The borrower's party key (m/86'/1'/0'/0/0), held in the worklet. */
export interface PartySigner {
  pubkey: Hex
  btc: { address: string; script: Hex }
  signObject<T extends object>(value: T): Promise<T & { sig: Hex }>
  /** A Passbook hash the shared code computed (term-sheet hash, outstanding statement); never a Bitcoin sighash. */
  signPassbookHash(hash: Hex): Promise<Hex>
  signRequest(r: { method: string; pathAndQuery: string; timestampMs: number; nonce: string; bodySha256: Hex }): Promise<Hex>
  signEvent(t: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent>
  nip44Encrypt(peer: Hex, plaintext: string): Promise<string>
  nip44Decrypt(peer: Hex, payload: string): Promise<string>
  /** Signs the inputs spending this key's own BIP-86 output; returns the PSBT, not finalized. */
  signKeyPath(psbtBase64: string): Promise<string>
  /** The borrower's signature for input 0's single escrow leaf; the sighash is computed in the worklet. */
  signEscrowLeaf(psbtBase64: string): Promise<{ signature: Hex; signed: { locktime: number; escrow_sats: string; outputs: { script: Hex; sats: string }[] } }>
}

/** The phone's view of Bitcoin, from the laptop's electrs (a light client: it trusts the server for history). */
export interface ChainPort extends ChainClient {
  /** Unspent outputs of a script, with confirmation height (0 while unconfirmed). */
  utxos(script: Hex): Promise<{ txid: Hex; vout: number; value: number; height: number }[]>
  broadcast(hex: Hex): Promise<Hex>
}

export interface RgbTransferRow { idx: number; kind: string; status: string; txid: string | null; recipientId: string | null; amount: number }

/** The phone's rgb-lib wallet (worklet). Amounts are base units (micro-USDT). */
export interface RgbPort {
  refresh(assetId?: string | null): Promise<void>
  balance(assetId: string): Promise<{ settled: number; future: number; spendable: number }>
  transfers(assetId: string): Promise<RgbTransferRow[]>
  /** Witness invoice: the sender creates the receiving output (no colored UTXO needed here). */
  witnessInvoice(amount: number, assetId?: string | null): Promise<{ invoice: string; recipientId: string }>
  blindInvoice(amount: number, assetId?: string | null): Promise<{ invoice: string; recipientId: string }>
  /** `endpoint`: the transport endpoint rgb-lib posted the consignment to, when it records one */
  send(o: { invoice: string; assetId: string; amount: number }): Promise<{ txid: Hex; endpoint?: string | null }>
  issueNia(o: { ticker: string; name: string; precision: number; amount: number }): Promise<string>
  /** where a signed send stands (worklet sendStatus): broadcast, not seen after a sync, or unknown; rgb-lib's status for it */
  status(txid: Hex): Promise<{ state: 'broadcast' | 'not-seen' | 'unknown'; rgbStatus: string | null }>
}

/** The lender's per-loan repayment account (src/rgb/watch.ts), in the worklet: the platform watches it with xpubs only. */
export interface RepayPort {
  /** the xpubs and fingerprint of this loan's account, for the platform's watch-only copy */
  keys(loanId: Hex): Promise<{ account_xpub_vanilla: string; account_xpub_colored: string; master_fingerprint: string }>
  /** restore the platform's rgb-lib backup (base64) of its watch-only wallet into this loan's own directory */
  restore(loanId: Hex, backupB64: string, password: string): Promise<void>
  refresh(loanId: Hex, assetId?: string | null): Promise<void>
  transfers(loanId: Hex, assetId: string): Promise<RgbTransferRow[]>
  balance(loanId: Hex, assetId: string): Promise<{ settled: number; future: number; spendable: number }>
}
