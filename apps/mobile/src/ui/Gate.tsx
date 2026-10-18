// Routes on the worklet's own lifecycle: starting, no wallet, locked, ready, error.
import React, { useEffect, useRef } from 'react'
import { AppState, Linking } from 'react-native'
import { parseProviderLink } from '../core/network'
import { pendingProviderLink } from '../wallet/flags'
import { useWalletManager, useWdkApp } from '@tetherto/wdk-react-native-core'
import { P, Problem, Screen, Working } from './kit'
import { Main } from './Main'
import { Onboarding } from './Onboarding'
import { Unlock } from './Unlock'

/** Locks the wallet when the app goes to the background, so the seed is not left decrypted. */
function useLockOnBackground(ready: boolean) {
  const wm = useWalletManager()
  const lock = useRef(wm.lock)
  lock.current = wm.lock
  useEffect(() => {
    if (!ready) return
    const sub = AppState.addEventListener('change', (s) => { if (s === 'background') void lock.current().catch(() => {}) })
    return () => sub.remove()
  }, [ready])
}

/**
 * The provider's link (its QR opened by the phone's own camera app): kept until the person
 * confirms it in Settings, Network. Nothing changes from a link alone.
 */
function useProviderLink() {
  useEffect(() => {
    const keep = (url: string | null) => { if (url && !('error' in parseProviderLink(url))) pendingProviderLink.set(url) }
    void Linking.getInitialURL().then(keep).catch(() => {})
    const sub = Linking.addEventListener('url', (e) => keep(e.url))
    return () => sub.remove()
  }, [])
}

export function Gate() {
  const { state } = useWdkApp()
  useProviderLink()
  useLockOnBackground(state.status === 'READY')
  switch (state.status) {
    case 'NO_WALLET': return <Onboarding />
    case 'LOCKED': return <Unlock />
    case 'READY': return <Main />
    case 'ERROR': return (
      <Screen>
        <P>Something went wrong.</P>
        <Problem>{state.error.message}</Problem>
        <P muted>Close the app and open it again.</P>
      </Screen>
    )
    default: return <Screen scroll={false}><Working label="Starting the wallet engine on this phone" /></Screen>
  }
}
