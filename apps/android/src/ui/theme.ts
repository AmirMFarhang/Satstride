// The dashboard's palette (web/style.css), light and dark.
export const LIGHT = { bg: '#f6f5f1', panel: '#ffffff', ink: '#1d1d1b', muted: '#5f5e58', line: '#e3e1da', soft: '#f1f2f0', accent: '#0f7b6c', accentInk: '#ffffff', ok: '#157f3b', okSoft: '#e4f2ea', warn: '#8a5a00', warnSoft: '#fff4dd', bad: '#b42318', badSoft: '#fde9e7' }
export const DARK: typeof LIGHT = { bg: '#141413', panel: '#1e1e1c', ink: '#ecebe6', muted: '#a8a7a0', line: '#34332f', soft: '#2a2a27', accent: '#35b39f', accentInk: '#0b1f1c', ok: '#5fd38a', okSoft: '#173326', warn: '#f0c060', warnSoft: '#3a2e14', bad: '#ff8a80', badSoft: '#3d1c19' }
export type Palette = typeof LIGHT
