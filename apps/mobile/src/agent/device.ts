// The device ports (ports.ts) over the worklet's Passbook module. On the phone the
// module is useModule('passbook') (calls cross into the Bare worklet); in the laptop
// tests it is worklet/index.js constructed directly under Node. Same method names,
// same results, so the agent runs the same code in both.

import * as bitcoin from 'bitcoinjs-lib'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { Hex } from '../../../../src/core/crypto.js'
import type { ChainTx } from '../../../../src/chain/types.js'
import type { ChainPort, NostrEvent, PartySigner, RepayPort, RgbPort, RgbTransferRow } from './ports'

export interface PassbookModuleCalls {
  info(): Promise<{ fingerprint: string; party: { pubkey: Hex; btc: { address: string; script: Hex } } }>
  partySignObject(value: object): Promise<object & { sig: Hex }>
  partySignPassbookHash(hash: Hex): Promise<Hex>
  partySignRequest(r: object): Promise<Hex>
  partySignEvent(t: object): Promise<NostrEvent>
  partyNip44Encrypt(peer: Hex, plaintext: string): Promise<string>
  partyNip44Decrypt(peer: Hex, payload: string): Promise<string>
  partySignKeyPath(psbt: string): Promise<string>
  partySignEscrowLeaf(psbt: string): Promise<{ signature: Hex; signed: { locktime: number; escrow_sats: string; outputs: { script: Hex; sats: string }[] } }>
  chainHeight(): Promise<number>
  chainUtxos(script: Hex): Promise<{ tx_hash: Hex; tx_pos: number; value: number; height: number }[]>
  chainHistory(script: Hex): Promise<{ tx_hash: Hex; height: number }[]>
  chainRawTx(txid: Hex): Promise<Hex>
  chainBroadcast(hex: Hex): Promise<Hex>
  rgbRefresh(o: { assetId?: string | null }): Promise<unknown>
  rgbAssets(): Promise<{ assetId: string; balance: { settled: number; future: number; spendable: number } }[]>
  rgbTransfers(o: { assetId?: string }): Promise<RgbTransferRow[]>
  rgbWitnessReceive(o: { assetId?: string | null; amount: number }): Promise<{ invoice: string; recipientId: string }>
  rgbBlindReceive(o: { assetId?: string | null; amount: number; durationSeconds?: number }): Promise<{ invoice: string; recipientId: string }>
  rgbSend(o: { invoice: string; assetId: string; amount: number }): Promise<{ txid: Hex; endpoint?: string | null }>
  rgbIssueNia(o: { ticker: string; name: string; precision: number; amount: number }): Promise<string>
  rgbSendStatus(o: { txid: Hex }): Promise<{ state: 'broadcast' | 'not-seen' | 'unknown'; rgbStatus: string | null }>
  /** REGTEST TEST DATA: restore the seeded test persona's rgb-lib backup beside this wallet's own */
  rgbRestoreBackup(o: { backupPath: string; password: string; fingerprint: string }): Promise<boolean>
}

/** The worklet's lender calls (M6): the per-loan repayment accounts. */
export interface LenderModuleCalls {
  lenderRepayKeys(loanId: Hex): Promise<{ account_xpub_vanilla: string; account_xpub_colored: string; master_fingerprint: string }>
  lenderRepayRestore(o: { loanId: Hex; backupPath: string; password: string }): Promise<boolean>
  lenderRepayRefresh(o: { loanId: Hex; assetId?: string | null }): Promise<unknown>
  lenderRepayTransfers(o: { loanId: Hex; assetId: string }): Promise<RgbTransferRow[]>
  lenderRepayAssets(o: { loanId: Hex }): Promise<{ assetId: string; balance: { settled: number; future: number; spendable: number } }[]>
}

/**
 * The repayment accounts over the worklet. rgb-lib restores a backup from a file, so the app
 * (expo-file-system) or a test (node:fs) writes the platform's backup, makes the loan's empty directory
 * under loansDir (rgb-lib restores into an existing one) and returns the backup's path.
 */
export function repayPort(m: LenderModuleCalls, writeBackup: (loanId: Hex, bytesB64: string) => Promise<string>): RepayPort {
  return {
    keys: (loanId) => m.lenderRepayKeys(loanId),
    async restore(loanId, backupB64, password) {
      const backupPath = await writeBackup(loanId, backupB64)
      await m.lenderRepayRestore({ loanId, backupPath, password })
    },
    refresh: async (loanId, assetId) => { await m.lenderRepayRefresh({ loanId, assetId: assetId ?? null }) },
    transfers: (loanId, assetId) => m.lenderRepayTransfers({ loanId, assetId }),
    async balance(loanId, assetId) {
      return (await m.lenderRepayAssets({ loanId })).find((a) => a.assetId === assetId)?.balance ?? { settled: 0, future: 0, spendable: 0 }
    },
  }
}

export async function partySigner(m: PassbookModuleCalls): Promise<PartySigner> {
  const { party } = await m.info()
  return {
    pubkey: party.pubkey,
    btc: party.btc,
    signObject: async <T extends object>(v: T) => (await m.partySignObject(v)) as T & { sig: Hex },
    signPassbookHash: (h) => m.partySignPassbookHash(h),
    signRequest: (r) => m.partySignRequest(r),
    signEvent: (t) => m.partySignEvent(t),
    nip44Encrypt: (p, s) => m.partyNip44Encrypt(p, s),
    nip44Decrypt: (p, s) => m.partyNip44Decrypt(p, s),
    signKeyPath: (p) => m.partySignKeyPath(p),
    signEscrowLeaf: (p) => m.partySignEscrowLeaf(p),
  }
}

/** A light client over electrs: a tx's height comes from the history of one of its own outputs. */
export function chainPort(m: PassbookModuleCalls): ChainPort {
  return {
    kind: 'electrum',
    getHeight: () => m.chainHeight(),
    async getTx(txid: Hex): Promise<ChainTx | null> {
      let hex: Hex
      try { hex = await m.chainRawTx(txid) } catch { return null }
      const tx = bitcoin.Transaction.fromHex(hex)
      if (tx.getId() !== txid) throw new Error('electrs returned another transaction')
      const outputs = tx.outs.map((o) => ({ value: Number(o.value), script: bytesToHex(o.script) }))
      const indexed = outputs.find((o) => !o.script.startsWith('6a'))
      let height: number | null = null
      if (indexed) {
        const row = (await m.chainHistory(indexed.script)).find((h) => h.tx_hash === txid)
        height = row && row.height > 0 ? row.height : null
      }
      return { txid, height, inputs: tx.ins.map((i) => ({ txid: bytesToHex(Uint8Array.from(i.hash).reverse()), vout: i.index, witness: i.witness.map((w) => bytesToHex(w)) })), outputs }
    },
    async utxos(script: Hex) {
      return (await m.chainUtxos(script)).map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, value: u.value, height: u.height }))
    },
    broadcast: (hex) => m.chainBroadcast(hex),
  }
}

export function rgbPort(m: PassbookModuleCalls): RgbPort {
  return {
    refresh: async (assetId) => { await m.rgbRefresh({ assetId: assetId ?? null }) },
    async balance(assetId) {
      return (await m.rgbAssets()).find((a) => a.assetId === assetId)?.balance ?? { settled: 0, future: 0, spendable: 0 }
    },
    transfers: (assetId) => m.rgbTransfers({ assetId }),
    witnessInvoice: (amount, assetId) => m.rgbWitnessReceive({ amount, assetId: assetId ?? null }),
    blindInvoice: (amount, assetId) => m.rgbBlindReceive({ amount, assetId: assetId ?? null }),
    send: (o) => m.rgbSend(o),
    issueNia: (o) => m.rgbIssueNia(o),
    status: (txid) => m.rgbSendStatus({ txid }),
  }
}
