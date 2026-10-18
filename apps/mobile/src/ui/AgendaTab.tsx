// The Agenda tab: D1's personal agenda (src/ui/agenda/Agenda.tsx) over this phone's own loans,
// pages and ladder, with deadlines counted from the chain height the phone reads.
import React, { useEffect, useState } from 'react'
import { CURE_BLOCKS } from '../../../../src/registry/ladder.js'
import { agendaLoans, noteBlock, runningLoanIds } from '../app/agenda'
import { useApp } from '../app/session'
import { useStore } from '../app/store'
import { usePassbookView, useVersion } from '../app/views'
import type { BlockSeen } from './agenda/agenda-model'
import { Agenda } from './agenda/Agenda'
import { Offline, Problem, Screen, TabBar, TabTop } from './kit'
import { HeroBones, RowBones, Skeleton } from '../motion/Skeleton'
import { PersonaLine } from './borrow/PersonaLine'
import { useNav, useTabSwitch } from './nav'
import { partyName } from './format'
import { isConnectionError } from './errors'

// the heights this app run saw arrive, kept across visits to the tab
let seenBlocks: BlockSeen[] = []

export function AgendaTab() {
  const s = useApp()
  const nav = useNav()
  const onTab = useTabSwitch()
  const view = usePassbookView()
  const flow = useStore(s.borrow.store)
  useVersion()
  const v = view.data
  const [seen, setSeen] = useState<BlockSeen[]>(seenBlocks)
  useEffect(() => { if (v) { seenBlocks = noteBlock(seenBlocks, v.height, Date.now()); setSeen(seenBlocks) } }, [v?.height])
  const ctx = { flowLoanId: flow.loanId, flowStage: flow.stage, pageIds: (v?.pages ?? []).map((p) => p.loan_id), name: partyName }
  // the platform's record of each running loan says whether a margin call was raised (as on the home and page screens)
  const [marginCalls, setMarginCalls] = useState<Record<string, number>>({})
  const running = runningLoanIds(agendaLoans(s.borrowerState, s.lenderState, ctx)).join(',')
  useEffect(() => {
    let live = true
    void Promise.all(running.split(',').filter(Boolean).map(async (id) => [id, (await s.platform.loan(id as never).catch(() => null))?.margin_call_height] as const))
      .then((rows) => { if (live) setMarginCalls(Object.fromEntries(rows.filter(([, h]) => typeof h === 'number') as [string, number][])) })
    return () => { live = false }
  }, [running, v?.height])
  const loans = agendaLoans(s.borrowerState, s.lenderState, { ...ctx, marginCalls })
  return (
    <Screen top={<TabTop title="Agenda" />} bottom={<TabBar tab="agenda" onTab={onTab} />}>
      <PersonaLine />
      {v ? (
        <Agenda
          height={v.height} now={Date.now()} seen={seen} loans={loans}
          pages={v.pages.map((p) => ({ loan_id: p.loan_id, outcome: p.outcome, principal: p.principal, open_height: p.open_height, maturity_height: p.maturity_height, ladder_step: p.ladder_step, ...(p.close_txid ? { close_txid: p.close_txid } : {}) }))}
          ladder={{ steps: v.ladderBps, at: v.ladder.step }} cureBlocks={CURE_BLOCKS}
          onOpenLoan={(id) => (loans.find((l) => l.id === id)?.role === 'lender' ? nav.go('lend', 'lend-loan', { id }) : nav.go('passbook'))} onOpenPage={(id) => nav.push('page', { id })}
        />
      ) : view.loading ? <Skeleton label="Reading your passbook from Bitcoin"><HeroBones /><RowBones rows={3} /></Skeleton> : null}
      <Offline error={view.error} busy={view.loading} onRetry={() => void view.reload()} />
      <Problem>{view.error && !isConnectionError(view.error) ? view.error : null}</Problem>
    </Screen>
  )
}
