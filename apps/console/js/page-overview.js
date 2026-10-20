// Overview: live counters and who this node is.

import { esc, has, isNum, fmtInt, fmtHeight, fmtDuration, fmtUnits, amountDecimals, absTime, relTime, hasTime, tickerOf, assetNote, label } from './format.js'
import { icon, amt, chip, statusChip, dot, keyCell, mono, text, kv, card, empty, skeletonCards, tileSkeleton } from './ui.js'

function tile({ key, labelText, iconName, value, format = 'int', sub = '', accent = false, asset }) {
  const ok = isNum(value)
  const decimals = format === 'amount' ? amountDecimals(value) : 0
  const initial = !ok ? '—' : format === 'amount' ? fmtUnits(value, decimals) : fmtInt(value)
  const unit = format === 'amount' ? `<span class="unit" data-tip="${esc(assetNote(asset))}">${esc(tickerOf(asset))}</span>` : ''
  return `<div class="tile${accent ? ' tile-accent' : ''}" data-pulse data-key="${key}">
    <div class="tile-label">${icon(iconName, 15)}${labelText}</div>
    <div class="tile-value"><span data-count="${ok ? value : ''}" data-format="${format}" data-decimals="${decimals}">${initial}</span>${unit}</div>
    <div class="tile-sub">${sub}</div>
  </div>`
}

function tiles(d) {
  const c = d.counters ?? {}
  const parts = [c.platform_fees_earned, c.check_fees_earned, c.lender_interest_earned]
  const total = parts.every(isNum) ? parts.reduce((a, b) => a + b, 0) : null
  return `<div class="tiles">
    ${tile({ key: 'loans', labelText: 'Loans', iconName: 'bank', value: c.loans_total, sub: isNum(c.loans_open) ? `${fmtInt(c.loans_open)} open now` : 'registered loans' })}
    ${tile({ key: 'offers', labelText: 'Offers', iconName: 'market', value: c.offers, sub: 'on the relay' })}
    ${tile({ key: 'neg', labelText: 'Negotiations', iconName: 'copilot', value: c.negotiations, sub: 'seen on Nostr' })}
    ${tile({ key: 'checks', labelText: 'Checks paid', iconName: 'check', value: c.checks_paid, sub: 'credit checks settled' })}
    ${tile({ key: 'decisions', labelText: 'Decisions logged', iconName: 'ledger', value: c.decisions_logged, sub: 'hash-chained entries' })}
    ${tile({ key: 'earned', labelText: 'Total earned', iconName: 'revenue', value: total, format: 'amount', accent: true, asset: d.asset, sub: 'fees, checks and interest' })}
  </div>`
}

const runTone = (s) => (s === 'running' ? 'ok' : s === 'unreachable' ? 'alert' : s === 'stopped' ? 'warn' : 'neutral')

function platformCard(d) {
  const p = d.platform ?? {}
  const a = d.asset ?? {}
  return card({
    title: 'Platform',
    iconName: 'node',
    sub: has(d.project) ? `project ${esc(d.project)}` : 'this platform process',
    aside: has(p.api_auth) ? chip(`API auth: ${p.api_auth}`, p.api_auth === 'enforce' ? 'ok' : 'warn', { dot: true, tip: 'src/server/auth.ts mode' }) : '',
    body: kv([
      ['Platform key', keyCell(p.pubkey, { what: 'platform key' })],
      ['Oracle key', keyCell(p.oracle_pk, { what: 'oracle key' })],
      ['Gate key', keyCell(p.gate_pk, { what: 'gate key' })],
      ['Height', `<span class="num">${esc(fmtHeight(p.height))}</span>`],
      ['Chain', text(p.chain)],
      ['Asset', has(a.asset_id) || has(a.ticker) ? `${chip(tickerOf(a), 'warn', { tip: assetNote(a) })}${keyCell(a.asset_id, { head: 10, tail: 6, what: 'asset id' })}` : text(null)],
      has(a.note) ? ['', `<span class="small muted">${esc(a.note)}</span>`] : null,
    ]),
  })
}

function lendersCard(d) {
  const list = d.lenders ?? []
  return card({
    title: 'Lenders',
    iconName: 'bank',
    sub: `${list.length} configured`,
    body: list.length
      ? `<div class="sublist">${list.map((l) => `<div class="subitem" data-key="${esc(l.name ?? l.pubkey)}">
          <div class="subitem-head"><span class="subitem-name">${dot(runTone(l.status))}${text(l.name)}</span>${statusChip(l.status)}</div>
          ${kv([['Nostr key', keyCell(l.pubkey, { what: 'lender key' })]])}
        </div>`).join('')}</div>`
      : empty('No lenders configured', 'Lender peers appear here once the provider stack starts them.', 'bank'),
  })
}

function checkNodesCard(d) {
  const list = d.check_nodes ?? []
  return card({
    title: list.length > 1 ? 'Check nodes' : 'Check node',
    iconName: 'target',
    sub: 'credit checks sold on the relay',
    body: list.length
      ? `<div class="sublist">${list.map((n) => `<div class="subitem" data-key="${esc(n.name ?? n.operator_pk)}">
          <div class="subitem-head"><span class="subitem-name">${dot(runTone(n.status), { pulse: n.status === 'running' })}${text(n.name)}</span>${statusChip(n.status)}</div>
          ${kv([
            ['Operator key', keyCell(n.operator_pk, { what: 'operator key' })],
            ['Scorer', text(n.scorer_label)],
            ['Release hash', keyCell(n.release_hash, { what: 'release hash' })],
            ['Price', amt(n.price?.amount, d.asset)],
            ['Payer modes', (n.payer_modes ?? []).length ? `<span class="chips">${n.payer_modes.map((m) => chip(m)).join('')}</span>` : text(null)],
            ['Execution', text(n.execution)],
          ])}
        </div>`).join('')}</div>`
      : empty('No check node', 'A check node sells credit checks once it is configured.', 'target'),
  })
}

function assistantCard(d) {
  const a = d.assistant ?? {}
  const running = a.status === 'running'
  return card({
    title: 'Assistant',
    iconName: 'sparkle',
    sub: 'agent on call',
    aside: running ? chip('running', 'ok', { dot: true }) : chip(label(a.status || 'not running'), 'neutral', { dot: true }),
    body: kv([
      ['Status', running ? 'running' : `<span>${esc(label(a.status || 'not running'))}</span>`],
      ['Nostr key', keyCell(a.pubkey, { what: 'assistant key' })],
      has(a.label) ? ['Answers with', chip(a.label, /^model/.test(a.label) ? 'brand' : 'neutral', { dot: true, cls: 'chip-wrap' })] : null,
      isNum(a.asks) ? ['Questions', `${esc(fmtInt(a.asks))} asked · ${esc(fmtInt(a.replies ?? 0))} answered`] : null,
      hasTime(a.last_seen) ? ['Last INFO', `<span data-tip="${esc(absTime(a.last_seen))}">${esc(relTime(a.last_seen))}</span>`] : null,
      has(a.note) ? ['Note', `<span class="small">${esc(a.note)}</span>`] : null,
    ]),
  })
}

function relaysCard(d) {
  const list = d.relays ?? []
  const up = list.filter((r) => r.connected).length
  return card({
    title: 'Relays',
    iconName: 'relay',
    sub: `${up} of ${list.length} connected`,
    body: list.length
      ? `<div class="sublist">${list.map((r) => `<div class="subitem" data-key="${esc(r.url)}">
          <div class="subitem-head">
            <span class="subitem-name" style="min-width:0">${dot(r.connected ? 'ok' : 'alert', { pulse: !!r.connected, tip: r.connected ? 'connected' : 'not connected' })}<span class="mono" style="overflow-wrap:anywhere">${esc(r.url)}</span></span>
            ${chip(r.kind === 'public' ? 'public' : 'local', r.kind === 'public' ? 'info' : 'neutral')}
          </div>
          <div class="small muted"><span class="num">${esc(fmtInt(r.events_seen))}</span> events seen${r.kind === 'public' ? ' · public events are test data' : ''}</div>
        </div>`).join('')}</div>`
      : empty('No relays', 'The platform is not subscribed to any Nostr relay.', 'relay'),
  })
}

const qvacTone = (s) => (s === 'ready' ? 'ok' : s === 'loading' ? 'warn' : s === 'down' ? 'alert' : 'neutral')

function qvacRows(q) {
  if (!has(q)) return []
  if (typeof q !== 'object') return [['QVAC', text(q)]]
  const models = q.models ?? []
  return [
    ['QVAC', `${has(q.status) ? chip(q.status, qvacTone(q.status), { dot: true }) : ''}${mono(q.url)}`],
    ['Models', models.length ? `<span class="chips">${models.map((m) => chip(`${m.id}${has(m.state) ? ` · ${m.state}` : ''}`, qvacTone(m.state), { cls: 'chip-mono' })).join('')}</span>` : text(null)],
  ]
}

function scorerCard(d) {
  const c = d.scorer ?? {}
  const tone = c.status === 'answering' ? 'ok' : c.status === 'down' ? 'alert' : 'warn'
  return card({
    title: 'Scorer / QVAC', iconName: 'cpu', sub: 'configured credit-check service',
    aside: chip(c.status ?? 'not observed', tone, { dot: true }),
    body: kv([
      ['Provider', text(c.provider)], ['Scorer', text(c.scorer_label)],
      ...qvacRows(c.qvac),
      ['Trust', text(c.provider === 'in-process' || c.provider === 'container' ? 'Local host trusted · dev-inprocess' : 'External verification required')],
    ]),
  })
}

function uptimeCard(d) {
  return card({
    title: 'Uptime',
    iconName: 'clock',
    sub: d.stack_up_since ? 'the provider stack, since its last up' : 'this platform process',
    body: `<div class="tile-value" style="font-size:24px">${esc(fmtDuration(d.stack_up_since ? Math.max(0, Math.floor((d.generated_at - d.stack_up_since) / 1000)) : d.uptime_s))}</div>
      ${kv([
        ...(d.stack_up_since ? [['Stack up since', esc(absTime(d.stack_up_since))], ['Platform process', esc(fmtDuration(d.uptime_s))]] : []),
        ['Snapshot', `<span data-tip="${esc(absTime(d.generated_at))}">${esc(absTime(d.generated_at))}</span>`],
        ['Network', d.network ? `${esc(d.network.label ?? d.network.name)}${d.network.test_coins_only ? ' · test coins only' : ''}` : text(null)],
        ['Project', text(d.project)],
      ])}`,
  })
}

export default {
  id: 'overview',
  title: 'Overview',
  icon: 'overview',
  subtitle: 'What this service-provider node runs, who it serves and what it has earned.',
  endpoint: '/overview',
  interval: 5000,
  render(ctx) {
    const d = ctx.data
    if (!d) return `<div class="tiles">${tileSkeleton(6)}</div><div class="grid g-auto">${skeletonCards(6)}</div>`
    return `${tiles(d)}
      <div class="section-title"><h2>Identity and services</h2><p>Hover or tap a key for its full value</p></div>
      <div class="grid g-auto">
        ${platformCard(d)}
        ${checkNodesCard(d)}
        ${lendersCard(d)}
        ${scorerCard(d)}
        ${relaysCard(d)}
        ${assistantCard(d)}
        ${uptimeCard(d)}
      </div>`
  },
}
