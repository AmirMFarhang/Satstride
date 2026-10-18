// The dashboard's pairing QR. The browser draws these rows; no image is made here.

import { toQR } from './vendor/toqr.js'

export interface QrMatrix {
  size: number
  /** One string per row, '1' for a dark module. */
  rows: string[]
}

/** Error correction M, so a projected screen with glare still scans. */
export function qrMatrix(text: string): QrMatrix {
  const m = toQR(text, 0)
  const size = Math.sqrt(m.length)
  if (!Number.isInteger(size)) throw new Error('QR encoder returned a non-square matrix')
  const rows: string[] = []
  for (let y = 0; y < size; y++) rows.push(Array.from(m.subarray(y * size, (y + 1) * size), (v) => (v ? '1' : '0')).join(''))
  return { size, rows }
}
