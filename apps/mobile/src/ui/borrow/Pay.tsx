// Canvas 17 (stop 3: pay) and 18 (repayment in progress, Plain / Check / Raw). The release
// that brings the bitcoin back needs no fourth stop: it pays only the person's own address.
import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { debtOf } from '../../../../../src/core/terms.js'
import { LADDER_BPS } from '../../../../../src/registry/ladder.js'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import { usePassbookView, useVersion } from '../../app/views'
import { Button, Disclosure, FlowTop, Hero, KV, Note, P, Problem, Screen, Segmented, Sheet, StopCount, Steps, Undo, Working, type StepState } from '../kit'
import { useNav } from '../nav'
import { Icon, Ring } from '../icons'
import { C, F, t } from '../theme'
import { btc, partyName, pctText, short, usd, usdNum } from '../format'

export function Pay() {
  const s = useApp()
  const nav = useNav()
  const f = useStore(s.borrow.store)
  const view = usePassbookView()
  const [next, setNext] = useState(false)
  const open = s.borrow.openLoan()
  useEffect(() => { if (['repaying', 'iou', 'releasing', 'closed'].includes(f.stage)) nav.replace('repayment') }, [f.stage])
  if (!open) return <Screen top={<FlowTop title="Pay" onBack={nav.pop} />}><P muted>No open loan on this phone.</P></Screen>
  const l = open.loan
  const tm = l.terms
  const lender = partyName('Lender', l.lender_pk)
  const pageNo = (view.data?.pages.length ?? 0) || 1
  const step = view.data?.ladder.step ?? tm.ladder_step
  const nextLimit = LADDER_BPS[Math.min(step + 1, LADDER_BPS.length - 1)]
  return (
    <Screen top={<FlowTop title={`Pay page ${pageNo}`} onBack={nav.pop} right={<StopCount n={3} />} />} bottom={<>
      <Button label={`Pay ${usdNum(debtOf(tm))} test USDT`} busy={!!f.working} onPress={() => void s.borrow.pay()} />
      <Undo />
    </>}>
      <Hero value={`${usdNum(debtOf(tm))} test USDT`} sub={`to ${lender}`} />
      <Note icon="refund" title={`${btc(tm.collateral_sats)} comes back to you`} />
      <Button kind="ghost" label="What happens next?" onPress={() => setNext(true)} />
      <Disclosure label="Network fee" value="from your reserve">
        <KV k="Paid from" v="your reserve (the RGB wallet's bitcoin)" />
        <KV k="Bitcoin that carries it" v="1,000 sats, to the lender with the USDT" />
        <KV k="Before paying" v="the wallet tops up its reserve if it is low" />
      </Disclosure>
      <Working label={f.working} />
      <Problem>{f.error}</Problem>
      <Sheet visible={next} onClose={() => setNext(false)} title="What happens next">
        <Numbered n={1} text={`Your ${usdNum(debtOf(tm))} test USDT goes to ${lender}.`} />
        <Numbered n={2} text={`${lender} signs and your bitcoin comes back.`} />
        <Numbered n={3} text={`Page ${pageNo} is stamped and your limit rises to ${pctText(nextLimit)}.`} />
        <P small>If {lender} doesn't sign, the platform does once your payment is proven.</P>
      </Sheet>
    </Screen>
  )
}

export function Repayment() {
  const s = useApp()
  const nav = useNav()
  const f = useStore(s.borrow.store)
  useVersion()
  const [depth, setDepth] = useState<'plain' | 'check' | 'raw'>(s.prefs.get().chainDetails ? 'raw' : 'plain')
  const [status, setStatus] = useState<string | null>(null)
  const id = f.loanId ?? s.borrow.openLoan()?.id
  const l = id ? s.borrowerState.loans[id] : undefined
  useEffect(() => {
    if (!l?.repayment_txid) return
    let live = true
    const read = async () => {
      const rows = await s.rgb.transfers(l.terms.asset_id).catch(() => [])
      const row = rows.find((r) => r.txid === l.repayment_txid && r.kind === 'Send')
      if (live) setStatus(row ? `Send · ${row.status}` : null)
    }
    void read()
    const timer = setInterval(read, 8000)
    return () => { live = false; clearInterval(timer) }
  }, [l?.repayment_txid])
  if (!l || !id) return <Screen top={<FlowTop title="Repayment" onBack={nav.root} />}><P muted>No payment in progress.</P></Screen>
  const tm = l.terms
  const lender = partyName('Lender', l.lender_pk)
  const closed = !!l.release_txid
  const st = (done: boolean, now: boolean): StepState => (done ? 'done' : now ? 'now' : 'next')
  const stuck = !f.working && !!f.error && !closed
  return (
    <Screen top={<FlowTop title="Repayment" onBack={nav.root} />} bottom={
      closed ? <Button label="See the stamped page" onPress={() => nav.replace('page', { id, stamped: true })} />
        : stuck ? <>
          <Button label="Try again" onPress={() => s.borrow.retryRelease()} />
          <Button kind="secondary" label="Ask the platform to release" onPress={() => s.borrow.releaseWithPlatform()} />
        </> : <Undo text="Opens the stamped page when it's done" />
    }>
      <View style={st2.head}>
        {closed ? <View style={st2.doneDot}><Icon name="check" size={22} color={C.white} strokeWidth={3} /></View> : <Ring />}
        <Text style={[t.mid, { fontSize: 28 }]}>{closed ? 'Paid' : l.repayment_txid ? 'Sent' : 'Sending'}</Text>
        <Text style={t.sub}>{usd(debtOf(tm))} to {lender}</Text>
      </View>
      <Segmented label="Depth" value={depth} onChange={setDepth} options={[{ id: 'plain', label: 'Plain' }, { id: 'check', label: 'Check' }, { id: 'raw', label: 'Raw' }]} />
      {depth === 'plain' ? (
        <View style={{ gap: 14 }}>
          <Line icon="clock" text={closed ? 'Done' : l.repayment_txid ? 'On its way · one block' : 'Being signed on this phone'} />
          <Line icon="close" text="Nothing to do. Don't send again." />
          <Line icon="arrow" text={closed ? 'Your bitcoin is back' : 'Next: your bitcoin comes back'} />
        </View>
      ) : depth === 'check' ? (
        <Steps items={[
          { label: 'Sent', state: st(!!l.repayment_txid, !l.repayment_txid), note: l.repayment_txid ? short(l.repayment_txid) : undefined },
          { label: `${lender}'s wallet picks it up`, state: st(!!l.repayment_receipt || closed, !!l.repayment_txid) },
          ...(l.iou ? [{ label: 'Your IOU comes back', state: st(closed || f.stage === 'releasing', f.stage === 'iou') }] : []),
          { label: 'Bitcoin released', state: st(closed, f.stage === 'releasing') },
        ]} />
      ) : (
        <View style={st2.raw}>
          <RawLine k="status" v={status ?? (l.repayment_txid ? 'sent' : 'not sent')} />
          <RawLine k="txid" v={l.repayment_txid ?? '—'} />
          <RawLine k="asset" v={tm.asset_id} />
          <RawLine k="amount" v={String(debtOf(tm))} />
          <RawLine k="loan" v={id} />
          <RawLine k="receipt" v={l.repayment_receipt ? `${l.repayment_receipt.validation} by ${l.repayment_receipt.validator_pk.slice(0, 12)}` : '—'} />
          <RawLine k="release" v={l.release_txid ?? '—'} />
        </View>
      )}
      <Working label={f.working} />
      <Problem>{f.error}</Problem>
    </Screen>
  )
}

function Numbered({ n, text }: { n: number; text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <Text style={st2.num}>{n}</Text>
      <Text style={[t.body, { flex: 1 }]}>{text}</Text>
    </View>
  )
}
function Line({ icon, text }: { icon: 'clock' | 'close' | 'arrow'; text: string }) {
  return <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}><Icon name={icon} size={20} color={C.muted} /><Text style={t.body}>{text}</Text></View>
}
function RawLine({ k, v }: { k: string; v: string }) {
  return <Text style={t.mono} selectable><Text style={{ color: C.muted }}>{k}</Text> {v}</Text>
}

const st2 = StyleSheet.create({
  head: { alignItems: 'center', gap: 8, paddingTop: 8 },
  doneDot: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' },
  raw: { gap: 8, backgroundColor: C.surface, borderRadius: 14, padding: 14 },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.surface, textAlign: 'center', lineHeight: 24, fontFamily: F.semibold, fontSize: 13, color: C.ink, overflow: 'hidden' },
})
