// REGTEST TEST DATA: said in words on the screens that matter (home, check result, term sheet,
// receipt) while the seeded test persona is active; the badge says it on every screen.
import { activeNetwork } from '../../core/network'
import React from 'react'
import { useApp } from '../../app/session'
import { personaTitle } from '../../app/persona'
import { Note } from '../kit'

export function PersonaLine() {
  const p = useApp().borrowerState.persona
  if (!p) return null
  return <Note tone="warn" icon="info" title={`Test persona ${personaTitle(p.name)} · ${activeNetwork().name} test data`} sub="Seeded by the service provider and observed from zero; not a real person's wallet." />
}
