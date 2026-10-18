// Android blocks plain HTTP. The phone reaches the laptop's Passbook node over
// USB with `adb reverse tcp:<port> tcp:<port>`, i.e. http://127.0.0.1:<port>, so
// cleartext is allowed to loopback only; every other host must be HTTPS.
const fs = require('fs')
const path = require('path')
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins')

const XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`

module.exports = function withLoopbackCleartext(config) {
  config = withDangerousMod(config, ['android', async (cfg) => {
    const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'network_security_config.xml'), XML)
    return cfg
  }])
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults)
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config'
    delete app.$['android:usesCleartextTraffic']
    return cfg
  })
}
