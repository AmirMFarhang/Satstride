// Check a loan (open or closed) on this phone against Bitcoin and the signatures, and the receipt
// of a closed loan: what was borrowed and paid, the bitcoin that came back, the step it earned,
// the evidence it was underwritten on and who paid for the check. Every line comes from the
// loan this phone keeps and is checked again by checkLoan (src/app/loan-check.ts).
import React, { useCallback, useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import type { Hex } from '../../../../../src/core/crypto.js'
import { debtOf } from '../../../../../src/core/terms.js'
import { checkFingerprint, checkLoan, type LoanTick } from '../../app/loan-check'
import { useApp } from '../../app/session'
import { usePassbookView } from '../../app/views'
import { Button, Disclosure, FlowTop, Hero, KV, Note, P, Problem, Row, Rows, Screen, Stamp, TxValue, Working } from '../kit'
import { PersonaLine } from './PersonaLine'
import { useNav } from '../nav'
import { Icon } from '../icons'
import { C, t } from '../theme'
import { btc, partyName, pctText, short, usd } from '../format'

function useLoanCheck(id: Hex) {
  const s = useApp()
  const l = s.borrowerState.loans[id]
  const [ticks, setTicks] = useState<LoanTick[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    if (!l) return
    setBusy(true); setError(null)
    try { setTicks((await checkLoan(s.borrower(l.terms.asset_id), id, l)).ticks) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [id, l, s])
  useEffect(() => { void run() }, [run])
  return { l, ticks, error, busy, run }
}

function TickRow({ x }: { x: LoanTick }) {
  const icon = x.ok === true ? 'check' : x.ok === false ? 'close' : 'info'
  const color = x.ok === true ? C.green : x.ok === false ? C.warn : C.muted
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 6 }}>
      <Icon name={icon} size={18} color={color} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={t.bodyMedium}>{x.label}</Text>
        <Text style={t.small}>{x.detail}</Text>
      </View>
    </View>
  )
}

export function CheckLoan({ params }: { params: Record<string, unknown> }) {
  const nav = useNav()
  const id = String(params.id) as Hex
  const { l, ticks, error, busy, run } = useLoanCheck(id)
  if (!l) return <Screen top={<FlowTop title="Check this loan" onBack={nav.pop} />}><P muted>This phone does not hold this loan.</P></Screen>
  const failed = (ticks ?? []).filter((x) => x.ok === false)
  return (
    <Screen top={<FlowTop title="Check this loan" onBack={nav.pop} />} bottom={<Button kind="secondary" label="Check again" busy={busy} onPress={() => void run()} />}>
      <Hero value={usd(l.terms.principal)} sub={`from ${partyName('Lender', l.lender_pk)} · loan ${short(id, 6)}`} size="mid" />
      {ticks ? (failed.length
        ? <Note tone="warn" icon="close" title={`${failed.length} check${failed.length === 1 ? '' : 's'} did not pass`} sub={failed.map((x) => x.label).join(', ')} />
        : <Note icon="check" title="Everything checks out" sub="Checked on this phone against Bitcoin and the signatures" />) : null}
      <View>{(ticks ?? []).map((x) => <TickRow key={x.id} x={x} />)}</View>
      <P small>The platform's record is shown for comparison only; the phone decides from the chain and the signatures.</P>
      <Working label={busy && !ticks ? 'Checking against Bitcoin' : null} />
      <Problem>{error}</Problem>
    </Screen>
  )
}

export function Receipt({ params }: { params: Record<string, unknown> }) {
  const nav = useNav()
  const view = usePassbookView()
  const id = String(params.id) as Hex
  const { l, ticks, error, busy } = useLoanCheck(id)
  if (!l) return <Screen top={<FlowTop title="Receipt" onBack={nav.pop} />}><P muted>This phone does not hold this loan.</P></Screen>
  const tm = l.terms
  const page = view.data?.pages.find((p) => p.loan_id === id)
  const sheet = l.termsheet
  const e = sheet?.scorer.evidence
  const passed = (ticks ?? []).filter((x) => x.ok === true).length
  const failed = (ticks ?? []).filter((x) => x.ok === false).length
  return (
    <Screen top={<FlowTop title="Receipt" onBack={nav.pop} />} bottom={<Button kind="secondary" label="Check this loan" onPress={() => nav.push('check-loan', { id })} />}>
      <View style={{ alignItems: 'center', gap: 8 }}>
        <Stamp text={l.release_txid ? 'PAID' : 'OPEN'} />
        <Text style={t.sub}>{partyName('Lender', l.lender_pk)} · loan {short(id, 6)}</Text>
      </View>
      <PersonaLine />
      <Rows topLine>
        <Row k="Borrowed" v={usd(tm.principal)} />
        <Row k="Interest" v={`${usd(tm.fee)}${sheet ? ` · ${pctText(sheet.apr_bps)} a year` : ''}`} />
        <Row k="Paid back" v={usd(debtOf(tm))} />
        <Row k="Bitcoin locked" v={btc(tm.collateral_sats)} />
        {page?.returned_sats !== undefined ? <Row k="Bitcoin returned" v={btc(page.returned_sats)} tone="green" /> : null}
        {view.data ? <Row k="Your step now" v={`${view.data.ladder.step} · limit ${pctText(view.data.ladder.allowed_ltv_bps)}`} /> : null}
      </Rows>
      <Disclosure label="Underwritten on">
        {sheet ? <>
          <KV k="Check" v={`${sheet.scorer.provider}${sheet.scorer.fallback ? ' (fallback)' : ''} · ${sheet.scorer.recommendation}`} />
          {e?.kind === 'compex-dsse' ? <KV k="Compex run" v={short(e.execution_id, 8)} /> : null}
          {e ? <KV k="Evidence digest" v={short(e.kind === 'compex-dsse' ? e.envelope_sha256 : e.run_record_sha256, 8)} /> : null}
          {sheet.scorer.check_receipt ? <KV k="Check node" v={short(sheet.scorer.check_receipt.operator_pk, 6)} /> : null}
          <KV k="Paid for by" v={partyName('Lender', l.lender_pk)} />
          <KV k="Lender approvals" v={String(l.lender_approvals?.length ?? 0)} />
          {(l.lender_decisions ?? []).map((d) => <KV key={d.hash} k={d.kind.replace(/-/g, ' ')} v={`${d.result} · signed`} />)}
        </> : <KV k="Check" v="the platform sandbox (before negotiated loans)" />}
      </Disclosure>
      <Disclosure label="Receipts on Bitcoin">
        {l.lock ? <KV k="Lock" v={<TxValue id={l.lock.txid} />} /> : null}
        {l.disbursement_txid ? <KV k="Loan paid in" v={<TxValue id={l.disbursement_txid} />} /> : null}
        {l.repayment_txid ? <KV k="Your payment" v={<TxValue id={l.repayment_txid} />} /> : null}
        {l.repayment_receipt ? <KV k="Lender's receipt" v={`signed · ${short(l.repayment_receipt.sig, 6)}`} /> : null}
        {l.release_txid ? <KV k="Release" v={<TxValue id={l.release_txid} />} /> : null}
      </Disclosure>
      {ticks ? <Note tone={failed ? 'warn' : 'green'} icon={failed ? 'close' : 'check'} title={failed ? `${failed} check${failed === 1 ? '' : 's'} did not pass` : `${passed} checks passed on this phone`} sub={`fingerprint ${checkFingerprint(ticks)}`} /> : null}
      <Working label={busy && !ticks ? 'Checking against Bitcoin' : null} />
      <Problem>{error}</Problem>
    </Screen>
  )
}
