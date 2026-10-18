// Canvas 20 (settings) and 21 (wallet health), and the recovery words behind the phone's lock.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { useWalletManager } from '@tetherto/wdk-react-native-core'
import { usePreventScreenCapture } from 'expo-screen-capture'
import { splitWords } from '../../core/backup'
import { activeWallet, backup, pendingProviderLink } from '../../wallet/flags'
import { personaTitle } from '../../app/persona'
import { NETWORK, WALLET_ID } from '../../wallet/config'
import { requirePhoneLock } from '../../wallet/phone-lock'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import { useWalletView } from '../../app/views'
import { Button, Disclosure, FlowTop, Hero, P, Problem, Row, Rows, Screen, Working } from '../kit'
import { useNav } from '../nav'
import { Icon } from '../icons'
import { C, F, t } from '../theme'
import { satsText, short } from '../format'
import pkg from '../../../package.json'

export function Settings() {
  const s = useApp()
  const nav = useNav()
  const wm = useWalletManager()
  const prefs = useStore(s.prefs)
  const [problem, setProblem] = useState<string | null>(null)
  const showWords = async () => {
    setProblem(null)
    const lock = await requirePhoneLock('Show your recovery words')
    if (!lock.ok) return setProblem(lock.reason)
    try {
      const m = await wm.getMnemonic(activeWallet.get(WALLET_ID))
      if (!m) return setProblem('No words stored for this wallet.')
      nav.push('words', { words: splitWords(m) })
    } catch (e) { setProblem((e as Error).message) }
  }
  return (
    <Screen top={<FlowTop title="Settings" onBack={nav.pop} />} bottom={<P small center>Pseudonymous. No identity documents collected.</P>}>
      <Section title="Backup">
        <Rows>
          <Row k="12 recovery words" v={backup.verified() ? <Ok text="written down" /> : 'not checked'} tone={backup.verified() ? undefined : 'warn'} onPress={() => void showWords()} />
          <Row k="Wallet records" v="not backed up on this build" tone="muted" />
        </Rows>
        <P small>Your words restore your bitcoin. Assets also need the RGB wallet records, which stay on this phone in this build.</P>
      </Section>
      <Section title="Display">
        <Rows>
          <Row k="Bitcoin unit" v={NETWORK.btcUnit} />
          <View style={st.switchRow}>
            <Text style={[t.body, { color: C.muted }]}>Show chain details</Text>
            <Switch accessibilityLabel="Show chain details" value={prefs.chainDetails} onValueChange={(v) => s.setPrefs({ chainDetails: v })} trackColor={{ true: C.green, false: C.track }} thumbColor={C.white} />
          </View>
        </Rows>
      </Section>
      <Section title={`${NETWORK.name === 'regtest' ? 'Regtest' : 'Mutinynet'} test data`}>
        <Rows>
          {s.borrowerState.persona
            ? <Row k={`Test persona ${personaTitle(s.borrowerState.persona.name)} is active`} v="Back to your own wallet" tone="warn" onPress={() => nav.push('persona')} />
            : <Row k={`Use the seeded test persona (${NETWORK.name} test data)`} onPress={() => nav.push('persona')} />}
        </Rows>
        <P small>For the acceptance run only: a persona the service provider seeded and its observer watched from zero. Your own wallet stays on this phone.</P>
      </Section>
      <Section title="Support">
        <Rows>
          <Row k="Wallet health" onPress={() => nav.push('health')} />
          <Row k="Your passbook key" v={short(s.key.pubkey, 6)} mono />
          <Row k="Network" v={pendingProviderLink.get() ? 'provider settings received' : NETWORK.badge} tone={pendingProviderLink.get() ? 'warn' : undefined} onPress={() => nav.push('network')} />
          <Row k="Version" v={`${pkg.version} · dev.passbook.wallet`} />
        </Rows>
      </Section>
      <Button kind="secondary" label="Lock the wallet" onPress={() => void wm.lock()} />
      <Problem>{problem}</Problem>
    </Screen>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={{ gap: 4 }}><Text style={t.small}>{title}</Text>{children}</View>
}
function Ok({ text }: { text: string }) {
  return <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><Icon name="check" size={16} color={C.green} /><Text style={[t.bodyMedium, { color: C.green }]}>{text}</Text></View>
}

export function Words({ params }: { params: Record<string, unknown> }) {
  const nav = useNav()
  // never in a screenshot, a screen recording or a USB screen capture
  usePreventScreenCapture('show-words')
  const words = (params.words as string[]) ?? []
  return (
    <Screen top={<FlowTop title="Recovery words" onBack={nav.pop} />} bottom={<Button label="Hide" onPress={nav.pop} />}>
      <P>Only you should see these. Anyone with them can spend from this wallet.</P>
      <View style={st.grid}>
        {words.map((w, i) => (
          <View key={i} style={st.cell}><Text style={t.small}>{i + 1}</Text><Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>{w}</Text></View>
        ))}
      </View>
    </Screen>
  )
}

export function WalletHealth() {
  const s = useApp()
  const nav = useNav()
  const w = useWalletView(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Awaited<ReturnType<typeof s.module.rgbUnspents>> | null>(null)
  const r = w.data?.reserve
  const pending = (w.data?.transfers ?? []).filter((x) => !['Settled', 'Failed'].includes(x.status))
  const unsent = pending.filter((x) => x.kind === 'Send' && x.status === 'Initiated')
  const good = !!r && r.freeSlots >= 1 && unsent.length === 0
  const tidy = async () => {
    setProblem(null); setBusy('Tidying up')
    try {
      // a send that stopped before it was signed still holds its coins in rgb-lib: give them back
      const outcomes = await s.module.rgbFailPending({})
      // only payments proven never broadcast are cancelled; the worklet refuses the rest
      const kept = outcomes.filter((o) => o.refused || o.cannotFail || !o.transfersChanged)
      await w.reload()
      if (kept.length) setProblem(`Kept ${kept.length} payment(s): ${kept.map((o) => o.refused ?? 'rgb-lib refused').join(', ')}. A payment that may be on the network is never cancelled.`)
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <Screen top={<FlowTop title="Wallet health" onBack={nav.pop} />} bottom={
      <Button kind="secondary" label="Tidy up now" busy={!!busy} disabled={!unsent.length} onPress={() => void tidy()} />
    }>
      <Hero value={!r ? '…' : good ? 'All good' : 'Needs a look'} />
      <Rows>
        <Row k="Reserve" v={r ? `${r.slots} slots · ${r.freeSlots} free` : '…'} tone={r && r.freeSlots === 0 ? 'warn' : undefined} />
        <Row k="Bitcoin for fees" v={r ? satsText(r.ready) : '…'} />
        <Row k="For your next loan" v={r ? satsText(r.forLoans) : '…'} />
        <Row k="Pending payments" v={pending.length ? `${pending.length} (${unsent.length} unsent)` : 'none'} />
        <Row k="Records backup" v="on this phone only" tone="muted" />
      </Rows>
      <Disclosure label={`Outputs${outputs ? ` (${outputs.length})` : ''}`}>
        {outputs === null ? <Pressable onPress={async () => setOutputs(await s.module.rgbUnspents({ skipSync: true }))}><Text style={[t.body, { color: C.green }]}>Read the outputs</Text></Pressable>
          : outputs.map((u) => (
            <View key={u.outpoint} style={st.out}>
              <Text style={[t.mono, { flex: 1 }]}>{short(u.outpoint.split(':')[0], 4)}:{u.outpoint.split(':')[1]}</Text>
              <Text style={t.mono}>{u.sats.toLocaleString('en-US')}</Text>
              <Text style={[t.tiny, { width: 96, textAlign: 'right' }]}>{u.allocations.length ? u.allocations.map((a) => `${a.amount / 1e6}`).join(' + ') : u.colorable ? (u.free ? 'free' : 'pending') : 'spendable'}</Text>
            </View>
          ))}
      </Disclosure>
      <Working label={busy ?? (w.loading && !w.data ? 'Reading the wallet' : null)} />
      <Problem>{problem ?? w.error}</Problem>
    </Screen>
  )
}

const st = StyleSheet.create({
  switchRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '31%', borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 8, gap: 2 },
  out: { flexDirection: 'row', gap: 8, alignItems: 'center' },
})
