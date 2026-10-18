// import.meta appears in shared src/ files the phone imports (src/scorer/contract.ts builds a
// file path from it at load time); Expo's polyfill maps it to globalThis.__ExpoImportMetaRegistry,
// which expo's runtime defines before the app's modules load.
module.exports = function (api) {
  api.cache(true)
  return { presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]] }
}
