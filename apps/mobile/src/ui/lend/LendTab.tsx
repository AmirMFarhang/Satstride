// The Lend tab (not on the canvas; drawn in its language): lend test USDT from this wallet.
// Three stops ask for a decision: post the offer, fund a loan, pay the platform fee. The
// phone checks every application itself (the platform's signed private check, the
// borrower's passbook on Bitcoin) and accepts by the posted offer's rules.
// Lane E3: a negotiated offer (the default) is served over Nostr by the phone's agent inside a
// signed policy, with the credit check billed at close; each term sheet is the lender's stop.
import React, { useEffect, useMemo, useState } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import type { Hex } from '../../../../../src/core/crypto.js'
import { debtOf } from '../../../../../src/core/terms.js'
import { lenderReturn } from '../../../../../src/core/economics.js'
import { MICRO_PER_USDT } from '../../../../../src/core/money.js'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import { useVersion, useWalletView } from '../../app/views'
import { useRelayOffers } from '../../app/offerbook'
import { loanPhase, type LoanPhase } from '../../app/lend-flow'
import { canResumeApprovedPayout, PHONE_OFFER } from '../../agent/lender'
import { Button, Choices, Disclosure, FlowTop, Hero, IconButton, KV, P, Problem, Row, Rows, Screen, Sheet, StopCount, Steps, TabBar, TabTop, Tag, TxValue, Undo, Working, type StepState } from '../kit'
import { useNav, useTabSwitch } from '../nav'
import { C, F, R, t } from '../theme'
import { btc, partyName, pctText, usd, usdNum } from '../format'
import { lenderAgreement } from '../words'
import { BILLED_LABEL } from '../../lender/check'
import { marketChoice } from '../../lender/market-policy'
import { pickLendAsset } from '../../lender/assets'
import { FeeParts, LendNegotiation, LendSheet, NegotiationRows, useBilledCheckNodes } from './Negotiated'
import { NETWORK } from '../../wallet/config'

const PHASE_TEXT: Record<LoanPhase, string> = {
  'to-fund': 'Waiting for your OK',
  'waiting-lock': 'Waiting for their bitcoin',
  'paying-out': 'Paying out',
  reconcile: 'Payout needs a check',
  open: 'Open',
  repaid: 'Repaid',
  releasing: 'Repaid · releasing',
  'fee-due': 'Repaid · fee due',
  closed: 'Closed',
  cancelled: 'Refunded · never paid out',
}

/** The test USDT this wallet can lend (src/lender/assets.ts): the market's asset when it holds some, else the test USDT it holds most of (ticker USDT or TUSDT). */
function useLendAsset() {
  const w = useWalletView()
  const book = useRelayOffers()
  const s = useApp()
  return useMemo(() => pickLendAsset(w.data?.assets ?? [], [...(book.data ?? []).map((o) => o.payload.asset_id), s.lenderState.offer?.payload.asset_id]), [w.data, book.data, s.lenderState.offer])
}

export function LendTab() {
  const s = useApp()
  const nav = useNav()
  const onTab = useTabSwitch()
  const f = useStore(s.lend.store)
  useVersion()
  const asset = useLendAsset()
  const [held, setHeld] = useState<{ main: number; repayments: number } | null>(null)
  const offer = s.lenderState.offer && !s.lenderState.offer.withdrawn ? s.lenderState.offer : null
  const loans = Object.entries(s.lenderState.loans).sort((a, b) => b[1].accepted_at - a[1].accepted_at) as [Hex, (typeof s.lenderState.loans)[Hex]][]
  const toFund = loans.find(([, l]) => loanPhase(l, false) === 'to-fund')
  const sheet = Object.values(s.lenderState.proposals ?? {}).sort((a, b) => a.at - b.at)[0]
  const feeDue = loans.find(([id, l]) => loanPhase(l, f.feesDue[id] !== undefined) === 'fee-due')
  useEffect(() => {
    const a = s.lend.lender() ?? (asset ? s.lender(asset.assetId) : null)
    if (a) void a.usdtHeld().then(setHeld).catch(() => setHeld(null))
  }, [s, asset, loans.length, f.working])
  const main = held?.main ?? asset?.settled ?? 0

  return (
    <Screen top={<TabTop title="Lend" right={<IconButton name="gear" label="Settings" onPress={() => nav.push('settings')} side="right" />} />} bottom={<>
      {sheet ? <Button label={`Review ${partyName('Borrower', sheet.borrower_pk)}'s term sheet`} onPress={() => nav.push('lend-sheet', { id: sheet.loan_id })} />
        : toFund ? <Button label={`Review ${partyName('Borrower', toFund[1].borrower_pk)}'s loan`} onPress={() => nav.push('lend-loan', { id: toFund[0] })} />
        : feeDue ? <Button label="Pay the platform fee" onPress={() => nav.push('lend-loan', { id: feeDue[0] })} />
        : offer ? <Button kind="outline" label="Withdraw offer" busy={!!f.working['']} onPress={() => void s.lend.withdraw()} />
        : <Button label="Post an offer" disabled={!asset || asset.spendable < PHONE_OFFER.min} onPress={() => nav.push('lend-offer', { assetId: asset?.assetId })} />}
      <TabBar tab="lend" onTab={onTab} />
    </>}>
      <Hero label="You can lend" value={`${usdNum(main)} ${NETWORK.usdUnit}`} sub={held?.repayments ? `+ ${usdNum(held.repayments)} in repayment accounts` : 'from this wallet'} />
      {offer ? (
        <View style={st.card}>
          <View style={st.head}>
            <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>Your offer</Text>
            <Tag label={f.negotiating ? 'NEGOTIATING' : f.listening ? 'LISTENING' : 'POSTED'} tone={f.listening ? 'green' : 'amber'} />
          </View>
          <Text style={[t.big, { fontSize: 36, lineHeight: 42 }]}>{pctText(offer.payload.apr_bps)} a year</Text>
          <Text style={t.sub}>{usdNum(offer.payload.min).replace(/\.00$/, '')}–{usdNum(offer.payload.max).replace(/\.00$/, '')} {NETWORK.usdUnit} · {offer.payload.term_blocks} blocks · {s.lenderState.market ? `negotiates down to ${pctText(s.lenderState.market.policy.min_apr_bps)}` : 'passbook only'}</Text>
          <Text style={t.small}>{f.working[''] ?? (f.negotiating ? 'Your agent answers borrowers over Nostr inside your policy and checks each one on this phone. Keep the app open.' : f.listening ? 'Checking each application on this phone as it arrives. Keep the app open.' : 'Not listening: keep the app open to take applications.')}</Text>
        </View>
      ) : (
        <P muted>Post an offer and borrowers who fit it can apply. This phone checks each one and accepts by your rules; you still fund each loan yourself.</P>
      )}
      <NegotiationRows />
      {loans.length ? (
        <View>
          <Text style={[t.small, { paddingBottom: 6 }]}>Loans</Text>
          <Rows topLine>
            {loans.map(([id, l]) => {
              const phase = loanPhase(l, f.feesDue[id] !== undefined)
              return <Row key={id} k={`${partyName('Borrower', l.borrower_pk)} · ${usdNum(l.terms.principal)}`} v={f.working[id] ?? PHASE_TEXT[phase]}
                tone={phase === 'to-fund' || phase === 'fee-due' || phase === 'reconcile' ? 'warn' : phase === 'closed' || phase === 'cancelled' ? 'muted' : 'green'} onPress={() => nav.push('lend-loan', { id })} />
            })}
          </Rows>
        </View>
      ) : null}
      {s.lenderState.declined.length ? (
        <View>
          <Text style={[t.small, { paddingBottom: 6 }]}>Declined by the checks</Text>
          <Rows topLine>
            {s.lenderState.declined.slice(-3).reverse().map((d) => (
              <Row key={`${d.borrower_pk}${d.at}`} k={`${partyName('Borrower', d.borrower_pk)} · ${usdNum(d.principal)}`} v={d.failed.map((c) => c.id).slice(0, 2).join(', ')} tone="muted" />
            ))}
          </Rows>
        </View>
      ) : null}
      {!asset ? <P muted>{`Receive ${NETWORK.usdUnit} in the Wallet tab to lend it.`}</P> : null}
      <Problem>{f.error}</Problem>
    </Screen>
  )
}

/** Lender stop 1: post the offer. */
export function PostOffer({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const f = useStore(s.lend.store)
  const w = useWalletView()
  const assetId = String(params.assetId ?? '')
  const asset = w.data?.assets.find((a) => a.assetId === assetId)
  const spendable = asset?.spendable ?? 0
  const caps = useMemo(() => {
    const whole = Math.floor(spendable / MICRO_PER_USDT)
    const nice = (x: number) => (x >= 100 ? Math.floor(x / 50) * 50 : x)
    return [...new Set([nice(whole / 4), nice(whole / 2), whole])].filter((x) => x * MICRO_PER_USDT >= PHONE_OFFER.min).map((x) => x * MICRO_PER_USDT)
  }, [spendable])
  const [apr, setApr] = useState(PHONE_OFFER.apr_bps)
  const [autoFund, setAutoFund] = useState(true)
  const [max, setMax] = useState<number | null>(null)
  // negotiated over Nostr (E3, the default): the lowest APR the agent agrees to, and the check node it asks (billed at close)
  const [negotiate, setNegotiate] = useState(true)
  const [floor, setFloor] = useState<number | null>(null)
  const nodes = useBilledCheckNodes(assetId)
  const usable = nodes.rows.filter((r) => r.usable)
  const [node, setNode] = useState<string | null>(null)
  const pickedNode = usable.find((r) => r.operator_pk === node) ?? usable[0] ?? null
  const floorOptions = [...new Set([apr - 300, apr - 200, apr - 100, apr].filter((b) => b >= 0))]
  const floorBps = floor !== null && floorOptions.includes(floor) ? floor : floorOptions[Math.max(0, floorOptions.length - 3)]
  // the node and the price on screen, both signed into the policy: the bill can never exceed what the person saw
  const market = negotiate && pickedNode ? marketChoice(pickedNode, floorBps, assetId) : undefined
  const cap = max ?? caps[caps.length - 1] ?? PHONE_OFFER.min
  const policy = { ...PHONE_OFFER, apr_bps: apr, max: Math.min(cap, PHONE_OFFER.max) }
  const net = lenderReturn({ principal: policy.min, fee: 0, term_blocks: policy.term_blocks })
  useEffect(() => { if (s.lenderState.offer && !s.lenderState.offer.withdrawn && !f.working['']) nav.pop() }, [s.lenderState.offer, f.working])
  return (
    <Screen top={<FlowTop title="Post an offer" onBack={nav.pop} right={<StopCount n={1} />} />} bottom={<>
      <Button label="Post offer" busy={!!f.working['']} disabled={!asset || cap < PHONE_OFFER.min || (negotiate && !market)} onPress={() => void s.lend.post(policy, assetId, autoFund, market)} />
      <Undo text="Anyone can read it. You can withdraw it any time." />
    </>}>
      <Hero value={`${pctText(apr)} a year`} sub={`for ${policy.term_blocks} blocks`} />
      <View style={{ gap: 10 }}>
        <Text style={t.small}>Interest a year</Text>
        <Choices label="Interest" options={[900, 1100, 1300, 1500].map((b) => ({ id: b, label: pctText(b) }))} value={apr} onChange={setApr} />
      </View>
      {caps.length ? (
        <View style={{ gap: 10 }}>
          <Text style={t.small}>Lend up to</Text>
          <Choices label="Largest loan" options={caps.map((c) => ({ id: c, label: (c / MICRO_PER_USDT).toLocaleString('en-US') }))} value={cap} onChange={setMax} />
        </View>
      ) : null}
      <Rows>
        <Row k="Lends" v={`${usdNum(policy.min).replace(/\.00$/, '')}–${usdNum(policy.max).replace(/\.00$/, '')} ${NETWORK.usdUnit}`} />
        <Row k="Asks to see" v="their passbook only" />
        <Row k="Bitcoin they lock" v="50–65% of value, by their step" />
        <Row k="Platform fee" v={`${pctText(net.share_bps)} of the interest, after close`} />
        <View style={st.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={t.body}>Pay out automatically</Text>
            <Text style={t.small}>once their bitcoin is locked</Text>
          </View>
          <Switch accessibilityLabel="Pay out automatically" value={autoFund} onValueChange={setAutoFund} trackColor={{ true: C.green, false: C.track }} thumbColor={C.white} />
        </View>
        <View style={st.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={t.body}>Negotiate over Nostr</Text>
            <Text style={t.small}>your agent answers borrowers inside your rules</Text>
          </View>
          <Switch accessibilityLabel="Negotiate over Nostr" value={negotiate} onValueChange={setNegotiate} trackColor={{ true: C.green, false: C.track }} thumbColor={C.white} />
        </View>
      </Rows>
      {negotiate ? (
        <View style={{ gap: 10 }}>
          <Text style={t.small}>Lowest interest your agent agrees to</Text>
          <Choices label="Lowest interest" options={floorOptions.map((b) => ({ id: b, label: pctText(b) }))} value={floorBps} onChange={setFloor} />
          <Text style={t.small}>Credit check</Text>
          {usable.length > 1 ? <Choices label="Check node" options={usable.map((r) => ({ id: r.operator_pk, label: r.operator_pk.slice(0, 6) }))} value={pickedNode?.operator_pk ?? null} onChange={setNode} /> : null}
          <Rows>
            <Row k="Check node" v={pickedNode ? pickedNode.label : nodes.loading ? 'looking on the relay…' : 'none bills at close on the relay'} tone={pickedNode ? 'green' : 'warn'} />
            <Row k={BILLED_LABEL} v={pickedNode ? 'added to the platform fee at close' : '—'} tone="muted" />
          </Rows>
        </View>
      ) : null}
      <Disclosure label="What am I agreeing to?">
        {negotiate
          ? <P>{`Anyone can read this offer. Your agent opens at ${pctText(apr)} and never agrees below ${pctText(floorBps)}, under the platform's caps; every move is signed and checked against the rules you sign now. After a deal, the check node runs a Compex credit check on credit and this phone opens and verifies it. Only a QUALIFY becomes a term sheet, and you approve each one.`}</P>
          : <P>Anyone can read this offer. A borrower who fits applies; this phone checks the platform's signed private check and their passbook on Bitcoin, prices the loan by fixed rules and accepts it if every check passes.</P>}
        {negotiate ? <P>{`${BILLED_LABEL}: the check's price is added to the platform fee you pay over RGB when the loan closes. If no loan follows, the provider absorbs it.`}</P> : null}
        {autoFund
          ? <P>Then it pays them out as soon as their bitcoin is locked on Bitcoin, within this offer. A borrower waits only two minutes for the payout after locking.</P>
          : <P>Then you approve each payout yourself, within two minutes of their bitcoin locking. If you miss it, the loan is refunded to them and nothing moves.</P>}
      </Disclosure>
      {asset && spendable < PHONE_OFFER.min ? <Problem>{`Lending starts at ${usd(PHONE_OFFER.min)}; this wallet has ${usd(spendable)}.`}</Problem> : null}
      <Working label={f.working[''] ?? null} />
      <Problem>{f.error}</Problem>
    </Screen>
  )
}

/** One loan: lender stop 2 (fund) when it waits for the person, stop 3 (the platform fee) after close, progress between. */
export function LendLoan({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const f = useStore(s.lend.store)
  useVersion()
  const [checks, setChecks] = useState(false)
  const id = String(params.id) as Hex
  const l = s.lenderState.loans[id]
  if (!l) return <Screen top={<FlowTop title="Loan" onBack={nav.pop} />}><P muted>This loan is not on this phone.</P></Screen>
  const tm = l.terms
  const borrower = partyName('Borrower', l.borrower_pk)
  const due = f.feesDue[id]
  const phase = loanPhase(l, due !== undefined)
  const r = lenderReturn({ principal: tm.principal, fee: tm.fee, term_blocks: tm.maturity_height - tm.open_height })
  const passed = l.checks.filter((c) => c.ok).length
  const resumeApproved = canResumeApprovedPayout(l, id) && !f.working[id]

  if (phase === 'cancelled') {
    return (
      <Screen top={<FlowTop title={borrower} onBack={nav.pop} />}>
        <Hero value={`${usdNum(tm.principal)} test USDT`} sub="never paid out" />
        <P muted>The payout did not happen in time, so the platform refunded {borrower}'s bitcoin to them ({l.cancelled}). No test USDT left this wallet.</P>
      </Screen>
    )
  }

  if (phase === 'to-fund') {
    const split = s.lender(tm.asset_id).splitPreview(id)
    const words = lenderAgreement(tm, borrower, split)
    return (
      <Screen top={<FlowTop title="Fund" onBack={nav.pop} right={<StopCount n={2} />} />} gap={22} bottom={<>
        <Button label="Fund when their bitcoin is locked" busy={!!f.working[id]} onPress={() => void s.lend.fund(id)} />
        <Undo text="Can't be undone · they wait two minutes after locking" />
      </>}>
        <Hero label="You lend" value={`${usdNum(tm.principal)} test USDT`} sub={`to ${borrower} · they repay ${usdNum(debtOf(tm))} by block ${tm.maturity_height}`} />
        <Rows>
          <Row k="Their bitcoin locked" v={`${btc(tm.collateral_sats)} · ${pctText(tm.ltv_bps)}`} />
          <Row k="You earn" v={usd(r.net)} />
          <Row k="Platform's share" v={usd(r.platform)} tone="muted" />
          <Row k="Checks" v={`${passed} of ${l.checks.length} passed`} tone={passed === l.checks.length ? 'green' : 'warn'} onPress={() => setChecks(true)} />
        </Rows>
        <Disclosure label="What am I agreeing to?">
          <P>{words.text}</P>
          <P small>Worded on your device from the terms. The numbers are the terms.</P>
          {words.rows.map(([k, v]) => <KV key={k} k={k} v={v} />)}
        </Disclosure>
        <Working label={f.working[id] ?? null} />
        <Problem>{f.error}</Problem>
        <ChecksSheet visible={checks} onClose={() => setChecks(false)} checks={l.checks} memo={l.memo} />
      </Screen>
    )
  }

  const st2 = (done: boolean, now: boolean): StepState => (done ? 'done' : now ? 'now' : 'next')
  return (
    <Screen top={<FlowTop title={borrower} onBack={nav.pop} right={phase === 'fee-due' ? <StopCount n={3} /> : undefined} />} bottom={phase === 'fee-due' ? <>
      <Button label={`Pay the platform fee, ${usdNum(due!)} ${NETWORK.usdUnit}`} busy={!!f.working[id]} disabled={!!f.feeParts[id]?.problems.length} onPress={() => void s.lend.payFee(id)} />
      <Undo />
    </> : resumeApproved ? <>
      <Button label="Resume approved payout" onPress={() => s.lend.follow(id)} />
      <P small>Your approval still applies. The phone checks that their bitcoin is locked before paying out.</P>
    </> : undefined}>
      <Hero value={`${usdNum(debtOf(tm))} test USDT`} sub={phase === 'closed' || phase === 'repaid' || phase === 'fee-due' ? `repaid by ${borrower}` : `${borrower} repays by block ${tm.maturity_height}`} />
      <Steps items={[
        { label: 'Accepted by your offer', state: 'done' },
        { label: 'Their bitcoin locked', state: st2(!!l.lock, phase === 'waiting-lock') },
        { label: `${usd(tm.principal)} paid out`, state: phase === 'reconcile' ? 'failed' : st2(!!l.disbursement_txid, phase === 'paying-out') },
        { label: 'Their IOU received', state: st2(!!l.iou, !!l.disbursement_txid && !l.iou && phase === 'open') },
        { label: 'Repaid into this loan\'s account', state: st2(!!l.repayment_txid, phase === 'open') },
        { label: 'Bitcoin released to them', state: st2(!!l.release_txid, phase === 'releasing') },
        { label: 'Platform fee paid', state: st2(!!l.fee_paid_txid, phase === 'fee-due') },
      ]} />
      <Working label={f.working[id] ?? null} />
      {phase === 'fee-due' ? <FeeParts parts={f.feeParts[id]} /> : null}
      <Rows>
        <Row k="You earn" v={usd(r.net)} />
          <Row k="Platform's share" v={usd(r.platform)} tone="muted" />
        <Row k="Checks" v={`${passed} of ${l.checks.length} passed`} onPress={() => setChecks(true)} />
      </Rows>
      <Disclosure label="Details and receipts">
        {l.lock ? <KV k="Collateral lock" v={<TxValue id={l.lock.txid} />} /> : null}
        {l.disbursement_txid ? <KV k="Payout" v={<TxValue id={l.disbursement_txid} />} /> : null}
        {l.repayment_account ? <KV k="Repayment account" v={l.repayment_account} /> : null}
        {l.repayment_txid ? <KV k="Repayment" v={<TxValue id={l.repayment_txid} />} /> : null}
        {l.iou_returned_txid ? <KV k="IOU returned" v={<TxValue id={l.iou_returned_txid} />} /> : null}
        {l.release_txid ? <KV k="Release" v={<TxValue id={l.release_txid} />} /> : null}
        {l.fee_paid_txid ? <KV k="Platform fee" v={<TxValue id={l.fee_paid_txid} />} /> : null}
        <KV k="Loan" v={<TxValue id={id} />} />
      </Disclosure>
      {phase === 'reconcile' ? <Problem>A payout was started and not confirmed. The wallet does not send it again by itself; check Wallet health.</Problem> : null}
      <Problem>{f.error}</Problem>
      <ChecksSheet visible={checks} onClose={() => setChecks(false)} checks={l.checks} memo={l.memo} />
    </Screen>
  )
}

function ChecksSheet({ visible, onClose, checks, memo }: { visible: boolean; onClose: () => void; checks: { id: string; ok: boolean; detail: string }[]; memo: string }) {
  return (
    <Sheet visible={visible} onClose={onClose} title="What this phone checked">
      <View style={{ gap: 8 }}>
        {checks.map((c) => (
          <View key={c.id} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={[t.bodyMedium, { color: c.ok ? C.green : C.warn, width: 18 }]}>{c.ok ? '✓' : '✗'}</Text>
            <Text style={[t.small, { flex: 1 }]}><Text style={{ color: C.ink, fontFamily: F.medium }}>{c.id}</Text> · {c.detail}</Text>
          </View>
        ))}
      </View>
      {memo ? <P small>{memo}</P> : null}
    </Sheet>
  )
}

export const LEND_SCREENS: Record<string, React.ComponentType<{ params: Record<string, unknown> }>> = {
  'lend-offer': PostOffer,
  'lend-loan': LendLoan,
  'lend-sheet': LendSheet,
  'lend-negotiation': LendNegotiation,
}

const st = StyleSheet.create({
  card: { borderRadius: R.card, backgroundColor: C.surface, padding: 20, gap: 10 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  switchRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 },
})
