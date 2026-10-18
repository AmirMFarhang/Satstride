// A QR code of a payment request, drawn as one SVG path (qrcode's matrix, error level M).
import React, { useMemo } from 'react'
import Svg, { Path, Rect } from 'react-native-svg'
import { create } from 'qrcode'
import { C } from './theme'

export function Qr({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const { d, n } = useMemo(() => {
    const q = create(value, { errorCorrectionLevel: 'M' })
    const count = q.modules.size
    let path = ''
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.modules.get(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`
    return { d: path, n: count + 8 }
  }, [value])
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} accessibilityRole="image" accessibilityLabel={label}>
      <Rect x={0} y={0} width={n} height={n} fill={C.white} />
      <Path d={d} fill={C.ink} />
    </Svg>
  )
}
