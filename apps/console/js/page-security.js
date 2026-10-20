// Security, live: posture, governance per node, trust evidence, the red-team
// self-test and the kill switch. Everything here is read-only except the
// red-team probes (requests this node must refuse) and the kill switch.

import { esc, has, isNum, fmtInt, fmtDuration, relTime, absTime, hasTime, label } from './format.js'
import { icon, chip, statusChip, keyCell, mono, text, kv, card, empty, table, timeCell, bool, codeRef, skeletonCards } from './ui.js'
import { apiGet, apiPost } from './api.js'
import { reducedMotion, toast } from './dom.js'

const KILLABLE_KINDS = new Set(['platform', "provider's lender"])

const rt = { phase: 'idle', probes: [], results: {}, current: null, error: null, listLoading: false }
const ks = { open: false, node: 'all', confirm: '', reason: '', busy: false, lines: null, error: null, focus: false }

const ST_LABEL = { ok: 'OK', warn: 'Check', alert: 'Alert' }
const st = (tone) => `<span class="st st-${tone}-t"><span class="dot dot-${tone}"></span>${ST_LABEL[tone] ?? ''}</span>`

// ---------- posture ----------

function posture(d) {
  const nodes = d.nodes ?? []
  const a = d.api_auth ?? {}
  const g = d.signing_gate ?? {}
  const authTone = a.enforced && a.mode === 'enforce' ? 'ok' : a.mode === 'off' ? 'alert' : 'warn'
  const stopped = nodes.filter((n) => n.kill_switch?.stopped).length
  const problems = nodes.reduce((s, n) => s + (n.policy?.problems?.length ?? 0), 0)
  const pending = nodes.reduce((s, n) => s + (n.policy?.pending?.length ?? 0), 0)
  const loosening = nodes.some((n) => (n.policy?.pending ?? []).some((p) => p.change === 'loosen'))
  const unverified = nodes.filter((n) => n.log && n.log.verified === false).length
  const entries = nodes.reduce((s, n) => s + (isNum(n.log?.entries) ? n.log.entries : 0), 0)
  const lists = d.sanctions?.lists ?? []
  const listEntries = lists.reduce((s, l) => s + (isNum(l.entries) ? l.entries : 0), 0)
  const c = d.scorer ?? {}
  const borrowers = d.custody?.borrowers ?? []
  const held = borrowers.filter((b) => b.keys_on_this_node && !b.seeded).length
  const personas = borrowers.filter((b) => b.keys_on_this_node && b.seeded).length

  const items = [
    ['sec-access', 'API auth', authTone, a.mode ?? '—', `${a.enforced ? 'enforced' : 'not enforced'} · ${fmtInt(a.operators ?? 0)} operator${a.operators === 1 ? '' : 's'} · ${fmtInt(a.sessions ?? 0)} session${a.sessions === 1 ? '' : 's'}`],
    ['sec-access', 'Signing gate', g.enforced ? 'ok' : 'alert', g.enforced ? 'Enforced' : 'Not enforced', g.detail ?? ''],
    ['sec-kill', 'Kill switch', stopped ? 'warn' : 'ok', stopped ? `${stopped} of ${nodes.length} stopped` : 'Ready, nothing stopped', `${nodes.length} governed node${nodes.length === 1 ? '' : 's'}`],
    ['sec-nodes', 'Policy', problems ? 'alert' : loosening ? 'warn' : 'ok', problems ? `${problems} problem${problems === 1 ? '' : 's'}` : pending ? `${pending} pending change${pending === 1 ? '' : 's'}` : 'In force, none pending', nodes.map((n) => `${n.role} v${n.policy?.version ?? '?'}`).join(' · ')],
    ['sec-nodes', 'Decision log', unverified ? 'alert' : 'ok', unverified ? `${unverified} chain${unverified === 1 ? '' : 's'} broken` : 'Chain verified ✓', `${fmtInt(entries)} entries across ${nodes.length} node${nodes.length === 1 ? '' : 's'}`],
    ['sec-trust', 'Sanctions list', lists.length ? 'ok' : 'warn', lists.length ? `${lists.length} list${lists.length === 1 ? '' : 's'}, as of ${lists.map((l) => l.as_of).filter(Boolean).sort().at(-1) ?? '—'}` : 'No list loaded', `${fmtInt(listEntries)} addresses${has(d.sanctions?.screen) ? ` · ${d.sanctions.screen}` : ''}`],
    ['sec-trust', 'Scorer trust', c.provider ? 'neutral' : 'warn', c.trust_ceiling ?? 'Unknown', c.verification ?? 'No scorer verification metadata reported'],
    ['sec-custody', 'Key custody', held ? 'alert' : personas ? 'warn' : 'ok', held ? `${held} borrower key${held === 1 ? '' : 's'} here` : 'No phone keys here', personas ? `${personas} seeded test persona${personas === 1 ? '' : 's'} (test data) · ${borrowers.length} borrower${borrowers.length === 1 ? '' : 's'} checked` : `${borrowers.length} borrower${borrowers.length === 1 ? '' : 's'} checked`],
  ]
  return `<div class="posture">${items.map(([target, title, tone, value, sub]) => `
    <button type="button" class="pcard st-${tone}" data-action="scrollto" data-target="${target}" data-key="${esc(title)}" style="text-align:left;font:inherit;cursor:pointer">
      <span class="pcard-head"><span>${esc(title)}</span>${st(tone)}</span>
      <span class="pcard-value">${esc(value)}</span>
      <span class="pcard-sub" data-tip="${esc(sub)}">${esc(sub)}</span>
    </button>`).join('')}</div>`
}

// ---------- red team ----------

async function loadProbes(ctx) {
  if (rt.listLoading) return
  rt.listLoading = true
  try {
    const r = await apiGet('/redteam')
    rt.probes = r.probes ?? []
    rt.error = null
  } catch (err) {
    rt.error = err
  } finally {
    rt.listLoading = false
    ctx.rerender()
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function runRedTeam(ctx) {
  if (rt.phase === 'running') return
  rt.phase = 'running'
  rt.results = {}
  rt.error = null
  ctx.rerender()
  try {
    const r = await apiGet('/redteam')
    rt.probes = r.probes ?? []
  } catch (err) {
    rt.error = err
    rt.phase = 'idle'
    return ctx.rerender()
  }
  for (const p of rt.probes) {
    rt.current = p.id
    ctx.rerender()
    const started = performance.now()
    let result
    try {
      result = await apiPost(`/redteam/${encodeURIComponent(p.id)}`)
    } catch (err) {
      result = { id: p.id, error: err.message, unauthorized: err.unauthorized }
    }
    const left = reducedMotion() ? 0 : 450 - (performance.now() - started)
    if (left > 0) await wait(left)
    rt.results[p.id] = result
    rt.current = null
    ctx.rerender()
  }
  rt.phase = 'done'
  ctx.rerender()
}

function verdictOf(res) {
  if (!res) return null
  if (res.error) return 'error'
  if (res.skipped || res.status === 'skipped') return 'skip'
  return res.pass === true ? 'pass' : 'fail'
}

function probeRow(p) {
  const res = rt.results[p.id]
  const running = rt.current === p.id
  const v = verdictOf(res)
  const info = { ...p, ...(res ?? {}) }
  const stateIcon = running
    ? '<span class="spinner" role="status" aria-label="running"></span>'
    : v === 'pass' ? `<span class="probe-state pass">${icon('check')}</span>`
    : v === 'fail' || v === 'error' ? `<span class="probe-state fail">${icon('x')}</span>`
    : v === 'skip' ? `<span class="probe-state skip">${icon('arrow')}</span>`
    : '<span class="probe-state queued"></span>'
  const verdict = running ? '<span class="probe-verdict wait">RUNNING</span>'
    : v === 'pass' ? '<span class="probe-verdict pass" data-tip="Refused as expected">PASS</span>'
    : v === 'fail' ? '<span class="probe-verdict fail" data-tip="This node accepted a request it must refuse">FAIL · accepted!</span>'
    : v === 'skip' ? '<span class="probe-verdict skip" data-tip="Not applicable yet; left out of the score">SKIPPED</span>'
    : v === 'error' ? '<span class="probe-verdict fail" data-tip="The probe itself could not run">ERROR</span>'
    : `<span class="probe-verdict wait">${rt.phase === 'running' ? 'QUEUED' : 'NOT RUN'}</span>`
  const layer = has(info.layer) ? chip(info.layer === 'http' ? 'HTTP' : info.layer === 'in-process' ? 'in-process' : info.layer, 'neutral', { cls: 'tag' }) : ''
  const facts = res && !res.error
    ? `<div class="probe-facts">
        <span>expected <b>${esc(info.expect ?? '—')}</b></span>
        <span>actual <b>${esc(info.status ?? '—')}</b></span>
        ${isNum(info.ms) ? `<span>latency <b>${esc(fmtInt(info.ms))} ms</b></span>` : ''}
        ${info.refused_by ? `<span>refused by ${codeRef(info.refused_by.file, info.refused_by.fn)}</span>` : ''}
      </div>
      ${has(info.reason) ? `<div class="probe-reason">${esc(info.reason)}</div>` : ''}
      ${info.control ? `<div class="probe-facts">${chip(info.control.ok ? 'control ok' : 'control failed', info.control.ok ? 'ok' : 'alert', { dot: true, tip: 'The matching legitimate request, which must be accepted' })}${has(info.control.detail) ? `<span>${esc(info.control.detail)}</span>` : ''}</div>` : ''}`
    : res?.error ? `<div class="probe-reason" style="color:var(--alert)">${esc(res.unauthorized ? 'Operator session missing or expired: open the operator link again.' : res.error)}</div>`
    : `<div class="probe-facts"><span>expected <b>${esc(p.expect ?? '—')}</b></span></div>`
  const cls = running ? ' is-running' : v === 'pass' ? ' is-pass' : v === 'fail' || v === 'error' ? ' is-fail' : ''
  return `<div class="probe${cls}" data-key="${esc(p.id)}">
    ${stateIcon}
    <div style="min-width:0">
      <div class="probe-title">${esc(info.title ?? p.id)} ${layer} <span class="mono muted small">${esc(p.id)}</span></div>
      ${has(info.attack) ? `<div class="probe-attack">${esc(info.attack)}</div>` : ''}
      ${facts}
    </div>
    <div class="probe-verdict-wrap">${verdict}</div>
  </div>`
}

function redTeamCard() {
  const done = rt.probes.filter((p) => rt.results[p.id])
  const verdicts = done.map((p) => verdictOf(rt.results[p.id]))
  const passed = verdicts.filter((v) => v === 'pass').length
  const skipped = verdicts.filter((v) => v === 'skip').length
  const failed = verdicts.filter((v) => v === 'fail' || v === 'error').length
  const counted = verdicts.length - skipped
  const running = rt.phase === 'running'
  const btn = `<button class="btn btn-primary btn-lg" type="button" data-action="redteam"${running ? ' disabled' : ''}>${running ? '<span class="spinner" style="width:16px;height:16px;border-color:rgba(255,255,255,.35);border-top-color:currentColor"></span>Running…' : `${icon('play')}${rt.phase === 'done' ? 'Run again' : 'Run red-team self-test'}`}</button>`
  const summary = rt.phase === 'done' && verdicts.length
    ? failed
      ? `<div class="rt-summary bad" role="status">${icon('alert')}${failed} of ${counted} attack${counted === 1 ? '' : 's'} not refused <span>· investigate before taking traffic${skipped ? ` · ${skipped} skipped` : ''}</span></div>`
      : `<div class="rt-summary ok" role="status">${icon('security')}${passed}/${counted} attacks refused <span>${skipped ? `· ${skipped} skipped (not applicable yet)` : '· every probe was refused by the code named on its row'}</span></div>`
    : ''
  const body = `<div class="redteam-intro">
      <p>Sends ${rt.probes.length ? `${rt.probes.length} requests` : 'requests'} this node must refuse, one at a time: unsigned and replayed requests, the wrong party, tampered term sheets, replayed negotiations and mismatched bindings. Each row names the code that refused it. Skipped probes are left out of the score.</p>
      ${btn}
    </div>
    ${rt.error ? `<div class="banner" role="alert">${icon('alert')}<div class="banner-body">${esc(rt.error.unauthorized ? 'Operator session missing or expired: open the operator link again.' : rt.error.message)}</div></div>` : ''}
    ${rt.probes.length ? `<div class="probes">${rt.probes.map(probeRow).join('')}</div>` : rt.listLoading ? '<div class="sk-stack" style="display:flex;flex-direction:column"><span class="sk" style="height:56px"></span><span class="sk" style="height:56px"></span></div>' : ''}
    ${summary}`
  return card({ title: 'Red-team self-test', iconName: 'target', sub: 'Live attacks against this node, expected to be refused', body, cls: 'redteam', id: 'sec-redteam' })
}

// ---------- detail cards ----------

function accessCards(d) {
  const a = d.api_auth ?? {}
  const g = d.signing_gate ?? {}
  return `<div class="grid g-2" id="sec-access">
    ${card({
      title: 'API auth',
      iconName: 'lock',
      aside: chip(a.mode ?? 'unknown', a.enforced && a.mode === 'enforce' ? 'ok' : a.mode === 'off' ? 'alert' : 'warn', { dot: true }),
      body: kv([
        ['Mode', mono(a.mode)],
        ['Enforced', bool(a.enforced)],
        ['Operator keys', `<span class="num">${esc(fmtInt(a.operators))}</span>`],
        ['Dashboard sessions', `<span class="num">${esc(fmtInt(a.sessions))}</span>`],
        ['Paired devices', `<span class="num">${esc(fmtInt(a.devices))}</span>`],
        ['Local console', a.local_console === true ? chip('allowed', 'warn', { dot: true }) : a.local_console === false ? chip('off', 'ok', { dot: true }) : text(null)],
        ['Source', codeRef(a.source)],
      ]),
    })}
    ${card({
      title: 'Signing gate',
      iconName: 'key',
      aside: chip(g.enforced ? 'enforced' : 'not enforced', g.enforced ? 'ok' : 'alert', { dot: true }),
      body: `${has(g.detail) ? `<p class="small" style="color:var(--text-2)">${esc(g.detail)}</p>` : ''}${kv([['Source', has(g.source) ? `<span class="chips">${String(g.source).split(/,\s*/).map((f) => codeRef(f)).join('')}</span>` : text(null)]])}`,
    })}
  </div>`
}

function policyBlock(p) {
  if (!p) return empty('No policy', 'This node has no signed policy.', 'scale')
  const pending = p.pending ?? []
  return `<div class="field" style="gap:10px">
    <div class="subitem-head"><strong>Policy</strong>${(p.problems ?? []).length ? chip(`${p.problems.length} problem${p.problems.length === 1 ? '' : 's'}`, 'alert', { dot: true }) : chip(`v${p.version ?? '?'}`, 'ok', { dot: true })}</div>
    ${kv([
      ['Version', `<span class="num">${esc(p.version ?? '—')}</span>${has(p.change) ? chip(label(p.change), p.change === 'loosen' ? 'warn' : 'neutral') : ''}`],
      ['Hash', keyCell(p.hash, { what: 'policy hash' })],
      ['In force since', hasTime(p.effective_at) ? `<span data-tip="${esc(absTime(p.effective_at))}">${esc(relTime(p.effective_at))}</span>` : text(null)],
      ['Quorum', p.quorum ? `<span><span class="num">${esc(p.quorum.threshold)} of ${esc(p.quorum.keys)}</span> key${p.quorum.keys === 1 ? '' : 's'}</span>` : text(null)],
      ['Loosening delay', text(isNum(p.loosen_delay_seconds) ? fmtDuration(p.loosen_delay_seconds) : null)],
      ['Sanctions', has(p.sanctions) ? chip(p.sanctions, p.sanctions === 'required' ? 'ok' : 'warn') : text(null)],
    ])}
    ${(p.rules ?? []).length ? `<div><div class="small muted" style="margin-bottom:6px">Rules</div><ul class="rules">${p.rules.map((r) => `<li data-key="${esc(r.id)}"><span class="mono">${esc(r.id)}</span><span>${esc(r.description ?? '')}</span></li>`).join('')}</ul></div>` : ''}
    ${pending.length ? `<div><div class="small muted" style="margin-bottom:6px">Pending versions</div>${pending.map((x) => `<div class="callout" style="margin-bottom:6px" data-key="${esc(x.version)}">${icon('clock')}<div><strong>v${esc(x.version)}</strong> ${chip(label(x.change), x.change === 'loosen' ? 'warn' : 'neutral')} ${hasTime(x.effective_at) ? `effective <span data-tip="${esc(absTime(x.effective_at))}">${esc(relTime(x.effective_at))}</span>` : ''}${(x.reasons ?? []).length ? `<div class="small">${x.reasons.map(esc).join('; ')}</div>` : ''}</div></div>`).join('')}</div>` : ''}
    ${(p.problems ?? []).length ? `<ul class="problems">${p.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
  </div>`
}

function logBlock(l, now) {
  if (!l) return empty('No decision log', 'This node has not logged decisions yet.', 'ledger')
  const kinds = Object.entries(l.by_kind ?? {}).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...kinds.map(([, n]) => n))
  return `<div class="field" style="gap:10px">
    <div class="subitem-head"><strong>Decision log</strong>${l.verified ? `<span class="verified">${icon('check')}chain verified</span>` : chip('chain broken', 'alert', { dot: true })}</div>
    ${kv([
      ['Entries', `<span class="num">${esc(fmtInt(l.entries))}</span>`],
      ['Head', keyCell(l.head, { what: 'log head hash' })],
      ['Anchor', text(l.anchor)],
      ['Refused', `<span class="num">${esc(fmtInt(l.refused))}</span>`],
      ['Last entry', timeCell(l.last_at, now)],
    ])}
    ${(l.problems ?? []).length ? `<ul class="problems">${l.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${kinds.length ? `<div><div class="small muted" style="margin-bottom:6px">By kind</div><div class="bars">${kinds.map(([k, n]) => `<div class="bar-row" data-key="${esc(k)}"><span class="mono" data-tip="${esc(k)}">${esc(k)}</span><span class="bar-track"><span class="bar-fill" style="width:${(n / max) * 100}%;display:block"></span></span><b>${esc(fmtInt(n))}</b></div>`).join('')}</div></div>` : ''}
  </div>`
}

function killBlock(k, now) {
  if (!k) return empty('No kill-switch state', '', 'power')
  const agents = k.agents ?? []
  return `<div class="field" style="gap:10px">
    <div class="subitem-head"><strong>Kill switch</strong>${k.stopped ? chip('stopped', 'alert', { dot: true }) : chip('running', 'ok', { dot: true })}</div>
    ${agents.length ? `<div class="sublist">${agents.map((a, i) => `<div class="subitem" data-key="${esc(`${a.agent}-${i}`)}">
        <div class="subitem-head"><span class="mono">${esc(a.agent === '*' ? '* (every agent)' : a.agent)}</span>${timeCell(a.at, now)}</div>
        ${kv([['By', keyCell(a.by, { what: 'key' })], ['Reason', text(a.reason)]])}
      </div>`).join('')}</div>` : '<p class="small muted">No agent is stopped on this node.</p>'}
  </div>`
}

function nodesSection(d, now) {
  const nodes = d.nodes ?? []
  if (!nodes.length) return empty('No governed nodes', 'Policy, decision log and kill-switch state appear per node.', 'node')
  return `<div class="grid" id="sec-nodes">${nodes.map((n) => card({
    title: esc(n.role ?? 'node'),
    sub: has(n.kind) ? esc(n.kind) : 'governed node',
    iconName: 'node',
    aside: keyCell(n.gate_pk, { what: 'gate key' }),
    body: `<div class="grid g-3">${policyBlock(n.policy)}${logBlock(n.log, now)}${killBlock(n.kill_switch, now)}</div>`,
  })).join('')}</div>`
}

function qvacText(q) {
  if (!has(q)) return text(null)
  if (typeof q !== 'object') return text(q)
  return `${has(q.status) ? chip(q.status, q.status === 'ready' ? 'ok' : q.status === 'down' ? 'alert' : 'warn', { dot: true }) : ''}${mono(q.url)}`
}

function trustCards(d, now) {
  const s = d.sanctions ?? {}
  const c = d.scorer ?? {}
  const r = c.release ?? {}
  return `<div class="grid g-2" id="sec-trust">
    ${card({
      title: 'Sanctions list',
      iconName: 'list',
      aside: '',
      body: `${kv([['Screen', text(s.screen)], ['List version', mono(s.list_version)]])}
        ${table([
          { label: 'List', cls: 'wrap', cell: (l) => `<div>${text(l.title)}</div><div class="mono muted small">${esc(l.list_id ?? '')}</div>` },
          { label: 'As of', cell: (l) => text(l.as_of) },
          { label: 'Entries', cls: 'r', cell: (l) => `<span class="num">${esc(fmtInt(l.entries))}</span>` },
          { label: 'sha256', cell: (l) => keyCell(l.sha256, { what: 'sha256' }) },
        ], s.lists ?? [], { key: (l) => l.list_id, emptyHtml: empty('No sanctions list loaded', 'Screening needs a list before loans can pass the sanctions rule.', 'list') })}`,
    })}
    ${card({
      title: 'Scorer trust',
      iconName: 'cpu',
      aside: chip(c.trust_ceiling ?? 'unknown', 'neutral'),
      body: `${kv([
        ['Release hash', keyCell(c.release_hash, { what: 'release hash' })],
        ['Provider', text(r.provider)],
        ['Image digest', keyCell(r.image_digest, { head: 14, tail: 6, what: 'image digest' })],
        ['Scoring contract', keyCell(r.scoring_contract_hash, { what: 'scoring contract hash' })],
        ['Model hash', has(r.model_hash) ? keyCell(r.model_hash, { what: 'model hash' }) : '<span class="muted">— none pinned</span>'],
        ['Verification', text(c.verification)],
        ['QVAC server', c.qvac_server && typeof c.qvac_server === 'object' ? (c.qvac_server.models?.length ? c.qvac_server.models.map((m) => mono(`${m.id} · ${m.state}`)).join(' ') : text(c.qvac_server.status)) : text(null)],
        ['Scorer', text(c.scorer_label)],
      ])}
      ${table([
        { label: 'Run', cell: (x) => timeCell(x.at, now) },
        { label: 'Negotiation', cell: (x) => keyCell(x.negotiation_id, { head: 6, tail: 4, what: 'negotiation id' }) },
        { label: 'Lender verification', cell: (x) => (x.verified ? chip('verified', 'ok', { dot: true }) : chip('failed: not underwritten', 'warn', { dot: true })) },
        { label: 'Paid', cell: (x) => text(x.paid) },
        { label: 'Rail', cls: 'wrap', cell: (x) => `<span class="small">${text(x.rail)}</span>` },
        { label: 'Lender', cell: (x) => keyCell(x.lender_pk, { head: 6, tail: 4, what: 'lender key' }) },
      ], c.recent_runs ?? [], { key: (x, i) => `${x.negotiation_id}-${x.at}-${i}`, emptyHtml: empty('No scoring runs yet', 'Each credit check run shows here with its evidence verification.', 'cpu') })}`,
    })}
  </div>`
}

function custodyCard(d) {
  const c = d.custody ?? {}
  const list = c.borrowers ?? []
  return card({
    title: 'Key custody',
    iconName: 'key',
    id: 'sec-custody',
    sub: 'Whose keys this node holds',
    body: `${has(c.statement) ? `<p style="color:var(--text-2)">${esc(c.statement)}</p>` : ''}
      ${list.length ? `<div class="sublist">${list.map((b) => `<div class="subitem" data-key="${esc(b.borrower_pk)}" style="flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:wrap">
          <span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0">${keyCell(b.borrower_pk, { what: 'borrower key' })}${has(b.label) ? `<span class="small muted">${esc(b.label)}</span>` : ''}</span>
          ${b.keys_on_this_node ? (b.seeded ? chip('seeded test persona: test wallet on this laptop', 'warn', { dot: true }) : chip('keys on this node: yes', 'alert', { dot: true })) : chip('keys on this node: no', 'ok', { dot: true })}
        </div>`).join('')}</div>` : empty('No borrowers yet', 'Each borrower this node has seen is listed with where its keys live.', 'user')}`,
  })
}

// ---------- kill switch ----------

const killable = (d) => (d?.nodes ?? []).filter((n) => !has(n.kind) || KILLABLE_KINDS.has(n.kind) || n.role === 'platform')

function killCard(d) {
  return card({
    title: 'Kill switch',
    iconName: 'power',
    id: 'sec-kill',
    sub: 'Danger zone',
    cls: 'danger',
    body: `<div class="danger-row">
        <p>Stops every agent on the chosen node and revokes its session keys, through the same path as <span class="mono">passbook agent stop --all</span>. Open loans keep their on-chain exits.</p>
        <div>
          <button class="btn btn-danger" type="button" data-action="ksOpen"${killable(d).length ? '' : ' disabled'}>${icon('power')}Engage kill switch…</button>
          <div class="cant-undo">Can't be undone from the console.</div>
        </div>
      </div>
      ${ks.lines && !ks.open ? `<div><div class="small muted" style="margin-bottom:6px">Last result</div><pre class="lines">${esc(ks.lines.join('\n'))}</pre></div>` : ''}`,
  })
}

function killModal(d) {
  if (!ks.open) return ''
  const nodes = killable(d)
  const ready = ks.confirm === 'STOP' && !ks.busy
  const result = ks.lines && !ks.busy && !ks.error
  return `<div class="modal-backdrop" data-action="ksBackdrop" data-key="ks-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ks-title">
      <div class="modal-head">
        <span class="modal-ic">${icon('power')}</span>
        <div><h2 id="ks-title">${result ? 'Kill switch engaged' : 'Engage the kill switch'}</h2><p>Runs <span class="mono">passbook agent stop --all</span> against the node's governance store.</p></div>
      </div>
      ${result ? `<div class="modal-body"><pre class="lines">${esc(ks.lines.join('\n'))}</pre></div>
        <div class="modal-foot"><button class="btn btn-primary" type="button" data-action="ksClose">Done</button></div>` : `
      <div class="modal-body">
        <div class="field">
          <label for="ks-node">Node</label>
          <select id="ks-node" class="select" data-change="ksNode"${ks.busy ? ' disabled' : ''}>
            <option value="all"${ks.node === 'all' ? ' selected' : ''}>All eligible nodes</option>
            ${nodes.map((n) => `<option value="${esc(n.role)}"${ks.node === n.role ? ' selected' : ''}>${esc(n.role)}${has(n.kind) ? ` (${esc(n.kind)})` : ''}</option>`).join('')}
          </select>
          <span class="hint">Only the platform and the provider's own lenders can be stopped from here.</span>
        </div>
        <div class="callout">${icon('info')}<div><strong>Open loans keep their on-chain exits.</strong> Stopping halts this node's agents and revokes their session keys. It does not touch the chain: nothing already on-chain is cancelled, moved or locked.</div></div>
        <div class="field">
          <label for="ks-confirm">Type <span class="mono">STOP</span> to confirm</label>
          <input id="ks-confirm" class="input confirm${ks.confirm === 'STOP' ? ' ok' : ''}" data-input="ksConfirm" autocomplete="off" spellcheck="false" placeholder="STOP"${ks.busy ? ' disabled' : ''}>
        </div>
        <div class="field">
          <label for="ks-reason">Reason <span class="muted">(optional, written to the decision log)</span></label>
          <textarea id="ks-reason" class="textarea" data-input="ksReason" rows="2" maxlength="500"${ks.busy ? ' disabled' : ''}></textarea>
        </div>
        ${ks.error ? `<div class="banner" role="alert">${icon('alert')}<div class="banner-body">${esc(ks.error)}</div></div>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn" type="button" data-action="ksClose"${ks.busy ? ' disabled' : ''}>Cancel</button>
        <button class="btn btn-danger" type="button" data-action="ksSubmit"${ready ? '' : ' disabled'}>${ks.busy ? '<span class="spinner" style="width:14px;height:14px;border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>Stopping…' : `${icon('power')}Stop ${ks.node === 'all' ? 'all eligible nodes' : esc(ks.node)}`}</button>
      </div>`}
    </div>
  </div>`
}

async function submitKill(ctx) {
  if (ks.confirm !== 'STOP' || ks.busy) return
  ks.busy = true
  ks.error = null
  ctx.rerender()
  try {
    const r = await apiPost('/kill-switch', { node: ks.node, confirm: 'STOP', reason: ks.reason.trim() })
    ks.lines = Array.isArray(r.lines) && r.lines.length ? r.lines : [r.ok ? 'ok' : JSON.stringify(r)]
    toast('Kill switch engaged')
    ctx.refresh()
  } catch (err) {
    ks.error = err.unauthorized ? 'Operator session missing or expired: open the operator link again.' : err.message
  } finally {
    ks.busy = false
    ctx.rerender()
  }
}

function closeKill(ctx) {
  if (ks.busy) return
  ks.open = false
  ks.error = null
  ctx.rerender()
}

export default {
  id: 'security',
  title: 'Security, live',
  nav: 'Security',
  icon: 'security',
  subtitle: 'Posture of this node, read live from its governance stores, plus a red-team self-test you can run now.',
  endpoint: '/security',
  interval: 5000,
  onEnter(ctx) {
    if (!rt.probes.length && rt.phase === 'idle') loadProbes(ctx)
  },
  render(ctx) {
    const d = ctx.data
    if (!d) return `<div class="posture">${Array.from({ length: 8 }, () => '<div class="pcard"><span class="sk" style="height:12px;width:50%"></span><span class="sk" style="height:18px;width:70%"></span><span class="sk" style="height:10px;width:60%"></span></div>').join('')}</div>${redTeamCard()}<div class="grid g-2">${skeletonCards(2, 5)}</div>`
    return `${posture(d)}
      ${redTeamCard()}
      <div class="section-title"><h2>Access</h2><p>Who may call this node and what it will sign</p></div>
      ${accessCards(d)}
      <div class="section-title"><h2>Governance per node</h2><p>Policy, decision log and kill-switch state</p></div>
      ${nodesSection(d, ctx.now)}
      <div class="section-title"><h2>Trust evidence</h2><p>Sanctions screening and the credit scorer's release</p></div>
      ${trustCards(d, ctx.now)}
      ${custodyCard(d)}
      ${killCard(d)}
      ${killModal(d)}`
  },
  afterRender(root) {
    if (ks.focus) {
      ks.focus = false
      root.querySelector('#ks-node')?.focus()
    }
  },
  actions: {
    redteam: (el, ev, ctx) => runRedTeam(ctx),
    scrollto(el) {
      const t = document.getElementById(el.getAttribute('data-target'))
      t?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
    },
    ksOpen(el, ev, ctx) {
      Object.assign(ks, { open: true, node: 'all', confirm: '', reason: '', error: null, lines: null, focus: true })
      ctx.rerender()
    },
    ksClose: (el, ev, ctx) => closeKill(ctx),
    ksBackdrop(el, ev, ctx) { if (ev.target === el) closeKill(ctx) },
    ksNode(el, ev, ctx) { ks.node = el.value; ctx.rerender() },
    ksConfirm(el, ev, ctx) { ks.confirm = el.value.trim(); ctx.rerender() },
    ksReason(el) { ks.reason = el.value },
    ksSubmit: (el, ev, ctx) => submitKill(ctx),
    escape(el, ev, ctx) { if (ks.open) closeKill(ctx) },
  },
}
