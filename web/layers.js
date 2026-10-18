// Panel: "RGB + Bitcoin mainnet + Lightning: on-chain recomputed by the lender".
// Self-contained (served at /demo/layers.js by src/server/layers.ts). The
// person makes a fresh address in their own wallet, signs the challenge there
// and pastes only the signature; this page never asks for a key or a seed.
// Every number shown comes from deterministic code and names its trust mode.

import { readSession, signedPost } from '/session-auth.js'

const session = readSession()
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const short = (h, n = 12) => (h && h.length > n + 2 ? `${h.slice(0, n)}…` : h ?? '')

const css = `
.layers { border-top: 1px solid var(--line); margin-top: 14px; }
.layers .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
.layers input[type=text], .layers textarea { flex: 1 1 260px; min-width: 0; font-family: var(--mono); font-size: .8rem; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); }
.layers textarea { width: 100%; min-height: 3.2rem; resize: vertical; }
.layers pre.challenge { white-space: pre-wrap; word-break: break-all; background: var(--soft); padding: 8px; border-radius: 6px; font-size: .78rem; margin: 6px 0; }
.layers .layer { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.layers .layer h4 { margin: 0 0 4px; font-size: .9rem; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.layers .tm { font-size: .72rem; padding: 1px 6px; border-radius: 999px; background: var(--soft); color: var(--muted); font-weight: 500; }
.layers .ok { color: var(--ok); } .layers .bad { color: var(--bad); } .layers .warn { color: var(--warn); }
.layers table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.layers td, .layers th { text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
.layers .mono { font-family: var(--mono); font-size: .75rem; word-break: break-all; }
.layers .outcome { font-weight: 600; margin: 8px 0 2px; }
.layers summary { cursor: pointer; margin: 8px 0 4px; }
`

function mount() {
  const host = $('layers')
  if (!host) return null
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  host.innerHTML = `
    <details id="layers-details"><summary><h3 id="layers-h" style="display:inline">RGB + Bitcoin mainnet + Lightning: on-chain recomputed by the lender</h3></summary>
    <p class="hint">Proofs only. Make a <strong>fresh</strong> address in your own wallet (bc1q… or bc1p…), sign the challenge there with BIP-322, paste the signature. Never paste a private key or seed. Mainnet is read, never spent; loans stay on <span id="layers-loan-chain">regtest</span>.</p>
    <p class="hint" id="layers-sources"></p>
    <div class="row">
      <label for="layers-address" class="hint">Address</label>
      <input type="text" id="layers-address" autocomplete="off" spellcheck="false" placeholder="bc1q… or bc1p…">
      <button id="layers-challenge">Get challenge</button>
    </div>
    <div id="layers-challenge-box" hidden>
      <p class="hint">Sign exactly this message with that address in your wallet:</p>
      <pre class="challenge" id="layers-challenge-text"></pre>
      <div class="row"><button id="layers-copy">Copy message</button><span class="hint" id="layers-expiry"></span></div>
      <label for="layers-signature" class="hint">BIP-322 signature</label>
      <textarea id="layers-signature" autocomplete="off" spellcheck="false" placeholder="paste the signature (smp… or base64)"></textarea>
    </div>
    <div class="row">
      <button id="layers-run" class="primary">Run the agent check</button>
      <label class="hint"><input type="checkbox" id="layers-offline"> offline: recorded mainnet data</label>
      <span class="hint" id="layers-status" role="status"></span>
    </div>
    <div id="layers-result" aria-live="polite"></div></details>`
  return host
}

function renderLayer(l) {
  const control = l.control.length
    ? l.control.map((v) => `<div>${v.ok ? '<span class="ok">control proven</span>' : `<span class="bad">control failed</span> <span class="hint">${esc(v.reasons.join(', '))}</span>`} <span class="mono">${esc(short(v.subject, 18))}</span> <span class="hint">(${esc(v.format)})</span></div>`).join('')
    : '<div class="hint">control not proven</div>'
  const rc = l.recompute
  const recompute = rc
    ? rc.ok
      ? `<div class="ok">lender recomputed from its own source (${esc(rc.source)}), all ${rc.matched} rows match</div>`
      : `<div class="bad">lender recompute differs</div>${rc.tampered.map((t) => `<div class="mono">${esc(short(t.txid, 16))} ${esc(t.field)}: borrower ${esc(t.claimed)}, lender ${esc(t.recomputed)}</div>`).join('')}${rc.missing.map((t) => `<div class="mono">${esc(short(t, 16))} found by the lender, not sent</div>`).join('')}${rc.unknown.map((t) => `<div class="mono">${esc(short(t, 16))} unknown to the lender's source</div>`).join('')}`
    : ''
  const sources = [l.source && `device: ${esc(l.source)}${l.height !== null && l.height !== undefined ? ` at block ${l.height}` : ''}`, l.lender_source && `lender: ${esc(l.lender_source)}`].filter(Boolean).join(' · ')
  return `<div class="layer"><h4>${esc(l.layer)} ${l.trust_mode ? `<span class="tm">${esc(l.trust_mode)}</span>` : ''}</h4>${control}${recompute}${sources ? `<div class="hint">${sources}</div>` : ''}${l.limits.length ? `<div class="hint">limits: ${esc(l.limits.join('; '))}</div>` : ''}</div>`
}

function render(r) {
  const out = $('layers-result')
  if (!r) { out.innerHTML = ''; return }
  const f = r.features
  const features = f ? `<table><thead><tr><th>layer</th><th>feature</th><th>band</th><th>trust mode</th></tr></thead><tbody>${f.features.map((x) => `<tr><td>${esc(x.layer)}</td><td>${esc(x.name.replaceAll('_', ' '))}</td><td>${esc(x.value)}</td><td><span class="tm">${esc(x.trust_mode)}</span></td></tr>`).join('')}</tbody></table>
    <p class="hint">${f.typologies.map((t) => `${esc(t.type)}: ${t.matched ? `<span class="${t.disposition === 'block' ? 'bad' : 'warn'}">${esc(t.disposition)}</span>` : 'clear'}`).join(' · ')} · sanctions ${esc(f.sanctions.status)} (${esc(f.sanctions.screen)}; lists ${esc(f.sanctions.list_version)}; ${f.sanctions.screened.proven} proven, ${f.sanctions.screened.counterparties} counterparties)${f.sanctions.hits.map((h) => ` · <span class="bad">hit hop ${h.hop} ${esc(short(h.address, 16))}</span>`).join('')}</p>` : ''
  const n = r.negotiation
  out.innerHTML = `
    ${r.awaiting_signature?.length ? '<p class="warn">Waiting for the BIP-322 signature from your own wallet.</p>' : ''}
    ${r.layers.map(renderLayer).join('')}
    ${r.lightning?.public_facts ? `<p class="hint">Lightning public facts from ${esc(r.lightning.public_facts.source)}</p>` : ''}
    ${features}
    <p class="outcome ${n.outcome === 'DEAL' ? 'ok' : 'bad'}">${esc(n.outcome)}${n.outcome === 'DEAL' ? ` · LTV bonus ${n.ltv_bonus_bps} bps, bounded and clamped to the platform limit` : ''}</p>
    ${n.reasons.map((x) => `<div class="hint">${esc(x)}</div>`).join('')}
    ${(n.layers ?? []).filter((l) => l.status === 'failed').map((l) => `<div class="hint">${esc(l.layer)} adds nothing: ${esc(l.why.join('; '))}</div>`).join('')}
    <p class="hint">${esc(r.decided_by)} · ${r.source_calls.length} source calls logged with endpoint and block height · result ${esc(short(r.result_hash, 16))}</p>`
}

async function refresh() {
  const s = await fetch('/demo/layers').then((x) => (x.ok ? x.json() : null)).catch(() => null)
  const host = $('layers')
  if (!s || !host) return
  host.hidden = false
  $('layers-loan-chain').textContent = s.loan_chain
  $('layers-sources').textContent = `History chain ${s.history_chain} (read only), last ${s.window_days} days. Borrower device reads ${s.sources.device ?? 'none'}; the lender recomputes from its own ${s.sources.lender ?? 'none'}${s.sources.recorded ? `; offline: ${s.sources.recorded}` : ''}. Lightning: ${s.lightning ?? 'no node on this device'}.`
  if (s.challenge) showChallenge(s.challenge)
  if (s.address && !$('layers-address').value) $('layers-address').value = s.address
  render(s.last)
  if (s.last || s.challenge) $('layers-details').open = true
}

function showChallenge(c) {
  $('layers-challenge-box').hidden = false
  $('layers-challenge-text').textContent = c.text
  $('layers-expiry').textContent = `expires ${new Date(c.expires_at * 1000).toLocaleString()}`
}

async function post(path, body) {
  const res = await signedPost(session, path, body)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

if (mount()) {
  $('layers-challenge').addEventListener('click', async () => {
    $('layers-status').textContent = ''
    try { showChallenge((await post('/demo/layers/challenge', { address: $('layers-address').value.trim() })).challenge) } catch (e) { $('layers-status').textContent = e.message }
  })
  $('layers-copy').addEventListener('click', () => navigator.clipboard?.writeText($('layers-challenge-text').textContent))
  $('layers-run').addEventListener('click', async () => {
    $('layers-status').textContent = 'checking: device reads, lender recomputes…'
    $('layers-run').disabled = true
    try {
      const r = await post('/demo/layers/check', { signature: $('layers-signature')?.value.trim() ?? '', offline: $('layers-offline').checked })
      render(r)
      $('layers-status').textContent = ''
    } catch (e) { $('layers-status').textContent = e.message } finally { $('layers-run').disabled = false }
  })
  refresh()
}
