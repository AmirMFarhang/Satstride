// Some shared files in src/ mix pure functions with Node-only ones and import node:* at the
// top (src/sandbox/run-record.ts: verifyRunRecord is pure, modelFileHash reads files). Metro
// resolves those imports here (metro.config.js), so the phone can use the pure functions. Any
// call into a Node built-in throws, naming what was called: nothing silently does nothing.
// The few pure helpers a shared module runs at load time (src/scorer/contract.ts builds a path
// with fileURLToPath(new URL(..., import.meta.url))) are real, so such a module still loads.
'use strict'
const missing = (name) => function () { throw new Error(`${name} is a Node built-in and is not available on the phone`) }
const norm = (p) => {
  const abs = p.startsWith('/')
  const out = []
  for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s) }
  return (abs ? '/' : '') + out.join('/')
}
const pure = {
  fileURLToPath: (u) => decodeURIComponent(new URL(String(u)).pathname),
  pathToFileURL: (p) => new URL(`file://${encodeURI(String(p))}`),
  join: (...parts) => norm(parts.filter(Boolean).join('/')),
  resolve: (...parts) => norm(parts.reduce((acc, p) => (String(p).startsWith('/') ? String(p) : `${acc}/${p}`), '/')),
  dirname: (p) => { const s = norm(String(p)); const i = s.lastIndexOf('/'); return i <= 0 ? (s.startsWith('/') ? '/' : '.') : s.slice(0, i) },
  basename: (p) => String(p).split('/').filter(Boolean).pop() ?? '',
  sep: '/',
}
module.exports = new Proxy({}, {
  get (_t, key) {
    if (key === '__esModule') return false
    if (key === 'default') return module.exports
    if (typeof key === 'symbol') return undefined
    if (Object.prototype.hasOwnProperty.call(pure, key)) return pure[key]
    return missing(String(key))
  },
})
