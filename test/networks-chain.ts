// TEST ONLY. A tiny regtest chain for the layer tests: unsigned transactions
// (parsing is all the adapter does with them), one per block, real merkle
// roots and headers ground to regtest's trivial target, so every record still
// passes the same checks a live source must pass. Keys are random regtest keys.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import * as bitcoin from 'bitcoinjs-lib'
import { bytesToHex, type Hex } from '../src/core/crypto.js'
import type { BitcoinSource, TxRecord } from '../src/networks/bitcoin-source.js'
import type { SourceCall } from '../src/networks/types.js'

const NET = bitcoin.networks.regtest
const dsha = (b: Uint8Array) => sha256(sha256(b))
const rev = (b: Uint8Array) => Uint8Array.from(b).reverse()

export interface Wallet { address: string; script: Hex; secret: Uint8Array; pubkey: Hex }

export function regtestWallet(type: 'p2wpkh' | 'p2tr' = 'p2wpkh'): Wallet {
  const secret = secp256k1.utils.randomSecretKey()
  const pub = secp256k1.getPublicKey(secret, true)
  const pay = type === 'p2wpkh' ? bitcoin.payments.p2wpkh({ pubkey: pub, network: NET }) : bitcoin.payments.p2tr({ internalPubkey: pub.slice(1), network: NET })
  return { address: pay.address!, script: bytesToHex(pay.output!), secret, pubkey: bytesToHex(pub) }
}

/** A 2-of-2 P2WSH output, like a Lightning channel's funding output. */
export function channelScript(): Hex {
  const k = () => secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
  return bytesToHex(bitcoin.payments.p2wsh({ redeem: bitcoin.payments.p2ms({ m: 2, pubkeys: [k(), k()], network: NET }), network: NET }).output!)
}

export interface Out { script: Hex; value: number }

export class FakeBitcoin {
  readonly records = new Map<Hex, TxRecord>()
  private prev: Uint8Array = new Uint8Array(32)
  height = 100
  time = 1_790_000_000
  private seq = 0

  private mine(tx: bitcoin.Transaction): Hex {
    this.height++
    this.time += 600
    const txid = tx.getId()
    const header = new Uint8Array(80)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x20000000, true)
    header.set(this.prev, 4)
    header.set(rev(Uint8Array.from(Buffer.from(txid, 'hex'))), 36)
    view.setUint32(68, this.time, true)
    view.setUint32(72, 0x207fffff, true)
    let hash: Uint8Array
    for (let nonce = 0; ; nonce++) {
      view.setUint32(76, nonce, true)
      hash = dsha(header)
      if (rev(hash)[0] < 0x7f) break
    }
    this.prev = hash
    this.records.set(txid, { txid, hex: tx.toHex(), block_height: this.height, block_hash: bytesToHex(rev(hash)), block_time: this.time, merkle: { merkle: [], pos: 0 }, header: bytesToHex(header) })
    return txid
  }

  /** A transaction spending the given outpoints (or a fresh coinbase-like input) to the given outputs. */
  tx(inputs: { txid: Hex; vout: number }[], outputs: Out[]): Hex {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    if (!inputs.length) tx.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff, Uint8Array.of(0x01, this.seq++ & 0xff, 0x00))
    for (const i of inputs) tx.addInput(rev(Uint8Array.from(Buffer.from(i.txid, 'hex'))), i.vout)
    for (const o of outputs) tx.addOutput(Uint8Array.from(Buffer.from(o.script, 'hex')), BigInt(o.value))
    return this.mine(tx)
  }

  /** Money from an outside payer: a payer-owned output, then a payment from it. */
  pay(from: Hex, outputs: Out[]): Hex {
    const total = outputs.reduce((s, o) => s + o.value, 0)
    const funding = this.tx([], [{ script: from, value: total + 1_000 }])
    return this.tx([{ txid: funding, vout: 0 }], outputs)
  }

  source(label = 'fake regtest'): BitcoinSource & { tamper?: (r: TxRecord) => TxRecord } {
    const chain = this
    const calls: SourceCall[] = []
    const log = (endpoint: string) => calls.push({ at: chain.time, source: label, endpoint, ok: true, height: chain.height })
    const src = {
      label, kind: 'electrum' as const, chain: 'regtest' as const, calls,
      tamper: undefined as undefined | ((r: TxRecord) => TxRecord),
      async tipHeight() { log('tip'); return chain.height },
      async addressTxids(address: string) {
        log(`address/${address}`)
        const script = bytesToHex(bitcoin.address.toOutputScript(address, NET))
        const funded = new Set<string>()
        const out: { txid: Hex; height: number }[] = []
        for (const r of chain.records.values()) {
          const tx = bitcoin.Transaction.fromHex(r.hex)
          let touches = false
          tx.outs.forEach((o, vout) => { if (bytesToHex(o.script) === script) { touches = true; funded.add(`${r.txid}:${vout}`) } })
          if (tx.ins.some((i) => funded.has(`${bytesToHex(rev(i.hash))}:${i.index}`))) touches = true
          if (touches) out.push({ txid: r.txid, height: r.block_height })
        }
        return out
      },
      async tx(txid: Hex) { log(`tx/${txid}`); const r = chain.records.get(txid); if (!r) throw new Error('unknown tx'); return src.tamper ? src.tamper({ ...r }) : { ...r } },
      async rawTx(txid: Hex) { log(`raw/${txid}`); const r = chain.records.get(txid); if (!r) throw new Error('unknown tx'); return r.hex },
    }
    return src
  }
}
