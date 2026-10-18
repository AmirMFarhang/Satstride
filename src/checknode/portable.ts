// Byte helpers the phone needs to open a sealed check result without Node:
// base64 and gunzip (RFC 1952 around RFC 1951 inflate), in plain TypeScript.
// The operator seals with node:zlib's gzip (seal.ts); test/checknode-split.test.ts
// checks this inflate against it. Browser-safe (no node: imports, no dependencies).

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i
B64_INDEX['-'.charCodeAt(0)] = 62
B64_INDEX['_'.charCodeAt(0)] = 63

/** Standard or URL-safe base64, padding optional; throws on any other character. */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  if (clean.length % 4 === 1) throw new Error('BASE64_MALFORMED')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0, acc = 0, o = 0
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i)
    const v = c < 128 ? B64_INDEX[c] : -1
    if (v < 0) throw new Error('BASE64_MALFORMED')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff }
  }
  return out.subarray(0, o)
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---- inflate (RFC 1951), canonical Huffman decoding bit by bit ----

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CLC_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface Tree { counts: Uint16Array; symbols: Uint16Array }

function buildTree(lengths: Uint8Array): Tree {
  const counts = new Uint16Array(16)
  for (const l of lengths) counts[l]++
  counts[0] = 0
  // An over-subscribed code is not a prefix code.
  let left = 1
  for (let len = 1; len < 16; len++) { left = left * 2 - counts[len]; if (left < 0) throw new Error('INFLATE_BAD_CODE') }
  const offs = new Uint16Array(16)
  for (let len = 1, sum = 0; len < 16; len++) { offs[len] = sum; sum += counts[len] }
  const symbols = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i
  return { counts, symbols }
}

const FIXED = (() => {
  const l = new Uint8Array(288)
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288)
  return { lit: buildTree(l), dist: buildTree(new Uint8Array(30).fill(5)) }
})()

class Inflater {
  pos = 0
  private bitBuf = 0
  private bitCnt = 0
  out: Uint8Array
  len = 0
  constructor(private readonly src: Uint8Array, private readonly maxOutput: number) {
    this.out = new Uint8Array(Math.min(Math.max(1024, src.length * 4), maxOutput))
  }
  private bit(): number {
    if (this.bitCnt === 0) {
      if (this.pos >= this.src.length) throw new Error('INFLATE_TRUNCATED')
      this.bitBuf = this.src[this.pos++]
      this.bitCnt = 8
    }
    const b = this.bitBuf & 1
    this.bitBuf >>>= 1
    this.bitCnt--
    return b
  }
  private bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v |= this.bit() << i
    return v
  }
  private decode(t: Tree): number {
    let code = 0, first = 0, index = 0
    for (let len = 1; len < 16; len++) {
      code |= this.bit()
      const count = t.counts[len]
      if (code - count < first) return t.symbols[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('INFLATE_BAD_CODE')
  }
  private push(b: number) {
    if (this.len === this.out.length) {
      if (this.len >= this.maxOutput) throw new Error('INFLATE_TOO_LARGE')
      const next = new Uint8Array(Math.min(this.out.length * 2, this.maxOutput))
      next.set(this.out)
      this.out = next
    }
    this.out[this.len++] = b
  }
  private stored() {
    this.bitCnt = 0
    if (this.pos + 4 > this.src.length) throw new Error('INFLATE_TRUNCATED')
    const n = this.src[this.pos] | (this.src[this.pos + 1] << 8)
    const nn = this.src[this.pos + 2] | (this.src[this.pos + 3] << 8)
    this.pos += 4
    if ((n ^ 0xffff) !== nn) throw new Error('INFLATE_BAD_STORED_LENGTH')
    if (this.pos + n > this.src.length) throw new Error('INFLATE_TRUNCATED')
    for (let i = 0; i < n; i++) this.push(this.src[this.pos + i])
    this.pos += n
  }
  private dynamicTrees(): { lit: Tree; dist: Tree } {
    const hlit = this.bits(5) + 257, hdist = this.bits(5) + 1, hclen = this.bits(4) + 4
    if (hlit > 286 || hdist > 30) throw new Error('INFLATE_BAD_HEADER')
    const cl = new Uint8Array(19)
    for (let i = 0; i < hclen; i++) cl[CLC_ORDER[i]] = this.bits(3)
    const clTree = buildTree(cl)
    const lengths = new Uint8Array(hlit + hdist)
    for (let n = 0; n < hlit + hdist;) {
      const sym = this.decode(clTree)
      if (sym < 16) { lengths[n++] = sym; continue }
      let repeat: number, value = 0
      if (sym === 16) { if (n === 0) throw new Error('INFLATE_BAD_REPEAT'); value = lengths[n - 1]; repeat = this.bits(2) + 3 }
      else if (sym === 17) repeat = this.bits(3) + 3
      else repeat = this.bits(7) + 11
      if (n + repeat > hlit + hdist) throw new Error('INFLATE_BAD_REPEAT')
      lengths.fill(value, n, n + repeat)
      n += repeat
    }
    if (lengths[256] === 0) throw new Error('INFLATE_NO_END_CODE')
    return { lit: buildTree(lengths.subarray(0, hlit)), dist: buildTree(lengths.subarray(hlit)) }
  }
  private codes(lit: Tree, dist: Tree) {
    for (;;) {
      const sym = this.decode(lit)
      if (sym < 256) { this.push(sym); continue }
      if (sym === 256) return
      const li = sym - 257
      if (li >= 29) throw new Error('INFLATE_BAD_LENGTH')
      const length = LENGTH_BASE[li] + this.bits(LENGTH_EXTRA[li])
      const di = this.decode(dist)
      if (di >= 30) throw new Error('INFLATE_BAD_DISTANCE')
      const distance = DIST_BASE[di] + this.bits(DIST_EXTRA[di])
      if (distance > this.len) throw new Error('INFLATE_BAD_DISTANCE')
      for (let i = 0; i < length; i++) this.push(this.out[this.len - distance])
    }
  }
  run(): Uint8Array {
    let last = 0
    while (!last) {
      last = this.bit()
      const type = this.bits(2)
      if (type === 0) this.stored()
      else if (type === 1) this.codes(FIXED.lit, FIXED.dist)
      else if (type === 2) { const t = this.dynamicTrees(); this.codes(t.lit, t.dist) }
      else throw new Error('INFLATE_BAD_BLOCK_TYPE')
    }
    // The trailer starts at the next byte boundary.
    this.bitCnt = 0
    return this.out.slice(0, this.len)
  }
}

/** Raw DEFLATE; `end` is the byte offset after the last block. */
export function inflateRaw(data: Uint8Array, maxOutput = 4_000_000): { bytes: Uint8Array; end: number } {
  const inf = new Inflater(data, maxOutput)
  const bytes = inf.run()
  return { bytes, end: inf.pos }
}

/** One gzip member (RFC 1952): header, deflate data, CRC-32 and size checked. */
export function gunzip(data: Uint8Array, maxOutput = 4_000_000): Uint8Array {
  if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) throw new Error('GZIP_MALFORMED')
  const flags = data[3]
  if (flags & 0xe0) throw new Error('GZIP_MALFORMED')
  let p = 10
  if (flags & 4) { if (p + 2 > data.length) throw new Error('GZIP_MALFORMED'); p += 2 + (data[p] | (data[p + 1] << 8)) }
  if (flags & 8) { while (p < data.length && data[p] !== 0) p++; p++ }
  if (flags & 16) { while (p < data.length && data[p] !== 0) p++; p++ }
  if (flags & 2) p += 2
  if (p >= data.length) throw new Error('GZIP_MALFORMED')
  const { bytes, end } = inflateRaw(data.subarray(p), maxOutput)
  const t = p + end
  if (t + 8 > data.length) throw new Error('GZIP_TRUNCATED')
  const crc = (data[t] | (data[t + 1] << 8) | (data[t + 2] << 16) | (data[t + 3] << 24)) >>> 0
  const size = (data[t + 4] | (data[t + 5] << 8) | (data[t + 6] << 16) | (data[t + 7] << 24)) >>> 0
  if (crc !== crc32(bytes) || size !== (bytes.length >>> 0)) throw new Error('GZIP_CHECKSUM')
  return bytes
}
