// The borrow flow on one screen: the negotiated path (Negotiated.tsx: negotiation, check node,
// consent and scorer approval, the verified result), then stop 2 (accept and lock: canvas 14),
// the lock and the funds arriving. The flow keeps running if the person leaves, and this screen
// picks it up where it is.
import React, { useEffect } from 'react'
import { View } from 'react-native'
import { debtOf } from '../../../../../src/core/terms.js'
import { termInterest } from '../../../../../src/core/economics.js'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import type { BorrowStage } from '../../app/borrow-flow'
import { Button, Disclosure, FlowTop, Hero, KV, P, Problem, Row, Rows, Screen, StopCount, Steps, Undo, Working, type StepState } from '../kit'
import { useNav } from '../nav'
import { btc, partyName, pctText, usd, usdNum } from '../format'
import { borrowerAgreement } from '../words'
import { NEGOTIATED_STAGES, NegotiatedStage } from './Negotiated'
import { TermSheetDetails } from './TermSheet'

const ORDER: BorrowStage[] = ['applying', 'awaiting', 'terms', 'collateral', 'locking', 'funding', 'open']
const at = (stage: BorrowStage, s: BorrowStage) => ORDER.indexOf(stage) >= ORDER.indexOf(s)

export function BorrowFlow() {
  const s = useApp()
  const nav = useNav()
  const f = useStore(s.borrow.store)

  useEffect(() => { if (f.stage === 'open') nav.root() }, [f.stage])

  const offer = f.offer
  const lender = offer ? partyName('Lender', offer.lender_pk) : 'the lender'
  const leave = () => nav.root()

  if (!offer && f.stage === 'idle') {
    return <Screen top={<FlowTop title="Borrow" onBack={leave} />}><P muted>Nothing in progress.</P></Screen>
  }

  if (offer && NEGOTIATED_STAGES.has(f.stage)) return <NegotiatedStage f={f} />

  // Stop 2: accept and lock
  if (f.stage === 'terms' && f.terms && f.loanId) {
    const tm = f.terms
    const split = s.borrower(tm.asset_id).splitPreview(f.loanId)
    const words = borrowerAgreement(tm, lender, split)
    return (
      <Screen top={<FlowTop title="Accept" right={<StopCount n={2} />} />} gap={22} bottom={<>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="Lock and accept" busy={!!f.working} onPress={() => void s.borrow.accept()} style={{ flex: 1 }} />
          <Button kind="secondary" label="Decline" disabled={!!f.working} onPress={() => { s.borrow.decline(); leave() }} style={{ width: 104, height: 56 }} />
        </View>
        <Undo />
      </>}>
        <Hero label="You lock" value={btc(tm.collateral_sats)} sub={`Get ${usdNum(tm.principal)} · repay ${usdNum(debtOf(tm))} by block ${tm.maturity_height}`} />
        <Rows>
          <Row k="Interest" v={`${usd(tm.fee)} · ${pctText(tm.ltv_bps)} of your bitcoin`} />
        </Rows>
        <Disclosure label="What am I agreeing to?">
          <P>{words.text}</P>
          <P small>Worded on your device from your terms. The numbers are the terms.</P>
          {words.rows.map(([k, v]) => <KV key={k} k={k} v={v} />)}
        </Disclosure>
        {s.borrowerState.loans[f.loanId]?.termsheet ? <TermSheetDetails loan={s.borrowerState.loans[f.loanId]} /> : null}
        <Working label={f.working} />
        <Problem>{f.error}</Problem>
      </Screen>
    )
  }

  // waiting for the terms, locking, funding
  const state = (done: boolean, now: boolean): StepState => (done ? 'done' : now ? 'now' : 'next')
  const steps = at(f.stage, 'terms')
    ? [
        { label: `${lender} accepts`, state: 'done' as StepState },
        { label: 'Bitcoin locked', state: state(at(f.stage, 'funding'), f.stage === 'collateral' || f.stage === 'locking') },
        { label: `${f.terms ? usd(f.terms.principal) : 'The loan'} paid in`, state: state(f.stage === 'open', f.stage === 'funding') },
      ]
    : [
        { label: 'Agreed', state: f.deal ? 'done' as StepState : 'next' as StepState, note: f.deal ? `${pctText(f.deal.agreed.apr_bps)} · ${pctText(f.deal.agreed.ltv_bps)} of your bitcoin` : undefined },
        { label: 'Credit check verified on this phone', state: f.checkView?.ok ? 'done' as StepState : 'next' as StepState, note: f.checkView?.outputs?.recommendation },
        { label: `${lender} sends signed terms`, state: state(at(f.stage, 'terms'), f.stage === 'applying' || f.stage === 'awaiting') },
      ]
  const principal = f.terms?.principal ?? f.principal ?? 0
  const fee = f.terms?.fee ?? (f.deal && offer ? termInterest({ principal: f.deal.agreed.principal, apr_bps: f.deal.agreed.apr_bps, term_blocks: f.deal.agreed.term_blocks }) : undefined)
  return (
    <Screen top={<FlowTop title="Borrow" onBack={leave} />} bottom={
      f.error && !f.working ? <Button kind="secondary" label="Back to your passbook" onPress={() => { s.borrow.reset(); leave() }} /> : undefined
    }>
      <Hero value={`${usdNum(principal)} test USDT`} sub={offer ? `from ${lender} · ${offer.payload.term_blocks} blocks` : undefined} />
      <Rows>
        <Row k="You lock" v={f.terms ? btc(f.terms.collateral_sats) : 'set in the terms'} />
        <Row k="Fee" v={fee !== undefined ? usd(fee) : '…'} />
      </Rows>
      <Steps items={steps} />
      <Working label={f.working} />
      <Problem>{f.error}</Problem>
    </Screen>
  )
}
