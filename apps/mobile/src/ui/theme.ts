// The design canvas's tokens ("Passbook mobile app"): one light look, IBM Plex Sans,
// one dark ink, one green. Screen rules from the canvas: one job per screen, one
// number in large type, one primary button at the bottom, explanations behind a
// tap, "Can't be undone" under every button that moves money or signs.
import type { TextStyle } from 'react-native'

export const C = {
  bg: '#FFFFFF',
  ink: '#14201F',
  muted: '#5B6663',
  faint: '#8A9491',
  surface: '#F4F6F5',
  divider: '#EEF1F0',
  border: '#E3E7E5',
  track: '#D5DBD8',
  handle: '#C9D0CD',
  green: '#1E6B52',
  greenBg: '#E7F2EE',
  amber: '#8A5A00',
  amberBg: '#FFF6E5',
  warn: '#8A4B0F',
  warnBg: '#FBF1E4',
  scrim: 'rgba(20,32,31,0.4)',
  white: '#FFFFFF',
  // the REGTEST badge: test coins never look real
  test: '#F5A524',
  testText: '#1A1300',
} as const

/** Android names an embedded font by its file: one family per weight (app.json, expo-font). */
export const F = {
  regular: 'IBMPlexSans_400Regular',
  medium: 'IBMPlexSans_500Medium',
  semibold: 'IBMPlexSans_600SemiBold',
  bold: 'IBMPlexSans_700Bold',
  mono: 'IBMPlexMono_400Regular',
} as const

export const t = {
  title: { fontFamily: F.semibold, fontSize: 15, color: C.ink } satisfies TextStyle,
  big: { fontFamily: F.semibold, fontSize: 44, letterSpacing: -0.5, lineHeight: 50, color: C.ink } satisfies TextStyle,
  mid: { fontFamily: F.semibold, fontSize: 32, letterSpacing: -0.3, lineHeight: 38, color: C.ink } satisfies TextStyle,
  body: { fontFamily: F.regular, fontSize: 15, lineHeight: 22, color: C.ink } satisfies TextStyle,
  bodyMedium: { fontFamily: F.medium, fontSize: 15, lineHeight: 22, color: C.ink } satisfies TextStyle,
  sub: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.muted } satisfies TextStyle,
  small: { fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: C.muted } satisfies TextStyle,
  tiny: { fontFamily: F.regular, fontSize: 12, lineHeight: 16, color: C.muted } satisfies TextStyle,
  mono: { fontFamily: F.mono, fontSize: 12, lineHeight: 17, color: C.ink } satisfies TextStyle,
  h2: { fontFamily: F.semibold, fontSize: 20, lineHeight: 26, color: C.ink } satisfies TextStyle,
}

export const R = { button: 14, card: 20, sheet: 22, chip: 16, tag: 6 } as const
