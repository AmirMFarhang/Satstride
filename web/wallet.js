// Passbook wallet panel: the screen over the user's own Passbook node.
//
// Mobile-first, one job per screen (docs/RGB-WALLET-UX.md 6.0). Every screen
// is drawn by render(screen, model), a pure function returning HTML, so tests
// can check every screen without a browser: each one carries the network badge,
// and the dollar asset is always the profile's label ("test USDT (regtest)"),
// never plain "USDT". Words come from web/wallet-strings.js, shared with the
// Android thin client.
//
// Every request to /wallet/api/* is signed with the operator session from the
// node's printed link (web/session-auth.js); the node refuses anything else.

import S from './wallet-strings.js'

export const SCREENS = ['loading', 'disabled', 'nosession', 'welcome', 'create', 'words', 'backup', 'restore', 'unlock', 'home', 'receive', 'send', 'review', 'result', 'history', 'about']

// ---- pure helpers ----

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])

/** A string from the shared file with {placeholders} filled from the network labels and `vars`. */
export function t(key, net, vars = {}) {
  const raw = S[key] ?? key
  const fill = { network: net?.label ?? '?', coin: net?.coin ?? 'test BTC', asset: net?.asset ?? 'test USDT', ...vars }
  return raw.replace(/\{(\w+)\}/g, (m, k) => (k in fill ? String(fill[k]) : m))
}

/** "1.5" -> 1500000 for 6 decimals, without floating point. Null when not a plain positive decimal. */
export function parseDecimal(text, decimals) {
  const m = /^\s*(\d+)(?:[.,](\d+))?\s*$/.exec(String(text ?? ''))
  if (!m || (m[2] ?? '').length > decimals) return null
  const n = Number(m[1] + (m[2] ?? '').padEnd(decimals, '0'))
  return Number.isSafeInteger(n) ? n : null
}

const btcText = (sats) => { let s = (sats / 1e8).toFixed(8).replace(/0+$/, ''); if (s.endsWith('.')) s += '0'; return s }
const shortId = (s, n = 14) => (typeof s === 'string' && s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : String(s ?? ''))

export function badge(net) {
  const name = esc(net?.name ?? 'unknown')
  return `<span class="net-badge net-${name}" data-network-badge="${esc(net?.label ?? '?')}" title="${esc(t('badge.title', net))}"><b>${esc(net?.label ?? '?')}</b> · ${esc(t('badge.test', net))}</span>`
}

function frame(screen, net, body, { nav = true, back = null } = {}) {
  const tabs = nav ? `<nav class="w-nav" aria-label="Wallet">${['home', 'receive', 'send', 'history', 'about'].map((s) => `<button data-go="${s}"${s === screen ? ' aria-current="page"' : ''}>${esc(t(`nav.${s}`, net))}</button>`).join('')}</nav>` : ''
  return `<header class="w-head">
  ${back ? `<button class="w-back" data-go="${esc(back)}" aria-label="${esc(t('nav.back', net))}">‹</button>` : ''}
  <h1>${esc(t('app.title', net))}</h1>
  ${badge(net)}
</header>
<main class="w-screen" data-screen="${esc(screen)}">${body}</main>
${tabs}`
}

const field = (id, label, attrs = '') => `<label class="w-field" for="${id}"><span>${label}</span><input id="${id}" name="${id}" ${attrs}></label>`
const errorBox = (m) => (m.error ? `<p class="w-error" role="alert">${esc(m.error)}</p>` : '')
const row = (k, v, cls = '') => `<div class="w-row ${cls}"><dt>${k}</dt><dd>${v}</dd></div>`

/** One screen as HTML. `m` is the view model: { net, status, balances, ... }. */
export function render(screen, m = {}) {
  const net = m.net
  const e = errorBox(m)
  switch (screen) {
    case 'loading':
      return frame(screen, net, `<p class="w-muted">${esc(t('loading', net))}</p>`, { nav: false })
    case 'disabled':
      return frame(screen, net, `<h2>${esc(t('disabled.title', net))}</h2><p>${esc(t('disabled.body', net))}</p><button data-go="about">${esc(t('nav.about', net))}</button>`, { nav: false })
    case 'nosession':
      return frame(screen, net, `<h2>${esc(t('session.title', net))}</h2><p>${esc(t('session.body', net))}</p><button data-go="about">${esc(t('nav.about', net))}</button>`, { nav: false })
    case 'welcome':
      return frame(screen, net, `<h2>${esc(t('welcome.title', net))}</h2><p>${esc(t('welcome.body', net))}</p>${e}
<button class="w-primary" data-go="create">${esc(t('welcome.create', net))}</button>
<button data-go="restore">${esc(t('welcome.restore', net))}</button>
<button class="w-link" data-go="about">${esc(t('nav.about', net))}</button>`, { nav: false })
    case 'create':
      return frame(screen, net, `<h2>${esc(t('create.title', net))}</h2><p class="w-muted">${esc(t('create.body', net))}</p>
<form data-form="create">${field('pass1', esc(t('create.passphrase', net)), 'type="password" autocomplete="new-password" minlength="8" required')}${field('pass2', esc(t('create.repeat', net)), 'type="password" autocomplete="new-password" minlength="8" required')}${e}
<button class="w-primary" type="submit">${esc(t('create.go', net))}</button></form>`, { nav: false, back: 'welcome' })
    case 'words':
      return frame(screen, net, `<h2>${esc(t('words.title', net))}</h2><p class="w-warn">${esc(t('words.body', net))}</p>
<ol class="w-words">${(m.words ?? []).map((w) => `<li>${esc(w)}</li>`).join('')}</ol>
<button class="w-primary" data-action="words-done">${esc(t('words.done', net))}</button>`, { nav: false })
    case 'backup': {
      const pos = m.positions ?? []
      return frame(screen, net, `<h2>${esc(t('backup.title', net))}</h2><p>${esc(t('backup.body', net, { positions: pos.join(', ') }))}</p>
<form data-form="backup">${pos.map((n) => field(`w${n}`, esc(t('backup.word', net, { n })), 'autocomplete="off" autocapitalize="none" spellcheck="false" required')).join('')}${field('pass', esc(t('backup.passphrase', net)), 'type="password" autocomplete="current-password" required')}${e}
<button class="w-primary" type="submit">${esc(t('backup.go', net))}</button></form>`, { nav: false, back: 'home' })
    }
    case 'restore':
      return frame(screen, net, `<h2>${esc(t('restore.title', net))}</h2>
<form data-form="restore"><label class="w-field" for="words"><span>${esc(t('restore.words', net))}</span><textarea id="words" name="words" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" required></textarea></label>
${field('pass', esc(t('restore.passphrase', net)), 'type="password" autocomplete="new-password" minlength="8" required')}${e}
<button class="w-primary" type="submit">${esc(t('restore.go', net))}</button></form>`, { nav: false, back: 'welcome' })
    case 'unlock':
      return frame(screen, net, `<h2>${esc(t('unlock.title', net))}</h2>
<form data-form="unlock">${field('pass', esc(t('unlock.passphrase', net)), 'type="password" autocomplete="current-password" required')}${e}
<button class="w-primary" type="submit">${esc(t('unlock.go', net))}</button></form>`, { nav: false })
    case 'home': {
      const b = m.balances
      const backed = m.status?.backup?.verified
      return frame(screen, net, `${backed ? '' : `<div class="w-banner" role="status">${esc(t('backup.banner', net))} <button data-action="backup-start">${esc(t('backup.banner.go', net))}</button></div>`}${e}
<section class="w-balance" aria-label="${esc(t('home.coin', net))}"><h2>${esc(t('home.coin', net))}</h2><p class="w-amount" data-amount="btc">${esc(b?.btc?.label ?? '…')}</p></section>
<section class="w-balance" aria-label="${esc(t('home.asset', net))}"><h2>${esc(t('home.asset', net))}</h2>${b && !b.asset_id ? `<p class="w-muted">${esc(t('home.noasset', net))}</p>` : `<p class="w-amount" data-amount="asset">${esc(b?.usdt?.label ?? '…')}</p>${b?.usdt?.pending_label ? `<p class="w-muted">${esc(b.usdt.pending_label)}</p>` : ''}`}</section>
<details class="w-more"><summary>${esc(t('home.rgbcoin', net))}</summary><p>${esc(b?.rgb_btc?.label ?? '…')}</p>${b?.asset_id ? `<p class="w-muted">${esc(t('home.assetid', net))} <code>${esc(shortId(b.asset_id))}</code></p>` : ''}</details>
<div class="w-actions"><button class="w-primary" data-go="receive">${esc(t('nav.receive', net))}</button><button class="w-primary" data-go="send">${esc(t('nav.send', net))}</button></div>
<button class="w-link" data-action="lock">${esc(t('nav.lock', net))}</button>`)
    }
    case 'receive': {
      const r = m.receive ?? {}
      return frame(screen, net, `<h2>${esc(t('receive.btc', net))}</h2>
<p class="w-addr"><code data-copy>${esc(r.address ?? '…')}</code></p>
<button data-action="copy" data-value="${esc(r.address ?? '')}">${esc(t('receive.copy', net))}</button>${r.explorer ? ` <a href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(t('receive.explorer', net))}</a>` : ''}
<h2>${esc(t('receive.rgb', net))}</h2><p class="w-muted">${esc(t('receive.rgb.body', net))}</p>
<form data-form="invoice">${field('amount', esc(t('receive.rgb.amount', net)), 'inputmode="decimal" autocomplete="off"')}${e}
<button type="submit">${esc(t('receive.rgb.go', net))}</button></form>
${r.invoice ? `<p class="w-addr"><code>${esc(r.invoice)}</code></p><button data-action="copy" data-value="${esc(r.invoice)}">${esc(t('receive.copy', net))}</button>` : ''}
${r.needsPrepare ? `<p class="w-muted">${esc(t('receive.rgb.prepare.body', net))}</p><p class="w-addr"><code>${esc(r.rgbAddress ?? '')}</code></p><button data-action="prepare">${esc(t('receive.rgb.prepare', net))}</button>` : ''}`, { back: 'home' })
    }
    case 'send': {
      const kind = m.sendKind ?? 'btc'
      return frame(screen, net, `<h2>${esc(t('send.title', net))}</h2>
<form data-form="send"><fieldset class="w-kind"><legend>${esc(t('send.what', net))}</legend>
<label><input type="radio" name="kind" value="btc"${kind === 'btc' ? ' checked' : ''}> ${esc(t('send.kind.btc', net))}</label>
<label><input type="radio" name="kind" value="rgb"${kind === 'rgb' ? ' checked' : ''}> ${esc(t('send.kind.rgb', net))}</label></fieldset>
${kind === 'btc' ? field('to', esc(t('send.to.btc', net)), 'autocomplete="off" autocapitalize="none" spellcheck="false" required') : `<label class="w-field" for="to"><span>${esc(t('send.to.rgb', net))}</span><textarea id="to" name="to" rows="3" autocomplete="off" spellcheck="false" required></textarea></label>`}
${field('amount', esc(t(kind === 'btc' ? 'send.amount.btc' : 'send.amount.rgb', net)), 'inputmode="decimal" autocomplete="off" required')}${e}
<button class="w-primary" type="submit">${esc(t('send.review', net))}</button></form>`, { back: 'home' })
    }
    case 'review': {
      const p = m.preview
      const d = p?.decoded ?? {}
      return frame(screen, net, `<h2>${esc(t('review.title', net))}</h2>
<dl class="w-review">${row(esc(t('review.network', net)), badge(net))}${row(esc(t('review.to', net)), `<code>${esc(d.to)}</code>`)}${row(esc(t('review.type', net)), esc(d.to_type))}${row(esc(t('review.amount', net)), `<b>${esc(d.amount_label)}</b>`)}${row(esc(t('review.fee', net)), esc(d.fee_label))}${row(esc(t('review.total', net)), `<b>${esc(d.total_label)}</b>`)}${d.asset_id ? row(esc(t('review.asset', net)), `<code>${esc(shortId(d.asset_id))}</code>`) : ''}${d.transport_endpoints?.length ? row(esc(t('review.proxy', net)), esc(d.transport_endpoints.join(', '))) : ''}${row(esc(t('review.gate', net)), p?.gate ? `${esc(p.gate.name)}${p.gate.adapter ? ` <span class="w-tag">${esc(t('review.gate.adapter', net))}</span>` : ''}` : '<b>none: sends are refused</b>')}</dl>
<div class="w-irrev" role="alert"><b>${esc(t('review.irreversible', net))}</b> ${esc(t('review.irreversible.body', net))}</div>${e}
<p class="w-muted">${esc(t('review.expires', net))}</p>
<div class="w-actions"><button data-go="send">${esc(t('review.cancel', net))}</button><button class="w-primary w-danger" data-action="confirm">${esc(t('review.confirm', net))}</button></div>`, { nav: false })
    }
    case 'result': {
      const r = m.result ?? {}
      return frame(screen, net, r.ok
        ? `<h2>${esc(t('result.sent', net))}</h2><p>${esc(t('result.sent.body', net))}</p><dl class="w-review">${row(esc(t('result.txid', net)), `<code>${esc(r.txid)}</code>`)}</dl>${r.explorer ? `<a href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(t('receive.explorer', net))}</a>` : ''}<button class="w-primary" data-go="home">${esc(t('result.home', net))}</button>`
        : `<h2>${esc(t('result.failed', net))}</h2><p class="w-error" role="alert">${esc(r.error)}</p><button class="w-primary" data-go="home">${esc(t('result.home', net))}</button>`, { nav: false })
    }
    case 'history': {
      const h = m.history
      const rows = h?.rows ?? []
      const attempts = h?.attempts ?? []
      return frame(screen, net, `<h2>${esc(t('history.title', net))}</h2>${e}
${rows.length ? `<ul class="w-list">${rows.map((r) => `<li><span class="w-amt ${r.direction}">${esc(r.label)}</span><span class="w-muted">${esc(r.status)}${r.txid ? ` · ${r.explorer ? `<a href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(shortId(r.txid, 8))}</a>` : `<code>${esc(shortId(r.txid, 8))}</code>`}` : ''}</span></li>`).join('')}</ul>` : `<p class="w-muted">${esc(t('history.empty', net))}</p>`}
${attempts.length ? `<h3>${esc(t('history.attempts', net))}</h3><ul class="w-list">${attempts.map((a) => `<li><span>${esc(a.unit === 'micro' ? `${(a.amount / 1e6).toFixed(2)} ${net?.asset ?? ''}` : `${btcText(a.amount)} ${net?.coin ?? ''}`)}</span><span class="w-status ${esc(a.status)}">${esc(t(`history.status.${a.status}`, net))}${a.reason ? `: ${esc(a.reason)}` : ''}</span></li>`).join('')}</ul>` : ''}`, { back: 'home' })
    }
    case 'about': {
      const a = m.about ?? {}
      return frame(screen, net, `<h2>${esc(t('about.title', net))}</h2><p>${esc(t('about.body', net))}</p>
<dl class="w-review">${row(esc(t('about.network', net)), badge(net))}</dl><p class="w-warn">${esc(t('about.test', net))}</p>
${a.endpoints ? `<h3>${esc(t('about.endpoints', net))}</h3><dl class="w-review">${Object.entries(a.endpoints).filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k, v]) => row(esc(k), `<code>${esc(Array.isArray(v) ? v.join(', ') : v)}</code>`)).join('')}</dl>` : ''}
${a.modules ? `<h3>${esc(t('about.modules', net))}</h3><dl class="w-review">${Object.entries(a.modules).map(([k, v]) => row(`<code>${esc(k)}</code>`, esc(v))).join('')}</dl>` : ''}
${a.gate ? `<h3>${esc(t('about.gate', net))}</h3><p>${esc(a.gate.name)}</p>` : ''}
<p class="w-muted">${esc(t('about.built', net))}</p>`, { nav: !!m.status?.unlocked, back: m.status?.unlocked ? 'home' : 'welcome' })
    }
    default:
      return frame('loading', net, `<p>${esc(screen)}</p>`, { nav: false })
  }
}

// ---- browser controller (runs only when mounted) ----

/** The network badge for any page of this node (the dashboard header uses it). */
export async function mountBadge(el, fetchImpl = globalThis.fetch) {
  if (!el) return
  try {
    const r = await fetchImpl('/wallet/api/network')
    const { network } = await r.json()
    el.innerHTML = badge(network)
  } catch { /* the dashboard still works without the badge */ }
}

export async function mountWallet(root) {
  const { readSession, signedHeaders } = await import('/session-auth.js')
  const session = readSession()
  const m = { net: null, status: null, balances: null, error: null }
  let screen = 'loading'

  const call = async (method, path, body) => {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const headers = { ...(raw ? { 'content-type': 'application/json' } : {}), ...(await signedHeaders(session, method, path, raw)) }
    const res = await fetch(path, { method, headers, ...(raw ? { body: raw } : {}) })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(out.error ?? `HTTP ${res.status}`), { status: res.status, detail: out.detail })
    return out
  }
  const draw = () => { root.innerHTML = render(screen, m); const f = root.querySelector('input,textarea'); if (f && screen !== 'home') f.focus() }
  const go = async (next) => {
    m.error = null
    screen = next
    try {
      if (next === 'home') { m.status = await call('GET', '/wallet/api/status'); if (!m.status.unlocked) return go(m.status.has_wallet ? 'unlock' : 'welcome'); m.balances = await call('GET', '/wallet/api/balances') }
      if (next === 'receive') m.receive = await call('GET', '/wallet/api/receive/btc')
      if (next === 'history') m.history = await call('GET', '/wallet/api/history')
      if (next === 'about') m.about = await call('GET', '/wallet/api/about')
    } catch (err) {
      if (err.status === 423) return go(m.status?.has_wallet === false ? 'welcome' : 'unlock')
      m.error = err.message
    }
    draw()
  }

  root.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button,[data-go]')
    if (!b) return
    if (b.dataset.go) { ev.preventDefault(); return go(b.dataset.go) }
    const action = b.dataset.action
    if (!action) return
    m.error = null
    try {
      if (action === 'words-done') { m.words = null; const c = await call('POST', '/wallet/api/backup/challenge'); m.positions = c.positions; screen = 'backup' }
      else if (action === 'backup-start') { const c = await call('POST', '/wallet/api/backup/challenge'); m.positions = c.positions; screen = 'backup' }
      else if (action === 'lock') { await call('POST', '/wallet/api/lock'); screen = 'unlock' }
      else if (action === 'copy') { await navigator.clipboard?.writeText(b.dataset.value ?? ''); b.textContent = t('receive.copied', m.net); return }
      else if (action === 'prepare') { await call('POST', '/wallet/api/prepare-rgb', { confirm: true }); m.receive = { ...m.receive, needsPrepare: false } }
      else if (action === 'confirm') {
        b.disabled = true
        try { const r = await call('POST', '/wallet/api/send/confirm', { preview_id: m.preview.id, confirm: true }); m.result = { ok: true, txid: r.txid, explorer: r.explorer } }
        catch (err) { m.result = { ok: false, error: err.message } }
        m.preview = null
        screen = 'result'
      }
    } catch (err) { m.error = err.message }
    draw()
  })

  root.addEventListener('change', (ev) => {
    if (ev.target.name === 'kind') { m.sendKind = ev.target.value; draw() }
  })

  root.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const f = ev.target
    const v = (name) => f.elements[name]?.value ?? ''
    const btn = f.querySelector('button[type=submit]')
    if (btn) btn.disabled = true
    m.error = null
    try {
      switch (f.dataset.form) {
        case 'create': {
          if (v('pass1') !== v('pass2')) throw new Error(t('create.mismatch', m.net))
          const r = await call('POST', '/wallet/api/create', { passphrase: v('pass1') })
          m.words = r.words
          screen = 'words'
          break
        }
        case 'restore':
          m.status = await call('POST', '/wallet/api/restore', { words: v('words'), passphrase: v('pass') })
          return go('home')
        case 'unlock':
          m.status = await call('POST', '/wallet/api/unlock', { passphrase: v('pass') })
          return go('home')
        case 'backup': {
          const answers = Object.fromEntries((m.positions ?? []).map((n) => [String(n), v(`w${n}`)]))
          const r = await call('POST', '/wallet/api/backup/verify', { passphrase: v('pass'), answers })
          if (!r.verified) { const c = await call('POST', '/wallet/api/backup/challenge'); m.positions = c.positions; throw new Error(t('backup.bad', m.net)) }
          return go('home')
        }
        case 'invoice': {
          const amount = v('amount').trim() ? parseDecimal(v('amount'), 6) : undefined
          if (amount === null) throw new Error('amount: use digits and at most 6 decimals')
          try { const r = await call('POST', '/wallet/api/receive/rgb', amount === undefined ? {} : { amount_micro: amount }); m.receive = { ...m.receive, invoice: r.invoice, needsPrepare: false } }
          catch (err) { if (err.status === 409) m.receive = { ...m.receive, needsPrepare: true, rgbAddress: err.detail?.rgb_btc_address }; throw err }
          break
        }
        case 'send': {
          const kind = f.elements.kind.value
          const amount = parseDecimal(v('amount'), kind === 'btc' ? 8 : 6)
          if (!amount) throw new Error(`amount: use digits and at most ${kind === 'btc' ? 8 : 6} decimals`)
          m.sendKind = kind
          m.preview = await call('POST', '/wallet/api/send/preview', { kind, to: v('to').trim(), amount })
          screen = 'review'
          break
        }
      }
    } catch (err) { m.error = err.message }
    draw()
  })

  try {
    m.net = (await (await fetch('/wallet/api/network')).json()).network
  } catch { m.net = { name: 'unknown', label: 'unknown network', coin: 'test BTC', asset: 'test USDT' } }
  if (!session) { screen = 'nosession'; draw(); return }
  try {
    m.status = await call('GET', '/wallet/api/status')
    if (m.status.disabled) { screen = 'disabled'; draw(); return }
  } catch (err) { m.error = err.message; screen = 'nosession'; draw(); return }
  go(m.status.unlocked ? 'home' : m.status.has_wallet ? 'unlock' : 'welcome')
}
