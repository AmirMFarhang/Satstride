// The floating "ask" button: bottom right, above the tab bar, on every tab. It
// opens the agent-on-call sheet. Stroke icon in the canvas's style (D1's icon set
// can replace it).
import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import { C } from '../ui/theme'

/** A speech bubble with a question mark, 24-unit stroke paths like src/ui/icons.tsx. */
export function AskIcon({ size = 24, color = C.white }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 5h16v11H9l-4 4v-4H4z" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      <Path d="M10 9a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx={12} cy={14.2} r={0.9} fill={color} />
    </Svg>
  )
}

export function AskButton({ onPress, bottom = 92, busy = false }: { onPress: () => void; bottom?: number; busy?: boolean }) {
  return (
    <View pointerEvents="box-none" style={[st.wrap, { bottom }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Ask the agent on call" accessibilityHint="Questions about the app. It can't move money or see your keys."
        onPress={onPress} style={({ pressed }) => [st.button, pressed ? st.pressed : null]} hitSlop={8}>
        <AskIcon />
        {busy ? <View style={st.dot} /> : null}
      </Pressable>
    </View>
  )
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', right: 20 },
  button: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: C.ink, shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.96 }] },
  dot: { position: 'absolute', top: 12, right: 12, width: 9, height: 9, borderRadius: 5, backgroundColor: C.test, borderWidth: 1.5, borderColor: C.ink },
})
