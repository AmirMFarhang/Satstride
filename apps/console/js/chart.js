// Hand-written SVG: a cumulative stacked step-area chart with a crosshair
// tooltip. Step-after interpolation, because cumulative revenue moves in
// jumps at each hourly bucket and stays flat between them.

import { esc, fmtUnits, fmtCompactUnits, tickerOf, fmtHour, fmtDay } from './format.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const H = 260
const M = { top: 28, right: 16, bottom: 30, left: 52 }

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw))
  const f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
}

function timeTicks(t0, t1, maxTicks) {
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]
  const span = Math.max(t1 - t0, HOUR)
  const step = steps.find((s) => span / s <= maxTicks) ?? steps[steps.length - 1]
  const offset = new Date().getTimezoneOffset() * 60_000 // align ticks to local hours/midnights
  const first = Math.ceil((t0 - offset) / step) * step + offset
  const out = []
  for (let t = first; t <= t1; t += step) out.push(t)
  return { ticks: out, step }
}

/**
 * model: { layers: [{ key, label, color }], points: [{ t, inc: {key: micro}, cum: {key: micro} }], asset }
 * points are real buckets, oldest first; `start`/`end` add the zero start and the flat run to now.
 */
export function drawStackedArea(host, model) {
  const W = Math.max(280, Math.floor(host.clientWidth))
  const sig = `${W}|${JSON.stringify(model.points)}`
  if (host._sig === sig) { host._model = model; return }
  host._sig = sig
  host._model = model

  const { layers, points } = model
  const t0 = points[0].t - HOUR
  const tEnd = Math.max(points[points.length - 1].t + HOUR, Math.min(model.now ?? Date.now(), points[points.length - 1].t + 30 * DAY))
  const totalOf = (p) => layers.reduce((s, l) => s + (p.cum[l.key] ?? 0), 0)
  const maxMicro = Math.max(1, ...points.map(totalOf))
  const maxUnits = maxMicro / 1e6
  const yStep = niceStep(maxUnits / 4)
  const yMax = Math.ceil(maxUnits / yStep) * yStep || yStep
  const iw = W - M.left - M.right
  const ih = H - M.top - M.bottom
  const x = (t) => M.left + ((t - t0) / (tEnd - t0)) * iw
  const y = (micro) => M.top + ih - (micro / 1e6 / yMax) * ih

  // stacked tops per layer at each real point
  const stacks = points.map((p) => {
    let acc = 0
    return layers.map((l) => (acc += p.cum[l.key] ?? 0))
  })

  const stepPath = (vals) => {
    // starts at zero, steps at each bucket, runs flat to the end
    let d = `M${x(t0).toFixed(1)},${y(0).toFixed(1)}`
    let prev = 0
    points.forEach((p, i) => {
      const xi = x(p.t).toFixed(1)
      d += `H${xi}V${y(vals[i] ?? prev).toFixed(1)}`
      prev = vals[i]
    })
    d += `H${x(tEnd).toFixed(1)}`
    return d
  }
  const areaPath = (top, bottom) => {
    const up = stepPath(top)
    // walk back along the bottom edge
    let back = `V${y(bottom[bottom.length - 1] ?? 0).toFixed(1)}`
    for (let i = points.length - 1; i >= 0; i--) {
      const xi = x(points[i].t).toFixed(1)
      back += `H${xi}V${y(i > 0 ? bottom[i - 1] : 0).toFixed(1)}`
    }
    back += `H${x(t0).toFixed(1)}Z`
    return up + back
  }

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative revenue by stream over time">`
  // y grid
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    const yy = Math.round(y(v * 1e6)) + 0.5
    svg += `<line class="${v === 0 ? 'axis-line' : 'grid-line'}" x1="${M.left}" x2="${W - M.right}" y1="${yy}" y2="${yy}"/>`
    svg += `<text x="${M.left - 8}" y="${yy + 4}" text-anchor="end">${esc(fmtCompactUnits(v))}</text>`
  }
  svg += `<text x="${M.left - 8}" y="12" text-anchor="end" style="font-weight:600">${esc(tickerOf(model.asset))}</text>`
  // x ticks
  const { ticks, step } = timeTicks(t0, tEnd, Math.max(2, Math.floor(iw / 96)))
  let lastDay = ''
  for (const t of ticks) {
    const xx = Math.round(x(t)) + 0.5
    const day = fmtDay(t)
    const lbl = step >= DAY ? day : day !== lastDay ? `${day} ${fmtHour(t)}` : fmtHour(t)
    lastDay = day
    svg += `<line class="grid-line" x1="${xx}" x2="${xx}" y1="${y(0)}" y2="${y(0) + 4}"/>`
    svg += `<text x="${xx}" y="${H - 10}" text-anchor="middle">${esc(lbl)}</text>`
  }
  // layers, bottom first
  layers.forEach((l, li) => {
    const top = stacks.map((s) => s[li])
    const bottom = stacks.map((s) => (li > 0 ? s[li - 1] : 0))
    svg += `<path d="${areaPath(top, bottom)}" style="fill:var(${l.color});fill-opacity:.16;stroke:none"/>`
  })
  layers.forEach((l, li) => {
    const top = stacks.map((s) => s[li])
    svg += `<path d="${stepPath(top)}" style="fill:none;stroke:var(${l.color});stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>`
  })
  // hover layer
  svg += `<g class="hover" visibility="hidden"><line class="crosshair" y1="${M.top}" y2="${y(0)}"/>${layers.map((l) => `<circle r="4" style="fill:var(${l.color});stroke:var(--surface);stroke-width:2"/>`).join('')}</g>`
  svg += `<rect class="hit" x="${M.left}" y="${M.top}" width="${iw}" height="${ih}" fill="transparent"/>`
  svg += '</svg>'
  host.innerHTML = `${svg}<div class="chart-tip" hidden></div>`

  const svgEl = host.querySelector('svg')
  const hover = svgEl.querySelector('.hover')
  const cross = hover.querySelector('line')
  const dots = [...hover.querySelectorAll('circle')]
  const tip = host.querySelector('.chart-tip')
  const hit = svgEl.querySelector('.hit')

  const show = (clientX) => {
    const m = host._model
    const r = svgEl.getBoundingClientRect()
    const px = clientX - r.left
    let best = 0
    let bestD = Infinity
    points.forEach((p, i) => {
      const dd = Math.abs(x(p.t) - px)
      if (dd < bestD) { bestD = dd; best = i }
    })
    const p = points[best]
    const xx = x(p.t)
    cross.setAttribute('x1', xx)
    cross.setAttribute('x2', xx)
    dots.forEach((c, li) => { c.setAttribute('cx', xx); c.setAttribute('cy', y(stacks[best][li])) })
    hover.setAttribute('visibility', 'visible')
    const total = totalOf(p)
    const inc = layers.reduce((s, l) => s + (p.inc[l.key] ?? 0), 0)
    tip.innerHTML = `<div class="chart-tip-title">${esc(fmtDay(p.t))}, ${esc(fmtHour(p.t))}–${esc(fmtHour(p.t + HOUR))}</div>
      ${[...layers].reverse().map((l) => `<div class="chart-tip-row"><span class="swatch" style="--swatch:var(${l.color})"></span><span>${esc(l.label)}</span><span class="amt">${esc(fmtUnits(p.cum[l.key] ?? 0))}</span></div>`).join('')}
      <div class="chart-tip-row total"><span></span><span>All earned</span><span class="amt">${esc(fmtUnits(total))} ${esc(tickerOf(m.asset))}</span></div>
      <div class="small muted" style="margin-top:4px">+${esc(fmtUnits(inc))} in this hour</div>`
    tip.hidden = false
    const tw = tip.offsetWidth
    const left = xx + 14 + tw > W ? xx - 14 - tw : xx + 14
    tip.style.left = `${Math.max(0, left)}px`
    tip.style.top = `${M.top}px`
  }
  const hide = () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true }
  hit.addEventListener('pointermove', (e) => show(e.clientX))
  hit.addEventListener('pointerdown', (e) => show(e.clientX))
  hit.addEventListener('pointerleave', hide)
}
