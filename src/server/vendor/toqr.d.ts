// Types for the vendored toqr 0.1.1 (see toqr.js). ec: 0 = M, 1 = L, 2 = H, 3 = Q.
/** The modules row by row, size*size entries of 0 or 1. */
export declare const toQR: (content: string | Uint8Array, ec?: 0 | 1 | 2 | 3) => Uint8Array<ArrayBuffer>
