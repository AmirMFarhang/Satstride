// The canvas's icons: 24-unit stroke paths, decor only (the control around one carries the label).
import React from 'react'
import Svg, { Circle, Path } from 'react-native-svg'
import { C } from './theme'

const PATHS = {
  back: { d: ['M15 5l-7 7 7 7'], w: 2 },
  next: { d: ['M9 5l7 7-7 7'], w: 2 },
  down: { d: ['M6 9l6 6 6-6'], w: 2 },
  check: { d: ['M5 12l5 5 9-10'], w: 2.6 },
  close: { d: ['M18 6L6 18M6 6l12 12'], w: 1.8 },
  arrow: { d: ['M5 12h14M13 6l6 6-6 6'], w: 1.8 },
  up: { d: ['M7 17L17 7M9 7h8v8'], w: 2.4 },
  edit: { d: ['M4 20h4L19 9l-4-4L4 16z'], w: 2 },
  refund: { d: ['M4 12a8 8 0 1 0 3-6.2M4 4v4h4'], w: 2.2 },
  gear: { d: ['M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1'], w: 1.8, circle: { r: 3 } },
  info: { d: ['M12 11v5M12 8h.01'], w: 2, circle: { r: 9 } },
  alert: { d: ['M12 7v6M12 16h.01'], w: 2, circle: { r: 9 } },
  clock: { d: ['M12 7v5l3 2'], w: 2, circle: { r: 9 } },
  passbook: { d: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11'], w: 1.8 },
  logo: { d: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11', 'M10 8l1.5 1.5L15 6'], w: 1.6 },
  market: { d: ['M4 6h16M4 12h16M4 18h10'], w: 1.8 },
  wallet: { d: ['M3 7a2 2 0 0 1 2-2h14v14H5a2 2 0 0 1-2-2z', 'M15 12h2'], w: 1.8 },
  // not on the canvas: the Lend tab, drawn in the same stroke style (coins going out)
  lend: { d: ['M4 8c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z', 'M4 8v4c0 1.7 3.1 3 7 3', 'M4 12v4c0 1.7 3.1 3 7 3', 'M15 17h6M18 14l3 3-3 3'], w: 1.8 },
  copy: { d: ['M9 9h10v10H9z', 'M5 15V5h10'], w: 1.8 },
  share: { d: ['M12 3v12M7 8l5-5 5 5', 'M5 13v6h14v-6'], w: 1.8 },
  plus: { d: ['M12 5v14M5 12h14'], w: 2 },
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 22, color = C.ink, strokeWidth }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const p = PATHS[name]
  const w = strokeWidth ?? p.w
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {'circle' in p ? <Circle cx={12} cy={12} r={p.circle.r} /> : null}
      {p.d.map((d) => <Path key={d} d={d} />)}
    </Svg>
  )
}

/** The canvas's "sending" ring: a quarter arc over a light track, turning while it waits. */
export function Ring({ size = 40 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Circle cx={20} cy={20} r={16} fill="none" stroke={C.border} strokeWidth={4} />
      <Path d="M20 4a16 16 0 0 1 16 16" fill="none" stroke={C.ink} strokeWidth={4} strokeLinecap="round" />
    </Svg>
  )
}
