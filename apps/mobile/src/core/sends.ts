// Pure rules for RGB sends, shared by the screens and tests.

/** The fungible amount an invoice asks for, in base units; null when it asks for none ("Any"). */
export function requestedAmount(assignment: unknown): number | null {
  let a = assignment
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { return null }
  }
  if (!a || typeof a !== 'object') return null
  const o = a as { Fungible?: unknown; type?: unknown; value?: unknown }
  const v = o.Fungible ?? (o.type === 'Fungible' ? o.value : undefined)
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Why an entered amount can't pay this invoice, or null: a fixed request must be paid exactly. */
export function amountMismatch(requested: number | null, entered: bigint | number, format: (units: bigint | number) => string): string | null {
  if (requested === null) return null
  return BigInt(requested) === BigInt(entered) ? null : `This invoice asks for exactly ${format(requested)}; you entered ${format(entered)}.`
}

/** The worklet's error for a send that was signed and may have been broadcast (worklet/rgb.js AMBIGUOUS). */
export const AMBIGUOUS = 'AMBIGUOUS_SEND:'
export function parseAmbiguous(message: string): { txid: string; batchTransferIdx: number | null } | null {
  const at = message.indexOf(AMBIGUOUS)
  if (at < 0) return null
  const rest = message.slice(at + AMBIGUOUS.length)
  const end = rest.indexOf('}')
  try {
    const v = JSON.parse(rest.slice(0, end + 1)) as { txid?: unknown; batchTransferIdx?: unknown }
    if (typeof v.txid !== 'string' || !/^[0-9a-f]{64}$/.test(v.txid)) return null
    return { txid: v.txid, batchTransferIdx: Number.isInteger(v.batchTransferIdx) ? (v.batchTransferIdx as number) : null }
  } catch { return null }
}
