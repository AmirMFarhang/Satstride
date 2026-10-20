import type { ChainClient } from './types.js'
import type { Hex } from '../core/crypto.js'
import { confirmedUnspent } from '../rgb/history-observer.js'
import type { ReconcileOptions } from '../sandbox/reconcile.js'

/**
 * The native allocations must still be unspent: `gettxout` on the checker's own node, as the sandbox asks it
 * (src/sandbox/run.ts), or on a public test network an Esplora (Mutinynet): the output's spent status from
 * /tx/:id/outspend/:vout and its value and script from the confirmed transaction. Undefined when the chain client
 * can do neither; reconciliation then fails closed for any non-empty allocation.
 */
export function nodeUnspent(chain: ChainClient): ReconcileOptions['getUnspent'] {
  const node = chain as ChainClient & { rpc?: <T>(method: string, params: unknown[]) => Promise<T>; outspends?: (txid: Hex) => Promise<{ spent: boolean }[]> }
  if (typeof node.rpc === 'function') {
    return async (txid, vout) => {
      const out = await node.rpc!<{ value: number; scriptPubKey: { hex: Hex } } | null>('gettxout', [txid, vout, true])
      return out ? { value: Math.round(out.value * 1e8), script: out.scriptPubKey.hex } : null
    }
  }
  if (typeof node.outspends === 'function') {
    // the same Esplora re-check the history observer uses (src/rgb/history-observer.ts, #75)
    return async (txid, vout) => {
      const u = await confirmedUnspent(node as Parameters<typeof confirmedUnspent>[0], txid, vout)
      return u ? { value: u.sats, script: u.script } : null
    }
  }
  return undefined
}

/** The default window on a public test network read through Esplora: 240 blocks, about 2 hours of Mutinynet's 30-s blocks. */
export const PUBLIC_NETWORK_PROOF_MAX_AGE_BLOCKS = 240

/**
 * How many blocks old the observer's history proof may be. PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS when set; otherwise
 * by the chain the checker reads: 0 on its own bitcoind (the proof must be at the current height, as on regtest where
 * blocks come on demand), PUBLIC_NETWORK_PROOF_MAX_AGE_BLOCKS on an Esplora (a public test network keeps mining:
 * Mutinynet about every 30 s). Every allocation is still re-checked unspent at check time, so a later spend is caught.
 */
export function historyProofMaxAge(env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env, chainKind?: string): number {
  if (['mainnet', 'bitcoin', 'main'].includes((env.PASSBOOK_PUBLIC_NETWORK ?? '').trim().toLowerCase())) throw new Error('chain checks refuse mainnet')
  const raw = env.PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS
  if (raw === undefined || raw === '') return chainKind === 'esplora' ? PUBLIC_NETWORK_PROOF_MAX_AGE_BLOCKS : 0
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0 || n > 4320) throw new Error('PASSBOOK_HISTORY_PROOF_MAX_AGE_BLOCKS must be 0 to 4320 blocks')
  return n
}

