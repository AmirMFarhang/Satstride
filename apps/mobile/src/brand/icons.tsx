// The stroke icon set (icon-paths.ts) as react-native-svg components. Decor only: the control
// around an icon carries its label, as with the canvas's Icon (src/ui/icons.tsx).
import React from 'react'
import Svg, { Circle, Path } from 'react-native-svg'
import { C } from '../ui/theme'
import { ICON_PATHS, STROKE, type BrandIconName, type IconDef } from './icon-paths'

export type { BrandIconName } from './icon-paths'
export { TAB_ICONS } from './icon-paths'

export interface BrandIconProps {
  name: BrandIconName
  size?: number
  color?: string
  strokeWidth?: number
}

export function BrandIcon({ name, size = 22, color = C.ink, strokeWidth }: BrandIconProps) {
  const p: IconDef = ICON_PATHS[name]
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth ?? p.w ?? STROKE} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {(p.c ?? []).map(([cx, cy, r]) => <Circle key={`${cx},${cy},${r}`} cx={cx} cy={cy} r={r} />)}
      {p.d.map((d) => <Path key={d} d={d} />)}
    </Svg>
  )
}
