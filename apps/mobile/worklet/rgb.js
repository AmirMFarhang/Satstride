// The borrower's RGB wallet inside the worklet: rgb-lib (the Bare build,
// @utexo/rgb-lib-bare) opened WATCH-ONLY from the xpubs keys.js derives, the same
// way the laptop's @utexo/rgb-sdk opens it. rgb-lib builds every PSBT; keys.js
// signs it here with the seed's root; rgb-lib finishes and broadcasts. No mnemonic
// or private key is ever handed to rgb-lib or to the UI.
//
// The calls use rgb-lib's string arguments, so the same class also runs on the
// laptop over the Node binding (@utexo/rgb-lib), which is how the signer is
// tested on regtest before it reaches the phone.
'use strict'

const { rgbKeys, signRgbPsbt, describePsbt, txidOfPsbt } = require('./keys.js')

/** What a send must look like for the gate in front of signing (mirrors the laptop's RgbTransferSummary). */
const WITNESS_SATS = 1000
/** A send this recent may still be on its way to the indexer: not cancelled until it is older. */
const SETTLE_WINDOW_S = 120
/** The prefix of the error a send throws when it was signed and may have been broadcast (the UI parses it). */
const AMBIGUOUS = 'AMBIGUOUS_SEND:'

/** The batch transfer index of a newer-API SendBeginResult (null for the Node binding's bare PSBT). */
function batchIdxOf (r) {
  try {
    const v = typeof r === 'string' && r.trim().startsWith('{') ? JSON.parse(r) : r
    return v && typeof v === 'object' && Number.isInteger(v.batchTransferIdx) ? v.batchTransferIdx : null
  } catch { return null }
}

/** A base64 PSBT out of whatever the binding returned: the PSBT itself, or a result object or its JSON. */
function psbtOf (r) {
  const v = typeof r === 'string' && r.trim().startsWith('{') ? JSON.parse(r) : r
  const psbt = typeof v === 'string' ? v.trim() : v && v.psbt
  if (typeof psbt !== 'string' || !psbt.startsWith('cHNidP')) throw new Error('rgb-lib returned no PSBT')
  return psbt
}

class PhoneRgbWallet {
  constructor (root, config, rgblib) {
    for (const k of ['dataDir', 'indexerUrl', 'proxyEndpoint']) {
      if (!config[k]) throw new Error(`rgb: missing ${k}`)
    }
    // test networks only: regtest, or a signet (Mutinynet); never mainnet
    if (config.network !== 'Regtest' && config.network !== 'Signet') throw new Error(`rgb: this build runs on regtest or Mutinynet only, not ${config.network}`)
    this._root = root
    this._lib = rgblib
    this._config = config
    this._wallet = null
    this._online = null
    this.keys = rgbKeys(root)
    // The Bare build wraps rgb-lib's newer C API: receives and sends take an absolute expiry
    // timestamp (and sendBegin a dry-run flag); the laptop's Node binding takes a duration.
    const sb = rgblib.Wallet && rgblib.Wallet.prototype && rgblib.Wallet.prototype.sendBegin
    this._newApi = typeof sb === 'function' && sb.length >= 6
  }

  /** rgb-lib's expiry argument for a receive valid `seconds` from now, in the form this binding takes. */
  _expiry (seconds) {
    return this._newApi ? String(Math.floor(Date.now() / 1000) + seconds) : String(seconds)
  }

  _open () {
    if (this._wallet) return this._wallet
    const walletData = {
      dataDir: this._config.dataDir,
      bitcoinNetwork: this._config.network,
      databaseType: 'Sqlite',
      maxAllocationsPerUtxo: '1',
      supportedSchemas: ['Cfa', 'Nia', 'Uda']
    }
    // one combined WalletData: the Bare binding splits off the key fields itself
    this._wallet = new this._lib.Wallet(new this._lib.WalletData({ ...walletData, ...this.keys }))
    return this._wallet
  }

  _goOnline () {
    const w = this._open()
    if (!this._online) this._online = w.goOnline(false, this._config.indexerUrl)
    return this._online
  }

  address () { return this._open().getAddress() }

  // rgb-lib's C API takes the online handle as required even with skipSync (a null one crashed
  // the phone in list_unspents, SIGSEGV at 0x8); skipSync alone decides whether to sync
  btcBalance (skipSync = false) { return this._open().getBtcBalance(this._goOnline(), skipSync) }

  /** Colored UTXOs to receive RGB into (a blinded receive needs a free one). Signs here; broadcasts. */
  createUtxos ({ num = 5, size = 5000, feeRate = 2 } = {}) {
    const w = this._open()
    const online = this._goOnline()
    const psbt = psbtOf(w.createUtxosBegin(online, true, String(num), String(size), String(feeRate), false))
    const signed = signRgbPsbt(this._root, psbt)
    return w.createUtxosEnd(online, signed, false)
  }

  /** A blinded RGB invoice: the sender cannot see which UTXO receives. */
  blindReceive ({ assetId = null, amount, durationSeconds = 86400, minConfirmations = 1 }) {
    const a = Number(amount)
    if (!Number.isSafeInteger(a) || a <= 0) throw new Error('amount must be a positive whole number of base units')
    // a receiver cannot name an asset it has never held (rgb-lib), so the invoice stays open then
    return this._open().blindReceive(assetId && this.knowsAsset(assetId) ? assetId : null, JSON.stringify({ Fungible: a }), this._expiry(durationSeconds), [this._config.proxyEndpoint], String(minConfirmations))
  }

  /** A witness invoice: the sender creates the receiving output, so no colored UTXO is needed here (the loan disbursement). */
  witnessReceive ({ assetId = null, amount, durationSeconds = 86400, minConfirmations = 1 }) {
    const a = Number(amount)
    if (!Number.isSafeInteger(a) || a <= 0) throw new Error('amount must be a positive whole number of base units')
    const named = assetId && this.knowsAsset(assetId) ? assetId : null
    return this._open().witnessReceive(named, JSON.stringify({ Fungible: a }), this._expiry(durationSeconds), [this._config.proxyEndpoint], String(minConfirmations))
  }

  /** Issue a non-inflatable asset to this wallet (the borrower's PB-IOU note). Returns the contract id. */
  issueNia ({ ticker, name, precision, amount }) {
    const a = Number(amount)
    if (!/^[A-Z]{3,8}$/.test(String(ticker)) || !Number.isSafeInteger(a) || a <= 0) throw new Error('bad issuance')
    const asset = this._open().issueAssetNIA(String(ticker), String(name), String(precision), [String(a)])
    const id = (typeof asset === 'string' ? JSON.parse(asset) : asset).assetId
    if (!id) throw new Error('issuance returned no asset id')
    return id
  }

  /** Sync, fetch consignments, acknowledge and confirm pending transfers (all assets unless one this wallet knows is named). */
  refresh (assetId = null) {
    const w = this._open()
    return w.refresh(this._goOnline(), assetId && this.knowsAsset(assetId) ? assetId : null, [], false)
  }

  knowsAsset (assetId) {
    const listed = this._open().listAssets(['Nia', 'Cfa', 'Uda']) || {}
    return [...(listed.nia || []), ...(listed.cfa || []), ...(listed.uda || [])].some((a) => a.assetId === assetId)
  }

  assets () {
    const w = this._open()
    const listed = w.listAssets(['Nia', 'Cfa', 'Uda']) || {}
    return (listed.nia || []).map((a) => ({ assetId: a.assetId, ticker: a.ticker, name: a.name, precision: a.precision, balance: w.getAssetBalance(a.assetId) }))
  }

  /**
   * The wallet's outputs as the reserve sees them: each colored output with what it holds
   * (free when it holds nothing and no pending receive waits on it), and the vanilla ones.
   * skipSync reads rgb-lib's last view without syncing.
   */
  unspents (skipSync = false) {
    const w = this._open()
    const raw = w.listUnspents(this._goOnline(), false, skipSync) // the online handle is required, see btcBalance
    const list = typeof raw === 'string' ? JSON.parse(raw) : (raw || [])
    return list.map((u) => {
      const utxo = u.utxo || {}
      const op = utxo.outpoint || {}
      const allocations = (u.rgbAllocations || []).map((a) => ({ assetId: a.assetId ?? null, amount: (a.assignment && a.assignment.Fungible) || 0, settled: !!a.settled }))
      return {
        outpoint: `${op.txid}:${op.vout}`,
        sats: Number(utxo.btcAmount || 0),
        colorable: !!utxo.colorable,
        exists: utxo.exists !== false,
        allocations,
        pendingBlinded: Number(u.pendingBlinded || 0),
        free: !!utxo.colorable && allocations.length === 0 && !Number(u.pendingBlinded || 0)
      }
    })
  }

  /** Transfers of one asset (none if this wallet has never held it), or the asset-less ones (pending blind receives). */
  transfers (assetId) {
    if (assetId && !this.knowsAsset(assetId)) return []
    return (this._open().listTransfers(assetId || null) || []).map((t) => ({
      idx: t.idx,
      batchTransferIdx: t.batchTransferIdx,
      kind: t.kind,
      status: t.status,
      txid: t.txid ?? null,
      recipientId: t.recipientId ?? null,
      amount: t.kind === 'Send' ? (t.requestedAssignment?.Fungible ?? 0) : (t.assignments ?? []).reduce((s, x) => s + (x.Fungible ?? 0), 0)
    }))
  }

  /** Every field of an invoice, for the review screen and the checks below. */
  decodeInvoice (invoice) {
    const inv = new this._lib.Invoice(String(invoice).trim())
    // the Bare binding returns invoiceData as JSON text, the Node binding as an object
    try { const d = inv.invoiceData(); return typeof d === 'string' ? JSON.parse(d) : d } finally { inv.drop() }
  }

  /**
   * Pay an RGB invoice (donation: the sender broadcasts without waiting for the
   * receiver's ack, as the laptop agents do). Refuses an invoice for another
   * asset or network. Returns the txid and the decoded PSBT that was signed.
   */
  send ({ invoice, assetId, amount, feeRate = 2 }) {
    const a = Number(amount)
    if (!Number.isSafeInteger(a) || a <= 0) throw new Error('amount must be a positive whole number of base units')
    const d = this.decodeInvoice(invoice)
    if (!d || typeof d.recipientId !== 'string' || !Array.isArray(d.transportEndpoints)) throw new Error('could not read the invoice (no recipient or transport endpoints)')
    if (d.assetId && d.assetId !== assetId) throw new Error(`invoice is for ${d.assetId}, not ${assetId}`)
    if (d.network && String(d.network).toLowerCase() !== String(this._config.network).toLowerCase()) throw new Error(`invoice is for ${d.network}, not ${this._config.network}`)
    const witness = String(d.recipientId).includes(':wvout:')
    const recipientMap = {
      [assetId]: [{
        recipientId: d.recipientId,
        witnessData: witness ? { amountSat: String(WITNESS_SATS), blinding: null } : null,
        assignment: { Fungible: a },
        // the endpoint the invoice names first (the receiver watches its own proxy); this phone's own
        // configured proxy last, which rgb-lib tries only if the named one cannot be reached (a regtest
        // stack may name its proxy by an address only the laptop reaches). sendEnd records which was used.
        transportEndpoints: [...new Set([...d.transportEndpoints, this._config.proxyEndpoint])]
      }]
    }
    const w = this._open()
    const online = this._goOnline()
    // the Bare binding takes (…, expirationTimestamp, dryRun) after minConfirmations and returns
    // a SendBeginResult ({ psbt, batchTransferIdx, details }) as JSON; the Node one returns the PSBT
    const begun = this._newApi
      ? w.sendBegin(online, recipientMap, true, String(feeRate), '1', null, false)
      : w.sendBegin(online, recipientMap, true, String(feeRate), '1')
    const begunIdx = batchIdxOf(begun)
    let signed, summary
    try {
      const psbt = psbtOf(begun)
      summary = describePsbt(psbt, null, this._config.hrp)
      signed = signRgbPsbt(this._root, psbt)
    } catch (err) {
      // nothing was signed or broadcast: give the reserved allocation back (rgb-lib's newer
      // API records the transfer at send_begin), then report the error
      if (begunIdx !== null) { try { this._failUnsigned(begunIdx) } catch {} }
      throw err
    }
    const txid = txidOfPsbt(signed)
    let r
    try {
      r = w.sendEnd(online, signed, false)
    } catch (err) {
      // signed: rgb-lib may have broadcast it before the proxy or the indexer failed. The
      // caller must not sign again for this invoice until sendStatus resolves it.
      throw new Error(`${AMBIGUOUS}${JSON.stringify({ txid, batchTransferIdx: begunIdx })} the payment was signed and may have been broadcast; check it before trying again (${err && err.message})`)
    }
    return { txid: r.txid || txid, batchTransferIdx: r.batchTransferIdx, feeSats: summary.feeSats, endpoint: this._usedEndpoint(assetId, r.txid || txid) }
  }

  /** The transport endpoint rgb-lib posted the consignment to, from its own transfer record (null if it does not say). */
  _usedEndpoint (assetId, txid) {
    try {
      const t = (this._open().listTransfers(assetId) || []).find((x) => x.kind === 'Send' && x.txid === txid)
      const e = ((t && t.transportEndpoints) || []).find((x) => x.used)
      return e ? String(e.endpoint) : null
    } catch { return null }
  }

  /**
   * Whether this wallet's transaction is on the network: after a sync, rgb-lib's own list of
   * the wallet's transactions holds every broadcast spend of its outputs, in the mempool or a
   * block. null when that could not be read (then nothing may treat it as unsent).
   */
  broadcastSeen (txid) {
    try {
      const raw = this._open().listTransactions(this._goOnline(), false)
      const list = typeof raw === 'string' ? JSON.parse(raw) : (raw || [])
      return list.some((t) => t && t.txid === txid)
    } catch { return null }
  }

  /** Where a signed send stands: broadcast (seen on the network), not seen, or unknown; with rgb-lib's status for it. */
  sendStatus ({ txid }) {
    if (!/^[0-9a-f]{64}$/.test(String(txid))) throw new Error('sendStatus: bad txid')
    try { this.refresh(null) } catch {}
    const seen = this.broadcastSeen(txid)
    const w = this._open()
    const rows = (w.listTransfers(null) || []).concat(...this.assets().map((a) => w.listTransfers(a.assetId) || []))
    const row = rows.find((t) => t.txid === txid && t.kind === 'Send')
    return { txid, state: seen === true ? 'broadcast' : seen === false ? 'not-seen' : 'unknown', rgbStatus: row ? row.status : null, batchTransferIdx: row ? row.batchTransferIdx : null }
  }

  /** Fail one batch this wallet knows it never signed (send_begin succeeded, signing failed). */
  _failUnsigned (idx) {
    const r = this._open().failTransfers(this._goOnline(), String(idx), false, false)
    return { batchTransferIdx: idx, ...(typeof r === 'string' ? JSON.parse(r) : (r && typeof r === 'object' ? r : { transfersChanged: !!r })) }
  }

  /**
   * Cancel sends stuck at rgb-lib status Initiated, so their allocations can be spent again,
   * but only a batch proven never broadcast: Initiated is not that proof (a send interrupted
   * during sendEnd may already be live). A batch is cancelled only when it has no recorded
   * transaction, or its transaction is not on the network after a sync, and it is older than
   * SETTLE_WINDOW_S. Anything else is refused with the reason ("may be broadcast", "too
   * recent"). One batch, or every Initiated one. Returns an outcome per batch.
   */
  failPending (batchTransferIdx = null, nowS = Math.floor(Date.now() / 1000)) {
    const w = this._open()
    try { this.refresh(null) } catch {}
    const rows = (w.listTransfers(null) || []).concat(...this.assets().map((a) => w.listTransfers(a.assetId) || []))
      .filter((t) => t.kind === 'Send' && t.status === 'Initiated' && Number.isInteger(t.batchTransferIdx))
      .filter((t) => batchTransferIdx === null || batchTransferIdx === undefined || t.batchTransferIdx === batchTransferIdx)
    const batches = new Map()
    for (const t of rows) batches.set(t.batchTransferIdx, [...(batches.get(t.batchTransferIdx) || []), t])
    const out = []
    for (const [idx, ts] of batches) {
      const txids = [...new Set(ts.map((t) => t.txid).filter(Boolean))]
      const seen = txids.map((txid) => this.broadcastSeen(txid))
      const newest = Math.max(...ts.map((t) => Number(t.updatedAt || t.createdAt || 0)))
      if (seen.some((x) => x !== false)) out.push({ batchTransferIdx: idx, refused: 'may be broadcast', txid: txids[0] })
      else if (newest && nowS - newest < SETTLE_WINDOW_S) out.push({ batchTransferIdx: idx, refused: 'too recent to tell', txid: txids[0] || null })
      else out.push(this._failUnsigned(idx))
    }
    return out
  }

  close () {
    try { if (this._online) this._online.drop() } catch {}
    try { if (this._wallet) this._wallet.drop() } catch {}
    this._online = null
    this._wallet = null
  }
}

module.exports = { PhoneRgbWallet, WITNESS_SATS, AMBIGUOUS, SETTLE_WINDOW_S }
