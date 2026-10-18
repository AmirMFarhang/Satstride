// The dashboard phone's building blocks (web/app.js "building blocks"), in React Native.

import { createContext, useContext, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { LIGHT, type Palette } from './theme'
import { SHARED } from '../core/strings.js'

export const Colors = createContext<Palette>(LIGHT)
export const useColors = () => useContext(Colors)

export function Top({ title, right, onBack }: { title: string; right?: ReactNode; onBack?: () => void }) {
  const c = useColors()
  return (
    <View style={s.top}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={12}>
          <Text style={[s.back, { color: c.accent }]}>‹</Text>
        </Pressable>
      ) : null}
      <Text accessibilityRole="header" style={[s.title, { color: c.ink }]}>{title}</Text>
      <View style={s.grow} />
      {right}
    </View>
  )
}

export function StopN({ text }: { text: string }) {
  const c = useColors()
  return <Text style={[s.stopN, { color: c.muted, borderColor: c.line }]}>{text}</Text>
}

export function Hero({ label, big, sub, children }: { label?: string; big: string; sub?: string; children?: ReactNode }) {
  const c = useColors()
  return (
    <View style={s.hero}>
      {label ? <Text style={[s.heroLabel, { color: c.muted }]}>{label}</Text> : null}
      <Text testID="hero-big" style={[s.big, { color: c.ink }]} adjustsFontSizeToFit numberOfLines={1}>{big}</Text>
      {sub ? <Text style={[s.sub, { color: c.muted }]}>{sub}</Text> : null}
      {children}
    </View>
  )
}

export function Btn({ label, onPress, kind = 'primary', disabled, testID }: { label: string; onPress: () => void; kind?: 'primary' | 'second' | 'link'; disabled?: boolean; testID?: string }) {
  const c = useColors()
  const style = kind === 'primary' ? { backgroundColor: c.accent } : kind === 'second' ? { backgroundColor: c.panel, borderColor: c.line, borderWidth: 1 } : {}
  const color = kind === 'primary' ? c.accentInk : kind === 'link' ? c.accent : c.ink
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[kind === 'link' ? s.link : s.btn, style, disabled ? s.disabled : null]}>
      <Text style={[kind === 'link' ? s.linkText : s.btnText, { color }]}>{label}</Text>
    </Pressable>
  )
}

export function Row({ k, v, onPress }: { k: string; v: ReactNode; onPress?: () => void }) {
  const c = useColors()
  const body = (
    <>
      <Text style={[s.k, { color: c.muted }]}>{k}</Text>
      {typeof v === 'string' ? <Text style={[s.v, { color: c.ink }]}>{v}{onPress ? ' ›' : ''}</Text> : v}
    </>
  )
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={[s.row, { borderColor: c.line }]}>{body}</Pressable>
  ) : (
    <View style={[s.row, { borderColor: c.line }]}>{body}</View>
  )
}

export function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  const c = useColors()
  return (
    <View style={s.kv}>
      <Text style={[s.kvK, { color: c.muted }]}>{k}</Text>
      <Text style={[s.kvV, { color: c.ink }, mono ? s.mono : null]} selectable>{v}</Text>
    </View>
  )
}

export function Amount({ text }: { text: string }) {
  const c = useColors()
  return <Text style={{ fontSize: 26, fontWeight: '700', color: c.ink, fontVariant: ['tabular-nums'] }}>{text}</Text>
}

export function Card({ children }: { children: ReactNode }) {
  const c = useColors()
  return <View style={[s.card, { backgroundColor: c.panel, borderColor: c.line }]}>{children}</View>
}

export function Tag({ text, tone }: { text: string; tone: 'open' | 'done' | 'bad' }) {
  const c = useColors()
  const bg = tone === 'done' ? c.okSoft : tone === 'bad' ? c.badSoft : c.soft
  const fg = tone === 'done' ? c.ok : tone === 'bad' ? c.bad : c.accent
  return <Text style={[s.tag, { backgroundColor: bg, color: fg }]}>{text}</Text>
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'bad'; children: ReactNode }) {
  const c = useColors()
  const bg = tone === 'ok' ? c.okSoft : tone === 'bad' ? c.badSoft : c.warnSoft
  const fg = tone === 'ok' ? c.ok : tone === 'bad' ? c.bad : c.warn
  return <Text accessibilityRole="alert" style={[s.banner, { backgroundColor: bg, color: fg }]}>{children}</Text>
}

export function P({ children, small, muted }: { children: ReactNode; small?: boolean; muted?: boolean }) {
  const c = useColors()
  return <Text style={[small ? s.small : s.p, { color: muted ? c.muted : c.ink }]}>{children}</Text>
}

export function Section({ title }: { title: string }) {
  const c = useColors()
  return <Text style={[s.sec, { color: c.muted }]}>{title.toUpperCase()}</Text>
}

export function Ladder({ steps, at }: { steps: number[]; at: number }) {
  const c = useColors()
  return (
    <View style={s.ladder} accessibilityLabel={`Limit ladder, now at ${steps[at] / 100}%`}>
      {steps.map((b, i) => (
        <Text key={b} style={[s.rung, { backgroundColor: i <= at ? c.accent : c.soft, color: i <= at ? c.accentInk : c.muted }]}>{`${b / 100}%`}</Text>
      ))}
    </View>
  )
}

export function Steps({ items }: { items: [string, boolean][] }) {
  const c = useColors()
  const first = items.findIndex(([, done]) => !done)
  return (
    <View style={s.steps}>
      {items.map(([label, done], i) => (
        <Text key={label} style={[s.step, { color: done ? c.ink : i === first ? c.accent : c.muted }]}>{done ? '✓ ' : i === first ? '› ' : '  '}{label}</Text>
      ))}
    </View>
  )
}

export function Undo() {
  const c = useColors()
  return <Text style={[s.undo, { color: c.muted }]}>{SHARED.cantUndo}</Text>
}

export function Toggle({ label, value, open, onPress }: { label: string; value?: string; open: boolean; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onPress} style={[s.row, { borderColor: c.line }]}>
      <Text style={[s.k, { color: c.muted }]}>{label}</Text>
      <Text style={[s.v, { color: c.ink }]}>{value ?? ''} {open ? '▴' : '▾'}</Text>
    </Pressable>
  )
}

export const s = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  back: { fontSize: 30, lineHeight: 30, paddingRight: 4 },
  title: { fontSize: 20, fontWeight: '700' },
  grow: { flex: 1 },
  stopN: { fontSize: 11, fontWeight: '700', letterSpacing: 1, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  hero: { alignItems: 'center', paddingVertical: 18, gap: 4 },
  heroLabel: { fontSize: 13 },
  big: { fontSize: 34, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sub: { fontSize: 14, textAlign: 'center' },
  btn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, alignItems: 'center', flexGrow: 1 },
  btnText: { fontSize: 16, fontWeight: '600' },
  link: { paddingVertical: 8 },
  linkText: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  k: { fontSize: 15, flexShrink: 1 },
  v: { fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  kvK: { fontSize: 13, flexShrink: 1 },
  kvV: { fontSize: 13, flexShrink: 1, textAlign: 'right' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 6, marginVertical: 6 },
  tag: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden', alignSelf: 'flex-start' },
  banner: { padding: 10, borderRadius: 8, fontSize: 14, marginVertical: 6, overflow: 'hidden' },
  p: { fontSize: 15, lineHeight: 21, marginVertical: 4 },
  small: { fontSize: 13, lineHeight: 18, marginVertical: 3 },
  sec: { fontSize: 12, fontWeight: '700', letterSpacing: 1, marginTop: 16, marginBottom: 4 },
  ladder: { flexDirection: 'row', gap: 6, justifyContent: 'center', marginVertical: 8 },
  rung: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, overflow: 'hidden', fontSize: 13, fontWeight: '600' },
  steps: { gap: 4, marginVertical: 6 },
  step: { fontSize: 14 },
  undo: { fontSize: 12, textAlign: 'center', marginTop: 6 },
})
