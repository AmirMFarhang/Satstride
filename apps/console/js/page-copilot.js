// Operator copilot: questions in, answers out. It never moves money, signs
// or sees keys; it can only point at a screen.

import { esc, has, short } from './format.js'
import { icon, chip } from './ui.js'
import { apiGet, apiPost } from './api.js'

// Replaced by the node's own list (GET /console/api/copilot), whose first question names the lender's latest gate decision.
let SUGGESTED = ['What did we earn?', 'Any alerts?', 'Any refusals?', 'Is the decision log intact?']
let suggestionsLoaded = false

const INTENT = {
  revenue: ['revenue', 'Open Revenue'],
  alerts: ['market', 'Open the operator agenda'],
  loans: ['market', 'Open Market and loans'],
  policy: ['security', 'Open Security (policy)'],
  security: ['security', 'Open Security'],
  nostr: ['feed', 'Open Live feed'],
  decision: ['feed', 'Open Live feed (decision log)'],
}
const PAGE_NAMES = { overview: 'Overview', revenue: 'Revenue', market: 'Market and loans', security: 'Security', feed: 'Live feed', copilot: 'Copilot' }
const FALLBACK = {
  NO_MODEL: 'no model loaded',
  MODEL_TIMEOUT: 'the model timed out',
  MODEL_ERROR: 'the model returned an error',
  MODEL_SCHEMA: 'the model answer failed the schema check',
}

const chat = { messages: [], pending: false, scroll: false, focus: false }

/** Accepts D2's CopilotAnswer (text, intent, …) and the earlier draft shape (answer, navigate). */
function normalize(r) {
  const out = {
    text: r.text ?? r.answer ?? r.raw ?? '',
    label: r.label ?? r.by ?? r.source ?? '',
    source: r.source ?? r.by ?? null,
    model: r.model ?? null,
    fallback: r.fallback_reason ?? null,
    refused: r.refused ?? null,
    cites: Array.isArray(r.cites) ? r.cites : [],
    why: Array.isArray(r.why) ? r.why.filter((x) => has(x)) : [],
    links: [],
  }
  if (r.intent && INTENT[r.intent.go]) {
    const [page, lbl] = INTENT[r.intent.go]
    const tip = r.intent.hash ? `decision ${r.intent.hash}` : r.intent.loan_id ? `loan ${r.intent.loan_id}` : ''
    out.links.push({ page, label: lbl, tip })
  }
  for (const n of Array.isArray(r.navigate) ? r.navigate : []) if (PAGE_NAMES[n.page]) out.links.push({ page: n.page, label: n.label ?? `Open ${PAGE_NAMES[n.page]}` })
  return out
}

function botMessage(m, i) {
  if (m.error) {
    return `<div class="msg msg-bot" data-key="m${i}"><div class="bubble" style="border-color:var(--alert-line);color:var(--alert)">${esc(m.error)}</div></div>`
  }
  const a = m.answer
  const isModel = a.source === 'model'
  const go = a.links[0]
  return `<div class="msg msg-bot" data-key="m${i}">
    <div class="bubble">${esc(a.text || '(empty answer)')}</div>
    ${a.refused ? `<div class="refused">${icon('lock')}<div>The copilot does not act; go to ${esc(go ? PAGE_NAMES[go.page] : 'the matching screen')} and do it yourself.</div></div>` : ''}
    ${a.why.length ? `<pre class="why">${esc(a.why.join('\n'))}</pre>` : ''}
    ${a.cites.length ? `<div class="chips">${a.cites.map((c) => chip(`#${c.seq ?? '?'} ${c.kind ?? ''} ${short(c.hash ?? '', 6, 4)}`.trim(), 'neutral', { cls: 'tag', tip: `decision-log entry ${c.seq ?? ''}${c.hash ? `\nhash ${c.hash}` : ''}${c.action_id ? `\naction ${c.action_id}` : ''}` })).join('')}</div>` : ''}
    <div class="msg-meta">
      ${has(a.label) ? chip(a.label, isModel ? 'brand' : 'neutral', { dot: true, tip: isModel && a.model ? `model ${a.model}` : isModel ? 'answered by the model' : 'answered by a fixed template' }) : ''}
      ${a.fallback ? chip(`template stands in: ${FALLBACK[a.fallback] ?? a.fallback}`, 'warn', { tip: a.fallback }) : ''}
    </div>
    ${a.links.length ? `<div class="msg-actions">${a.links.map((l) => `<button class="btn btn-sm" type="button" data-action="nav" data-page="${esc(l.page)}"${l.tip ? ` data-tip="${esc(l.tip)}"` : ''}>${esc(l.label)}${icon('arrow')}</button>`).join('')}</div>` : ''}
  </div>`
}

async function ask(question, ctx) {
  const qn = question.trim()
  if (!qn || chat.pending) return
  chat.messages.push({ role: 'user', text: qn })
  chat.pending = true
  chat.scroll = true
  ctx.rerender()
  try {
    const screen = ctx.prevRoute && ctx.prevRoute !== 'copilot' ? ctx.prevRoute : 'overview'
    const r = await apiPost('/copilot', { question: qn, screen })
    chat.messages.push({ role: 'bot', answer: normalize(r ?? {}) })
  } catch (err) {
    chat.messages.push({ role: 'bot', error: err.unauthorized ? 'Operator session missing or expired: open the operator link again.' : err.message })
  } finally {
    chat.pending = false
    chat.scroll = true
    chat.focus = true
    ctx.rerender()
  }
}

export default {
  id: 'copilot',
  title: 'Operator copilot',
  nav: 'Copilot',
  icon: 'copilot',
  subtitle: 'Ask about this node in plain words. The copilot never moves money, signs, or sees keys.',
  onEnter(ctx) {
    chat.focus = true
    if (suggestionsLoaded) return
    apiGet('/copilot').then((r) => {
      if (Array.isArray(r?.suggestions) && r.suggestions.length) { SUGGESTED = r.suggestions.slice(0, 5).map(String); suggestionsLoaded = true; ctx?.rerender?.() }
    }).catch(() => { /* keep the built-in questions */ })
  },
  render() {
    const suggestions = `<div class="suggest">${SUGGESTED.map((s) => `<button type="button" data-action="suggest" data-q="${esc(s)}"${chat.pending ? ' disabled' : ''}>${esc(s)}</button>`).join('')}</div>`
    const log = chat.messages.length
      ? chat.messages.map((m, i) => (m.role === 'user' ? `<div class="msg msg-user" data-key="m${i}"><div class="bubble">${esc(m.text)}</div></div>` : botMessage(m, i))).join('') +
        (chat.pending ? '<div class="msg msg-bot" data-key="typing"><div class="bubble typing" aria-label="Thinking"><i></i><i></i><i></i></div></div>' : '')
      : `<div class="chat-empty">
          <span class="card-ic">${icon('copilot', 22)}</span>
          <h3>Ask the copilot</h3>
          <p>It reads the same data as these screens and answers from the decision log, the fee ledger and the loan registry. It never moves money, signs, or sees keys.</p>
          ${suggestions}
        </div>`
    return `<section class="card chat">
        <header class="card-head">
          <div class="card-title"><span class="card-ic">${icon('copilot', 18)}</span><div><h3>Copilot</h3><p class="card-sub">Read-only: it can point you to a screen, never act for you</p></div></div>
          <div class="card-aside">${chip('never moves money · never signs · never sees keys', 'ok', { dot: true, cls: 'chip-wrap' })}</div>
        </header>
        <div class="chat-log" id="chat-log" aria-live="polite">${log}</div>
        ${chat.messages.length ? `<div style="padding:0 16px 8px">${suggestions}</div>` : ''}
        <form class="chat-form" data-submit="ask" autocomplete="off">
          <label class="sr-only" for="chat-q">Question</label>
          <input id="chat-q" name="q" class="input" maxlength="500" placeholder="Ask about revenue, loans, the decision log…" autocomplete="off"${chat.pending ? ' disabled' : ''}>
          <button class="btn btn-primary" type="submit"${chat.pending ? ' disabled' : ''}>${icon('send')}Ask</button>
        </form>
      </section>`
  },
  afterRender(root) {
    if (chat.scroll) {
      chat.scroll = false
      const log = root.querySelector('#chat-log')
      if (log) log.scrollTop = log.scrollHeight
    }
    if (chat.focus) {
      chat.focus = false
      root.querySelector('#chat-q')?.focus()
    }
  },
  actions: {
    ask(form, ev, ctx) {
      const input = form.elements.q
      const v = input.value
      input.value = ''
      ask(v, ctx)
    },
    suggest(el, ev, ctx) { ask(el.getAttribute('data-q'), ctx) },
  },
}
