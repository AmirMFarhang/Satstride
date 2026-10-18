// The agent-on-call sheet: a bottom sheet with the conversation. Each answer shows
// who wrote it (the provider's QVAC model or a template, and why a template stood
// in), at most one button to a screen (the person taps it; it only opens the
// screen), and "What I shared": exactly what left the phone, or that nothing did.
import React, { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { AssistAnswer } from '../../../../src/assistant/client.js'
import { intentTitle, routeFor, type AssistRoute, type Fallback } from '../../../../src/assistant/protocol.js'
import { SUGGESTED_QUESTIONS } from '../../../../src/assistant/templates.js'
import { Button, Chip, Disclosure, KV, Tag, Working } from '../ui/kit'
import { Icon } from '../ui/icons'
import { C, F, R, t } from '../ui/theme'
import type { Assistant } from './useAssistant'

/** Why a template answered, in plain words. Never left out: there is no silent fallback. */
export const FALLBACK_WORDS: Record<Fallback, string> = {
  NO_MODEL: 'The provider runs without a model, so this is its help text.',
  MODEL_TIMEOUT: "The provider's model didn't answer in time, so this is its help text.",
  MODEL_ERROR: "The provider's model failed, so this is its help text.",
  MODEL_SCHEMA: "The provider's model gave an answer that broke the rules, so it was dropped and this is the help text.",
  PROVIDER_TIMEOUT: "The provider didn't answer, so this phone answered from its own help text.",
  PROVIDER_UNREACHABLE: "The relay couldn't be reached, so this phone answered from its own help text.",
  REPLY_INVALID: "The provider's reply failed this phone's checks, so it isn't shown; this is the phone's help text.",
  NO_ASSISTANT: 'No provider help agent is set up, so this phone answered from its own help text.',
  NOT_SENT: 'Nothing was sent.',
}

export const short = (pk: string) => `${pk.slice(0, 6)}…${pk.slice(-4)}`

/** The label line under the tag: the exact label, and where a template ran. */
export function labelWords(a: Pick<AssistAnswer, 'label' | 'source' | 'answered_by'>): string {
  if (a.source === 'model') return a.label
  return a.answered_by === 'phone' ? `${a.label}, on this phone` : `${a.label}, from the provider`
}

function Shared({ a }: { a: AssistAnswer }) {
  if (!a.shared) return <Disclosure label="What I shared" value="nothing"><Text style={t.small}>This question never left the phone.</Text></Disclosure>
  const c = a.shared.context
  return (
    <Disclosure label="What I shared">
      <KV k="Question" v={a.shared.question} />
      <KV k="Screen" v={`${c.tab} · ${c.screen}`} />
      {c.height !== undefined ? <KV k="Block height" v={String(c.height)} /> : null}
      {c.passbook ? <KV k="Passbook" v={`step ${c.passbook.step + 1}, ${c.passbook.on_time} on time, ${c.passbook.late} late`} /> : null}
      {c.loans.length ? c.loans.map((l) => (
        <KV key={l.loan_id} k={`Loan ${l.loan_id.slice(0, 6)}…`} v={[l.state, l.owed ? `owes ${l.owed}` : null, l.blocks_left !== undefined ? `${l.blocks_left} blocks left` : null, l.check ?? null].filter(Boolean).join(', ')} />
      )) : <KV k="Loans" v="none" />}
      <KV k="Sent to" v={`help agent ${short(a.shared.to)}`} />
      <Text style={t.tiny}>Encrypted to the provider's help agent only (NIP-44), from a throwaway key. Never your keys, addresses, words or history.</Text>
    </Disclosure>
  )
}

function AnswerCard({ a, onGo }: { a: AssistAnswer; onGo: (r: AssistRoute) => void }) {
  return (
    <View style={st.answer}>
      <View style={st.labelRow}>
        <Tag label={a.source === 'model' ? 'MODEL' : 'TEMPLATE'} tone={a.source === 'model' ? 'green' : 'muted'} />
        <Text style={[t.tiny, st.flex]} accessibilityLabel={`Answer label: ${labelWords(a)}`}>{labelWords(a)}</Text>
      </View>
      <Text style={t.body}>{a.text}</Text>
      {a.refused === 'MONEY_ACTION' ? <Text style={t.small}>Only you can move money or sign, on the screen that does it.</Text> : null}
      {a.fallback_reason ? <Text style={t.small}>{FALLBACK_WORDS[a.fallback_reason]}</Text> : null}
      {a.intent ? <Button kind="secondary" label={intentTitle(a.intent)} onPress={() => onGo(routeFor(a.intent!))} /> : null}
      <Shared a={a} />
    </View>
  )
}

export function AssistantSheet({ assistant, onGo, visible, onClose }: { assistant: Assistant; onGo: (route: AssistRoute) => void; visible?: boolean; onClose?: () => void }) {
  const [draft, setDraft] = useState('')
  const scroll = useRef<ScrollView>(null)
  const shown = visible ?? assistant.visible
  const close = onClose ?? assistant.close
  useEffect(() => { if (shown) setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50) }, [assistant.turns, shown])

  const send = (q: string) => {
    if (!q.trim() || assistant.busy) return
    setDraft('')
    void assistant.ask(q)
  }
  const go = (r: AssistRoute) => { close(); onGo(r) }
  const who = assistant.status === 'looking' ? 'Looking for the provider…'
    : assistant.status === 'online' ? (assistant.info?.label.startsWith('model') ? `Provider advertises ${assistant.info.label}. Each reply shows whether its model answered.` : 'Provider found. Each reply shows who answered.')
    : assistant.status === 'unconfirmed' ? "The provider's help agent hasn't announced itself: questions go to it, and this phone answers if it doesn't reply"
    : 'Provider offline: answers come from this phone\'s help text'

  return (
    <Modal visible={shown} transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={st.scrim}>
        <Pressable style={st.dismiss} onPress={close} accessibilityLabel="Close" accessibilityRole="button" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.sheet}>
          <SafeAreaView edges={['bottom']} style={st.inner}>
            <View style={st.handle} />
            <View style={st.head}>
              <View style={st.flex}>
                <Text accessibilityRole="header" style={t.h2}>Agent on call</Text>
                <Text style={t.small}>{who}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close} style={st.close} hitSlop={8}><Icon name="close" size={20} color={C.muted} /></Pressable>
            </View>
            <ScrollView ref={scroll} style={st.flex} contentContainerStyle={st.thread} keyboardShouldPersistTaps="handled">
              {!assistant.turns.length ? (
                <View style={st.empty}>
                  <Text style={t.sub}>Ask about the app. I can explain and open a screen for you. I can't move money, sign, approve or see your keys.</Text>
                  <View style={st.chips}>{SUGGESTED_QUESTIONS.map((q) => <Chip key={q} label={q} onPress={() => send(q)} />)}</View>
                </View>
              ) : assistant.turns.map((turn) => (
                <View key={turn.id} style={st.turn}>
                  <View style={st.question}><Text style={[t.body, { color: C.ink }]}>{turn.question}</Text></View>
                  {turn.answer ? <AnswerCard a={turn.answer} onGo={go} /> : <Working label={assistant.status === 'offline' ? 'Answering on this phone' : 'Waiting for the provider’s signed reply (up to 30 seconds)'} />}
                </View>
              ))}
            </ScrollView>
            <View style={st.compose}>
              <TextInput value={draft} onChangeText={setDraft} placeholder="Ask a question" placeholderTextColor={C.faint} style={st.input} maxLength={500}
                returnKeyType="send" onSubmitEditing={() => send(draft)} accessibilityLabel="Your question" autoCorrect autoCapitalize="sentences" />
              <Button label="Ask" onPress={() => send(draft)} disabled={!draft.trim() || assistant.busy} style={st.ask} />
            </View>
            <Text style={[t.tiny, st.center]}>Never type your recovery words here. Test network, test coins.</Text>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

const st = StyleSheet.create({
  flex: { flex: 1 },
  scrim: { flex: 1, backgroundColor: C.scrim, justifyContent: 'flex-end' },
  dismiss: { flex: 1 },
  sheet: { maxHeight: '88%', minHeight: '60%', backgroundColor: C.white, borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet },
  inner: { flex: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, gap: 12 },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.handle, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  thread: { gap: 18, paddingBottom: 8 },
  empty: { gap: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  turn: { gap: 10 },
  question: { alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: C.surface, borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10 },
  answer: { gap: 10, borderLeftWidth: 2, borderLeftColor: C.divider, paddingLeft: 12 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  compose: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontFamily: F.regular, fontSize: 16, color: C.ink, backgroundColor: C.white },
  ask: { height: 48, paddingHorizontal: 18 },
  center: { textAlign: 'center' },
})
