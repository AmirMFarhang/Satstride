// A minimal Electrum client for the worklet: the phone's chain source is the
// laptop's electrs (through adb reverse), like any light wallet. JSON-RPC 2.0 over
// one TCP connection, newline-delimited. `net` is Node's in tests and bare-net in
// the worklet (bare-node-runtime maps it).
'use strict'

const net = require('net')
const { sha256 } = require('@noble/hashes/sha2.js')
const { hex } = require('@scure/base')

/** Electrum's script hash: sha256(scriptPubKey), byte-reversed, hex. */
function scriptHash (scriptHex) {
  return hex.encode(sha256(hex.decode(scriptHex)).reverse())
}

class Electrum {
  constructor ({ host, port, timeoutMs = 20000 }) {
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
    this.socket = null
    this.buf = ''
    this.nextId = 1
    this.pending = new Map()
  }

  _connect () {
    if (this.socket) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port }, () => resolve())
      s.setEncoding?.('utf8')
      s.on('data', (d) => this._data(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')))
      s.on('error', (e) => { reject(e); this._fail(e) })
      s.on('close', () => this._fail(new Error('electrum connection closed')))
      this.socket = s
    })
    return this.ready
  }

  _data (chunk) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`electrum: ${msg.error.message || JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
    }
  }

  _fail (err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
    this.socket = null
  }

  async request (method, params = []) {
    await this._connect()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`electrum ${method}: timeout`)) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async height () { return (await this.request('blockchain.headers.subscribe')).height }
  async listUnspent (scriptHex) { return this.request('blockchain.scripthash.listunspent', [scriptHash(scriptHex)]) }
  async history (scriptHex) { return this.request('blockchain.scripthash.get_history', [scriptHash(scriptHex)]) }
  async rawTx (txid) { return this.request('blockchain.transaction.get', [txid, false]) }
  async broadcast (txHex) { return this.request('blockchain.transaction.broadcast', [txHex]) }

  close () {
    try { this.socket?.end?.() } catch {}
    try { this.socket?.destroy?.() } catch {}
    this.socket = null
  }
}

module.exports = { Electrum, scriptHash }
