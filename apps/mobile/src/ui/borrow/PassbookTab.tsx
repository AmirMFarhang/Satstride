// Canvas 9 and 15: the Passbook tab. With no loan: what the earned limit lets the person
// borrow, the ladder, their bitcoin and pages. With a loan open: the page, how far it is
// along, the limit, what happens if bitcoin falls, and "Pay page N".
import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { debtOf } from '../../../../../src/core/terms.js'
import { headroom, liquidationDue } from '../../../../../src/registry/ladder.js'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import { useLoanRecord, usePassbookView } from '../../app/views'
import { Bar4, Button, Disclosure, Hero, IconButton, Ladder, P, Problem, Row, Rows, Screen, Sheet, TabBar, TabTop, Tag, TxValue, Working, Offline } from '../kit'
import { HeroBones, RowBones, Skeleton } from '../../motion/Skeleton'
import { PersonaLine } from './PersonaLine'
import { isConnectionError } from '../errors'
import { useNav, useTabSwitch } from '../nav'
import { C, F, R, t } from '../theme'
import { Icon } from '../icons'
import { btc, partyName, pctText, usd, usdNum } from '../format'

const BUSY_STAGES = new Set(['negotiating', 'check-node', 'consent', 'check-sealing', 'compex-approval', 'check-opening', 'check-result', 'applying', 'awaiting', 'no-terms', 'terms', 'collateral', 'locking', 'funding'])

export function PassbookTab() {
  const s = useApp()
  const nav = useNav()
  const onTab = useTabSwitch()
  const flow = useStore(s.borrow.store)
  const view = usePassbookView()
  const [sheet, setSheet] = useState<'limit' | null>(null)
  const open = s.borrow.openLoan()
  const v = view.data

  const top = <TabTop title="Your passbook" right={<IconButton name="gear" label="Settings" onPress={() => nav.push('settings')} side="right" />} />
  const tabs = <TabBar tab="passbook" onTab={onTab} />

  if (open && open.loan.disbursement_txid) return <OpenPage top={top} tabs={tabs} id={open.id} pageNo={(v?.pages.length ?? 0) || 1} onLimit={() => setSheet('limit')} sheet={sheet} onSheet={setSheet} />

  const step = v?.ladder.step ?? 0
  const allowed = v?.ladder.allowed_ltv_bps ?? 5000
  const onTime = v?.pages.filter((p) => p.outcome === 'on_time').length ?? 0
  const inFlight = BUSY_STAGES.has(flow.stage) || (open && !open.loan.disbursement_txid)
  return (
    <Screen top={top} bottom={<>
      {inFlight
        ? <Button label="Continue borrowing" onPress={() => nav.push('borrow')} />
        : <Button label="Borrow" disabled={!v || v.borrowable <= 0} onPress={() => nav.push('borrow-amount')} />}
      {tabs}
    </>}>
      <PersonaLine />
      {view.loading && !v ? <Skeleton label="Reading your passbook from Bitcoin"><HeroBones /><RowBones rows={2} /></Skeleton> : <>
        <Hero label="You can borrow up to" value={v ? `${usdNum(v.borrowable, 6).replace(/\.00$/, '')} test USDT` : '…'} sub={`${pctText(allowed)} of your bitcoin's value`} />
      </>}
      {v ? <Ladder steps={[...v.ladderBps]} at={step} /> : null}
      <Rows>
        <Row k="Your bitcoin" v={v ? btc(v.btcSats) : '…'} />
        <Row k="Pages" v={v?.pages.length ? `${v.pages.length} · ${onTime} on time` : 'none yet'} tone={v?.pages.length ? undefined : 'muted'} onPress={v?.pages.length ? () => nav.push('pages') : undefined} />
        {inFlight ? <Row k="Borrowing" v={flow.working ?? 'waiting for you'} tone="green" onPress={() => nav.push('borrow')} /> : null}
      </Rows>
      {v && v.btcSats === 0 ? <P muted>Add bitcoin in the Wallet tab to borrow against it.</P> : null}
      <Offline error={view.error} busy={view.loading} onRetry={() => void view.reload()} />
      <Problem>{view.error && !isConnectionError(view.error) ? `Can't read your passbook right now: ${view.error}` : null}</Problem>
    </Screen>
  )
}

function OpenPage({ top, tabs, id, pageNo, onLimit, sheet, onSheet }: { top: React.ReactNode; tabs: React.ReactNode; id: string; pageNo: number; onLimit: () => void; sheet: 'limit' | null; onSheet: (s: 'limit' | null) => void }) {
  const s = useApp()
  const nav = useNav()
  const flow = useStore(s.borrow.store)
  const view = usePassbookView()
  const record = useLoanRecord(id)
  const l = s.borrowerState.loans[id]
  const tm = l.terms
  const debt = debtOf(tm)
  const price = view.data?.priceCents ?? tm.oracle_quote.price_cents
  const height = view.data?.height ?? tm.open_height
  const room = headroom(debt, tm.collateral_sats, price)
  const call = record.data?.margin_call_height
  const due = liquidationDue(debt, tm.collateral_sats, price, call, height)
  const filled = l.release_txid ? 4 : l.repayment_txid ? 3 : l.disbursement_txid ? 2 : 1
  const paying = ['repaying', 'iou', 'releasing'].includes(flow.stage)
  const ladder = view.data
  return (
    <Screen top={top} gap={20} bottom={<>
      {paying
        ? <Button label="See the payment" onPress={() => nav.push('repayment')} />
        : <Button label={`Pay page ${pageNo}`} onPress={() => nav.push('pay')} />}
      {tabs}
    </>}>
      <PersonaLine />
      <View style={st.card}>
        <View style={st.cardHead}>
          <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>Page {pageNo}</Text>
          <Tag label={paying ? 'PAYING' : 'OPEN'} tone="amber" />
        </View>
        <View style={{ gap: 4 }}>
          <Text style={[t.big, { fontSize: 40 }]} adjustsFontSizeToFit numberOfLines={1}>{usdNum(debt)} test USDT</Text>
          <Text style={t.sub}>due by block {tm.maturity_height} · {partyName('Lender', l.lender_pk)}</Text>
        </View>
        <Bar4 filled={filled} label={`Step ${filled} of 4: ${['bitcoin locked', 'loan paid in', 'paid back', 'stamped'][filled - 1]}`} />
        <Disclosure label="Details" topLine={false}>
          <Done done label={`${btc(tm.collateral_sats)} locked`} tx={l.lock?.txid} />
          <Done done={!!l.disbursement_txid} label={`${usd(tm.principal)} received`} tx={l.disbursement_txid} />
          <Done done={!!l.repayment_txid} label="Paid" tx={l.repayment_txid} />
          <Done done={!!l.release_txid} label="Stamped" tx={l.release_txid} />
        </Disclosure>
        <Button kind="ghost" label="Check this loan" onPress={() => nav.push('check-loan', { id })} />
      </View>
      <Rows>
        <Row k="Limit" v={pctText(ladder?.ladder.allowed_ltv_bps ?? tm.ltv_bps)} onPress={onLimit} />
        <Row k="If bitcoin falls" onPress={() => nav.push('margin', { id })} v={
          <View style={st.safe}>
            <View style={[st.dot, { backgroundColor: call !== undefined ? C.warn : C.green }]} />
            <Text style={[t.bodyMedium, { color: call !== undefined ? C.warn : C.green }]}>{call !== undefined ? (due.ok ? 'Sale due' : 'Margin call') : room.ltv_bps >= 7000 ? 'Close to a call' : 'Safe'}</Text>
          </View>
        } />
      </Rows>
      <Working label={paying ? flow.working : null} />
      <Problem>{flow.error}</Problem>
      <Sheet visible={sheet === 'limit'} onClose={() => onSheet(null)} title="Your limit">
        {ladder ? <Ladder steps={[...ladder.ladderBps]} at={ladder.ladder.step} /> : null}
        <P>Each page paid on time moves you one step up.</P>
      </Sheet>
    </Screen>
  )
}

function Done({ done, label, tx }: { done: boolean; label: string; tx?: string }) {
  return (
    <View style={st.done}>
      {done ? <Icon name="check" size={16} color={C.green} /> : <View style={st.ring} />}
      <Text style={[t.body, { fontSize: 14, flex: 1 }, done ? null : { color: C.muted }]}>{label}</Text>
      {tx ? <TxValue id={tx} /> : null}
    </View>
  )
}

const st = StyleSheet.create({
  card: { borderRadius: R.card, backgroundColor: C.surface, padding: 20, gap: 14 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  safe: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  done: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ring: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: C.track },
})
