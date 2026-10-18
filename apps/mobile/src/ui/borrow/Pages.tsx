// Canvas 19 (page stamped) and 16 (margin call), plus the list of pages. Every page is read
// from the passbook this phone keeps, verified against Bitcoin (verifyPassbook in src/).
import { activeNetwork } from '../../core/network'
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { debtOf } from '../../../../../src/core/terms.js'
import { priceAtLtv } from '../../../../../src/core/money.js'
import { CURE_BLOCKS, LIQUIDATION_BPS, MARGIN_CALL_BPS, headroom } from '../../../../../src/registry/ladder.js'
import { useApp } from '../../app/session'
import { useLoanRecord, usePassbookView, type PassbookPage } from '../../app/views'
import { Button, Disclosure, FlowTop, Hero, IconButton, KV, Note, P, Problem, Row, Rows, Screen, Sheet, Stamp, Tag, TxValue, Undo, Working } from '../kit'
import { PageStamped } from '../../motion/PageStamped'
import type { StampOutcome } from '../../motion/stamp-model'
import { RowBones, Skeleton } from '../../motion/Skeleton'
import { useNav } from '../nav'
import { Icon } from '../icons'
import { C, F, R, t } from '../theme'
import { btc, partyName, pctText, usd, usdNum } from '../format'

const OUTCOME: Record<string, { stamp: string; tag: string; tone: 'green' | 'amber' | 'muted' }> = {
  on_time: { stamp: 'PAID ON TIME', tag: 'PAID', tone: 'green' },
  late: { stamp: 'PAID LATE', tag: 'LATE', tone: 'amber' },
  defaulted: { stamp: 'DEFAULTED', tag: 'DEFAULT', tone: 'amber' },
  liquidated: { stamp: 'SOLD', tag: 'SOLD', tone: 'amber' },
  refunded: { stamp: 'REFUNDED', tag: 'REFUND', tone: 'muted' },
  open: { stamp: 'OPEN', tag: 'OPEN', tone: 'amber' },
}

export function PagesList() {
  const nav = useNav()
  const view = usePassbookView()
  const pages = view.data?.pages ?? []
  return (
    <Screen top={<FlowTop title="Pages" onBack={nav.pop} />}>
      <Rows>
        {pages.map((p, i) => (
          <Pressable key={p.loan_id} accessibilityRole="button" onPress={() => nav.push('page', { id: p.loan_id })} style={st.pageRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 16 }]}>Page {i + 1} · {usd(p.principal)}</Text>
              <Text style={t.small}>blocks {p.open_height}–{p.maturity_height} · step {p.ladder_step}</Text>
            </View>
            <Tag label={OUTCOME[p.outcome]?.tag ?? p.outcome.toUpperCase()} tone={OUTCOME[p.outcome]?.tone ?? 'muted'} />
          </Pressable>
        ))}
      </Rows>
      {view.loading && !view.data ? <Skeleton label="Reading your passbook from Bitcoin"><RowBones rows={3} /></Skeleton> : !pages.length ? <P muted>No pages yet.</P> : null}
      <Problem>{view.error}</Problem>
    </Screen>
  )
}

export function PageScreen({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const view = usePassbookView()
  const id = String(params.id)
  const pages = view.data?.pages ?? []
  const idx = pages.findIndex((p) => p.loan_id === id)
  const page: PassbookPage | undefined = pages[idx]
  const local = s.borrowerState.loans[id]
  const lenderPk = local?.lender_pk ?? local?.terms.lender_pk
  const o = OUTCOME[page?.outcome ?? 'open'] ?? OUTCOME.open
  const ladder = view.data?.ladder
  return (
    <Screen top={<FlowTop title={idx >= 0 ? `Page ${idx + 1}` : 'Page'} onBack={nav.pop} />} bottom={
      <Button label="Borrow again" onPress={() => nav.go('passbook', 'borrow-amount')} />
    }>
      {/* the moment the release stamps the page: only with a real closing txid (D1's PageStamped) */}
      {params.stamped && page?.close_txid && page.outcome !== 'open' && ladder && view.data ? (
        <PageStamped compact pageNo={idx + 1} closeTxid={page.close_txid} ladderStep={ladder.step} ladderSteps={view.data.ladderBps.length} limitBps={ladder.allowed_ltv_bps}
          outcome={page.outcome as StampOutcome} amount={usd(page.principal)} counterparty={lenderPk ? `from ${partyName('Lender', lenderPk)}` : undefined} blocks={`blocks ${page.open_height}–${page.maturity_height}`} />
      ) : (
        <View style={st.stampCard}>
          <Stamp text={o.stamp} />
          <Text style={[t.mid, { paddingTop: 8 }]}>{page ? usd(page.principal) : local ? usd(local.terms.principal) : '…'}</Text>
          {lenderPk ? <Text style={t.sub}>from {partyName('Lender', lenderPk)}</Text> : null}
        </View>
      )}
      {ladder && page?.outcome === 'on_time' ? <Note icon="up" title={`Limit now ${pctText(ladder.allowed_ltv_bps)}`} sub={view.data ? `up to ${usdNum(view.data.borrowable).replace(/\.00$/, '')} test USDT` : undefined} /> : null}
      <Disclosure label="Details and receipts">
        {page ? <KV k="Opened" v={`block ${page.open_height}`} /> : null}
        {page ? <KV k="Paid" v={`${usd(page.principal + page.fee)}`} /> : null}
        {page?.returned_sats !== undefined ? <KV k="Bitcoin returned" v={btc(page.returned_sats)} /> : null}
        {local?.repayment_txid ? <KV k="Payment receipt" v={<TxValue id={local.repayment_txid} />} /> : null}
        {page?.close_txid ? <KV k="Release receipt" v={<TxValue id={page.close_txid} />} /> : null}
        {page ? <KV k="Checked on Bitcoin" v={Object.values(page.verified).every(Boolean) ? 'all six checks' : Object.entries(page.verified).filter(([, ok]) => !ok).map(([k]) => k).join(', ') + ' not yet'} /> : null}
      </Disclosure>
      {local ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button kind="secondary" label="Receipt" onPress={() => nav.push('receipt', { id })} style={{ flex: 1 }} />
          <Button kind="secondary" label="Check this loan" onPress={() => nav.push('check-loan', { id })} style={{ flex: 1 }} />
        </View>
      ) : null}
      <Working label={view.loading && !view.data ? 'Reading the page from Bitcoin' : null} />
      <Problem>{view.error}</Problem>
    </Screen>
  )
}

export function MarginCall({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const id = String(params.id)
  const view = usePassbookView()
  const record = useLoanRecord(id)
  const [info, setInfo] = useState(false)
  const l = s.borrowerState.loans[id]
  if (!l) return <Screen top={<FlowTop title="Page" onBack={nav.pop} />}><P muted>This loan is not on this phone.</P></Screen>
  const tm = l.terms
  const debt = debtOf(tm)
  const price = view.data?.priceCents ?? tm.oracle_quote.price_cents
  const height = view.data?.height ?? tm.open_height
  const call = record.data?.margin_call_height
  const room = headroom(debt, tm.collateral_sats, price)
  const callPrice = priceAtLtv(debt, tm.collateral_sats, MARGIN_CALL_BPS)
  const salePrice = priceAtLtv(debt, tm.collateral_sats, LIQUIDATION_BPS)
  const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
  const pageNo = (view.data?.pages.length ?? 0) || 1
  return (
    <Screen top={<FlowTop title={`Page ${pageNo}`} onBack={nav.pop} right={<IconButton name="info" label="What a margin call means" onPress={() => setInfo(true)} side="right" />} />} bottom={call !== undefined ? <>
      <Button label={`Pay ${usdNum(debt)} test USDT now`} onPress={() => nav.replace('pay')} />
      <Undo />
    </> : undefined}>
      {call !== undefined ? (
        <View style={st.warnBox} accessibilityRole="alert">
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Icon name="alert" size={22} color={C.warn} />
            <Text style={[t.bodyMedium, { fontFamily: F.semibold, color: C.warn, fontSize: 16 }]}>Margin call</Text>
          </View>
          <Text style={[t.big, { color: C.warn }]}>{Math.max(0, call + CURE_BLOCKS - height)} blocks left</Text>
          <Text style={[t.body, { color: C.warn }]}>Pay early by block {call + CURE_BLOCKS} to keep your bitcoin.</Text>
        </View>
      ) : (
        <Hero label="Your loan is" value={`${pctText(room.ltv_bps)}`} sub="of your locked bitcoin's value" />
      )}
      <Rows>
        <Row k="You owe" v={usd(debt)} />
        <Row k="Bitcoin now" v={`${dollars(price)} (${activeNetwork().name} oracle)`} />
        {call === undefined ? <Row k="Margin call at" v={dollars(callPrice)} /> : null}
        <Row k="Sale starts at" v={dollars(salePrice)} />
      </Rows>
      {call === undefined ? <P muted>Nothing to do. If bitcoin falls to {dollars(callPrice)}, you have {CURE_BLOCKS} blocks to pay early.</P> : null}
      <Problem>{record.error}</Problem>
      <Sheet visible={info} onClose={() => setInfo(false)} title="What a margin call means">
        <P>Bitcoin fell far enough that your locked bitcoin barely covers what you owe.</P>
        <P>If you don't pay within {CURE_BLOCKS} blocks, enough bitcoin goes to the lender to cover {usdNum(debt)} test USDT, at the oracle's price. The rest comes back to you.</P>
      </Sheet>
    </Screen>
  )
}

const st = StyleSheet.create({
  pageRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 },
  stampCard: { borderRadius: 18, backgroundColor: C.surface, paddingVertical: 28, paddingHorizontal: 20, alignItems: 'center', gap: 10 },
  warnBox: { borderRadius: R.card, backgroundColor: C.warnBg, padding: 20, gap: 8 },
})
