// When a one-shot animation (the page stamped, the splash's seal) may run, from the person's
// reduce-motion setting as useReducedMotion reports it: null while the setting is still being
// read. Until it is known nothing plays and nothing is marked as played, so a person with reduce
// motion never sees half a page turn. No React Native here, so the tests run it.

export type MotionPlan = 'wait' | 'skip' | 'jump' | 'play'

/**
 * wait  the setting is not known yet: do nothing, mark nothing
 * skip  this moment already played (or jumped) once
 * jump  reduce motion is on: show the end state at once
 * play  animate
 */
export function motionPlan(reduced: boolean | null, alreadyPlayed: boolean): MotionPlan {
  if (reduced === null) return 'wait'
  if (alreadyPlayed) return 'skip'
  return reduced ? 'jump' : 'play'
}

/** For loops and small transitions: animate only once the setting is known to be off. */
export const mayAnimate = (reduced: boolean | null): reduced is false => reduced === false
