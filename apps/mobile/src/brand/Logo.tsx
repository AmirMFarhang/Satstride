// The Passbook mark (mark.ts, the user's pick: the sealed passbook) and its lockup with the
// wordmark. Knockouts are painted in the palette's paper colour, so draw it on that colour:
// white screens use 'colour' or 'mono', the green splash 'onGreen', ink surfaces 'reverse'.
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { C, F } from '../ui/theme'
import { MARK, PALETTES, type Layer, type Mark, type Palette, type Variant } from './mark'

export interface LogoProps {
  /** edge of the square, in dp; the mark reads from 16 up */
  size?: number
  variant?: Variant
  /** overrides the variant's colours (e.g. paper to match a tinted card) */
  palette?: Partial<Palette>
  mark?: Mark
  /** the screen reader's name for it; omit when a text label sits next to it */
  label?: string
}

export function Logo({ size = 48, variant = 'colour', palette, mark = MARK, label }: LogoProps) {
  const p = { ...PALETTES[variant], ...palette }
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64"
      {...(label ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}>
      {mark.layers.map((l, i) => <MarkLayer key={i} l={l} p={p} />)}
    </Svg>
  )
}

export function MarkLayer({ l, p }: { l: Layer; p: Palette }) {
  const paint = {
    fill: l.fill ? p[l.fill] : 'none',
    stroke: l.stroke ? p[l.stroke] : 'none',
    ...(l.stroke ? { strokeWidth: l.width ?? 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const } : {}),
  }
  if (l.el === 'path') return <Path d={l.d} {...paint} />
  if (l.el === 'circle') return <Circle cx={l.cx} cy={l.cy} r={l.r} {...paint} />
  return <Rect x={l.x} y={l.y} width={l.w} height={l.h} rx={l.rx} {...paint} {...(l.rotate ? { rotation: l.rotate, originX: l.x + l.w / 2, originY: l.y + l.h / 2 } : {})} />
}

/** The canvas's welcome tile (canvas 1): an 84 px ink square, radius 26, with the mark in white. */
export function LogoTile({ size = 84, label = 'Passbook' }: { size?: number; label?: string }) {
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size, borderRadius: Math.round(size * 0.31), backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' }}>
      <Logo size={Math.round(size * 0.62)} variant="reverse" />
    </View>
  )
}

/** The mark and "Passbook" in IBM Plex Sans: the onboarding header and the about sheet. */
export function LogoLockup({ size = 40, variant = 'colour', color }: { size?: number; variant?: Variant; color?: string }) {
  const p = PALETTES[variant]
  return (
    <View style={s.row} accessible accessibilityRole="header" accessibilityLabel="Passbook">
      <Logo size={size} variant={variant} />
      <Text style={[s.word, { fontSize: Math.round(size * 0.68), color: color ?? p.ink }]}>Passbook</Text>
    </View>
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  word: { fontFamily: F.semibold, letterSpacing: -0.4 },
})
