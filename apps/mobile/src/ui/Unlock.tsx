// The wallet is on this phone and locked: the phone's own lock opens it.
import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useWalletManager } from '@tetherto/wdk-react-native-core'
import { NETWORK, WALLET_ID } from '../wallet/config'
import { activeWallet } from '../wallet/flags'
import { PERSONA_WALLET_ID } from '../app/persona'
import { requirePhoneLock } from '../wallet/phone-lock'
import { Button, P, Problem, Screen } from './kit'
import { Icon } from './icons'
import { C, F, t } from './theme'

export function Unlock() {
  const wm = useWalletManager()
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setProblem(null)
    const lock = await requirePhoneLock('Open your PassBook wallet')
    if (!lock.ok) return setProblem(lock.reason)
    setBusy(true)
    try { await wm.unlock(activeWallet.get(WALLET_ID)) } catch (e) { setProblem(`Could not open the wallet: ${(e as Error).message}`) } finally { setBusy(false) }
  }
  return (
    <Screen scroll={false} bottom={<>
      <Button label="Unlock" busy={busy} onPress={() => void open()} />
      {activeWallet.get(WALLET_ID) === PERSONA_WALLET_ID ? <Button kind="ghost" label="Open your own wallet instead" disabled={busy} onPress={() => { activeWallet.set(WALLET_ID); void open() }} /> : null}
    </>}>
      <View style={st.center}>
        <View style={st.logo}><Icon name="logo" size={40} color={C.white} /></View>
        <Text style={st.name} accessibilityRole="header">Wallet locked</Text>
        <Text style={[t.sub, { textAlign: 'center', maxWidth: 280 }]}>{activeWallet.get(WALLET_ID) === PERSONA_WALLET_ID ? `The seeded ${NETWORK.name} test persona is on this phone (test data). Unlock it with your phone's lock.` : "Your wallet is on this phone. Unlock it with your phone's lock."}</Text>
      </View>
      <Problem>{problem}</Problem>
    </Screen>
  )
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  logo: { width: 76, height: 76, borderRadius: 24, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: F.semibold, fontSize: 26, color: C.ink },
})
