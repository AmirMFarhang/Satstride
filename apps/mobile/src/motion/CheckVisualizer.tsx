// The private credit check, as it happens: your data sealed in an envelope on the phone,
// travelling over Nostr to the check node, waiting there for your approval of the Compex
// contract, the node running it while the lender pays, the result travelling back, and then
// the checks this phone ran on it, one by one (BorrowerCheckView.ticks: the DSSE signature,
// the released run, the v2 binding to this loan...) and the recommendation. The envelope's
// place is the real stage; the ticks are the real ticks, in their order. With reduce motion
// everything is in place at once.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import type { BorrowerCheckView } from '../../../../src/checknode/borrower-check.js'
import { C, F, R, t } from '../ui/theme'
import { BrandIcon } from '../brand/icons'
import { useEntrance, useReducedMotion } from './reduce-motion'
import { checkPicture, phaseWords, type CheckPhase, type TickRow, type VerdictTone } from './check-model'

export interface CheckVisualizerProps {
  phase: CheckPhase
  /** the opened check (openForwardedCheck / runBorrowerCheck's view); its ticks show once `phase` is 'opened' */
  view?: Pick<BorrowerCheckView, 'ok' | 'ticks' | 'outputs'> | null
  /** the refusal code when `phase` is 'refused' */
  refusal?: string | null
  /** the refusal in words (M7's refusalWords) */
  refusalText?: string
  /** how the check node is named ("Check node 9d1375") */
  operatorLabel?: string
  /** ms between ticks as they appear */
  tickMs?: number
}

const BOX = 56
const TRAVEL_MS = 900

export function CheckVisualizer({ phase, view, refusal, refusalText, operatorLabel = 'the check node', tickMs = 170 }: CheckVisualizerProps) {
  const pic = useMemo(() => checkPicture({ phase, view, refusal }), [phase, view, refusal])
  const still = useReducedMotion()
  const [lane, setLane] = useState(0)
  const pos = useRef(new Animated.Value(pic.envelope.at)).current
  const pulse = useRef(new Animated.Value(0)).current
  const [shown, setShown] = useState(0)

  // the envelope goes where the real stage says it is, once the lane is measured and the envelope is on screen
  useEffect(() => {
    const { at, from } = pic.envelope
    if (still === null) { pos.setValue(from); return }
    if (still || !lane) { pos.setValue(at); return }
    pos.setValue(from)
    if (at === from) return
    const a = Animated.timing(pos, { toValue: at, duration: TRAVEL_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true })
    a.start()
    return () => a.stop()
  }, [phase, lane > 0, still]) // eslint-disable-line react-hooks/exhaustive-deps

  // the node breathes while it is working or waiting on you
  useEffect(() => {
    if (still !== false || (phase !== 'running' && phase !== 'approval')) { pulse.setValue(0); return }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [phase, still]) // eslint-disable-line react-hooks/exhaustive-deps

  // the ticks, one by one, after the envelope is back
  useEffect(() => {
    if (still === null) return
    if (still) { setShown(pic.ticks.length); return }
    setShown(0)
    if (!pic.ticks.length) return
    let n = 0
    let timer: ReturnType<typeof setTimeout>
    const step = () => { n += 1; setShown(n); if (n < pic.ticks.length) timer = setTimeout(step, tickMs) }
    timer = setTimeout(step, TRAVEL_MS)
    return () => clearTimeout(timer)
  }, [pic.ticks.length, phase, still]) // eslint-disable-line react-hooks/exhaustive-deps

  const span = Math.max(0, lane - BOX)
  const x = pos.interpolate({ inputRange: [0, 1], outputRange: [BOX + 6, span - 50] })
  const hop = pos.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -14, 0] })
  const nodeScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] })
  const halo = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] })
  const refused = phase === 'refused'
  const done = shown >= pic.ticks.length
  const failed = pic.ticks.filter((tk) => !tk.ok)

  return (
    <View style={{ gap: 16 }}>
      <View style={s.stage} onLayout={(e: LayoutChangeEvent) => setLane(e.nativeEvent.layout.width)} accessible accessibilityLiveRegion="polite" accessibilityLabel={phaseWords(phase, operatorLabel)}>
        <View style={[s.wire, { left: BOX / 2, right: BOX / 2, borderColor: refused ? C.warn : C.track }]} />
        <View style={[s.end, { left: 0 }]}>
          <View style={[s.box, { backgroundColor: C.ink }]}><BrandIcon name="phone" size={26} color={C.white} /></View>
          <Text style={s.who}>This phone</Text>
        </View>
        <View style={[s.end, { right: 0 }]}>
          <Animated.View style={[s.halo, { opacity: halo, transform: [{ scale: nodeScale }], backgroundColor: phase === 'approval' ? C.amberBg : C.greenBg }]} />
          <Animated.View style={[s.box, { backgroundColor: C.greenBg, transform: [{ scale: nodeScale }] }]}><BrandIcon name="node" size={26} color={C.green} /></Animated.View>
          <Text style={s.who} numberOfLines={1}>{operatorLabel === 'the check node' ? 'Check node' : operatorLabel}</Text>
        </View>
        <Animated.View pointerEvents="none" style={[s.envelope, { opacity: lane ? 1 : 0, transform: [{ translateX: x }, { translateY: hop }] }]}>
          <Envelope open={phase === 'opened'} tone={refused ? C.warn : C.green} />
        </Animated.View>
      </View>

      <View style={s.status}>
        {phase === 'approval' ? <Text style={[s.pill, { color: C.amber, backgroundColor: C.amberBg }]}>WAITING FOR YOU</Text> : null}
        {phase === 'running' ? <Text style={[s.pill, { color: C.green, backgroundColor: C.greenBg }]}>COMPEX · QVAC · LENDER PAYS</Text> : null}
        <Text style={[t.sub, { textAlign: 'center' }]}>{phaseWords(phase, operatorLabel)}</Text>
      </View>

      {refused ? (
        <View style={s.refusal} accessibilityRole="alert">
          <Text style={[t.small, { color: C.warn, fontFamily: F.semibold }]}>{pic.refusal}</Text>
          {refusalText ? <Text style={[t.body, { color: C.warn }]}>{refusalText}</Text> : null}
        </View>
      ) : null}

      {pic.ticks.length ? (
        <View style={{ gap: 10 }}>
          {pic.ticks.slice(0, shown).map((tk) => <Tick key={tk.id} tk={tk} still={still} />)}
        </View>
      ) : null}

      {done && pic.ok === false ? (
        <View style={s.refusal} accessibilityRole="alert">
          <Text style={[t.bodyMedium, { color: C.warn, fontFamily: F.semibold }]}>Does not verify on this phone</Text>
          <Text style={[t.small, { color: C.warn }]}>{failed.length ? failed.map((f) => f.label).join(', ') : 'no checks ran'}. No result is used.</Text>
        </View>
      ) : null}
      {done && pic.verdict ? <VerdictBadge recommendation={pic.verdict.recommendation} tone={pic.verdict.tone} band={pic.verdict.income_band} still={still} /> : null}
    </View>
  )
}

function Envelope({ open, tone }: { open: boolean; tone: string }) {
  if (open) {
    // opened on the phone: the flap up, the result showing
    return (
      <Svg width={44} height={34} viewBox="0 0 44 34">
        <Path d="M3 12L22 1.5 41 12" fill={C.surface} stroke={C.ink} strokeWidth={2} strokeLinejoin="round" />
        <Rect x={9} y={5} width={26} height={18} rx={2} fill={C.white} stroke={C.ink} strokeWidth={1.6} />
        <Path d="M13 10h18M13 14.5h11" stroke={tone} strokeWidth={2} strokeLinecap="round" />
        <Path d="M2 12h40v18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" fill={C.white} stroke={C.ink} strokeWidth={2} strokeLinejoin="round" />
        <Path d="M3 13.5l19 10.5 19-10.5" fill="none" stroke={C.ink} strokeWidth={2} strokeLinejoin="round" />
      </Svg>
    )
  }
  return (
    <Svg width={44} height={34} viewBox="0 0 44 34">
      <Rect x={2} y={6} width={40} height={26} rx={4} fill={C.white} stroke={C.ink} strokeWidth={2} />
      <Path d="M3 8l19 13 19-13" fill="none" stroke={C.ink} strokeWidth={2} strokeLinejoin="round" />
      <Circle cx={22} cy={21} r={5} fill={tone} />
    </Svg>
  )
}

function Tick({ tk, still }: { tk: TickRow; still: boolean | null }) {
  const a = useEntrance(still, (v) => Animated.spring(v, { toValue: 1, friction: 6, tension: 120, useNativeDriver: true }))
  return (
    <Animated.View style={[s.tick, { opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }]} accessible accessibilityLabel={`${tk.label}: ${tk.ok ? 'passed' : 'failed'}. ${tk.detail}`}>
      <Animated.View style={[s.dot, { backgroundColor: tk.ok ? C.green : C.warn, transform: [{ scale: a }] }]}>
        <BrandIcon name={tk.ok ? 'check' : 'close'} size={12} color={C.white} strokeWidth={3} />
      </Animated.View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[t.body, { fontSize: 14 }, tk.key ? { fontFamily: F.semibold } : null]}>{tk.label}</Text>
        <Text style={[t.tiny, tk.ok ? null : { color: C.warn }]} numberOfLines={2}>{tk.detail}</Text>
      </View>
    </Animated.View>
  )
}

const TONE: Record<VerdictTone, { fg: string; bg: string }> = {
  good: { fg: C.green, bg: C.greenBg },
  hold: { fg: C.amber, bg: C.amberBg },
  bad: { fg: C.warn, bg: C.warnBg },
}

function VerdictBadge({ recommendation, tone, band, still }: { recommendation: string; tone: VerdictTone; band: string | null; still: boolean | null }) {
  const a = useEntrance(still, (v) => Animated.spring(v, { toValue: 1, friction: 5, tension: 140, delay: 120, useNativeDriver: true }))
  const c = TONE[tone]
  return (
    <Animated.View style={[s.verdict, { backgroundColor: c.bg, opacity: a, transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }] }]} accessible accessibilityLabel={`Recommendation ${recommendation}${band ? `, income band ${band}` : ''}`}>
      <BrandIcon name="seal" size={26} color={c.fg} />
      <View style={{ flex: 1 }}>
        <Text style={[s.verdictText, { color: c.fg }]}>{recommendation}</Text>
        {band ? <Text style={[t.small, { color: c.fg }]}>income band {band}</Text> : null}
      </View>
    </Animated.View>
  )
}

const s = StyleSheet.create({
  stage: { height: BOX + 26 },
  wire: { position: 'absolute', top: BOX / 2, height: 0, borderTopWidth: 2, borderStyle: 'dashed' },
  end: { position: 'absolute', top: 0, alignItems: 'center', width: BOX + 40, marginHorizontal: -20 },
  box: { width: BOX, height: BOX, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', top: -8, width: BOX + 16, height: BOX + 16, borderRadius: 22 },
  who: { fontFamily: F.medium, fontSize: 12, color: C.ink, marginTop: 6 },
  envelope: { position: 'absolute', top: BOX / 2 - 17, left: 0 },
  status: { alignItems: 'center', gap: 8 },
  pill: { fontFamily: F.bold, fontSize: 11, letterSpacing: 0.5, borderRadius: R.tag, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  refusal: { borderRadius: 12, backgroundColor: C.warnBg, padding: 14, gap: 4 },
  tick: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: R.button, padding: 16 },
  verdictText: { fontFamily: F.semibold, fontSize: 22, letterSpacing: 0.4 },
})
