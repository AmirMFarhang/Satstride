// Node's Web Crypto for @noble's random bytes (the app uses expo-crypto's)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { webcrypto } = require('crypto') as { webcrypto: unknown }

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } }
if (!g.crypto?.getRandomValues) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default)
