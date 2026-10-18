// Keys for the Passbook module inside the WDK worklet (Bare runtime, pure JS).
//
// The module receives the wallet's 64-byte BIP-39 seed once, at construction, and
// keeps only the BIP-32 root built from it. Nothing here returns a private key:
// callers get xpubs, a fingerprint and signed PSBTs.
//
// The RGB account keys match rgb-lib and the laptop's @utexo/rgb-sdk exactly
// (deriveAccountXpubsFromRoot): BIP-86 accounts m/86'/1'/0' (vanilla) and
// m/86'/827167'/0' (colored) on test networks, tpub/tprv versions, the master
// fingerprint as 8 hex chars. So the same 12 words open the same RGB wallet on
// the phone and on a laptop.
'use strict'

const { HDKey } = require('@scure/bip32')
const btc = require('@scure/btc-signer')
const { base64, hex } = require('@scure/base')

const TEST_VERSIONS = { private: 0x04358394, public: 0x043587cf }
const COIN_BITCOIN_TESTNET = 1
const COIN_RGB_TESTNET = 827167

function rootFromSeed (seed) {
  if (!(seed instanceof Uint8Array) || (seed.length !== 64 && seed.length !== 32 && seed.length !== 16)) {
    throw new Error('expected a BIP-39 seed (64 bytes)')
  }
  // copy: the caller zeroes its buffer right after the module is constructed
  return HDKey.fromMasterSeed(Uint8Array.from(seed), TEST_VERSIONS)
}

function fingerprintHex (root) {
  return root.fingerprint.toString(16).padStart(8, '0')
}

/** rgb-lib's SinglesigKeys for a test network, without a mnemonic (watch-only; signing stays here). */
function rgbKeys (root) {
  return {
    accountXpubVanilla: root.derive(`m/86'/${COIN_BITCOIN_TESTNET}'/0'`).publicExtendedKey,
    accountXpubColored: root.derive(`m/86'/${COIN_RGB_TESTNET}'/0'`).publicExtendedKey,
    masterFingerprint: fingerprintHex(root),
    vanillaKeychain: '1'
  }
}

const PSBT_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, allowUnknown: true, disableScriptCheck: true }

/**
 * Sign every input of an rgb-lib PSBT this root owns (matched by the BIP-32
 * derivations rgb-lib writes into each input), then finalize, because rgb-lib's
 * *_end calls extract the transaction. Refuses a PSBT with an input it cannot sign.
 */
function signRgbPsbt (root, psbtBase64) {
  const tx = btc.Transaction.fromPSBT(base64.decode(String(psbtBase64).trim()), PSBT_OPTS)
  const signed = tx.sign(root)
  if (signed === 0) throw new Error('no input of this PSBT belongs to this wallet')
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    if (!inp.tapKeySig && !(inp.partialSig && inp.partialSig.length) && !inp.finalScriptWitness) {
      throw new Error(`input ${i} is not this wallet's; refusing to sign a partial transaction`)
    }
  }
  tx.finalize()
  return base64.encode(tx.toPSBT())
}

/** What a PSBT spends and pays, for showing the user before signing (amounts in sats as strings). */
function describePsbt (psbtBase64, network, hrp) {
  const tx = btc.Transaction.fromPSBT(base64.decode(String(psbtBase64).trim()), PSBT_OPTS)
  const net = network || btc.TEST_NETWORK
  // addresses in this network's prefix: bcrt on regtest (the default), tb on the signets
  const regtest = { ...net, bech32: hrp || 'bcrt' }
  const outputs = []
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i)
    let address = null
    try { address = btc.Address(regtest).encode(btc.OutScript.decode(o.script)) } catch { address = null }
    outputs.push({ address, sats: String(o.amount ?? 0n), script: hex.encode(o.script) })
  }
  let inSats = 0n
  for (let i = 0; i < tx.inputsLength; i++) inSats += tx.getInput(i).witnessUtxo?.amount ?? 0n
  const outSats = outputs.reduce((s, o) => s + BigInt(o.sats), 0n)
  return { inputs: tx.inputsLength, inSats: String(inSats), outputs, feeSats: String(inSats - outSats) }
}

/** The txid of a finalized PSBT (the transaction rgb-lib will broadcast). */
function txidOfPsbt (psbtBase64) {
  return btc.Transaction.fromPSBT(base64.decode(String(psbtBase64).trim()), PSBT_OPTS).id
}

module.exports = { rootFromSeed, rgbKeys, signRgbPsbt, describePsbt, txidOfPsbt, fingerprintHex, TEST_VERSIONS }
