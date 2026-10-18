// Small non-secret app state (MMKV). Nothing here can move coins or recover a seed.
import { createMMKV } from 'react-native-mmkv'

const store = createMMKV({ id: 'passbook-wallet-flags' })

/** Set once the user has typed back three of their words (or restored from words). */
export const backup = {
  verified: (): boolean => store.getBoolean('backup.verified') === true,
  markVerified: (): void => store.set('backup.verified', true),
  clear: (): void => { store.remove('backup.verified') },
}

/**
 * Which wallet the phone opens: the person's own (config WALLET_ID), or the seeded regtest test persona
 * (src/app/persona.ts), kept under its own wallet id so the person's own wallet is never overwritten.
 */
export const activeWallet = {
  get: (fallback: string): string => store.getString('wallet.active') ?? fallback,
  set: (id: string): void => store.set('wallet.active', id),
}

/**
 * Which test network and endpoints the next app start uses (src/core/network.ts profileFor):
 * set in Settings or from the provider's link, confirmed by the person. The worklet is configured
 * at start, so a change takes effect when the app opens again.
 */
export interface NetworkSettings { name: string; platform?: string; platformPk?: string; relays?: string[]; proxy?: string }
export const networkSettings = {
  get: (): NetworkSettings => {
    const raw = store.getString('network.settings')
    if (raw === undefined) {
      // A fresh install (nothing stored by this app yet) starts on Mutinynet, the network that needs
      // no cable; an install that already holds state keeps regtest, as before.
      const fresh = store.getAllKeys().length === 0 && createMMKV({ id: 'passbook-agent' }).getAllKeys().length === 0
      const s: NetworkSettings = { name: fresh ? 'mutinynet' : 'regtest' }
      if (fresh) store.set('network.settings', JSON.stringify(s))
      return s
    }
    try { const v = JSON.parse(raw) as NetworkSettings | null; return v && typeof v.name === 'string' ? v : { name: 'regtest' } } catch { return { name: 'regtest' } }
  },
  set: (s: NetworkSettings): void => store.set('network.settings', JSON.stringify(s)),
}

/** A provider link the phone was opened with, waiting for the person to confirm it in Settings. */
export const pendingProviderLink = {
  get: (): string | null => store.getString('network.pending-link') ?? null,
  set: (link: string): void => store.set('network.pending-link', link),
  clear: (): void => { store.remove('network.pending-link') },
}
