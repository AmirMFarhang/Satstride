// The unlocked wallet: one session for both roles, four tabs (Passbook, Lend, Market,
// Wallet) and the screens each tab opens. Settings opens from the gear on any tab.
import React, { useState } from 'react'
import { View } from 'react-native'
import { useBtcAccount } from '../wallet/btc'
import { AppProvider, useApp, useAppStatus } from '../app/session'
import { NetworkBadge, P, Problem } from './kit'
import { C } from './theme'
import { SplashMark } from '../motion/SplashMark'
import { AgendaTab } from './AgendaTab'
import { Navigator, useNav } from './nav'
import { AskButton, AssistantSheet, contextInput, useAssistant } from '../assistant'
import { PassbookTab } from './borrow/PassbookTab'
import { BorrowAmount } from './borrow/BorrowAmount'
import { Offers } from './borrow/Offers'
import { Rules } from './borrow/Rules'
import { BorrowFlow } from './borrow/BorrowFlow'
import { Pay, Repayment } from './borrow/Pay'
import { MarginCall, PageScreen, PagesList } from './borrow/Pages'
import { CheckLoan, Receipt } from './borrow/LoanCheck'
import { MarketTab } from './market/MarketTab'
import { WalletTab } from './wallet/WalletTab'
import { Receive } from './wallet/Receive'
import { SendBitcoin, SendCheck, SendCheckDone, SendUsdt } from './wallet/Send'
import { Settings, WalletHealth, Words } from './wallet/Settings'
import { Persona } from './wallet/Persona'
import { NetworkSettings } from './wallet/Network'
import { LendTab, LEND_SCREENS } from './lend/LendTab'

const SCREENS = {
  'borrow-amount': BorrowAmount,
  rules: Rules,
  offers: Offers,
  borrow: BorrowFlow,
  pay: Pay,
  repayment: Repayment,
  page: PageScreen,
  receipt: Receipt,
  'check-loan': CheckLoan,
  pages: PagesList,
  margin: MarginCall,
  receive: Receive,
  send: SendUsdt,
  'send-btc': SendBitcoin,
  'send-check': SendCheck,
  'send-check-done': SendCheckDone,
  settings: Settings,
  persona: Persona,
  network: NetworkSettings,
  health: WalletHealth,
  words: Words,
  ...LEND_SCREENS,
} as Record<string, React.ComponentType<{ params: Record<string, unknown> }>>

export function Main() {
  const btc = useBtcAccount()
  return (
    <AppProvider btc={btc}>
      <Shell />
    </AppProvider>
  )
}

function Shell() {
  const { session, error } = useAppStatus()
  // the seal stamps only once the session is ready (never on an error), then the app opens
  const [splashDone, setSplashDone] = useState(false)
  if (!session || !splashDone) {
    return (
      <View style={{ flex: 1, backgroundColor: C.green }}>
        <NetworkBadge />
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <SplashMark ready={!!session} waiting={error ? null : 'Starting the wallet engine on this phone'} onDone={() => setSplashDone(true)} />
        </View>
        {error ? <View style={{ padding: 16, backgroundColor: C.bg }}><P>The wallet engine started, but the agents could not.</P><Problem>{error}</Problem></View> : null}
      </View>
    )
  }
  return <Navigator roots={{ passbook: PassbookTab, agenda: AgendaTab, lend: LendTab, market: MarketTab, wallet: WalletTab }} screens={SCREENS} overlay={HelpOverlay} />
}

function HelpOverlay({ screen }: { screen: string }) {
  const session = useApp()
  const nav = useNav()
  const assistant = useAssistant({ transport: session.relay.transport(), screens: Object.keys(SCREENS),
    context: () => contextInput({ tab: nav.tab, screen, testPersona: !!session.borrowerState.persona }),
  })
  return <>
    <AskButton onPress={assistant.open} busy={assistant.busy} bottom={170} />
    <AssistantSheet assistant={assistant} onGo={(r) => nav.go(r.tab, r.name, r.params)} />
  </>
}
