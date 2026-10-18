// Expo's release build minifies with R8 by default. R8 can rename or drop classes
// that native code reaches only through JNI (Nitro modules, the Bare worklet host),
// which then fail at runtime, not at build time. A sideloaded demo APK gains
// nothing from minifying, so the release build stays unminified.
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
