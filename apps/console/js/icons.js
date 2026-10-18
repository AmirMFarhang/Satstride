// Inline stroke icons: 20 px grid, 1.5 px stroke, currentColor.

const P = {
  overview: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="4" rx="1.5"/><rect x="11" y="9" width="6" height="8" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/>',
  revenue: '<path d="M3 16.5h14"/><path d="M4 13l4-4 3 3 5-6"/><path d="M12.5 6H16v3.5"/>',
  market: '<path d="M3.5 7.5h13l-1 9h-11z"/><path d="M7 7.5V6a3 3 0 0 1 6 0v1.5"/><path d="M8 11h4"/>',
  security: '<path d="M10 2.5 16 5v4.5c0 3.8-2.6 6.7-6 8-3.4-1.3-6-4.2-6-8V5z"/><path d="m7.5 10 1.8 1.8L12.8 8"/>',
  feed: '<path d="M4 4.5h12"/><path d="M4 8.5h12"/><path d="M4 12.5h8"/><path d="M4 16.5h5"/><circle cx="15.5" cy="15" r="1.5"/>',
  copilot: '<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z"/><path d="M7 9.5h.01M10 9.5h.01M13 9.5h.01" stroke-width="2"/>',
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6.5A1.5 1.5 0 0 0 5.5 13H7"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  x: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  sun: '<circle cx="10" cy="10" r="3.25"/><path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M4.7 15.3l1-1M14.3 5.7l1-1"/>',
  moon: '<path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z"/>',
  menu: '<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>',
  download: '<path d="M10 3.5v9"/><path d="m6.5 9 3.5 3.5L13.5 9"/><path d="M4 15.5h12"/>',
  play: '<path d="M6.5 4.5v11l9-5.5z"/>',
  pause: '<path d="M7 4.5v11M13 4.5v11"/>',
  power: '<path d="M10 3v6.5"/><path d="M6 5.6a6 6 0 1 0 8 0"/>',
  alert: '<path d="M10 3 2.5 16.5h15z"/><path d="M10 8.5v3.5M10 14.5h.01"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5M10 6.5h.01"/>',
  lock: '<rect x="4" y="9" width="12" height="8.5" rx="2"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/>',
  key: '<circle cx="7" cy="13" r="3.5"/><path d="m9.5 10.5 7-7M14 6l2 2M12 8l1.5 1.5"/>',
  node: '<rect x="3" y="3.5" width="14" height="5" rx="1.5"/><rect x="3" y="11.5" width="14" height="5" rx="1.5"/><path d="M6 6h.01M6 14h.01" stroke-width="2"/>',
  relay: '<circle cx="10" cy="10" r="1.75"/><path d="M6.5 13.5a5 5 0 0 1 0-7M13.5 6.5a5 5 0 0 1 0 7M4.2 15.8a8.2 8.2 0 0 1 0-11.6M15.8 4.2a8.2 8.2 0 0 1 0 11.6"/>',
  cpu: '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>',
  user: '<circle cx="10" cy="7" r="3"/><path d="M4 17a6 6 0 0 1 12 0"/>',
  bank: '<path d="M3 8 10 4l7 4"/><path d="M4.5 8.5v6M8 8.5v6M12 8.5v6M15.5 8.5v6M3 16.5h14"/>',
  sparkle: '<path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.2 5.2l2 2M12.8 12.8l2 2M5.2 14.8l2-2M12.8 7.2l2-2"/>',
  chain: '<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1"/>',
  list: '<path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9"/><path d="M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" stroke-width="2"/>',
  send: '<path d="M17 3 8.5 11.5"/><path d="M17 3 11.5 17l-3-5.5L3 8.5z"/>',
  logout: '<path d="M8 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h3"/><path d="m12 6.5 3.5 3.5L12 13.5M15.5 10H8"/>',
  arrow: '<path d="M4 10h12M11.5 5.5 16 10l-4.5 4.5"/>',
  target: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.5"/><circle cx="10" cy="10" r=".5"/>',
  scale: '<path d="M10 3v14M5 17h10M4 6h12"/><path d="m4 6-2 5h4zM16 6l-2 5h4z"/>',
  ledger: '<rect x="4" y="2.5" width="12" height="15" rx="2"/><path d="M7 6.5h6M7 9.5h6M7 12.5h3.5"/>',
  link: '<path d="M8 12 12 8"/><path d="M9 5.5 10.5 4a3.5 3.5 0 0 1 5 5L14 10.5M11 14.5 9.5 16a3.5 3.5 0 0 1-5-5L6 9.5"/>',
}

/** An inline SVG icon by name. */
export function icon(name, size = 20, cls = '') {
  const body = P[name] ?? P.info
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
}
