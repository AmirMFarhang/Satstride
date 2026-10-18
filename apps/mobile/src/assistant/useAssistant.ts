// The help sheet's state: the conversation, whether the provider's help agent is
// reachable and what answers there (its model label), and `ask`. The phone asks
// with a throwaway key made when the sheet first opens (never the wallet's key),
// and reads the context only when a question is sent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Hex } from '../../../../src/core/crypto.js'
import { askAssistant, discoverAssistant, ephemeralSigner, type AssistAnswer } from '../../../../src/assistant/client.js'
import { assistContext, type AssistContextInput, type AssistInfo, type AssistSigner, type AssistTransport } from '../../../../src/assistant/protocol.js'
import { renderableIntent, statusAfterAnswer, statusAfterLookup, type AssistantStatus } from './context'

export interface AssistantConfig {
  /** the relay connection the app already has (poolTransport over its SimplePool); null when offline */
  transport: AssistTransport | null
  /** the provider's help agent key, pinned at build or pairing; when absent it is discovered from the relay */
  assistantPk?: Hex | null
  /** what to share, read at the moment a question is sent */
  context: () => AssistContextInput
  /** how long to wait for the provider before answering from this phone, default 30 s */
  timeoutMs?: number
  /** the screens the navigator registers (Main.tsx SCREENS keys): an answer's button only for one of these */
  screens: readonly string[]
}

export interface Turn { id: number; question: string; answer: AssistAnswer | null }

export type { AssistantStatus }

export interface Assistant {
  visible: boolean
  open(): void
  close(): void
  turns: Turn[]
  busy: boolean
  ask(question: string): Promise<AssistAnswer | null>
  /** the provider's help agent, when found: its key and what answers there */
  info: AssistInfo | null
  status: AssistantStatus
  clear(): void
}

// babel-preset-expo inlines only literal EXPO_PUBLIC_* reads
const PINNED = (process.env.EXPO_PUBLIC_PASSBOOK_ASSISTANT_PK ?? '').trim().toLowerCase()
const pinnedKey = (): Hex | null => (/^[0-9a-f]{64}$/.test(PINNED) ? (PINNED as Hex) : null)

export function useAssistant(cfg: AssistantConfig): Assistant {
  const [visible, setVisible] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [info, setInfo] = useState<AssistInfo | null>(null)
  const [status, setStatus] = useState<AssistantStatus>('looking')
  const signer = useRef<AssistSigner | null>(null)
  const nextId = useRef(1)
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const pk = cfg.assistantPk ?? pinnedKey()

  // look for the provider's INFO each time the sheet opens: who answers, and whether anyone does
  // (the transport is read through the ref: a new object on each render does not restart the lookup)
  const hasTransport = !!cfg.transport
  useEffect(() => {
    if (!visible) return
    let live = true
    const transport = cfgRef.current.transport
    if (!transport) { setStatus((s) => statusAfterLookup(s, { transport: false, found: false, pinned: !!pk })); return }
    setStatus((s) => (s === 'online' ? s : 'looking'))
    void discoverAssistant(transport, { authors: pk ? [pk] : undefined, waitMs: 3000 }).then((found) => {
      if (!live) return
      setInfo(found)
      // a pinned key is an identity, not proof the provider is up
      setStatus((s) => statusAfterLookup(s, { transport: true, found: !!found, pinned: !!pk }))
    })
    return () => { live = false }
  }, [visible, hasTransport, pk])

  const ask = useCallback(async (question: string) => {
    const q = question.trim()
    if (!q) return null
    signer.current ??= ephemeralSigner()
    const id = nextId.current++
    setTurns((t) => [...t, { id, question: q, answer: null }])
    const c = cfgRef.current
    const answer = await askAssistant({
      transport: c.transport,
      signer: signer.current,
      assistantPk: pk ?? info?.assistant_pk ?? null,
      question: q,
      context: assistContext(c.context()),
      timeoutMs: c.timeoutMs,
    })
    const shown = { ...answer, intent: renderableIntent(answer.intent, c.screens) }
    setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer: shown } : x)))
    setStatus((s) => statusAfterAnswer(s, answer))
    return shown
  }, [pk, info])

  const busy = turns.some((t) => !t.answer)
  return useMemo(() => ({
    visible, open: () => setVisible(true), close: () => setVisible(false),
    turns, busy, ask, info, status, clear: () => setTurns((t) => t.filter((x) => !x.answer)),
  }), [visible, turns, busy, ask, info, status])
}
