// Metro for the on-device wallet. The borrower agent (src/agent/) imports the shared,
// browser-safe protocol code from the repository's src/ (terms, money, economics, escrow,
// oracle, passbook, market kinds) directly: one source of truth for every number and check.
//  - watchFolders adds ../../src; nothing there is copied.
//  - a package imported from ../../src resolves as if imported from apps/mobile, so the app
//    has one copy of each and never depends on a root `npm ci`.
//  - src/ (and the agent importing it) uses NodeNext-style ".js" imports of ".ts" files: mapped.
//  - tiny-secp256k1 v2 is WebAssembly, which Hermes lacks: it maps to the pure-JS
//    @bitcoinerlab/secp256k1 (same API, noble-based), as RN bitcoin wallets do.
//  - a node:* import from a shared file resolves to src/agent/node-stub.js: the phone uses only
//    those files' pure functions (verifyRunRecord), and a call into Node throws by name.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const shared = path.resolve(__dirname, '../../src') + path.sep
// the scoring contract JSON (contracts/), hashed into the borrower's consent receipt
config.watchFolders = [...(config.watchFolders ?? []), shared, path.resolve(__dirname, '../../contracts')]
const appEntry = path.join(__dirname, 'index.ts')
const nodeStub = path.join(__dirname, 'src/agent/node-stub.js')
const resolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, name, platform) => {
  const next = resolve ?? context.resolveRequest
  if (name === 'tiny-secp256k1') return next({ ...context, originModulePath: appEntry }, '@bitcoinerlab/secp256k1', platform)
  if (name.startsWith('node:') && context.originModulePath.startsWith(shared)) return { type: 'sourceFile', filePath: nodeStub }
  // src/ and the agent import src/ files with NodeNext-style ".js" names
  if (/^\.\.?\/.*\.js$/.test(name)) {
    try {
      return next(context, name.replace(/\.js$/, '.ts'), platform)
    } catch {
      // a real .js file
    }
  }
  if (context.originModulePath.startsWith(shared) && !name.startsWith('.')) {
    return next({ ...context, originModulePath: appEntry }, name, platform)
  }
  return next(context, name, platform)
}
module.exports = config
