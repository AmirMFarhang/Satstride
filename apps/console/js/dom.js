// DOM helpers: a small keyed morph (pages render HTML strings; the morph
// patches the live DOM so scroll positions, focus, hover and running
// animations survive each poll), animated counters, a floating tooltip,
// toasts and clipboard copy.

import { esc } from './format.js'

export const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null)
const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.tagName === b.tagName && keyOf(a) === keyOf(b)))

/** Replace `el`'s children with `html`, reusing matching nodes. */
export function morph(el, html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  morphChildren(el, tpl.content)
}

function morphChildren(from, to) {
  const keyed = new Map()
  const unkeyed = []
  for (const n of from.childNodes) {
    const k = keyOf(n)
    if (k !== null) keyed.set(k, n)
    else unkeyed.push(n)
  }
  let u = 0
  let ref = from.firstChild
  for (const nn of [...to.childNodes]) {
    const k = keyOf(nn)
    let match = null
    if (k !== null) {
      match = keyed.get(k) ?? null
      keyed.delete(k)
    } else if (u < unkeyed.length) {
      const cand = unkeyed[u]
      if (same(cand, nn)) { match = cand; u++ }
    }
    if (match && !same(match, nn)) match = null
    if (match) {
      morphNode(match, nn)
      if (match === ref) ref = ref.nextSibling
      else from.insertBefore(match, ref)
    } else {
      from.insertBefore(nn, ref)
    }
  }
  while (ref) {
    const next = ref.nextSibling
    from.removeChild(ref)
    ref = next
  }
}

function morphNode(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue
    return
  }
  syncAttributes(a, b)
  // Subtrees owned by JS (charts, counters) keep their own children.
  if (a.hasAttribute('data-own') || a.hasAttribute('data-count')) return
  morphChildren(a, b)
}

function syncAttributes(a, b) {
  for (const { name } of [...a.attributes]) {
    if (b.hasAttribute(name)) continue
    if (name === 'open' && a.tagName === 'DETAILS') continue
    a.removeAttribute(name)
  }
  for (const { name, value } of [...b.attributes]) {
    if (a.getAttribute(name) !== value) a.setAttribute(name, value)
  }
  // keep live form state in step with explicit attributes
  if (a.tagName === 'BUTTON' || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA') {
    a.disabled = b.hasAttribute('disabled')
  }
}

// ---------- animated counters ----------

/**
 * Elements with data-count="<number>" count to their target with
 * requestAnimationFrame. `fmt(el, value)` renders the text.
 */
export function animateCounters(root, fmt) {
  for (const el of root.querySelectorAll('[data-count]')) {
    const raw = el.getAttribute('data-count')
    const target = raw === '' ? NaN : Number(raw)
    if (!Number.isFinite(target)) {
      cancelAnimationFrame(el._raf)
      el._target = undefined
      el._shown = undefined
      el.textContent = '—'
      continue
    }
    if (el._target === target) continue
    const first = el._target === undefined
    const from = Number.isFinite(el._shown) ? el._shown : 0
    el._target = target
    cancelAnimationFrame(el._raf)
    if (reducedMotion() || from === target) {
      el._shown = target
      el.textContent = fmt(el, target)
      continue
    }
    if (!first) pulse(el.closest('[data-pulse]') ?? el)
    const start = performance.now()
    const dur = first ? 900 : 650
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur)
      const e = 1 - (1 - p) ** 3
      el._shown = p < 1 ? from + (target - from) * e : target
      el.textContent = fmt(el, el._shown)
      if (p < 1) el._raf = requestAnimationFrame(step)
    }
    el._raf = requestAnimationFrame(step)
  }
}

export function pulse(el) {
  if (reducedMotion() || !el.animate) return
  el.animate(
    [
      { boxShadow: '0 0 0 0 var(--pulse)' },
      { boxShadow: '0 0 0 6px transparent' },
    ],
    { duration: 900, easing: 'ease-out' },
  )
}

// ---------- floating tooltip ----------

let tipEl = null
let tipFor = null

export function initTooltips() {
  tipEl = document.getElementById('tip')
  if (!tipEl) return
  const show = (target) => {
    const text = target.getAttribute('data-tip')
    if (!text) return hide()
    tipFor = target
    tipEl.textContent = text
    tipEl.hidden = false
    const r = target.getBoundingClientRect()
    const t = tipEl.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    let x = r.left + r.width / 2 - t.width / 2
    x = Math.max(8, Math.min(vw - t.width - 8, x))
    let y = r.top - t.height - 8
    if (y < 8) y = r.bottom + 8
    tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }
  const hide = () => {
    tipFor = null
    tipEl.hidden = true
  }
  document.addEventListener('mouseover', (ev) => {
    const t = ev.target.closest?.('[data-tip]')
    if (t && t !== tipFor) show(t)
    else if (!t && tipFor) hide()
  })
  document.addEventListener('focusin', (ev) => {
    const t = ev.target.closest?.('[data-tip]')
    if (t) show(t)
  })
  document.addEventListener('focusout', hide)
  document.addEventListener('scroll', hide, true)
}

export function hideTooltip() {
  if (tipEl) tipEl.hidden = true
  tipFor = null
}

// ---------- toasts ----------

export function toast(text, tone = 'neutral') {
  const host = document.getElementById('toasts')
  if (!host) return
  const el = document.createElement('div')
  el.className = `toast toast-${tone}`
  el.innerHTML = esc(text)
  host.appendChild(el)
  setTimeout(() => {
    el.classList.add('out')
    setTimeout(() => el.remove(), 250)
  }, 2200)
}

// ---------- clipboard ----------

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
