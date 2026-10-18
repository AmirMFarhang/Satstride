// The opening: the passbook appears while the wallet engine starts, and the seal stamps it
// (the check drawing itself) only when the app is really ready: `ready` is the engine's
// own signal (the session is up), never a timer. Then "PassBook" settles under it and
// onDone fires. Drawn on the splash's green so it continues the native splash image; the
// REGTEST badge stays on top as on every screen. With reduce motion the stamped mark shows
// as soon as the app is ready.
import React, { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { F } from '../ui/theme'
import { MARK, PALETTES, type Variant } from '../brand/mark'
import { MarkLayer } from '../brand/Logo'
import { motionPlan } from './motion-plan'
import { useEntrance, useReducedMotion } from './reduce-motion'

export interface SplashMarkProps {
  /** true once the app is ready (e.g. the session exists); the seal stamps then */
  ready: boolean
  onDone?: () => void
  size?: number
  variant?: Variant
  /** what is starting, under the mark while not ready ("Starting the wallet engine on this phone") */
  waiting?: string | null
}

const AnimatedPath = Animated.createAnimatedComponent(Path)

export function SplashMark({ ready, onDone, size = 132, variant = 'onGreen', waiting }: SplashMarkProps) {
  const still = useReducedMotion()
  const p = PALETTES[variant]
  const appear = useEntrance(still, (v) => Animated.timing(v, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: true }))
  const breathe = useRef(new Animated.Value(0)).current
  const seal = useRef(new Animated.Value(0)).current
  const draw = useRef(new Animated.Value(0)).current
  const word = useRef(new Animated.Value(0)).current
  const stamped = useRef(false)

  // while the engine starts, the booklet breathes
  useEffect(() => {
    if (still !== false || ready) { breathe.setValue(0); return }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(breathe, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [ready, still]) // eslint-disable-line react-hooks/exhaustive-deps

  // ready: the seal stamps, the check draws, the name settles (once the reduce-motion setting is known)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => {
    if (!ready) return
    const plan = motionPlan(still, stamped.current)
    if (plan === 'wait' || plan === 'skip') return
    stamped.current = true
    const end = () => { for (const v of [seal, draw, word]) v.setValue(1) }
    if (plan === 'jump') { end(); onDone?.(); return }
    let finishedAll = false
    const anim = Animated.sequence([
      Animated.timing(seal, { toValue: 1, duration: 280, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.parallel([
        Animated.timing(draw, { toValue: 1, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: false }),
        Animated.timing(word, { toValue: 1, duration: 380, delay: 80, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.delay(260),
    ])
    anim.start(({ finished }) => { if (finished) { finishedAll = true; onDone?.() } })
    // interrupted (reduce motion switched on): show the stamped mark and still hand over
    return () => {
      anim.stop()
      if (finishedAll) return
      end()
      if (mounted.current) onDone?.()
    }
  }, [ready, still]) // eslint-disable-line react-hooks/exhaustive-deps

  const booklet = MARK.layers.slice(0, MARK.sealFrom)
  const sealLayers = MARK.layers.slice(MARK.sealFrom)
  const check = sealLayers.at(-1)
  const disc = check && check.el === 'path' && check.stroke ? sealLayers.slice(0, -1) : sealLayers
  const CHECK_LEN = 20
  return (
    <View style={s.wrap} accessible accessibilityRole="image" accessibilityLabel={ready ? 'PassBook' : `PassBook. ${waiting ?? 'Starting'}`}>
      <Animated.View style={{ width: size, height: size, opacity: Animated.multiply(appear, breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 0.72] })), transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }] }}>
        <Svg width={size} height={size} viewBox="0 0 64 64" style={StyleSheet.absoluteFill}>
          {booklet.map((l, i) => <MarkLayer key={i} l={l} p={p} />)}
        </Svg>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: seal, transform: [{ scale: seal.interpolate({ inputRange: [0, 1], outputRange: [1.9, 1] }) }] }]}>
          <Svg width={size} height={size} viewBox="0 0 64 64">
            {disc.map((l, i) => <MarkLayer key={i} l={l} p={p} />)}
            {check && check.el === 'path' && check.stroke && disc !== sealLayers ? (
              <AnimatedPath d={check.d} fill="none" stroke={p[check.stroke]} strokeWidth={check.width ?? 2} strokeLinecap="round" strokeLinejoin="round"
                strokeDasharray={`${CHECK_LEN}`} strokeDashoffset={draw.interpolate({ inputRange: [0, 1], outputRange: [CHECK_LEN, 0] })} />
            ) : null}
          </Svg>
        </Animated.View>
      </Animated.View>
      <Animated.Text style={[s.word, { color: p.ink, opacity: word, transform: [{ translateY: word.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>PassBook</Animated.Text>
      {!ready && waiting ? <Text style={[s.waiting, { color: p.ink }]}>{waiting}</Text> : null}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', gap: 18 },
  word: { fontFamily: F.semibold, fontSize: 30, letterSpacing: -0.4 },
  waiting: { fontFamily: F.regular, fontSize: 13, opacity: 0.8 },
})
