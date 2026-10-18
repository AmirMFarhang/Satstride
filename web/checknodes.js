// Panel: "Check nodes: a role anyone can run" (Add-on 5, docs/CHECK-MARKET.md).
// Self-contained (served at /demo/checknodes.js by src/server/checknodes.ts).
// Read-only. Every tier shown is the one the verifier derives from evidence;
// a node without a valid attestation shows "no TEE: software evidence"
// whatever it declares. Fallbacks are labelled where they appear.

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const short = (h, n = 12) => (h && h.length > n + 2 ? `${h.slice(0, n)}…` : h ?? '')
const usdt = (micro) => (Number(micro) / 1e6).toFixed(2)

const css = `
.checknodes { border-top: 1px solid var(--line); margin-top: 14px; }
.checknodes table { width: 100%; border-collapse: collapse; font-size: .8rem; }
.checknodes td, .checknodes th { text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
.checknodes .mono { font-family: var(--mono); font-size: .75rem; word-break: break-all; }
.checknodes .tm { font-size: .72rem; padding: 1px 6px; border-radius: 999px; background: var(--soft); color: var(--muted); font-weight: 500; white-space: nowrap; }
.checknodes .ok { color: var(--ok); } .checknodes .bad { color: var(--bad); } .checknodes .warn { color: var(--warn); }
.checknodes .picked { outline: 2px solid var(--ok); outline-offset: -2px; }
.checknodes ul { margin: 4px 0 4px 18px; padding: 0; font-size: .8rem; }
.checknodes summary { cursor: pointer; margin: 8px 0 4px; }
.checknodes .scroll { overflow-x: auto; }
.checknodes table.kv { table-layout: fixed; }
.checknodes table.kv th { width: 9rem; }
.checknodes table.kv td { word-break: break-all; }
`

function nodeRows(nodes, pickedPk) {
  return nodes.map((n) => `
    <tr class="${n.operator_pk === pickedPk ? 'picked' : ''}">
      <td><span class="mono">${esc(short(n.operator_pk, 16))}</span><br><span class="tm">${esc(n.operator_key)}</span>${n.operator_pk === pickedPk ? '<br><strong class="ok">picked</strong>' : ''}</td>
      <td><span class="mono">${esc(short(n.release_hash, 16))}</span><br><span class="tm">${esc(n.release?.provider)}</span> <span class="tm">${esc(short(n.release?.image_digest, 18))}</span></td>
      <td>${esc(n.scorer_label)}${n.scorer_fallback ? ' <span class="tm warn">FALLBACK</span>' : ''}</td>
      <td><strong>${esc(n.execution?.label)}</strong>${n.execution?.declared && n.execution.declared !== 'none' ? `<br><span class="tm warn">declared ${esc(n.execution.declared)}, not attested</span>` : ''}</td>
      <td>${esc(usdt(n.price?.amount))} test USDT</td>
      <td>${(n.accepted_assets ?? []).map((a) => `<span class="tm">${esc(a.ticker)} ${a.kind === 'voucher' ? '(voucher, 1 = 1 check)' : ''}</span>`).join(' ')}</td>
      <td>${(n.rails ?? []).map((r) => `<span class="tm ${/FALLBACK/.test(r.label) ? 'warn' : ''}">${esc(r.label)}</span>`).join('<br>')}</td>
      <td><span class="tm">${esc(n.bond)}</span></td>
      <td>${esc(n.p50_seconds)} s</td>
    </tr>`).join('')
}

function render(data) {
  const host = $('checknodes-body')
  const rec = data.record
  const liveNodes = (data.live ?? []).filter((l) => l.status).map((l) => l.status)
  const nodes = liveNodes.length ? liveNodes : rec?.nodes ?? []
  const pickedPk = rec?.pick?.operator_pk ?? null
  const down = (data.live ?? []).filter((l) => l.error)
  if (!nodes.length) {
    host.innerHTML = '<p class="hint">No check node is running and no market run is recorded. Start the stack with <code>infra/check-market.sh start</code>, then run <code>npm run test:regtest -- test/regtest/check-market.test.ts</code> or <code>passbook check-node serve</code>.</p>'
    return
  }
  const paid = rec?.paid
  const lender = rec?.lender
  host.innerHTML = `
    <p class="hint">${nodes.length} competing providers; none is special, ours included. The platform takes no cut of check fees. ${liveNodes.length ? 'Live status from the running nodes.' : data.record_source === 'recorded-evidence' ? `<strong>Recorded</strong> regtest run of ${esc(rec?.at)} (docs/CHECK-MARKET-REGTEST.json); no node is running now.` : `From the last local run (${esc(rec?.at)}).`}${down.length ? ` <span class="warn">${down.length} node status endpoint(s) unreachable.</span>` : ''}</p>
    <div class="scroll"><table>
      <thead><tr><th>Operator key</th><th>Release</th><th>Scorer</th><th>Execution tier (derived)</th><th>Price</th><th>Accepted assets</th><th>Rails</th><th>Bond</th><th>p50</th></tr></thead>
      <tbody>${nodeRows(nodes, pickedPk)}</tbody>
    </table></div>
    ${rec ? `
      <h4>Picked by policy: ${pickedPk ? `<span class="mono">${esc(short(pickedPk, 16))}</span>` : '<span class="bad">none</span>'}</h4>
      <ul>${(rec.pick?.why ?? []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      <p class="hint">Order: the lender's accepted operators and releases, min trust and min execution, max price; then cheapest, then fastest, then the operator key.</p>
      ${paid ? `
        <h4>Paid check</h4>
        <table class="kv">
          <tr><th>Rail</th><td><span class="tm ${/FALLBACK/.test(paid.rail_label) ? 'warn' : 'ok'}">${esc(paid.rail_label)}</span></td></tr>
          <tr><th>Paid</th><td>${esc(usdt(paid.amount))} test USDT over RGB Lightning (regtest)</td></tr>
          <tr><th>Payment hash</th><td class="mono">${esc(paid.payment_hash)}</td></tr>
          <tr><th>K came from</th><td>${paid.key_source === 'lightning-preimage' ? 'the payment preimage: paying revealed K' : '<span class="warn">the operator, after payment (FALLBACK: pay, then deliver; trusts the node)</span>'}</td></tr>
          <tr><th>Commitment</th><td class="mono">sha256(plaintext) = ${esc(paid.commitment)}</td></tr>
          <tr><th>Release</th><td class="mono">${esc(paid.release_hash)}</td></tr>
          ${rec.receipt ? `<tr><th>Receipt (RGB UDA)</th><td class="mono">${esc(rec.receipt.contract_id ?? '')} <span class="tm">${esc(rec.receipt.status)}</span></td></tr>` : ''}
        </table>` : ''}
      ${lender ? `
        <details><summary>Lender verified it without trusting the borrower: <strong class="${lender.ok ? 'ok' : 'bad'}">${lender.ok ? 'verified' : 'refused'}</strong> · ${esc(lender.execution)} · scorer trust ${esc(lender.scorer_trust ?? 'none')}</summary>
          <ul>${lender.ticks.map((t) => `<li class="${t.ok ? 'ok' : 'bad'}">${t.ok ? '✓' : '✗'} ${esc(t.id)}: ${esc(t.detail)}</li>`).join('')}</ul>
        </details>` : ''}
      ${rec.voucher ? `
        <h4>Voucher ${esc(rec.voucher.name)} (1 unit = 1 check)</h4>
        <ul>
          <li>Issued ${esc(rec.voucher.issued)} by the node; ${esc(rec.voucher.lender_received)} to the lender; ${esc(rec.voucher.borrower_received)} from the lender to the borrower.</li>
          ${rec.voucher.first_attempt?.outcome === 'refused' ? `<li class="warn">First attempt refused before K was revealed: ${esc(rec.voucher.first_attempt.node_reason)}</li>` : ''}
          <li class="${rec.voucher.paid ? 'ok' : 'bad'}">${rec.voucher.paid ? `Redeemed over RGB Lightning (HODL): K from the payment preimage; lender ${rec.voucher.lender_verified ? 'verified' : 'did not verify'}.` : `Not redeemed${rec.voucher.error ? `: ${esc(rec.voucher.error)}` : ''}.`}</li>
        </ul>` : ''}
      ${rec.finding ? `<p class="hint">Finding: ${esc(rec.finding)}</p>` : ''}
      ${rec.asset_source ? `<p class="hint">Asset: ${esc(rec.asset_source)}.</p>` : ''}
    ` : ''}
    <p class="hint">Built: offers, deterministic pick, sealed result, HODL payment, K forwarding, lender verification, TEE verifier with refusal fixtures, 2-of-N agreement, receipts (UDA) and vouchers (NIA). Designed, not built: the operator bond, real Nitro attestation.</p>`
}

async function refresh() {
  try {
    const res = await fetch('/demo/checknodes', { cache: 'no-store' })
    if (res.ok) render(await res.json())
  } catch { /* the demo server is restarting: keep the last view */ }
}

function mount() {
  const host = $('checknodes')
  if (!host) return
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  host.innerHTML = `<details id="checknodes-details" open><summary><h3 id="checknodes-h" style="display:inline">Check nodes: a role anyone can run</h3></summary><div id="checknodes-body" aria-live="polite"><p class="hint">loading…</p></div></details>`
  host.hidden = false
  refresh()
  setInterval(refresh, 10_000)
}

mount()
