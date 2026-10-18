// The whole app: pair with the borrower's Passbook node, then show what the node
// says and answer the borrower's own stops. Every screen sits in one frame that
// carries the network badge. Platform pieces (secure storage, the device lock,
// the camera, fetch) come in as `deps`, so tests drive the same component.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { NodeClient, pair, snapshot, Unpaired, type Fetch, type Paired, type Snapshot } from '../core/client.js'
import { short } from '../core/format.js'
import { screenName, type UiState } from '../core/model.js'
import { networkOf, NOT_PAIRED_BADGE } from '../core/network.js'
import { parsePairingLink, type PairingLink } from '../core/pairing.js'
import { newDeviceKey, type DeviceKeyPair } from '../core/signing.js'
import { PHONE_ONLY, SHARED, T } from '../core/strings.js'
import type { DeviceLock } from '../platform/lock'
import type { PairedStore } from '../platform/store'
import { Banner, Btn, Card, Colors, P, Top, useColors } from './kit'
import * as screens from './screens'
import { DARK, LIGHT } from './theme'

type Notice = { text: string; tone: 'ok' | 'info' }

export interface ScannerProps { onCode: (text: string) => void; onClose: () => void }

export interface Deps {
  store: PairedStore
  lock: DeviceLock
  fetch: Fetch
  now?: () => number
  newKey?: () => DeviceKeyPair
  /** How the node lists this phone, e.g. "Pixel 9". */
  label?: string
  pollMs?: number
  Scanner?: ComponentType<ScannerProps>
  /** A passbook://pair link the app was opened with (adb shell am start -d …), and later ones. */
  initialLink?: string | null
  onLink?: (cb: (url: string) => void) => () => void
}

export function Phone({ deps }: { deps: Deps }) {
  const colors = useColorScheme() === 'dark' ? DARK : LIGHT
  const now = deps.now ?? Date.now
  const [paired, setPaired] = useState<Paired | null | undefined>(undefined)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** ok: something the borrower did went through; info: something happened to the pairing */
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [ui, setUi] = useState<UiState>({ tab: 'passbook', page: null, termsheet: false })
  const [unticked, setUnticked] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PairingLink | null>(null)
  const [scanning, setScanning] = useState(false)
  const [pasted, setPasted] = useState('')
  const alive = useRef(true)
  /** one poll at a time: a slow node must not stack requests */
  const polling = useRef(false)
  /** a refresh asked for while a poll was in flight: run it as soon as that poll ends */
  const again = useRef(false)
  /** bumped by every answer the phone sends; a poll that started before it read the old stop and is dropped */
  const answers = useRef(0)
  /** the current pairing was already dropped: forget it once, however many requests were refused */
  const dropped = useRef(false)

  useEffect(() => {
    alive.current = true
    deps.store.load().then((p) => alive.current && setPaired(p && p.expires_at > now() ? p : null), () => alive.current && setPaired(null))
    return () => { alive.current = false }
  }, [])

  const offerLink = useCallback((text: string) => {
    try {
      setPending(parsePairingLink(text, now()))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (deps.initialLink) offerLink(deps.initialLink)
    return deps.onLink?.((url) => offerLink(url))
  }, [])

  const client = useMemo(() => (paired ? new NodeClient(paired.node, paired.key, deps.fetch, now) : null), [paired])

  const unpair = useCallback(async (reason: string) => {
    if (dropped.current) return
    dropped.current = true
    await deps.store.forget().catch(() => {})
    if (!alive.current) return
    setPaired(null)
    setSnap(null)
    setUi({ tab: 'passbook', page: null, termsheet: false })
    setNotice({ text: `${PHONE_ONLY.unpaired}: ${reason}`, tone: 'info' })
  }, [])

  const refresh = useCallback(async () => {
    if (!client || !paired) return
    if (polling.current) { again.current = true; return }
    polling.current = true
    const seen = answers.current
    try {
      const s = await snapshot(client, paired.borrower_pk, now)
      if (!alive.current) return
      // the phone answered a stop while this poll was out: it may show that stop again, so read once more instead
      if (seen !== answers.current) again.current = true
      else {
        setSnap(s)
        setError(null)
      }
    } catch (e) {
      if (e instanceof Unpaired) await unpair(e.message)
      else if (alive.current) setError((e as Error).message)
    } finally {
      polling.current = false
      if (again.current && alive.current) {
        again.current = false
        void refreshRef.current()
      }
    }
  }, [client, paired])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    if (!client) return
    void refresh()
    const t = setInterval(() => void refresh(), deps.pollMs ?? 2000)
    return () => clearInterval(t)
  }, [client, refresh])

  const doPair = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const p = await pair(pending, (deps.newKey ?? newDeviceKey)(), deps.label ?? 'Android phone', deps.fetch, now)
      await deps.store.save(p)
      dropped.current = false
      setPending(null)
      setPasted('')
      setNotice(null)
      setPaired(p)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Share, approve and pay need the phone's lock first; declining does not. */
  const act = async (what: 'share' | 'accept' | 'decline' | 'repay', arg?: unknown) => {
    if (!client || busy) return
    setError(null)
    if (what !== 'decline') {
      const unlocked = await deps.lock(PHONE_ONLY.lockPrompt)
      if (!unlocked.ok) { setError(unlocked.message); return }
    }
    setBusy(true)
    try {
      const r = what === 'share' ? await client.share(arg as string[])
        : what === 'repay' ? await client.confirm('repay', true, arg as string)
        : await client.confirm('accept', what === 'accept', arg as string)
      if (r.ok === false) setError(SHARED.noLonger)
      else {
        // the node took the answer, so that stop is closed: don't show it (or its button) until the next poll says what comes next
        setSnap((cur) => (cur?.demo ? { ...cur, demo: { ...cur.demo, waiting: { waiting: null } } } : cur))
        if (what === 'accept') setNotice({ text: T.approvedSheet(short(arg, 12)), tone: 'ok' })
        setUi((u) => ({ ...u, termsheet: false }))
        setUnticked(new Set())
      }
    } catch (e) {
      if (e instanceof Unpaired) await unpair(e.message)
      else setError((e as Error).message)
    } finally {
      answers.current += 1
      setBusy(false)
      void refresh()
    }
  }

  if (paired === undefined) return <Colors.Provider value={colors}><Frame badge={NOT_PAIRED_BADGE} test /></Colors.Provider>

  if (!paired) {
    if (scanning && deps.Scanner) {
      const Scanner = deps.Scanner
      return (
        <Colors.Provider value={colors}>
          <Frame badge={NOT_PAIRED_BADGE} test scroll={false}>
            <Scanner onCode={(text) => { setScanning(false); offerLink(text) }} onClose={() => setScanning(false)} />
          </Frame>
        </Colors.Provider>
      )
    }
    return (
      <Colors.Provider value={colors}>
        <Frame badge={NOT_PAIRED_BADGE} test error={error} notice={notice} cta={pending ? <Btn testID="pair" label={busy ? PHONE_ONLY.pairing : PHONE_ONLY.pair} onPress={() => void doPair()} disabled={busy} /> : undefined}>
          <Top title={PHONE_ONLY.pairTitle} />
          <P>{PHONE_ONLY.pairHint}</P>
          {deps.Scanner ? <Btn testID="scan" label={PHONE_ONLY.scan} onPress={() => setScanning(true)} /> : null}
          <P small muted>{PHONE_ONLY.pasteLink}</P>
          <PasteBox value={pasted} onChange={setPasted} onSubmit={() => offerLink(pasted)} />
          {pending ? (
            <Card>
              <P>{T.pairWith(short(pending.borrower_pk, 12), pending.node)}</P>
              <P small muted>{T.keyExpires(new Date(now() + pending.key_ttl_ms).toLocaleString())}</P>
            </Card>
          ) : null}
        </Frame>
      </Colors.Provider>
    )
  }

  const net = networkOf(snap?.state, snap?.network)
  const name = screenName(true, snap, ui)
  const props: screens.ScreenProps = {
    snap, net, borrowerPk: paired.borrower_pk, busy, act: (w, a) => void act(w, a),
    openPage: (id) => setUi((u) => ({ ...u, page: id })),
    openTermSheet: (open) => setUi((u) => ({ ...u, termsheet: open })),
    unticked,
    toggleTick: (txid) => setUnticked((prev) => { const n = new Set(prev); if (n.has(txid)) n.delete(txid); else n.add(txid); return n }),
  }
  const screen = name === 'page' ? screens.page({ ...props, loanId: ui.page! }) : name === 'pair' ? screens.home(props) : screens[name](props)
  const connected = !!snap && !error
  return (
    <Colors.Provider value={colors}>
      <Frame
        badge={net.badge}
        test={net.test}
        node={paired.node}
        connected={connected}
        error={error}
        notice={notice}
        banner={snap && !snap.platform_online ? PHONE_ONLY.platformOff : null}
        cta={screen.cta}
        tabs={screen.tabs ? <Tabs tab={ui.tab} onTab={(tab) => setUi({ tab, page: null, termsheet: false })} /> : undefined}
      >
        {screen.body}
        {name === 'wallet' ? <Btn kind="link" label={PHONE_ONLY.forget} onPress={() => void unpair('unpaired on this phone')} /> : null}
      </Frame>
    </Colors.Provider>
  )
}

function PasteBox({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  const c = useColors()
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <TextInput testID="paste" value={value} onChangeText={onChange} onSubmitEditing={onSubmit} placeholder="passbook://pair?…" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} style={[f.input, { color: c.ink, borderColor: c.line, backgroundColor: c.panel }]} />
      <Btn kind="second" label="OK" onPress={onSubmit} disabled={!value.trim()} />
    </View>
  )
}

function Tabs({ tab, onTab }: { tab: UiState['tab']; onTab: (t: UiState['tab']) => void }) {
  const c = useColors()
  const item = (id: UiState['tab'], label: string) => (
    <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} onPress={() => onTab(id)} style={f.tab}>
      <Text style={{ color: tab === id ? c.accent : c.muted, fontWeight: tab === id ? '700' : '500' }}>{label}</Text>
    </Pressable>
  )
  return <View accessibilityRole="tablist" style={[f.tabs, { borderColor: c.line, backgroundColor: c.panel }]}>{[item('passbook', SHARED.passbook), item('wallet', SHARED.wallet), item('offers', PHONE_ONLY.offers)]}</View>
}

/** Every screen: the network badge first, then whether the node is reachable, then the screen. */
export function Frame({ badge, test, node, connected, error, notice, banner, cta, tabs, scroll = true, children }: { badge: string; test: boolean; node?: string; connected?: boolean; error?: string | null; notice?: Notice | null; banner?: string | null; cta?: ReactNode; tabs?: ReactNode; scroll?: boolean; children?: ReactNode }) {
  const c = useColors()
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={['top', 'bottom', 'left', 'right']}>
      <View style={[f.bar, { borderColor: c.line, backgroundColor: c.panel }]}>
        <Text testID="network-badge" accessibilityLabel={`Network: ${badge}`} style={[f.badge, test ? { backgroundColor: c.warnSoft, color: c.warn } : { backgroundColor: c.okSoft, color: c.ok }]}>{badge}</Text>
        {node ? <Text testID="connection" style={[f.conn, { color: connected ? c.muted : c.bad }]} numberOfLines={1}>{connected ? `${PHONE_ONLY.connected} · ${node.replace(/^https?:\/\//, '')}` : node.replace(/^https?:\/\//, '')}</Text> : null}
      </View>
      {scroll ? (
        <ScrollView contentContainerStyle={f.body} keyboardShouldPersistTaps="handled">
          {error ? <Banner tone="bad">{error}</Banner> : null}
          {banner ? <Banner>{banner}</Banner> : null}
          {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
          {children}
        </ScrollView>
      ) : <View style={{ flex: 1 }}>{children}</View>}
      {cta ? <View style={[f.foot, { borderColor: c.line, backgroundColor: c.bg }]}>{cta}</View> : null}
      {tabs}
    </SafeAreaView>
  )
}

const f = StyleSheet.create({
  bar: { paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  badge: { alignSelf: 'flex-start', fontSize: 12, fontWeight: '800', letterSpacing: 0.8, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: 'hidden' },
  conn: { fontSize: 12 },
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  foot: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
})
