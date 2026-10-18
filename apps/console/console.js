// Satstride operator console: shell, hash router and polling.
// Pages live in ./js/page-*.js and render HTML strings; the shell morphs
// them into the DOM so each poll patches only what changed.

import { readSession, parseSession, storeSession, forgetSession } from './session-auth.js'
import { setSession, getSession, apiGet, ApiError } from './js/api.js'
import { morph, animateCounters, initTooltips, hideTooltip, toast, copyText } from './js/dom.js'
import { icon } from './js/icons.js'
import { esc, fmtInt, fmtUnits, relTime, short } from './js/format.js'
import overview from './js/page-overview.js'
import revenue from './js/page-revenue.js'
import market from './js/page-market.js'
import security from './js/page-security.js'
import feed from './js/page-feed.js'
import copilot from './js/page-copilot.js'
import live from './js/page-live.js'

const PAGES = [live, overview, revenue, market, security, feed, copilot]
const BY_ID = Object.fromEntries(PAGES.map((p) => [p.id, p]))
const THEME_KEY = 'passbook-console-theme'

const state = {
  route: 'live',
  prevRoute: null,
  network: null,
  asset: null,
  cache: Object.fromEntries(PAGES.map((p) => [p.id, { data: null, error: null, updatedAt: 0, loading: false }])),
  navOpen: false,
}

let els = null
let pollGen = 0
let pollTimer = 0

// ---------- boot ----------

function boot() {
  initTooltips()
  wireEvents()
  const session = readSession()
  if (!session) {
    // a #session=… pasted into the address bar only changes the hash
    gateRetry = () => {
      const s = readSession()
      if (!s) return
      setSession(s)
      startShell()
    }
    window.addEventListener('hashchange', gateRetry)
    return renderGate()
  }
  setSession(session)
  startShell()
}

let gateRetry = null

function startShell() {
  if (gateRetry) window.removeEventListener('hashchange', gateRetry)
  gateRetry = null
  renderShell()
  window.addEventListener('hashchange', onRoute)
  document.addEventListener('visibilitychange', onVisibility)
  setInterval(renderHead, 1000)
  onRoute()
  // Feed and copilot carry no network block: learn it from the overview once.
  if (!state.network && !BY_ID[state.route].endpoint) apiGet('/overview').then((d) => { absorb(d); renderHead() }).catch(() => {})
}

// ---------- the "operator link required" screen ----------

function renderGate(error = '') {
  const here = `${location.origin}${location.pathname}`
  const root = document.getElementById('root')
  root.className = ''
  root.removeAttribute('aria-busy')
  root.innerHTML = `
    <main class="gate">
      <div class="gate-card">
        <div class="brand"><img src="./brand.svg" alt="" width="30" height="30"><div><div class="brand-name">Satstride</div><div class="brand-sub">Provider console</div></div></div>
        <div>
          <h1>Operator link required</h1>
          <p style="margin-top:6px">This console is for the operator of this Satstride node. Every request is signed with the private operator session, so the console needs the operator link before it can show anything.</p>
        </div>
        <ol>
          <li>Find the line the platform prints when it starts:<code class="codeblock" style="margin-top:6px">dashboard (operator link, keep it private): http://…/#session=…</code></li>
          <li>Copy the <span class="mono">#session=…</span> part and open this console with it appended:<code class="codeblock" style="margin-top:6px">${esc(here)}#session=&lt;id&gt;.&lt;secret&gt;</code></li>
        </ol>
        <p class="small muted">The fragment never leaves your browser. The console keeps it for this tab only and removes it from the address bar.</p>
        <form class="gate-form" data-submit="gate" autocomplete="off">
          <label class="sr-only" for="gate-link">Operator link</label>
          <input id="gate-link" class="input" name="link" placeholder="…or paste the operator link here" spellcheck="false" autocomplete="off">
          <button class="btn btn-primary" type="submit">Continue</button>
        </form>
        ${error ? `<p class="gate-err" role="alert">${esc(error)}</p>` : ''}
      </div>
    </main>`
}

// ---------- shell ----------

function navHtml() {
  return PAGES.map((p) => `<a href="#/${p.id}" data-nav="${p.id}"${p.id === state.route ? ' aria-current="page"' : ''}>${icon(p.icon)}<span>${esc(p.nav ?? p.title)}</span></a>`).join('')
}

function renderShell() {
  const root = document.getElementById('root')
  root.className = ''
  root.removeAttribute('aria-busy')
  root.innerHTML = `
    <div class="app" id="app">
      <header class="topbar">
        <a class="brand" href="#/live"><img src="./brand.svg" alt="" width="28" height="28"><div><div class="brand-name">Satstride</div><div class="brand-sub">Provider console</div></div></a>
        <div class="topbar-right">
          <button class="icon-btn" type="button" data-action="menu" aria-label="Menu" aria-expanded="false" aria-controls="sidebar" id="menu-btn">${icon('menu')}</button>
        </div>
      </header>
      <aside class="sidebar" id="sidebar">
        <a class="brand" href="#/live"><img src="./brand.svg" alt="" width="30" height="30"><div><div class="brand-name">Satstride</div><div class="brand-sub">Provider console</div></div></a>
        <nav class="nav" id="nav" aria-label="Console">${navHtml()}</nav>
        <div class="sidebar-foot">
          <div class="session-line" data-tip="Requests are signed with this operator session (HMAC-SHA256)">${icon('lock', 14)}<span>Session</span><span class="mono">${esc(short(getSession()?.id ?? '', 6, 4))}</span></div>
          <div class="foot-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-action="theme" id="theme-btn"></button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="forget" data-tip="Forget the operator session in this tab">${icon('logout')}<span>Sign out</span></button>
          </div>
        </div>
      </aside>
      <div id="scrim"></div>
      <div class="main">
        <div class="page-head" id="head"></div>
        <div class="banner-slot" id="banner"></div>
        <main class="page" id="page" tabindex="-1"></main>
      </div>
    </div>`
  els = {
    app: document.getElementById('app'),
    nav: document.getElementById('nav'),
    head: document.getElementById('head'),
    banner: document.getElementById('banner'),
    page: document.getElementById('page'),
    themeBtn: document.getElementById('theme-btn'),
    menuBtn: document.getElementById('menu-btn'),
    scrim: document.getElementById('scrim'),
  }
  renderTheme()
}

function netBadge() {
  const n = state.network
  if (!n) return '<span class="netbadge" aria-label="network loading">NETWORK …</span>'
  const name = String(n.label || n.name || 'unknown').toUpperCase()
  const tip = n.test_coins_only ? 'Test network: every amount is a test coin with no value' : n.public ? 'Public network' : 'Private network'
  return `<span class="netbadge" data-tip="${esc(tip)}">${icon('alert', 14)}${esc(name)}${n.test_coins_only ? ' · test coins' : ''}</span>`
}

function liveHtml(page, c) {
  if (!page.interval && !page.liveLabel) return ''
  if (document.hidden) return `<span class="live"><span class="dot"></span>Paused while the tab is hidden</span>`
  const custom = page.liveLabel?.(pageCtx())
  if (custom) return custom
  if (c.error && !c.data) return `<span class="live"><span class="dot dot-alert"></span>Not connected</span>`
  if (c.error) return `<span class="live"><span class="dot dot-warn"></span>Update failed · data from ${esc(relTime(c.updatedAt))}</span>`
  if (!c.updatedAt) return `<span class="live"><span class="dot"></span>Connecting…</span>`
  return `<span class="live" data-tip="Refreshes every ${page.interval / 1000} s"><span class="dot dot-ok pulse"></span>Live · updated ${esc(relTime(c.updatedAt))}</span>`
}

function renderHead() {
  if (!els) return
  const page = BY_ID[state.route]
  const c = state.cache[page.id]
  morph(els.head, `
    <div class="page-title"><h1>${esc(page.title)}</h1><p>${page.subtitle}</p></div>
    <div class="head-meta">${liveHtml(page, c)}${netBadge()}</div>`)
}

function renderBanner() {
  const c = state.cache[state.route]
  const err = c.error
  if (!err) return morph(els.banner, '')
  const unauthorized = err instanceof ApiError && err.unauthorized
  morph(els.banner, unauthorized
    ? `<div class="banner" role="alert">${icon('lock')}<div class="banner-body"><strong>Operator session missing or expired:</strong> open the operator link again.</div><button class="btn btn-sm btn-danger-outline" type="button" data-action="relink">Use a new link</button></div>`
    : `<div class="banner" role="alert">${icon('alert')}<div class="banner-body"><strong>Could not load this page.</strong> ${esc(err.message)}</div><button class="btn btn-sm btn-danger-outline" type="button" data-action="retry">Retry</button></div>`)
}

function pageCtx() {
  const c = state.cache[state.route]
  return {
    data: c.data,
    error: c.error,
    updatedAt: c.updatedAt,
    network: state.network,
    asset: state.asset,
    now: Date.now(),
    prevRoute: state.prevRoute,
    rerender,
    refresh: startPolling,
    navigate,
    setError: (e) => { c.error = e; rerender() },
  }
}

function counterFmt(el, v) {
  if (el.getAttribute('data-format') === 'amount') return fmtUnits(Math.round(v), Number(el.getAttribute('data-decimals') ?? 2))
  return fmtInt(v)
}

function rerender() {
  if (!els) return
  const page = BY_ID[state.route]
  const ctx = pageCtx()
  els.page.classList.toggle('errored', !!(ctx.error && !ctx.data))
  morph(els.page, page.render(ctx))
  animateCounters(els.page, counterFmt)
  page.afterRender?.(els.page, ctx)
  renderBanner()
  renderHead()
}

// ---------- routing ----------

function navigate(id) {
  if (!BY_ID[id]) return
  if (location.hash !== `#/${id}`) location.hash = `#/${id}`
  else onRoute()
}

function onRoute() {
  // a fresh operator link pasted while the console is open replaces the session
  if (/session=/.test(location.hash)) {
    const s = readSession()
    if (s) {
      setSession(s)
      for (const c of Object.values(state.cache)) c.error = null
    }
  }
  const m = /^#\/([a-z-]+)/.exec(location.hash)
  const id = m && BY_ID[m[1]] ? m[1] : 'live'
  if (!m || !BY_ID[m[1]]) history.replaceState(null, '', `${location.pathname}${location.search}#/${id}`)
  const changed = id !== state.route
  if (changed) {
    BY_ID[state.route]?.onLeave?.()
    state.prevRoute = state.route
    state.route = id
  }
  setNav(false)
  hideTooltip()
  for (const a of els.nav.querySelectorAll('a')) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  const page = BY_ID[id]
  document.title = `${page.title} · Satstride console`
  if (changed) {
    els.page.innerHTML = ''
    window.scrollTo({ top: 0 })
  }
  rerender()
  page.onEnter?.(pageCtx())
  startPolling()
}

// ---------- polling ----------

function absorb(data) {
  if (data && typeof data === 'object') {
    if (data.network && typeof data.network === 'object') state.network = data.network
    if (data.asset && typeof data.asset === 'object') state.asset = data.asset
  }
}

async function loadPage(page) {
  const c = state.cache[page.id]
  c.loading = true
  try {
    if (page.load) await page.load(pageCtx(), c)
    else {
      c.data = await apiGet(page.endpoint)
      absorb(c.data)
    }
    c.error = null
    c.updatedAt = Date.now()
  } catch (err) {
    c.error = err instanceof ApiError ? err : new ApiError(0, String(err?.message ?? err), page.endpoint)
  } finally {
    c.loading = false
  }
}

function startPolling() {
  const gen = ++pollGen
  clearTimeout(pollTimer)
  const page = BY_ID[state.route]
  if (!page.endpoint && !page.load) return
  const tick = async () => {
    if (gen !== pollGen) return
    if (document.hidden) return renderHead()
    if (page.paused?.()) { renderHead(); pollTimer = setTimeout(tick, 500); return }
    await loadPage(page)
    if (gen !== pollGen) return
    rerender()
    if (page.interval) pollTimer = setTimeout(tick, page.nextDelay?.() ?? page.interval)
  }
  tick()
}

function onVisibility() {
  if (document.hidden) {
    pollGen++
    clearTimeout(pollTimer)
    renderHead()
  } else {
    startPolling()
  }
}

// ---------- theme, nav ----------

function effectiveTheme() {
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'dark' || t === 'light') return t
  return 'light'
}

function renderTheme() {
  if (!els) return
  const dark = effectiveTheme() === 'dark'
  els.themeBtn.innerHTML = `${icon(dark ? 'sun' : 'moon')}<span>${dark ? 'Light' : 'Dark'}</span>`
  els.themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme')
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  try { localStorage.setItem(THEME_KEY, next) } catch { /* storage blocked */ }
  renderTheme()
  rerender() // charts read colours from CSS at draw time
}

function setNav(open) {
  state.navOpen = open
  if (!els) return
  els.app.classList.toggle('nav-open', open)
  els.menuBtn.setAttribute('aria-expanded', String(open))
  els.scrim.className = open ? 'nav-scrim' : ''
  els.scrim.onclick = open ? () => setNav(false) : null
}

// ---------- events ----------

const GLOBAL_ACTIONS = {
  async copy(el) {
    const ok = await copyText(el.getAttribute('data-copy') ?? '')
    toast(ok ? 'Copied to clipboard' : 'Copy failed: select the text instead', ok ? 'neutral' : 'alert')
  },
  nav(el) { navigate(el.getAttribute('data-page')) },
  theme: toggleTheme,
  menu() { setNav(!state.navOpen) },
  retry() { startPolling() },
  relink() { forgetSession(); setSession(null); location.hash = ''; location.reload() },
  forget() { forgetSession(); setSession(null); history.replaceState(null, '', location.pathname + location.search); location.reload() },
}

function wireEvents() {
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest?.('[data-action]')
    if (!el || el.disabled) return
    const name = el.getAttribute('data-action')
    const page = BY_ID[state.route]
    const fn = page?.actions?.[name] ?? GLOBAL_ACTIONS[name]
    if (!fn) return
    if (el.tagName === 'A' || el.tagName === 'BUTTON') ev.preventDefault()
    fn(el, ev, pageCtx())
  })
  const forward = (attr) => (ev) => {
    const el = ev.target.closest?.(`[${attr}]`)
    if (!el) return
    const fn = BY_ID[state.route]?.actions?.[el.getAttribute(attr)]
    if (fn) fn(el, ev, pageCtx())
  }
  document.addEventListener('input', forward('data-input'))
  document.addEventListener('change', forward('data-change'))
  document.addEventListener('submit', (ev) => {
    const form = ev.target.closest?.('form[data-submit]')
    if (!form) return
    ev.preventDefault()
    const name = form.getAttribute('data-submit')
    if (name === 'gate') return submitGate(form)
    const fn = BY_ID[state.route]?.actions?.[name]
    if (fn) fn(form, ev, pageCtx())
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    if (state.navOpen) setNav(false)
    BY_ID[state.route]?.actions?.escape?.(null, ev, pageCtx())
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { renderTheme(); rerender() })
}

function submitGate(form) {
  const s = parseSession(form.elements.link.value)
  if (!s) return renderGate('That does not contain an operator session. Paste the whole link, or the part from #session= on.')
  storeSession(s)
  setSession(s)
  history.replaceState(null, '', `${location.pathname}${location.search}#/overview`)
  startShell()
}

boot()
