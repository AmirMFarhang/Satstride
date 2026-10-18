// Your borrowing rules: the amount and term from the previous screen, the highest APR and the
// highest share of your bitcoin's value you will lock. Signed with your key after the phone's
// lock; the phone's agent negotiates inside them and never past them.
import React, { useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { DEFAULT_ECONOMICS } from '../../../../../src/core/economics.js'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import { usePassbookView } from '../../app/views'
import { useRelayOffers } from '../../app/offerbook'
import { Button, Choices, Disclosure, FlowTop, Hero, KV, P, Problem, Row, Rows, Screen, Undo, Working, Offline } from '../kit'
import { isConnectionError } from '../errors'
import { useNav } from '../nav'
import { t } from '../theme'
import { pctText, short, usdNum } from '../format'

const APR_STEPS = [600, 800, 1000, 1200, 1500, 2000]
const LTV_STEPS = [3000, 4000, 5000, 6000, 7000]

export function Rules({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const f = useStore(s.borrow.store)
  const view = usePassbookView()
  const book = useRelayOffers()
  const principal = Number(params.principal)
  const termBlocks = Number(params.termBlocks)
  const allowed = view.data?.ladder.allowed_ltv_bps ?? 0
  const signed = s.borrowerState.policy
  const cap = DEFAULT_ECONOMICS.max_apr_bps
  const aprs = useMemo(() => APR_STEPS.filter((a) => a <= cap), [cap])
  const ltvs = useMemo(() => [...new Set([...LTV_STEPS.filter((l) => l < allowed), allowed])].filter((l) => l > 0), [allowed])
  const cheapest = Math.min(...(book.data ?? []).filter((o) => o.payload.term_blocks === termBlocks).map((o) => o.payload.apr_bps))
  const [apr, setApr] = useState<number | null>(null)
  const [ltv, setLtv] = useState<number | null>(null)
  const maxApr = apr ?? signed?.max_apr_bps ?? aprs.find((a) => a >= cheapest) ?? aprs[aprs.length - 1]
  const maxLtv = Math.min(ltv ?? signed?.max_ltv_bps ?? allowed, allowed)
  const [busy, setBusy] = useState(false)
  // the asset the market lends for this term (one test USDT contract on this regtest)
  const assetId = (book.data ?? []).find((o) => o.payload.term_blocks === termBlocks)?.payload.asset_id ?? signed?.asset_id
  const sameAsSigned = !!signed && signed.principal.max === principal && signed.term_blocks.max === termBlocks && signed.max_apr_bps === maxApr && signed.max_ltv_bps === maxLtv && signed.asset_id === assetId

  const sign = async () => {
    if (!assetId) return
    setBusy(true)
    try {
      const ok = sameAsSigned ? signed : await s.borrow.signRules(assetId, { asset_id: assetId, principal, max_apr_bps: maxApr, max_ltv_bps: maxLtv, term_blocks: termBlocks })
      if (ok) nav.push('offers', { principal, termBlocks })
    } finally { setBusy(false) }
  }

  return (
    <Screen top={<FlowTop title="Your rules" onBack={nav.pop} />} bottom={<>
      <Button label={sameAsSigned ? 'Use these rules' : 'Sign these rules'} busy={busy} disabled={!assetId || !allowed || !principal || !termBlocks} onPress={() => void sign()} />
      <Undo text="Your agent negotiates inside these rules and never past them" />
    </>}>
      <Hero value={`${usdNum(principal).replace(/\.00$/, '')} test USDT`} sub={`pay back in ${termBlocks} blocks`} />
      <View style={{ gap: 10 }}>
        <Text style={t.small}>Highest interest a year</Text>
        <Choices label="Highest APR" options={aprs.map((a) => ({ id: a, label: pctText(a) }))} value={maxApr} onChange={setApr} />
        {Number.isFinite(cheapest) ? <P small muted>The cheapest offer for this term asks {pctText(cheapest)}.</P> : null}
      </View>
      <View style={{ gap: 10 }}>
        <Text style={t.small}>Most of your bitcoin's value to borrow against</Text>
        <Choices label="Highest LTV" options={ltvs.map((l) => ({ id: l, label: pctText(l) }))} value={maxLtv} onChange={setLtv} />
        <P small muted>Your passbook allows up to {pctText(allowed)} today. A lower share locks more bitcoin and is safer if the price falls.</P>
      </View>
      <Rows>
        <Row k="Settlement" v="RGB on Bitcoin, co-signed" />
        <Row k="Credit check" v="paid by the lender" />
      </Rows>
      {signed ? (
        <Disclosure label="Rules signed before">
          <KV k="Amount" v={`${usdNum(signed.principal.max).replace(/\.00$/, '')} test USDT`} />
          <KV k="Highest APR" v={pctText(signed.max_apr_bps)} />
          <KV k="Highest LTV" v={pctText(signed.max_ltv_bps)} />
          <KV k="Term" v={`${signed.term_blocks.max} blocks`} />
          <KV k="Signed by" v={short(signed.owner_pk, 6)} />
        </Disclosure>
      ) : null}
      <Working label={view.loading && !view.data ? 'Reading your passbook' : null} />
      <Offline error={view.error ?? book.error} busy={view.loading || book.loading} onRetry={() => { void view.reload(); void book.reload() }} />
      <Problem>{f.error ?? [view.error, book.error].find((e) => e && !isConnectionError(e)) ?? null}</Problem>
    </Screen>
  )
}
