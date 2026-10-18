// Canvas 10: how much, for how long; what it locks and what it costs, from the order book.
import React, { useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { collateralFor, MICRO_PER_USDT } from '../../../../../src/core/money.js'
import { termInterest } from '../../../../../src/core/economics.js'
import { parseUnits } from '../../core/amounts'
import { usePassbookView, viewOffers } from '../../app/views'
import { useRelayOffers } from '../../app/offerbook'
import { useApp } from '../../app/session'
import { Button, Choices, Field, FlowTop, Hero, P, Problem, Row, Rows, Screen, Working, Offline } from '../kit'
import { isConnectionError } from '../errors'
import { useNav } from '../nav'
import { t } from '../theme'
import { btc, usd, usdNum } from '../format'

/** Three round amounts up to the limit: a quarter, a half, all of it. */
function amountChoices(limitMicro: number): number[] {
  const L = Math.floor(limitMicro / MICRO_PER_USDT)
  const nice = (x: number) => (x >= 100 ? Math.floor(x / 50) * 50 : Math.floor(x))
  return [...new Set([nice(L / 4), nice(L / 2), L])].filter((x) => x > 0).map((x) => x * MICRO_PER_USDT)
}

export function BorrowAmount() {
  const s = useApp()
  const nav = useNav()
  const view = usePassbookView()
  const book = useRelayOffers()
  const limit = view.data?.borrowable ?? 0
  const choices = useMemo(() => amountChoices(limit), [limit])
  const [pick, setPick] = useState<number | null>(null)
  const [typed, setTyped] = useState('')
  const terms = useMemo(() => [...new Set((book.data ?? []).map((o) => o.payload.term_blocks))].sort((a, b) => a - b), [book.data])
  const [term, setTerm] = useState<number | null>(null)
  const typedMicro = typed ? parseUnits(typed) : null
  const principal = typedMicro !== null ? Number(typedMicro) : pick ?? choices[Math.min(1, choices.length - 1)] ?? 0
  const termBlocks = term ?? terms[0] ?? null
  const offers = viewOffers((book.data ?? []).filter((o) => termBlocks === null || o.payload.term_blocks === termBlocks), principal, limit, s.key.pubkey)
  const fitting = offers.filter((o) => o.fits)
  const cheapest = fitting[0]
  const fee = cheapest ? termInterest({ principal, apr_bps: cheapest.offer.payload.apr_bps, term_blocks: cheapest.offer.payload.term_blocks }) : null
  const lock = view.data && fee !== null ? collateralFor(principal + fee, view.data.ladder.allowed_ltv_bps, view.data.priceCents) : null

  return (
    <Screen top={<FlowTop title="Borrow" onBack={nav.pop} />} bottom={
      <Button label="Set your rules" disabled={!principal || principal > limit || !fitting.length} onPress={() => nav.push('rules', { principal, termBlocks })} />
    }>
      <Hero value={`${usdNum(principal).replace(/\.00$/, '')} test USDT`} sub={`up to ${usdNum(limit).replace(/\.00$/, '')}`} />
      {choices.length ? <Choices label="Amount" options={choices.map((c) => ({ id: c, label: (c / MICRO_PER_USDT).toLocaleString('en-US') }))} value={typedMicro === null ? principal : null} onChange={(v) => { setTyped(''); setPick(v) }} /> : null}
      <Field label="Or type an amount (test USDT)" value={typed} onChangeText={setTyped} keyboardType="decimal-pad" placeholder="100" />
      {terms.length ? (
        <View style={{ gap: 10 }}>
          <Text style={t.small}>Pay back in</Text>
          <Choices label="Term" options={terms.map((b) => ({ id: b, label: `${b} blocks` }))} value={termBlocks} onChange={setTerm} />
        </View>
      ) : null}
      <Rows>
        <Row k="You lock" v={lock !== null ? btc(lock) : '…'} />
        <Row k="Fee" v={fee !== null ? `from ${usd(fee)}` : '…'} />
      </Rows>
      {principal > limit ? <P muted>That is more than your limit of {usd(limit)} today.</P> : null}
      {book.data && principal && principal <= limit && !fitting.length ? <P muted>No offer in the market lends {usd(principal)} for this term yet. The Market tab shows every offer.</P> : null}
      <Working label={book.loading && !book.data ? 'Reading the market' : null} />
      <Offline error={book.error ?? view.error} busy={book.loading || view.loading} onRetry={() => { void book.reload(); void view.reload() }} />
      <Problem>{[book.error, view.error].find((e) => e && !isConnectionError(e)) ?? null}</Problem>
    </Screen>
  )
}
