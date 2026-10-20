import { hashObject } from '../../../../../src/core/crypto.js'
// The lender's negotiated screens (lane E3), in the canvas's language: each negotiation's live
// signed transcript and where its credit check stands, the term sheet waiting for the person
// (one stop: these terms, and the payout once their bitcoin is locked), the check nodes that
// bill at close, and the fee at close with its parts. Every amount is a test coin named with
// its network; nothing is shown in fiat.
import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import type { Hex } from '../../../../../src/core/crypto.js'
import { debtOf } from '../../../../../src/core/terms.js'
import { KIND } from '../../../../../src/market/kinds.js'
import { latestOffers } from '../../../../../src/checknode/offer.js'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import { useVersion } from '../../app/views'
import { NETWORK } from '../../wallet/config'
import { BILLED_LABEL } from '../../lender/check'
import { closeFeeLines, type CloseFees } from '../../lender/fees'
import { billedCheckNodes, deskPhase, lenderTranscript, type CheckNodeRow } from '../../lender/views'
import type { NegotiationRecord } from '../../lender/review'
import { Button, Disclosure, FlowTop, Hero, KV, P, Problem, Row, Rows, Screen, StopCount, TxValue, Undo, Working } from '../kit'
import { useNav } from '../nav'
import { C, F, t } from '../theme'
import { btc, partyName, pctText, usd } from '../format'


/** The check nodes on the relay that bill a lender at close in this asset (kind 38401, signed by their operators). */
export function useBilledCheckNodes(assetId: string): { rows: CheckNodeRow[]; loading: boolean } {
  const s = useApp()
  const [rows, setRows] = useState<CheckNodeRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    const relay = assetId ? s.lender(assetId).relay : null
    if (!relay) { setLoading(false); return }
    void relay.list<unknown>(KIND.CHECK_OFFER).then((events) => {
      const { valid } = latestOffers(events.map((e) => ({ offer: e.payload, created_at: e.event.created_at, pubkey: e.event.pubkey as Hex })), Math.floor(Date.now() / 1000))
      if (live) setRows(billedCheckNodes(valid, assetId, NETWORK.usdUnit))
    }).catch(() => {}).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [s, assetId])
  return { rows, loading }
}

/** The Lend tab's list of negotiations, newest first. */
export function NegotiationRows() {
  const s = useApp()
  const nav = useNav()
  useVersion()
  const st = s.lenderState
  const list = Object.values(st.negotiations ?? {}).sort((a, b) => b.started_at - a.started_at).slice(0, 4)
  if (!list.length) return null
  return (
    <View>
      <Text style={[t.small, { paddingBottom: 6 }]}>Negotiations over Nostr</Text>
      <Rows topLine>
        {list.map((r) => {
          const d = deskPhase(r, st.proposals, st.loans)
          return <Row key={r.negotiation_id} k={partyName('Borrower', r.borrower_pk)} v={d.words} tone={d.phase === 'sheet' ? 'warn' : d.phase === 'no-deal' || d.phase === 'not-qualified' || d.phase === 'check-refused' ? 'muted' : 'green'} onPress={() => nav.push('lend-negotiation', { id: r.negotiation_id })} />
        })}
      </Rows>
    </View>
  )
}

function Transcript({ r }: { r: NegotiationRecord }) {
  const tr = lenderTranscript(r.messages, r.borrower_pk)
  return (
    <View style={{ gap: 8 }}>
      {tr.lines.map((l) => (
        <View key={l.key} style={{ flexDirection: 'row', gap: 10 }}>
          <Text style={[t.small, { width: 24, color: C.faint }]}>#{l.seq}</Text>
          <Text style={[t.body, { flex: 1 }]}><Text style={{ fontFamily: F.semibold, color: l.who === 'You' ? C.green : C.ink }}>{l.who}</Text> {l.text}</Text>
          <Text style={[t.small, { color: C.faint }]}>{l.sig}</Text>
        </View>
      ))}
      {tr.end ? <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>{tr.end}</Text> : null}
      {tr.problems.length ? <Problem>{tr.problems.join('; ')}</Problem> : null}
      <P small muted>Each line is a message signed by its sender and chained to the one before. Your agent signs only moves inside the policy you approved.</P>
    </View>
  )
}

/** One negotiation: the live transcript, then the credit check billed at close. */
export function LendNegotiation({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  useVersion()
  const id = String(params.id) as Hex
  const st = s.lenderState
  const r = st.negotiations?.[id]
  if (!r) return <Screen top={<FlowTop title="Negotiation" onBack={nav.pop} />}><P muted>This negotiation is not on this phone.</P></Screen>
  const d = deskPhase(r, st.proposals, st.loans)
  const sheet = Object.values(st.proposals ?? {}).find((p) => p.negotiation_id === id)
  const agreed = typeof r.outcome === 'object' && 'agreed' in r.outcome ? r.outcome.agreed : null
  const k = r.check
  return (
    <Screen top={<FlowTop title={partyName('Borrower', r.borrower_pk)} onBack={nav.pop} />} bottom={sheet ? <Button label="Review the term sheet" onPress={() => nav.push('lend-sheet', { id: sheet.loan_id })} /> : undefined}>
      <Hero value={agreed ? `${pctText(agreed.apr_bps)} a year` : d.words} sub={agreed ? `${usd(agreed.principal)} · ${pctText(agreed.ltv_bps)} LTV · ${agreed.term_blocks} blocks` : `negotiation ${id.slice(0, 8)}`} />
      <Transcript r={r} />
      {agreed ? (
        <Rows topLine>
          <Row k="Credit check" v={d.words} tone={d.phase === 'not-qualified' || d.phase === 'check-refused' ? 'warn' : 'green'} />
          {k ? <Row k="Result" v={`${k.recommendation ?? 'none'}${k.income_band ? ` · income ${k.income_band}` : ''}`} tone={k.refusals.length ? 'warn' : 'green'} /> : null}
          {k ? <Row k="Checked on this phone" v={`${k.ticks.filter((x) => x.ok).length} of ${k.ticks.length}`} /> : null}
          {k ? <Row k={BILLED_LABEL} v={usd(k.bill.amount)} tone="muted" /> : null}
        </Rows>
      ) : null}
      {k ? (
        <Disclosure label="What this phone checked">
          {k.ticks.map((x) => <KV key={x.id} k={`${x.ok ? '✓' : '✗'} ${x.id}`} v={x.detail} />)}
          {k.not_run.length ? <P small>Not checked on this phone: {k.not_run.join(', ')}.</P> : null}
          {k.refusals.length ? <P small>Not funded: {k.refusals.join('; ')}</P> : null}
          <P small>{k.rail_label}</P>
          {k.execution_id ? <KV k="scorer run" v={k.execution_id} /> : null}
          <KV k="Key sent to them" v={<TxValue id={k.key_hash} />} />
          <KV k="Bill" v={<TxValue id={k.bill.bill_hash} />} />
        </Disclosure>
      ) : null}
      {r.check_error ? <Problem>{r.check_error}</Problem> : null}
    </Screen>
  )
}

/** The negotiated stop: the term sheet, with the check and the bill, approved with the phone's lock. */
export function LendSheet({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const f = useStore(s.lend.store)
  useVersion()
  const id = String(params.id) as Hex
  const p = s.lenderState.proposals?.[id]
  useEffect(() => { if (!p && s.lenderState.loans[id]) nav.pop() }, [p, s.lenderState.loans[id]]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return <Screen top={<FlowTop title="Term sheet" onBack={nav.pop} />}><P muted>This term sheet is not waiting for approval.</P></Screen>
  const tm = p.sheet.terms
  const borrower = partyName('Borrower', p.borrower_pk)
  const bill = s.lenderState.bills?.find((b) => b.negotiation_id === p.negotiation_id)
  const passed = p.checks.filter((c) => c.ok).length
  const ev = p.sheet.scorer.evidence
  return (
    <Screen top={<FlowTop title="Term sheet" onBack={nav.pop} right={<StopCount n={2} />} />} gap={22} bottom={<>
      <Button label="Approve and lend when their bitcoin is locked" busy={!!f.working[id]} onPress={() => void s.lend.approveSheet(id)} />
      <Undo text="Can't be undone · they wait three minutes for your answer" />
      <Button kind="outline" label="Decline" disabled={!!f.working[id]} onPress={() => { void s.lend.declineSheet(id); nav.pop() }} />
    </>}>
      <Hero label="You lend" value={usd(tm.principal)} sub={`to ${borrower} at ${pctText(p.sheet.apr_bps)} a year (negotiated) · they repay ${usd(debtOf(tm))} by block ${tm.maturity_height}`} />
      <Rows>
        <Row k="Their bitcoin locked" v={`${btc(tm.collateral_sats)} · ${pctText(tm.ltv_bps)}`} />
        <Row k="Credit check" v={`${p.sheet.scorer.recommendation} · local scorer (development assurance)`} tone="green" />
        <Row k="Checks" v={`${passed} of ${p.checks.length} passed`} tone={passed === p.checks.length ? 'green' : 'warn'} />
        {bill ? <Row k={BILLED_LABEL} v={usd(bill.amount)} tone="muted" /> : null}
      </Rows>
      {bill ? <P small muted>{`The check node ran the check on credit. ${usd(bill.amount)} is added to the platform fee you pay over RGB when this loan closes. Nothing was paid up front.`}</P> : null}
      <Disclosure label="What am I agreeing to?">
        <P>{`You lend ${usd(tm.principal)} to ${borrower} once their ${NETWORK.btcUnit} is locked on Bitcoin. They repay ${usd(debtOf(tm))} by block ${tm.maturity_height}. If they do not, the locked bitcoin pays you after block ${tm.maturity_height + tm.grace_blocks}.`}</P>
        <P small>The terms hash below is what their lock commits on chain; it binds the scorer evidence and their consent.</P>
        <KV k="Terms hash" v={<TxValue id={id} />} />
        {ev ? <KV k="Evidence reference" v={<TxValue id={hashObject(ev)} />} /> : null}
        {p.checks.map((c) => <KV key={c.id} k={`${c.ok ? '✓' : '✗'} ${c.id}`} v={c.detail} />)}
      </Disclosure>
      <Working label={f.working[id] ?? null} />
      <Problem>{f.error}</Problem>
    </Screen>
  )
}

/** The fee at close, by part: the platform's share and the checks billed at close. */
export function FeeParts({ parts }: { parts: CloseFees | undefined }) {
  if (!parts) return null
  return (
    <View style={{ gap: 6 }}>
      {closeFeeLines(parts, NETWORK.usdUnit).map((l) => <KV key={l.k} k={l.k} v={l.v} />)}
      {parts.problems.length ? <Problem>{`Not paying this fee: ${parts.problems.join('; ')}`}</Problem> : null}
    </View>
  )
}
