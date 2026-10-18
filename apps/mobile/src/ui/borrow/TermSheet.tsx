// The negotiated term sheet at the accept stop: the evidence digest it commits on chain and the
// lender's approvals of exactly this sheet, each checked on the phone before this is shown.
import React from 'react'
import type { PhoneLoan } from '../../agent/borrower'
import { Disclosure, KV, P } from '../kit'
import { PersonaLine } from './PersonaLine'
import { pctText, short } from '../format'

const decisionLabel = (kind: string) => kind === 'sanctions-result' ? 'Sanctions screen' : kind === 'approval' ? 'Lender approval' : kind === 'gate-decision' ? 'Governance gate' : kind.replace(/-/g, ' ')

export function TermSheetDetails({ loan }: { loan: PhoneLoan }) {
  const sheet = loan.termsheet!
  const e = sheet.scorer.evidence
  const approvals = loan.lender_approvals ?? []
  const decisions = loan.lender_decisions ?? []
  return (
    <Disclosure label="Term sheet and evidence">
      <PersonaLine />
      <KV k="Negotiated APR" v={pctText(sheet.apr_bps)} />
      <KV k="Checked by" v={`${sheet.scorer.provider}${sheet.scorer.fallback ? ' (fallback)' : ''} · ${sheet.scorer.recommendation}`} />
      <KV k="Evidence digest" v={e ? (e.kind === 'compex-dsse' ? short(e.envelope_sha256, 8) : short(e.run_record_sha256, 8)) : 'none'} />
      {e?.kind === 'compex-dsse' ? <KV k="Compex run" v={short(e.execution_id, 8)} /> : null}
      <KV k="Consent" v={short(sheet.consent_hash, 8)} />
      <KV k="Lender approvals" v={`${approvals.length}: ${approvals.map((a) => short(a.approver_pk, 4)).join(', ')}`} />
      {decisions.length ? decisions.map((d) => <KV key={d.hash} k={decisionLabel(d.kind)} v={`${d.result} · node ${short(d.node_pk, 4)} · signed`} />) : <KV k="Lender's governance" v="no signed decision was sent" />}
      <P small>Signed by the lender and checked on this phone: the sheet follows the agreement both agents signed, names the check you opened, and carries every approval the lender's own signed policy requires. Its hash is the terms hash your lock commits.</P>
    </Disclosure>
  )
}
