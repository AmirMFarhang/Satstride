// The phone's screens: the dashboard phone's screens (web/app.js), same words,
// fed by the node's state. The thin client computes no terms: amounts, term
// sheet lines and cost lines are the node's, with only the test asset renamed.

import { useState, type ReactNode } from 'react'
import { Pressable, Switch, Text, View } from 'react-native'
import type { Snapshot } from '../core/client.js'
import { btc, centsOf, dollars, pctOf, satsText, short, usdNum, usdt } from '../core/format.js'
import { allowedBps, borrowable, heightOf, ladderBps, ladderStep, lenderName, lenderOf, loanStatuses, openPage, pageNo, pagesOf, priceOf, waitingOf, type Page, type Waiting } from '../core/model.js'
import { labelAsset, type Network } from '../core/network.js'
import { PHONE_ONLY, SHARED, T } from '../core/strings.js'
import { Amount, Banner, Btn, Card, Hero, KV, Ladder, P, Row, Section, Steps, StopN, Tag, Toggle, Top, Undo, useColors } from './kit'

export interface ScreenProps {
  snap: Snapshot | null
  net: Network
  borrowerPk: string
  busy: boolean
  /** Locks the phone, then posts the answer; resolves when the node answered. */
  act: (what: 'share' | 'accept' | 'decline' | 'repay', arg?: unknown) => void
  openPage: (loanId: string | null) => void
  openTermSheet: (open: boolean) => void
  /** stop 1: inflows the borrower unticked (not shared) */
  unticked: ReadonlySet<string>
  toggleTick: (txid: string) => void
}

/** A screen: its body, the one button kept in reach, and whether the tabs show. */
export interface Screen { body: ReactNode; cta?: ReactNode; tabs: boolean }

const lenderLine = (snap: Snapshot | null, pk: unknown) => lenderName(snap, pk).replaceAll(' ', ' ')

// ---- passbook (home) ----

function PageCard({ p, snap, net, open, onToggle }: { p: Page; snap: Snapshot | null; net: Network; open: boolean; onToggle: () => void }) {
  const lender = lenderLine(snap, lenderOf(snap, p))
  const funded = p.status === 'open' || p.status === 'repaid'
  const left = p.maturity_height - heightOf(snap)
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <P>{T.page(pageNo(snap, p))}</P>
        <Tag text={SHARED.open} tone="open" />
      </View>
      <Amount text={usdt(p.principal + p.fee, net)} />
      <P small muted>{funded ? T.dueBlock(p.maturity_height, left, lender) : T.waitingPayIn(lender)}</P>
      <Toggle label={SHARED.details} open={open} onPress={onToggle} />
      {open ? <Steps items={[[`${btc(p.collateral_sats)} locked`, p.verified.lock], [`${usdt(p.principal, net)} received`, funded], ['Paid', p.status === 'repaid'], ['Stamped', p.verified.close]]} /> : null}
      {open ? <KV k={SHARED.lockReceipt} v={short(p.lock_txid, 16)} mono /> : null}
    </Card>
  )
}

function HeadroomChip({ state }: { state: string }) {
  const c = useColors()
  const text = state === 'healthy' ? SHARED.safe : state === 'margin_call' ? SHARED.marginCall : SHARED.atRisk
  return <Text style={{ color: state === 'healthy' ? c.ok : c.bad, fontWeight: '600' }}>●{text}</Text>
}

function LoanStatus({ snap, borrowerPk }: { snap: Snapshot | null; borrowerPk: string }) {
  const loans = loanStatuses(snap, borrowerPk)
  if (!loans.length) return null
  return (
    <>
      <Section title={PHONE_ONLY.loanStatus} />
      {loans.map((l) => <KV key={l.id} k={`Loan ${short(l.id, 8)}`} v={l.status} />)}
    </>
  )
}

function HomeBody(p: ScreenProps) {
  const [open, setOpen] = useState(false)
  const { snap, net } = p
  const page = openPage(snap)
  const settled = Number(snap?.wallet?.usdt_settled ?? 0)
  if (page) {
    return (
      <>
        <Top title={SHARED.yourPassbook} />
        {page.cure_until_height !== undefined ? <Banner tone="bad">{SHARED.marginCallBanner}{T.cureEnds(page.cure_until_height)}</Banner> : null}
        <PageCard p={page} snap={snap} net={net} open={open} onToggle={() => setOpen(!open)} />
        <Row k={SHARED.limit} v={pctOf(allowedBps(snap))} />
        {page.headroom ? <Row k={SHARED.ifBitcoinFalls} v={<HeadroomChip state={page.headroom.state} />} /> : null}
        {page.headroom ? <KV k="Margin call" v={dollars(page.headroom.margin_call_price_cents)} /> : null}
        <Row k={SHARED.dollars} v={usdt(settled, net)} />
        <LoanStatus snap={snap} borrowerPk={p.borrowerPk} />
      </>
    )
  }
  const closed = pagesOf(snap).filter((x) => x.outcome !== 'open')
  return (
    <>
      <Top title={SHARED.yourPassbook} />
      <Hero label={SHARED.canBorrow} big={snap?.wallet ? `${borrowable(snap).toLocaleString('en-US')} ${net.asset}` : pctOf(allowedBps(snap))} sub={T.borrowShare(pctOf(allowedBps(snap)))} />
      <Ladder steps={ladderBps(snap)} at={ladderStep(snap)} />
      {closed.length ? (
        <>
          <Section title={SHARED.pages} />
          {closed.map((x) => (
            <Pressable key={x.loan_id} accessibilityRole="button" onPress={() => p.openPage(x.loan_id)}>
              <Card>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flexShrink: 1 }}>
                    <P>{`${T.page(pageNo(snap, x))} · ${usdt(x.principal, net)}`}</P>
                    <P small muted>{lenderLine(snap, lenderOf(snap, x))}</P>
                  </View>
                  <Tag text={x.outcome === 'on_time' ? SHARED.onTime : x.outcome.replace('_', ' ').toUpperCase()} tone={x.outcome === 'on_time' ? 'done' : 'bad'} />
                </View>
              </Card>
            </Pressable>
          ))}
        </>
      ) : (
        <Row k={SHARED.dollars} v={usdt(settled, net)} />
      )}
      <LoanStatus snap={snap} borrowerPk={p.borrowerPk} />
    </>
  )
}

export const home = (p: ScreenProps): Screen => ({ body: <HomeBody {...p} />, cta: <P small muted>{PHONE_ONLY.nothingToDo}</P>, tabs: true })

// ---- wallet ----

const STATUS: Record<string, string> = { Settled: SHARED.statusDone, WaitingConfirmations: SHARED.statusConfirming, WaitingCounterparty: SHARED.statusWaiting, Failed: SHARED.statusAttention }

export function wallet({ snap, net }: ScreenProps): Screen {
  const w = (snap?.wallet ?? {}) as { btc_free_sats?: number; fee_btc_sats?: number; reserve_sats?: number; usdt_settled?: number; usdt_future?: number; error?: string; transfers?: { kind: string; status: string; amount: number; txid?: string }[] }
  const page = openPage(snap)
  const spendable = (w.btc_free_sats ?? 0) + (w.fee_btc_sats ?? 0)
  const transfers = w.transfers ?? []
  return {
    tabs: true,
    body: (
      <>
        <Top title={SHARED.wallet} />
        <Hero big={btc(spendable)} sub={dollars(centsOf(spendable, priceOf(snap)))}>
          <P small muted>{T.reserved(satsText(w.reserve_sats ?? 0))}</P>
        </Hero>
        {page ? <Row k={SHARED.inTheSafe} v={btc(page.collateral_sats)} /> : null}
        <Section title={SHARED.assets} />
        <Row k={`$ ${net.asset}`} v={`${usdNum(w.usdt_settled ?? 0)}${(w.usdt_future ?? 0) > (w.usdt_settled ?? 0) ? `  ${T.arriving(usdNum((w.usdt_future ?? 0) - (w.usdt_settled ?? 0)))}` : ''}`} />
        <Section title={SHARED.activity} />
        {transfers.map((t, i) => (
          <Row key={`${t.txid ?? i}`} k={`${t.kind === 'Send' ? T.sent(net.asset) : T.received(net.asset)} · ${STATUS[t.status] ?? t.status}`} v={`${t.kind === 'Send' ? '−' : '+'}${usdNum(t.amount)}`} />
        ))}
        {transfers.length ? null : <P muted>{w.error ? SHARED.walletNotRead : SHARED.noPayments}</P>}
      </>
    ),
  }
}

// ---- offers (phone only: the order book the lenders published) ----

export function offers({ snap, net }: ScreenProps): Screen {
  const list = (snap?.offers ?? []) as { id: string; lender_pk: string; payload: { apr_bps: number; max: number; term_blocks: number; ltv_ladder_bps: number[] } }[]
  return {
    tabs: true,
    body: (
      <>
        <Top title={PHONE_ONLY.offers} />
        {list.map((o) => (
          <Card key={o.id}>
            <P>{lenderLine(snap, o.lender_pk)}</P>
            <P small muted>{T.offer(`${(o.payload.apr_bps / 100).toFixed(2)}%`, usdt(o.payload.max, net), o.payload.term_blocks)}</P>
            <P small muted>{T.offerLtv(o.payload.ltv_ladder_bps.map((b) => `${b / 100}%`).join(' / '))}</P>
          </Card>
        ))}
        {list.length ? null : <P muted>{PHONE_ONLY.noOffers}</P>}
      </>
    ),
  }
}

// ---- stop 1: share and apply ----

function Stop1Body({ snap, net, unticked, toggleTick }: ScreenProps) {
  const [seeOpen, setSeeOpen] = useState(false)
  const w = waitingOf(snap)!
  const items = (w.items as { txid: string; amount: number; height: number }[] | undefined) ?? []
  const lender = lenderLine(snap, w.lender_pk)
  return (
    <>
      <Top title={SHARED.apply} right={<StopN text={SHARED.stop1of3} />} />
      <P>{items.length ? T.share(items.length, lender) : T.noIncomeProof(lender)}</P>
      {items.map((i) => (
        <View key={i.txid} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 }}>
          <Switch accessibilityLabel={`Share ${usdt(i.amount, net)}`} value={!unticked.has(i.txid)} onValueChange={() => toggleTick(i.txid)} />
          <P>{usdt(i.amount, net)}</P>
          <P small muted>{`block ${i.height}`}</P>
        </View>
      ))}
      {items.length ? null : <P muted>{SHARED.readPassbookInstead}</P>}
      <Btn kind="link" label={T.whatSee(lender)} onPress={() => setSeeOpen(!seeOpen)} />
      {seeOpen ? <><P small>✓ The payments you tick</P><P small>✓ A signed pass or fail from the private check</P><P small>✗ Not your balance or your history</P></> : null}
    </>
  )
}

export function stop1(p: ScreenProps): Screen {
  const items = ((waitingOf(p.snap)?.items as { txid: string }[] | undefined) ?? [])
  const share = () => p.act('share', items.filter((i) => !p.unticked.has(i.txid)).map((i) => i.txid))
  return { body: <Stop1Body {...p} />, cta: <Btn testID="share" label={items.length ? SHARED.shareAndApply : SHARED.apply} onPress={share} disabled={p.busy} />, tabs: false }
}

// ---- stop 2: approve this exact term sheet ----

interface Render { title: string; lines: string[]; if_price_falls: string[]; if_not_repaid: string[]; settlement: string; scorer: string; final: string }
type AcceptInfo = Waiting & { principal: number; fee: number; collateral_sats: number; maturity_height: number; grace_blocks: number; refund_blocks: number; cost_lines?: string[]; termsheet?: { hash: string; render: Render }; explanation?: string; lender_sats_on_default?: number; borrower_sats_on_default?: number; atomic_repayment?: { expires_at: number } }

/** An ln-rln loan commits to a Lightning invoice: its extra payment and expiry are terms, shown before approving. */
function AtomicTerms({ w }: { w: AcceptInfo }) {
  if (!w.atomic_repayment) return null
  return (
    <View testID="atomic-terms">
      <KV k={SHARED.lightningPayment} v={SHARED.satsExtra} />
      <KV k={SHARED.invoiceExpires} v={new Date(w.atomic_repayment.expires_at * 1000).toLocaleString()} />
    </View>
  )
}

function ApproveButtons({ w, busy, act }: { w: AcceptInfo; busy: boolean; act: ScreenProps['act'] }) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn testID="approve" label={w.termsheet ? SHARED.approveAndLock : SHARED.lockAndAccept} onPress={() => act('accept', w.loan_id)} disabled={busy} />
        <Btn testID="decline" kind="second" label={SHARED.decline} onPress={() => act('decline', w.loan_id)} disabled={busy} />
      </View>
      <Undo />
    </View>
  )
}

function Stop2Body(p: ScreenProps) {
  const [agree, setAgree] = useState(false)
  const w = waitingOf(p.snap) as AcceptInfo
  const { snap, net } = p
  const lender = lenderLine(snap, w.lender_pk)
  const debt = w.principal + w.fee
  return (
    <>
      <Top title={SHARED.accept} right={<StopN text={SHARED.stop2of3} />} />
      <Hero label={SHARED.youLock} big={btc(w.collateral_sats)} sub={T.getRepay(usdt(w.principal, net), usdNum(debt), !!w.atomic_repayment, w.maturity_height)} />
      {(w.cost_lines ?? []).map((line) => <P key={line} small>{labelAsset(line, net)}</P>)}
      <AtomicTerms w={w} />
      {w.termsheet ? (
        <>
          <P small>{labelAsset(w.termsheet.render.scorer, net)}</P>
          <P small>{labelAsset(w.termsheet.render.settlement, net)}</P>
          <P small>{T.termSheetFinal(short(w.termsheet.hash, 12), w.termsheet.render.final)}</P>
          <Btn testID="read-termsheet" kind="link" label={PHONE_ONLY.readTermSheet} onPress={() => p.openTermSheet(true)} />
        </>
      ) : null}
      <Toggle label={SHARED.whatAgreeing} open={agree} onPress={() => setAgree(!agree)} />
      {agree ? (
        <View>
          {w.explanation ? <P>{w.explanation}</P> : null}
          <P small muted>{PHONE_ONLY.wordedOnNode}</P>
          <KV k={T.neverPays(lender)} v={T.refundAfter(w.refund_blocks)} />
          <KV k={T.unpaidAt(w.maturity_height + w.grace_blocks)} v={T.lenderGets(lender, btc(w.lender_sats_on_default ?? 0))} />
          <KV k={SHARED.youGetBack} v={btc(w.borrower_sats_on_default ?? 0)} />
        </View>
      ) : null}
    </>
  )
}

export function stop2(p: ScreenProps): Screen {
  return { body: <Stop2Body {...p} />, cta: <ApproveButtons w={waitingOf(p.snap) as AcceptInfo} busy={p.busy} act={p.act} />, tabs: false }
}

/** The whole term sheet the borrower approves, as the node rendered it for the borrower. */
export function termsheet(p: ScreenProps): Screen {
  const w = waitingOf(p.snap) as AcceptInfo
  const r = w.termsheet?.render
  const L = (x: string) => labelAsset(x, p.net)
  return {
    tabs: false,
    body: (
      <>
        <Top title={PHONE_ONLY.termSheet} onBack={() => p.openTermSheet(false)} />
        {r ? (
          <>
            <P>{L(r.title)}</P>
            {r.lines.map((x) => <P key={x} small>{L(x)}</P>)}
            <P small>{L(r.settlement)}</P>
            <AtomicTerms w={w} />
            <P small>{L(r.scorer)}</P>
            <Section title={PHONE_ONLY.ifPriceFalls} />
            {r.if_price_falls.map((x) => <P key={x} small>{L(x)}</P>)}
            <Section title={PHONE_ONLY.ifNotRepaid} />
            {r.if_not_repaid.map((x) => <P key={x} small>{L(x)}</P>)}
            <KV k={SHARED.termSheetHashLine.replace(/: $/, '')} v={w.termsheet!.hash} mono />
            <P>{r.final}</P>
          </>
        ) : null}
      </>
    ),
    cta: <ApproveButtons w={w} busy={p.busy} act={p.act} />,
  }
}

// ---- stop 3: pay ----

function Stop3Body(p: ScreenProps) {
  const [fee, setFee] = useState(false)
  const w = waitingOf(p.snap) as Waiting & { debt: number; collateral_sats: number; atomic_repayment?: unknown }
  const { snap, net } = p
  const lender = lenderLine(snap, w.lender_pk)
  const page = pagesOf(snap).find((x) => x.loan_id === w.loan_id)
  const ready = Number(snap?.wallet?.reserve_sats ?? 0) > 0
  return (
    <>
      <Top title={T.payPage(page ? pageNo(snap, page) : '')} />
      <Hero big={usdt(w.debt, net)} sub={T.to(lender, !!w.atomic_repayment)} />
      <P>{T.comesBack(btc(w.collateral_sats))}</P>
      <Toggle label={SHARED.networkFee} value={SHARED.fromReserve} open={fee} onPress={() => setFee(!fee)} />
      {fee ? (
        <>
          <Steps items={[[w.atomic_repayment ? 'Funded RGB Lightning channel ready' : ready ? SHARED.walletReady : SHARED.walletNeedsSlot, !!w.atomic_repayment || ready], [T.amountFromTerms(usdt(w.debt, net)), true]]} />
          <P small muted>{SHARED.oneConfirmation}</P>
        </>
      ) : null}
    </>
  )
}

export function stop3(p: ScreenProps): Screen {
  const w = waitingOf(p.snap) as Waiting & { debt: number; atomic_repayment?: unknown }
  return {
    tabs: false,
    body: <Stop3Body {...p} />,
    cta: (
      <View style={{ gap: 6 }}>
        <Btn testID="pay" label={T.pay(usdt(w.debt, p.net), !!w.atomic_repayment)} onPress={() => p.act('repay', w.loan_id)} disabled={p.busy} />
        <Undo />
      </View>
    ),
  }
}

// ---- a passbook page ----

export function page(p: ScreenProps & { loanId: string }): Screen {
  const { snap, net } = p
  const x = pagesOf(snap).find((q) => q.loan_id === p.loanId)
  if (!x) return home(p)
  const onTime = x.outcome === 'on_time'
  const repaid = onTime || x.outcome === 'late'
  return {
    tabs: false,
    body: (
      <>
        <Top title={T.page(pageNo(snap, x))} onBack={() => p.openPage(null)} />
        <Card>
          <Tag text={onTime ? SHARED.paidOnTime : x.outcome.replace('_', ' ').toUpperCase()} tone={onTime ? 'done' : 'bad'} />
          <Amount text={usdt(x.principal, net)} />
          <P small muted>{T.from(lenderLine(snap, lenderOf(snap, x)))}</P>
        </Card>
        <Banner tone="ok">{T.limitNow(pctOf(allowedBps(snap)))}{snap?.wallet ? T.upTo(borrowable(snap).toLocaleString('en-US'), net.asset) : ''}</Banner>
        <Section title={SHARED.detailsAndReceipts} />
        <KV k={SHARED.opened} v={`block ${x.open_height}`} />
        <KV k={SHARED.due} v={`block ${x.maturity_height}`} />
        {repaid ? <KV k={SHARED.paidBack} v={usdt(x.principal + x.fee, net)} /> : <KV k={SHARED.outcome} v={x.outcome} />}
        <KV k={SHARED.bitcoinReturned} v={x.returned_sats === undefined ? SHARED.notVerifiedYet : btc(x.returned_sats)} />
        {x.repayment_txid ? <KV k={SHARED.rgbReceipt} v={short(x.repayment_txid, 16)} mono /> : null}
        <KV k={SHARED.lockReceipt} v={`${short(x.lock_txid, 16)}${x.verified.lock ? ' ✓' : ' ✗'}`} mono />
        <KV k={repaid ? SHARED.releaseReceipt : SHARED.settlementReceipt} v={`${short(x.close_txid, 16)}${x.close_txid ? (x.verified.close ? ' ✓' : ' ✗') : ''}`} mono />
      </>
    ),
    cta: <Btn label={SHARED.backToPassbook} onPress={() => p.openPage(null)} />,
  }
}
