// The platform's view of a repayment, validated by rgb-lib itself.
//
// rgb-lib 0.3.0-beta.8 has no stateless "validate this consignment" call: the
// native binding exports no inspect, validate or accept function. A wallet
// validates a consignment only during `refresh`, for a receive it is waiting
// for, and then reports only its own allocation. So the platform cannot check
// a consignment the borrower posts to it after the fact.
//
// What rgb-lib does allow: a wallet holds only xpubs (signing is a separate
// call with the mnemonic), so a watch-only wallet can issue a receive invoice
// and validate what arrives for it. The lender gives the platform the xpubs of a
// per-loan repayment account derived from its own seed. The platform opens a
// watch-only rgb-lib wallet on them, issues the witness invoice for principal +
// fee there, and hands the lender an rgb-lib backup of that wallet. The lender
// restores it and opens the account with its mnemonic. Both wallets now wait for
// the same receive. When the borrower pays, each fetches the consignment from the
// RGB proxy and validates it on its own. The lender keeps the only key that
// can spend the repayment. The platform's copy can only see it.
//
// Verified on regtest: the watch-only wallet and the restored owner both settle
// the same witness receive, and both ACKs to the proxy go through.

import './node-version.js' // before the native binding loads
import './native-exit.js' // its handles are finalized before node tears the isolate down
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { deriveKeysFromMnemonic, restoreFromBackup, WalletManager } from '@utexo/rgb-sdk'
import { hexToBytes, randomHex, type Hex } from '../core/crypto.js'
import { RgbWallet, rgbConfigFromEnv, type RgbConfig } from './wallet.js'

/** The public half of a repayment account: what the lender hands the platform. */
export interface WatchKeys {
  account_xpub_vanilla: string
  account_xpub_colored: string
  master_fingerprint: string
}

/** What the platform issued from its watch-only wallet. `backup` is base64 of an rgb-lib backup file. */
export interface IssuedInvoice {
  invoice: string
  recipient_id: string
  backup: string
  password: string
}

/** The receive for one invoice, as the platform's watch-only wallet sees it after a refresh. */
export interface WatchedReceive {
  recipient_id: string
  /** rgb-lib's status: 'Settled' only after the consignment validated and the witness confirmed */
  status: string
  txid: Hex | null
  /** amount of `assetId` received, in the asset's smallest unit; 0 if none of it arrived */
  amount: number
}

/** The platform depends on this, not on rgb-lib, so its rules stay testable without the native binding. */
export interface RepaymentWatcher {
  issue(loanId: Hex, keys: WatchKeys, amount: number, durationSeconds: number): IssuedInvoice
  inspect(loanId: Hex, keys: WatchKeys, recipientId: string, assetId: string): WatchedReceive | null
  close(): void
}

// rgb-sdk's WalletManager, as 1.0.3 implements it; its .d.ts is broader than what we call
interface SdkWallet {
  witnessReceive(p: { assetId?: string; amount: number; minConfirmations: number; durationSeconds: number }): { invoice: string; recipientId: string }
  createBackup(p: { backupPath: string; password: string }): { backupPath: string }
  refreshWallet(): void
  listAssets(): { nia?: { assetId?: string }[] | null }
  listTransfers(assetId?: string): RawReceive[] | null
  dispose(): void
}
interface RawReceive {
  kind: string
  status: string
  txid?: string | null
  recipientId?: string | null
  assignments?: { Fungible?: number }[]
}

/** Watch-only rgb-lib wallets, one data directory per loan under `rootDir`. Holds xpubs only. */
export class RgbRepaymentWatch implements RepaymentWatcher {
  private readonly open = new Map<Hex, SdkWallet>()

  constructor(
    readonly rootDir: string,
    readonly cfg: RgbConfig = rgbConfigFromEnv(),
  ) {}

  private wallet(loanId: Hex, keys: WatchKeys): SdkWallet {
    let w = this.open.get(loanId)
    if (!w) {
      const dataDir = join(this.rootDir, loanId)
      mkdirSync(dataDir, { recursive: true })
      w = new WalletManager({
        xpubVan: keys.account_xpub_vanilla,
        xpubCol: keys.account_xpub_colored,
        masterFingerprint: keys.master_fingerprint,
        network: this.cfg.network,
        dataDir,
        indexerUrl: this.cfg.indexerUrl,
        transportEndpoint: this.cfg.transportEndpoint,
      }) as unknown as SdkWallet
      this.open.set(loanId, w)
    }
    return w
  }

  issue(loanId: Hex, keys: WatchKeys, amount: number, durationSeconds: number): IssuedInvoice {
    const w = this.wallet(loanId, keys)
    // the watch-only wallet has never held the asset, so the invoice leaves it open; inspect() checks it
    const inv = w.witnessReceive({ amount, minConfirmations: 1, durationSeconds })
    const tmp = mkdtempSync(join(tmpdir(), 'passbook-watch-'))
    try {
      const password = randomHex(16)
      const { backupPath } = w.createBackup({ backupPath: tmp, password })
      return { invoice: inv.invoice, recipient_id: inv.recipientId, backup: readFileSync(backupPath).toString('base64'), password }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  inspect(loanId: Hex, keys: WatchKeys, recipientId: string, assetId: string): WatchedReceive | null {
    // one refresh fetches and validates the consignment (WaitingConfirmations), the next one settles it
    // if the witness is already confirmed: refresh until the status stops moving
    let last: WatchedReceive | null = null
    for (let i = 0; i < 4; i++) {
      const r = this.read(loanId, keys, recipientId, assetId)
      if (r?.status === 'Settled' || r?.status === 'Failed' || (r && last && r.status === last.status)) return r
      last = r
    }
    return last
  }

  private read(loanId: Hex, keys: WatchKeys, recipientId: string, assetId: string): WatchedReceive | null {
    const w = this.wallet(loanId, keys)
    w.refreshWallet()
    const known = (w.listAssets().nia ?? []).some((a) => a.assetId === assetId)
    const ofAsset = known ? (w.listTransfers(assetId) ?? []) : []
    const t = ofAsset.find((x) => x.recipientId === recipientId && x.kind === 'ReceiveWitness')
    if (t) return { recipient_id: recipientId, status: t.status, txid: t.txid ?? null, amount: (t.assignments ?? []).reduce((s, a) => s + (a.Fungible ?? 0), 0) }
    // nothing of this asset arrived: report what rgb-lib says about the invoice itself
    const any = (w.listTransfers() ?? []).find((x) => x.recipientId === recipientId)
    return any ? { recipient_id: recipientId, status: any.status, txid: any.txid ?? null, amount: 0 } : null
  }

  close(): void {
    for (const w of this.open.values()) w.dispose()
    this.open.clear()
  }
}

// ---- the lender's side ----

/**
 * The per-loan repayment account's mnemonic, derived from the lender's party key
 * and the loan id: recoverable from the lender's seed, unrelated to its main RGB wallet.
 */
export function repaymentMnemonic(secretKey: Uint8Array, loanId: Hex): string {
  const entropy = sha256(concatBytes(utf8ToBytes('passbook/repayment-account/v1'), secretKey, hexToBytes(loanId))).slice(0, 16)
  return entropyToMnemonic(entropy, wordlist)
}

export async function watchKeys(mnemonic: string, network: RgbConfig['network'] = 'regtest'): Promise<WatchKeys> {
  const k = await deriveKeysFromMnemonic(network, mnemonic)
  return { account_xpub_vanilla: k.accountXpubVanilla, account_xpub_colored: k.accountXpubColored, master_fingerprint: k.masterFingerprint }
}

/** Restore the platform's backup into an empty `dataDir`, then open the account with its mnemonic. */
export async function openRepaymentAccount(mnemonic: string, dataDir: string, issued: Pick<IssuedInvoice, 'backup' | 'password'>, cfg: RgbConfig = rgbConfigFromEnv()): Promise<RgbWallet> {
  mkdirSync(dataDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'passbook-restore-'))
  try {
    const file = join(tmp, 'repayment.backup')
    writeFileSync(file, Buffer.from(issued.backup, 'base64'))
    restoreFromBackup({ backupFilePath: file, password: issued.password, dataDir })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return RgbWallet.open(mnemonic, dataDir, cfg)
}
