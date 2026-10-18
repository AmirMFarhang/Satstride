// The app's stroke icon set as plain data: 24-unit paths drawn with round caps and joins,
// 1.8 wide unless noted, the canvas's icon style (src/ui/icons.tsx). The canvas's own
// icons keep their exact paths here, so swapping src/ui/icons.tsx's Icon for BrandIcon
// changes nothing on screen except the Passbook tab, which now echoes the logo (a booklet
// sealed at the corner). No React Native here: icons.tsx draws it, the tests read it.

export interface IconDef {
  /** stroked paths */
  d: string[]
  /** stroked circles: [cx, cy, r] */
  c?: [number, number, number][]
  /** stroke width (24-unit box) */
  w?: number
}

export const STROKE = 1.8

export const ICON_PATHS = {
  // ---- tabs ----
  passbook: { d: ['M12.5 21H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5', 'M8 3v18', 'M15.4 16.6l1.2 1.2 2.4-2.6'], c: [[17, 16.6, 4.2]] },
  lend: { d: ['M4 8c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z', 'M4 8v4c0 1.7 3.1 3 7 3', 'M4 12v4c0 1.7 3.1 3 7 3', 'M15 17h6M18 14l3 3-3 3'] },
  market: { d: ['M4 6h16M4 12h16M4 18h10'] },
  wallet: { d: ['M3 7a2 2 0 0 1 2-2h14v14H5a2 2 0 0 1-2-2z', 'M15 12h2'] },
  agenda: { d: ['M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M4 10h16', 'M8 3v4M16 3v4', 'M9 15.2l2 2 4-4'] },
  ask: { d: ['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.3A8 8 0 1 1 20 12z', 'M9.9 9.6a2.2 2.2 0 0 1 4.3.7c0 1.5-2.2 1.9-2.2 3.2', 'M12 16.3h.01'] },

  // ---- the canvas's actions (unchanged) ----
  back: { d: ['M15 5l-7 7 7 7'], w: 2 },
  next: { d: ['M9 5l7 7-7 7'], w: 2 },
  down: { d: ['M6 9l6 6 6-6'], w: 2 },
  check: { d: ['M5 12l5 5 9-10'], w: 2.6 },
  close: { d: ['M18 6L6 18M6 6l12 12'] },
  arrow: { d: ['M5 12h14M13 6l6 6-6 6'] },
  up: { d: ['M7 17L17 7M9 7h8v8'], w: 2.4 },
  edit: { d: ['M4 20h4L19 9l-4-4L4 16z'], w: 2 },
  refund: { d: ['M4 12a8 8 0 1 0 3-6.2M4 4v4h4'], w: 2.2 },
  gear: { d: ['M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1'], c: [[12, 12, 3]] },
  info: { d: ['M12 11v5M12 8h.01'], c: [[12, 12, 9]], w: 2 },
  alert: { d: ['M12 7v6M12 16h.01'], c: [[12, 12, 9]], w: 2 },
  clock: { d: ['M12 7v5l3 2'], c: [[12, 12, 9]], w: 2 },
  copy: { d: ['M9 9h10v10H9z', 'M5 15V5h10'] },
  share: { d: ['M12 3v12M7 8l5-5 5 5', 'M5 13v6h14v-6'] },
  plus: { d: ['M12 5v14M5 12h14'], w: 2 },

  // ---- money and loan actions ----
  borrow: { d: ['M12 3v11M7.5 9.5L12 14l4.5-4.5', 'M5 16v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2'] },
  repay: { d: ['M12 14V3M7.5 7.5L12 3l4.5 4.5', 'M5 16v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2'] },
  send: { d: ['M21 3L10.5 13.5', 'M21 3l-6.5 18-4-7.5L3 9.5z'] },
  receive: { d: ['M12 4v11M6.5 10l5.5 5.5 5.5-5.5', 'M5 20h14'] },
  lock: { d: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V8a4 4 0 0 1 8 0v3'] },
  unlock: { d: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V8a4 4 0 0 1 7.7-1.5'] },
  sign: { d: ['M4 21h16', 'M14.5 4.5l3 3L9 16l-4 1 1-4z', 'M12.5 6.5l3 3'] },
  seal: { d: ['M8.6 13.4l2.2 2.2 4.6-4.9', 'M12 2.5l2.1 1.6 2.6-.1.8 2.5 2.1 1.5-.8 2.5.8 2.5-2.1 1.5-.8 2.5-2.6-.1L12 19.5l-2.1-1.6-2.6.1-.8-2.5-2.1-1.5.8-2.5-.8-2.5 2.1-1.5.8-2.5 2.6.1z', 'M8.5 19l-1 3M15.5 19l1 3'] },
  stamp: { d: ['M10 3h4a1 1 0 0 1 1 1v3a2 2 0 0 1-1 1.7V12h-4V8.7A2 2 0 0 1 9 7V4a1 1 0 0 1 1-1z', 'M6 12h12a1 1 0 0 1 1 1v3H5v-3a1 1 0 0 1 1-1z', 'M6 20h12'] },
  page: { d: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6M9 17h4'] },
  ladder: { d: ['M5 20v-5M10 20v-8M15 20V8M20 20V4'], w: 2.2 },
  block: { d: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'] },
  hash: { d: ['M9.5 4l-2 16M16.5 4l-2 16M4.5 9h15M3.5 15h15'] },
  bell: { d: ['M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 21h4'] },

  // ---- the agents and the check ----
  agent: { d: ['M8 8h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z', 'M12 4.5V8', 'M9.5 13.5h.01M14.5 13.5h.01', 'M2.8 12.5v3M21.2 12.5v3'], c: [[12, 3.5, 1]] },
  lender: { d: ['M4 20a8 8 0 0 1 16 0'], c: [[12, 8, 4]] },
  phone: { d: ['M8 2.5h8a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z', 'M11 18.5h2'] },
  envelope: { d: ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M3.5 6.5L12 13l8.5-6.5'] },
  node: { d: ['M6 4h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M6 13h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z', 'M8 7.5h.01M8 16.5h.01'], w: 1.8 },
  relay: { d: ['M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8'], c: [[12, 12, 1.6]] },
  shield: { d: ['M12 3l7 3v5c0 4.6-3 8.3-7 10-4-1.7-7-5.4-7-10V6z', 'M9 12l2 2 4-4.2'] },
  key: { d: ['M10.8 12.2L20 3M16.5 6.5l3 3M14.5 8.5l2 2'], c: [[7.5, 15.5, 4.5]] },
  deal: { d: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'] },
  nodeal: { d: ['M13.5 6.3l-.5.5M18.7 11l-3 3a4 4 0 0 1-2.2 1.1', 'M10.5 17.7l-.5.5a4 4 0 0 1-5.7-5.7l3-3a4 4 0 0 1 2.2-1.1', 'M4 4l16 16'] },
} satisfies Record<string, IconDef>

export type BrandIconName = keyof typeof ICON_PATHS

/** The tab bar's icons, in the tab bar's order (Passbook, Lend, Market, Wallet, Agenda, Ask). */
export const TAB_ICONS = ['passbook', 'lend', 'market', 'wallet', 'agenda', 'ask'] as const satisfies readonly BrandIconName[]
