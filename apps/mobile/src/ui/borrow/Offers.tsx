// Canvas 11: the wallet's shortlist. Offers read from the relay, ranked on the phone against the
// rules the person signed (src/market/negotiate.ts rankOffers, explained by its fixed template);
// the phone's agent negotiates with the one the person picks.
import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useApp } from '../../app/session'
import { usePassbookView } from '../../app/views'
import { useRelayOffers } from '../../app/offerbook'
import { rankingWords, shortlist, type Shortlisted } from '../../app/borrow-policy'
import { Button, Disclosure, FlowTop, IconButton, KV, P, Problem, Screen, Sheet, Tag, Working, Offline } from '../kit'
import { isConnectionError } from '../errors'
import { useNav } from '../nav'
import { C, F, t } from '../theme'
import { btc, partyName, pctText, usd, usdNum } from '../format'
import { debtOf } from '../../../../../src/core/terms.js'

export function Offers({ params }: { params: Record<string, unknown> }) {
  const s = useApp()
  const nav = useNav()
  const principal = Number(params.principal)
  const termBlocks = Number(params.termBlocks)
  const book = useRelayOffers()
  const view = usePassbookView()
  const policy = s.borrowerState.policy
  const [info, setInfo] = useState(false)
  const [words, setWords] = useState<string | null>(null)
  const list = useMemo(() => policy && view.data && book.data
    ? shortlist(book.data.filter((o) => o.payload.term_blocks === termBlocks), policy, { price_cents: view.data.priceCents, step: view.data.ladder.step, allowed_ltv_bps: view.data.ladder.allowed_ltv_bps, own_pk: s.key.pubkey })
    : null, [policy, view.data, book.data, termBlocks, s.key.pubkey])
  const ranked = list?.ranked ?? []
  useEffect(() => { if (ranked.length) void rankingWords(ranked).then(setWords).catch(() => setWords(null)); else setWords(null) }, [ranked.map((r) => r.offer.id).join()])

  const start = (r: Shortlisted) => { s.borrow.negotiate(r.offer, principal); nav.push('borrow') }
  if (!policy) {
    return <Screen top={<FlowTop title="Choose a lender" onBack={nav.pop} />}><P muted>Sign your borrowing rules first.</P><Button kind="secondary" label="Set your rules" onPress={() => nav.push('rules', { principal, termBlocks })} /></Screen>
  }
  return (
    <Screen top={<FlowTop title="Choose a lender" onBack={nav.pop} right={<IconButton name="info" label="Where offers come from" onPress={() => setInfo(true)} side="right" />} />} gap={20}
      bottom={ranked[0]?.withinPolicy ? <Button label={`Negotiate with ${partyName('Lender', ranked[0].offer.lender_pk)}`} disabled={!!s.borrow.value.working} onPress={() => start(ranked[0])} /> : <Button kind="ghost" label="See the whole market" onPress={() => nav.go('market')} />}>
      <Text style={t.sub}>{usdNum(principal).replace(/\.00$/, '')} test USDT · {termBlocks} blocks · at most {pctText(policy.max_apr_bps)} · {ranked.length} offer{ranked.length === 1 ? '' : 's'}</Text>
      {words ? <P small>{words}</P> : null}
      {ranked.map((r, i) => (
        <Pressable key={r.offer.id} accessibilityRole="button" accessibilityLabel={`Negotiate with ${partyName('Lender', r.offer.lender_pk)}`}
          onPress={() => start(r)} style={({ pressed }) => [st.card, i === 0 && r.withinPolicy ? st.best : null, pressed ? { opacity: 0.7 } : null]}>
          <View style={st.head}>
            <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 16 }]}>{partyName('Lender', r.offer.lender_pk)}</Text>
            {i === 0 && r.withinPolicy && ranked.length > 1 ? <Tag label="LOWEST COST" /> : r.withinPolicy ? <Text style={t.small}>{pctText(r.offer.payload.apr_bps)} a year</Text> : <Tag label="ABOVE YOUR APR" tone="amber" />}
          </View>
          <View style={st.pay}>
            <Text style={[t.small, { fontSize: 14 }]}>You pay back at most</Text>
            <Text style={[t.mid, { fontSize: 22 }]}>{usdNum(debtOf({ principal: r.summary.position.principal, fee: r.summary.fee }))}</Text>
          </View>
          <Text style={[t.small, { fontSize: 14 }]}>Locks {btc(r.summary.collateral_sats)} · {pctText(r.summary.position.ltv_bps)} of its value</Text>
          {r.why ? <Text style={[t.small, { fontSize: 13, color: C.muted }]}>{r.why}</Text> : null}
        </Pressable>
      ))}
      {list && !ranked.length ? <P muted>No offer on the relay fits your rules for {usd(principal)} over {termBlocks} blocks right now.</P> : null}
      {list?.left.length ? (
        <Disclosure label={`Left out (${list.left.length})`}>
          {list.left.map((l) => <KV key={l.offer.id} k={partyName('Lender', l.offer.lender_pk)} v={l.why} />)}
        </Disclosure>
      ) : null}
      <Working label={(book.loading && !book.data) || (view.loading && !view.data) ? 'Reading the relay' : null} />
      <Offline error={book.error ?? view.error} busy={book.loading || view.loading} onRetry={() => { void book.reload(); void view.reload() }} />
      <Problem>{[book.error, view.error].find((e) => e && !isConnectionError(e)) ?? null}</Problem>
      <Sheet visible={info} onClose={() => setInfo(false)} title="Where offers come from">
        <P>Independent lenders sign offers and post them to a Nostr relay. Your phone reads them there and checks every signature itself.</P>
        <P>They are ranked by what you pay back, then by how much bitcoin they lock. Your agent negotiates inside the rules you signed, and you approve before anything is shared or locked.</P>
      </Sheet>
    </Screen>
  )
}

const st = StyleSheet.create({
  card: { borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 16, gap: 8 },
  best: { borderWidth: 2, borderColor: C.ink },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pay: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
})
