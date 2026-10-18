// Settings, Network: which test network the phone talks to and where its provider is. Mutinynet
// needs no cable: an Electrum server, KaleidoSwap's RGB proxy and public Nostr relays on the
// internet, and the platform where the provider says (its link or QR, opened by the phone's own
// camera app, lands here to be confirmed). With the platform's key from that link the phone talks
// to the platform over Nostr and the address is only the fallback. The worklet is set up when the
// app starts, so a change takes effect the next time Passbook opens. Mainnet does not exist here.
import React, { useState } from 'react'
import { Text, View } from 'react-native'
import { NETWORK_NAMES, overrideProblems, parseProviderLink, type NetworkName } from '../../core/network'
import { NETWORK, NETWORK_PROBLEM } from '../../wallet/config'
import { networkSettings, pendingProviderLink } from '../../wallet/flags'
import { Button, Choices, Field, FlowTop, KV, Note, P, Problem, Rows, Row, Screen, Undo } from '../kit'
import { useNav } from '../nav'
import { t } from '../theme'

const TITLE: Record<NetworkName, string> = { regtest: 'Regtest (laptop, USB)', mutinynet: 'Mutinynet (internet)' }

export function NetworkSettings() {
  const nav = useNav()
  const saved = networkSettings.get()
  const pending = pendingProviderLink.get()
  const [name, setName] = useState<NetworkName>((saved.name === 'mutinynet' ? 'mutinynet' : 'regtest'))
  const [platform, setPlatform] = useState(saved.platform ?? (saved.name === NETWORK.name ? NETWORK.platform : ''))
  const [platformPk, setPlatformPk] = useState(saved.platformPk ?? '')
  const [proxy, setProxy] = useState(saved.proxy ?? '')
  const [relays, setRelays] = useState((saved.relays ?? []).join(', '))
  const [paste, setPaste] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const apply = (link: string) => {
    const r = parseProviderLink(link)
    if ('error' in r) { setProblem(`Not used: ${r.error}`); return }
    setName(r.name); setPlatform(r.overrides.platform ?? ''); setRelays((r.overrides.relays ?? []).join(', '))
    setPlatformPk(r.overrides.platformPk ?? ''); setProxy(r.overrides.proxy ?? '')
    setProblem(null); setNote(`From the provider${r.platformPk ? ` (platform key ${r.platformPk.slice(0, 8)}…)` : ''}. Check it, then save.`)
  }
  const save = () => {
    const rl = relays.split(',').map((x) => x.trim()).filter(Boolean)
    const pk = platformPk.trim().toLowerCase()
    const overrides = { ...(platform ? { platform: platform.trim() } : {}), ...(pk ? { platformPk: pk } : {}), ...(rl.length ? { relays: rl } : {}), ...(proxy ? { proxy } : {}) }
    const problems = overrideProblems(name, overrides)
    if (problems.length) { setProblem(`Not saved: ${problems.join('; ')}`); return }
    networkSettings.set({ name, ...overrides })
    pendingProviderLink.clear()
    setProblem(null)
    const same = name === NETWORK.name && (overrides.platform ?? NETWORK.platform) === NETWORK.platform && (overrides.platformPk ?? null) === NETWORK.platformPk
    setNote(same ? 'Saved.' : 'Saved. To switch, close Passbook completely (swipe it away from your recent apps), then open it again.')
  }

  return (
    <Screen top={<FlowTop title="Network" onBack={nav.pop} />} bottom={<>
      <Button label="Save" onPress={save} />
      <Undo text="Test networks only; the change takes effect when Passbook opens again" />
    </>}>
      <Rows topLine>
        <Row k="Now" v={NETWORK.badge} />
        <Row k="Bitcoin" v={`${NETWORK.electrum.host}:${NETWORK.electrum.port}`} mono />
        <Row k="RGB proxy" v={NETWORK.proxy.replace(/^rpcs?:\/\//, '')} mono />
        <Row k="Platform" v={NETWORK.platformPk ? `over Nostr · ${NETWORK.platformPk.slice(0, 8)}…` : NETWORK.platform || 'not set'} mono tone={NETWORK.platformPk || NETWORK.platform ? undefined : 'warn'} />
        {NETWORK.platformPk ? <Row k="Fallback" v={NETWORK.platform || 'none'} mono /> : null}
        <Row k="Relays" v={String(NETWORK.relays.length)} />
      </Rows>
      {NETWORK_PROBLEM ? <Problem>{`The saved settings were not used: ${NETWORK_PROBLEM}`}</Problem> : null}
      {pending ? <Note tone="warn" icon="info" title="The provider sent its settings" sub="Opened from its link. Review below before saving." /> : null}
      {pending ? <Button kind="secondary" label="Use the provider's settings" onPress={() => apply(pending)} /> : null}
      <View style={{ gap: 10 }}>
        <Text style={t.small}>Network</Text>
        <Choices label="Network" options={NETWORK_NAMES.map((n) => ({ id: n, label: TITLE[n] }))} value={name} onChange={(v) => {
          // another network's platform and relays never carry over
          setName(v); setNote(null)
          setPlatform(v === saved.name ? saved.platform ?? '' : v === NETWORK.name ? NETWORK.platform : '')
          setRelays(v === saved.name ? (saved.relays ?? []).join(', ') : '')
          setPlatformPk(v === saved.name ? saved.platformPk ?? '' : ''); setProxy(v === saved.name ? saved.proxy ?? '' : '')
        }} />
      </View>
      <Field label="Platform key (over Nostr, from the provider's link)" value={platformPk} onChangeText={setPlatformPk} placeholder="64 hex characters" autoCapitalize="none" />
      <Field label={platformPk ? 'Platform address (fallback, optional)' : 'Platform address'} value={platform} onChangeText={setPlatform} placeholder={name === 'regtest' ? 'http://127.0.0.1:4301' : 'http://192.168.1.20:4301'} autoCapitalize="none" keyboardType="url" />
      <Field label="Relays (comma-separated, optional)" value={relays} onChangeText={setRelays} placeholder={name === 'mutinynet' ? 'wss://relay.primal.net, wss://nos.lol' : 'ws://127.0.0.1:7937'} autoCapitalize="none" />
      <Field label="Or paste the provider's link" value={paste} onChangeText={(v) => { setPaste(v); if (v.startsWith('passbookwallet://')) apply(v) }} placeholder="passbookwallet://provider?network=mutinynet&…" autoCapitalize="none" />
      <P small>Mutinynet is a public test network: its coins have no value, and every amount here says so. Mainnet does not exist in this wallet.</P>
      {note ? <KV k="" v={note} /> : null}
      <Problem>{problem}</Problem>
    </Screen>
  )
}
