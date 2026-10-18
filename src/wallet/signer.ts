// The Signer port. Protocol signatures (policies, negotiation messages, term
// sheets, approvals, consent receipts) go through this interface, so the key
// can live in a WDK wallet (demo), an HSM or an MPC custodian. Only the
// WDK-derived signer is implemented; HSM and MPC are documented designs.

import { schnorr } from '@noble/curves/secp256k1.js'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { bytesToHex, hashObject, signHash, verifyHash, type Hex, type KeyPair } from '../core/crypto.js'

/** Same path as wallet/party.ts PARTY_KEY_PATH; kept here so the port loads no RGB code. */
const PARTY_KEY_PATH = "m/86'/1'/0'/0/0"

/** The party key of a WDK seed phrase (for operator tools that act for a node, such as the kill switch). */
export function partyKeyFromSeed(seedPhrase: string): KeyPair {
  return partyKey(seedPhrase)
}

function partyKey(seedPhrase: string): KeyPair {
  if (!validateMnemonic(seedPhrase, wordlist)) throw new Error('not a valid BIP-39 seed phrase')
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(seedPhrase)).derive(PARTY_KEY_PATH)
  if (!node.privateKey) throw new Error('no private key at the party path')
  return { secretKey: node.privateKey, pubkey: bytesToHex(schnorr.getPublicKey(node.privateKey)) }
}

export interface Signer {
  readonly kind: 'wdk' | 'local-key' | 'hsm' | 'mpc'
  /** x-only BIP-340 public key */
  readonly pubkey: Hex
  /** BIP-340 Schnorr over a 32-byte hash */
  signHash(hashHex: Hex): Promise<Hex>
}

/** The party key at m/86'/1'/0'/0/0 of a WDK seed, as used by the agents. */
export class WdkSigner implements Signer {
  readonly kind = 'wdk' as const
  readonly pubkey: Hex
  readonly #key: KeyPair
  constructor(seedPhrase: string) {
    this.#key = partyKey(seedPhrase)
    this.pubkey = this.#key.pubkey
  }
  async signHash(hashHex: Hex): Promise<Hex> {
    return signHash(hashHex, this.#key.secretKey)
  }
}

/** A key already in memory (tests and labelled demo keys). */
export class LocalKeySigner implements Signer {
  readonly kind = 'local-key' as const
  readonly pubkey: Hex
  readonly #key: KeyPair
  constructor(key: KeyPair) {
    this.#key = key
    this.pubkey = key.pubkey
  }
  async signHash(hashHex: Hex): Promise<Hex> {
    return signHash(hashHex, this.#key.secretKey)
  }
}

/** Same result as core/crypto signObject: the signature covers every field except `sig`. */
export async function signWith<T extends object>(signer: Signer, value: T): Promise<T & { sig: Hex }> {
  const { sig: _ignored, ...rest } = value as T & { sig?: Hex }
  return { ...(rest as T), sig: await signer.signHash(hashObject(rest)) }
}

export function verifySigned<T extends { sig?: Hex }>(value: T, pubkey: Hex): boolean {
  const { sig, ...rest } = value
  return typeof sig === 'string' && verifyHash(sig, hashObject(rest), pubkey)
}

// ---- What you see is what you sign: the signing guard ----
//
// Every transaction signature a governed node makes passes here first: the
// escrow PSBT signers (escrow.ts signLeaf / signKeyPath) and the RGB send
// (rgb/wallet.ts). A signer key or wallet is enrolled once with the public key
// of its node's policy gate (src/governance/gate.ts); from then on, in this
// process, it signs only with a gate token that the gate signed for exactly the
// decoded transaction about to be signed. The token is single use and short
// lived. Enrolment cannot be undone or moved to another gate. Keys that were
// never enrolled (unit tests of script mechanics, the regtest seeder) are
// outside governance, and the gate's docs say so.

export type GovernedAction = 'lock' | 'fund' | 'repay' | 'release' | 'liquidate' | 'fee-payment' | 'iou-transfer' | 'wallet-send' | 'policy-change' | 'key-change'
export const GOVERNED_ACTIONS: readonly GovernedAction[] = ['lock', 'fund', 'repay', 'release', 'liquidate', 'fee-payment', 'iou-transfer', 'wallet-send', 'policy-change', 'key-change']

export interface GateToken {
  v: 1
  domain: 'passbook-gate-token-v1'
  action_id: string
  action: GovernedAction
  /** Who will sign: `key:<x-only pk>` for a Taproot key, `rgb:<wallet id>` for an RGB wallet. */
  signer: string
  /** summaryHash of the decoded transaction the decision and its approvals cover. */
  decoded_hash: Hex
  policy_version: number
  issued_at: number
  expires_at: number
  gate_pk: Hex
  sig: Hex
}

export class SigningRefused extends Error {
  constructor(readonly code: 'NO_GATE_TOKEN' | 'TOKEN_SIGNATURE' | 'TOKEN_FOR_ANOTHER_SIGNER' | 'DECODED_HASH_MISMATCH' | 'TOKEN_EXPIRED' | 'TOKEN_REUSED', message: string) {
    super(message)
    this.name = 'SigningRefused'
  }
}

/** The hash an approval signs and a gate token binds: the decoded transaction, never the raw bytes alone. */
export function summaryHash(summary: unknown): Hex {
  return hashObject({ domain: 'passbook-wysiwys-v1', summary })
}

export const keySignerId = (xonlyPk: Hex): string => `key:${xonlyPk}`

const enrolled = new Map<string, Hex>()
const spent = new Set<string>()
/** The gate's durable ledger for its tokens. */
export interface SignatureLedger {
  /** Mark the token used, before signing. False when it was already used: it stays used across restarts and failures. */
  spend(token: GateToken): boolean
  /** After the attempt: commit the reservation and log the signature, or give the reservation back and log the failure. */
  settle(token: GateToken, outcome: { signed: true } | { signed: false; error: string }): void
}

/** What the signing code reports back once it has (or has not) signed. */
export interface SignatureTicket {
  signed(): void
  failed(error: unknown): void
}

const NO_TICKET: SignatureTicket = { signed() {}, failed() {} }
const ledgers = new Map<Hex, SignatureLedger>()

/** Put a signer under a gate. Idempotent for the same gate; a second gate is refused. */
export function enrollSigner(signer: string, gatePk: Hex): void {
  const current = enrolled.get(signer)
  if (current && current !== gatePk) throw new Error(`${signer.slice(0, 20)}… is already governed by another gate`)
  enrolled.set(signer, gatePk)
}

export function signerGate(signer: string): Hex | undefined {
  return enrolled.get(signer)
}

/** The gate registers its ledger: every token it issued is spent through it, and every attempt settled with it. */
export function onGovernedSignature(gatePk: Hex, ledger: SignatureLedger): void {
  ledgers.set(gatePk, ledger)
}

/**
 * Called by the signing code right before it signs. Throws SigningRefused for
 * an enrolled signer without a valid, unspent token for this exact decoded
 * transaction. The token is spent here, so it can never be used twice; the
 * caller then reports the outcome on the returned ticket, and only a real
 * signature commits the reservation and is logged as signed. A signer outside
 * governance gets a ticket that does nothing.
 */
export function authorizeSignature(signer: string, summary: unknown, token: GateToken | undefined, now = Math.floor(Date.now() / 1000)): SignatureTicket {
  const gatePk = enrolled.get(signer)
  if (!gatePk) return NO_TICKET
  if (!token) throw new SigningRefused('NO_GATE_TOKEN', `refusing to sign: no gate token for ${signer.slice(0, 20)}…; every governed signature needs the policy gate's decision`)
  if (token.domain !== 'passbook-gate-token-v1' || token.gate_pk !== gatePk || !verifySigned(token, gatePk)) throw new SigningRefused('TOKEN_SIGNATURE', 'refusing to sign: the gate token is not signed by this signer\'s gate')
  if (token.signer !== signer) throw new SigningRefused('TOKEN_FOR_ANOTHER_SIGNER', 'refusing to sign: the gate token names another signer')
  const decoded = summaryHash(summary)
  if (token.decoded_hash !== decoded) throw new SigningRefused('DECODED_HASH_MISMATCH', `refusing to sign: the decoded transaction ${decoded.slice(0, 12)}… differs from the approved summary ${token.decoded_hash.slice(0, 12)}…`)
  if (now > token.expires_at) throw new SigningRefused('TOKEN_EXPIRED', 'refusing to sign: the gate token expired')
  const use = `${token.action_id}:${token.decoded_hash}:${signer}`
  const ledger = ledgers.get(gatePk)
  if (spent.has(use) || ledger?.spend(token) === false) throw new SigningRefused('TOKEN_REUSED', 'refusing to sign: this gate token was already used')
  spent.add(use)
  let settled = false
  return {
    signed: () => { if (!settled) { settled = true; ledger?.settle(token, { signed: true }) } },
    failed: (error) => { if (!settled) { settled = true; ledger?.settle(token, { signed: false, error: error instanceof Error ? error.message : String(error) }) } },
  }
}
