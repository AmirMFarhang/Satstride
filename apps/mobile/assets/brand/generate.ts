// Generates the app icon, Android's adaptive icon layers, the splash image and the mark's SVGs
// from the one drawing in src/brand/mark.ts, and writes manifest.json with the hash of each
// file's source SVG (the brand test checks the manifest against mark.ts, so the PNGs cannot
// drift from the in-app logo unnoticed).
//
//   npx tsx assets/brand/generate.ts          (from apps/mobile; needs python3 with cairosvg)
//
// Sizes follow Android: the adaptive icon is 108 dp with a 66 dp safe circle, so the mark sits
// inside the middle 61%; the Android 12 splash icon is masked to a circle the same way.
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BRAND, MARK, PALETTES, markSvg, type Palette } from '../../src/brand/mark.ts'

const OUT = dirname(fileURLToPath(import.meta.url))

/** The mark inset so it fits Android's adaptive safe circle (66/108). */
export const SAFE_INSET = 30
/** The legacy square icon: green to the edges, the mark a little larger. */
export const ICON_INSET = 18

/** One PNG: a single opaque pass, or a colour pass plus an alpha pass for real transparent holes. */
export interface BrandAsset { file: string; px: number; svg: string; alpha?: string; use: string }

const clear = (p: Palette, inset: number) => ({ svg: markSvg(MARK, p, { size: 1024, inset, knockout: 'omit' }), alpha: markSvg(MARK, p, { size: 1024, inset, knockout: 'alpha' }) })

export function brandAssets(): BrandAsset[] {
  return [
    { file: 'icon.png', px: 1024, use: 'expo.icon: the legacy square icon (green, white mark)', svg: markSvg(MARK, PALETTES.onGreen, { size: 1024, inset: ICON_INSET, background: BRAND.green }) },
    { file: 'adaptive-foreground.png', px: 1024, use: 'android.adaptiveIcon.foregroundImage: the white mark inside the safe circle, transparent', ...clear(PALETTES.onGreen, SAFE_INSET) },
    { file: 'adaptive-background.png', px: 1024, use: 'android.adaptiveIcon.backgroundImage: the canvas green', svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BRAND.green}"/></svg>` },
    { file: 'adaptive-monochrome.png', px: 1024, use: 'android.adaptiveIcon.monochromeImage: Android 13 themed icons (alpha only)', ...clear(PALETTES.mono, SAFE_INSET) },
    { file: 'splash.png', px: 1024, use: 'android.splash.image on backgroundColor #1E6B52: the white mark, circle-safe', ...clear(PALETTES.onGreen, SAFE_INSET) },
    { file: 'logo-colour.png', px: 1024, use: 'docs and the PR: the colour mark, transparent', ...clear(PALETTES.colour, 0) },
  ]
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
/** What the manifest records for a PNG: the hash of its source pass(es). */
export const sourceHash = (a: BrandAsset) => sha256(a.alpha ? `${a.svg}\n${a.alpha}` : a.svg)

/** cairosvg draws each pass; with an alpha pass, PIL takes the colour from the first and the alpha from the second. */
const PY = `
import io, sys, cairosvg
from PIL import Image
svg, alpha, out, px = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
render = lambda f: Image.open(io.BytesIO(cairosvg.svg2png(url=f, output_width=px, output_height=px)))
img = render(svg)
if alpha != '-':
    img = img.convert('RGBA')
    img.putalpha(render(alpha).convert('L'))
img.save(out, optimize=True)
`

function rasterize(svgPath: string, alphaPath: string | null, pngPath: string, px: number): void {
  const r = spawnSync('python3', ['-c', PY, svgPath, alphaPath ?? '-', pngPath, String(px)], { encoding: 'utf8', cwd: dirname(svgPath) })
  if (r.status !== 0) throw new Error(`cairosvg failed for ${pngPath}: ${r.stderr || r.error}`)
}

function main(): void {
  const tmp = mkdtempSync(join(tmpdir(), 'passbook-brand-'))
  const manifest: Record<string, { px: number; svg_sha256: string; use: string }> = {}
  for (const a of brandAssets()) {
    const svgPath = join(tmp, a.file.replace(/\.png$/, '.svg'))
    writeFileSync(svgPath, a.svg)
    const alphaPath = a.alpha ? svgPath.replace(/\.svg$/, '.alpha.svg') : null
    if (alphaPath) writeFileSync(alphaPath, a.alpha!)
    rasterize(svgPath, alphaPath, join(OUT, a.file), a.px)
    manifest[a.file] = { px: a.px, svg_sha256: sourceHash(a), use: a.use }
    console.log(`${a.file} ${a.px}px`)
  }
  writeFileSync(join(OUT, 'mark.svg'), markSvg(MARK, PALETTES.colour, { size: 64, knockout: 'mask' }) + '\n')
  writeFileSync(join(OUT, 'mark-mono.svg'), markSvg(MARK, PALETTES.mono, { size: 64, knockout: 'mask' }) + '\n')
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ mark: MARK.id, generated_by: 'assets/brand/generate.ts', files: manifest }, null, 2) + '\n')
  console.log(`mark ${MARK.id}: manifest.json, mark.svg, mark-mono.svg`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
