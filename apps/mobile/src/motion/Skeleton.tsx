// Loading states in the canvas's shapes: grey blocks where the number, the rows and the text
// will be, with a light band sweeping across them, and the sealed-passbook
// loader for a wait with a name ("Reading your passbook from Bitcoin"). Shown only while
// the screen's own data is loading (the `loading` flag of usePassbookView and friends);
// with reduce motion the blocks stay still.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, Text, View, type DimensionValue, type LayoutChangeEvent } from 'react-native'
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg'
import { C, t } from '../ui/theme'
import { Logo } from '../brand/Logo'
import { useReducedMotion } from './reduce-motion'

const SWEEP_MS = 1300

// Inside a Skeleton: one label for the screen reader, and the reduce-motion setting read once.
const Sweep = createContext<{ still: boolean | null } | null>(null)

/** Holds the skeleton blocks of one screen; they shimmer together (each starts when it is laid out). */
export function Skeleton({ children, label = 'Loading' }: { children: React.ReactNode; label?: string }) {
  const still = useReducedMotion()
  return (
    <Sweep.Provider value={{ still }}>
      <View accessible accessibilityLabel={label} accessibilityState={{ busy: true }} style={{ gap: 14 }}>{children}</View>
    </Sweep.Provider>
  )
}

/** One grey block; inside a Skeleton a light band sweeps across it. */
export function Bone({ width = '100%', height = 14, radius = 6, style }: { width?: DimensionValue; height?: number; radius?: number; style?: object }) {
  const sweep = useContext(Sweep)
  const [w, setW] = useState(0)
  const progress = useRef(new Animated.Value(0)).current
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)
  const band = Math.max(60, w * 0.5)
  const moving = sweep?.still === false && w > 0
  // the loop starts after the band is on screen (an animation started before its view mounts never moves it)
  useEffect(() => {
    if (!moving) return
    progress.setValue(0)
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: SWEEP_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [moving, w]) // eslint-disable-line react-hooks/exhaustive-deps
  const x = progress.interpolate({ inputRange: [0, 1], outputRange: [-band, w] })
  return (
    <View onLayout={onLayout} style={[{ width, height, borderRadius: radius, backgroundColor: C.surface, overflow: 'hidden' }, style]}>
      {moving ? (
        <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: band, transform: [{ translateX: x }] }}>
          <Svg width={band} height={height}>
            <Defs>
              <LinearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={C.white} stopOpacity={0} />
                <Stop offset="0.5" stopColor={C.white} stopOpacity={0.75} />
                <Stop offset="1" stopColor={C.white} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={band} height={height} fill="url(#sweep)" />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  )
}

/** The canvas's hero (label, one big number, a line under it), still loading. */
export function HeroBones() {
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingTop: 8 }}>
      <Bone width={150} height={14} />
      <Bone width={230} height={40} radius={10} />
      <Bone width={180} height={14} />
    </View>
  )
}

/** Rows (a label on the left, its value on the right), still loading. */
export function RowBones({ rows = 3 }: { rows?: number }) {
  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[s.row, i < rows - 1 ? s.divider : null]}>
          <Bone width={`${32 + ((i * 17) % 20)}%`} height={14} />
          <Bone width={`${18 + ((i * 11) % 16)}%`} height={14} />
        </View>
      ))}
    </View>
  )
}

/** Lines of text, the last one shorter. */
export function TextBones({ lines = 3 }: { lines?: number }) {
  return <View style={{ gap: 8 }}>{Array.from({ length: lines }, (_, i) => <Bone key={i} width={i === lines - 1 ? '62%' : '100%'} height={13} />)}</View>
}

/** A card (the open page's surface card), still loading. */
export function CardBones() {
  return (
    <View style={s.card}>
      <View style={s.cardHead}><Bone width={70} height={14} style={{ backgroundColor: C.border }} /><Bone width={52} height={20} radius={6} style={{ backgroundColor: C.border }} /></View>
      <Bone width="80%" height={36} radius={10} style={{ backgroundColor: C.border }} />
      <Bone width="55%" height={13} style={{ backgroundColor: C.border }} />
    </View>
  )
}

/**
 * The branded wait: the passbook mark inside a turning ring, and what the phone is waiting
 * on in words. `label` null shows nothing (nothing is loading).
 */
export function Loading({ label, size = 56 }: { label: string | null | undefined; size?: number }) {
  const still = useReducedMotion()
  const spin = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (still !== false || !label) return
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [still, label, spin])
  if (!label) return null
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  const r = size / 2 - 3
  return (
    <View style={s.loading} accessible accessibilityLiveRegion="polite" accessibilityLabel={label} accessibilityState={{ busy: true }}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.border} strokeWidth={3} fill="none" />
        </Svg>
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>
          <Svg width={size} height={size}>
            <Path d={`M${size / 2} 3a${r} ${r} 0 0 1 ${r} ${r}`} stroke={C.green} strokeWidth={3} strokeLinecap="round" fill="none" />
          </Svg>
        </Animated.View>
        <Logo size={size * 0.52} />
      </View>
      <Text style={[t.small, { textAlign: 'center' }]}>{label}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  divider: { borderBottomWidth: 1, borderBottomColor: C.divider },
  card: { borderRadius: 20, backgroundColor: C.surface, padding: 20, gap: 14 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  loading: { alignItems: 'center', gap: 10, paddingVertical: 8 },
})
