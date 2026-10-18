// Canvas 3: bitcoin and assets, no output decisions. The big number is the main bitcoin
// account; what the wallet keeps aside for assets and loans is the "reserved" chip.
import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useApp } from '../../app/session'
import { useWalletView } from '../../app/views'
import { Button, Chip, Hero, IconButton, KV, P, Problem, Row, Rows, Screen, Sheet, TabBar, TabTop, Working, Offline } from '../kit'
import { RowBones, Skeleton } from '../../motion/Skeleton'
import { isConnectionError } from '../errors'
import { useNav, useTabSwitch } from '../nav'
import { C, F, t } from '../theme'
import { btc, satsText, usdNum } from '../format'
import { pendingSends } from '../../wallet/pending-sends'

export function WalletTab() {
  const s = useApp()
  const nav = useNav()
  const onTab = useTabSwitch()
  const [sync, setSync] = useState(false)
  const w = useWalletView(sync)
  const [reserve, setReserve] = useState(false)
  const main = s.btc.balance
  const r = w.data?.reserve
  const reserved = r ? r.holding + r.ready + r.forLoans : null
  const refresh = async () => { setSync(true); await s.btc.refresh(); await w.reload() }
  return (
    <Screen top={<TabTop title="Wallet" right={<IconButton name="gear" label="Settings" onPress={() => nav.push('settings')} side="right" />} />} bottom={<TabBar tab="wallet" onTab={onTab} />}>
      <View style={{ alignItems: 'center', gap: 6 }}>
        <Hero value={main === null ? '…' : btc(main)} />
        {reserved !== null ? <Chip label={`+ ${satsText(reserved)} reserved`} icon="info" onPress={() => setReserve(true)} /> : null}
      </View>
      {pendingSends.list().length ? <Row k="A payment's state is unknown" v="Check" tone="warn" onPress={() => nav.push('send-check', { txid: pendingSends.list()[0].txid })} /> : null}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Button label="Receive" onPress={() => nav.push('receive')} style={{ flex: 1 }} />
        <Button kind="secondary" label="Send" onPress={() => nav.push('send')} style={{ flex: 1, height: 56 }} />
      </View>
      <View>
        <Text style={[t.small, { paddingBottom: 6 }]}>Assets</Text>
        <Rows>
          {(w.data?.assets ?? []).map((a) => (
            <View key={a.assetId} style={st.asset}>
              <View style={st.assetLeft}>
                <View style={st.coin}><Text style={st.coinText}>$</Text></View>
                <View>
                  <Text style={[t.bodyMedium, { fontSize: 16 }]}>test {a.ticker}</Text>
                  <Text style={t.tiny}>{a.name} · {a.assetId.slice(0, 12)}…</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 18 }]}>{usdNum(a.settled, a.precision)}</Text>
                {a.future !== a.settled ? <Text style={t.tiny}>{usdNum(a.future, a.precision)} incl. pending</Text> : null}
              </View>
            </View>
          ))}
          {w.data && !w.data.assets.length ? <Row k="No assets yet" v="Receive test USDT" tone="muted" onPress={() => nav.push('receive', { kind: 'usdt' })} /> : null}
          {w.data?.locked ? <Row k="In your passbook safe" v={btc(w.data.locked)} /> : null}
        </Rows>
      </View>
      <View>
        <View style={st.actHead}>
          <Text style={t.small}>Activity</Text>
          <Button kind="ghost" label={w.loading ? 'Refreshing…' : 'Refresh'} onPress={() => void refresh()} />
        </View>
        <Rows topLine>
          {(w.data?.transfers ?? []).filter((x) => x.amount > 0).slice(0, 4).map((x) => (
            <Row key={`r${x.assetId}:${x.idx}`} k={`${x.ticker ? `test ${x.ticker}` : 'Asset'} ${x.kind.startsWith('Receive') ? 'received' : x.kind === 'Issuance' ? 'issued' : 'sent'}${x.status === 'Settled' ? '' : ` · ${x.status}`}`}
              v={`${x.kind === 'Send' ? '−' : '+'}${usdNum(x.amount)}`} tone={x.kind === 'Send' ? undefined : 'green'} />
          ))}
          {s.btc.transfers.slice(0, 3).map((x) => (
            <Row key={`b${x.txid}:${x.direction}`} k={`Bitcoin ${x.direction === 'in' ? 'received' : 'sent'}${x.height > 0 ? '' : ' · unconfirmed'}`} v={`${x.direction === 'in' ? '+' : '−'}${satsText(x.sats)}`} tone={x.direction === 'in' ? 'green' : undefined} />
          ))}
        </Rows>
        {w.data && !w.data.transfers.length && !s.btc.transfers.length ? <P muted>No activity yet.</P> : null}
      </View>
      {w.loading && !w.data ? <Skeleton label="Reading the wallet"><RowBones rows={3} /></Skeleton> : null}
      <Offline error={w.error ?? s.btc.error} busy={w.loading} onRetry={() => void refresh()} />
      <Problem>{[w.error, s.btc.error].find((e) => e && !isConnectionError(e)) ?? null}</Problem>
      <Sheet visible={reserve} onClose={() => setReserve(false)} title="Reserved bitcoin">
        <P>Assets on Bitcoin sit on small amounts of bitcoin, and a loan locks bitcoin from your passbook key. It is still yours.</P>
        {r ? <>
          <KV k="Holding your assets" v={satsText(r.holding)} />
          <KV k="Ready for next payments" v={satsText(r.ready)} />
          <KV k="Ready for your next loan" v={satsText(r.forLoans + r.pendingCollateral)} />
        </> : null}
      </Sheet>
    </Screen>
  )
}

const st = StyleSheet.create({
  asset: { minHeight: 56, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  assetLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  coin: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' },
  coinText: { fontFamily: F.semibold, fontSize: 14, color: C.white },
  actHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
})
