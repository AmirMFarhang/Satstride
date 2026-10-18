// Reduce motion: when the person turned animations off in Android's accessibility settings,
// every motion component shows its end state at once (no travel, no shimmer, no page turn)
// and still says the same thing. Read once, then followed live. It is null until the first
// read returns: one-shot moments wait for it (motion-plan.ts), loops start only once it is false.
import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated } from 'react-native'

export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    // a failed read counts as "not reduced": the components still say everything without motion
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setReduced(v) }, () => { if (live) setReduced(false) })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => { live = false; sub.remove() }
  }, [])
  return reduced
}

/**
 * A value that goes from 0 to 1 once, when the reduce-motion setting is known: at once with
 * reduce motion on, through `run` with it off. Entrances (a card, a tick, the splash's mark).
 */
export function useEntrance(reduced: boolean | null, run: (v: Animated.Value) => Animated.CompositeAnimation): Animated.Value {
  const v = useRef(new Animated.Value(0)).current
  const done = useRef(false)
  useEffect(() => {
    if (reduced === null || done.current) return
    done.current = true
    if (reduced) { v.setValue(1); return }
    run(v).start()
  }, [reduced]) // eslint-disable-line react-hooks/exhaustive-deps
  return v
}
