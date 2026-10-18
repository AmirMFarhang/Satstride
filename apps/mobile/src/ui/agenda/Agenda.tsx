// The personal agenda: what is due and when (a countdown ring per deadline, the block it is
// due at, and an estimate of the time that says what it assumed), what comes next on each
// loan and who it waits on, the ladder, and the pages already stamped. A pure view of the
// state passed in (agenda-model.ts): no network, no timers of its own beyond the rings.
import React, { useEffect, useMemo, useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { C, F, R, t } from '../theme'
import { usd } from '../format'
import { BrandIcon, type BrandIconName } from '../../brand/icons'
import { useReducedMotion } from '../../motion/reduce-motion'
import { agenda, type AgendaInput, type Deadline, type NextStep, type Tone } from './agenda-model'

export interface AgendaProps extends AgendaInput {
  onOpenLoan?: (loanId: string) => void
  onOpenPage?: (loanId: string) => void
}

const TONE: Record<Tone, { fg: string; bg: string; word: string }> = {
  ok: { fg: C.green, bg: C.greenBg, word: 'on track' },
  soon: { fg: C.amber, bg: C.amberBg, word: 'due soon' },
  grace: { fg: C.warn, bg: C.warnBg, word: 'in grace' },
  late: { fg: C.warn, bg: C.warnBg, word: 'act now' },
}

const OUTCOME: Record<string, { tag: string; fg: string; bg: string }> = {
  on_time: { tag: 'PAID', fg: C.green, bg: C.greenBg },
  late: { tag: 'LATE', fg: C.amber, bg: C.amberBg },
  defaulted: { tag: 'DEFAULT', fg: C.warn, bg: C.warnBg },
  liquidated: { tag: 'SOLD', fg: C.warn, bg: C.warnBg },
  refunded: { tag: 'REFUND', fg: C.muted, bg: C.surface },
}

export function Agenda(p: AgendaProps) {
  const a = useMemo(() => agenda(p), [p.height, p.now, p.seen, p.loans, p.pages, p.ladder, p.cureBlocks]) // eslint-disable-line react-hooks/exhaustive-deps
  const empty = !a.deadlines.length && !a.next.length
  return (
    <View style={{ gap: 26 }}>
      <Section title="Due next">
        {a.deadlines.length
          ? a.deadlines.map((d) => <DeadlineCard key={d.loanId} d={d} onPress={p.onOpenLoan ? () => p.onOpenLoan!(d.loanId) : undefined} />)
          : <Text style={t.sub}>{empty ? 'Nothing due. Borrow or lend and its deadlines show here.' : 'No payment is due yet.'}</Text>}
        {a.deadlines.length ? <Text style={t.tiny}>Deadlines are block heights. Times are estimates {a.pace.words}; blocks can come faster or slower.</Text> : null}
      </Section>

      {a.next.length ? (
        <Section title="What's next">
          {a.next.map((n) => <NextRow key={`${n.loanId}:${n.role}`} n={n} onPress={p.onOpenLoan ? () => p.onOpenLoan!(n.loanId) : undefined} />)}
        </Section>
      ) : null}

      {a.ladder && p.ladder ? (
        <Section title="Your ladder">
          <View style={s.ladder} accessible accessibilityLabel={`Step ${a.ladder.at + 1} of ${a.ladder.of}: ${a.ladder.percent / 100}% of your bitcoin's value. ${a.ladder.next}`}>
            {p.ladder.steps.map((b, i) => (
              <View key={i} style={s.ladderCol}>
                <View style={[s.ladderBar, { height: 10 + i * 8, backgroundColor: i <= a.ladder!.at ? C.green : C.border }]} />
                <Text style={[t.small, i === a.ladder!.at ? { color: C.ink, fontFamily: F.semibold } : null]}>{b / 100}%</Text>
              </View>
            ))}
          </View>
          <Text style={t.sub}>{a.ladder.next}</Text>
        </Section>
      ) : null}

      {a.past.length ? (
        <Section title="Past pages">
          <View>
            {a.past.map((pg, i) => {
              const o = OUTCOME[pg.outcome] ?? { tag: pg.outcome.toUpperCase(), fg: C.muted, bg: C.surface }
              const inner = (
                <>
                  <View style={[s.miniSeal, { borderColor: o.fg }]}><BrandIcon name={pg.outcome === 'on_time' || pg.outcome === 'late' ? 'check' : 'close'} size={12} color={o.fg} strokeWidth={3} /></View>
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>{pg.label} · {usd(pg.principal)}</Text>
                    {pg.close_txid ? <Text style={[t.tiny, { fontFamily: F.mono }]}>{pg.closeWord} {pg.close_txid.slice(0, 4)}…{pg.close_txid.slice(-4)}</Text> : null}
                  </View>
                  <Text style={[s.tag, { color: o.fg, backgroundColor: o.bg }]}>{o.tag}</Text>
                </>
              )
              return p.onOpenPage
                ? <Pressable key={pg.loanId} accessibilityRole="button" onPress={() => p.onOpenPage!(pg.loanId)} style={({ pressed }) => [s.pageRow, i < a.past.length - 1 ? s.divider : null, pressed ? { opacity: 0.7 } : null]}>{inner}</Pressable>
                : <View key={pg.loanId} style={[s.pageRow, i < a.past.length - 1 ? s.divider : null]}>{inner}</View>
            })}
          </View>
        </Section>
      ) : null}
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={s.section}>{title}</Text>
      {children}
    </View>
  )
}

function DeadlineCard({ d, onPress }: { d: Deadline; onPress?: () => void }) {
  const tone = TONE[d.tone]
  const label = `${d.title}: ${d.blocksLeft > 0 ? `${d.blocksLeft} blocks left, due at block ${d.dueHeight}` : `past block ${d.dueHeight}`}${d.eta ? `, ${d.eta}` : ''}. ${d.note}.`
  const body = (
    <>
      <CountdownRing left={d.left} blocks={d.blocksLeft} color={tone.fg} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={s.cardHead}>
          <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 16, flexShrink: 1 }]} numberOfLines={2}>{d.title}</Text>
          <Text style={[s.tag, { color: tone.fg, backgroundColor: tone.bg }]}>{tone.word.toUpperCase()}</Text>
        </View>
        <Text style={t.small}>{d.note}</Text>
        <Text style={[t.small, { color: C.ink }]}>{d.blocksLeft > 0 ? `block ${d.dueHeight}${d.eta ? ` · ${d.eta}` : ''}` : `was due at block ${d.dueHeight}`}</Text>
      </View>
    </>
  )
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [s.card, pressed ? { opacity: 0.7 } : null]}>{body}</Pressable>
    : <View accessible accessibilityLabel={label} style={s.card}>{body}</View>
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

/** The share of the term still left, as a ring that runs down; the blocks left in the middle. */
export function CountdownRing({ left, blocks, color = C.green, size = 64 }: { left: number; blocks: number; color?: string; size?: number }) {
  const still = useReducedMotion()
  const v = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (still === null) return
    if (still) { v.setValue(left); return }
    Animated.timing(v, { toValue: left, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start()
  }, [left, still]) // eslint-disable-line react-hooks/exhaustive-deps
  const stroke = 6
  const r = (size - stroke) / 2
  const len = 2 * Math.PI * r
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.border} strokeWidth={stroke} fill="none" />
        <AnimatedCircle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={`${len} ${len}`} strokeDashoffset={v.interpolate({ inputRange: [0, 1], outputRange: [len, 0] })}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      <Text style={[s.ringNum, { color: blocks > 0 ? C.ink : color }]}>{Math.abs(blocks)}</Text>
      <Text style={s.ringUnit}>{blocks > 0 ? (blocks === 1 ? 'block' : 'blocks') : 'over'}</Text>
    </View>
  )
}

const WAIT_ICON: Record<NextStep['waitingOn'], BrandIconName> = { you: 'bell', them: 'clock', chain: 'block' }

function NextRow({ n, onPress }: { n: NextStep; onPress?: () => void }) {
  const mine = n.waitingOn === 'you'
  const inner = (
    <>
      <View style={[s.nextIcon, { backgroundColor: mine ? C.amberBg : C.surface }]}><BrandIcon name={WAIT_ICON[n.waitingOn]} size={18} color={mine ? C.amber : C.muted} /></View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[t.body, mine ? { fontFamily: F.semibold } : null]}>{n.text}</Text>
        <Text style={t.tiny}>{n.role === 'borrower' ? 'Borrowing' : 'Lending'} · {mine ? 'waiting on you' : n.waitingOn === 'chain' ? 'waiting on Bitcoin' : 'waiting on them'}</Text>
      </View>
      {onPress ? <BrandIcon name="next" size={16} color={C.muted} /> : null}
    </>
  )
  return onPress
    ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.next, pressed ? { opacity: 0.7 } : null]}>{inner}</Pressable>
    : <View style={s.next}>{inner}</View>
}

const s = StyleSheet.create({
  section: { fontFamily: F.semibold, fontSize: 13, letterSpacing: 0.6, color: C.muted, textTransform: 'uppercase' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 16, borderRadius: R.card, backgroundColor: C.surface, padding: 16 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  tag: { fontFamily: F.bold, fontSize: 10, letterSpacing: 0.5, borderRadius: R.tag, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
  ringNum: { fontFamily: F.semibold, fontSize: 17, lineHeight: 20 },
  ringUnit: { fontFamily: F.regular, fontSize: 10, lineHeight: 12, color: C.muted },
  next: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
  nextIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ladder: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  ladderCol: { flex: 1, alignItems: 'center', gap: 6 },
  ladderBar: { width: '100%', borderRadius: 4 },
  pageRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60 },
  divider: { borderBottomWidth: 1, borderBottomColor: C.divider },
  miniSeal: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
})
