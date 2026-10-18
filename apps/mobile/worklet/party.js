// The borrower's Passbook party key inside the worklet: m/86'/1'/0'/0/0 of the
// wallet seed, as on the laptop (src/wallet/party.ts). One x-only key is the
// Passbook identity, the Nostr key (NIP-01 events, NIP-44 v2), the signer of the
// platform API requests, the escrow leaf signer and, tweaked (BIP-86), the owner
// of the party's own BTC (the collateral).
//
// What leaves: the public key, signatures and ciphertexts. The UI hands over
// structured inputs (an object, an event template, a request, a PSBT); the hash
// that gets signed is computed here from them, so the UI thread cannot get an
// arbitrary 32-byte digest signed by the escrow or BTC key.
'use strict'

const { schnorr } = require('@noble/curves/secp256k1.js')
const { sha256 } = require('@noble/hashes/sha2.js')
const { bytesToHex, hexToBytes, utf8ToBytes } = require('@noble/hashes/utils.js')
const btc = require('@scure/btc-signer')
const { base64 } = require('@scure/base')
const nip44 = require('nostr-tools/nip44')
const { entropyToMnemonic, mnemonicToSeedSync } = require('@scure/bip39')
const { wordlist } = require('@scure/bip39/wordlists/english.js')

const PARTY_KEY_PATH = "m/86'/1'/0'/0/0"
const PSBT_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, allowUnknown: true, disableScriptCheck: true }

/** src/core/crypto.ts canonicalJson: sorted keys, no undefined, no whitespace. */
function canonicalJson (value) { return JSON.stringify(sortDeep(value)) }
function sortDeep (value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const v = value[key]
      if (v !== undefined) out[key] = sortDeep(v)
    }
    return out
  }
  return value
}
const sha256Hex = (s) => bytesToHex(sha256(typeof s === 'string' ? utf8ToBytes(s) : s))
const hashObject = (v) => sha256Hex(canonicalJson(v))

class PartyKey {
  constructor (root, hrp = 'bcrt') {
    // the address prefix of this network's outputs: bcrt on regtest, tb on the signets
    this._hrp = hrp === 'tb' ? 'tb' : 'bcrt'
    const node = root.derive(PARTY_KEY_PATH)
    if (!node.privateKey) throw new Error('no private key at the party path')
    this._secret = node.privateKey
    this.pubkey = bytesToHex(schnorr.getPublicKey(this._secret))
    this._conv = new Map()
  }

  /** The party's own BTC: the BIP-86 key-path output of the party key (the script is the same on every network). */
  btcOutput () {
    const out = btc.p2tr(hexToBytes(this.pubkey), undefined, { ...btc.TEST_NETWORK, bech32: this._hrp })
    return { address: out.address, script: bytesToHex(out.script) }
  }

  /** signHash over a hash computed here: hashObject(value) (src/core/crypto.ts signObject without the sig field). */
  signObject (value) {
    const { sig: _drop, ...rest } = value || {}
    const hash = hashObject(rest)
    return { ...rest, sig: bytesToHex(schnorr.sign(hexToBytes(hash), this._secret)) }
  }

  /**
   * A Passbook hash that the shared protocol code computed on the UI thread
   * (term-sheet hash, outstanding statement). Refused unless it is 32 bytes of
   * hex; never used for Bitcoin sighashes, which are computed below from the PSBT.
   */
  signPassbookHash (hashHex) {
    if (!/^[0-9a-f]{64}$/.test(String(hashHex))) throw new Error('expected a 32-byte hex hash')
    return bytesToHex(schnorr.sign(hexToBytes(hashHex), this._secret))
  }

  /** The platform API's request signature (src/server/auth.ts requestDigest). */
  signRequest ({ method, pathAndQuery, timestampMs, nonce, bodySha256 }) {
    if (!/^[0-9a-f]{64}$/.test(String(bodySha256))) throw new Error('bodySha256 must be hex')
    const digest = sha256Hex(['passbook-request-v1', String(method).toUpperCase(), String(pathAndQuery), String(timestampMs), String(nonce), bodySha256].join('\n'))
    return bytesToHex(schnorr.sign(hexToBytes(digest), this._secret))
  }

  /** NIP-01: id and signature for an event template, with this key as author. */
  signEvent ({ kind, created_at, tags, content }) {
    const ev = { pubkey: this.pubkey, created_at, kind, tags, content }
    const id = sha256Hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
    return { ...ev, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), this._secret)) }
  }

  _conversation (peer) {
    if (!/^[0-9a-f]{64}$/.test(String(peer))) throw new Error('peer must be an x-only hex key')
    let k = this._conv.get(peer)
    if (!k) { k = nip44.v2.utils.getConversationKey(this._secret, peer); this._conv.set(peer, k) }
    return k
  }

  nip44Encrypt (peer, plaintext) { return nip44.v2.encrypt(String(plaintext), this._conversation(peer)) }
  nip44Decrypt (peer, payload) { return nip44.v2.decrypt(String(payload), this._conversation(peer)) }

  /** Sign the inputs of a PSBT that spend this key's own BIP-86 output (the collateral lock). Not finalized. */
  signKeyPath (psbtBase64) {
    const tx = btc.Transaction.fromPSBT(base64.decode(String(psbtBase64)), PSBT_OPTS)
    let n = 0
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i)
      if (inp.tapInternalKey && bytesToHex(inp.tapInternalKey) === this.pubkey) {
        if (!tx.signIdx(this._secret, i)) throw new Error(`could not sign input ${i}`)
        n++
      }
    }
    if (n === 0) throw new Error('no input of this PSBT is this party key\'s output')
    return base64.encode(tx.toPSBT())
  }

  /**
   * The borrower's signature for the escrow leaf in input 0: the BIP-341
   * script-path sighash (SIGHASH_DEFAULT) computed here from the PSBT, the leaf
   * must contain this key. Returns the signature for the UI to add with the
   * shared escrow code (which verifies it), and what was signed.
   */
  signEscrowLeaf (psbtBase64) {
    const tx = btc.Transaction.fromPSBT(base64.decode(String(psbtBase64)), PSBT_OPTS)
    if (tx.inputsLength !== 1) throw new Error('an escrow spend has exactly one input')
    const inp = tx.getInput(0)
    if (!inp.witnessUtxo || !inp.tapLeafScript || inp.tapLeafScript.length !== 1) throw new Error('input 0 must carry its witness UTXO and exactly one tap leaf')
    const [, scriptWithVer] = inp.tapLeafScript[0]
    const script = scriptWithVer.subarray(0, -1)
    const ver = scriptWithVer[scriptWithVer.length - 1]
    if (!bytesToHex(script).includes(this.pubkey)) throw new Error('this key is not in that leaf')
    const msg = tx.preimageWitnessV1(0, [inp.witnessUtxo.script], btc.SigHash.DEFAULT, [inp.witnessUtxo.amount], undefined, script, ver)
    const outputs = []
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i)
      outputs.push({ script: bytesToHex(o.script), sats: String(o.amount) })
    }
    return { signature: bytesToHex(schnorr.sign(msg, this._secret)), signed: { locktime: tx.lockTime, escrow_sats: String(inp.witnessUtxo.amount), outputs } }
  }

  /**
   * The lender's per-loan repayment account (src/rgb/watch.ts repaymentMnemonic): the
   * mnemonic is derived from this key's secret and the loan id, so the lender's seed
   * recovers it, and it is unrelated to the main RGB wallet. Its BIP-39 seed goes
   * straight into a root that stays in the worklet; the words never leave it.
   */
  repaymentSeed (loanIdHex) {
    if (!/^[0-9a-f]{64}$/.test(String(loanIdHex))) throw new Error('repayment account: bad loan id')
    const entropy = sha256(concat(utf8ToBytes('passbook/repayment-account/v1'), this._secret, hexToBytes(loanIdHex))).slice(0, 16)
    return mnemonicToSeedSync(entropyToMnemonic(entropy, wordlist))
  }
}

function concat (...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

module.exports = { PartyKey, PARTY_KEY_PATH, canonicalJson, hashObject }
