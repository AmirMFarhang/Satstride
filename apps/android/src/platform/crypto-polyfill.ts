// @noble's randomBytes needs crypto.getRandomValues; Hermes may not have it.
// expo-crypto's comes from the platform's secure random source.
import { getRandomValues } from 'expo-crypto'

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } }
if (!g.crypto) g.crypto = {}
if (typeof g.crypto.getRandomValues !== 'function') g.crypto.getRandomValues = getRandomValues
