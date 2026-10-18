// The pairing (node URL, device key, scope, expiry) lives in the platform's
// secure storage: Android Keystore-backed, this device only, readable only
// while unlocked, and excluded from backups (app.json allowBackup: false).

import * as SecureStore from 'expo-secure-store'
import type { Paired } from '../core/client.js'

const KEY = 'passbook.device.v1'
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

export interface PairedStore {
  load(): Promise<Paired | null>
  save(p: Paired): Promise<void>
  forget(): Promise<void>
}

export const secureStore: PairedStore = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY, OPTS)
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as Paired
      return p && typeof p.node === 'string' && /^[0-9a-f]{64}$/.test(p.key?.secret ?? '') ? p : null
    } catch {
      return null
    }
  },
  save: (p) => SecureStore.setItemAsync(KEY, JSON.stringify(p), OPTS),
  forget: () => SecureStore.deleteItemAsync(KEY, OPTS),
}
