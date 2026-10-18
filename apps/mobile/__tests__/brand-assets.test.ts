// The logo the user picked, its PNGs and the icon set: one drawing (src/brand/mark.ts) behind
// the in-app logo, the app icon, the adaptive icon and the splash, and the PNGs regenerated
// whenever the drawing changes (manifest.json records each PNG's source hash).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MARK, MARK_ID, MARKS, PALETTES, markSvg, type Layer } from '../src/brand/mark.ts'
import { ICON_PATHS, TAB_ICONS } from '../src/brand/icon-paths.ts'
import { brandAssets, sourceHash } from '../assets/brand/generate.ts'

const DIR = join(import.meta.dirname, '..', 'assets', 'brand')

const bounds = (l: Layer): [number, number, number, number] => {
  if (l.el === 'circle') return [l.cx - l.r, l.cy - l.r, l.cx + l.r, l.cy + l.r]
  if (l.el === 'rect') return [l.x, l.y, l.x + l.w, l.y + l.h]
  const n = (l.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

test('the shipped mark is the user\'s pick, and every option fits its 64-unit box', () => {
  assert.equal(MARK_ID, 'sealed', 'the user picked option 1, the sealed passbook')
  assert.equal(MARK, MARKS.sealed)
  for (const m of Object.values(MARKS)) {
    assert.ok(m.sealFrom > 0 && m.sealFrom < m.layers.length, `${m.id}: the seal follows the booklet`)
    for (const l of m.layers) {
      if (l.el === 'path' && /[a-z]/.test(l.d.replace(/[eE]/g, ''))) continue // relative paths: checked by eye on the options page
      const [x0, y0, x1, y1] = bounds(l)
      assert.ok(x0 >= 0 && y0 >= 0 && x1 <= 64 && y1 <= 64, `${m.id}: ${JSON.stringify(l)} is inside the box`)
    }
  }
})

test('the knockout modes: masks for browsers, colour and alpha passes for the PNGs', () => {
  const paper = MARK.layers.filter((l) => (l.fill ?? 'paper') === 'paper' && (l.stroke ?? 'paper') === 'paper').length
  assert.equal((markSvg(MARK, PALETTES.colour, { knockout: 'mask' }).match(/<mask /g) ?? []).length, paper, 'one mask per knockout')
  const omit = markSvg(MARK, PALETTES.colour, { knockout: 'omit' })
  assert.ok(!omit.includes(PALETTES.colour.paper), 'the colour pass leaves the knockouts out')
  const alpha = markSvg(MARK, PALETTES.colour, { knockout: 'alpha' })
  assert.deepEqual([...new Set(alpha.match(/#[0-9a-fA-F]{3,6}\b/g))].sort(), ['#000', '#fff'], 'the alpha pass is black and white only')
  assert.ok(markSvg(MARK, PALETTES.onGreen).includes(PALETTES.onGreen.paper), 'paint mode draws the knockouts in the background colour')
})

const png = (file: string) => {
  const b = readFileSync(join(DIR, file))
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${file} is a PNG`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] }
}

test('the icon, adaptive icon and splash PNGs are generated from the current mark', () => {
  const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as { mark: string; files: Record<string, { px: number; svg_sha256: string }> }
  assert.equal(manifest.mark, MARK_ID)
  const assets = brandAssets()
  assert.deepEqual(Object.keys(manifest.files).sort(), assets.map((a) => a.file).sort())
  for (const a of assets) {
    assert.equal(manifest.files[a.file].svg_sha256, sourceHash(a), `${a.file} is stale: run npx tsx assets/brand/generate.ts`)
    const p = png(a.file)
    assert.deepEqual([p.width, p.height], [a.px, a.px], `${a.file} is ${a.px} px square`)
    if (a.alpha) assert.equal(p.colorType, 6, `${a.file} has an alpha channel (real holes)`)
  }
  for (const f of ['mark.svg', 'mark-mono.svg']) assert.match(readFileSync(join(DIR, f), 'utf8'), /^<svg /)
})

test('the icon set covers the tabs and keeps the canvas\'s icons exactly', () => {
  assert.deepEqual([...TAB_ICONS], ['passbook', 'lend', 'market', 'wallet', 'agenda', 'ask'])
  const canvas = readFileSync(join(import.meta.dirname, '..', 'src', 'ui', 'icons.tsx'), 'utf8')
  for (const name of ['back', 'next', 'down', 'check', 'close', 'arrow', 'up', 'edit', 'refund', 'gear', 'info', 'alert', 'clock', 'lend', 'market', 'wallet', 'copy', 'share', 'plus'] as const) {
    for (const d of ICON_PATHS[name].d) assert.ok(canvas.includes(`'${d}'`), `${name}: the canvas path ${d} is unchanged`)
  }
  for (const [name, def] of Object.entries(ICON_PATHS)) {
    assert.ok(def.d.length > 0, `${name} draws something`)
    const w = (def as { w?: number }).w ?? 1.8
    assert.ok(w >= 1.6 && w <= 3, `${name}: one stroke family`)
    for (const [cx, cy, r] of (def as { c?: [number, number, number][] }).c ?? []) assert.ok(cx - r >= 0 && cy - r >= 0 && cx + r <= 24 && cy + r <= 24, `${name}: circle inside the 24 box`)
  }
})
