// Expo's release build minifies with R8 by default. R8 renames ML Kit's internals
// and expo-camera's barcode analyzer then fails to start ("Failed to initialize
// BarcodeAnalyzer"): the preview shows but no QR is ever read. A sideloaded demo
// APK gains nothing from minifying, so the release build stays unminified.
const { withGradleProperties } = require('expo/config-plugins')

const PROPS = { 'android.enableMinifyInReleaseBuilds': 'false', 'android.enableShrinkResourcesInReleaseBuilds': 'false' }

module.exports = function withReleaseNoMinify(config) {
  return withGradleProperties(config, (cfg) => {
    for (const [key, value] of Object.entries(PROPS)) {
      const i = cfg.modResults.findIndex((p) => p.type === 'property' && p.key === key)
      if (i >= 0) cfg.modResults[i].value = value
      else cfg.modResults.push({ type: 'property', key, value })
    }
    return cfg
  })
}
