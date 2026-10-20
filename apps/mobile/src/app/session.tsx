// The app's one session: the worklet's Passbook module behind device ports, the laptop's
// platform and relay (through adb reverse), the agents' state in app storage, and the
// flows that run the borrower's (and the lender's) side. No key or seed is kept here:
// the state holds only public loan data and signatures (src/agent/session.ts before M6).
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useModule } from '@tetherto/wdk-react-native-core'
import { createMMKV } from 'react-native-mmkv'
import { chainPort, partySigner, rgbPort, type PassbookModuleCalls } from '../agent/device'
import { PhoneBorrower, relayWindow, type PhoneAgentState, type Step } from '../agent/borrower'
import { PhoneLender, lenderRelayWindow, type PhoneLenderState } from '../agent/lender'
import { repayPort, type LenderModuleCalls } from '../agent/device'
import { Directory, File, Paths } from 'expo-file-system'
import { base64 } from '@scure/base'
import { PhonePlatform } from '../agent/platform'
import { labelledEventSigner, PhoneRelay } from '../agent/relay'
import { NostrPlatformCall } from '../agent/platform-nostr'
import type { ChainPort, PartySigner, RgbPort } from '../agent/ports'
import { NETWORK, WALLET_ID } from '../wallet/config'
import { testLabelTags } from '../core/network'
import { activeWallet } from '../wallet/flags'
import type { PersonaRecord } from './persona'
import type { useBtcAccount } from '../wallet/btc'
import { BorrowFlow } from './borrow-flow'
import { checkSigner } from './credit-check'
import { pinnedScorerKeys } from './scorer-keys'
import { LendFlow } from './lend-flow'
import type { ReservePorts, Unspent } from './reserve'
import { Store } from './store'

const store = createMMKV({ id: 'passbook-agent' })
/**
 * The agents' state belongs to one wallet on one network: the person's own on regtest keeps the
 * M3/M6 keys (so the phone keeps its passbook); the seeded test persona's sits under its own wallet
 * id, and another network's under its name, so nothing mixes.
 */
export const agentKey = (base: 'borrower-state-v1' | 'lender-state-v1', walletId: string, network: string = NETWORK.name): string =>
  `${walletId === WALLET_ID ? base : `${base}:${walletId}`}${network === 'regtest' ? '' : `@${network}`}`
const PREFS_KEY = 'prefs-v1'

/** REGTEST TEST DATA: start the seeded persona's agent state with its record (no words, no backup). */
export function seedPersonaState(walletId: string, persona: PersonaRecord): void {
  const state: PhoneAgentState = { loans: {}, labels: {}, persona }
  store.set(agentKey('borrower-state-v1', walletId), JSON.stringify(state))
}

function loadJson<T>(key: string, ok: (v: T) => boolean, fallback: () => T): T {
  try {
    const raw = store.getString(key)
    if (raw) { const v = JSON.parse(raw) as T; if (v && ok(v)) return v }
  } catch { /* a damaged record starts fresh */ }
  return fallback()
}

export interface Prefs { chainDetails: boolean }

interface BtcSide { settled: number; future: number; spendable: number }
/** The worklet calls the app makes beyond the agents' ports. */
export type AppModule = Omit<PassbookModuleCalls, 'rgbAssets'> & LenderModuleCalls & {
  rgbAssets(): Promise<{ assetId: string; ticker: string; name: string; precision: number; balance: BtcSide }[]>
  rgbAddress(): Promise<string>
  rgbBtcBalance(o?: { skipSync?: boolean }): Promise<{ vanilla: BtcSide; colored: BtcSide }>
  rgbUnspents(o?: { skipSync?: boolean }): Promise<Unspent[]>
  rgbCreateUtxos(o: { num?: number; size?: number; feeRate?: number }): Promise<number>
  rgbDecodeInvoice(invoice: string): Promise<{ recipientId: string; assetId?: string | null; network?: string; expirationTimestamp?: number | null; transportEndpoints: string[]; assignment?: unknown }>
  rgbFailPending(o: { batchTransferIdx?: number | null }): Promise<{ batchTransferIdx: number; transfersChanged?: boolean; cannotFail?: boolean; refused?: string; txid?: string | null }[]>
}

export interface AppSession {
  module: AppModule
  key: PartySigner
  chain: ChainPort
  rgb: RgbPort
  platform: PhonePlatform
  relay: PhoneRelay
  borrowerState: PhoneAgentState
  borrower(assetId: string): PhoneBorrower
  borrow: BorrowFlow
  lenderState: PhoneLenderState
  lender(assetId: string): PhoneLender
  lend: LendFlow
  /** what the agents did, newest last: the Check and Raw views read it */
  steps: Store<Step[]>
  /** bumps whenever an agent's stored state changes */
  version: Store<number>
  prefs: Store<Prefs>
  setPrefs(p: Partial<Prefs>): void
  reserve(): ReservePorts
  btc: ReturnType<typeof useBtcAccount>
}

const Ctx = createContext<{ session: AppSession | null; error: string | null }>({ session: null, error: null })

export function useApp(): AppSession {
  const { session } = useContext(Ctx)
  if (!session) throw new Error('the wallet session is not ready')
  return session
}
export function useAppStatus() { return useContext(Ctx) }

export function AppProvider({ btc, children }: { btc: ReturnType<typeof useBtcAccount>; children: React.ReactNode }) {
  const m = useModule<AppModule>('passbook')
  const [session, setSession] = useState<AppSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the main account's functions change identity on every render; the reserve reads the latest
  const btcRef = useRef(btc)
  btcRef.current = btc

  useEffect(() => {
    let relay: PhoneRelay | null = null
    let cancelled = false
    void (async () => {
      try {
        const key = await partySigner(m)
        const chain = chainPort(m)
        const rgb = rgbPort(m)
        const walletId = activeWallet.get(WALLET_ID)
        const BORROWER_KEY = agentKey('borrower-state-v1', walletId), LENDER_KEY = agentKey('lender-state-v1', walletId)
        const borrowerState = loadJson<PhoneAgentState>(BORROWER_KEY, (s) => !!s.loans && !!s.labels, () => ({ loans: {}, labels: {} }))
        const lenderState = loadJson<PhoneLenderState>(LENDER_KEY, (s) => !!s.loans, () => ({ loans: {}, declined: [] }))
        lenderState.declined ??= []
        // after a restart the relay listens back to the oldest unfinished loan of either role, and
        // never hands out an event it handled before (ids kept with the borrower's state)
        const lw = lenderRelayWindow(lenderState)
        relay = new PhoneRelay(key, NETWORK.relays, {
          labels: testLabelTags(NETWORK), network: NETWORK,
          since: Math.min(relayWindow(borrowerState), lw ?? Infinity),
          seen: borrowerState.relay_seen ?? [],
          onSeen: (id) => { borrowerState.relay_seen = [...(borrowerState.relay_seen ?? []).slice(-299), id]; store.set(BORROWER_KEY, JSON.stringify(borrowerState)) },
        })
        // the platform over Nostr when the provider's link named its key (no route to the laptop needed); the LAN address is the fallback
        const nostrPlatform = NETWORK.platformPk ? new NostrPlatformCall({
          transport: relay.transport(),
          signer: { ...checkSigner(key), signEvent: labelledEventSigner(key, testLabelTags(NETWORK)), signRequest: (r) => key.signRequest(r) },
          platformPk: NETWORK.platformPk,
        }) : null
        const platform = new PhonePlatform(NETWORK.platform, key, nostrPlatform)
        const version = new Store(0)
        const steps = new Store<Step[]>([])
        const prefs = new Store<Prefs>(loadJson<Prefs>(PREFS_KEY, (p) => typeof p.chainDetails === 'boolean', () => ({ chainDetails: false })))
        const saveBorrower = async () => { store.set(BORROWER_KEY, JSON.stringify(borrowerState)); version.set((v) => v + 1) }
        const onStep = (s: Step) => steps.set((prev) => [...prev.slice(-80), s])
        const agents = new Map<string, PhoneBorrower>()
        const borrower = (assetId: string) => {
          let a = agents.get(assetId)
          if (!a) { a = new PhoneBorrower(key, platform, relay!, chain, rgb, assetId, borrowerState, onStep, saveBorrower); agents.set(assetId, a); void a.flushOutbox() }
          return a
        }
        const reserve = (): ReservePorts => ({
          main: {
            balance: async () => { await btcRef.current.refresh(); return btcRef.current.balance ?? 0n },
            quote: (to, sats) => btcRef.current.quote(to, sats),
            sign: (to, sats, fee) => btcRef.current.sign(to, sats, fee),
            broadcast: (hex) => btcRef.current.broadcast(hex),
          },
          rgb: m,
          chain,
          party: { address: key.btc.address, script: key.btc.script },
        })
        // Optional public signer restrictions supplement the explicitly selected operator and signed release.
        const borrow = new BorrowFlow(borrower, borrowerState, reserve, () => version.set((v) => v + 1), pinnedScorerKeys)
        const saveLender = async () => { store.set(LENDER_KEY, JSON.stringify(lenderState)); version.set((v) => v + 1) }
        // rgb-lib restores the platform's backup from a file: write it beside the loans and make the loan's empty directory
        const repay = repayPort(m, async (loanId, b64) => {
          new Directory(Paths.document, 'rgb-loans', loanId).create({ intermediates: true, idempotent: true })
          const f = new File(Paths.document, 'rgb-loans', `${loanId}.backup`)
          if (f.exists) f.delete()
          f.create()
          f.write(base64.decode(b64))
          return decodeURIComponent(f.uri.replace(/^file:\/\//, ''))
        })
        const lenders = new Map<string, PhoneLender>()
        const lender = (assetId: string) => {
          let a = lenders.get(assetId)
          if (!a) { a = new PhoneLender(key, platform, relay!, chain, rgb, repay, assetId, lenderState, onStep, saveLender); lenders.set(assetId, a); void a.flushOutbox() }
          return a
        }
        const lend = new LendFlow(lender, lenderState, reserve, () => { void saveLender() })
        if (cancelled) return relay.close()
        const s: AppSession = {
          module: m, key, chain, rgb, platform, relay, borrowerState, borrower, borrow, lenderState, lender, lend, steps, version, prefs,
          setPrefs: (p) => { prefs.set((x) => ({ ...x, ...p })); store.set(PREFS_KEY, JSON.stringify(prefs.get())) },
          reserve,
          get btc() { return btcRef.current },
        }
        setSession(s)
        borrow.resume()
        lend.resume()
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => { cancelled = true; relay?.close() }
  }, [m])

  const value = useMemo(() => ({ session, error }), [session, error])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
