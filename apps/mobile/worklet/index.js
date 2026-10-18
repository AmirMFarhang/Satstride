// The Passbook module of the WDK worklet (wdk.config.js `modules.passbook`).
// pear-wrk-wdk constructs it with the wallet's seed (64 bytes) and zeroes its own
// copy right after; the module keeps only the BIP-32 root (keys.js) and the party
// key derived from it (party.js). The UI calls the methods listed in wdk.config.js
// `allowedModuleMethods` and gets back public data, signatures, ciphertexts and
// txids. No method returns a private key or the seed.
'use strict'

const { rootFromSeed, fingerprintHex, rgbKeys } = require('./keys.js')
const { PhoneRgbWallet } = require('./rgb.js')
const { PartyKey } = require('./party.js')
const { Electrum } = require('./electrum.js')

module.exports = function createPassbookModule (ctx) {
  if (!ctx || !ctx.seed) throw new Error('passbook module: no wallet seed (create or unlock the wallet first)')
  const root = rootFromSeed(ctx.seed) // synchronous: the caller zeroes ctx.seed when this returns
  const config = ctx.config || {}
  const hrp = (config.network || {}).hrp === 'tb' ? 'tb' : 'bcrt'
  const party = new PartyKey(root, hrp)
  let rgb = null
  let electrum = null
  const rgbWallet = () => {
    if (!rgb) {
      // loaded on first use, so the wallet starts even if the RGB addon cannot load
      // the worklet loads the Bare build; a laptop test passes the Node binding in ctx.rgblib
      const rgblib = ctx.rgblib || require('@utexo/rgb-lib-bare')
      rgb = new PhoneRgbWallet(root, { ...(config.rgb || {}), hrp }, rgblib)
    }
    return rgb
  }
  // the lender's per-loan repayment accounts (src/rgb/watch.ts): one rgb-lib wallet each, from
  // a seed derived from the party key and the loan id, in its own directory under loansDir
  const repayWallets = new Map()
  const loanDir = (loanId) => {
    const base = (config.rgb || {}).loansDir
    if (!base) throw new Error('passbook module: no loansDir configured')
    if (!/^[0-9a-f]{64}$/.test(String(loanId))) throw new Error('repayment account: bad loan id')
    return `${base}/${loanId}`
  }
  const repayRoot = (loanId) => rootFromSeed(party.repaymentSeed(loanId))
  const repayWallet = (loanId) => {
    let w = repayWallets.get(loanId)
    if (!w) {
      w = new PhoneRgbWallet(repayRoot(loanId), { ...(config.rgb || {}), dataDir: loanDir(loanId) }, ctx.rgblib || require('@utexo/rgb-lib-bare'))
      repayWallets.set(loanId, w)
    }
    return w
  }
  const chain = () => {
    if (!electrum) {
      const e = config.electrum || {}
      if (!e.host || !e.port) throw new Error('passbook module: no electrum endpoint configured')
      electrum = new Electrum({ host: e.host, port: e.port })
    }
    return electrum
  }
  const call = (fn) => async (...args) => fn(...args)

  return {
    info: call(() => ({ fingerprint: fingerprintHex(root), rgb: rgbKeys(root), party: { pubkey: party.pubkey, btc: party.btcOutput() } })),
    // RGB (M2)
    rgbAddress: call(() => rgbWallet().address()),
    rgbBtcBalance: call((o = {}) => rgbWallet().btcBalance(!!o.skipSync)),
    rgbCreateUtxos: call((o) => rgbWallet().createUtxos(o || {})),
    rgbBlindReceive: call((o) => rgbWallet().blindReceive(o || {})),
    rgbWitnessReceive: call((o) => rgbWallet().witnessReceive(o || {})),
    rgbRefresh: call((o = {}) => rgbWallet().refresh(o.assetId || null)),
    rgbAssets: call(() => rgbWallet().assets()),
    rgbTransfers: call((o = {}) => rgbWallet().transfers(o.assetId)),
    rgbDecodeInvoice: call((invoice) => rgbWallet().decodeInvoice(invoice)),
    rgbSend: call((o) => rgbWallet().send(o || {})),
    rgbIssueNia: call((o) => rgbWallet().issueNia(o || {})),
    rgbFailPending: call((o = {}) => rgbWallet().failPending(o.batchTransferIdx ?? null)),
    rgbSendStatus: call((o = {}) => rgbWallet().sendStatus(o)),
    rgbUnspents: call((o = {}) => rgbWallet().unspents(!!o.skipSync)),
    // the lender's repayment account per loan (M6): the xpubs the platform watches, then the
    // platform's backup restored into its own directory, then reads; it never signs a send here
    lenderRepayKeys: call((loanId) => {
      const k = rgbKeys(repayRoot(loanId))
      return { account_xpub_vanilla: k.accountXpubVanilla, account_xpub_colored: k.accountXpubColored, master_fingerprint: k.masterFingerprint }
    }),
    lenderRepayRestore: call((o = {}) => {
      const rgblib = ctx.rgblib || require('@utexo/rgb-lib-bare')
      rgblib.restoreBackup(String(o.backupPath), String(o.password), loanDir(o.loanId))
      return true
    }),
    lenderRepayRefresh: call((o = {}) => repayWallet(o.loanId).refresh(o.assetId || null)),
    // REGTEST TEST DATA (M7 option A): the seeded test persona's rgb-lib backup restored into the RGB data
    // directory, beside this wallet's own (rgb-lib keeps each wallet under its own fingerprint); it opens
    // only when the phone is unlocked with the persona's words. Nothing is signed here.
    rgbRestoreBackup: call((o = {}) => {
      const rgblib = ctx.rgblib || require('@utexo/rgb-lib-bare')
      const dataDir = (config.rgb || {}).dataDir
      if (!dataDir) throw new Error('passbook module: no RGB dataDir configured')
      if (String(o.fingerprint) === fingerprintHex(root)) throw new Error('the backup is this wallet\'s own; nothing restored')
      rgblib.restoreBackup(String(o.backupPath), String(o.password), dataDir)
      return true
    }),
    lenderRepayTransfers: call((o = {}) => repayWallet(o.loanId).transfers(o.assetId)),
    lenderRepayAssets: call((o = {}) => repayWallet(o.loanId).assets()),
    // the party key (M3): signatures over inputs whose hash is computed here
    partySignObject: call((value) => party.signObject(value)),
    partySignPassbookHash: call((hash) => party.signPassbookHash(hash)),
    partySignRequest: call((r) => party.signRequest(r || {})),
    partySignEvent: call((t) => party.signEvent(t || {})),
    partyNip44Encrypt: call((peer, plaintext) => party.nip44Encrypt(peer, plaintext)),
    partyNip44Decrypt: call((peer, payload) => party.nip44Decrypt(peer, payload)),
    partySignKeyPath: call((psbt) => party.signKeyPath(psbt)),
    partySignEscrowLeaf: call((psbt) => party.signEscrowLeaf(psbt)),
    // the chain, from the laptop's electrs (M3)
    chainHeight: call(() => chain().height()),
    chainUtxos: call((script) => chain().listUnspent(script)),
    chainHistory: call((script) => chain().history(script)),
    chainRawTx: call((txid) => chain().rawTx(txid)),
    chainBroadcast: call((hex) => chain().broadcast(hex)),
    close: call(() => {
      if (rgb) rgb.close(); rgb = null
      for (const w of repayWallets.values()) w.close()
      repayWallets.clear()
      if (electrum) electrum.close(); electrum = null
    })
  }
}
