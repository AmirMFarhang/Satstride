// Canvas 1 (welcome) and the steps behind it. A new wallet's 12 words appear only after the
// phone's lock, are shown once, and three of them are typed back before the wallet is
// saved (behind the lock again). Restore takes 12 or 24 words. The words never leave the phone.
import React, { useEffect, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import { useWalletManager, validateMnemonic } from '@tetherto/wdk-react-native-core'
import { usePreventScreenCapture } from 'expo-screen-capture'
import { CHECK_COUNT, ordinal, pickCheckPositions, splitWords, verifyBackup } from '../core/backup'
import { backup } from '../wallet/flags'
import { WALLET_ID } from '../wallet/config'
import { requirePhoneLock } from '../wallet/phone-lock'
import { Button, Field, FlowTop, P, Problem, Screen, Working } from './kit'
import { Icon } from './icons'
import { LogoTile } from '../brand/Logo'
import { C, F, t } from './theme'

type Step = { at: 'welcome' } | { at: 'words'; words: string[] } | { at: 'check'; words: string[]; positions: number[] } | { at: 'restore' }

export function Onboarding() {
  const [step, setStep] = useState<Step>({ at: 'welcome' })
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const wm = useWalletManager()

  // Leaving the app discards words that are not saved yet: back to the start, nothing kept.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { setStep({ at: 'welcome' }); setProblem(null) }
    })
    return () => sub.remove()
  }, [])

  const save = async (phrase: string, why: string) => {
    setProblem(null)
    const lock = await requirePhoneLock(why)
    if (!lock.ok) return setProblem(lock.reason)
    setBusy(true)
    try {
      await wm.restoreWallet(phrase, WALLET_ID)
      backup.markVerified()
    } catch (e) {
      setProblem(`Could not save the wallet: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (step.at === 'welcome') {
    return (
      <Screen scroll={false} bottom={<>
        <Button label="Create a wallet" busy={busy} onPress={async () => {
          setProblem(null)
          // the words appear only to the phone's owner
          const lock = await requirePhoneLock('Create your wallet: show your new recovery words')
          if (!lock.ok) return setProblem(lock.reason)
          setBusy(true)
          try { setStep({ at: 'words', words: splitWords(await wm.generateMnemonic(12)) }) } catch (e) { setProblem((e as Error).message) } finally { setBusy(false) }
        }} />
        <Button kind="secondary" label="I already have one" disabled={busy} onPress={() => { setProblem(null); setStep({ at: 'restore' }) }} />
        <P small center>Pseudonymous. No identity documents collected.</P>
      </>}>
        <View style={st.welcome}>
          <LogoTile />
          <Text style={st.name} accessibilityRole="header">PassBook</Text>
          <Text style={[t.sub, st.tagline]}>Borrow dollars against your bitcoin, or lend them. Pay on time, borrow more.</Text>
          <Text style={[t.small, { textAlign: 'center', maxWidth: 300 }]}>Your keys are made on this phone and stay behind its lock.</Text>
        </View>
        <Problem>{problem}</Problem>
      </Screen>
    )
  }

  if (step.at === 'words') {
    return (
      <Screen top={<FlowTop title="Your 12 words" onBack={() => setStep({ at: 'welcome' })} />} bottom={
        <Button label="I wrote them down" onPress={() => setStep({ at: 'check', words: step.words, positions: pickCheckPositions(step.words.length) })} />
      }>
        <P>These words are the only backup of this wallet. Write them on paper, in order. Anyone who has them can spend from it.</P>
        <WordGrid words={step.words} />
        <P small>Next you type back {CHECK_COUNT} of them. Leaving the app before the wallet is saved discards these words.</P>
      </Screen>
    )
  }

  if (step.at === 'check') return <BackupCheck words={step.words} positions={step.positions} busy={busy} problem={problem}
    onBack={() => { setProblem(null); setStep({ at: 'words', words: step.words }) }}
    onPassed={() => save(step.words.join(' '), 'Save your new wallet on this phone')}
    onFailed={() => setProblem('Those words do not match. Check your paper backup.')} />

  return <Restore busy={busy} problem={problem} onBack={() => { setProblem(null); setStep({ at: 'welcome' }) }}
    onRestore={(phrase) => {
      if (!validateMnemonic(phrase)) return setProblem('Enter all 12 or 24 words, separated by spaces.')
      void save(splitWords(phrase).join(' '), 'Restore your wallet on this phone')
    }} />
}

function WordGrid({ words }: { words: string[] }) {
  // the words never go to a screenshot, a screen recording or a USB screen capture
  usePreventScreenCapture('recovery-words')
  return (
    <View style={st.grid}>
      {words.map((w, i) => (
        <View key={i} style={st.cell}>
          <Text style={t.small}>{i + 1}</Text>
          <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>{w}</Text>
        </View>
      ))}
    </View>
  )
}

function BackupCheck({ words, positions, busy, problem, onBack, onPassed, onFailed }: { words: string[]; positions: number[]; busy: boolean; problem: string | null; onBack: () => void; onPassed: () => void; onFailed: () => void }) {
  const [answers, setAnswers] = useState<string[]>(positions.map(() => ''))
  usePreventScreenCapture('backup-check')
  return (
    <Screen top={<FlowTop title="Check your backup" onBack={onBack} />} bottom={
      <Button label="Check and save" busy={busy} disabled={answers.some((a) => !a.trim())} onPress={() => (verifyBackup(words, positions, answers) ? onPassed() : onFailed())} />
    }>
      <P>Type these words from your paper backup.</P>
      {positions.map((pos, i) => (
        <Field key={pos} label={`${ordinal(pos)} word`} value={answers[i]} editable={!busy}
          onChangeText={(x) => setAnswers((a) => a.map((v, j) => (j === i ? x : v)))} />
      ))}
      <Working label={busy ? 'Saving the wallet behind your phone lock' : null} />
      <Problem>{problem}</Problem>
    </Screen>
  )
}

function Restore({ busy, problem, onBack, onRestore }: { busy: boolean; problem: string | null; onBack: () => void; onRestore: (phrase: string) => void }) {
  const [phrase, setPhrase] = useState('')
  usePreventScreenCapture('restore-words')
  return (
    <Screen top={<FlowTop title="Restore" onBack={onBack} />} bottom={<Button label="Restore" busy={busy} disabled={!phrase.trim()} onPress={() => onRestore(phrase)} />}>
      <P>Type your 12 or 24 words in order. They stay on this phone.</P>
      <Field label="Recovery words" value={phrase} onChangeText={setPhrase} multiline numberOfLines={4} editable={!busy}
        importantForAutofill="no" style={{ minHeight: 120, textAlignVertical: 'top' }} />
      <P small>Your words bring back your bitcoin and your passbook key. Assets also need this phone's RGB records, which this build does not back up yet.</P>
      <Problem>{problem}</Problem>
    </Screen>
  )
}

const st = StyleSheet.create({
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 },
  logo: { width: 84, height: 84, borderRadius: 26, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: F.semibold, fontSize: 34, letterSpacing: -0.5, color: C.ink },
  tagline: { fontSize: 17, lineHeight: 25, textAlign: 'center', maxWidth: 290 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '31%', borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 8, gap: 2 },
})
