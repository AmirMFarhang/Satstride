// The moment a page closes (a loan released): the open leaf of the passbook turns over, the
// seal drops onto the page and lands with one short buzz, and the page says what was stamped:
// its number, the closing transaction on Bitcoin named for what it was (the release for a
// paid page; short on the seal, whole for the screen reader) and the ladder step it earned.
// It plays only from a real txid (stampWords returns null otherwise and nothing is drawn).
// It waits until the reduce-motion setting is known; with reduce motion it shows the stamped
// page at once and the buzz still marks the moment. Interrupted, it shows the end state.
import React, { useEffect, useMemo, useRef } from 'react'
import { Animated, Easing, StyleSheet, Text, Vibration, View } from 'react-native'
import Svg, { Circle, Defs, Path, Text as SvgText, TextPath } from 'react-native-svg'
import { C, F, R, t } from '../ui/theme'
import { useReducedMotion } from './reduce-motion'
import { motionPlan } from './motion-plan'
import { STAMP_BUZZ_MS, STAMP_TIMING, stampWords, type StampInput } from './stamp-model'

export interface PageStampedProps extends StampInput {
  /** what the page records, already formatted ("100.00 test USDT", "from Lender 3f9a1c") */
  amount?: string
  counterparty?: string
  /** "blocks 309–339" or similar, from the page */
  blocks?: string
  /** start the moment; false holds the open leaf (e.g. until the screen is focused) */
  play?: boolean
  /** after the words settle */
  onDone?: () => void
  /** a node under the page (the copy-the-txid row, the Borrow again button) */
  children?: React.ReactNode
  /** leave out the ladder strip and its line, for a screen that already shows the canvas's "Limit now" note */
  compact?: boolean
}

export function PageStamped(p: PageStampedProps) {
  const w = useMemo(() => stampWords(p), [p.pageNo, p.closeTxid, p.ladderStep, p.ladderSteps, p.limitBps, p.outcome]) // eslint-disable-line react-hooks/exhaustive-deps
  const still = useReducedMotion()
  const turn = useRef(new Animated.Value(0)).current
  const drop = useRef(new Animated.Value(0)).current
  const press = useRef(new Animated.Value(0)).current
  const ripple = useRef(new Animated.Value(0)).current
  const words = useRef(new Animated.Value(0)).current
  const fill = useRef(new Animated.Value(0)).current
  const played = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    if (!w || p.play === false) return
    // nothing plays, and nothing is marked played, until the reduce-motion setting is known
    const plan = motionPlan(still, played.current === p.closeTxid)
    if (plan === 'wait' || plan === 'skip') return
    played.current = p.closeTxid
    const land = () => {
      if (w.buzz) Vibration.vibrate(STAMP_BUZZ_MS)
    }
    const end = () => {
      for (const v of [turn, drop, words, ripple]) v.setValue(1)
      press.setValue(0)
      fill.setValue(w.stepsFilled)
    }
    if (plan === 'jump') {
      end()
      land()
      p.onDone?.()
      return
    }
    let landed = false
    const anim = Animated.sequence([
      Animated.timing(turn, { toValue: 1, duration: STAMP_TIMING.turn, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.delay(STAMP_TIMING.hold),
      Animated.timing(drop, { toValue: 1, duration: STAMP_TIMING.drop, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
    ])
    anim.start(({ finished }) => {
      if (!finished) return
      landed = true
      land()
      Animated.parallel([
        Animated.sequence([
          Animated.timing(press, { toValue: 1, duration: 70, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.spring(press, { toValue: 0, friction: 4, tension: 160, useNativeDriver: true }),
        ]),
        Animated.timing(ripple, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(words, { toValue: 1, duration: STAMP_TIMING.settle, delay: 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(fill, { toValue: w.stepsFilled, duration: 380 * w.stepsFilled, delay: 260, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      ]).start(() => p.onDone?.())
    })
    // interrupted before the seal landed (reduce motion switched on, play turned off): never
    // leave a half-turned page; show the stamped page and finish the moment
    return () => {
      anim.stop()
      if (landed) return
      end()
      if (mounted.current) p.onDone?.()
    }
  }, [w, p.play, still]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!w) return null

  const leafRotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-180deg'] })
  const leafShade = turn.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.18, 0] })
  const sealScale = drop.interpolate({ inputRange: [0, 1], outputRange: [2.4, 1] })
  const sealRotate = drop.interpolate({ inputRange: [0, 1], outputRange: ['-22deg', '-8deg'] })
  const pageScale = press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.982] })
  const rippleScale = ripple.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.7] })
  const rippleOpacity = ripple.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.45, 0] })
  const wordsY = words.interpolate({ inputRange: [0, 1], outputRange: [10, 0] })

  return (
    <View accessible accessibilityRole="summary" accessibilityLabel={w.a11y} accessibilityLiveRegion="polite" style={{ gap: 20 }}>
      <View style={s.book}>
        <Animated.View style={[s.page, { transform: [{ scale: pageScale }] }]}>
          <View style={s.pageHead}>
            <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>Page {p.pageNo}</Text>
            {p.blocks ? <Text style={t.small}>{p.blocks}</Text> : null}
          </View>
          {p.amount ? <Text style={[t.mid, { fontSize: 28 }]} numberOfLines={1} adjustsFontSizeToFit>{p.amount}</Text> : null}
          {p.counterparty ? <Text style={t.sub}>{p.counterparty}</Text> : null}
          <View style={s.rules}>{[0, 1, 2, 3].map((i) => <View key={i} style={s.rule} />)}</View>
          <View style={s.sealSlot} pointerEvents="none">
            <Animated.View style={[s.ripple, { borderColor: TONE[w.tone], opacity: rippleOpacity, transform: [{ scale: rippleScale }] }]} />
            <Animated.View style={{ opacity: drop, transform: [{ scale: sealScale }, { rotate: sealRotate }] }}>
              <Seal ring={w.ring} tx={w.txShort} size={132} color={TONE[w.tone]} glyph={w.glyph} />
            </Animated.View>
          </View>
        </Animated.View>
        {/* the open leaf, turning over on the spine to show the page */}
        <Animated.View style={[s.leaf, { transform: [{ perspective: 1200 }, { rotateY: leafRotate }] }]} pointerEvents="none">
          <View style={s.pageHead}>
            <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>Page {p.pageNo}</Text>
            <Text style={s.openTag}>OPEN</Text>
          </View>
          {p.amount ? <Text style={[t.mid, { fontSize: 28 }]} numberOfLines={1} adjustsFontSizeToFit>{p.amount}</Text> : null}
          <View style={s.rules}>{[0, 1, 2, 3].map((i) => <View key={i} style={s.rule} />)}</View>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.ink, opacity: leafShade, borderRadius: R.card }]} />
        </Animated.View>
        <View style={s.spine} />
      </View>

      <Animated.View style={{ opacity: words, transform: [{ translateY: wordsY }], gap: 12, alignItems: 'center' }}>
        <Text style={[t.h2, { fontSize: 24, lineHeight: 30 }]}>{w.title}</Text>
        {p.compact ? null : <LadderFill steps={p.ladderSteps} fill={fill} />}
        {p.compact ? null : <Text style={t.sub}>{w.ladder}</Text>}
        <Text style={[t.mono, { color: C.muted }]}>{w.txWord} {w.txShort} on Bitcoin</Text>
      </Animated.View>
      {p.children}
    </View>
  )
}

const TONE: Record<'green' | 'amber' | 'warn' | 'muted', string> = { green: C.green, amber: C.amber, warn: C.warn, muted: C.muted }

/** The seal: an outer ring, the words around it, a disc with a check (paid) or a bar (not paid) and the closing transaction's short id. */
export function Seal({ ring, tx, size = 120, color = C.green, glyph = 'check' }: { ring: string; tx: string; size?: number; color?: string; glyph?: 'check' | 'bar' }) {
  const fontSize = Math.min(10.5, 268 / (ring.length * 0.78))
  return (
    <Svg width={size} height={size} viewBox="0 0 120 120" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <Path id="ring" d="M60 60m-45 0a45 45 0 1 1 90 0a45 45 0 1 1-90 0" />
      </Defs>
      <Circle cx={60} cy={60} r={57} fill={C.white} fillOpacity={0.94} stroke={color} strokeWidth={3} />
      <Circle cx={60} cy={60} r={51.5} fill="none" stroke={color} strokeWidth={1.2} />
      <SvgText fill={color} fontFamily={F.semibold} fontSize={fontSize} letterSpacing={1.2}>
        <TextPath href="#ring" startOffset="0">{ring}</TextPath>
      </SvgText>
      <Circle cx={60} cy={60} r={36} fill={color} />
      <Path d={glyph === 'check' ? 'M45 57.5l9.5 9.5 18-20' : 'M47 58h26'} stroke={C.white} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <SvgText x={60} y={83} fill={C.white} fontFamily={F.mono} fontSize={8.5} textAnchor="middle">{tx}</SvgText>
    </Svg>
  )
}

/** The ladder's steps filling up to the one this page earned. `fill` animates in steps (0..n). */
function LadderFill({ steps, fill }: { steps: number; fill: Animated.Value }) {
  return (
    <View style={s.ladder}>
      {Array.from({ length: steps }, (_, i) => (
        <View key={i} style={s.ladderTrack}>
          <Animated.View style={[s.ladderBar, { width: fill.interpolate({ inputRange: [i, i + 1], outputRange: ['0%', '100%'], extrapolate: 'clamp' }) }]} />
        </View>
      ))}
    </View>
  )
}

const s = StyleSheet.create({
  book: { height: 300, borderRadius: R.card, backgroundColor: C.surface, padding: 10 },
  page: { flex: 1, borderRadius: 16, backgroundColor: C.white, padding: 20, paddingLeft: 26, gap: 6, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  leaf: { position: 'absolute', top: 10, bottom: 10, left: 10, right: 10, borderRadius: 16, backgroundColor: C.white, padding: 20, paddingLeft: 26, gap: 6, borderWidth: 1, borderColor: C.border, backfaceVisibility: 'hidden', transformOrigin: 'left center' },
  spine: { position: 'absolute', top: 10, bottom: 10, left: 10, width: 6, borderTopLeftRadius: 16, borderBottomLeftRadius: 16, backgroundColor: C.green },
  pageHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  openTag: { fontFamily: F.bold, fontSize: 11, letterSpacing: 0.5, color: C.amber, backgroundColor: C.amberBg, borderRadius: R.tag, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  rules: { gap: 16, marginTop: 14 },
  rule: { height: 1, backgroundColor: C.divider },
  sealSlot: { position: 'absolute', right: 14, bottom: 10, width: 132, height: 132, alignItems: 'center', justifyContent: 'center' },
  ripple: { position: 'absolute', width: 132, height: 132, borderRadius: 66, borderWidth: 3, borderColor: C.green },
  ladder: { flexDirection: 'row', gap: 6, width: 200 },
  ladderTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: C.border, overflow: 'hidden' },
  ladderBar: { height: 8, borderRadius: 4, backgroundColor: C.green },
})
