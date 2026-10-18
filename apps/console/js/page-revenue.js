// Revenue: three streams, a cumulative chart, per-loan and per-check tables, CSV export.

import { esc, has, isNum, fmtInt, fmtPct, fmtHeight, fmtUnits, amountDecimals, tickerOf, assetNote, label } from './format.js'
import { icon, amt, statusChip, keyCell, text, card, empty, table, timeCell, skeleton, skeletonCards, tileSkeleton } from './ui.js'
import { apiDownload } from './api.js'
import { toast } from './dom.js'
import { drawStackedArea } from './chart.js'

const LAYERS = [
  { key: 'platform_fees', label: 'Platform fee share', color: '--s1' },
  { key: 'check_fees', label: 'Check fees', color: '--s2' },
  { key: 'lender_interest', label: 'Lender interest', color: '--s3' },
]

let downloading = false
let chartModel = null

function countValue(micro, asset) {
  if (!isNum(micro)) return '<span class="muted">—</span>'
  const dec = amountDecimals(micro)
  return `<span data-count="${micro}" data-format="amount" data-decimals="${dec}">${esc(fmtUnits(micro, dec))}</span><span class="unit" data-tip="${esc(assetNote(asset))}">${esc(tickerOf(asset))}</span>`
}

function streamCard({ key, title, color, micro, sub, asset, accent = false }) {
  return `<div class="tile stream${accent ? ' tile-accent' : ''}" data-pulse data-key="${key}" style="--swatch:${color ? `var(${color})` : 'var(--brand)'}">
    <div class="tile-label">${color ? '<span class="swatch"></span>' : icon('revenue', 15)}${title}</div>
    <div class="tile-value">${countValue(micro, asset)}</div>
    <div class="tile-sub">${sub}</div>
  </div>`
}

function streams(d) {
  const t = d.totals ?? {}
  const pf = t.platform_fees ?? {}
  const cf = t.check_fees ?? {}
  const li = t.lender_interest ?? {}
  const a = d.asset
  const due = isNum(pf.due) && pf.due > 0 ? ` · ${fmtUnits(pf.due)} ${tickerOf(a)} due` : ''
  return `<div class="streams">
    ${streamCard({ key: 'pf', title: 'Platform fee share', color: '--s1', micro: pf.earned, asset: a, sub: `${fmtInt(pf.paid_count ?? 0)} paid · ${fmtInt(pf.due_count ?? 0)} due${due}` })}
    ${streamCard({ key: 'cf', title: 'Check fees', color: '--s2', micro: cf.earned, asset: a, sub: `${fmtInt(cf.settled_count ?? 0)} settled · ${fmtInt(cf.pending ?? 0)} pending` })}
    ${streamCard({ key: 'li', title: 'Lender interest', color: '--s3', micro: li.earned, asset: a, sub: `from ${fmtInt(li.count ?? 0)} repaid loan${li.count === 1 ? '' : 's'}` })}
    ${streamCard({ key: 'all', title: 'All earned', micro: t.all_earned, asset: a, accent: true, sub: 'every stream, in test coins' })}
  </div>`
}

function buildModel(d, now) {
  const series = [...(d.series ?? [])].filter((p) => isNum(p.t)).sort((a, b) => a.t - b.t)
  if (!series.length) return null
  const cum = Object.fromEntries(LAYERS.map((l) => [l.key, 0]))
  const points = series.map((p) => {
    const inc = {}
    for (const l of LAYERS) {
      inc[l.key] = isNum(p[l.key]) ? p[l.key] : 0
      cum[l.key] += inc[l.key]
    }
    return { t: p.t, inc, cum: { ...cum } }
  })
  return { layers: LAYERS, points, asset: d.asset, now }
}

function chartCard(d, now) {
  chartModel = buildModel(d, now)
  const legend = `<div class="legend">${LAYERS.map((l) => `<span class="legend-item"><span class="swatch" style="--swatch:var(${l.color})"></span>${l.label}</span>`).join('')}</div>`
  return card({
    title: 'Cumulative earnings',
    iconName: 'revenue',
    sub: 'Running total by stream, hourly (times in your local time zone)',
    body: chartModel
      ? `${legend}<div class="chart" data-own data-chart="revenue"></div>`
      : empty('No revenue yet', 'The chart starts with the first settled check fee, platform fee or repaid loan.', 'revenue'),
  })
}

function loanRows(d) {
  const byId = new Map()
  for (const f of d.platform_fees ?? []) byId.set(f.loan_id, { id: f.loan_id, fee: f })
  for (const i of d.lender_interest ?? []) {
    const row = byId.get(i.loan_id) ?? { id: i.loan_id }
    row.interest = i
    byId.set(i.loan_id, row)
  }
  const at = (r) => Math.max(r.fee?.at ?? 0, r.interest?.at ?? 0)
  return [...byId.values()].sort((a, b) => at(b) - at(a))
}

function loansTable(d, now) {
  const a = d.asset
  const rows = loanRows(d)
  return card({
    title: 'Per loan',
    iconName: 'bank',
    sub: 'Platform fee share and lender interest for each closed loan',
    body: table([
      { label: 'Loan', cell: (r) => keyCell(r.id, { what: 'loan id' }) },
      { label: 'Lender', cell: (r) => keyCell(r.fee?.lender_pk ?? r.interest?.lender_pk, { what: 'lender key' }) },
      { label: 'Principal', cls: 'r', cell: (r) => amt(r.interest?.principal, a) },
      { label: 'Interest', cls: 'r', cell: (r) => amt(r.interest?.interest ?? r.fee?.interest, a) },
      { label: 'Share', cls: 'r', cell: (r) => `<span class="num">${esc(fmtPct(r.fee?.share_bps))}</span>` },
      { label: 'Platform fee', cls: 'r', cell: (r) => amt(r.fee?.amount, a) },
      { label: 'Fee status', cell: (r) => statusChip(r.fee?.status) },
      { label: 'Outcome', cell: (r) => statusChip(r.interest?.status ?? r.fee?.outcome) },
      { label: 'Closed / paid', cell: (r) => `<span class="num">${esc(fmtHeight(r.fee?.closed_height))} / ${esc(fmtHeight(r.fee?.paid_height))}</span>` },
      { label: 'Fee txid', cell: (r) => keyCell(r.fee?.paid_txid, { what: 'txid' }) },
      { label: 'When', cell: (r) => timeCell(Math.max(r.fee?.at ?? 0, r.interest?.at ?? 0), now) },
    ], rows, {
      key: (r) => r.id,
      emptyHtml: empty('No platform fees yet', 'The first fee is invoiced when a funded loan closes.', 'bank'),
    }),
  })
}

function checksTable(d, now) {
  const a = d.asset
  const rows = [...(d.check_fees ?? [])].sort((x, y) => (y.at ?? 0) - (x.at ?? 0))
  return card({
    title: 'Per check',
    iconName: 'target',
    sub: 'Credit-check bills settled with the close-time fee',
    body: table([
      { label: 'Negotiation', cell: (r) => keyCell(r.negotiation_id, { what: 'negotiation id' }) },
      { label: 'Amount', cls: 'r', cell: (r) => amt(r.amount, a) },
      { label: 'Bill', cell: (r) => keyCell(r.bill_hash, { what: 'bill hash' }) },
      { label: 'Status', cell: (r) => statusChip(r.status) },
      { label: 'Rail', cls: 'wrap', cell: (r) => `<span class="small">${text(r.rail)}</span>` },
      { label: 'Receipt', cell: (r) => keyCell(r.receipt, { what: 'receipt' }) },
      { label: 'When', cell: (r) => timeCell(r.at, now) },
    ], rows, {
      key: (r, i) => r.bill_hash || `${r.negotiation_id}-${i}`,
      emptyHtml: empty('No check fees yet', 'A bill earns revenue when its close-time fee is paid.', 'target'),
    }),
  })
}

function sources(d) {
  const s = d.sources ?? []
  if (!s.length) return ''
  return `<div class="sources"><span>Sources:</span><ul>${s.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
}

async function downloadCsv(ctx) {
  if (downloading) return
  downloading = true
  ctx.rerender()
  const net = String(ctx.network?.name ?? ctx.data?.network?.name ?? 'network').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
  const date = new Date().toISOString().slice(0, 10)
  const name = `passbook-revenue-${net}-${date}.csv`
  try {
    await apiDownload('/revenue.csv', name)
    toast(`Saved ${name}`)
  } catch (err) {
    toast(err.unauthorized ? 'Operator session missing or expired: open the operator link again' : err.message, 'alert')
  } finally {
    downloading = false
    ctx.rerender()
  }
}

export default {
  id: 'revenue',
  title: 'Revenue',
  icon: 'revenue',
  subtitle: 'Earnings by stream, in micro-unit precision. Test coins only, never fiat.',
  endpoint: '/revenue',
  interval: 10000,
  render(ctx) {
    const d = ctx.data
    const csvBtn = `<button class="btn btn-sm" type="button" data-action="csv"${downloading || !d ? ' disabled' : ''}>${downloading ? '<span class="spinner" style="width:14px;height:14px"></span>' : icon('download')}<span>Download CSV</span></button>`
    if (!d) return `<div class="streams">${tileSkeleton(4)}</div><section class="card"><div class="card-body">${skeleton(220)}</div></section><div class="grid">${skeletonCards(2, 5)}</div>`
    return `${streams(d)}
      <div class="toolbar">${sources(d)}${csvBtn}</div>
      ${chartCard(d, ctx.now)}
      ${loansTable(d, ctx.now)}
      ${checksTable(d, ctx.now)}`
  },
  afterRender(root) {
    const host = root.querySelector('[data-chart="revenue"]')
    if (!host || !chartModel) return
    drawStackedArea(host, chartModel)
    if (!host._ro && 'ResizeObserver' in window) {
      let w = host.clientWidth
      host._ro = new ResizeObserver(() => {
        if (Math.abs(host.clientWidth - w) < 2 || !host.isConnected) return
        w = host.clientWidth
        if (chartModel) drawStackedArea(host, chartModel)
      })
      host._ro.observe(host)
    }
  },
  actions: {
    csv: (el, ev, ctx) => downloadCsv(ctx),
  },
}
