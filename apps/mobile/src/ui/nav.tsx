// Four tabs (Passbook, Lend, Market, Wallet), each with its own stack of screens. The
// phone's back button pops the stack first; leaving the app locks the wallet, so back
// only leaves from the Passbook tab's first screen.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { BackHandler } from 'react-native'
import type { TabId } from './kit'

export interface Route { name: string; params?: Record<string, unknown> }

export interface Nav {
  tab: TabId
  push(name: string, params?: Record<string, unknown>): void
  replace(name: string, params?: Record<string, unknown>): void
  pop(): void
  root(): void
  /** to a tab, starting it at `name` (or its first screen) */
  go(tab: TabId, name?: string, params?: Record<string, unknown>): void
  /** to a tab as the person left it */
  switchTab(tab: TabId): void
}

const NavCtx = createContext<Nav | null>(null)
export function useNav(): Nav {
  const n = useContext(NavCtx)
  if (!n) throw new Error('no navigator')
  return n
}

const EMPTY: Record<TabId, Route[]> = { passbook: [], agenda: [], lend: [], market: [], wallet: [] }

export function Navigator({ roots, screens }: { roots: Record<TabId, React.ComponentType>; screens: Record<string, React.ComponentType<{ params: Record<string, unknown> }>> }) {
  const [tab, setTab] = useState<TabId>('passbook')
  const [stacks, setStacks] = useState<Record<TabId, Route[]>>(EMPTY)

  const nav = useMemo<Nav>(() => ({
    tab,
    push: (name, params) => setStacks((s) => ({ ...s, [tab]: [...s[tab], { name, params }] })),
    replace: (name, params) => setStacks((s) => ({ ...s, [tab]: [...s[tab].slice(0, -1), { name, params }] })),
    pop: () => setStacks((s) => ({ ...s, [tab]: s[tab].slice(0, -1) })),
    root: () => setStacks((s) => ({ ...s, [tab]: [] })),
    go: (t, name, params) => { setTab(t); setStacks((s) => ({ ...s, [t]: name ? [{ name, params }] : [] })) },
    switchTab: (t) => setTab(t),
  }), [tab])

  const onBack = useCallback(() => {
    if (stacks[tab].length) { nav.pop(); return true }
    if (tab !== 'passbook') { setTab('passbook'); return true }
    return false
  }, [stacks, tab, nav])
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack)
    return () => sub.remove()
  }, [onBack])

  const top = stacks[tab].at(-1)
  const Root = roots[tab]
  const Top = top ? screens[top.name] : null
  return (
    <NavCtx.Provider value={nav}>
      {Top ? <Top key={`${tab}:${stacks[tab].length}:${top!.name}`} params={top!.params ?? {}} /> : <Root key={tab} />}
    </NavCtx.Provider>
  )
}

/** The tab bar wired to the navigator: tapping the current tab goes to its first screen, another keeps its stack. */
export function useTabSwitch() {
  const nav = useNav()
  return (t: TabId) => (t === nav.tab ? nav.root() : nav.switchTab(t))
}
