// The Passbook mark as plain data: one 64-unit drawing that Logo.tsx (react-native-svg),
// the PNG generator (assets/brand/generate.ts) and the options page all render, so the
// app icon, the splash and the in-app logo can never drift apart. No React Native here.
//
// A drawing is a list of layers painted in order. Each layer is filled or stroked with a
// role, not a colour:
//   ink    the booklet (the canvas's dark ink)
//   accent the seal (the canvas's green)
//   paper  a knockout: the background showing through (white on a screen; transparent in
//          the generator's PNGs, where it becomes a mask)
// A palette maps the roles to colours, so the same drawing gives the colour, mono and
// on-green (app icon) variants.

export type Role = 'ink' | 'accent' | 'paper'

export type Layer =
  | { el: 'path'; d: string; fill?: Role; stroke?: Role; width?: number }
  | { el: 'circle'; cx: number; cy: number; r: number; fill?: Role; stroke?: Role; width?: number }
  | { el: 'rect'; x: number; y: number; w: number; h: number; rx: number; fill?: Role; stroke?: Role; width?: number; rotate?: number }

export interface Mark {
  id: MarkId
  name: string
  idea: string
  layers: Layer[]
  /** where the seal's layers start (its knockout halo first): the splash draws the booklet, then stamps the seal */
  sealFrom: number
}

export type MarkId = 'sealed' | 'open' | 'stamped'

/** Option 1: a closed passbook with its spine and name label, sealed at the corner. */
const sealed: Mark = {
  id: 'sealed',
  name: 'Sealed passbook',
  idea: 'A closed booklet with its spine and name label; a round seal with a check closes the corner, the way a page is stamped when a loan is released.',
  sealFrom: 3,
  layers: [
    { el: 'rect', x: 5, y: 4, w: 38, h: 52, rx: 7, fill: 'ink' },
    { el: 'path', d: 'M13 4V56', stroke: 'paper', width: 3 },
    { el: 'rect', x: 21, y: 14, w: 14, h: 5, rx: 2.5, fill: 'paper' },
    { el: 'circle', cx: 43, cy: 45, r: 14.5, fill: 'paper' },
    { el: 'circle', cx: 43, cy: 45, r: 11, fill: 'accent' },
    { el: 'path', d: 'M37.6 45.4L41.4 49.2L48.6 41.2', stroke: 'paper', width: 3.8 },
  ],
}

/** Option 2: the passbook open, its left page written, the right page sealed. */
const open: Mark = {
  id: 'open',
  name: 'Open passbook',
  idea: 'The booklet open on its spine: entries on the left page, the seal pressed into the right one.',
  sealFrom: 5,
  layers: [
    { el: 'path', d: 'M30 15C24 10.5 14.5 9.5 5 11.5V52C14.5 50 24 51 30 55.5Z', fill: 'ink' },
    { el: 'path', d: 'M34 15C40 10.5 49.5 9.5 59 11.5V52C49.5 50 40 51 34 55.5Z', fill: 'ink' },
    { el: 'path', d: 'M11 22.5C16 21.3 20.5 21.5 24.5 23.2', stroke: 'paper', width: 3 },
    { el: 'path', d: 'M11 31C16 29.8 20.5 30 24.5 31.7', stroke: 'paper', width: 3 },
    { el: 'path', d: 'M11 39.5C14 38.8 16.5 38.8 19 39.4', stroke: 'paper', width: 3 },
    { el: 'circle', cx: 46.5, cy: 32.5, r: 10.5, fill: 'paper' },
    { el: 'circle', cx: 46.5, cy: 32.5, r: 7.8, fill: 'accent' },
    { el: 'path', d: 'M42.6 32.8L45.4 35.6L50.6 29.8', stroke: 'paper', width: 3 },
  ],
}

/** Option 3: one page drawn in the app's stroke style, with the canvas's tilted stamp. */
const stamped: Mark = {
  id: 'stamped',
  name: 'Stamped page',
  idea: 'One passbook page in the stroke style of the app\'s icons, with the tilted stamp the app already puts on a paid page.',
  sealFrom: 3,
  layers: [
    { el: 'path', d: 'M17 6H37L49 18V54A4 4 0 0 1 45 58H17A4 4 0 0 1 13 54V10A4 4 0 0 1 17 6Z', stroke: 'ink', width: 5 },
    { el: 'path', d: 'M37 6V14A4 4 0 0 0 41 18H49', stroke: 'ink', width: 5 },
    { el: 'path', d: 'M21 21H31M21 29.5H38', stroke: 'ink', width: 5 },
    { el: 'rect', x: 21, y: 33, w: 37, h: 23, rx: 6, fill: 'paper', rotate: -8 },
    { el: 'rect', x: 24.5, y: 36.5, w: 30, h: 16, rx: 4, stroke: 'accent', width: 4.5, rotate: -8 },
    { el: 'path', d: 'M33.5 45.2L37.6 48.8L45.8 40.6', stroke: 'accent', width: 4.5 },
  ],
}

export const MARKS: Record<MarkId, Mark> = { sealed, open, stamped }

/** The mark the user picked (2026-10-18). Logo.tsx and the generator draw this one. */
export const MARK_ID: MarkId = 'sealed'
export const MARK: Mark = MARKS[MARK_ID]

/** Role -> colour. `paper` is what shows through the knockouts. */
export interface Palette { ink: string; accent: string; paper: string }

/** The canvas's colours (src/ui/theme.ts C.ink, C.green, C.bg), repeated here so this file stays free of React Native. */
export const BRAND = { ink: '#14201F', green: '#1E6B52', greenBg: '#E7F2EE', white: '#FFFFFF', test: '#F5A524', testText: '#1A1300' } as const

export type Variant = 'colour' | 'mono' | 'reverse' | 'onGreen' | 'onInk'
export const PALETTES: Record<Variant, Palette> = {
  /** ink booklet, green seal, on white: the in-app logo */
  colour: { ink: BRAND.ink, accent: BRAND.green, paper: BRAND.white },
  /** one ink colour, on white */
  mono: { ink: BRAND.ink, accent: BRAND.ink, paper: BRAND.white },
  /** one white colour, on ink */
  reverse: { ink: BRAND.white, accent: BRAND.white, paper: BRAND.ink },
  /** one white colour, on the canvas green: the app icon and the splash */
  onGreen: { ink: BRAND.white, accent: BRAND.white, paper: BRAND.green },
  /** white booklet, green seal, on ink */
  onInk: { ink: BRAND.white, accent: BRAND.green, paper: BRAND.ink },
}

/** One layer as an SVG element string (the generator and the options page; Logo.tsx maps the same fields). */
export function layerSvg(l: Layer, p: Palette, knockout: 'paint' | 'mask' = 'paint'): string {
  const paint = (r?: Role) => (r ? (r === 'paper' && knockout === 'mask' ? '#000' : p[r]) : 'none')
  const common = `fill="${paint(l.fill)}" stroke="${paint(l.stroke)}"${l.stroke ? ` stroke-width="${l.width ?? 2}" stroke-linecap="round" stroke-linejoin="round"` : ''}`
  if (l.el === 'path') return `<path d="${l.d}" ${common}/>`
  if (l.el === 'circle') return `<circle cx="${l.cx}" cy="${l.cy}" r="${l.r}" ${common}/>`
  const rot = l.rotate ? ` transform="rotate(${l.rotate} ${l.x + l.w / 2} ${l.y + l.h / 2})"` : ''
  return `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.rx}"${rot} ${common}/>`
}

const isPaperOnly = (l: Layer) => (l.fill === 'paper' || !l.fill) && (l.stroke === 'paper' || !l.stroke)

/**
 * How the knockouts (paper layers) are drawn:
 *   paint  in the palette's paper colour (on a solid background of that colour)
 *   mask   as real holes with SVG masks (browsers; not cairosvg)
 *   omit   left out: the colour pass of a transparent PNG, whose alpha comes from the 'alpha' pass
 *   alpha  white mark, black holes and background: the transparent PNG's alpha channel
 */
export type Knockout = 'paint' | 'mask' | 'omit' | 'alpha'

/** The mark as SVG markup in a 64-unit box, `inset` units of margin on each side. */
export function markSvg(m: Mark, p: Palette, o: { size?: number; knockout?: Knockout; background?: string; inset?: number } = {}): string {
  const size = o.size ?? 64
  const inset = o.inset ?? 0
  const knockout = o.knockout ?? 'paint'
  const box = `x="${-inset}" y="${-inset}" width="${64 + inset * 2}" height="${64 + inset * 2}"`
  const pal: Palette = knockout === 'alpha' ? { ink: '#fff', accent: '#fff', paper: '#000' } : p
  const background = knockout === 'alpha' ? '#000' : o.background
  const bg = background ? `<rect ${box} fill="${background}"/>` : ''
  let body = ''
  let defs = ''
  if (knockout !== 'mask') body = m.layers.filter((l) => knockout !== 'omit' || !isPaperOnly(l)).map((l) => layerSvg(l, pal)).join('')
  else {
    // painter's order with holes: each paper layer masks everything drawn before it
    let n = 0
    for (const l of m.layers) {
      if (!isPaperOnly(l)) { body += layerSvg(l, pal); continue }
      const id = `k${n++}`
      defs += `<mask id="${id}" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="#fff"/>${layerSvg(l, pal, 'mask')}</mask>`
      body = `<g mask="url(#${id})">${body}</g>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-inset} ${-inset} ${64 + inset * 2} ${64 + inset * 2}">${defs ? `<defs>${defs}</defs>` : ''}${bg}${body}</svg>`
}
