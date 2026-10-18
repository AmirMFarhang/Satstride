// Signs the release APK with the LOCAL demo keystore (scripts/make-keystore.sh):
// apps/android/keystore/passbook-demo.jks and keystore.properties, both gitignored.
// Without them a release build fails instead of falling back to the debug key.
const { withAppBuildGradle } = require('expo/config-plugins')

const RELEASE = `
        release {
            def ksProps = new Properties()
            def ksFile = rootProject.file('../keystore/keystore.properties')
            if (!ksFile.exists() && gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }) throw new GradleException('No demo keystore: run npm run keystore in apps/android first')
            if (ksFile.exists()) {
                ksFile.withInputStream { ksProps.load(it) }
                storeFile rootProject.file('../keystore/' + ksProps['storeFile'])
                storePassword ksProps['storePassword']
                keyAlias ksProps['keyAlias']
                keyPassword ksProps['keyPassword']
            }
        }`

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let g = cfg.modResults.contents
    if (!g.includes("rootProject.file('../keystore/keystore.properties')")) {
      // the release config is evaluated lazily, only when a release task needs it
      g = g.replace(/signingConfigs\s*\{/, (m) => `${m}${RELEASE}`)
      g = g.replace(/(release\s*\{[^{}]*?)signingConfig\s+signingConfigs\.debug/, '$1signingConfig signingConfigs.release')
    }
    if (!g.includes('signingConfig signingConfigs.release')) throw new Error('with-release-signing: could not find the release build type in app/build.gradle')
    cfg.modResults.contents = g
    return cfg
  })
}
