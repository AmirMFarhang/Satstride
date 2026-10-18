// Small HTML components shared by the pages. Every value passes through esc().

import { DASH, esc, has, isNum, fmtUnits, tickerOf, assetNote, short, relTime, absTime, hasTime, toneOf, label } from './format.js'
import { icon } from './icons.js'

export { icon }

/** An amount from micro-units: "1,234.56 tUSDT" with a test-coin tooltip. */
export function amt(micro, asset, { cls = '' } = {}) {
  if (!isNum(micro)) return `<span class="muted">${DASH}</span>`
  return `<span class="amt ${cls}" data-tip="${esc(assetNote(asset))}">${esc(fmtUnits(micro))}<span class="unit">${esc(tickerOf(asset))}</span></span>`
}

export const chip = (text, tone = 'neutral', { dot = false, tip = '', cls = '' } = {}) =>
  `<span class="chip chip-${tone} ${cls}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${dot ? `<span class="dot dot-${tone}"></span>` : ''}${esc(text)}</span>`

export const statusChip = (status, { tip = '' } = {}) => (has(status) ? chip(label(status), toneOf(status), { dot: true, tip }) : `<span class="muted">${DASH}</span>`)

export const dot = (tone, { pulse = false, tip = '' } = {}) =>
  `<span class="dot dot-${tone}${pulse ? ' pulse' : ''}"${tip ? ` data-tip="${esc(tip)}" tabindex="0"` : ''}></span>`

/** A truncated key/hash/id in mono with a copy button and the full value on hover. */
export function keyCell(value, { head = 8, tail = 6, what = 'value' } = {}) {
  if (!has(value)) return `<span class="muted">${DASH}</span>`
  const v = String(value)
  return `<span class="key"><span class="mono key-text" data-tip="${esc(v)}" tabindex="0">${esc(short(v, head, tail))}</span><button type="button" class="icon-btn copy" data-action="copy" data-copy="${esc(v)}" aria-label="Copy ${esc(what)}" data-tip="Copy">${icon('copy', 14)}</button></span>`
}

export const mono = (v) => (has(v) ? `<span class="mono">${esc(v)}</span>` : `<span class="muted">${DASH}</span>`)
export const text = (v) => (has(v) ? esc(v) : `<span class="muted">${DASH}</span>`)

export const timeCell = (t, now) =>
  hasTime(t) ? `<span class="time" data-tip="${esc(absTime(t))}">${esc(relTime(t, now))}</span>` : `<span class="muted">${DASH}</span>`

export const kv = (rows) =>
  `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`

export function card({ title, iconName, aside = '', body, cls = '', id = '', sub = '' }) {
  return `<section class="card ${cls}"${id ? ` id="${id}"` : ''}>
    <header class="card-head">
      <div class="card-title">${iconName ? `<span class="card-ic">${icon(iconName, 18)}</span>` : ''}<div><h3>${title}</h3>${sub ? `<p class="card-sub">${sub}</p>` : ''}</div></div>
      ${aside ? `<div class="card-aside">${aside}</div>` : ''}
    </header>
    <div class="card-body">${body}</div>
  </section>`
}

export const empty = (title, body = '', iconName = 'info') =>
  `<div class="empty"><span class="empty-ic">${icon(iconName, 20)}</span><div><p class="empty-title">${title}</p>${body ? `<p class="empty-text">${body}</p>` : ''}</div></div>`

/**
 * A table inside its own horizontal scroll container.
 * cols: [{ label, cell(row), cls }]; key(row) keeps row identity across polls.
 */
export function table(cols, rows, { key, emptyHtml = '', cls = '' } = {}) {
  if (!rows?.length) return emptyHtml
  return `<div class="table-wrap"><table class="tbl ${cls}">
    <thead><tr>${cols.map((c) => `<th class="${c.cls ?? ''}" scope="col">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-key="${esc(key ? key(r, i) : i)}">${cols.map((c) => `<td class="${c.cls ?? ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`
}

export const skeleton = (h = 16, w = '100%', cls = '') => `<span class="sk ${cls}" style="height:${h}px;width:${w}"></span>`

export function skeletonCards(n = 4, lines = 4) {
  return Array.from({ length: n }, () => `<section class="card"><header class="card-head">${skeleton(14, '40%')}</header><div class="card-body sk-stack">${Array.from({ length: lines }, (_, i) => skeleton(12, `${90 - i * 12}%`)).join('')}</div></section>`).join('')
}

export const tileSkeleton = (n) =>
  Array.from({ length: n }, () => `<div class="tile">${skeleton(11, '50%')}${skeleton(26, '70%', 'sk-gap')}${skeleton(10, '40%', 'sk-gap')}</div>`).join('')

export const bool = (v, yes = 'yes', no = 'no') =>
  v === true ? chip(yes, 'ok', { dot: true }) : v === false ? chip(no, 'alert', { dot: true }) : `<span class="muted">${DASH}</span>`

export const codeRef = (file, fn) =>
  has(file) ? `<span class="coderef"><span class="coderef-file">${esc(file)}</span>${has(fn) ? `<span class="coderef-fn">${esc(fn)}</span>` : ''}</span>` : `<span class="muted">${DASH}</span>`
