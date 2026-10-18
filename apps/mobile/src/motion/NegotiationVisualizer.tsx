// The negotiation as it happens: your agent and the lender as two avatars over the relay,
// each signed message flying from its sender to the other side as it arrives, the APR each
// side put on the table converging on a chart, and the end: a deal at the agreed rate, or no
// deal with its reason. Everything comes from the signed transcript passed in (the borrow
// flow's `transcript`, or NegotiationResult.messages); a card appears only for a message
// that exists. With reduce motion the cards and the end state appear without travel.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Circle, Line, Polyline } from 'react-native-svg'
import type { NegotiationMessage } from '../../../../src/market/negotiate-engine.js'
import { C, F, R, t } from '../ui/theme'
import { BrandIcon } from '../brand/icons'
import { useReducedMotion } from './reduce-motion'
import { aprText, cardWords, negotiationPicture, type MessageCard, type NegotiationPicture, type Side } from './negotiation-model'

export interface NegotiationVisualizerProps {
  /** the signed messages so far, sent and received (any order; duplicates are shown once) */
  messages: readonly NegotiationMessage[]
  /** this phone's key: its messages are "Your agent" */
  borrowerPk: string
  /** how the lender is named on screen ("Lender 3f9a1c") */
  lenderLabel: string
  /** verifyTranscript(...).ok on this phone, when the flow checked it; omitted says nothing */
  verified?: boolean
  /** the no-deal screen's words for the reason (M7's noDealWords); the raw code otherwise */
  noDeal?: { title: string; sub: string }
  /** the list of message cards under the picture (default on) */
  cards?: boolean
}

const AVATAR = 52
const FLY_MS = 640

export function NegotiationVisualizer({ messages, borrowerPk, lenderLabel, verified, noDeal, cards = true }: NegotiationVisualizerProps) {
  const pic = useMemo(() => negotiationPicture(messages, borrowerPk), [messages, borrowerPk])
  const still = useReducedMotion()
  const [lane, setLane] = useState(0)
  const fly = useRef(new Animated.Value(0)).current
  const end = useRef(new Animated.Value(pic.end.kind === 'open' ? 0 : 1)).current
  const [flying, setFlying] = useState<{ card: MessageCard; n: number } | null>(null)
  const seen = useRef(pic.cards.length)

  // a new signed message: it travels from its sender to the other side
  useEffect(() => {
    const n = pic.cards.length
    if (n > seen.current && still === false) setFlying({ card: pic.cards[n - 1], n })
    seen.current = n
  }, [pic.cards.length]) // eslint-disable-line react-hooks/exhaustive-deps
  // started once the flying card is on screen (an animation started before its view mounts never moves it)
  useEffect(() => {
    if (!flying) return
    fly.setValue(0)
    const a = Animated.timing(fly, { toValue: 1, duration: FLY_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true })
    a.start(({ finished }) => { if (finished) setFlying(null) })
    return () => a.stop()
  }, [flying]) // eslint-disable-line react-hooks/exhaustive-deps

  // the end: the avatars come together on a deal; the end badge appears either way
  useEffect(() => {
    if (pic.end.kind === 'open') { end.setValue(0); return }
    if (still === null) return
    if (still) { end.setValue(1); return }
    const a = Animated.timing(end, { toValue: 1, duration: 520, delay: FLY_MS, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true })
    a.start()
    return () => a.stop()
  }, [pic.end.kind, still]) // eslint-disable-line react-hooks/exhaustive-deps

  const span = Math.max(0, lane - AVATAR)
  // a deal brings the two together; no deal leaves them where they are, the wire broken in the warning colour
  const inward = pic.end.kind === 'accept' ? span * 0.18 : 0
  const youX = end.interpolate({ inputRange: [0, 1], outputRange: [0, inward] })
  const lenderX = end.interpolate({ inputRange: [0, 1], outputRange: [0, -inward] })
  const from = flying?.card.from === 'you' ? 0 : span, to = flying?.card.from === 'you' ? span : 0
  const flyX = fly.interpolate({ inputRange: [0, 1], outputRange: [from, to] })
  const flyY = fly.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -18, 0] })
  const flyOpacity = fly.interpolate({ inputRange: [0, 0.1, 0.85, 1], outputRange: [0, 1, 1, 0] })
  const lineColor = pic.end.kind === 'no_deal' ? C.warn : pic.end.kind === 'accept' ? C.green : C.track

  const summary = pic.end.kind === 'accept'
    ? `Deal at ${aprText(pic.end.position.apr_bps)} APR after ${pic.cards.length} signed messages`
    : pic.end.kind === 'no_deal' ? `No deal: ${noDeal?.title ?? pic.end.reason}` : `Negotiating with ${lenderLabel}: ${pic.cards.length} signed messages so far`

  return (
    <View style={{ gap: 18 }} accessible={false}>
      <View accessible accessibilityLabel={summary} accessibilityLiveRegion="polite" onLayout={(e: LayoutChangeEvent) => setLane(e.nativeEvent.layout.width)} style={s.stage}>
        <View style={[s.wire, { left: AVATAR / 2, right: AVATAR / 2, borderColor: lineColor, borderStyle: pic.end.kind === 'accept' ? 'solid' : 'dashed' }]} />
        <View style={s.relay}><BrandIcon name="relay" size={16} color={C.muted} /><Text style={s.relayText}>Nostr</Text></View>
        <Animated.View style={[s.party, { left: 0, transform: [{ translateX: youX }] }]}>
          <Avatar side="you" />
          <Text style={s.who}>Your agent</Text>
        </Animated.View>
        <Animated.View style={[s.party, { right: 0, transform: [{ translateX: lenderX }] }]}>
          <Avatar side="lender" />
          <Text style={s.who} numberOfLines={1}>{lenderLabel}</Text>
        </Animated.View>
        {flying && lane ? (
          <Animated.View pointerEvents="none" style={[s.flyer, { opacity: flyOpacity, transform: [{ translateX: flyX }, { translateY: flyY }] }]}>
            <Text style={s.flyType}>{flying.card.type}</Text>
            {flying.card.position ? <Text style={s.flyApr}>{aprText(flying.card.position.apr_bps)}</Text> : null}
          </Animated.View>
        ) : null}
        {pic.end.kind !== 'open' ? (
          <Animated.View style={[s.endBadge, { opacity: end, transform: [{ scale: end.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }, pic.end.kind === 'accept' ? s.endDeal : s.endNo]}>
            <BrandIcon name={pic.end.kind === 'accept' ? 'deal' : 'nodeal'} size={22} color={C.white} />
          </Animated.View>
        ) : null}
      </View>

      <AprChart pic={pic} width={lane} />

      <End pic={pic} noDeal={noDeal} verified={verified} count={pic.cards.length} />

      {cards ? <View style={{ gap: 10 }}>{pic.cards.map((c) => <Card key={c.key} c={c} lenderLabel={lenderLabel} still={still} />)}</View> : null}
      {pic.problems.length ? <Text style={s.problem}>{pic.problems.join('; ')}</Text> : null}
    </View>
  )
}

function Avatar({ side }: { side: Side }) {
  return (
    <View style={[s.avatar, side === 'you' ? { backgroundColor: C.ink } : { backgroundColor: C.greenBg }]}>
      <BrandIcon name={side === 'you' ? 'agent' : 'lender'} size={26} color={side === 'you' ? C.white : C.green} />
    </View>
  )
}

/** Each side's APR, move by move: your agent in ink, the lender in green, meeting at the deal. */
function AprChart({ pic, width }: { pic: NegotiationPicture; width: number }) {
  const H = 112, padX = 14, padY = 12
  const seqs = [...new Set([...pic.aprs.you, ...pic.aprs.lender].map((p) => p.seq).concat(pic.end.kind === 'accept' ? [pic.end.seq] : []))].sort((a, b) => a - b)
  if (!width || seqs.length < 1) return null
  const x = (seq: number) => padX + (seqs.length === 1 ? (width - padX * 2) / 2 : (seqs.indexOf(seq) / (seqs.length - 1)) * (width - padX * 2))
  const y = (apr: number) => padY + (1 - (apr - pic.range.min) / Math.max(1, pic.range.max - pic.range.min)) * (H - padY * 2)
  const line = (side: Side) => {
    const pts = pic.aprs[side].map((p) => ({ x: x(p.seq), y: y(p.apr_bps) }))
    if (pic.end.kind === 'accept') pts.push({ x: x(pic.end.seq), y: y(pic.end.position.apr_bps) })
    return pts
  }
  const you = line('you'), lender = line('lender')
  const gap = pic.gap !== null ? aprText(pic.gap) : null
  return (
    <View style={s.chart} accessible accessibilityLabel={`APR by move: yours ${pic.aprs.you.map((p) => aprText(p.apr_bps)).join(', ') || 'none yet'}; the lender's ${pic.aprs.lender.map((p) => aprText(p.apr_bps)).join(', ') || 'none yet'}${gap ? `; gap now ${gap}` : ''}`}>
      <View style={s.chartHead}>
        <Text style={t.small}>APR, move by move</Text>
        <Text style={[t.small, { color: C.ink, fontFamily: F.semibold }]}>{pic.end.kind === 'accept' ? `met at ${aprText(pic.end.position.apr_bps)}` : gap ? `${gap} apart` : ''}</Text>
      </View>
      <Svg width={width} height={H}>
        {[0.25, 0.5, 0.75].map((f) => <Line key={f} x1={padX} x2={width - padX} y1={padY + f * (H - padY * 2)} y2={padY + f * (H - padY * 2)} stroke={C.divider} strokeWidth={1} />)}
        {you.length > 1 ? <Polyline points={you.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={C.ink} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {lender.length > 1 ? <Polyline points={lender.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={C.green} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {you.map((p, i) => <Circle key={`y${i}`} cx={p.x} cy={p.y} r={4} fill={C.white} stroke={C.ink} strokeWidth={2.5} />)}
        {lender.map((p, i) => <Circle key={`l${i}`} cx={p.x} cy={p.y} r={4} fill={C.white} stroke={C.green} strokeWidth={2.5} />)}
      </Svg>
      <View style={s.legend}>
        <View style={s.key}><View style={[s.swatch, { backgroundColor: C.ink }]} /><Text style={t.tiny}>Your agent</Text></View>
        <View style={s.key}><View style={[s.swatch, { backgroundColor: C.green }]} /><Text style={t.tiny}>Lender</Text></View>
      </View>
    </View>
  )
}

function End({ pic, noDeal, verified, count }: { pic: NegotiationPicture; noDeal?: { title: string; sub: string }; verified?: boolean; count: number }) {
  const proof = `${count} signed message${count === 1 ? '' : 's'}, hash-chained${verified === true ? ', verified on this phone' : verified === false ? ', DID NOT VERIFY on this phone' : ''}`
  if (pic.end.kind === 'accept') {
    const p = pic.end.position
    return (
      <View style={[s.end, { backgroundColor: C.greenBg }]}>
        <Text style={[t.small, { color: C.green, fontFamily: F.semibold }]}>DEAL · accepted by {pic.end.by === 'you' ? 'your agent' : 'the lender'}</Text>
        <Text style={[t.mid, { color: C.ink }]}>{aprText(p.apr_bps)} APR</Text>
        <Text style={t.sub}>{aprText(p.ltv_bps)} of your bitcoin · {p.term_blocks} blocks</Text>
        <Text style={[t.tiny, { color: verified === false ? C.warn : C.muted }]}>{proof}</Text>
      </View>
    )
  }
  if (pic.end.kind === 'no_deal') {
    return (
      <View style={[s.end, { backgroundColor: C.warnBg }]} accessibilityRole="alert">
        <Text style={[t.small, { color: C.warn, fontFamily: F.semibold }]}>NO DEAL · ended by {pic.end.by === 'you' ? 'your agent' : 'the lender'}</Text>
        <Text style={[t.h2, { color: C.warn }]}>{noDeal?.title ?? 'No deal'}</Text>
        <Text style={[t.body, { color: C.warn }]}>{noDeal?.sub ?? `Reason: ${pic.end.reason}`}</Text>
        <Text style={[t.tiny, { color: C.warn }]}>{proof}</Text>
      </View>
    )
  }
  return <Text style={[t.small, { textAlign: 'center' }]}>{proof}</Text>
}

function Card({ c, lenderLabel, still }: { c: MessageCard; lenderLabel: string; still: boolean | null }) {
  const a = useRef(new Animated.Value(0)).current
  const shown = useRef(false)
  // in once, when the reduce-motion setting is known: at once with it on, sliding in with it off
  useEffect(() => {
    if (still === null || shown.current) return
    shown.current = true
    if (still) { a.setValue(1); return }
    Animated.timing(a, { toValue: 1, duration: 280, delay: FLY_MS - 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()
  }, [still]) // eslint-disable-line react-hooks/exhaustive-deps
  const mine = c.from === 'you'
  const tone = c.type === 'ACCEPT' ? C.green : c.type === 'NO_DEAL' ? C.warn : C.muted
  return (
    <Animated.View style={[s.card, mine ? s.mine : s.theirs, { opacity: a, transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [mine ? -14 : 14, 0] }) }] }]}>
      <View style={s.cardHead}>
        <Text style={[t.small, { color: C.ink, fontFamily: F.semibold }]}>{mine ? 'Your agent' : lenderLabel}</Text>
        <Text style={[s.type, { color: tone }]}>{c.type} · #{c.seq}</Text>
      </View>
      <Text style={t.body}>{cardWords(c)}</Text>
      <Text style={s.sig}>signed {c.sig}{c.chained ? ' · chained' : ''}</Text>
    </Animated.View>
  )
}

const s = StyleSheet.create({
  stage: { height: AVATAR + 30, justifyContent: 'flex-start' },
  wire: { position: 'absolute', top: AVATAR / 2, height: 0, borderTopWidth: 2 },
  relay: { position: 'absolute', top: AVATAR / 2 - 13, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bg, paddingHorizontal: 8, height: 26 },
  relayText: { fontFamily: F.medium, fontSize: 11, color: C.muted },
  party: { position: 'absolute', top: 0, alignItems: 'center', width: AVATAR + 40, marginHorizontal: -20 },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, alignItems: 'center', justifyContent: 'center' },
  who: { fontFamily: F.medium, fontSize: 12, color: C.ink, marginTop: 6 },
  flyer: { position: 'absolute', top: AVATAR / 2 - 17, left: 0, width: AVATAR, height: 34, borderRadius: 10, backgroundColor: C.white, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', elevation: 3, shadowColor: C.ink, shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  flyType: { fontFamily: F.bold, fontSize: 8, letterSpacing: 0.4, color: C.muted },
  flyApr: { fontFamily: F.semibold, fontSize: 11, color: C.ink },
  endBadge: { position: 'absolute', top: AVATAR / 2 - 18, alignSelf: 'center', width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  endDeal: { backgroundColor: C.green },
  endNo: { backgroundColor: C.warn },
  chart: { borderRadius: R.button, backgroundColor: C.surface, paddingVertical: 12, gap: 4, overflow: 'hidden' },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14 },
  legend: { flexDirection: 'row', gap: 16, paddingHorizontal: 14 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 3, borderRadius: 2 },
  end: { borderRadius: R.button, padding: 16, gap: 4 },
  card: { borderRadius: 14, padding: 12, gap: 4, maxWidth: '88%' },
  mine: { alignSelf: 'flex-start', backgroundColor: C.surface },
  theirs: { alignSelf: 'flex-end', backgroundColor: C.greenBg },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  type: { fontFamily: F.semibold, fontSize: 11, letterSpacing: 0.3 },
  sig: { fontFamily: F.mono, fontSize: 11, color: C.muted },
  problem: { ...t.small, color: C.warn },
})
