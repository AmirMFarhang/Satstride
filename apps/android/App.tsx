// Wires the real platform pieces into the phone: secure storage, the device
// lock, the camera, deep links (passbook://pair?…) and fetch.

import './src/platform/crypto-polyfill'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { Linking, Platform } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { deviceLock } from './src/platform/lock'
import { secureStore } from './src/platform/store'
import { Phone } from './src/ui/Phone'
import { Scanner } from './src/ui/Scanner'

const label = String((Platform.constants as { Model?: string }).Model ?? 'Android phone').slice(0, 40)

export default function App() {
  const [initial, setInitial] = useState<string | null | undefined>(undefined)
  useEffect(() => { Linking.getInitialURL().then((u) => setInitial(u), () => setInitial(null)) }, [])
  if (initial === undefined) return null
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Phone
        deps={{
          store: secureStore,
          lock: deviceLock,
          fetch: (url, init) => fetch(url, init),
          label,
          Scanner,
          initialLink: initial,
          onLink: (cb) => { const sub = Linking.addEventListener('url', ({ url }) => cb(url)); return () => sub.remove() },
        }}
      />
    </SafeAreaProvider>
  )
}
