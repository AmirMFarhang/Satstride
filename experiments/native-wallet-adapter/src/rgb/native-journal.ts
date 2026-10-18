import { bytesToHex, hashObject, hexToBytes, isHex, type Hex } from '../core/crypto.js'
import type { NativeWalletPort } from './native-port.js'

/** Stable across RPC keys, request IDs, reconnects and changes of transport. */
export function nativeLoanSlot(walletId: Hex, obligationId: Hex, action: 'origination' | 'repayment'): Hex {
  if (!isHex(walletId, 32) || !isHex(obligationId, 32)) throw new TypeError('native wallet and obligation identities required')
  return hashObject({ domain: 'passbook-native-loan-slot/v1', wallet_id: walletId, obligation_id: obligationId, action })
}
export class NativeReconciliationRequired extends Error {
  constructor(readonly slot: Hex, readonly stage: Hex) { super('NATIVE_RECONCILIATION_REQUIRED: a previous native call may have completed; inspect its retained operation before resuming') }
}
export class NativeOperationJournal {
  constructor(private readonly owner: NativeWalletPort) {}
  async reserve(slot: Hex, intent: unknown): Promise<void> {
    await this.owner.call('slot_reserve', { slot, intent_hash: hashObject(intent), intent })
  }
  /** Persist intent before a side effect, result before returning. An uncertain
   * call is never automatically repeated. Recovery supplies the exact native
   * result after reconciling the engine's operation/reservation index. */
  async effect<T>(slot: Hex, name: string, payload: unknown, invoke: () => Promise<T>): Promise<T> {
    const stage = hashObject({ domain: 'passbook-native-stage/v1', name })
    const claim = await this.owner.call<{ acquired: boolean; result: T | null }>('effect_claim', { slot, stage, payload })
    if (claim.result !== null) return claim.result
    if (!claim.acquired) throw new NativeReconciliationRequired(slot, stage)
    const result = await invoke()
    await this.owner.call('effect_result', { slot, stage, result })
    return result
  }
  async recordReconciledResult<T>(slot: Hex, name: string, result: T): Promise<void> {
    const stage = hashObject({ domain: 'passbook-native-stage/v1', name })
    await this.owner.call('effect_result', { slot, stage, result })
  }
  async retain(bytes: Uint8Array): Promise<{ sha256: Hex; byte_length: number }> {
    return this.owner.call('artifact_put', { hex: bytesToHex(bytes) })
  }
  async read(digest: Hex): Promise<Uint8Array> {
    const artifact = await this.owner.call<{ hex: string }>('artifact_get', { sha256: digest })
    return hexToBytes(artifact.hex)
  }
}
