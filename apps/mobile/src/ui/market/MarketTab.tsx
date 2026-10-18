// Canvas 22: the whole peer-to-peer order book. Lender offers (from the platform's book,
// which follows the relay), split into those that fit this wallet now and those that don't
// yet; and borrower requests, read straight from the relay (kind 38389), where the person
// can post their own. Posting asks for nothing from anyone: lenders may come to it.
import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Event } from 'nostr-tools'
import { collateralFor, MICRO_PER_USDT } from '../../../../../src/core/money.js'
import { KIND } from '../../../../../src/market/kinds.js'
import type { RequestPayload } from '../../../../../src/market/messages.js'
import { useApp } from '../../app/session'
import { useStore } from '../../app/store'
import { usePassbookView, viewOffers, type OfferView } from '../../app/views'
import { useRelayOffers } from '../../app/offerbook'
import { Button, Chip, IconButton, KV, P, Problem, Rows, Screen, Segmented, Sheet, TabBar, TabTop, Tag, Working, Offline } from '../kit'
import { isConnectionError } from '../errors'
import { useNav, useTabSwitch } from '../nav'
import { C, F, t } from '../theme'
import { btc, partyName, pctText, usd, usdNum } from '../format'

const REQUEST_D = 'passbook-request'

export function useRequests() {
  const s = useApp()
  const [list, setList] = useState<{ payload: RequestPayload; event: Event }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try { setList(await s.relay.list<RequestPayload>(KIND.REQUEST)); setError(null) } catch (e) { setError((e as Error).message) }
  }, [s])
  useEffect(() => { void load(); const timer = setInterval(load, 20_000); return () => clearInterval(timer) }, [load])
  return { list, error, reload: load }
}

const ago = (sec: number) => {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec)
  return d < 90 ? 'just now' : d < 5400 ? `${Math.round(d / 60)} min ago` : d < 129600 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} days ago`
}

export function MarketTab() {
  const s = useApp()
  const nav = useNav()
  const onTab = useTabSwitch()
  const flow = useStore(s.borrow.store)
  const book = useRelayOffers()
  const view = usePassbookView()
  const requests = useRequests()
  const [side, setSide] = useState<'offers' | 'requests'>('offers')
  const [sheet, setSheet] = useState<'info' | 'post' | null>(null)
  const [open, setOpen] = useState<OfferView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const limit = view.data?.borrowable ?? 0
  // the amount the person is borrowing now, else 100 test USDT (or less, within their limit)
  const principal = flow.principal ?? (limit > 0 ? Math.min(limit, 100 * MICRO_PER_USDT) : 100 * MICRO_PER_USDT)
  const term = flow.offer?.payload.term_blocks ?? book.data?.[0]?.payload.term_blocks ?? 30
  const offers = viewOffers(book.data ?? [], principal, limit, s.key.pubkey)
  const ownOffer = (book.data ?? []).find((o) => o.lender_pk === s.key.pubkey)
  const fit = offers.filter((o) => o.fits)
  const later = offers.filter((o) => !o.fits)
  const mine = requests.list?.find((r) => r.event.pubkey === s.key.pubkey)
  const others = (requests.list ?? []).filter((r) => r.event.pubkey !== s.key.pubkey)
  const asset = book.data?.[0]?.payload.asset_id

  const post = async (withdraw: boolean) => {
    if (!asset) return setProblem('No market asset yet: no lender has posted an offer.')
    setProblem(null); setBusy(withdraw ? 'Withdrawing' : 'Posting')
    try {
      const payload: RequestPayload = { asset_id: asset, principal: principal, term_blocks: term }
      const tags = [['d', REQUEST_D], ['step', String(view.data?.ladder.step ?? 0)], ...(withdraw ? [['expiration', String(Math.floor(Date.now() / 1000))]] : [])]
      await s.relay.publishPublic(KIND.REQUEST, payload, tags)
      setSheet(null)
      setSide('requests')
      await requests.reload()
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <Screen top={<TabTop title="Market" right={<IconButton name="info" label="How the market works" onPress={() => setSheet('info')} side="right" />} />} gap={16} bottom={<>
      {side === 'requests'
        ? <Button kind={mine ? 'outline' : 'primary'} label={mine ? 'Withdraw my request' : 'Post a request'} busy={!!busy} onPress={() => (mine ? void post(true) : setSheet('post'))} />
        : null}
      <TabBar tab="market" onTab={onTab} />
    </>}>
      <Segmented label="Side of the book" value={side} onChange={setSide} options={[{ id: 'offers', label: `Offers · ${offers.length}` }, { id: 'requests', label: `Requests · ${requests.list?.length ?? 0}` }]} />
      {side === 'offers' ? (
        <View style={{ gap: 4 }}>
          <Text style={t.small}>{book.book ? `From the relay · ${book.book.offers.length} signed offer${book.book.offers.length === 1 ? '' : 's'} verified on this phone` : 'Reading the relay'}</Text>
          <Chip label={`${usdNum(principal).replace(/\.00$/, '')} test USDT · ${term} blocks`} icon="edit" onPress={() => nav.go('passbook', 'borrow-amount')} />
          {ownOffer ? (
            <View style={[st.row, { paddingTop: 8 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 16 }]}>Your offer</Text>
                <Text style={t.small}>{usdNum(ownOffer.payload.min).replace(/\.00$/, '')}–{usdNum(ownOffer.payload.max).replace(/\.00$/, '')} · {ownOffer.payload.term_blocks} blocks · {pctText(ownOffer.payload.apr_bps)}</Text>
              </View>
              <Tag label="YOURS" />
            </View>
          ) : null}
          <Text style={[t.small, { paddingTop: 12, paddingBottom: 4 }]}>Fit you · {fit.length}</Text>
          {fit.map((o) => <OfferRow key={o.offer.id} o={o} onPress={() => setOpen(o)} />)}
          <Text style={[t.small, { paddingTop: 16, paddingBottom: 4 }]}>Not yet · {later.length}</Text>
          {later.map((o) => <OfferRow key={o.offer.id} o={o} dim onPress={() => setOpen(o)} />)}
          {book.book && !book.book.offers.length ? <P muted>No lender has a current offer on the relay. Offers appear here as lenders sign them; the list refreshes by itself.</P> : null}
          {book.book && book.book.rejected ? <Text style={[t.small, { paddingTop: 8 }]}>{book.book.rejected} event{book.book.rejected === 1 ? '' : 's'} left out: bad signature, malformed or expired</Text> : null}
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          <Text style={[t.small, { paddingVertical: 4 }]}>Borrowers asking now</Text>
          <Rows>
            {mine ? <ReqRow r={mine} yours /> : null}
            {others.map((r) => <ReqRow key={r.event.id} r={r} />)}
          </Rows>
          {requests.list && !requests.list.length ? <P muted>No requests on the relay right now.</P> : null}
        </View>
      )}
      <Working label={(book.loading && !book.data) || (side === 'requests' && !requests.list) ? 'Reading the market' : busy} />
      <Offline error={book.error ?? (side === 'requests' ? requests.error : null)} busy={book.loading} onRetry={() => { void book.reload(); void requests.reload() }} />
      <Problem>{problem ?? [book.error, side === 'requests' ? requests.error : null].find((e) => e && !isConnectionError(e)) ?? null}</Problem>

      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open ? partyName('Lender', open.offer.lender_pk) : ''} cta={null}>
        {open ? <>
          <View>
            <Text style={[t.big, { fontSize: 36, lineHeight: 42 }]}>{usdNum(open.payBack)} <Text style={[t.sub, { fontSize: 18 }]}>test USDT</Text></Text>
            <Text style={t.sub}>you pay back on {usdNum(principal)}</Text>
          </View>
          <KV k="Lends" v={`${usdNum(open.offer.payload.min).replace(/\.00$/, '')}–${usdNum(open.offer.payload.max).replace(/\.00$/, '')} test USDT`} />
          <KV k="Bitcoin locked" v={view.data ? btc(collateralFor(open.payBack, view.data.ladder.allowed_ltv_bps, view.data.priceCents)) : '…'} />
          <KV k="Asks to see" v={open.needsIncome ? `${open.offer.payload.requirements.inflow_months} months of signed salary records` : open.offer.payload.requirements.inflow_months > 0 ? `Your passbook, and ${open.offer.payload.requirements.inflow_months} months of income through a credit check it pays for` : 'Your passbook only'} />
          <KV k="Offer ends" v={`at block ${open.offer.payload.expires_height}`} />
          <KV k="Signed by" v={`${open.offer.lender_pk.slice(0, 12)}…, checked on this phone`} />
          <KV k="Platform lists it" v={(open.offer as { listed?: boolean | null }).listed === null ? "couldn't ask" : (open.offer as { listed?: boolean | null }).listed ? 'yes' : 'no (an overdue fee, or not seen yet)'} />
          {open.fits
            ? <Button label={`Borrow from ${partyName('Lender', open.offer.lender_pk)}`} onPress={() => { const o = open; setOpen(null); nav.go('passbook', 'rules', { principal, termBlocks: o.offer.payload.term_blocks }) }} />
            : <Text style={st.why}>{open.why}</Text>}
          <Button kind="ghost" label="Close" onPress={() => setOpen(null)} />
        </> : null}
      </Sheet>
      <Sheet visible={sheet === 'post'} onClose={() => setSheet(null)} title="Ask lenders to come to you" cta="Post request" onCta={() => void post(false)}>
        <Text style={[t.mid, { fontSize: 28 }]}>{usd(principal)} · {term} blocks</Text>
        <P muted>Lenders see the amount, the term and your step. Nothing else.</P>
      </Sheet>
      <Sheet visible={sheet === 'info'} onClose={() => setSheet(null)} title="How the market works">
        <P>Independent lenders post offers. Borrowers can post requests. Anyone can read both.</P>
        <P>Your step on the ladder decides which offers fit you. Each loan you repay unlocks more.</P>
        <P>You can lend too: the Lend tab posts your own offer from this wallet.</P>
        <P>PassBook never lends and never holds your bitcoin alone.</P>
      </Sheet>
    </Screen>
  )
}

function OfferRow({ o, dim, onPress }: { o: OfferView; dim?: boolean; onPress: () => void }) {
  const p = o.offer.payload
  const color = dim ? C.faint : C.ink
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [st.row, pressed ? { opacity: 0.7 } : null]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 16, color }]}>{partyName('Lender', o.offer.lender_pk)}</Text>
        <Text style={[t.small, dim ? { color: C.faint } : null]}>{o.why ?? `${usdNum(p.min).replace(/\.00$/, '')}–${usdNum(p.max).replace(/\.00$/, '')} · ${p.term_blocks} blocks · ${o.needsIncome ? 'salary' : 'passbook only'}`}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[t.mid, { fontSize: 20, color }]}>{pctText(p.apr_bps)}</Text>
        <Text style={[t.tiny, dim ? { color: C.faint } : null]}>a year</Text>
      </View>
    </Pressable>
  )
}

function ReqRow({ r, yours }: { r: { payload: RequestPayload; event: Event }; yours?: boolean }) {
  const step = r.event.tags.find((x) => x[0] === 'step')?.[1]
  return (
    <View style={st.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 16 }]}>{usdNum(r.payload.principal).replace(/\.00$/, '')} test USDT · {r.payload.term_blocks} blocks</Text>
        <Text style={t.small}>{step !== undefined ? `Step ${step} · ` : ''}{ago(r.event.created_at)}</Text>
      </View>
      {yours ? <Tag label="YOURS" /> : null}
    </View>
  )
}

const st = StyleSheet.create({
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: C.divider },
  why: { ...t.body, color: C.warn, backgroundColor: C.warnBg, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, overflow: 'hidden' },
})
