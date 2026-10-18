// Passbook dashboard. Left: the borrower's phone, built to the screen rules in
// docs/RGB-WALLET-UX.md section 6.0 (one job per screen, one number, one
// button, explanations behind a tap). It reads the platform's passbook view,
// the wire (GET /events), and under `npm run dev` the borrower's own wallet
// (GET /demo/wallet), and it answers the demo's stops: share at step 5, accept
// at step 7, pay at step 8. Middle: the step gate, and the price slider that
// moves the regtest oracle (POST /oracle/set; the platform runs its
// margin-call monitor on every change). Right: the wire.
// Every write is signed with the operator session from the printed link
// (web/session-auth.js); the platform refuses unsigned writes.

import { readSession, signedPost } from '/session-auth.js'

const session = readSession()
const write = (path, body) => signedPost(session, path, body)

const STEPS = [
  ['Setup', 'Regtest height, the mock USDT contract, the borrower\'s payer-signed inflows.'],
  ['Ask', 'The borrower asks for 600 USDT for 30 blocks; the phone shows the bitcoin to lock at the earned limit.'],
  ['Order book', 'Lender 1 publishes its offer to the Nostr relay; the platform\'s order book picks it up.'],
  ['Negotiate', 'The borrower and lender agents negotiate inside policies their owners signed: signed, hash-chained messages, ending in ACCEPT. No model sets a number.'],
  ['Sandbox', 'The wallet history goes in encrypted to the sandbox key. Only signed checks and a disclosure proposal come out.'],
  ['Approve', 'Stop 1 on the phone: the borrower picks which proposed inflows the lender may see, then applies over Nostr.'],
  ['Underwrite', 'Lender 1 verifies the sandbox signature and each disclosed inflow, reads the passbook, prices with deterministic policy and drafts an explanation.'],
  ['Lock and fund', 'Stop 2 on the phone: accept and lock. Collateral locked with the terms hash in OP_RETURN, default split signed, USDT disbursed over RGB.'],
  ['Repay', 'Stop 3 on the phone: pay. USDT back over RGB to the invoice the platform watches; lender and borrower co-sign the release. Both txids are the receipt. If the lender refuses, the platform validates the RGB repayment itself and co-signs through leaf C.'],
  ['Ladder', 'One on-time page lifts the limit to 55%. Lender 2 reads the chain and lends against the same bitcoin.'],
  ['Outcome', 'What each party holds, read from the chain and the RGB wallets.'],
]
// the margin scenario: the steps up to lock and fund, then the price falls
const MARGIN_STEPS = [
  ...STEPS.slice(0, 8),
  ['Margin call', 'The oracle price falls; the platform\'s monitor raises a margin call; the borrower\'s model explains the headroom.'],
  ['Cure window', '10 blocks for the borrower. Drag the price back up to cure; otherwise the call stands.'],
  ['Liquidate or cure', 'At 80% LTV or more after the window, lender and platform spend leaf B. Cured: the phone\'s Pay stop, then the release as usual.'],
  ['Outcome', 'What each party holds, read from the chain and the RGB wallets; the passbook page says how it closed.'],
]
/** the margin-call button takes the open loan here: past liquidation (80%), short of the hard stop (85%) */
const SCENARIO_LTV_BPS = 8200n

// ---- small helpers ----

const $ = (id) => document.getElementById(id)
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else if (v === true) n.setAttribute(k, '')
    else n.setAttribute(k, v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k)
  return n
}
const NS = 'http://www.w3.org/2000/svg'
const CIRCLE = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0'
const ICONS = {
  back: ['M15 5l-7 7 7 7'],
  chev: ['M9 5l7 7-7 7'],
  down: ['M6 9l6 6 6-6'],
  check: ['M5 12l5 5 9-10'],
  info: [CIRCLE, 'M12 11v5', 'M12 8h.01'],
  clock: [CIRCLE, 'M12 7v5l3 2'],
  cross: ['M18 6L6 18', 'M6 6l12 12'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  back2: ['M4 12a8 8 0 1 0 3-6.2', 'M4 4v4h4'],
  book: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11'],
  wallet: ['M3 7a2 2 0 0 1 2-2h14v14H5a2 2 0 0 1-2-2z', 'M15 12h2'],
  alert: [CIRCLE, 'M12 7v6', 'M12 16h.01'],
}
const icon = (name, style) => {
  const s = document.createElementNS(NS, 'svg')
  s.setAttribute('viewBox', '0 0 24 24')
  s.setAttribute('fill', 'none')
  s.setAttribute('stroke', 'currentColor')
  s.setAttribute('stroke-width', '2')
  s.setAttribute('stroke-linecap', 'round')
  s.setAttribute('stroke-linejoin', 'round')
  s.setAttribute('aria-hidden', 'true')
  if (style) s.setAttribute('style', style)
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    s.append(p)
  }
  return s
}
const short = (h, n = 10) => (typeof h === 'string' && h.length > n + 2 ? `${h.slice(0, n)}…` : String(h ?? ''))
const usdNum = (micro) => (micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usdt = (micro) => `${usdNum(micro)} USDT`
const btcNum = (sats) => {
  let s = (sats / 1e8).toFixed(8).replace(/0+$/, '')
  if (s.endsWith('.')) s += '0'
  return s
}
const btc = (sats) => `${btcNum(sats)} BTC`
/** "0.01212000 BTC" from an agent note, tidied */
const tidyBtc = (s) => (typeof s === 'string' && s.endsWith('BTC') ? btc(Math.round(parseFloat(s) * 1e8)) : s ?? '')
const satsText = (n) => `${Math.round(n).toLocaleString('en-US')} sats`
const dollars = (cents) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
const centsOf = (sats, priceCents) => Math.round((sats * priceCents) / 1e8)
const pctOf = (bps) => `${bps / 100}%`

// ---- state ----

const view = { step: 0, borrower: null, waiting: null, seen: new Set(), hidden: new Set(['model']), state: null, pb: null, wallet: null, lenders: {}, demo: false, scenario: 'standard', inspection: false, price: null, openLoan: null, terms: new Map(), atomicMode: false, atomic: new Map(), fees: new Map(), negotiation: [], negotiate: true }
const steps = () => (view.scenario === 'standard' ? STEPS : MARGIN_STEPS).filter((s) => view.negotiate || s[0] !== 'Negotiate').map((s) => view.atomicMode && s[0] === 'Repay' ? ['Repay', 'RGB Lightning pays the committed invoice and reveals its secret. The borrower releases bitcoin through leaf E, without a co-signer. The confirmed witness carries the public preimage.'] : s)
/** one entry per borrowing cycle, built from the borrower's and lenders' own notes on the wire */
const flow = { cycles: [], cur: null, lastWaiting: null }
/** what the person has tapped; never sent anywhere */
const ui = { tab: 'passbook', sheet: null, open: new Set(), depth: 'plain', raw: false, page: null, dismissed: new Set(), unticked: new Set(), busy: false }

const BORROWER_NOTES = {
  'Offer found in the order book': 'found',
  'Sandbox result received': 'checked',
  'Application sent to the lender (NIP-44)': 'applied',
  'Terms checked and accepted': 'accepted',
  'Collateral locked with the terms hash in OP_RETURN': 'locked',
  'USDT received over RGB; loan open': 'funded',
  'Repaid over RGB': 'repaid',
  'Repaid over Lightning → secret revealed → collateral released': 'atomic',
  'Collateral released; passbook page stamped': 'released',
  'Collateral released through leaf C with the platform; passbook page stamped': 'released',
}

function track(e) {
  const c = flow.cur
  if (e.type === 'agent' && e.role === 'borrower') {
    if (e.title === 'Asking for a loan') {
      flow.cur = { ask: e.detail ?? {} }
      flow.cycles.push(flow.cur)
      ui.open.clear()
      ui.depth = 'plain'
      return
    }
    const k = BORROWER_NOTES[e.title]
    if (k && c) c[k] = e.detail ?? {}
    if (k === 'atomic' && c) { c.released = e.detail; c.repaid = e.detail; view.atomic.set(e.detail.loan_id, e.detail) }
  } else if (e.type === 'atomic_repayment') {
    view.atomic.set(e.loan_id, e)
    if (c) { c.atomic = e; c.released = e; c.repaid = e }
  } else if (e.type === 'agent' && c && e.title.startsWith('Repayment settled')) {
    c.acked = e.detail ?? {}
  } else if (e.type === 'offer' && c && !c.lender_pk && e.action === 'upsert') {
    c.lender_pk = e.lender_pk
  } else if (e.type === 'demo') {
    const prev = flow.lastWaiting
    if (prev?.waiting === 'confirm' && prev.stop === 'repay' && !e.waiting && !e.error && c) c.repaying = true
    flow.lastWaiting = e.waiting ? e : null
    if (e.waiting && c && e.lender_pk) c.lender_pk = e.lender_pk
    if (e.waiting === 'confirm' && e.stop === 'repay' && c) c.repay = e
  }
}

// ---- data the phone reads ----

const pages = () => view.pb?.pages ?? []
const openPage = () => pages().find((p) => p.outcome === 'open' && p.status !== 'pending')
const pageNo = (p) => pages().indexOf(p) + 1
const price = () => view.pb?.price_cents ?? view.state?.price_cents ?? 0
const height = () => view.state?.height ?? 0
/** a lender's display name, kept on one line wherever it wraps */
const lenderName = (pk) => ((pk && view.lenders[pk]) || (pk ? `Lender ${pk.slice(0, 6)}` : 'the lender')).replaceAll(' ', ' ')
const lenderOf = (p) => { const loan = view.state?.loans?.find((l) => l.id === p.loan_id); return loan?.lender_pk ?? loan?.terms?.lender_pk }
const allowedBps = () => view.pb?.ladder?.allowed_ltv_bps ?? 5000
const freeSats = () => (view.wallet?.btc_free_sats ?? 0)
/** what the free bitcoin supports at the earned limit, rounded down to whole dollars */
const borrowable = () => Math.floor((centsOf(freeSats(), price()) * allowedBps()) / 10_000 / 100)
const nextIs = (re) => view.waiting?.waiting === 'next' && re.test(view.waiting.title ?? '')

// ---- actions ----

async function post(path, body) {
  ui.error = null
  ui.busy = true
  renderPhone(true)
  try {
    const response = await write(path, body ?? {})
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.error ?? 'This action is no longer available. Refresh and try again.')
  } catch (error) {
    ui.error = error.message
  } finally {
    ui.busy = false
    renderPhone(true)
  }
}
const next = () => post('/demo/next')
const confirmStop = (stop, accept) => post('/demo/confirm', { stop, accept, loan_id: view.waiting?.loan_id })
function approve() {
  const items = view.waiting?.items ?? []
  const txids = items.filter((i) => !ui.unticked.has(i.txid)).map((i) => i.txid)
  ui.unticked.clear()
  return post('/demo/approve', { txids })
}
const openSheet = (s) => {
  ui.sheet = s
  renderPhone(true)
  document.querySelector('.sheet .btn')?.focus()
}
const closeSheet = () => {
  ui.sheet = null
  renderPhone(true)
}
const toggle = (key) => {
  ui.open.has(key) ? ui.open.delete(key) : ui.open.add(key)
  renderPhone(true)
}

// ---- building blocks ----

const iconBtn = (name, label, onclick) => el('button', { class: 'icon-btn', 'aria-label': label, onclick }, icon(name))
const spacer = () => el('span', { class: 'icon-btn spacer', 'aria-hidden': 'true' })
const top = (title, { back, right, left } = {}) =>
  el('div', { class: 'top' }, back ? iconBtn('back', 'Back', back) : left ? null : spacer(), el('div', { class: `t${left ? ' left' : ''}`, text: title }), right ?? spacer())
const chainSwitch = () =>
  el('button', { class: 'chain-sw', 'aria-pressed': String(ui.raw), title: 'Show chain details everywhere', onclick: () => ((ui.raw = !ui.raw), renderPhone(true)) }, 'Chain')
const grow = () => el('div', { class: 'grow' })
const btn = (label, kind, onclick, disabled = false) => el('button', { class: `btn ${kind}`, onclick, disabled: disabled || ui.busy }, label)
const undo = () => el('div', { class: 'undo', text: "Can't be undone" })
const rowb = (k, v, onclick) =>
  onclick
    ? el('button', { class: 'rowb', onclick }, el('span', { class: 'k', text: k }), el('span', { class: 'v' }, v, icon('chev')))
    : el('div', { class: 'rowb' }, el('span', { class: 'k', text: k }), el('span', { class: 'v' }, v))
const toggleRow = (key, label, value) =>
  el(
    'button',
    { class: 'rowb', 'aria-expanded': String(ui.open.has(key)), onclick: () => toggle(key) },
    el('span', { class: 'k', text: label }),
    el('span', { class: 'v' }, value ?? '', icon('down', ui.open.has(key) ? 'transform: rotate(180deg)' : '')),
  )
const kv = (k, v) => el('div', { class: 'kv' }, el('span', { text: k }), el('span', {}, v))
const tx = (label, txid, ok) => el('div', { class: 'kv' }, el('span', { text: label }), el('span', { class: 'tx', title: txid }, txid ? short(txid, 16) : '…', ok === undefined ? '' : ok ? ' ✓' : ' ✗'))
const bar4 = (flags, label) => el('div', { class: 'bar4', role: 'img', 'aria-label': label }, ...flags.map((f) => el('span', { class: f ? 'on' : '' })))
const stepList = (items) => {
  const firstTodo = items.findIndex(([, , done]) => !done)
  return el(
    'div',
    { class: 'steps4' },
    ...items.map(([label, right, done], i) =>
      el('div', { class: `st ${done ? 'done' : i === firstTodo ? 'now' : 'todo'}` }, el('span', { class: 'm' }, done ? icon('check') : ''), el('span', { text: label }), right ? el('span', { class: 'r', text: right }) : null),
    ),
  )
}
const stateChip = (h) => {
  const s = h.state
  if (s === 'healthy') return el('span', { class: 'ok' }, el('span', { class: 'dot' }), ' Safe')
  if (s === 'margin_call') return el('span', { class: 'bad' }, el('span', { class: 'dot' }), ' Margin call')
  return el('span', { class: 'bad' }, el('span', { class: 'dot' }), ' At risk')
}
const ladderStrip = () => {
  const steps = view.pb?.ladder_bps ?? [5000, 5500, 6000, 6500]
  const at = view.pb?.ladder?.step ?? 0
  return el('div', { class: 'ladder', role: 'img', 'aria-label': `Limit ladder, now at ${pctOf(steps[at])}` }, ...steps.map((b, i) => el('span', { class: i <= at ? 'on' : '', text: pctOf(b) })))
}

// ---- screens ----

function screenName() {
  if (view.inspection) return 'home'
  const w = view.waiting
  if (w?.waiting === 'approve') return 'stop1'
  if (w?.waiting === 'confirm' && w.stop === 'accept') return 'stop2'
  if (w?.waiting === 'confirm' && w.stop === 'repay') return 'stop3'
  if (ui.page) return 'page'
  if (ui.tab === 'wallet') return 'wallet'
  const c = flow.cur
  if (c?.repaying && !c.released) return 'sending'
  if (c?.released && !ui.dismissed.has(c.released.release_txid) && lastClosed()) return 'stamped'
  if (c && !c.locked && !c.released) return 'borrow'
  return 'home'
}
const lastClosed = () => [...pages()].reverse().find((p) => p.outcome !== 'open' && p.close_txid)

function home() {
  if (view.inspection) return [
    top('Saved passbook', { right: chainSwitch() }),
    el('div', { class: 'banner' }, 'History recovered. Wallet balances are unavailable; approvals and payments are paused.'),
    ladderStrip(),
    ...pages().map((p) => el('div', { class: 'card' },
      el('b', { text: `Page ${pageNo(p)} · ${p.status.toUpperCase()}` }),
      el('div', { class: 'amt', text: usdt(p.principal) }),
      el('div', { class: 'sub', text: `${btc(p.collateral_sats)} collateral · due block ${p.maturity_height}` }),
      rawPage(p))),
    grow(),
  ]
  const p = openPage()
  const kids = [top('Your passbook', { left: true, right: chainSwitch() })]
  if (p) {
    if (p.cure_until_height !== undefined) kids.push(el('div', { class: 'banner bad' }, icon('alert'), el('span', {}, el('b', { text: 'Margin call. ' }), `Cure window ends at block ${p.cure_until_height}. Use the demo price control to rehearse a recovery.`)))
    kids.push(pageCard(p))
    kids.push(
      el(
        'div',
        { class: 'rows' },
        rowb('Limit', pctOf(allowedBps()), () => openSheet('limit')),
        p.headroom ? rowb('If bitcoin falls', stateChip(p.headroom), () => openSheet('margin')) : null,
        rowb('Dollars', usdt(view.wallet?.usdt_settled ?? 0)),
      ),
    )
    kids.push(grow(), el('div', { class: 'cta' }, btn(`Pay page ${pageNo(p)}`, 'primary', next, !(nextIs(/^Repay/) && p.status === 'open'))))
    return kids
  }
  kids.push(
    el(
      'div',
      { class: 'hero' },
      el('div', { class: 'label', text: 'You can borrow up to' }),
      el('div', { class: 'big', text: view.wallet ? `${borrowable().toLocaleString('en-US')} USDT` : pctOf(allowedBps()) }),
      el('div', { class: 'sub', text: `${pctOf(allowedBps())} of your bitcoin's value` }),
    ),
    ladderStrip(),
  )
  const closed = pages().filter((x) => x.outcome !== 'open')
  if (closed.length)
    kids.push(
      el('div', { class: 'sec', text: 'Pages' }),
      el(
        'div',
        { class: 'list' },
        ...closed.map((x) =>
          el(
            'button',
            { class: 'li', onclick: () => ((ui.page = x.loan_id), renderPhone(true)) },
            el('span', { class: 'a' }, el('span', { text: `Page ${pageNo(x)} · ${usdt(x.principal)}` }), el('span', { text: lenderName(lenderOf(x)) })),
            el('span', { class: `tag ${x.outcome === 'on_time' ? 'done' : 'bad'}`, text: x.outcome === 'on_time' ? 'ON TIME' : x.outcome.replace('_', ' ').toUpperCase() }),
          ),
        ),
      ),
    )
  else kids.push(el('div', { class: 'rows' }, rowb('Dollars', usdt(view.wallet?.usdt_settled ?? 0))))
  kids.push(grow(), el('div', { class: 'cta' }, btn('Borrow 600 USDT', 'primary', next, !nextIs(/^(Ask|Ladder)/))))
  return kids
}

function pageCard(p) {
  const lender = lenderName(lenderOf(p))
  const funded = p.status === 'open' || p.status === 'repaid'
  const left = p.maturity_height - height()
  const key = `page-${p.loan_id}`
  const sub = funded ? `due block ${p.maturity_height}${left > 0 ? ` · in ${left} blocks` : ''} · ${lender}` : `Waiting for ${lender} to pay in`
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'row1' }, el('b', { text: `Page ${pageNo(p)}` }), el('span', { class: 'tag open', text: 'OPEN' })),
    el('div', { class: 'amt', text: usdt(p.principal + p.fee) }),
    el('div', { class: 'sub', text: sub }),
    bar4([p.verified.lock, funded, p.status === 'repaid', p.verified.close], `Locked ${p.verified.lock ? 'yes' : 'no'}, paid in ${funded ? 'yes' : 'no'}`),
    toggleRow(key, 'Details'),
    ui.open.has(key)
      ? el(
          'div',
          { class: 'more' },
          stepList([
            [`${btc(p.collateral_sats)} locked`, null, p.verified.lock],
            [`${usdt(p.principal)} received`, null, funded],
            ['Paid', null, p.status === 'repaid'],
            ['Stamped', null, p.verified.close],
          ]),
          funded ? null : el('p', { class: 'small', text: `If ${lender} doesn't pay within 10 blocks, you can request a refund co-signed by the platform.` }),
          ui.raw ? rawPage(p) : el('button', { class: 'link', onclick: () => ((ui.raw = true), renderPhone(true)) }, 'Chain details'),
        )
      : null,
  )
}

function rawPage(p) {
  return el(
    'div',
    { class: 'more' },
    tx('Lock', p.lock_txid, p.verified.lock),
    tx('Close', p.close_txid, p.close_txid ? p.verified.close : undefined),
    kv('Terms in OP_RETURN', p.verified.terms_commitment ? '✓' : '✗'),
    kv('Collateral output', p.verified.collateral_amount ? '✓' : '✗'),
    kv('Chained to last page', p.verified.chain_link ? '✓' : '✗'),
    kv('LTV at open', pctOf(p.ltv_bps)),
    kv('Loan', el('span', { class: 'tx', text: short(p.loan_id, 16) })),
  )
}

function borrow() {
  const c = flow.cur
  const a = c.ask ?? {}
  const lender = lenderName(c.lender_pk)
  return [
    top('Borrow'),
    el('div', { class: 'hero' }, el('div', { class: 'big', text: a.principal ?? '' }), el('div', { class: 'sub', text: a.term_blocks ? `for ${a.term_blocks} blocks` : '' })),
    el('div', { class: 'rows' }, rowb('You lock', tidyBtc(c.accepted?.collateral ?? a.btc_needed)), rowb('Interest', c.accepted?.fee ?? 'set by the lender')),
    stepList([
      ['Lender found', c.found ? `${lender} · ${c.found.apr}` : null, !!c.found],
      ['Checked privately', null, !!c.checked],
      ['Application sent', null, !!c.applied],
      [`${c.found ? lender : 'Lender'} accepted`, null, !!c.accepted],
    ]),
    grow(),
    el('p', { class: 'small', text: 'You will be asked before anything is shared or signed.' }),
  ]
}

function stop1() {
  const w = view.waiting
  const items = w.items ?? []
  const lender = lenderName(w.lender_pk)
  const q = items.length ? `Share ${items.length} payment${items.length > 1 ? 's' : ''} with ${lender}?` : `${lender} doesn't ask for income proof`
  return [
    top('Apply', { right: el('span', { class: 'stop-n', text: '1 OF 3' }) }),
    el('div', { class: 'q', text: q }),
    items.length
      ? el(
          'div',
          { class: 'ticks' },
          ...items.map((i) =>
            el(
              'label',
              { class: 'tickrow' },
              el('input', { type: 'checkbox', checked: !ui.unticked.has(i.txid), onchange: (ev) => (ev.target.checked ? ui.unticked.delete(i.txid) : ui.unticked.add(i.txid)) }),
              el('span', { text: usdt(i.amount) }),
              el('span', { class: 'r', text: `block ${i.height}` }),
            ),
          ),
        )
      : el('p', { class: 'muted', text: 'They read your passbook instead.' }),
    el('button', { class: 'link', onclick: () => openSheet('share') }, `What will ${lender} see?`),
    grow(),
    el('div', { class: 'cta' }, btn(items.length ? 'Share and apply' : 'Apply', 'primary', approve)),
  ]
}

function stop2() {
  const w = view.waiting
  const lender = lenderName(w.lender_pk)
  const debt = w.principal + w.fee
  return [
    top('Accept', { right: el('span', { class: 'stop-n', text: '2 OF 3' }) }),
    el('div', { class: 'hero' }, el('div', { class: 'label', text: 'You lock' }), el('div', { class: 'big', text: btc(w.collateral_sats) }), el('div', { class: 'sub', text: `Get ${usdt(w.principal)} · repay ${usdNum(debt)}${w.atomic_repayment ? ' + 3,000 sats over Lightning' : ''} by block ${w.maturity_height}` })),
    // the platform wrote these from the terms: principal + interest, no other fee, and the early-liquidation disclosure
    ...(w.cost_lines ?? []).map((line) => el('p', { class: 'small', text: line })),
    // negotiated loans: this exact term sheet, its evidence digest and the hash the lock will commit
    ...(w.termsheet ? [el('p', { class: 'small', text: w.termsheet.render.scorer }), el('p', { class: 'small', text: w.termsheet.render.settlement }), el('p', { class: 'small', text: `Term sheet ${short(w.termsheet.hash, 12)}: ${w.termsheet.render.final}` })] : []),
    grow(),
    el(
      'div',
      { class: 'rows' },
      toggleRow('agree', 'What am I agreeing to?'),
      ui.open.has('agree')
        ? el(
            'div',
            { class: 'more' },
            el('p', { text: w.explanation }),
            el('div', { class: 'small', text: 'Worded on your device from your terms. The numbers are the terms.' }),
            kv(`If ${lender} never pays`, `refund request after ${w.refund_blocks} blocks`),
            kv(`If unpaid at block ${w.maturity_height + w.grace_blocks}`, `${lender} gets ${btc(w.lender_sats_on_default)}`),
            kv('You get back', btc(w.borrower_sats_on_default)),
            w.atomic_repayment ? kv('Lightning BTC payment', '3,000 sats extra, paid to lender') : null,
            w.atomic_repayment ? kv('Invoice expires', new Date(w.atomic_repayment.expires_at * 1000).toLocaleString()) : null,
          )
        : null,
    ),
    el('div', { class: 'cta' }, el('div', { class: 'two' }, btn(w.termsheet ? 'Approve and lock' : 'Lock and accept', 'primary grow', () => confirmStop('accept', true)), btn('Decline', 'second', () => confirmStop('accept', false))), undo()),
  ]
}

function stop3() {
  const w = view.waiting
  const lender = lenderName(w.lender_pk)
  const p = pages().find((x) => x.loan_id === w.loan_id)
  const ready = (view.wallet?.reserve_sats ?? 0) > 0
  return [
    top(`Pay page ${p ? pageNo(p) : ''}`.trim(), { right: iconBtn('info', 'What happens next', () => openSheet('next')) }),
    el('div', { class: 'hero' }, el('div', { class: 'big', text: usdt(w.debt) }), el('div', { class: 'sub', text: `to ${lender}${w.atomic_repayment ? ' over RGB Lightning + 3,000 sats' : ''}` })),
    el('div', { class: 'chip ok' }, icon('back2'), `${btc(w.collateral_sats)} comes back to you`),
    grow(),
    el(
      'div',
      { class: 'rows' },
      w.atomic_repayment ? rowb('Release', 'No co-signer needed') : null,
      w.atomic_repayment ? rowb('Additional BTC payment', '3,000 sats to lender') : null,
      toggleRow('fee', 'Network fee', 'from your reserve'),
      ui.open.has('fee')
        ? el(
            'div',
            { class: 'more' },
            stepList([
              [w.atomic_repayment ? 'Funded RGB Lightning channel ready' : ready ? 'Wallet ready to send' : 'Wallet needs a reserve slot first', null, w.atomic_repayment || ready],
              [`Amount from your terms: ${usdt(w.debt)}`, null, true],
            ]),
            el('p', { class: 'small', text: w.atomic_repayment ? 'Lightning pays the invoice and reveals the secret; your key releases the collateral through leaf E.' : 'One confirmation, then the release.' }),
          )
        : null,
    ),
    el('div', { class: 'cta' }, btn(`Pay ${usdt(w.debt)}${w.atomic_repayment ? ' + 3,000 sats' : ''}`, 'primary', () => confirmStop('repay', true)), undo()),
  ]
}

function sending() {
  const c = flow.cur
  const r = c.repay ?? {}
  const receipt = pages().find((p) => p.loan_id === r.loan_id)
  const lender = lenderName(r.lender_pk ?? c.lender_pk)
  const seg = el(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Depth' },
    ...[['plain', 'Plain'], ['check', 'Check'], ['raw', 'Raw']].map(([id, label]) => el('button', { 'aria-pressed': String(ui.depth === id), onclick: () => ((ui.depth = id), renderPhone(true)) }, label)),
  )
  let body
  if (r.atomic_repayment) {
    body = el('div', { class: 'more' },
      el('p', { text: c.atomic ? 'Repaid over Lightning → secret revealed → collateral released' : 'Paying over RGB Lightning. The matching secret unlocks your collateral.' }),
      kv('Co-signer', 'None needed'),
      kv('Lightning payment hash', c.atomic?.payment_hash ?? r.atomic_repayment.payment_hash),
      c.atomic ? kv('Public preimage', c.atomic.preimage) : null,
      c.atomic ? tx('Leaf E release', c.atomic.release_txid) : null,
    )
  } else if (ui.depth === 'plain')
    body = el(
      'div',
      { class: 'list' },
      el('div', { class: 'li' }, el('span', { class: 'asset' }, icon('clock', 'width:22px;height:22px'), 'On its way · about one block')),
      el('div', { class: 'li' }, el('span', { class: 'asset' }, icon('cross', 'width:22px;height:22px'), "Nothing to do. Don't send again.")),
      el('div', { class: 'li' }, el('span', { class: 'asset' }, icon('arrow', 'width:22px;height:22px'), 'Next: your bitcoin comes back')),
    )
  else if (ui.depth === 'check')
    body = stepList([
      ['Sent', null, true],
      ['1 confirmation', null, !!c.repaid],
      [`${lender} picked it up`, null, !!c.acked],
      ['Bitcoin released', null, !!c.released],
    ])
  else
    body = el(
      'div',
      { class: 'more' },
      tx('Repayment', receipt?.repayment_txid ?? c.repaid?.txid),
      kv('Amount', c.repaid?.amount ?? usdt(r.debt ?? 0)),
      kv('Mined at', c.repaid?.height ? `block ${c.repaid.height}` : 'mempool'),
      tx('Lender ack', c.acked?.txid),
      tx('Release', receipt?.close_txid ?? c.released?.release_txid),
    )
  return [top('Repayment'), el('div', { class: 'hero' }, el('div', { class: 'big', text: 'Sending' }), el('div', { class: 'sub', text: `${usdt(r.debt ?? 0)} to ${lender}` })), seg, body, grow()]
}

function pageScreen(p, { back }) {
  const lender = lenderName(lenderOf(p))
  const key = `rcpt-${p.loan_id}`
  const atomic = view.atomic.get(p.loan_id)
  const onTime = p.outcome === 'on_time'
  const about = borrowable()
  return [
    top(`Page ${pageNo(p)}`, back ? { back } : {}),
    el(
      'div',
      { class: 'card', style: 'align-items:center;text-align:center;padding:24px 16px' },
      el('div', { class: `stamp${onTime ? '' : ' late'}`, text: onTime ? 'PAID ON TIME' : p.outcome.replace('_', ' ').toUpperCase() }),
      el('div', { class: 'amt', text: usdt(p.principal) }),
      el('div', { class: 'sub', text: `from ${lender}` }),
    ),
    el('div', { class: 'banner ok' }, icon('arrow', 'width:20px;height:20px;transform:rotate(-45deg)'), el('span', {}, el('b', { text: `Limit now ${pctOf(allowedBps())}` }), view.wallet ? ` · up to ${about.toLocaleString('en-US')} USDT` : '')),
    el(
      'div',
      { class: 'rows' },
      toggleRow(key, 'Details and receipts'),
      ui.open.has(key)
        ? el(
            'div',
            { class: 'more' },
            atomic ? el('p', { text: 'Repaid over Lightning → secret revealed → collateral released' }) : null,
            atomic ? kv('Co-signer', 'None needed') : null,
            atomic ? kv('Lightning payment hash', atomic.payment_hash) : null,
            atomic ? kv('Public preimage', atomic.preimage) : null,
            atomic ? tx('Leaf E release', atomic.release_txid, p.verified.close) : null,
            kv('Opened', `block ${p.open_height}`),
            kv('Due', `block ${p.maturity_height}`),
            onTime || p.outcome === 'late' ? kv('Paid back', usdt(p.principal + p.fee)) : kv('Outcome', p.outcome),
            kv('Bitcoin returned', p.returned_sats === undefined ? 'Not verified yet' : btc(p.returned_sats)),
            p.repayment_txid ? tx('RGB repayment receipt', p.repayment_txid) : null,
            tx('Lock receipt', p.lock_txid, p.verified.lock),
            tx(onTime || p.outcome === 'late' ? 'Release receipt' : 'Settlement receipt', p.close_txid, p.verified.close),
          )
        : null,
    ),
    grow(),
    el('div', { class: 'cta' }, btn(back ? 'Back to passbook' : 'Done', 'primary', back ?? (() => (ui.dismissed.add(flow.cur?.released?.release_txid), renderPhone(true))))),
  ]
}

function walletScr() {
  const w = view.wallet ?? {}
  const p = openPage()
  const spendable = (w.btc_free_sats ?? 0) + (w.fee_btc_sats ?? 0)
  const STATUS = { Settled: 'Done', WaitingConfirmations: 'Confirming', WaitingCounterparty: 'Waiting', Failed: 'Needs attention' }
  return [
    top('Wallet', { left: true, right: chainSwitch() }),
    el(
      'div',
      { class: 'hero' },
      el('div', { class: 'big', text: btc(spendable) }),
      el('div', { class: 'sub', text: dollars(centsOf(spendable, price())) }),
      el('button', { class: 'chip', onclick: () => openSheet('reserve') }, `+ ${satsText(w.reserve_sats ?? 0)} reserved`, icon('info')),
    ),
    p ? el('div', { class: 'rows' }, rowb('In the safe', btc(p.collateral_sats))) : null,
    el('div', { class: 'sec', text: 'Assets' }),
    el(
      'div',
      { class: 'list' },
      el(
        'div',
        { class: 'li' },
        el('span', { class: 'asset' }, el('span', { class: 'coin', text: '$' }), el('span', {}, 'USDT '), el('span', { class: 'ok', title: 'Verified issuer' }, icon('check', 'width:16px;height:16px'))),
        el('span', { class: 'a', style: 'align-items:flex-end' }, el('b', { text: usdNum(w.usdt_settled ?? 0) }), (w.usdt_future ?? 0) > (w.usdt_settled ?? 0) ? el('span', { text: `+${usdNum(w.usdt_future - w.usdt_settled)} arriving` }) : null),
      ),
    ),
    el('div', { class: 'sec', text: 'Activity' }),
    el(
      'div',
      { class: 'list' },
      ...(w.transfers ?? []).map((t) =>
        el(
          'div',
          { class: 'li' },
          el('span', { class: 'a' }, el('span', { text: t.kind === 'Send' ? 'USDT sent' : 'USDT received' }), el('span', { text: ui.raw && t.txid ? short(t.txid, 16) : STATUS[t.status] ?? t.status })),
          el('b', { class: t.kind === 'Send' ? '' : 'ok', text: `${t.kind === 'Send' ? '−' : '+'}${usdNum(t.amount)}` }),
        ),
      ),
      (w.transfers ?? []).length ? null : el('div', { class: 'li muted' }, w.error ? 'Wallet not read yet' : 'No payments yet'),
    ),
    grow(),
  ]
}

function tabs() {
  const tab = (id, label, ic) => el('button', { 'aria-pressed': String(ui.tab === id), onclick: () => ((ui.tab = id), (ui.page = null), renderPhone(true)) }, icon(ic), label)
  return el('nav', { class: 'tabs', 'aria-label': 'Sections' }, tab('passbook', 'Passbook', 'book'), tab('wallet', 'Wallet', 'wallet'))
}

function sheet(kind) {
  const h = openPage()?.headroom
  const w = view.wallet ?? {}
  const lender = lenderName(view.waiting?.lender_pk)
  const body = {
    limit: () => [
      el('h3', { text: 'Your limit' }),
      ladderStrip(),
      el('p', { text: 'Each page paid on time moves you one step up.' }),
      el('div', { class: 'more' }, kv('Pages on time', String(view.pb?.ladder?.on_time ?? 0))),
    ],
    margin: () => [
      el('h3', { text: 'If bitcoin falls' }),
      el(
        'div',
        { class: 'more', style: 'font-size:15px' },
        kv('Now', dollars(price())),
        h ? kv('Margin call', `${dollars(h.margin_call_price_cents)} · −${Math.round(h.drop_to_margin_call_bps / 100)}%`) : null,
        h ? kv('Sale', `${dollars(h.liquidation_price_cents)} · −${Math.round(h.drop_to_liquidation_bps / 100)}%`) : null,
      ),
      el('p', { class: 'small', text: 'At a call you get 10 blocks to pay early.' }),
    ],
    reserve: () => [
      el('h3', { text: 'Reserved bitcoin' }),
      el('p', { text: 'Assets on Bitcoin sit on small amounts of bitcoin. It is still yours and comes back when you send the asset on.' }),
      el('div', { class: 'more', style: 'font-size:15px' }, kv('Holding your assets', satsText(w.reserve_sats ?? 0)), kv('For network fees', satsText(w.fee_btc_sats ?? 0))),
    ],
    share: () => [
      el('h3', { text: `What ${lender} sees` }),
      el('div', { class: 'ticks' }, el('div', { class: 'asset ok' }, icon('check', 'width:18px;height:18px'), 'The payments you tick'), el('div', { class: 'asset ok' }, icon('check', 'width:18px;height:18px'), 'A signed pass or fail from the private check'), el('div', { class: 'asset bad' }, icon('cross', 'width:18px;height:18px'), 'Not your balance or your history')),
    ],
    next: () => [
      el('h3', { text: 'What happens next' }),
      el('ol', {}, el('li', { text: `Your USDT goes to ${lender}.` }), el('li', { text: `${lender} signs and your bitcoin comes back.` }), el('li', { text: 'The page is stamped and your limit can rise.' })),
      el('p', { class: 'small', text: `If ${lender} doesn't sign, the platform does once your payment is proven.` }),
    ],
  }[kind]
  if (!body) return null
  return el('div', { class: 'sheet-wrap' }, el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, el('div', { class: 'grab' }), ...body(), btn('Got it', 'primary', closeSheet)))
}

const SCREENS = {
  home,
  borrow,
  stop1,
  stop2,
  stop3,
  sending,
  wallet: walletScr,
  stamped: () => pageScreen(lastClosed(), {}),
  page: () => {
    const p = pages().find((x) => x.loan_id === ui.page)
    return p ? pageScreen(p, { back: () => ((ui.page = null), renderPhone(true)) }) : home()
  },
}

let lastSig = ''
function renderPhone(force = false) {
  const name = screenName()
  const sig = JSON.stringify([name, view.pb, view.wallet, view.waiting, view.state?.height, flow.cur, flow.cycles.length])
  if (!force && sig === lastSig) return
  lastSig = sig
  const scr = el('div', { class: 'scr' }, ...SCREENS[name]())
  const kids = [scr]
  if (ui.error) kids.push(el('p', { class: 'banner bad', role: 'alert', text: ui.error }))
  // the screen's one button stays in reach whatever the details above it open to
  const cta = scr.querySelector(':scope > .cta')
  if (cta) kids.push(el('div', { class: 'foot' }, cta))
  if (!view.inspection && (name === 'home' || name === 'wallet')) kids.push(tabs())
  if (ui.sheet) kids.push(sheet(ui.sheet))
  $('phone').replaceChildren(...kids.filter(Boolean))
}

// ---- step panel ----

function renderSteps() {
  const ol = $('steps')
  if (view.inspection) {
    $('step-title').textContent = 'Recovered saved history'
    $('step-desc').textContent = 'Approvals and payments are paused. Automated agent resume is unavailable; keep the saved DB, state and wallets together.'
    $('next').disabled = true
    $('scenario').hidden = true
    $('hint').textContent = 'Inspect passbook receipts on the phone.'
    return
  }
  const list = steps()
  ol.replaceChildren(...list.map(([t], i) => el('li', { class: i + 1 < view.step ? 'done' : i + 1 === view.step ? 'now' : '', text: t })))
  const cur = list[view.step - 1]
  $('step-n').textContent = String(view.step)
  $('step-title').textContent = cur ? cur[0] : 'Not started'
  $('step-desc').textContent = cur ? cur[1] : 'Press Next to begin.'
  const w = view.waiting
  const isNext = w?.waiting === 'next'
  $('next').disabled = !isNext
  $('scenario').hidden = !(isNext && (w.scenarios ?? []).includes('lender-refuses'))
  $('hint').textContent = isNext
    ? `next: ${w.n}. ${w.title}${w.hint ? ` (${w.hint})` : ''}`
    : w?.waiting === 'confirm' && w.stop === 'fee'
      ? `waiting for ${lenderName(w.lender_pk)} to pay the platform fee (lender panel)`
      : w?.waiting === 'approve' || w?.waiting === 'confirm'
      ? 'waiting for the borrower on the phone'
      : w?.error
        ? `stopped: ${w.error}`
        : view.step >= list.length
          ? 'done'
          : 'running…'
}

$('platform-off').addEventListener('click', async () => { await post('/demo/platform-off'); $('platform-off').disabled = true; $('platform-off').textContent = 'Platform API off'; await refreshData() })

$('next').addEventListener('click', async () => {
  $('next').disabled = true
  await write('/demo/next')
})
$('scenario').addEventListener('click', async () => {
  $('next').disabled = true
  $('scenario').hidden = true
  await write('/demo/next', { scenario: 'lender-refuses' })
})

// ---- lender panel: the platform's share of the interest, owed after close ----

const OUTCOME_TEXT = { repaid_on_time: 'repaid on time', repaid_late: 'repaid late', liquidated: 'liquidated', split: 'split at maturity' }

async function refreshFees() {
  if (!view.demo || !Object.keys(view.lenders).length) return
  for (const pk of Object.keys(view.lenders)) {
    const r = await fetch(`/fees?lender=${pk}`).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    if (r) view.fees.set(pk, r)
  }
}

function renderFees() {
  const w = view.waiting
  const waitingFee = w?.waiting === 'confirm' && w.stop === 'fee' ? w : null
  const rows = []
  for (const [pk, r] of view.fees) {
    for (const f of r.fees ?? []) {
      const overdue = f.status === 'fee_due' && r.height > f.grace_until_height
      const asked = waitingFee && waitingFee.loan_id === f.loan_id
      rows.push(el('div', { class: `fee-row${overdue ? ' overdue' : ''}${f.status === 'fee_paid' ? ' paid' : ''}` },
        el('div', {}, el('span', { class: 'lender-name', text: lenderName(pk) }), ` · loan ${short(f.loan_id, 8)} · ${OUTCOME_TEXT[f.outcome] ?? f.outcome}`),
        // every figure is the platform's: interest is the terms' fee (termInterest), the fee its 15% share
        el('div', { class: 'figures', text: `Interest ${usdt(f.interest)} · platform fee ${usdt(f.amount)} (${f.share_bps / 100}%) · lender keeps ${usdt(f.interest - f.amount)}` }),
        el('div', { class: 'hint', text: f.status === 'fee_paid' ? `Paid over RGB${f.paid_txid ? ` in ${short(f.paid_txid, 12)}` : ''}; validated by the platform` : overdue ? `Overdue since block ${f.grace_until_height}: ${r.blocked ?? 'offers and new loans refused'}` : `Due; offers and new loans are refused after block ${f.grace_until_height} if unpaid` }),
        asked
          ? el('div', {}, el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => confirmStop('fee', true) }, `Pay ${usdt(f.amount)}`), el('button', { onclick: () => confirmStop('fee', false) }, 'Not now')), undo())
          : null,
      ))
    }
  }
  $('lender-fees').hidden = rows.length === 0 && !waitingFee
  $('fee-rows').replaceChildren(...rows)
}

// ---- negotiation and the lender's term-sheet approval ----

const NEG_ROLE = { borrower: 'Borrower agent', lender: 'Lender agent' }

function renderNegotiation() {
  $('negotiation').hidden = view.negotiation.length === 0
  $('neg-rows').replaceChildren(...view.negotiation.map((m) => el('li', { class: m.message === 'ACCEPT' ? 'accept' : '' },
    `${NEG_ROLE[m.role] ?? m.role} · ${m.message}`,
    m.apr_bps !== undefined ? ` · ${(m.apr_bps / 100).toFixed(2)}% APR · ${(m.ltv_bps / 100).toFixed(2)}% LTV` : '',
    el('span', { class: 'hash', text: `  ${short(m.hash, 10)}` }),
  )))
}

/** The lender's approval of exactly this term sheet; a second, distinct lender key above the maker-checker threshold. */
function renderApproval() {
  const w = view.waiting
  const asked = w?.waiting === 'confirm' && (w.stop === 'lender-approve' || w.stop === 'checker-approve') ? w : null
  $('lender-approval').hidden = !asked
  if (!asked) return $('approval-body').replaceChildren()
  const r = asked.render
  const checker = asked.stop === 'checker-approve'
  $('approval-body').replaceChildren(
    el('div', { class: 'approver', text: checker ? `Second approver (maker-checker above ${usdt(asked.threshold)}): key ${short(asked.approver_pk, 12)}` : `${lenderName(asked.lender_pk)}: key ${short(asked.approver_pk, 12)}` }),
    el('div', { class: 'sheet-title', text: r.title }),
    ...r.lines.map((line) => el('p', { class: 'small', text: line })),
    el('p', { class: 'small', text: r.settlement }),
    el('p', { class: 'small', text: r.scorer }),
    ...r.if_price_falls.map((line) => el('p', { class: 'small', text: line })),
    ...r.if_not_repaid.map((line) => el('p', { class: 'small', text: line })),
    el('div', { class: 'hash', text: `Term-sheet hash = the terms hash the lock commits: ${short(asked.loan_id, 16)}` }),
    el('p', { class: 'final', text: r.final }),
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => confirmStop(asked.stop, true) }, checker ? 'Approve as second approver' : 'Approve term sheet'), el('button', { onclick: () => confirmStop(asked.stop, false) }, 'Decline')),
    undo(),
  )
}

// ---- oracle panel ----

// money in BigInt, as on the server: debt in micro-USDT, collateral in sats, price in cents per BTC
const ltvBps = (debt, sats, price) => Number((BigInt(debt) * 100_000_000n) / (BigInt(sats) * BigInt(price)))
const priceAtLtv = (debt, sats, ltv) => Number((BigInt(debt) * 100_000_000n) / (BigInt(sats) * BigInt(ltv)))

async function openTerms() {
  if (!view.openLoan) return null
  if (!view.terms.has(view.openLoan)) view.terms.set(view.openLoan, (await fetch(`/loans/${view.openLoan}`).then((r) => r.json())).terms)
  return view.terms.get(view.openLoan)
}

async function renderRisk() {
  const t = await openTerms()
  $('margin').disabled = !t || view.inspection
  const risk = $('risk')
  if (!t || !view.price) {
    risk.className = 'hint'
    risk.textContent = 'No open loan to watch.'
    return
  }
  const debt = t.principal + t.fee
  const ltv = ltvBps(debt, t.collateral_sats, view.price)
  const state = ltv >= 8500 ? 'hard_stop' : ltv >= 8000 ? 'liquidatable' : ltv >= 7000 ? 'margin_call' : 'healthy'
  risk.className = `hint ${state}`
  risk.textContent = `open loan at ${(ltv / 100).toFixed(1)}% LTV (${state.replace('_', ' ')}); margin call below ${dollars(priceAtLtv(debt, t.collateral_sats, 7000))}, liquidation below ${dollars(priceAtLtv(debt, t.collateral_sats, 8000))}`
}

async function setPrice(cents) {
  $('price').disabled = true
  try {
    await write('/oracle/set', { price_cents: cents })
  } finally {
    $('price').disabled = false
  }
}

$('live-price').addEventListener('click', async () => {
  const res = await write('/oracle/live')
  if (!res.ok) $('oracle-status').textContent = (await res.json()).error
  else await refreshData()
})

$('price').addEventListener('input', () => ($('price-out').textContent = `$${Number($('price').value).toLocaleString('en-US')}`))
$('price').addEventListener('change', () => void setPrice(Number($('price').value) * 100))
$('margin').addEventListener('click', async () => {
  const t = await openTerms()
  if (!t) return
  // the price at which the open loan sits at 82% LTV: the platform raises the call, the lender may liquidate once the cure window runs out
  await setPrice(Number((BigInt(t.principal + t.fee) * 100_000_000n) / (BigInt(t.collateral_sats) * SCENARIO_LTV_BPS)))
})

function renderPills() {
  const s = view.state
  if (!s) return
  $('pills').replaceChildren(
    el('span', { class: 'pill' }, 'height ', el('b', { text: String(s.height) })),
    el('span', { class: 'pill' }, 'BTC ', el('b', { text: dollars(s.price_cents) })),
    el('span', { class: 'pill' }, 'chain ', el('b', { text: s.chain })),
    el('span', { class: 'pill' }, 'model ', el('b', { text: s.engine })),
    ...(view.aiStep ? [el('span', { class: 'pill' }, 'local AI ', el('b', { text: `${view.aiStep.tokens_per_second?.toFixed(1) ?? '?'} tok/s` }))] : []),
    el('span', { class: 'pill' }, 'relay ', el('b', { text: s.relays.length ? 'live' : 'off' })),
  )
}

// The API may start before wallet/model setup registers /demo. Read metadata
// again after demo events so an already-open page gets its lenders and panels.
function applyDemoMetadata(d) {
  view.atomicMode = !!d.atomic
  view.negotiate = d.negotiate !== false
  for (const proof of d.atomic_receipts ?? []) view.atomic.set(proof.loan_id, proof)
  view.demo = true
  view.inspection = d.mode === 'inspection'
  view.borrower = d.borrower_pk
  view.lenders = d.lenders ?? {}
  $('phone-h').textContent = d.persona ? `${d.persona[0].toUpperCase()}${d.persona.slice(1)}'s phone` : "Borrower's phone"
  $('investigator').hidden = !d.persona
  $('memo-form').hidden = !d.can_edit_memo
  view.comparisons = d.comparisons ?? []
  renderComparisons()
}

async function refreshData() {
  const stateResponse = await fetch('/state')
  const offline = stateResponse.status === 503
  const local = offline ? await fetch('/demo/local').then((r) => r.json()) : null
  view.state = offline ? local.state : await stateResponse.json()
  view.price = view.state.price_cents
  const quote = view.state.oracle
  if (quote) {
    const when = quote.observed_at === null ? '' : ` · observed ${new Date(quote.observed_at).toLocaleTimeString()} (${Math.round(quote.age_ms / 1000)}s ago)`
    const venues = (quote.sources ?? []).map((s) => s.name).join(', ')
    const usdt = quote.usdt_usd_ppm === null || quote.usdt_usd_ppm === undefined ? '' : ` · USDT ${(quote.usdt_usd_ppm / 1e6).toFixed(4)} USD${quote.usdt_peg_ok === false ? ' (OFF PEG: no new loans or liquidations)' : ''}`
    const label = quote.source === 'demo_override' ? 'DEMO OVERRIDE (latched)' : quote.source === 'live_median' ? `${quote.stale ? 'STALE · last good' : 'Live'} BTC/USDT index of ${quote.sources?.length ?? 0} venues (${venues})${usdt}` : 'Configured demo price'
    $('oracle-status').textContent = `${label}${when}${quote.last_error ? ` · feed error: ${quote.last_error}` : ''}`
    $('live-price').hidden = !quote.live_enabled || quote.source === 'live_median'
    $('live-price').disabled = view.inspection
    $('price').disabled = view.inspection
  }

  const runtime = view.demo ? await fetch('/demo').then((r) => r.json()) : null
  view.atomicMode = !!runtime?.atomic
  for (const proof of runtime?.atomic_receipts ?? []) view.atomic.set(proof.loan_id, proof)
  $('platform-off').hidden = !runtime?.can_disable_platform
  $('platform-off').disabled = offline
  $('platform-off').textContent = offline ? 'Platform API off' : 'Turn platform API off'
  $('price').disabled = offline || view.inspection
  if (offline) { $('margin').disabled = true; $('live-price').disabled = true; $('oracle-status').textContent = 'Platform API off · cached origination price' }
  view.openLoan = view.state.loans.find((l) => l.status === 'open')?.id ?? null
  if (document.activeElement !== $('price')) {
    const usd = Math.round(view.state.price_cents / 100)
    if (usd < Number($('price').min)) $('price').min = String(usd)
    if (usd > Number($('price').max)) $('price').max = String(usd)
    $('price').value = String(usd)
    $('price-out').textContent = `$${usd.toLocaleString('en-US')}`
  }
  if (!offline) await renderRisk()
  renderPills()
  if (view.demo) {
    const d = await fetch('/demo').then((r) => r.ok ? r.json() : null)
    if (d) applyDemoMetadata(d)
  }
  $('pair-show').disabled = !view.borrower || view.inspection
  if (view.borrower) {
    $('who').textContent = `borrower ${view.borrower}`
    view.pb = offline ? local.passbook : await fetch(`/passbook/${view.borrower}`).then((r) => r.json())
  }
  if (view.demo) view.wallet = await fetch('/demo/wallet').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (!offline) await refreshFees()
  renderFees()
  renderApproval()
  renderPrivateReasons()
  renderPhone()
}

// ---- wire ----

const KINDS = { agent: 'agents', ai_step: 'investigation', comparison: 'borrower comparison', model: 'model calls', policy: 'platform checks', loan: 'loan', risk: 'price and margin', sandbox: 'sandbox', offer: 'order book', income: 'income', fee: 'platform fees', step: 'steps', outcome: 'outcome' }
function renderFilters() {
  $('filters').replaceChildren(
    ...Object.entries(KINDS).map(([k, label]) => {
      const box = el('input', { type: 'checkbox' })
      box.checked = !view.hidden.has(k)
      box.addEventListener('change', () => {
        box.checked ? view.hidden.delete(k) : view.hidden.add(k)
        for (const li of document.querySelectorAll(`#wire li[data-kind="${k}"]`)) li.hidden = view.hidden.has(k)
      })
      return el('label', {}, box, label)
    }),
  )
}

function detailNode(d) {
  if (d == null) return null
  if (typeof d !== 'object') return el('div', { class: 'd', text: String(d) })
  const parts = Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
  return el('div', { class: 'd', text: parts.join(' · ') })
}

function wireItem(e) {
  const time = new Date(e.at).toLocaleTimeString()
  let kind = e.type
  let cls = ''
  let who = 'platform'
  let title = e.title ?? e.type
  let body = null
  switch (e.type) {
    case 'ai_step':
      view.aiStep = e
      renderPills()
      who = 'sandbox'
      title = `Investigation ${e.n}: ${e.tool}`
      body = detailNode({ arguments: e.argsSummary, milliseconds: e.ms, model: e.model, tokens_per_second: e.tokens_per_second?.toFixed(1) ?? 'unavailable' })
      $('ai-badge').textContent = `${e.model} · ${e.tokens_per_second?.toFixed(1) ?? '?'} tok/s`
      break
    case 'comparison':
      who = 'sandbox'
      title = `${e.persona}: ${e.mode} — ${e.passed ? 'passes' : 'declined'}`
      body = detailNode({ investigation: e.investigation?.status, verdict: e.investigation?.verdict, note: e.investigation?.lender_note })
      if (!view.comparisons) view.comparisons = []
      view.comparisons = view.comparisons.filter((r) => r.persona !== e.persona || r.mode !== e.mode).concat(e)
      renderComparisons()
      break
    case 'agent':
      who = e.role
      if (e.title.startsWith('model:')) {
        kind = 'model'
        cls = 'model'
        title = `${e.title.slice(7)} via ${e.detail?.engine} in ${e.detail?.ms} ms${e.detail?.fallback ? ` (fallback: ${e.detail.fallback})` : ''}`
      } else body = detailNode(e.detail)
      break
    case 'policy':
      cls = e.ok ? '' : 'fail'
      body = el('div', {}, ...(e.checks ?? []).map((c) => el('div', { class: `check ${c.ok ? 'y' : 'n'}`, text: c.detail })))
      break
    case 'sandbox':
      who = 'sandbox'
      title = 'Sandbox run: signed result left, raw bundle discarded'
      body = el('div', {}, ...e.checks.map((c) => el('div', { class: `check ${c.ok ? 'y' : 'n'}`, text: `${c.id}: ${c.detail}` })), el('div', { class: 'd', text: e.model_trace.map((t) => `${t.task} via ${t.engine} ${t.ms} ms`).join(' · ') }))
      break
    case 'loan':
      title = `Loan ${short(e.loan_id, 8)} ${e.status}${e.on_time !== undefined ? (e.on_time ? ' on time' : ' late') : ''}`
      // some loan events (the platform issuing a repayment invoice) carry no transaction
      body = el('div', { class: 'd' }, e.note ?? '', e.note && e.txid ? ' · ' : '', e.txid ? 'txid ' : '', e.txid ? el('code', { text: short(e.txid, 16) }) : null, e.txid && e.height !== undefined ? ` at ${e.height}` : '')
      break
    case 'offer':
      title = `Offer ${e.action} from ${short(e.lender_pk, 8)}`
      body = detailNode({ apr: `${e.payload.apr_bps / 100}%`, max: usdt(e.payload.max), ladder: e.payload.ltv_ladder_bps.map((b) => b / 100).join('/') })
      break
    case 'fee':
      title = e.title ?? `Platform fee ${e.status}`
      body = detailNode(e.status === 'fee_paid' ? { lender: short(e.lender_pk, 8), amount: usdt(e.amount), txid: short(e.txid, 16), height: e.height } : { lender: short(e.lender_pk, 8), interest: usdt(e.interest), fee: usdt(e.amount), share: `${e.share_bps / 100}%`, outcome: OUTCOME_TEXT[e.outcome] ?? e.outcome, grace_until: e.grace_until_height, note: e.note })
      break
    case 'income':
      who = 'payer'
      title = `Salary paid over RGB: ${usdt(e.amount)} at height ${e.height}`
      body = el('div', { class: 'd' }, 'txid ', el('code', { text: short(e.txid, 16) }), ' · signed by the payer')
      break
    case 'oracle':
      kind = 'risk'
      title = `${e.source === 'live_median' ? 'Live BTC/USDT index' : e.source === 'demo_override' ? 'Demo override' : 'Configured demo price'}: ${dollars(e.price_cents)}${e.stale ? ' (stale)' : ''}`
      break
    case 'margin_call':
      kind = 'risk'
      cls = 'risk'
      title = `Margin call on ${short(e.loan_id, 8)}: ${(e.ltv_bps / 100).toFixed(1)}% LTV at ${dollars(e.price_cents)}`
      body = el('div', { class: 'd', text: `${e.state.replace('_', ' ')} · cure until height ${e.cure_until_height} · borrower ${short(e.borrower_pk, 8)}` })
      break
    case 'margin_call_cleared':
      kind = 'risk'
      cls = 'risk cleared'
      title = `Margin call cleared on ${short(e.loan_id, 8)}: ${(e.ltv_bps / 100).toFixed(1)}% LTV`
      break
    case 'outcome':
      who = 'demo'
      cls = 'step'
      title = 'Outcome, read from the chain and the RGB wallets'
      body = el('dl', { class: 'outcome' }, ...e.rows.flatMap((r) => [el('dt', { text: r.who }), el('dd', { text: r.holds })]))
      break
    case 'step':
      cls = 'step'
      who = 'demo'
      title = `${e.n}. ${e.title}${e.scenario === 'lender-refuses' ? ' (scenario: lender refuses release)' : ''}`
      break
    default:
      body = detailNode(Object.fromEntries(Object.entries(e).filter(([k]) => !['type', 'at', 'seq'].includes(k))))
  }
  const li = el('li', { class: `ev ${who} ${cls}`, 'data-kind': kind }, el('div', { class: 'h' }, el('span', { class: 'who', text: who }), el('span', { class: 't', text: title }), el('span', { class: 'time', text: time })), body)
  li.hidden = view.hidden.has(kind)
  return li
}

let refreshTimer = null
function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void refreshData().catch(() => {}), 250)
}

function renderComparisons() {
  $('comparison-results').replaceChildren(...(view.comparisons ?? []).map((r) => el('p', {}, el('b', { text: `${r.persona} · ${r.mode}: ${r.passed ? 'passes' : 'declined'}` }), el('br'), r.investigation?.lender_note ?? '', el('br'), el('small', { text: `Investigation ${r.investigation?.status ?? 'not_run'}${r.investigation?.verdict ? ` · ${r.investigation.verdict}` : ''}` }))))
}

$('memo-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const response = await write('/demo/memo', { memo: $('judge-memo').value })
    const result = await response.json()
    $('memo-status').textContent = result.ok ? 'Queued for the AI run after the fixed baseline. The injection guard runs first.' : 'Editing is closed; restart the persona demo to try again.'
  } catch (error) { $('memo-status').textContent = error.message }
})

function onEvent(e) {
  if (view.seen.has(e.seq)) return
  view.seen.add(e.seq)
  if (e.type === 'device') void refreshDevices()
  if (!view.inspection) track(e)
  if (e.type === 'demo' && view.inspection) return
  if (e.type === 'negotiation') {
    if (!view.negotiation.some((m) => m.hash === e.hash)) view.negotiation.push(e)
    renderNegotiation()
    return
  }
  if (e.type === 'demo') {
    view.demo = true
    if (e.borrower_pk) view.borrower = e.borrower_pk
    if (e.scenario) view.scenario = e.scenario
    view.waiting = e.waiting ? e : e.error ? { waiting: null, error: e.error } : null
    renderSteps()
    renderFees()
    renderApproval()
    scheduleRefresh()
    renderPhone()
    return
  }
  if (e.type === 'step' && !view.inspection) {
    view.step = e.n
    renderSteps()
  }
  if (e.type === 'agent' && e.role === 'borrower' && !view.borrower) view.borrower = e.actor_pk
  $('wire').prepend(wireItem(e))
  if (['loan', 'step', 'oracle', 'policy', 'margin_call', 'margin_call_cleared', 'agent', 'atomic_repayment', 'fee'].includes(e.type)) scheduleRefresh()
  renderPhone()
}

// ---- pair a phone (apps/android): one-time code as a QR, paired devices, revoke ----

/** The node's QR rows ('1' = dark) drawn as one SVG path, with a 4-module quiet zone. */
function qrSvg(qr) {
  const s = document.createElementNS(NS, 'svg')
  const n = qr.size + 8
  s.setAttribute('viewBox', `0 0 ${n} ${n}`)
  s.setAttribute('width', '300')
  s.setAttribute('height', '300')
  s.setAttribute('role', 'img')
  s.setAttribute('aria-label', 'Pairing code for the Passbook Android app')
  s.setAttribute('shape-rendering', 'crispEdges')
  const bg = document.createElementNS(NS, 'rect')
  bg.setAttribute('width', String(n))
  bg.setAttribute('height', String(n))
  bg.setAttribute('fill', '#fff')
  const p = document.createElementNS(NS, 'path')
  let d = ''
  qr.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x + 4} ${y + 4}h1v1h-1z` })
  p.setAttribute('d', d)
  p.setAttribute('fill', '#000')
  s.append(bg, p)
  return s
}

async function showPairing() {
  $('pair-show').disabled = true
  try {
    const res = await write('/devices/pairing', { node: location.origin, scope: 'borrower', borrower_pk: view.borrower })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error ?? 'Could not make a pairing code')
    const port = location.port || (location.protocol === 'https:' ? '443' : '80')
    $('pair-code').replaceChildren(
      qrSvg(r.qr),
      el('p', { class: 'hint', text: `Scan with the Passbook app. Code expires at ${new Date(r.code_expires_at).toLocaleTimeString()}; the phone's key lasts ${Math.round(r.key_ttl_ms / 3_600_000)} h. USB: adb reverse tcp:${port} tcp:${port}` }),
      el('p', { class: 'hint', text: 'No camera? Over USB this opens the same code in the app (then tap Pair):' }),
      // Two quoting levels: the host shell strips the double quotes, the device shell keeps the single-quoted link whole (its & would otherwise split the command).
      el('code', { class: 'who', text: `adb shell "am start -a android.intent.action.VIEW -d '${r.link}'"` }),
    )
  } catch (error) {
    $('pair-code').replaceChildren(el('p', { class: 'hint', text: error.message }))
  } finally {
    $('pair-show').disabled = !view.borrower
  }
}

async function refreshDevices() {
  const r = await fetch('/devices').then((x) => (x.ok ? x.json() : null)).catch(() => null)
  if (!r) return
  // a phone that just paired used its code: take the QR down
  if (r.devices.some((d) => d.state === 'active' && Date.now() - d.paired_at < 10_000)) $('pair-code').replaceChildren()
  $('pair-devices').replaceChildren(...r.devices.map((d) => el('li', {},
    `${d.label} · ${d.scope} · ${d.state} · key ${short(d.pubkey, 12)} · expires ${new Date(d.expires_at).toLocaleTimeString()} `,
    d.state === 'active' ? el('button', { onclick: async () => { await write(`/devices/${d.id}/revoke`); await refreshDevices() } }, 'Revoke') : null,
  )))
}

$('pair-show').addEventListener('click', () => void showPairing())

async function start() {
  void refreshDevices()
  renderFilters()
  renderSteps()
  try {
    const d = await fetch('/demo').then((r) => (r.ok ? r.json() : null))
    if (d) {
      applyDemoMetadata(d)
      view.waiting = d.waiting?.waiting ? d.waiting : null
      view.step = d.step
      if (d.scenario) view.scenario = d.scenario
      renderSteps()
    }
  } catch {}
  await refreshData().catch(() => {})
  renderPhone(true)
  const es = new EventSource('/events')
  es.onmessage = (m) => onEvent(JSON.parse(m.data))
  setInterval(() => void refreshData().catch(() => {}), 5000)
}

start()

function renderPrivateReasons() {
  const box = $('borrower-reasons'), reasons = view.wallet?.private_reasons
  box.hidden = !reasons
  if (!reasons) return
  box.replaceChildren(el('h3', { text: 'Your income checks' }), el('p', { class: 'who', text: `Private wallet view · history ${reasons.history_assurance}. Lenders receive signed checks and income bands.` }), ...reasons.rows.map((row) => el('div', { class: 'reason-row' }, el('b', { text: row.label }), row.value_bps === null ? el('small', { text: 'Unknown' }) : el('meter', { min: '0', max: '100', value: String(row.value_bps / 100), 'aria-label': row.label }), el('small', { text: row.detail }))), el('p', { class: 'who', text: reasons.basis }))
}
