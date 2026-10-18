// src/core is plain ES modules shared with the root test suite, so its relative
// imports end in .js (TypeScript NodeNext style) while the files are .ts: resolve those.
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const resolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, name, platform) => {
  const next = resolve ?? context.resolveRequest
  if (/^\.\.?\/.*\.js$/.test(name)) {
    try {
      return next(context, name.replace(/\.js$/, ''), platform)
    } catch {
      // a real .js file
    }
  }
  return next(context, name, platform)
}
module.exports = config
