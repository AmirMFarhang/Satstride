// Live feed: Nostr events, decision-log entries and platform events,
// newest on top, at most CAP kept in memory.

import { esc, has, relTime, absTime, short, KIND_LABELS, fmtInt } from './format.js'
import { icon, chip, empty, skeleton } from './ui.js'
import { apiGet, q } from './api.js'

const CAP = 300
const PAGE = 200
const SOURCES = [
  ['all', 'All'],
  ['nostr', 'Nostr'],
  ['decision-log', 'Decision log'],
  ['platform', 'Platform'],
]
const SOURCE_LABEL = { nostr: 'Nostr', 'decision-log': 'Decision log', platform: 'Platform' }

const feed = { items: [], cursor: null, paused: false, filter: 'all', loaded: false }
const keyOf = (i) => `${i.source}:${i.id}:${i.at}`

async function load(ctx, cache) {
  let loops = 0
  let more = true
  while (more && loops < 10) {
    const r = await apiGet(feed.cursor ? `/feed?after=${q(feed.cursor)}` : '/feed')
    const items = Array.isArray(r.items) ? r.items : []
    if (has(r.cursor)) feed.cursor = r.cursor
    const known = new Set(feed.items.map(keyOf))
    const fresh = items.filter((i) => !known.has(keyOf(i))).map((i) => ({ ...i, _fresh: feed.loaded }))
    if (fresh.length) feed.items = [...fresh.reverse(), ...feed.items].slice(0, CAP)
    more = items.length >= PAGE
    loops++
  }
  feed.loaded = true
  cache.data = { count: feed.items.length }
}

function route(i) {
  if (!has(i.from) && !has(i.to)) return ''
  const k = (v) => (has(v) ? `<span class="mono" data-tip="${esc(v)}" tabindex="0">${esc(short(v, 6, 4))}</span>` : '')
  return `<span class="feed-route">${k(i.from)}${has(i.to) ? `${icon('arrow', 14)}${k(i.to)}` : ''}</span>`
}

function row(i, now) {
  const lbl = i.label ?? KIND_LABELS[i.kind] ?? ''
  return `<li class="feed-item${i._fresh ? ' fresh' : ''}" data-key="${esc(keyOf(i))}"${i._fresh ? '' : ' style="animation:none"'}>
    <div class="feed-src">${chip(SOURCE_LABEL[i.source] ?? i.source ?? '—', 'neutral', { cls: `chip-src-${esc(i.source)}` })}</div>
    <div class="feed-main">
      <div class="feed-line">${has(i.kind) ? `<span class="feed-kind">${esc(i.kind)}</span>` : ''}<span class="feed-label">${esc(lbl)}</span>${route(i)}</div>
      ${has(i.detail) ? `<div class="feed-detail">${esc(i.detail)}</div>` : ''}
      ${has(i.id) ? `<div class="feed-line"><span class="mono muted small" data-tip="${esc(i.id)}" tabindex="0">id ${esc(short(i.id, 10, 6))}</span></div>` : ''}
    </div>
    <div class="feed-time" data-tip="${esc(absTime(i.at))}">${esc(relTime(i.at, now))}</div>
  </li>`
}

export default {
  id: 'feed',
  title: 'Live feed',
  icon: 'feed',
  subtitle: 'Every event this provider sees, as it happens: Nostr traffic, decision-log entries and platform events.',
  interval: 2000,
  load,
  paused: () => feed.paused,
  liveLabel: () => (feed.paused ? '<span class="live"><span class="dot dot-warn"></span>Paused · press Resume to catch up</span>' : null),
  render(ctx) {
    const counts = { all: feed.items.length }
    for (const i of feed.items) counts[i.source] = (counts[i.source] ?? 0) + 1
    const shown = feed.filter === 'all' ? feed.items : feed.items.filter((i) => i.source === feed.filter)
    const toolbar = `<div class="toolbar">
      <div class="seg" role="group" aria-label="Filter by source">${SOURCES.map(([id, name]) => `<button type="button" data-action="filter" data-filter="${id}" aria-pressed="${feed.filter === id}">${name}<span class="count">${fmtInt(counts[id] ?? 0)}</span></button>`).join('')}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="small muted">${fmtInt(feed.items.length)} kept · newest ${CAP}</span>
        <button class="btn btn-sm" type="button" data-action="pause" aria-pressed="${feed.paused}">${feed.paused ? `${icon('play')}Resume` : `${icon('pause')}Pause`}</button>
      </div>
    </div>`
    const note = `<div class="note note-neutral">${icon('info')}<div>Public Nostr events are test data. Encrypted messages show their kind, parties and ids only.</div></div>`
    if (!ctx.data && !feed.loaded) {
      return `${toolbar}${note}<section class="card"><div class="card-body sk-stack">${Array.from({ length: 6 }, () => skeleton(44)).join('')}</div></section>`
    }
    return `${toolbar}${note}
      <section class="card" style="overflow:hidden">
        ${shown.length
          ? `<ol class="feed" aria-live="polite">${shown.map((i) => row(i, ctx.now)).join('')}</ol>`
          : `<div class="card-body">${empty(feed.filter === 'all' ? 'Nothing yet' : `No ${SOURCE_LABEL[feed.filter]} events yet`, 'Events appear here within two seconds of the provider seeing them.', 'feed')}</div>`}
      </section>`
  },
  actions: {
    filter(el, ev, ctx) {
      feed.filter = el.getAttribute('data-filter')
      ctx.rerender()
    },
    pause(el, ev, ctx) {
      feed.paused = !feed.paused
      ctx.rerender()
    },
  },
}
