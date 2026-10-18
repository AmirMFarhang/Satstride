// Market and loans: relay offers, check offers, negotiations, the checks
// funnel, loans by state and the operator agenda.

import { esc, has, isNum, fmtInt, fmtPct, fmtHeight, relTime, absTime, hasTime, label, KIND_LABELS, short } from './format.js'
import { icon, amt, chip, statusChip, keyCell, text, card, empty, table, timeCell, skeletonCards } from './ui.js'

const LOAN_STATES = [
  ['pending', '--s4'],
  ['locked', '--s7'],
  ['open', '--s1'],
  ['repaid', '--s3'],
  ['defaulted', '--s2'],
  ['liquidated', '--s8'],
  ['refunded', '--s5'],
]

const SEV_RANK = { alert: 0, warn: 1, info: 2 }

function agendaCard(d, now) {
  const items = [...(d.agenda ?? [])].sort((a, b) => {
    const s = (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3)
    if (s) return s
    const ah = isNum(a.due_height) && a.due_height > 0 ? a.due_height : Infinity
    const bh = isNum(b.due_height) && b.due_height > 0 ? b.due_height : Infinity
    if (ah !== bh) return ah - bh
    return (hasTime(a.due_at) ? a.due_at : Infinity) - (hasTime(b.due_at) ? b.due_at : Infinity)
  })
  const counts = { alert: 0, warn: 0, info: 0 }
  for (const i of items) if (i.severity in counts) counts[i.severity]++
  const aside = items.length ? `${counts.alert ? chip(`${counts.alert} alert`, 'alert', { dot: true }) : ''}${counts.warn ? chip(`${counts.warn} warn`, 'warn', { dot: true }) : ''}${counts.info ? chip(`${counts.info} info`, 'info', { dot: true }) : ''}` : chip('all clear', 'ok', { dot: true })
  const due = (i) => {
    const parts = []
    if (isNum(i.due_height) && i.due_height > 0) {
      const left = isNum(d.height) ? i.due_height - d.height : null
      parts.push(`<b>${esc(fmtHeight(i.due_height))}</b>${left !== null ? `<span>${left > 0 ? `in ${fmtInt(left)} block${left === 1 ? '' : 's'}` : left === 0 ? 'this block' : `${fmtInt(-left)} block${left === -1 ? '' : 's'} ago`}</span>` : ''}`)
    }
    if (hasTime(i.due_at)) parts.push(`<span data-tip="${esc(absTime(i.due_at))}">${esc(relTime(i.due_at, now))}</span>`)
    return parts.join('') || '<span>no deadline</span>'
  }
  return card({
    title: 'Operator agenda',
    iconName: 'list',
    sub: 'What needs you, most urgent first',
    aside,
    body: items.length
      ? `<div class="agenda">${items.map((i, n) => `<div class="agenda-item sev-${esc(i.severity)}" data-key="${esc(`${i.kind}-${i.title}-${n}`)}">
          <span class="agenda-bar" aria-hidden="true"></span>
          <div style="min-width:0">
            <div class="agenda-title">${esc(i.title)} ${chip(label(i.kind), 'neutral')}</div>
            ${has(i.detail) ? `<div class="agenda-detail">${esc(i.detail)}</div>` : ''}
          </div>
          <div class="agenda-due">${due(i)}</div>
        </div>`).join('')}</div>`
      : empty('Nothing is waiting on you', 'Fees due, maturities, pending checks and policy changes appear here.', 'check'),
  })
}

function funnelCard(d) {
  const c = d.checks ?? {}
  const req = isNum(c.requested) ? c.requested : 0
  const stages = [
    ['Requested', c.requested, '--funnel-1'],
    ['Paid', c.paid, '--funnel-2'],
    ['Released', c.released, '--funnel-3'],
  ]
  const pct = (v) => (req > 0 && isNum(v) ? Math.max(v > 0 ? 3 : 0, Math.min(100, (v / req) * 100)) : 0)
  const relay = c.relay ?? {}
  const relayKinds = Object.keys(relay)
  return card({
    title: 'Checks funnel',
    iconName: 'target',
    sub: 'Credit checks from request to released result',
    body: `<div class="funnel" role="img" aria-label="${esc(`Requested ${req}, paid ${c.paid ?? 0}, released ${c.released ?? 0}`)}">
        ${stages.map(([name, v, color], i) => `
          ${i ? `<div class="funnel-arrow" aria-hidden="true">${isNum(v) && req > 0 ? `↓ ${Math.round((v / Math.max(1, stages[i - 1][1] ?? 0)) * 100) || 0}%` : '↓'}</div>` : ''}
          <div class="funnel-row" data-key="${name}">
            <span class="funnel-label">${name}</span>
            <span class="funnel-track"><span class="funnel-bar" style="width:${pct(v)}%;background:var(${color})"></span></span>
            <span class="funnel-count">${esc(fmtInt(v))}</span>
          </div>`).join('')}
      </div>
      <div class="funnel-side">
        ${chip(`refused ${fmtInt(c.refused ?? 0)}`, c.refused ? 'alert' : 'neutral', { dot: true })}
        ${chip(`unpaid ${fmtInt(c.unpaid ?? 0)}`, c.unpaid ? 'warn' : 'neutral', { dot: true })}
        ${chip(`awaiting payment ${fmtInt(c.awaiting_payment ?? 0)}`, c.awaiting_payment ? 'warn' : 'neutral', { dot: true })}
      </div>
      ${relayKinds.length ? `<div class="small muted">On the relay: ${relayKinds.map((k) => `<span class="mono">${esc(k)}</span> ${esc(KIND_LABELS[k] ?? '')} ×${esc(fmtInt(relay[k]))}`).join(' · ')}</div>` : ''}`,
  })
}

function loansCard(d, now) {
  const l = d.loans ?? {}
  const by = l.by_state ?? {}
  const known = new Set(LOAN_STATES.map(([s]) => s))
  const states = [...LOAN_STATES, ...Object.keys(by).filter((s) => !known.has(s)).map((s) => [s, '--neutral-dot'])]
  const total = states.reduce((s, [k]) => s + (isNum(by[k]) ? by[k] : 0), 0)
  const bar = total
    ? `<div class="segbar" role="img" aria-label="${esc(states.filter(([k]) => by[k]).map(([k]) => `${k} ${by[k]}`).join(', '))}">${states.filter(([k]) => by[k] > 0).map(([k, c]) => `<span data-key="${k}" style="flex-grow:${by[k]};background:var(${c})" data-tip="${esc(`${k}: ${by[k]}`)}"></span>`).join('')}</div>`
    : '<div class="segbar" aria-hidden="true"></div>'
  const legend = `<div class="seg-legend">${states.map(([k, c]) => `<span class="legend-item${by[k] ? '' : ' zero'}" data-key="${k}"><span class="swatch" style="--swatch:var(${c})"></span>${esc(k)} <b>${esc(fmtInt(by[k] ?? 0))}</b></span>`).join('')}</div>`
  const items = [...(l.items ?? [])].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
  return card({
    title: 'Loans by state',
    iconName: 'bank',
    sub: `${fmtInt(total)} loan${total === 1 ? '' : 's'} in the registry`,
    body: `${bar}${legend}
      ${table([
        { label: 'Loan', cell: (r) => keyCell(r.id, { what: 'loan id' }) },
        { label: 'State', cell: (r) => statusChip(r.status) },
        { label: 'Borrower', cell: (r) => keyCell(r.borrower_pk, { what: 'borrower key' }) },
        { label: 'Lender', cell: (r) => keyCell(r.lender_pk, { what: 'lender key' }) },
        { label: 'Principal', cls: 'r', cell: (r) => amt(r.principal, d.asset) },
        { label: 'Fee', cls: 'r', cell: (r) => amt(r.fee, d.asset) },
        { label: 'LTV', cls: 'r', cell: (r) => `<span class="num">${esc(fmtPct(r.ltv_bps))}</span>` },
        { label: 'Open → maturity', cell: (r) => `<span class="num">${esc(fmtHeight(r.open_height))} → ${esc(fmtHeight(r.maturity_height))}</span>` },
        { label: 'Lock tx', cell: (r) => keyCell(r.lock_txid, { head: 6, tail: 4, what: 'lock txid' }) },
        { label: 'Disbursement tx', cell: (r) => keyCell(r.disbursement_txid, { head: 6, tail: 4, what: 'disbursement txid' }) },
        { label: 'Release tx', cell: (r) => keyCell(r.release_txid, { head: 6, tail: 4, what: 'release txid' }) },
        { label: 'Updated', cell: (r) => timeCell(r.updated_at, now) },
      ], items, { key: (r) => r.id, emptyHtml: empty('No loans yet', 'Loans appear when a negotiation reaches a term sheet and collateral locks.', 'bank') })}`,
  })
}

function offersCard(d) {
  const a = d.asset
  const range = (o) => {
    if (!(isNum(o.max) && o.max > 0) && !(isNum(o.min) && o.min > 0)) return '<span class="muted">—</span>'
    return `${amt(o.min, a)} <span class="muted">–</span> ${amt(o.max, a)}`
  }
  return card({
    title: 'Offers on the relay',
    iconName: 'market',
    sub: 'Standing lender offers (kind 38388)',
    aside: chip(`${(d.offers ?? []).length}`, 'neutral'),
    body: table([
      { label: 'Lender', cell: (o) => keyCell(o.lender_pk, { what: 'lender key' }) },
      { label: 'APR', cls: 'r', cell: (o) => `<span class="num">${esc(fmtPct(o.apr_bps))}</span>` },
      { label: 'Principal', cell: range },
      { label: 'Term', cls: 'r', cell: (o) => (isNum(o.term_blocks) ? `<span class="num">${esc(fmtInt(o.term_blocks))}</span> <span class="muted">blocks</span>` : '<span class="muted">—</span>') },
      { label: 'LTV ladder', cls: 'wrap', cell: (o) => ((o.ltv_ladder_bps ?? []).length ? `<span class="chips">${o.ltv_ladder_bps.map((b) => chip(fmtPct(b), 'neutral')).join('')}</span>` : '<span class="muted">—</span>') },
      { label: 'Negotiable', cell: (o) => (o.negotiable ? chip(`negotiable${isNum(o.max_rounds) ? ` · ${o.max_rounds} rounds` : ''}`, 'brand') : chip('fixed', 'neutral')) },
      { label: 'Expires', cls: 'r', cell: (o) => `<span class="num">${esc(fmtHeight(o.expires_height))}</span>` },
    ], d.offers ?? [], { key: (o) => o.id, emptyHtml: empty('No offers on the relay', 'Lender offers appear when a lender peer publishes one.', 'market') }),
  })
}

function checkOffersCard(d, now) {
  return card({
    title: 'Check-node offers',
    iconName: 'target',
    sub: 'Credit checks for sale (kind 38401)',
    aside: chip(`${(d.check_offers ?? []).length}`, 'neutral'),
    body: table([
      { label: 'Operator', cell: (o) => keyCell(o.operator_pk, { what: 'operator key' }) },
      { label: 'Price', cls: 'r', cell: (o) => amt(o.price?.amount, d.asset) },
      { label: 'Payer', cell: (o) => `<span class="chips">${(o.payer_modes ?? []).map((m) => chip(m)).join('') || '—'}</span>` },
      { label: 'Release hash', cell: (o) => keyCell(o.release_hash, { what: 'release hash' }) },
      { label: 'Published', cell: (o) => timeCell(o.at, now) },
    ], d.check_offers ?? [], { key: (o) => o.operator_pk, emptyHtml: empty('No check offers', 'A check node publishes its price and release hash here.', 'target') }),
  })
}

function negotiationsCard(d, now) {
  const kinds = (k) => {
    const entries = Object.entries(k ?? {}).sort(([a], [b]) => Number(a) - Number(b))
    return entries.length ? `<span class="chips">${entries.map(([kind, n]) => chip(`${KIND_LABELS[kind]?.replace(/^NEG_/, '') ?? kind} ×${n}`, 'neutral', { cls: 'chip-mono', tip: `kind ${kind}${KIND_LABELS[kind] ? ` (${KIND_LABELS[kind]})` : ''}` })).join('')}</span>` : '<span class="muted">—</span>'
  }
  const rows = [...(d.negotiations ?? [])].sort((a, b) => (b.last_at ?? 0) - (a.last_at ?? 0))
  return card({
    title: 'Negotiations',
    iconName: 'copilot',
    sub: 'Hash-chained, signed messages per negotiation',
    aside: chip(`${rows.length}`, 'neutral'),
    body: table([
      { label: 'Negotiation', cell: (n) => keyCell(n.id, { what: 'negotiation id' }) },
      { label: 'Messages', cls: 'r', cell: (n) => `<span class="num">${esc(fmtInt(n.messages))}</span>` },
      { label: 'Kinds', cls: 'wrap', cell: (n) => kinds(n.kinds) },
      { label: 'State', cell: (n) => statusChip(n.state) },
      { label: 'Parties', cell: (n) => (n.participants ?? []).length ? `<span class="chips">${n.participants.map((p) => `<span class="mono small" data-tip="${esc(p)}" tabindex="0">${esc(short(p, 6, 4))}</span>`).join('<span class="muted">↔</span>')}</span>` : '<span class="muted">—</span>' },
      { label: 'Started', cell: (n) => timeCell(n.first_at, now) },
      { label: 'Last activity', cell: (n) => timeCell(n.last_at, now) },
    ], rows, { key: (n) => n.id, emptyHtml: empty('No negotiations yet', 'A borrower opens one with a public ASK (kind 7490).', 'copilot') }),
  })
}

export default {
  id: 'market',
  title: 'Market and loans',
  nav: 'Market & loans',
  icon: 'market',
  subtitle: 'Offers, negotiations, credit checks and loans this provider can see, plus what is waiting on you.',
  endpoint: '/market',
  interval: 5000,
  render(ctx) {
    const d = ctx.data
    if (!d) return `<div class="grid g-wide-narrow">${skeletonCards(2, 5)}</div><div class="grid">${skeletonCards(2, 4)}</div>`
    return `<div class="note">${icon('lock')}<div>Contents are NIP-44 encrypted between the parties; the console sees ids and counts only.${isNum(d.height) ? ` <span class="muted">Chain height ${esc(fmtHeight(d.height))}.</span>` : ''}</div></div>
      <div class="grid g-wide-narrow">
        ${agendaCard(d, ctx.now)}
        ${funnelCard(d)}
      </div>
      ${loansCard(d, ctx.now)}
      ${negotiationsCard(d, ctx.now)}
      ${offersCard(d)}
      ${checkOffersCard(d, ctx.now)}`
  },
}
