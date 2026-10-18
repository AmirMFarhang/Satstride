// The agent on call on the phone: drop-ins for M8.
//
//   const assistant = useAssistant({ transport: session.relay.transport(), screens: Object.keys(SCREENS),
//     context: () => contextInput({ tab: nav.tab, screen, height, passbook, loans, testPersona: !!session.borrowerState.persona }) })
//   <AskButton onPress={assistant.open} busy={assistant.busy} />
//   <AssistantSheet assistant={assistant} onGo={(r) => nav.go(r.tab, r.name, r.params)} />
//
// Both sit inside the Navigator (useNav). The provider's key comes from
// EXPO_PUBLIC_PASSBOOK_ASSISTANT_PK, else from its INFO event on the relay.
export { useAssistant, type Assistant, type AssistantConfig, type AssistantStatus, type Turn } from './useAssistant'
export { AskButton, AskIcon } from './AskButton'
export { AssistantSheet, FALLBACK_WORDS, labelWords } from './AssistantSheet'
export { checkOutcome, contextInput, loanBrief, loanStateFromStage, renderableIntent, statusAfterAnswer, statusAfterLookup, usdtText } from './context'
export { routeFor, type AssistRoute } from '../../../../src/assistant/protocol.js'
