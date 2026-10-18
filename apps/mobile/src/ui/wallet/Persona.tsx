// REGTEST TEST DATA: switch this phone to the seeded test persona for the acceptance run, or back to
// the person's own wallet. The package comes once from the service provider over USB
// (provider.sh service persona fatima); the phone checks the observer's history proof against the
// platform's own key before anything is installed, and installs only after the phone's lock.
import React, { useState } from 'react'
import { Text, View } from 'react-native'
import { useWalletManager, validateMnemonic } from '@tetherto/wdk-react-native-core'
import { Directory, File, Paths } from 'expo-file-system'
import { base64 } from '@scure/base'
import { useApp } from '../../app/session'
import { seedPersonaState } from '../../app/session'
import { fetchPersona, PERSONA_WALLET_ID, personaProblems, personaRecord, personaTitle, type PersonaPackage } from '../../app/persona'
import { activeWallet } from '../../wallet/flags'
import { NETWORK, RGB_DIR, WALLET_ID } from '../../wallet/config'
import { requirePhoneLock } from '../../wallet/phone-lock'
import { Button, FlowTop, KV, Note, P, Problem, Row, Rows, Screen, Undo, Working } from '../kit'
import { useNav } from '../nav'
import { t } from '../theme'
import { short, usd } from '../format'

export function Persona() {
  const s = useApp()
  const nav = useNav()
  const wm = useWalletManager()
  const active = s.borrowerState.persona
  const [pkg, setPkg] = useState<PersonaPackage | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchIt = async () => {
    setError(null); setWorking('Asking the service provider for the test persona')
    try {
      const got = await fetchPersona()
      setWorking("Checking the history proof against the platform's key")
      const { platform_pk } = await s.platform.state()
      const ps = personaProblems(got, platform_pk, (w) => validateMnemonic(w), NETWORK.name)
      setProblems(ps)
      setPkg(got as PersonaPackage)
    } catch (e) { setError((e as Error).message) } finally { setWorking(null) }
  }

  const install = async () => {
    if (!pkg || problems.length) return
    const name = personaTitle(pkg.persona)
    const lock = await requirePhoneLock(`Switch this phone to the seeded test persona ${name} (${NETWORK.name} test data)`)
    if (!lock.ok) return setError(lock.reason)
    setError(null)
    const backupFile = new File(Paths.document, 'rgb-persona.backup')
    try {
      setWorking(`Restoring ${name}'s wallet records beside yours`)
      // this network's RGB directory: a regtest persona with the same fingerprint must not skip the restore
      if (!new Directory(Paths.document, RGB_DIR, pkg.rgb_fingerprint).exists) {
        if (backupFile.exists) backupFile.delete()
        backupFile.create()
        backupFile.write(base64.decode(pkg.rgb_backup_b64))
        await s.module.rgbRestoreBackup({ backupPath: decodeURIComponent(backupFile.uri.replace(/^file:\/\//, '')), password: pkg.rgb_backup_password, fingerprint: pkg.rgb_fingerprint })
      }
      // the persona's agent state and the active wallet first: the session reads them when the persona opens
      seedPersonaState(PERSONA_WALLET_ID, personaRecord(pkg))
      activeWallet.set(PERSONA_WALLET_ID)
      const words = pkg.words
      setPkg(null)
      // WDK restores a wallet only while none is open; locking closes these screens, and restoring
      // the persona's words opens it (under its own id; the person's own wallet is untouched)
      await wm.lock()
      try {
        await wm.deleteWallet(PERSONA_WALLET_ID).catch(() => { /* none from an earlier run */ })
        await wm.restoreWallet(words, PERSONA_WALLET_ID)
      } catch (e) {
        activeWallet.set(WALLET_ID)
        throw e
      }
    } catch (e) {
      setError(`Could not switch to the test persona: ${(e as Error).message}`)
    } finally {
      if (backupFile.exists) backupFile.delete()
      setWorking(null)
    }
  }

  const backToOwn = async () => {
    const lock = await requirePhoneLock('Back to your own wallet')
    if (!lock.ok) return setError(lock.reason)
    activeWallet.set(WALLET_ID)
    await wm.lock()
  }

  if (active) {
    return (
      <Screen top={<FlowTop title="Test persona" onBack={nav.pop} />} bottom={<>
        <Button label="Back to your own wallet" onPress={() => void backToOwn()} />
        <Undo text="The test persona stays on this phone until you remove it" />
      </>}>
        <Note tone="warn" icon="info" title={`Test persona ${personaTitle(active.name)} is active`} sub={`Seeded ${NETWORK.name} test data from the service provider, not a real person. Everything this phone shows now is the persona's.`} />
        <Rows>
          <Row k="Observed from zero by" v={short(active.observer_pk, 6)} mono />
          <Row k="Observed transfers" v={String(active.history_proof.transfers.length)} />
          <Row k="Seeded income records" v={String(active.inflows.length)} />
        </Rows>
        <Problem>{error}</Problem>
      </Screen>
    )
  }

  const h = pkg?.history_proof
  return (
    <Screen top={<FlowTop title="Test persona" onBack={nav.pop} />} bottom={pkg && !problems.length
      ? <>
          <Button label={`Switch to ${personaTitle(pkg.persona)} (test data)`} busy={!!working} onPress={() => void install()} />
          <Undo text="Your own wallet stays on this phone; switch back in Settings" />
        </>
      : <Button kind={pkg ? 'secondary' : 'primary'} label={pkg ? 'Fetch again' : 'Fetch from the service provider'} busy={!!working} onPress={() => void fetchIt()} />}>
      <Text style={[t.h2, { fontSize: 24, lineHeight: 30 }]}>Use the seeded test persona</Text>
      <Note tone="warn" icon="info" title={`${NETWORK.name === 'regtest' ? 'Regtest' : 'Mutinynet'} test data`} sub="A persona the service provider seeded, with a history its observer watched from zero. It is not a real person's wallet. Only for the acceptance run." />
      <P small>A wallet made on this phone has no observed history yet, so its credit check comes back ESCALATE. That stays true for your own wallet.</P>
      {pkg && h ? (
        <View style={{ gap: 8 }}>
          <Rows>
            <Row k="Persona" v={`${personaTitle(pkg.persona)} · test data`} />
            <Row k="Observer" v={problems.some((p) => /observer/.test(p)) ? 'not this platform' : `this platform · ${short(pkg.observer_pk, 6)}`} tone={problems.some((p) => /observer/.test(p)) ? 'warn' : 'green'} />
            <Row k="Proof signature" v={problems.some((p) => /signature/.test(p)) ? 'does not verify' : 'verifies'} tone={problems.some((p) => /signature/.test(p)) ? 'warn' : 'green'} />
            <Row k="Observed from zero" v={h.observed_from_zero ? 'yes' : 'no'} tone={h.observed_from_zero ? 'green' : 'warn'} />
            <Row k="Observed transfers" v={String(h.transfers?.length ?? 0)} />
            <Row k="Balance seen" v={usd(h.current_balance)} />
            <Row k="Seeded income records" v={String(pkg.inflows?.length ?? 0)} />
          </Rows>
          <KV k="The persona's key" v={short(h.borrower_pk, 6)} />
        </View>
      ) : <P small muted>On the laptop: provider.sh service persona fatima. It serves the package once over USB.</P>}
      {problems.length ? <Problem>{`Not used: ${problems.join('; ')}.`}</Problem> : null}
      <Working label={working} />
      <Problem>{error}</Problem>
    </Screen>
  )
}
