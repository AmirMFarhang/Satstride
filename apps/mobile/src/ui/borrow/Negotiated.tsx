// The negotiated path's screens: the agent's negotiation as it happens (every signed message),
// no deal and failure, the check node, the consent, the Compex contract approval and the
// verified result. Each one shows what the flow is waiting on; nothing is shared, approved or
// paid without a stop.
import React, { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { NegotiationMessage, Position } from '../../../../../src/market/negotiate.js'
import type { BorrowState } from '../../app/borrow-flow'
import { refusalCode, refusalWords } from '../../app/credit-check'
import { checkResultWords } from '../../app/check-result'
import { eligiblePersona } from '../../app/persona'
import { useApp } from '../../app/session'
import { Button, Disclosure, FlowTop, Hero, KV, Note, P, Problem, Row, Rows, Screen, StopCount, Tag, Undo, Working } from '../kit'
import { PersonaLine } from './PersonaLine'
import { NegotiationVisualizer } from '../../motion/NegotiationVisualizer'
import { CheckVisualizer } from '../../motion/CheckVisualizer'
import type { CheckPhase } from '../../motion/check-model'
import { useNav } from '../nav'
import { Icon } from '../icons'
import { C, F, t } from '../theme'
import { partyName, pctText, short, usdNum } from '../format'

/** The flow's stage as D1's check picture (src/motion/check-model.ts). */
const CHECK_PHASE: Partial<Record<BorrowState['stage'], CheckPhase>> = { consent: 'sealing', 'check-sealing': 'out', 'compex-approval': 'approval', 'check-opening': 'running', 'check-result': 'opened', 'check-refused': 'refused' }

export const NEGOTIATED_STAGES = new Set<BorrowState['stage']>(['negotiating', 'no-deal', 'negotiation-failed', 'check-node', 'consent', 'check-sealing', 'compex-approval', 'check-opening', 'check-result', 'check-refused', 'no-terms'])

const position = (b: Record<string, unknown>): Position | null => (b.position && typeof b.position === 'object' ? b.position as Position : null)

function line(m: NegotiationMessage, me: string): { who: string; what: string } {
  const p = position(m.body)
  const who = m.from_pk === me ? 'Your agent' : partyName('Lender', m.from_pk)
  const terms = p ? `${usdNum(p.principal).replace(/\.00$/, '')} at ${pctText(p.apr_bps)}, ${pctText(p.ltv_bps)} of your bitcoin, ${p.term_blocks} blocks` : ''
  switch (m.type) {
    case 'ASK': return { who, what: `asks for ${terms}` }
    case 'OFFER': return { who, what: `offers ${terms}` }
    case 'COUNTER': return { who, what: `counters: ${terms}` }
    case 'ACCEPT': return { who, what: `accepts ${terms}` }
    case 'NO_DEAL': return { who, what: `ends it: ${String(m.body.reason ?? 'no deal')}` }
    default: return { who, what: m.type.toLowerCase() }
  }
}

/** Each way a negotiation ends without a deal (src/market/negotiate-nostr.ts codes), in words for its own screen. */
export function noDealWords(code: string, lender: string): { title: string; sub: string } {
  const c = code.replace(/^REFUSED:/, '')
  if (code.startsWith('REFUSED:')) return { title: `${lender} would not negotiate`, sub: c === 'KILL_SWITCH' ? "The lender's agent is paused by its owner." : c.startsWith('SANCTION') ? "The lender's screening stopped it." : c === 'CAPACITY' ? 'The lender has no room for another loan now.' : `The lender's rules refused it (${c}).` }
  switch (code) {
    case 'MAX_ROUNDS': return { title: 'No deal', sub: 'Your agent and the lender could not meet within the rounds allowed.' }
    case 'ECONOMICS': case 'APR_CAP': return { title: 'No deal', sub: 'The terms would go past the platform limits.' }
    case 'ASSET': return { title: 'No deal', sub: 'The lender lends another asset.' }
    case 'PRINCIPAL': return { title: 'No deal', sub: 'The lender does not lend this amount.' }
    case 'TERM': return { title: 'No deal', sub: 'The lender does not lend for this term.' }
    case 'SETTLEMENT': return { title: 'No deal', sub: 'The lender settles another way than co-signed RGB.' }
    case 'POLICY': return { title: 'Stopped at your rules', sub: 'Going further would break the rules you signed, so your agent did not.' }
    case 'TIMEOUT': return { title: `${lender} did not answer`, sub: 'No reply came over Nostr in time.' }
    case 'STRUCTURE': case 'PROTOCOL': case 'PARAMS': return { title: 'Stopped: a message did not check out', sub: 'A signed message failed verification on this phone, so nothing more was sent.' }
    case 'STALE_TERMS': return { title: 'The offer changed', sub: `${lender} has signed new terms since this offer. Read the market again.` }
    case 'ABORTED': return { title: 'Stopped', sub: 'The negotiation was stopped on this phone.' }
    default: return { title: 'No deal', sub: `${lender} ended it (${code}).` }
  }
}

/** Why a negotiation could not run at all. */
function stoppedWords(code: string | undefined, lender: string): string {
  if (code === 'NOT_IN_THIS_BUILD') return 'This build of the app cannot negotiate over Nostr yet.'
  if (code === 'TERMS') return `${lender}'s offer does not carry negotiation terms.`
  if (code === 'TRANSPORT') return 'The relay did not take your agent’s message. Check the connection and try again.'
  return 'Your key could not sign the message.'
}

export function Transcript({ messages, me }: { messages: NegotiationMessage[]; me: string }) {
  return (
    <View style={{ gap: 12 }}>
      {messages.map((m) => {
        const l = line(m, me)
        const mine = m.from_pk === me
        return (
          <View key={`${m.seq}-${m.sig.slice(0, 8)}`} style={[st.msg, mine ? st.mine : null]}>
            <View style={st.msgHead}>
              <Text style={[t.small, { fontFamily: F.semibold, color: C.ink }]}>{l.who}</Text>
              <Text style={[t.small, { fontSize: 12 }]}>{m.type} · #{m.seq}</Text>
            </View>
            <Text style={t.body}>{l.what}</Text>
            <Text style={[t.small, { fontSize: 11, fontFamily: F.mono }]}>signed {short(m.sig, 6)}</Text>
          </View>
        )
      })}
    </View>
  )
}

export function NegotiatedStage({ f }: { f: BorrowState }) {
  const s = useApp()
  const nav = useNav()
  const offer = f.offer!
  const lender = partyName('Lender', offer.lender_pk)
  const me = s.key.pubkey
  const policy = s.borrowerState.policy
  const leave = () => { s.borrow.reset(); nav.root() }
  const back = () => nav.root()

  if (f.stage === 'negotiating' || f.stage === 'no-deal' || f.stage === 'negotiation-failed') {
    const done = f.stage !== 'negotiating'
    return (
      <Screen top={<FlowTop title="Negotiating" onBack={back} />} bottom={done ? <>
        <Button label="Choose another lender" onPress={() => { s.borrow.reset(); nav.pop() }} />
        <Button kind="ghost" label="Back to your passbook" onPress={leave} />
      </> : <Undo text="Your agent stays inside the rules you signed" />}>
        <Text style={t.sub}>{lender} · {usdNum(f.principal ?? 0).replace(/\.00$/, '')} test USDT{policy ? ` · at most ${pctText(policy.max_apr_bps)}` : ''}</Text>
        {f.stage === 'no-deal' ? (() => { const w = noDealWords(f.noDeal ?? 'NO_DEAL', lender); return <Note tone="warn" icon="close" title={w.title} sub={`${w.sub} Nothing was shared or signed beyond the negotiation.`} /> })() : null}
        {f.stage === 'negotiation-failed' ? <Note tone="warn" icon="close" title="The negotiation did not start" sub={`${stoppedWords(f.stopped, lender)} Nothing was shared.`} /> : null}
        {f.stage === 'no-deal' && f.noDeal ? <Rows><Row k="Code" v={f.noDeal} mono /></Rows> : null}
        <NegotiationVisualizer messages={f.transcript ?? []} borrowerPk={me} lenderLabel={lender} noDeal={f.stage === 'no-deal' && f.noDeal ? noDealWords(f.noDeal, lender) : undefined} />
        <Working label={f.working} />
        <Problem>{f.stage === 'negotiation-failed' ? f.error : null}</Problem>
      </Screen>
    )
  }

  if (f.stage === 'check-node') return <CheckNodePick f={f} lender={lender} />
  if (f.stage === 'consent' || f.stage === 'check-sealing') return <Consent f={f} lender={lender} />

  if (f.stage === 'compex-approval' || f.stage === 'check-opening') {
    const c = f.approval?.contract
    const opening = f.stage === 'check-opening'
    return (
      <Screen top={<FlowTop title="Approve the check" onBack={back} right={<StopCount n={1} />} />} bottom={opening ? undefined : <>
        <Button label="Approve with your lock" busy={!!f.working} disabled={!c} onPress={() => void s.borrow.approveCompex()} />
        <Undo text="Your sealed history is opened only by this contract" />
      </>}>
        <Text style={[t.h2, { fontSize: 24, lineHeight: 30 }]}>Let Compex run this check on your sealed history?</Text>
        <CheckVisualizer phase={CHECK_PHASE[f.stage] ?? 'approval'} operatorLabel={`Check node ${short(f.checkNode?.offer.operator_pk ?? '', 3)}`} />
        <Rows topLine>
          <Row k="Contract" v={c?.contractId ?? '…'} mono />
          <Row k="Version" v={c ? String(c.contractVersion) : '…'} />
          <Row k="Contract hash" v={c ? short(c.contractHash, 8) : '…'} mono />
          <Row k="Check node" v={f.checkNode ? short(f.checkNode.offer.operator_pk, 6) : '…'} mono />
          <Row k="Paid by" v={lender} />
        </Rows>
        <P small>The check node signed this contract and your phone checked it matches the agreed loan before showing it. The result comes back only for {lender} and you; Compex keeps nothing.</P>
        {opening ? <Steps3 /> : null}
        <Working label={f.working} />
        <Problem>{f.error}</Problem>
      </Screen>
    )
  }

  if (f.stage === 'check-result' && f.checkView) {
    const v = f.checkView
    const o = v.outputs
    // a verified result that does not qualify: the lender requires QUALIFY, so nothing is applied for
    const qualifies = v.ok && o?.recommendation === 'QUALIFY'
    if (v.ok && o && !qualifies) {
      const failedChecks = o.checks.filter((c) => !c.ok)
      const words = checkResultWords(o)
      return (
        <Screen top={<FlowTop title="Check result" onBack={back} />} bottom={<Button kind="secondary" label="Back to your passbook" onPress={leave} />}>
          <CheckVisualizer phase="opened" view={v} operatorLabel={`Check node ${short(v.operator_pk, 3)}`} />
          <Hero label="Compex says" value={o.recommendation} sub={`income band ${o.income_band}`} size="mid" />
          <PersonaLine />
          <Note tone="warn" icon="close" title={words.title} sub={words.detail} />
          {failedChecks.length ? (
            <Rows>{failedChecks.map((c) => <Row key={c.id} k={checkWords(c.id)} v="not confirmed" tone="warn" />)}</Rows>
          ) : null}
          {o.findings.length ? <Disclosure label="What the check found">{o.findings.map((x, i) => <KV key={`${x.type}-${i}`} k={findingWords(x.type)} v={x.type} />)}</Disclosure> : null}
          <Disclosure label="The check">
            <KV k="Compex run" v={v.execution_id ?? '…'} />
            <KV k="Release" v={short(v.release_hash, 8)} />
            <KV k="Check node" v={short(v.operator_pk, 6)} />
            <KV k="Paid by" v={v.rail_label ? `${lender} · ${v.rail_label}` : lender} />
          </Disclosure>
          <P small>Verified on this phone: signed by a pinned Compex evidence key and bound to this loan. The result is the check's, not the lender's.</P>
        </Screen>
      )
    }
    return (
      <Screen top={<FlowTop title="Check result" onBack={back} />} bottom={v.ok ? <>
        <Button label={`Ask ${lender} for the terms`} busy={!!f.working} onPress={() => s.borrow.continueToTerms()} />
        <Undo text="Nothing is locked until you accept the terms" />
      </> : <Button kind="secondary" label="Back to your passbook" onPress={leave} />}>
        <CheckVisualizer phase="opened" view={v} operatorLabel={`Check node ${short(v.operator_pk, 3)}`} />
        <Hero label="Compex says" value={o?.recommendation ?? 'no result'} sub={o ? `income band ${o.income_band}` : undefined} size="mid" />
        <PersonaLine />
        {v.ok ? <Note icon="check" title="Verified on this phone" sub="Signed by a pinned Compex evidence key and bound to this loan" /> : <Note tone="warn" icon="close" title="This result did not verify" sub="The phone will not use it. Nothing was locked." />}
        <Rows>
          <Row k="Release" v={short(v.release_hash, 8)} mono />
          <Row k="Run" v={v.execution_id ? short(v.execution_id, 8) : '…'} mono />
          <Row k="Check node" v={short(v.operator_pk, 6)} mono />
          <Row k="Paid by" v={v.key_source === ('operator-billed' as never) ? `${lender} · billed at close, not paid up front` : v.rail_label ? `${lender} · ${v.rail_label}` : lender} />
          <Row k="Binding" v={o?.v === 2 ? 'v2: this borrower, lender and loan' : 'not v2'} tone={o?.v === 2 ? 'green' : 'warn'} />
        </Rows>
        <Disclosure label={`What the phone checked (${v.ticks.filter((x) => x.ok).length} of ${v.ticks.length})`}>
          {v.ticks.map((x) => (
            <View key={x.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
              <Icon name={x.ok ? 'check' : 'close'} size={16} color={x.ok ? C.green : C.warn} />
              <Text style={[t.small, { flex: 1 }]}>{x.detail}</Text>
            </View>
          ))}
          <P small>Compex's full claim verifier runs at the lender; the phone checks the signature, the binding and the opening.</P>
        </Disclosure>
        <Working label={f.working} />
        <Problem>{f.error}</Problem>
      </Screen>
    )
  }

  if (f.stage === 'no-terms') {
    return (
      <Screen top={<FlowTop title="No terms" onBack={back} />} bottom={<>
        <Button label="Wait again" busy={!!f.working} onPress={() => s.borrow.waitForTerms()} />
        <Button kind="secondary" label="Back to your passbook" onPress={leave} />
      </>}>
        <Note tone="warn" icon="close" title={`${lender} sent no terms`} sub="Your application went out over Nostr, but no signed term sheet came back in 3 minutes. The lender may have declined. Nothing was locked." />
        <P small>Waiting again sends nothing and signs nothing: it listens for the lender's terms once more.</P>
        <Problem>{f.error}</Problem>
      </Screen>
    )
  }

  // check-refused
  return (
    <Screen top={<FlowTop title="Credit check" onBack={back} />} bottom={<>
      {/^(OFFER|RULES|CHECK_NODE)/.test(refusalCode(f.refused ?? '')) ? <Button label="Pick another check node" onPress={() => s.borrow.backToCheckNodes()} /> : null}
      <Button kind="secondary" label="Back to your passbook" onPress={leave} />
    </>}>
      <CheckVisualizer phase="refused" refusal={refusalCode(f.refused ?? 'REFUSED')} refusalText={refusalWords(f.refused ?? 'REFUSED')} operatorLabel={`Check node ${short(f.checkNode?.offer.operator_pk ?? '', 3)}`} />
      <Note tone="warn" icon="close" title="The check did not go ahead" sub={refusalWords(f.refused ?? 'REFUSED')} />
      <Rows><Row k="Code" v={refusalCode(f.refused ?? 'REFUSED')} mono />{f.refused?.startsWith('lender:') ? <Row k="From" v={lender} /> : null}</Rows>
      <P small>Nothing was locked. Any consent you gave names this negotiation only and expires by itself.</P>
      <Problem>{f.error}</Problem>
    </Screen>
  )
}

/** The chain checks and Compex findings, in words (codes from src/scorer/compex.ts). */
function checkWords(id: string): string {
  return ({ anchor_confirmations: 'Bitcoin confirmations', history_reconciliation: 'History matches the observer', rgb_receive_validation: 'Payments received check out', affordability: 'Affordability', inflows: 'Income', headroom: 'Headroom', injection: 'Instructions hidden in memos' } as Record<string, string>)[id] ?? id
}
function findingWords(code: string): string {
  return ({ HISTORY_TOO_SHORT: 'History too short', CHAIN_CHECK_FAILED: 'A chain check failed', CHAIN_CHECKS_PASSED: 'Chain checks passed', INCOME_BELOW_REQUIREMENT: 'Income below what the lender asks', INCOME_MEETS_REQUIREMENT: 'Income meets the requirement', INCOME_RECURRING: 'Income is recurring', INCOME_VOLATILE: 'Income varies', INCOME_SIGNED_BY_PAYERS: 'Income signed by payers', LOAN_LIKE_INFLOWS: 'Inflows that look like loans', SELF_TRANSFERS_EXCLUDED: 'Your own transfers left out', AFFORDABILITY_OK: 'Affordable', AFFORDABILITY_SHORTFALL: 'Not affordable', INSTRUCTIONS_IN_MEMOS: 'Instructions found in memos' } as Record<string, string>)[code] ?? code.toLowerCase().replace(/_/g, ' ')
}

function Steps3() {
  return (
    <View style={{ gap: 6 }}>
      <Text style={t.small}>The lender pays the check node on its own rail, Compex runs, and the result comes back here to be opened.</Text>
    </View>
  )
}

/** What the bundle declares as recurring outflows: only the borrower's own declaration, never a default. */
export function declaredOutflowsText(o: { label: string; every_blocks: number; amount: number }[] | undefined): string {
  if (!o?.length) return 'Recurring outflows: none declared. The check counts only what your wallet history shows.'
  return `Recurring outflows declared: ${o.map((x) => `${x.label} ${usdNum(x.amount).replace(/\.00$/, '')} test USDT every ${x.every_blocks} blocks`).join(', ')}.`
}

function CheckNodePick({ f, lender }: { f: BorrowState; lender: string }) {
  const s = useApp()
  const nav = useNav()
  const rows = f.checkNodes ?? []
  const [loading, setLoading] = useState(false)
  const reload = async () => { setLoading(true); try { await s.borrow.loadCheckNodes() } finally { setLoading(false) } }
  useEffect(() => { if (!f.checkNodes) void reload() }, [])
  return (
    <Screen top={<FlowTop title="Credit check" onBack={() => nav.root()} />} bottom={<>
      <Button label="Review consent" disabled={!f.checkNode?.usable} onPress={() => s.borrow.reviewConsent()} />
      <Undo text="Nothing is shared yet" />
    </>}>
      {f.deal ? <Note icon="check" title="Agreed" sub={`${usdNum(f.deal.agreed.principal).replace(/\.00$/, '')} test USDT at ${pctText(f.deal.agreed.apr_bps)}, ${pctText(f.deal.agreed.ltv_bps)} of your bitcoin`} /> : null}
      {f.deal ? <Disclosure label={`The negotiation (${f.deal.messages.length} signed messages)`}><NegotiationVisualizer messages={f.deal.messages} borrowerPk={s.key.pubkey} lenderLabel={lender} verified /></Disclosure> : null}
      <Text style={[t.h2, { fontSize: 22, lineHeight: 28 }]}>Who runs your credit check?</Text>
      <P small>Check nodes post signed offers on the relay. {lender} pays for the check; no credit score is asked for, only your passbook and wallet history, sealed to the node.</P>
      <P small>{declaredOutflowsText(eligiblePersona(s.borrowerState.persona, s.key.pubkey, f.offer?.payload.asset_id)?.declared_outflows)}</P>
      {rows.map((r) => {
        const on = f.checkNode?.offer.operator_pk === r.offer.operator_pk
        return (
          <Pressable key={r.offer.operator_pk} disabled={!r.usable} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !r.usable }} onPress={() => s.borrow.pickCheckNode(r)} style={[st.card, on ? st.best : null, !r.usable ? { opacity: 0.5 } : null]}>
            <View style={st.msgHead}>
              <Text style={[t.bodyMedium, { fontFamily: F.semibold }]}>Check node {r.offer.operator_pk.slice(0, 6)}</Text>
              {r.usable ? <Tag label={r.offer.release.provider.toUpperCase()} /> : <Tag label="NOT USABLE" tone="muted" />}
            </View>
            <Text style={t.small}>Release {short(r.release_hash, 6)} · about {r.offer.p50_seconds} s · keeps nothing</Text>
            {r.why ? <Text style={t.small}>{r.why}</Text> : null}
          </Pressable>
        )
      })}
      {!rows.length && !loading && f.checkNodes ? <P muted>No check node has a current offer on the relay. The provider may be starting.</P> : null}
      {f.checkNodes ? <Button kind="ghost" label="Read the relay again" onPress={() => void reload()} /> : null}
      <Working label={loading ? 'Reading check-node offers' : f.working} />
      <Problem>{f.error}</Problem>
    </Screen>
  )
}

function Consent({ f, lender }: { f: BorrowState; lender: string }) {
  const s = useApp()
  const nav = useNav()
  const node = f.checkNode!
  const [cats, setCats] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void s.borrow.consentCategories().then(setCats).catch((e: Error) => setErr(e.message)) }, [])
  const sealing = f.stage === 'check-sealing'
  return (
    <Screen top={<FlowTop title="Consent" onBack={sealing ? () => nav.root() : () => s.borrow.backToCheckNodes()} right={<StopCount n={1} />} />} bottom={sealing ? undefined : <>
      <Button label="Consent with your lock" busy={!!f.working} disabled={!cats} onPress={() => void s.borrow.consent()} />
      <Undo text="Nothing is shared until you confirm with your phone's lock" />
    </>}>
      <Text style={[t.h2, { fontSize: 24, lineHeight: 30 }]}>Share your sealed history for one credit check?</Text>
      <CheckVisualizer phase={sealing ? 'out' : 'sealing'} operatorLabel={`Check node ${short(node.offer.operator_pk, 3)}`} />
      <Rows topLine>
        <Row k="Operator" v={short(node.offer.operator_pk, 6)} mono />
        <Row k="Release" v={`${node.offer.release.provider} · ${short(node.release_hash, 6)}`} mono />
        <Row k="Result goes to" v={lender} />
        <Row k="Paid by" v={lender} />
        <Row k="Kept by the node" v="nothing" />
      </Rows>
      <Disclosure label="Data shared" value={cats ? `${cats.length} kinds` : '…'} open>
        {(cats ?? []).map((c) => <KV key={c} k={c.replace(/_/g, ' ')} v="sealed" />)}
      </Disclosure>
      <P small>Your history is encrypted on this phone to the check node's key. Your consent names this negotiation, this operator and release, and {lender}. It is not a credit score: the check reads your passbook and wallet history only.</P>
      <Working label={f.working ?? (cats ? null : 'Preparing your history')} />
      <Problem>{err ?? f.error}</Problem>
    </Screen>
  )
}

const st = StyleSheet.create({
  msg: { borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12, gap: 4, marginRight: 32 },
  mine: { marginRight: 0, marginLeft: 32, backgroundColor: C.surface },
  msgHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  card: { borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 16, gap: 6 },
  best: { borderWidth: 2, borderColor: C.ink },
})

