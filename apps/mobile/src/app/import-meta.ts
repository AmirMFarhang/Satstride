// import.meta.url for shared src/ files that build a path from it at load time
// (src/scorer/contract.ts). Expo maps import.meta to this registry (babel.config.js); its url is
// the bundle's script URL, which can be null in a release build, and new URL(rel, null) would
// throw while the app loads. Keep Expo's url when there is one, else a fixed file: base. The
// paths built from it are never read on the phone (reading files throws, src/agent/node-stub.js).
const g = globalThis as unknown as { __ExpoImportMetaRegistry?: { url?: string | null } }
const expo = g.__ExpoImportMetaRegistry
Object.defineProperty(globalThis, '__ExpoImportMetaRegistry', {
  value: { get url() { try { return expo?.url || 'file:///passbook-mobile/index.bundle' } catch { return 'file:///passbook-mobile/index.bundle' } } },
  enumerable: false,
  writable: true,
})
export {}
