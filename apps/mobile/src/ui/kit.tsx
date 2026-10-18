// The canvas's building blocks: a white screen with its one number and one primary
// button pinned at the bottom, rows, chips, segmented controls, bottom sheets, a
// step list, the ladder and the stamp. The REGTEST badge sits on every screen.
import React, { useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { NETWORK, WALLET_ID } from '../wallet/config'
import { activeWallet } from '../wallet/flags'
import { PERSONA_WALLET_ID } from '../app/persona'
import { C, F, R, t } from './theme'
import { isConnectionError, plainError } from './errors'
import { Icon, type IconName } from './icons'
import { BrandIcon, type BrandIconName } from '../brand/icons'

/** On every screen: this build is on regtest and its coins are test coins. */
export function NetworkBadge() {
  // the seeded regtest test persona is named on every screen while it is active (src/app/persona.ts)
  const text = activeWallet.get(WALLET_ID) === PERSONA_WALLET_ID ? `${NETWORK.badge} · TEST PERSONA (test data)` : NETWORK.badge
  return (
    <View accessibilityRole="header" accessibilityLabel={`Network: ${text}`} style={s.badge}>
      <Text style={s.badgeText}>{text}</Text>
    </View>
  )
}

/** A screen: badge, top bar, scrolling body, and the bottom (primary button, tab bar) always in reach. */
export function Screen({ top, children, bottom, gap = 24, scroll = true }: { top?: React.ReactNode; children?: React.ReactNode; bottom?: React.ReactNode; gap?: number; scroll?: boolean }) {
  const body = <View style={[s.body, { gap }]}>{children}</View>
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <NetworkBadge />
      {top ? <View style={s.topWrap}>{top}</View> : null}
      {scroll ? <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">{body}</ScrollView> : <View style={s.flex}>{body}</View>}
      {bottom ? <View style={s.bottom}>{bottom}</View> : null}
    </SafeAreaView>
  )
}

export function IconButton({ name, label, onPress, side }: { name: IconName; label: string; onPress: () => void; side?: 'left' | 'right' }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
      style={({ pressed }) => [s.iconBtn, side === 'left' ? { marginLeft: -12 } : side === 'right' ? { marginRight: -12 } : null, pressed ? s.pressed : null]}>
      <Icon name={name} />
    </Pressable>
  )
}

/** A tab's own top bar: its name on the left, one icon on the right. */
export function TabTop({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={s.topBar}>
      <Text accessibilityRole="header" style={t.title}>{title}</Text>
      {right ?? <View style={s.spacer} />}
    </View>
  )
}

/** A screen inside a flow: back on the left, its name in the middle, an info button or the stop count on the right. */
export function FlowTop({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={s.topBar}>
      {onBack ? <IconButton name="back" label="Back" onPress={onBack} side="left" /> : <View style={s.spacer} />}
      <Text accessibilityRole="header" style={t.title}>{title}</Text>
      {right ?? <View style={s.spacer} />}
    </View>
  )
}

/** "1 OF 3": which of the three stops this is. */
export function StopCount({ n }: { n: 1 | 2 | 3 }) {
  return <Text style={s.stopN} accessibilityLabel={`Stop ${n} of 3`}>{n} OF 3</Text>
}

export function Hero({ label, value, sub, size = 'big', align = 'center' }: { label?: string; value: string; sub?: React.ReactNode; size?: 'big' | 'mid'; align?: 'center' | 'left' }) {
  return (
    <View style={[s.hero, align === 'left' ? { alignItems: 'flex-start' } : null]}>
      {label ? <Text style={[t.sub, align === 'center' ? s.center : null]}>{label}</Text> : null}
      <Text style={[size === 'big' ? t.big : t.mid, align === 'center' ? s.center : null]} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
      {sub ? (typeof sub === 'string' ? <Text style={[t.sub, align === 'center' ? s.center : null]}>{sub}</Text> : sub) : null}
    </View>
  )
}

export function Rows({ children, topLine }: { children: React.ReactNode; topLine?: boolean }) {
  const kids = React.Children.toArray(children).filter(Boolean)
  return (
    <View style={topLine ? s.topLine : null}>
      {kids.map((k, i) => <View key={i} style={i < kids.length - 1 ? s.divider : null}>{k}</View>)}
    </View>
  )
}

/** A label and its value; with onPress it opens something (a chevron shows it). */
export function Row({ k, v, onPress, tone, mono }: { k: string; v?: React.ReactNode; onPress?: () => void; tone?: 'green' | 'muted' | 'warn'; mono?: boolean }) {
  const color = tone === 'green' ? C.green : tone === 'muted' ? C.muted : tone === 'warn' ? C.warn : C.ink
  const value = typeof v === 'string' || typeof v === 'number' ? <Text style={[mono ? t.mono : s.rowV, { color }]} numberOfLines={1}>{v}</Text> : v
  const inner = (
    <>
      <Text style={s.rowK}>{k}</Text>
      <View style={s.rowRight}>{value}{onPress ? <Icon name="next" size={16} color={C.muted} /> : null}</View>
    </>
  )
  return onPress
    ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.row, pressed ? s.pressed : null]}>{inner}</Pressable>
    : <View style={s.row}>{inner}</View>
}

/** A short txid or id with a copy button (the canvas's receipt rows). */
export function TxValue({ id, chars = 4 }: { id: string; chars?: number }) {
  const [copied, setCopied] = useState(false)
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : `Copy ${id}`} onPress={async () => { await Clipboard.setStringAsync(id); setCopied(true) }} style={s.tx}>
      <Text style={t.mono}>{copied ? 'copied' : `${id.slice(0, chars)}…${id.slice(-chars)}`}</Text>
      <Icon name="copy" size={14} color={C.muted} />
    </Pressable>
  )
}

type ButtonKind = 'primary' | 'secondary' | 'outline' | 'ghost'
export function Button({ label, onPress, kind = 'primary', disabled, busy, style }: { label: string; onPress: () => void; kind?: ButtonKind; disabled?: boolean; busy?: boolean; style?: ViewStyle }) {
  const box = kind === 'primary' ? s.primary : kind === 'secondary' ? s.secondary : kind === 'outline' ? s.outline : s.ghost
  const text = kind === 'primary' ? s.primaryText : kind === 'ghost' ? s.ghostText : s.secondaryText
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled, busy: !!busy }} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [box, style, disabled ? s.disabled : pressed ? s.pressed : null]}>
      {busy ? <ActivityIndicator color={kind === 'primary' ? C.white : C.ink} /> : <Text style={text}>{label}</Text>}
    </Pressable>
  )
}

/** Under every button that moves money or signs. */
export function Undo({ text = "Can't be undone" }: { text?: string }) {
  return <Text style={[t.small, s.center]}>{text}</Text>
}

export function Chip({ label, onPress, icon, active }: { label: string; onPress?: () => void; icon?: IconName; active?: boolean }) {
  const inner = (
    <>
      <Text style={[s.chipText, active ? { color: C.white } : null]}>{label}</Text>
      {icon ? <Icon name={icon} size={14} color={active ? C.white : C.muted} /> : null}
    </>
  )
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityState={{ selected: !!active }} onPress={onPress} style={({ pressed }) => [s.chip, active ? s.chipOn : null, pressed ? s.pressed : null]}>{inner}</Pressable>
    : <View style={[s.chip, active ? s.chipOn : null]}>{inner}</View>
}

/** Small uppercase status: OPEN, LOWEST COST, YOURS. */
export function Tag({ label, tone = 'green' }: { label: string; tone?: 'green' | 'amber' | 'muted' }) {
  const bg = tone === 'green' ? C.greenBg : tone === 'amber' ? C.amberBg : C.surface
  const fg = tone === 'green' ? C.green : tone === 'amber' ? C.amber : C.muted
  return <Text style={[s.tag, { backgroundColor: bg, color: fg }]}>{label}</Text>
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <View style={s.seg} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.id === value
        return (
          <Pressable key={o.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(o.id)} style={[s.segItem, on ? s.segOn : null]}>
            <Text style={[s.segText, on ? { color: C.ink, fontFamily: F.semibold } : null]}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** A choice of amounts or terms: dark when picked. */
export function Choices<T extends string | number>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T | null; onChange: (v: T) => void; label: string }) {
  return (
    <View style={s.choices} accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.id === value
        return (
          <Pressable key={String(o.id)} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(o.id)}
            style={({ pressed }) => [s.choice, on ? s.choiceOn : null, pressed ? s.pressed : null]}>
            <Text style={[s.choiceText, on ? { color: C.white } : null]}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** An explanation behind a tap: a bottom sheet over a scrim. */
export function Sheet({ visible, onClose, title, children, cta = 'Got it', onCta }: { visible: boolean; onClose: () => void; title: string; children?: React.ReactNode; cta?: string | null; onCta?: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button">
        <Pressable style={s.sheet} onPress={() => {}} accessible={false}>
          <View style={s.handle} />
          <Text accessibilityRole="header" style={t.h2}>{title}</Text>
          {children}
          {cta ? <Button label={cta} onPress={onCta ?? onClose} style={{ height: 52 }} /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

export function P({ children, muted, small, center }: { children: React.ReactNode; muted?: boolean; small?: boolean; center?: boolean }) {
  return <Text style={[small ? t.small : muted ? t.sub : t.body, center ? s.center : null]}>{children}</Text>
}

/** "Details", "What am I agreeing to?": a row that opens what is behind it. */
export function Disclosure({ label, value, children, topLine = true, open: initial = false }: { label: string; value?: string; children: React.ReactNode; topLine?: boolean; open?: boolean }) {
  const [open, setOpen] = useState(initial)
  return (
    <View style={topLine ? s.topLine : null}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={s.disclosure}>
        <Text style={t.bodyMedium}>{label}</Text>
        <View style={s.rowRight}>
          {value ? <Text style={t.bodyMedium}>{value}</Text> : null}
          <View style={open ? { transform: [{ rotate: '180deg' }] } : null}><Icon name="down" size={16} color={C.muted} /></View>
        </View>
      </Pressable>
      {open ? <View style={s.disclosed}>{children}</View> : null}
    </View>
  )
}

/** A key and value inside a disclosure or a sheet (14px, no divider). */
export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <View style={s.kv}>
      <Text style={[t.small, { fontSize: 14 }]}>{k}</Text>
      {typeof v === 'string' ? <Text style={[t.body, { fontSize: 14, flexShrink: 1, textAlign: 'right' }]}>{v}</Text> : v}
    </View>
  )
}

export type StepState = 'done' | 'now' | 'next' | 'failed'
/** The canvas's progress list: green check, amber ring for the step waiting on the person, grey ring for later. */
export function Steps({ items }: { items: { label: string; state: StepState; note?: string }[] }) {
  return (
    <View style={{ gap: 14 }}>
      {items.map((it, i) => (
        <View key={i} style={s.step} accessibilityLabel={`${it.label}: ${it.state === 'done' ? 'done' : it.state === 'now' ? 'now' : it.state === 'failed' ? 'failed' : 'not yet'}`}>
          {it.state === 'done' ? <View style={[s.dot, { backgroundColor: C.green }]}><Icon name="check" size={13} color={C.white} strokeWidth={3} /></View>
            : it.state === 'now' ? <View style={[s.dot, { borderWidth: 3, borderColor: C.amber }]} />
            : it.state === 'failed' ? <View style={[s.dot, { backgroundColor: C.warn }]}><Icon name="close" size={13} color={C.white} strokeWidth={3} /></View>
            : <View style={[s.dot, { borderWidth: 2, borderColor: C.border }]} />}
          <Text style={[t.body, { flex: 1 }, it.state === 'now' ? { fontFamily: F.semibold } : it.state === 'next' ? { color: C.muted } : null]}>{it.label}</Text>
          {it.note ? <Text style={t.small}>{it.note}</Text> : null}
        </View>
      ))}
    </View>
  )
}

/** Four short bars: locked, paid in, paid, stamped. */
export function Bar4({ filled, label }: { filled: number; label: string }) {
  return (
    <View style={s.bar4} accessibilityRole="image" accessibilityLabel={label}>
      {[0, 1, 2, 3].map((i) => <View key={i} style={[s.bar, { backgroundColor: i < filled ? C.green : C.track }]} />)}
    </View>
  )
}

/** The limit ladder: one column per step, the earned one green. */
export function Ladder({ steps, at }: { steps: number[]; at: number }) {
  return (
    <View style={s.ladder} accessibilityRole="image" accessibilityLabel={`Limit ladder: ${steps.map((b) => `${b / 100}%`).join(', ')}, now at ${steps[at] / 100}%`}>
      {steps.map((b, i) => (
        <View key={i} style={s.ladderCol}>
          <View style={[s.ladderBar, { backgroundColor: i <= at ? C.green : C.border }]} />
          <Text style={[t.small, i === at ? { color: C.ink, fontFamily: F.semibold } : null]}>{b / 100}%</Text>
        </View>
      ))}
    </View>
  )
}

export function Stamp({ text }: { text: string }) {
  return <Text style={s.stamp}>{text}</Text>
}

/** A green or amber box: the limit rising, a warning, a note that matters. */
export function Note({ tone = 'green', icon, title, sub }: { tone?: 'green' | 'warn'; icon?: IconName; title: string; sub?: string }) {
  const fg = tone === 'green' ? C.green : C.warn
  return (
    <View style={[s.note, { backgroundColor: tone === 'green' ? C.greenBg : C.warnBg }]} accessibilityRole={tone === 'warn' ? 'alert' : undefined}>
      {icon ? <Icon name={icon} size={22} color={fg} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.bodyMedium, { fontFamily: F.semibold, fontSize: 16, color: tone === 'green' ? C.ink : C.warn }]}>{title}</Text>
        {sub ? <Text style={[t.body, { fontSize: 14, color: fg }]}>{sub}</Text> : null}
      </View>
    </View>
  )
}

/** Something went wrong: said plainly, in the canvas's warning colours. */
export function Problem({ children }: { children?: React.ReactNode }) {
  if (!children) return null
  // a connection failure in words, the raw text kept beneath it
  if (typeof children === 'string') {
    const e = plainError(children)
    if (e.detail) {
      return (
        <View accessibilityRole="alert" style={{ gap: 2 }}>
          <Text style={s.problem}>{e.text}</Text>
          <Text style={[t.small, { fontSize: 11, color: C.faint }]} numberOfLines={2}>{e.detail}</Text>
        </View>
      )
    }
  }
  return <Text accessibilityRole="alert" style={s.problem}>{children}</Text>
}

/** A screen's data could not be read because a service is unreachable: say which, and try again. */
export function Offline({ error, onRetry, busy }: { error?: string | null; onRetry: () => void; busy?: boolean }) {
  if (!error || !isConnectionError(error)) return null
  const e = plainError(error)
  const title = e.kind === 'relay' ? 'Not connected to the relay' : e.kind === 'chain' ? 'Not connected to the Bitcoin server' : e.kind === 'lender' ? 'No answer yet' : 'Not connected'
  return (
    <View style={{ gap: 10 }}>
      <Note tone="warn" icon="info" title={title} sub={e.text} />
      <Button kind="secondary" label="Try again" busy={busy} onPress={onRetry} />
    </View>
  )
}

/** What the phone is doing right now (keeps the person from tapping again). */
export function Working({ label }: { label?: string | null }) {
  if (!label) return null
  return (
    <View style={s.working} accessibilityLiveRegion="polite">
      <ActivityIndicator color={C.ink} />
      <Text style={t.small}>{label}</Text>
    </View>
  )
}

export function Field(props: TextInputProps & { label: string; hint?: string }) {
  const { label, hint, style, ...rest } = props
  return (
    <View style={{ gap: 6 }}>
      <Text style={t.small}>{label}</Text>
      <TextInput autoCapitalize="none" autoCorrect={false} placeholderTextColor={C.faint} accessibilityLabel={label} {...rest} style={[s.input, style]} />
      {hint ? <Text style={t.tiny}>{hint}</Text> : null}
    </View>
  )
}

export function Spacer() { return <View style={s.flex} /> }

export type TabId = 'passbook' | 'agenda' | 'lend' | 'market' | 'wallet'
const TABS: { id: TabId; label: string; icon: BrandIconName }[] = [
  { id: 'passbook', label: 'Passbook', icon: 'passbook' },
  { id: 'agenda', label: 'Agenda', icon: 'agenda' },
  { id: 'lend', label: 'Lend', icon: 'lend' },
  { id: 'market', label: 'Market', icon: 'market' },
  { id: 'wallet', label: 'Wallet', icon: 'wallet' },
]
export function TabBar({ tab, onTab }: { tab: TabId; onTab: (t: TabId) => void }) {
  return (
    <View style={s.tabBar} accessibilityRole="tablist" accessibilityLabel="Sections">
      {TABS.map((x) => {
        const on = x.id === tab
        return (
          <Pressable key={x.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onTab(x.id)} style={s.tab}>
            <BrandIcon name={x.icon} color={on ? C.ink : C.muted} />
            <Text style={[s.tabText, on ? { color: C.ink, fontFamily: F.semibold } : null]}>{x.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: C.bg },
  badge: { paddingVertical: 4, alignItems: 'center', backgroundColor: C.test },
  badgeText: { fontFamily: F.bold, fontSize: 11, letterSpacing: 0.6, color: C.testText },
  topWrap: { paddingHorizontal: 20, paddingTop: 12 },
  topBar: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  spacer: { width: 44, height: 44 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  stopN: { fontFamily: F.semibold, fontSize: 12, letterSpacing: 0.5, color: C.muted, minWidth: 44, textAlign: 'right' },
  scroll: { flexGrow: 1 },
  body: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20, flexGrow: 1 },
  bottom: { paddingHorizontal: 20, paddingBottom: 12, paddingTop: 8, gap: 8, backgroundColor: C.bg },
  hero: { alignItems: 'center', gap: 6, paddingTop: 8 },
  center: { textAlign: 'center' },
  topLine: { borderTopWidth: 1, borderTopColor: C.divider },
  divider: { borderBottomWidth: 1, borderBottomColor: C.divider },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowK: { ...t.body, color: C.muted, flexShrink: 0 },
  rowV: { ...t.bodyMedium, flexShrink: 1, textAlign: 'right' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  tx: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  primary: { height: 56, borderRadius: R.button, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { fontFamily: F.medium, fontSize: 17, color: C.white },
  secondary: { height: 52, borderRadius: R.button, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  outline: { height: 56, borderRadius: R.button, backgroundColor: C.white, borderWidth: 1, borderColor: C.handle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  secondaryText: { fontFamily: F.medium, fontSize: 16, color: C.ink },
  ghost: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontFamily: F.regular, fontSize: 15, color: C.muted },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  chip: { alignSelf: 'flex-start', height: 32, paddingHorizontal: 12, borderRadius: R.chip, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipOn: { backgroundColor: C.ink },
  chipText: { fontFamily: F.medium, fontSize: 13, color: C.muted },
  tag: { fontFamily: F.bold, fontSize: 11, letterSpacing: 0.5, borderRadius: R.tag, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  seg: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 12, padding: 4 },
  segItem: { flex: 1, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.white, elevation: 1, shadowColor: C.ink, shadowOpacity: 0.12, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
  segText: { fontFamily: F.medium, fontSize: 15, color: C.muted },
  choices: { flexDirection: 'row', gap: 10 },
  choice: { flex: 1, height: 48, borderRadius: 12, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  choiceOn: { backgroundColor: C.ink },
  choiceText: { fontFamily: F.medium, fontSize: 16, color: C.ink },
  scrim: { flex: 1, backgroundColor: C.scrim, justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.white, borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 28, gap: 16 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.handle, alignSelf: 'center' },
  disclosure: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  disclosed: { gap: 10, paddingBottom: 12 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  bar4: { flexDirection: 'row', gap: 6 },
  bar: { flex: 1, height: 4, borderRadius: 2 },
  ladder: { flexDirection: 'row', gap: 6 },
  ladderCol: { flex: 1, gap: 6, alignItems: 'center' },
  ladderBar: { width: '100%', height: 8, borderRadius: 4 },
  stamp: { transform: [{ rotate: '-6deg' }], borderWidth: 3, borderColor: C.green, color: C.green, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, fontFamily: F.semibold, fontSize: 16, letterSpacing: 1.5 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: R.button },
  problem: { ...t.body, color: C.warn, backgroundColor: C.warnBg, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, overflow: 'hidden' },
  working: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 32 },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontFamily: F.regular, fontSize: 16, color: C.ink, backgroundColor: C.white },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg, marginHorizontal: -20, marginBottom: -12 },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingTop: 10, paddingBottom: 12 },
  tabText: { fontFamily: F.medium, fontSize: 12, color: C.muted },
})
