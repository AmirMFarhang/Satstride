// A value that screens subscribe to. The agents' flows live outside the screens, so a
// loan keeps going while the person switches tabs; each screen just renders the latest.
import { useSyncExternalStore } from 'react'

export class Store<T> {
  private listeners = new Set<() => void>()
  constructor(private value: T) {}
  get(): T { return this.value }
  set(next: T | ((prev: T) => T)): void {
    this.value = typeof next === 'function' ? (next as (prev: T) => T)(this.value) : next
    for (const l of this.listeners) l()
  }
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.get())
}
